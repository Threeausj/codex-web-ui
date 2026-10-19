import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, reactive } from 'vue';
import { createThreadIndicators } from '../src/lib/thread-indicators';
import { createThreadReadSync } from '../src/lib/thread-read-sync';
import type { StoredThreadReadReceipt, ThreadReadReceipt } from '../shared/thread-read-receipts';

const completed = (id: string, threadId = 't', completedAt = 100) => ({ method: 'turn/completed',
  params: { threadId, turn: { id, status: 'completed', completedAt } } });
const receipt = (turnId: string, threadId = 't', activityAt = 100): StoredThreadReadReceipt => ({
  hostId: 'nas', threadId, turnIds: [turnId], activityAt,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); };
type Call = { method: string; receipts: ThreadReadReceipt[]; signal: AbortSignal; reportError: boolean };
function fixture(t: TestContext, respond: (call: Call) => unknown | Promise<unknown>) {
  const names = ['window', 'document'];
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const browserWindow = new EventTarget(), browserDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browserDocument });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const state = reactive({ authenticated: true, authenticationGeneration: 1, online: true, connected: true,
    hostId: 'nas', hosts: [{ id: 'nas' }] });
  const calls: Call[] = [];
  let listener: ((host: string, message: any) => void) | undefined;
  let sync: ReturnType<typeof createThreadReadSync> | undefined;
  const values = new Map<string, string>();
  const tracker = createThreadIndicators({ getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value) }, () => 1000, entry => sync?.markRead(entry));
  const api = {
    requestHttp: async (path: string, options: any, reportError: boolean) => {
      assert.equal(path, '/thread-read-receipts');
      const call: Call = { method: options.method, receipts: options.body ? JSON.parse(options.body).receipts : [],
        signal: options.signal, reportError };
      calls.push(call);
      return await respond(call);
    },
    subscribeProtocol: (callback: typeof listener) => { listener = callback; return () => { listener = undefined; }; },
  };
  function start() { sync = createThreadReadSync(state, api, tracker); return sync; }
  t.after(() => {
    sync?.stop();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  });
  return { state, tracker, calls, start,
    emit: (records: StoredThreadReadReceipt[]) => listener?.('nas', { method: 'bridge/thread-read-receipts', params: { receipts: records } }),
    browserWindow };
}

test('a stale HTTP snapshot cannot undo a WebSocket read and no acknowledgement is echoed', async t => {
  const read = deferred<{ receipts: StoredThreadReadReceipt[] }>();
  const f = fixture(t, call => call.method === 'GET' ? read.promise : { receipts: [] });
  f.tracker.observe('nas', completed('remote'));
  f.start();
  f.emit([receipt('remote')]);
  assert.equal(f.tracker.indicator('nas', 't'), null);
  read.resolve({ receipts: [] });
  await settle();
  t.mock.timers.tick(1000); await settle();
  assert.equal(f.tracker.indicator('nas', 't'), null);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.deepEqual(f.tracker.readReceipts(), []);
});

test('successful delivery of an old migrated read does not retry when the bounded server journal retains newer IDs', async t => {
  const retained: StoredThreadReadReceipt = { hostId: 'nas', threadId: 't',
    turnIds: Array.from({ length: 16 }, (_, index) => `newer-${index}`), activityAt: 200 };
  const f = fixture(t, () => ({ receipts: [retained] }));
  f.tracker.observe('nas', completed('older'));
  f.tracker.setVisible('nas', 't');
  const sync = f.start();
  await settle();
  t.mock.timers.tick(150); await settle();
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.receipts), [[
    { hostId: 'nas', threadId: 't', turnId: 'older', activityAt: 100 },
  ]]);
  sync.markRead({ hostId: 'nas', threadId: 't', turnId: 'older', activityAt: 100 });
  for (let index = 0; index < 4; index++) { t.mock.timers.tick(30000); await settle(); }
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.tracker.indicator('nas', 't'), null);
});

