import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationCache, conversationSessionScope, type ConversationSnapshot, type ConversationPersistence } from '../src/lib/conversation-cache';

function persistence() {
  const rows = new Map<string, any>();
  const store: ConversationPersistence = {
    read: async key => rows.get(key),
    write: async (record, count, bytes, oldest) => {
      rows.set(record.key, structuredClone(record));
      let retained = 0, used = 0;
      for (const row of [...rows.values()].sort((a, b) => b.savedAt - a.savedAt)) {
        if (row.scope !== record.scope || row.savedAt < oldest || retained >= count || used + row.bytes > bytes) rows.delete(row.key);
        else { retained++; used += row.bytes; }
      }
    },
    remove: async key => { rows.delete(key); },
    removeHost: async (scope, hostId) => { for (const [key, row] of rows) if (row.scope === scope && row.hostId === hostId) rows.delete(key); },
    clear: async () => { rows.clear(); },
  };
  return { rows, store };
}
const snapshot = (threadId = 'thread-a', hostId = 'local'): ConversationSnapshot => ({
  hostId, threadId, thread: { id: threadId, name: 'Private conversation' },
  items: [{ id: 'answer', text: 'Private answer' }], turns: [{ id: 'turn', status: 'completed', items: [] }],
  tokenUsage: { last: { totalTokens: 42 }, modelContextWindow: 100 }, cursor: 'older',
});

test('persistent history is isolated by the authenticated session and host, and snapshots cannot mutate the stored copy', async () => {
  const { store } = persistence();
  const writer = new ConversationCache(store);
  writer.activate('session-a');
  const original = snapshot();
  writer.write(original);
  original.items[0].text = 'Uncommitted change';
  await writer.flush();
  const reader = new ConversationCache(store);
  reader.activate('session-a');
  const restored = await reader.read('local', 'thread-a');
  assert.equal(restored?.items[0].text, 'Private answer');
  restored!.items[0].text = 'Reader change';
  assert.equal(reader.peek('local', 'thread-a')?.items[0].text, 'Private answer');
  assert.equal(await reader.read('remote', 'thread-a'), null);
  reader.activate('session-b');
  assert.equal(await reader.read('local', 'thread-a'), null);
});

test('logout invalidates pending reads and queued writes, clears private records, and a deleted host cannot reuse its history', async () => {
  const { store, rows } = persistence();
  const cache = new ConversationCache(store);
  cache.activate('session');
  cache.write(snapshot());
  cache.write(snapshot('thread-a', 'remote'));
  await cache.flush();
  cache.removeHost('remote');
  await cache.flush();
  assert.equal([...rows.values()].filter(row => row.hostId === 'remote').length, 0);
  let release!: () => void;
  const originalRead = store.read;
  store.read = async key => { const captured = await originalRead(key); await new Promise<void>(resolve => { release = resolve; }); return captured; };
  const reader = new ConversationCache(store);
  reader.activate('session');
  const read = reader.read('local', 'thread-a');
  await new Promise(resolve => setImmediate(resolve));
  reader.write(snapshot('queued-after-read'));
  await reader.clear();
  release();
  assert.equal(await read, null);
  assert.equal(reader.peek('local', 'queued-after-read'), null);
  assert.equal(rows.size, 0);
});

test('device caches have a bounded history, expire, and gracefully fall back when storage is unavailable or a conversation is too large', async () => {
  let time = 0;
  const { store, rows } = persistence();
  const cache = new ConversationCache(store, () => ++time);
  cache.activate('session');
  for (let index = 0; index < 20; index++) cache.write(snapshot(`thread-${index}`));
  await cache.flush();
  assert.equal(rows.size, 12);
  assert.equal(cache.peek('local', 'thread-0'), null);
  assert.ok(cache.peek('local', 'thread-19'));
  time += 25 * 60 * 60 * 1000;
  assert.equal(cache.peek('local', 'thread-19'), null);
  assert.equal(await cache.read('local', 'thread-19'), null);
  const huge = snapshot('huge');
  huge.items[0].text = 'x'.repeat(800 * 1024);
  cache.write(huge);
  assert.equal(cache.peek('local', 'huge'), null);
  const broken = new ConversationCache({ ...store, write: async () => { throw new Error('Quota exceeded'); }, read: async () => { throw new Error('Disabled IndexedDB'); } });
  broken.activate('session');
  broken.write(snapshot());
  await broken.flush();
  assert.ok(broken.peek('local', 'thread-a'));
  assert.equal(await broken.read('local', 'missing'), null);
});

test('persisted scope uses a one-way digest rather than the session credential', async () => {
  const scope = await conversationSessionScope('private-csrf-credential');
  assert.match(scope!, /^[a-f0-9]{64}$/);
  assert.equal(scope, await conversationSessionScope('private-csrf-credential'));
  assert.notEqual(scope, await conversationSessionScope('new-private-csrf-credential'));
  assert.equal(await conversationSessionScope(''), null);
});

test('a disk read already in flight cannot resurrect a reverted conversation or a removed host', async () => {
  for (const invalidate of ['thread', 'host'] as const) {
    const { store } = persistence();
    const writer = new ConversationCache(store);
    writer.activate('session');
    writer.write(snapshot());
    await writer.flush();
    let release!: () => void;
    const read = store.read;
    store.read = async key => { const record = await read(key); await new Promise<void>(resolve => { release = resolve; }); return record; };
    const cache = new ConversationCache(store);
    cache.activate('session');
    const pending = cache.read('local', 'thread-a');
    await new Promise(resolve => setImmediate(resolve));
    if (invalidate === 'thread') cache.remove('local', 'thread-a');
    else cache.removeHost('local');
    await cache.flush();
    release();
    assert.equal(await pending, null);
    assert.equal(cache.peek('local', 'thread-a'), null);
  }
});
