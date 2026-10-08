import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivateState, type PrivatePersistence } from '../src/lib/private-state';
function persistence() {
  const rows = new Map<string, any>();
  const store: PrivatePersistence = { read: async key => rows.get(key), write: async row => { rows.set(row.key, structuredClone(row)); }, remove: async key => { rows.delete(key); }, clear: async () => rows.clear() as any };
  return { rows, store };
}
test('draft content and disk base survive reload, while host, project and login remain isolated', async () => {
  const { rows, store } = persistence();
  const writer = new PrivateState(store); writer.activate('hashed-session');
  const draft = { text: 'unsaved', base: 'disk', version: 'cas-version', tabs: ['/project/a.ts', '/project/b.md'] };
  await writer.write('file-workspace', 'host-a/project', draft); draft.text = 'late edit';
  const reader = new PrivateState(store); reader.activate('hashed-session');
  assert.equal((await reader.read<any>('file-workspace', 'host-a/project')).text, 'unsaved');
  assert.equal((await reader.read<any>('file-workspace', 'host-a/project')).version, 'cas-version');
  assert.equal(await reader.read('file-workspace', 'host-b/project'), null);
  reader.activate('other-session'); assert.equal(await reader.read('file-workspace', 'host-a/project'), null);
  await writer.clear(); assert.equal(rows.size, 0);
});
test('a durable mutation receipt must commit before dispatch and storage failures are visible', async () => {
  const { store } = persistence();
  const writer = new PrivateState({ ...store, write: async () => { throw new Error('Quota'); } }); writer.activate('hash');
  await assert.rejects(writer.write('queue', 'thread', { clientId: 'original-id', input: 'prompt' }, true), /Quota/);
  assert.equal((await writer.read<any>('queue', 'thread')).clientId, 'original-id');
  await writer.clear();
});
test('logout invalidates queued private writes and late reads', async () => {
  const { rows, store } = persistence(); let release!: () => void;
  const writer = new PrivateState(store); writer.activate('hash'); await writer.write('queue', 'thread', { clientId: 'id' }, true);
  const reader = new PrivateState({ ...store, read: async key => { const captured = await store.read(key); await new Promise<void>(resolve => { release = resolve; }); return captured; } });
  reader.activate('hash'); const read = reader.read('queue', 'thread'); await new Promise(resolve => setImmediate(resolve));
  await reader.clear(); release(); assert.equal(await read, null); assert.equal(rows.size, 0);
});
test('a slow disk read returns the newer draft and cannot replace it in memory', async () => {
  const { store } = persistence();
  const writer = new PrivateState(store); writer.activate('hash'); await writer.write('file-workspace', 'host/project', { text: 'old' });
  let release!: () => void, started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const reader = new PrivateState({ ...store, read: async key => {
    const captured = await store.read(key); if (!captured) return captured; started(); await new Promise<void>(resolve => { release = resolve; }); return captured;
  } });
  reader.activate('hash'); const pending = reader.read('file-workspace', 'host/project'); await reading;
  await reader.write('file-workspace', 'host/project', { text: 'new edit' }); release();
  assert.deepEqual(await pending, { text: 'new edit' });
  assert.deepEqual(await reader.read('file-workspace', 'host/project'), { text: 'new edit' });
});
test('a slow read cannot resurrect a removed operation receipt; unrelated edits do not invalidate it', async () => {
  const { store } = persistence();
  const writer = new PrivateState(store); writer.activate('hash'); await writer.write('queue', 'thread', { clientId: 'old' }, true);
  let release!: () => void, started!: () => void;
  let reading = new Promise<void>(resolve => { started = resolve; });
  const reader = new PrivateState({ ...store, read: async key => {
    const captured = await store.read(key); if (!captured) return captured; started(); await new Promise<void>(resolve => { release = resolve; }); return captured;
  } });
  reader.activate('hash'); const pending = reader.read('queue', 'thread'); await reading;
  await reader.write('file-workspace', 'other/project', { text: 'independent' }); release();
  assert.deepEqual(await pending, { clientId: 'old' });
  const nextReader = new PrivateState((reader as any).persistence); nextReader.activate('hash');
  reading = new Promise<void>(resolve => { started = resolve; });
  const removed = nextReader.read('queue', 'thread'); await reading;
  await nextReader.remove('queue', 'thread'); release();
  assert.equal(await removed, null);
  assert.equal(await nextReader.read('queue', 'thread'), null);
});
