import type JSZip from 'jszip';
import type { OfficeFileKind } from './file-preview';

export const MAX_OFFICE_BYTES = 8 * 1024 * 1024;
export const OFFICE_ZIP_LIMITS = { maxEntries: 2000, maxEntryUncompressedBytes: 8 * 1024 * 1024,
  maxTotalUncompressedBytes: 32 * 1024 * 1024, maxMediaBytes: 24 * 1024 * 1024, maxConcurrency: 2 } as const;
export const SHEET_PAGE_ROWS = 50;
export const SHEET_PAGE_COLUMNS = 40;
export const SHEET_MAX_ROWS = 10000;
type ZipEntry = { name: string; compressed: number; uncompressed: number };
const invalid = () => new Error('文件不是可读取的 Office 文档，或已损坏；请下载原文件查看');

/** Inspect the central directory before starting any decompressor. ZIP64,
 * encrypted entries and split archives are outside this bounded preview. */
export function inspectOfficeZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength > MAX_OFFICE_BYTES) throw new Error('Office 预览上限为 8 MB，请下载原文件查看');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); --at) {
    if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) { end = at; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw invalid();
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (count !== view.getUint16(end + 8, true) || !count || count > OFFICE_ZIP_LIMITS.maxEntries || start + size !== end || start < 0) throw new Error('Office 文档结构过大或不受支持，请下载原文件查看');
  const entries: ZipEntry[] = [], names = new Set<string>();
  let cursor = start, total = 0;
  for (let index = 0; index < count; ++index) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw invalid();
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true), uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true), next = cursor + 46 + nameLength + extra + comment;
    if (next > end || flags & 1 || ![0, 8].includes(method) || offset + 30 > start || view.getUint32(offset, true) !== 0x04034b50) throw invalid();
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!name || name.startsWith('/') || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.split('/').includes('..') || names.has(name)) throw invalid();
    if (uncompressed > OFFICE_ZIP_LIMITS.maxEntryUncompressedBytes || (total += uncompressed) > OFFICE_ZIP_LIMITS.maxTotalUncompressedBytes ||
        uncompressed > 1024 * 1024 && uncompressed / Math.max(1, compressed) > 1000) throw new Error('Office 文档解压后过大，请下载原文件查看');
    const dataOffset = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    if (dataOffset + compressed > start) throw invalid();
    names.add(name); entries.push({ name, compressed, uncompressed }); cursor = next;
  }
  if (cursor !== end) throw invalid();
  return entries;
}

/** Decode only XML references, never entities declared by the input document. */
function attribute(value: string) {
  return value.replace(/&(?:#x([a-f0-9]+)|#(\d+)|(amp|quot|apos|lt|gt));/gi, (_match, hex, decimal, named) =>
    hex || decimal ? String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(hex || decimal, hex ? 16 : 10))) :
      ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[named.toLowerCase()] || '');
}
export function safeOfficeXml(xml: string, relationships: boolean): string {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Office 文档含不受支持的 XML 声明，请下载原文件查看');
  if (!relationships) return xml;
  return xml.replace(/<(?:[\w.-]+:)?Relationship\b[^>]*\/?\s*>/gi, tag => {
    const values = new Map<string, string>();
    for (const match of tag.matchAll(/\b([\w.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) values.set(match[1]!.toLowerCase(), attribute(match[3]!));
    const mode = values.get('targetmode'), target = values.get('target') || '';
    return mode && mode.toLowerCase() !== 'internal' || /^\s*(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(target) ? '' : tag;
  });
}

/** Read the actual inflated stream with a budget as well: malicious central
 * directory sizes must not bypass the limits before a library parses the XML. */
async function boundedEntry(entry: JSZip.JSZipObject, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const stream = (entry as JSZip.JSZipObject & { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> }).internalStream('uint8array');
    const chunks: Uint8Array[] = [];
    let length = 0, settled = false;
    const fail = (cause: unknown) => { if (!settled) { settled = true; stream.pause(); signal.removeEventListener('abort', abort); chunks.length = 0; reject(cause); } };
    const abort = () => fail(new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    stream.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      length += chunk.length;
      if (length > maximum) { fail(new Error('Office 文档解压后过大，请下载原文件查看')); return; }
      chunks.push(chunk);
    }).on('error', fail).on('end', () => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort);
      const result = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      resolve(result);
    }).resume();
  });
}
export async function prepareOfficeBytes(bytes: Uint8Array, kind: OfficeFileKind, signal: AbortSignal): Promise<Uint8Array> {
  if (bytes.byteLength > MAX_OFFICE_BYTES) throw new Error('Office 预览上限为 8 MB，请下载原文件查看');
  if (kind === 'xls') {
    if (!bytes.subarray(0, 8).every((byte, index) => byte === [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1][index]) || bytes.length < 8) throw invalid();
    return bytes;
  }
  const entries = inspectOfficeZip(bytes);
  const required = kind === 'docx' ? 'word/document.xml' : kind === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
  if (!entries.some(entry => entry.name === required)) throw invalid();
  const { default: Zip } = await import('jszip');
  const zip = await Zip.loadAsync(bytes, { createFolders: false });
  let total = 0, changed = false;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    signal.throwIfAborted();
    const file = zip.file(entry.name);
    if (!file) throw invalid();
    const data = await boundedEntry(file, Math.min(OFFICE_ZIP_LIMITS.maxEntryUncompressedBytes, OFFICE_ZIP_LIMITS.maxTotalUncompressedBytes - total), signal);
    total += data.length;
    if (/\.(?:xml|rels)$/i.test(entry.name)) {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(data), safe = safeOfficeXml(source, /\.rels$/i.test(entry.name));
      if (safe !== source) { zip.file(entry.name, safe); changed = true; }
    }
  }
  signal.throwIfAborted();
  return changed ? zip.generateAsync({ type: 'uint8array', compression: 'STORE' }) : bytes;
}

export type SpreadsheetPage = { sheetNames: string[]; sheetIndex: number; rows: string[][]; rowStart: number; rowEnd: number; columnStart: number; columnEnd: number; rowCount: number; columnCount: number; limited: boolean };
export function sheetColumn(index: number): string {
  let label = ''; for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + (value - 1) % 26) + label;
  return label;
}
