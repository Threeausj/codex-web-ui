import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationCache, ConversationMemoryCache, conversationSessionScope, type ConversationSnapshot, type ConversationPersistence } from '../src/lib/conversation-cache';

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
  const reduced = cache.peek('local', 'huge');
  assert.ok(reduced?.items[0].text.length);
  assert.ok(reduced.items[0].text.length < 800 * 1024);
  assert.equal(reduced.historyTruncated, true);
  assert.equal(reduced.cursor, null);
  assert.equal(reduced.items[0].cacheTruncated, true);
  await cache.flush();
  const fresh = new ConversationCache(store, () => time);
  fresh.activate('session');
  assert.equal((await fresh.read('local', 'huge'))?.items[0].text, reduced.items[0].text);
  const broken = new ConversationCache({ ...store, write: async () => { throw new Error('Quota exceeded'); }, read: async () => { throw new Error('Disabled IndexedDB'); } });
  broken.activate('session');
  broken.write(snapshot());
  await broken.flush();
  assert.ok(broken.peek('local', 'thread-a'));
  assert.equal(await broken.read('local', 'missing'), null);
});

test('bounded snapshots retain recent turns and never keep an older cursor that skips trimmed history', async () => {
  const { store } = persistence();
  const cache = new ConversationCache(store);
  cache.activate('session');
  const long = snapshot('long');
  long.turns = Array.from({ length: 360 }, (_, index) => ({ id: `turn-${index}`, items: [], status: 'completed' }));
  long.items = long.turns.map(turn => ({ id: `answer-${turn.id}`, turnId: turn.id, type: 'agentMessage', text: 'x'.repeat(3000) }));
  cache.write(long);
  const reduced = cache.peek('local', 'long')!;
  assert.ok(reduced.items.length > 200 && reduced.items.length < 360);
  assert.equal(reduced.items.at(-1).id, 'answer-turn-359');
  assert.equal(reduced.turns.at(-1).id, 'turn-359');
  assert.equal(reduced.items.length, reduced.turns.length);
  assert.equal(reduced.cursor, null);
  assert.equal(reduced.historyTruncated, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(reduced)).byteLength <= 768 * 1024);
});

test('inactive delta invalidations are coalesced, while invalidation immediately rejects stale memory and pending reads', async () => {
  const { store, rows } = persistence();
  const batches: string[][] = [];
  store.removeMany = async keys => { batches.push(keys); for (const key of keys) rows.delete(key); };
  const cache = new ConversationCache(store);
  cache.activate('session');
  cache.write(snapshot('a')); cache.write(snapshot('b'));
  await cache.flush();
  for (let index = 0; index < 1000; index++) { cache.remove('local', 'a'); cache.remove('local', 'b'); }
  assert.equal(cache.peek('local', 'a'), null);
  assert.equal(cache.peek('local', 'b'), null);
  await cache.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  assert.equal(rows.size, 0);
  cache.remove('local', 'a');
  cache.write(snapshot('a'));
  await cache.flush();
  assert.ok(await cache.read('local', 'a'));
  assert.equal(batches.length, 1);
});

test('memory LRU bounds idle conversations while preserving the selected and running arrays and their history', () => {
  const protectedIds = new Set(['active', 'running']);
  const cache = new ConversationMemoryCache(() => protectedIds, 3, 100000);
  const active = [{ id: 'active-answer', text: 'Selected' }];
  const running = [{ id: 'running-answer', text: 'Streaming' }];
  cache.set('active', active); cache.set('running', running);
  cache.rememberHistory('active', { turns: [{ id: 'active-turn', items: active }], cursor: 'older', engineId: 'engine' });
  for (let index = 0; index < 20; index++) cache.set(`idle-${index}`, [{ id: `${index}` }]);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('active'), active);
  assert.equal(cache.get('running'), running);
  assert.equal(cache.history('active')?.cursor, 'older');
  assert.equal(cache.history('active')?.turns[0].items.length, 0);
  assert.equal(cache.get('idle-0'), undefined);
  cache.get('idle-19');
  protectedIds.delete('running');
  cache.set('newest', [{ id: 'newest' }]);
  assert.equal(cache.get('running'), undefined);
  assert.equal(cache.get('active'), active);
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