test('an offline read survives reconnection and one failed write retries without duplicate successful writes', async t => {
  let posts = 0;
  const f = fixture(t, call => {
    if (call.method === 'GET') return { receipts: [] };
    if (++posts === 1) throw new Error('connection reset');
    return { receipts: call.receipts.map(value => receipt(value.turnId, value.threadId, value.activityAt)) };
  });
  f.state.online = false;
  f.start();
  f.tracker.observe('nas', completed('offline'));
  f.tracker.setVisible('nas', 't');
  t.mock.timers.tick(30000); await settle();
  assert.equal(f.calls.length, 0);
  f.state.online = true; await settle();
  t.mock.timers.tick(150); await settle();
  assert.equal(posts, 1);
  t.mock.timers.tick(1999); await settle();
  assert.equal(posts, 1);
  t.mock.timers.tick(1); await settle();
  assert.equal(posts, 2);
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(30000); await settle(); }
  assert.equal(posts, 2);
  assert.ok(f.calls.every(call => call.signal instanceof AbortSignal && call.reportError === false));
});

test('partial server confirmation retries only the unacknowledged conversation', async t => {
  let posts = 0;
  const f = fixture(t, call => {
    if (call.method === 'GET') return { receipts: [] };
    ++posts;
    const accepted = posts === 1 ? call.receipts.slice(0, 1) : call.receipts;
    return { receipts: accepted.map(value => receipt(value.turnId, value.threadId, value.activityAt)) };
  });
  for (const id of ['one', 'two']) { f.tracker.observe('nas', completed(id, id)); f.tracker.setVisible('nas', id); }
  f.start(); await settle();
  t.mock.timers.tick(150); await settle();
  t.mock.timers.tick(2000); await settle();
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.receipts.map(value => value.threadId)), [['one', 'two'], ['two']]);
  t.mock.timers.tick(30000); await settle();
  assert.equal(posts, 2);
});

test('authentication replacement aborts old requests and ignores their late responses', async t => {
  const oldWrite = deferred<{ receipts: StoredThreadReadReceipt[] }>();
  let posts = 0;
  const f = fixture(t, call => {
    if (call.method === 'GET') return { receipts: [] };
    if (++posts === 1) return oldWrite.promise;
    return { receipts: call.receipts.map(value => receipt(value.turnId, value.threadId, value.activityAt)) };
  });
  f.tracker.observe('nas', completed('local'));
  f.tracker.setVisible('nas', 't');
  f.tracker.setVisible('nas', null);
  f.tracker.observe('nas', completed('old-session-only', 'other'));
  f.start(); await settle();
  t.mock.timers.tick(150); await settle();
  const firstPost = f.calls.find(call => call.method === 'POST')!;
  f.state.authenticationGeneration++; await settle();
  assert.equal(firstPost.signal.aborted, true);
  oldWrite.resolve({ receipts: [receipt('old-session-only', 'other')] });
  await settle();
  assert.equal(f.tracker.indicator('nas', 'other'), 'unread');
  t.mock.timers.tick(150); await settle();
  assert.equal(posts, 2);
  t.mock.timers.tick(30000); await settle();
  assert.equal(posts, 2);
});

test('a suspended HTTP request times out, aborts and can retry after the browser returns online', async t => {
  let posts = 0;
  const f = fixture(t, call => {
    if (call.method === 'GET') return { receipts: [] };
    if (++posts > 1) return { receipts: call.receipts.map(value => receipt(value.turnId, value.threadId, value.activityAt)) };
    return new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  f.tracker.observe('nas', completed('hung'));
  f.tracker.setVisible('nas', 't');
  f.start(); await settle();
  t.mock.timers.tick(150); await settle();
  t.mock.timers.tick(15000); await settle();
  assert.equal(f.calls.find(call => call.method === 'POST')!.signal.aborted, true);
  t.mock.timers.tick(2000); await settle();
  assert.equal(posts, 2);
  t.mock.timers.tick(30000); await settle();
  assert.equal(posts, 2);
});
