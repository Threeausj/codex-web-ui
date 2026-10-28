import test from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentDraftStore, attachmentDraftIdentity, type DraftAttachment } from '../src/lib/attachment-drafts';
import type { PrivatePersistence } from '../src/lib/private-state';

function fixture() {
  const rows = new Map<string, any>(), released: string[] = [];
  let counter = 0;
  const persistence: PrivatePersistence = { read: async key => structuredClone(rows.get(key)),
    write: async record => { rows.set(record.key, structuredClone(record)); },
    remove: async key => { rows.delete(key); }, clear: async () => { rows.clear(); } };
  const previews = { create: (_blob: Blob) => `blob:fixture-${++counter}`, revoke: (url: string) => { released.push(url); } };
  const store = new AttachmentDraftStore(persistence, previews); store.activate('account-hash');
  return { rows, released, persistence, previews, store };
}
function file(id: string, hostId = 'a'): DraftAttachment {
  return { id, hostId, name: 'image.png', mime: 'image/png', path: `/uploads/${id}.png`, size: 5,
    original: new Blob(['image'], { type: 'image/png' }), lastModified: 123 };
}
test('image originals and host-owned paths survive a reload without persisting object URLs', async () => {
  const f = fixture(), id = attachmentDraftIdentity('a', 'same-id', '/', false);
  await f.store.save(id, 'a', [{ ...file('image'), previewUrl: 'blob:page-old' }]);
  const row = [...f.rows.values()][0];
  assert.equal(row.value.files[0].previewUrl, undefined);
  assert.equal(row.bytes > 5, true);
  const reloaded = new AttachmentDraftStore(f.persistence, f.previews); reloaded.activate('account-hash');
  const restored = await reloaded.read(id, 'a');
  assert.equal(await restored[0]!.original!.text(), 'image');
  assert.equal(restored[0]!.path, '/uploads/image.png'); assert.equal(restored[0]!.previewUrl, 'blob:fixture-1');
  assert.equal((await reloaded.read(attachmentDraftIdentity('b', 'same-id', '/', false), 'b')).length, 0);
  reloaded.activate('other-account'); assert.equal((await reloaded.read(id, 'a')).length, 0);
  assert.deepEqual(f.released, ['blob:fixture-1']);
});
test('concurrent late upload completions append to their source draft and never overwrite each other', async () => {
  const f = fixture();
  await Promise.all([f.store.append('source', 'a', [file('one')]), f.store.append('source', 'a', [file('two')])]);
  assert.deepEqual(f.store.peek('source')!.map(value => value.id), ['one', 'two']);
  assert.equal((await f.store.read('destination', 'a')).length, 0);
  await assert.rejects(f.store.read('source', 'b'), /另一台主机/);
  await assert.rejects(async () => f.store.save('destination', 'b', [file('foreign')]), /另一台主机/);
});
test('a successful send consumes only submitted items in the original draft after navigation', async () => {
  const f = fixture(), sent = { ...file('sent'), previewUrl: 'blob:sent' }, later = file('later');
  await f.store.save('source', 'a', [sent]);
  await f.store.save('other', 'b', [file('other', 'b')]);
  await f.store.append('source', 'a', [later]);
  await f.store.consume('source', 'a', [sent]);
  assert.deepEqual(f.store.peek('source')!.map(value => value.id), ['later']);
  assert.deepEqual(f.store.peek('other')!.map(value => value.id), ['other']);
  assert.deepEqual(f.released, ['blob:sent']);
});
test('disk quota failures keep live attachments and their warning after switching away and back', async () => {
  const f = fixture();
  const store = new AttachmentDraftStore({ ...f.persistence, write: async () => { throw new Error('quota'); } }, f.previews);
  store.activate('account-hash');
  await assert.rejects(store.save('source', 'a', [file('kept')]), /quota/);
  await store.read('other', 'b'); await store.read('source', 'a');
  assert.equal(store.peek('source')![0]!.id, 'kept'); assert.equal(store.warning('source'), 'quota');
  store.activate(null); assert.equal(store.peek('source'), undefined); assert.equal(store.warning('source'), '');
});
test('an oversized attachment count stays in the current page with a warning instead of persisting an unreadable draft', async () => {
  const f = fixture();
  const files = Array.from({ length: 257 }, (_, index) => file(String(index)));
  await assert.rejects(f.store.save('many', 'a', files), /上限/);
  assert.equal(f.store.peek('many')!.length, 257);
  assert.equal(f.rows.size, 0); assert.ok(f.store.warning('many'));
});
test('late persisted reads cannot resurrect removed drafts or cross a login change', async () => {
  const f = fixture(); await f.store.save('source', 'a', [file('old')]);
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const reader = new AttachmentDraftStore({ ...f.persistence, read: async key => {
    const row = await f.persistence.read(key); started(); await new Promise<void>(resolve => { release = resolve; }); return row;
  } }, f.previews); reader.activate('account-hash');
  const pending = reader.read('source', 'a'); await ready;
  await reader.save('source', 'a', []); release(); assert.deepEqual(await pending, []);
  reader.activate('other-account'); assert.equal(reader.peek('source'), undefined);
});
