import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatTabs, maxChatTabs, maxPinnedChatTabs, sameChatTab, type ChatTab } from '../src/lib/chat-tabs';

type Stored = { version: number; entries: unknown[] };
const tab = (threadId = 'chat-a', hostId = 'local', extra: Partial<ChatTab> = {}): ChatTab =>
  ({ hostId, threadId, title: `Title ${threadId}`, pinned: false, lastOpened: 1, ...extra });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
function fixture(initial?: Stored) {
  let authentication = 1, saved = initial, clock = 10;
  const writes: unknown[] = [];
  const persistence = {
    read: async <T>() => structuredClone(saved ?? null) as T | null,
    write: async <T>(_namespace: string, _identity: string, value: T) => {
      saved = structuredClone(value) as Stored; writes.push(structuredClone(value));
    },
  };
  const store = createChatTabs({ ready: async () => {}, authentication: () => authentication, persistence, now: () => clock++ });
  return { store, persistence, writes, authentication: () => { authentication++; }, saved: () => saved };
}

test('reopening a chat updates its title and recency while keeping tab order stable', async () => {
  const f = fixture();
  await f.store.load();
  f.store.open(tab('a')); f.store.open(tab('b')); f.store.open(tab('a', 'local', { title: 'Renamed a' }));
  assert.deepEqual(f.store.state.entries.map(entry => entry.threadId), ['a', 'b']);
  assert.equal(f.store.state.entries[0]!.title, 'Renamed a');
  assert.ok(f.store.state.entries[0]!.lastOpened > f.store.state.entries[1]!.lastOpened);
  await f.store.flush();
});

test('the same native thread ID on different hosts occupies different tabs', async () => {
  const f = fixture();
  f.store.open(tab('shared', 'local')); f.store.open(tab('shared', 'remote'));
  assert.equal(f.store.state.entries.length, 2);
  assert.equal(sameChatTab(f.store.state.entries[0], f.store.state.entries[1]), false);
  f.store.remove(tab('shared', 'remote'));
  assert.equal(f.store.state.entries[0]!.hostId, 'local');
  await f.store.flush();
});

test('pinning keeps fixed tabs first without changing sidebar pin data or other tab order', async () => {
  const f = fixture();
  for (const id of ['a', 'b', 'c', 'd']) f.store.open(tab(id));
  assert.equal(f.store.togglePinned(tab('c')), true);
  assert.equal(f.store.togglePinned(tab('b')), true);
  assert.deepEqual(f.store.state.entries.map(entry => entry.threadId), ['c', 'b', 'a', 'd']);
  assert.equal(f.store.togglePinned(tab('c')), true);
  assert.deepEqual(f.store.state.entries.map(entry => entry.threadId), ['b', 'c', 'a', 'd']);
  assert.equal(f.store.state.entries[0]!.pinned, true);
  assert.equal(f.store.togglePinned(tab('missing')), false);
  await f.store.flush();
});

test('closing an inactive tab preserves selection and closing the active tab chooses its neighbor', async () => {
  const f = fixture();
  for (const id of ['a', 'b', 'c', 'd']) f.store.open(tab(id));
  assert.equal(f.store.close(tab('a'), tab('c')), null);
  assert.equal(f.store.close(tab('c'), tab('c'))?.threadId, 'd');
  assert.equal(f.store.close(tab('d'), tab('d'))?.threadId, 'b');
  assert.equal(f.store.close(tab('b'), tab('b')), null);
  assert.deepEqual(f.store.state.entries, []);
  await f.store.flush();
});

test('the limit evicts the least recently opened ordinary tab and preserves fixed tabs', async () => {
  const f = fixture();
  f.store.open(tab('fixed')); f.store.togglePinned(tab('fixed'));
  for (let i = 0; i < maxChatTabs - 1; i++) f.store.open(tab(`chat-${i}`));
  f.store.open(tab('chat-0'));
  f.store.open(tab('new'));
  assert.equal(f.store.state.entries.length, maxChatTabs);
  assert.equal(f.store.state.entries[0]!.threadId, 'fixed');
  assert.ok(f.store.state.entries.some(entry => entry.threadId === 'chat-0'));
  assert.ok(f.store.state.entries.some(entry => entry.threadId === 'new'));
  assert.equal(f.store.state.entries.some(entry => entry.threadId === 'chat-1'), false);
  await f.store.flush();
});

test('one ordinary slot remains usable when the fixed-tab limit is reached', async () => {
  const f = fixture();
  for (let i = 0; i < maxPinnedChatTabs; i++) { f.store.open(tab(`fixed-${i}`)); assert.equal(f.store.togglePinned(tab(`fixed-${i}`)), true); }
  f.store.open(tab('current'));
  assert.equal(f.store.togglePinned(tab('current')), false);
  f.store.open(tab('next'));
  assert.equal(f.store.state.entries.length, maxChatTabs);
  assert.equal(f.store.state.entries.filter(entry => entry.pinned).length, maxPinnedChatTabs);
  assert.equal(f.store.state.entries.at(-1)!.threadId, 'next');
  await f.store.flush();
});

