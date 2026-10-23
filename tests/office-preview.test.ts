import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import Zip from 'jszip';
import { officeFileKind, officeMime } from '../src/lib/file-preview';
import { inspectOfficeZip, MAX_OFFICE_BYTES, OFFICE_ZIP_LIMITS, prepareOfficeBytes, safeOfficeXml, sheetColumn } from '../src/lib/office-preview';

async function document(extra: Record<string, string | Uint8Array> = {}) {
  const zip = new Zip();
  zip.file('[Content_Types].xml', '<Types/>'); zip.file('word/document.xml', '<document>中文内容</document>');
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
const central = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = view.getUint32(bytes.length - 22 + 16, true);
  return { view, start };
};

test('Office recognition keeps unsupported legacy DOC/PPT explicit and does not match ordinary files', () => {
  for (const kind of ['docx', 'xlsx', 'xls', 'pptx']) { assert.equal(officeFileKind(`/项目/文件.${kind.toUpperCase()}`), kind); assert.ok(officeMime('/file.' + kind)); }
  assert.equal(officeFileKind('/file.doc'), 'legacy'); assert.equal(officeFileKind('/file.ppt'), 'legacy');
  for (const name of ['/folder.docx/file.txt', '/file.docm', '/file.xlsx.exe', '/file.zip']) assert.equal(officeFileKind(name), null);
  assert.equal(sheetColumn(0), 'A'); assert.equal(sheetColumn(25), 'Z'); assert.equal(sheetColumn(26), 'AA'); assert.equal(sheetColumn(16383), 'XFD');
});

test('Office archive preflight rejects oversized, encrypted, multipart and traversal packages before decompression', async () => {
  const bytes = await document();
  assert.ok(inspectOfficeZip(bytes).some(entry => entry.name === 'word/document.xml'));
  assert.throws(() => inspectOfficeZip(new Uint8Array(MAX_OFFICE_BYTES + 1)), /8 MB/);
  assert.throws(() => inspectOfficeZip(new Uint8Array([0x50, 0x4b])), /损坏/);
  for (const change of [
    (view: DataView, start: number) => view.setUint16(start + 8, 1, true),
    (view: DataView) => view.setUint16(bytes.length - 18, 1, true),
    (view: DataView, start: number) => view.setUint32(start + 24, OFFICE_ZIP_LIMITS.maxEntryUncompressedBytes + 1, true),
    (view: DataView, start: number) => { view.setUint32(start + 20, 1, true); view.setUint32(start + 24, 2 * 1024 * 1024, true); },
  ]) {
    const copy = bytes.slice(), { view, start } = central(copy); change(view, start); assert.throws(() => inspectOfficeZip(copy));
  }
  const traversal = new Zip(); traversal.file('../outside.xml', '<x/>', { createFolders: false });
  await assert.rejects(prepareOfficeBytes(await traversal.generateAsync({ type: 'uint8array' }), 'docx', new AbortController().signal), /损坏/);
});

test('Office preflight enforces total expanded bytes and entry counts rather than only the preview download limit', async () => {
  const zip = new Zip();
  for (let i = 0; i < 5; i++) zip.file(`media${i}.bin`, randomBytes(9000));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), { view, start } = central(bytes);
  let cursor = start;
  // Artificial metadata is sufficient to prove rejection before any inflate.
  let changed = 0;
  while (view.getUint32(cursor, true) === 0x02014b50) {
    view.setUint32(cursor + 24, 8 * 1024 * 1024, true); changed++;
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  assert.equal(changed, 5);
  assert.throws(() => inspectOfficeZip(bytes), /解压后过大/);
  const many = new Zip();
  for (let i = 0; i <= OFFICE_ZIP_LIMITS.maxEntries; i++) many.file(`e${i}.xml`, 'x');
  const crowded = await many.generateAsync({ type: 'uint8array' });
  assert.throws(() => inspectOfficeZip(crowded));
});

test('actual inflate size cannot bypass the budget by lying in the ZIP central directory', async () => {
  const bytes = await document({ 'word/large.xml': new Uint8Array(OFFICE_ZIP_LIMITS.maxEntryUncompressedBytes + 1).fill(65) });
  const { view, start } = central(bytes);
  let cursor = start;
  while (view.getUint32(cursor, true) === 0x02014b50) {
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + view.getUint16(cursor + 28, true)));
    if (name === 'word/large.xml') view.setUint32(cursor + 24, 1, true);
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  assert.doesNotThrow(() => inspectOfficeZip(bytes));
  await assert.rejects(prepareOfficeBytes(bytes, 'docx', new AbortController().signal), /解压后过大/);
});

test('external relationships and entity-encoded URLs are removed while internal images remain available', async () => {
  const relationships = '<Relationships><Relationship Id="i1" Target="media/image.png"/><Relationship Id="i2" Target="https://example.invalid/image" TargetMode="External"/><Relationship Id="i3" Target="//example.invalid/font"/><Relationship Id="i4" Target="&#x68;ttps://example.invalid/track" TargetMode="&#69;xternal"/></Relationships>';
  const safe = safeOfficeXml(relationships, true);
  assert.match(safe, /media\/image.png/); assert.ok(!safe.includes('example.invalid'));
  const bytes = await document({ 'word/_rels/document.xml.rels': relationships });
  const prepared = await prepareOfficeBytes(bytes, 'docx', new AbortController().signal);
  const zip = await Zip.loadAsync(prepared);
  assert.equal(await zip.file('word/_rels/document.xml.rels')!.async('string'), safe);
  assert.equal(await zip.file('word/document.xml')!.async('string'), '<document>中文内容</document>');
});

test('DTD/XXE declarations and mismatched package kinds never reach a document renderer', async () => {
  for (const xml of ['<!DOCTYPE x [<!ENTITY xxe SYSTEM "https://example.invalid/private">]><document>&xxe;</document>', '<!ENTITY a "expanded">']) {
    assert.throws(() => safeOfficeXml(xml, false), /XML 声明/);
    await assert.rejects(prepareOfficeBytes(await document({ 'word/document.xml': xml }), 'docx', new AbortController().signal), /XML 声明/);
  }
  await assert.rejects(prepareOfficeBytes(await document(), 'xlsx', new AbortController().signal), /损坏/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareOfficeBytes(await document(), 'docx', controller.signal), /abort/i);
  await assert.rejects(prepareOfficeBytes(new Uint8Array([1, 2, 3]), 'xls', new AbortController().signal), /损坏/);
});