test('stored tabs survive reload and only navigation metadata is serialized', async () => {
  const f = fixture();
  f.store.open({ ...tab('a'), text: 'Do not save private conversation contents', turns: [1] } as ChatTab);
  f.store.togglePinned(tab('a'));
  await f.store.flush();
  assert.equal(f.writes.length, 1);
  assert.deepEqual(Object.keys((f.saved()!.entries[0] as any)).sort(), ['hostId', 'lastOpened', 'pinned', 'threadId', 'title']);
  const restored = createChatTabs({ ready: async () => {}, authentication: () => 1, persistence: f.persistence });
  await restored.load();
  assert.deepEqual(restored.state.entries, f.store.state.entries);
  assert.equal(restored.state.hydrated, true);
});

test('first navigation during a slow initial read merges with stored fixed tabs', async () => {
  const read = deferred<any>();
  const f = fixture();
  f.persistence.read = async <T>() => read.promise as Promise<T | null>;
  const loading = f.store.load();
  f.store.open(tab('selected')); f.store.rename(tab('selected'), 'Latest title');
  read.resolve({ version: 1, entries: [tab('fixed', 'remote', { pinned: true }), tab('selected', 'local', { title: 'Old title' })] });
  await loading;
  assert.deepEqual(f.store.state.entries.map(entry => entry.threadId), ['fixed', 'selected']);
  assert.equal(f.store.state.entries[1]!.title, 'Latest title');
  assert.equal(f.store.state.entries[0]!.pinned, true);
  await f.store.flush();
});

test('deletion, host removal and rename while loading cannot be undone by stale storage', async () => {
  const read = deferred<any>();
  const f = fixture();
  f.persistence.read = async <T>() => read.promise as Promise<T | null>;
  const loading = f.store.load();
  f.store.remove(tab('deleted')); f.store.removeHost('removed-host'); f.store.rename(tab('keep'), 'Accepted name');
  read.resolve({ version: 1, entries: [tab('deleted'), tab('remote', 'removed-host'), tab('keep')] });
  await loading;
  assert.deepEqual(f.store.state.entries.map(entry => entry.threadId), ['keep']);
  assert.equal(f.store.state.entries[0]!.title, 'Accepted name');
  await f.store.flush();
});

test('authentication changes prevent a late storage result from restoring the previous account tabs', async () => {
  const read = deferred<any>();
  const f = fixture();
  f.persistence.read = async <T>() => read.promise as Promise<T | null>;
  const loading = f.store.load();
  await Promise.resolve();
  f.authentication(); f.store.clear();
  read.resolve({ version: 1, entries: [tab('old-account', 'private-host', { pinned: true })] });
  await loading;
  assert.deepEqual(f.store.state.entries, []);
  assert.equal(f.store.state.hydrated, false);
  assert.deepEqual(f.writes, []);
});

test('queued writes from the previous authentication are cancelled before storage access', async () => {
  const ready = deferred<void>();
  const f = fixture();
  let auth = 1;
  const store = createChatTabs({ ready: () => ready.promise, authentication: () => auth, persistence: f.persistence });
  store.open(tab('old'));
  const writing = store.flush();
  await Promise.resolve();
  auth++; store.clear(); ready.resolve();
  await writing;
  assert.deepEqual(f.writes, []);
  assert.deepEqual(store.state.entries, []);
});

test('denied storage preserves current-window tabs and operations remain usable', async () => {
  const f = fixture();
  f.persistence.read = async () => { throw new Error('Storage unavailable'); };
  f.persistence.write = async () => { throw new Error('Storage unavailable'); };
  f.store.open(tab('a')); f.store.togglePinned(tab('a'));
  await f.store.flush();
  assert.equal(f.store.state.entries[0]!.threadId, 'a');
  assert.equal(f.store.state.entries[0]!.pinned, true);
  assert.equal(f.store.state.hydrated, true);
  f.store.open(tab('b'));
  assert.equal(f.store.close(tab('b'), tab('b'))?.threadId, 'a');
  await f.store.flush();
});

test('invalid, duplicated and oversized saved metadata is normalized into a bounded tab catalog', async () => {
  const entries: unknown[] = [null, {}, tab('dup'), tab('dup', 'local', { title: 'Newest', pinned: true, lastOpened: 5 }),
    tab('bad', ''), tab('long', 'local', { title: 'A'.repeat(1000) })];
  for (let i = 0; i < 100; i++) entries.push(tab(`extra-${i}`, 'local', { pinned: true, lastOpened: i }));
  const f = fixture({ version: 1, entries });
  await f.store.load();
  assert.equal(f.store.state.entries.length, maxChatTabs);
  assert.equal(f.store.state.entries.filter(entry => entry.pinned).length, maxPinnedChatTabs);
  assert.equal(f.store.state.entries.filter(entry => entry.threadId === 'dup').length, 1);
  assert.equal(f.store.state.entries.find(entry => entry.threadId === 'dup')!.title, 'Newest');
  assert.ok(f.store.state.entries.every(entry => entry.title.length <= 256));
});

test('unknown persisted versions are ignored and opening a host never prunes other hosts', async () => {
  const f = fixture({ version: 99, entries: [tab('future')] });
  await f.store.load();
  assert.deepEqual(f.store.state.entries, []);
  f.store.open(tab('a', 'host-a')); f.store.open(tab('b', 'host-b')); f.store.open(tab('c', 'host-b'));
  assert.deepEqual(f.store.state.entries.map(entry => entry.hostId), ['host-a', 'host-b', 'host-b']);
  await f.store.flush();
});
