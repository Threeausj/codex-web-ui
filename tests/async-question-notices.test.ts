import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncQuestionCheckQueue, useAsyncQuestionNoticeDismissals } from '../src/lib/async-question-notices';
import { asyncQuestionFingerprint } from '../shared/async-question-reply';
import { asyncQuestionNoticeBatches, validAsyncQuestionNoticeFingerprint, type AsyncQuestionNotice } from '../shared/async-question-notices';

const item = (title = 'Which option?') => ({ id: 'question', type: 'agentMessage', delivery: 'async', questions: [{ title, options: ['One', 'Two'] }] });
const notice = (hostId = 'local', title?: string): AsyncQuestionNotice => ({ hostId, threadId: 'thread', turnId: 'turn', itemId: 'question', fingerprint: asyncQuestionFingerprint(item(title))! });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('notice fingerprints bind the exact item, normalized question and choices', () => {
  assert.equal(validAsyncQuestionNoticeFingerprint('question', notice().fingerprint), true);
  for (const fingerprint of ['bad-json', JSON.stringify(['other', item().questions]),
    JSON.stringify(['question', []]), JSON.stringify(['question', [{ title: ' Which option? ', options: ['One', 'Two'] }]]),
    JSON.stringify(['question', [{ title: 'Which option?', options: ['One', 'Two'], ignored: true }]])])
    assert.equal(validAsyncQuestionNoticeFingerprint('question', fingerprint), false);
});

test('server dismissals survive a new view and hide only the matching host and question fingerprint', async () => {
  const persisted: AsyncQuestionNotice[] = [];
  const requestHttp = async (path: string, options?: RequestInit) => {
    if (options?.method === 'POST') { persisted.push(...JSON.parse(options.body as string).questions); return { dismissals: persisted }; }
    return { dismissals: persisted };
  };
  const api = { requestHttp, runtimeIdentity: () => ({ authenticationGeneration: 1 }) };
  const first = useAsyncQuestionNoticeDismissals(api);
  await first.dismiss([notice()]);
  assert.equal(first.dismissed(notice()), true);
  assert.equal(first.dismissed(notice('another-host')), false);
  assert.equal(first.dismissed({ ...notice(), turnId: 'another-turn' }), false);
  assert.equal(first.dismissed(notice('local', 'A revised question?')), false);
  const reopened = useAsyncQuestionNoticeDismissals(api);
  await reopened.refresh();
  assert.equal(reopened.dismissed(notice()), true);
  assert.equal(reopened.state.busy, false);
});

test('long Unicode questions split by actual JSON bytes and oversized single notices fail before dispatch', async () => {
  const large = notice('local', '中'.repeat(10000));
  const batches = asyncQuestionNoticeBatches([large, { ...large, turnId: 'another-turn' }]);
  assert.equal(batches.length, 2);
  for (const questions of batches)
    assert.ok(new TextEncoder().encode(JSON.stringify({ questions })).byteLength <= 48 * 1024);
  assert.deepEqual(batches.flat(), [large, { ...large, turnId: 'another-turn' }]);
  assert.deepEqual(asyncQuestionNoticeBatches(Array.from({ length: 70 }, (_, i) => ({ ...notice(), turnId: String(i) }))).map(batch => batch.length), [32, 32, 6]);
  let requests = 0;
  const store = useAsyncQuestionNoticeDismissals({
    runtimeIdentity: () => ({ authenticationGeneration: 1 }),
    requestHttp: async () => { requests++; return {}; },
  });
  await assert.rejects(store.dismiss([notice('local', '中'.repeat(18000))]), /内容过长/);
  assert.equal(requests, 0); assert.equal(store.state.busy, false);
  await store.dismiss([large, { ...large, turnId: 'another-turn' }]);
  assert.equal(requests, 2); assert.equal(store.dismissed(large), true);
});

test('a late list read cannot restore the banner dismissed while it was in flight', async () => {
  const reading = deferred<any>();
  const store = useAsyncQuestionNoticeDismissals({
    runtimeIdentity: () => ({ authenticationGeneration: 1 }),
    requestHttp: async (_path, options) => options?.method === 'POST' ? {} : reading.promise,
  });
  const old = store.refresh();
  await store.dismiss([notice()]);
  reading.resolve({ dismissals: [] }); await old;
  assert.equal(store.dismissed(notice()), true);
  assert.equal(store.state.loading, false);
});

test('refresh started while dismissal is pending cannot race its committed result', async () => {
  const writing = deferred<any>();
  let reads = 0;
  const store = useAsyncQuestionNoticeDismissals({
    runtimeIdentity: () => ({ authenticationGeneration: 1 }),
    requestHttp: async (_path, options) => {
      if (options?.method === 'POST') return writing.promise;
      reads++; return { dismissals: [] };
    },
  });
  const pending = store.dismiss([notice()]);
  await store.refresh(true); assert.equal(reads, 0);
  writing.resolve({}); await pending;
  assert.equal(store.dismissed(notice()), true);
});

test('logout ignores a late list and dismissal acknowledgement from an older login', async () => {
  let authenticationGeneration = 1;
  const reading = deferred<any>(), writing = deferred<any>();
  const store = useAsyncQuestionNoticeDismissals({
    runtimeIdentity: () => ({ authenticationGeneration }),
    requestHttp: async (_path, options) => options?.method === 'POST' ? writing.promise : reading.promise,
  });
  const oldRead = store.refresh(), oldWrite = store.dismiss([notice()]);
  authenticationGeneration++; store.clear();
  reading.resolve({ dismissals: [notice()] }); writing.resolve({});
  await Promise.all([oldRead, oldWrite]);
  assert.deepEqual(store.state.dismissals, {});
  assert.equal(store.state.busy, false);
});

test('failed persistence keeps the reminder available and a new attempt can close it', async () => {
  let failure = true;
  const store = useAsyncQuestionNoticeDismissals({
    runtimeIdentity: () => ({ authenticationGeneration: 1 }),
    requestHttp: async () => { if (failure) throw new Error('Offline'); return {}; },
  });
  await assert.rejects(store.dismiss([notice()]), /Offline/);
  assert.equal(store.dismissed(notice()), false);
  assert.equal(store.state.busy, false);
  failure = false;
  await store.dismiss([notice()]);
  assert.equal(store.dismissed(notice()), true);
});

test('native reconciliation caps concurrency and retries a negative answer after its TTL', async () => {
  let now = 1000, active = 0, maximum = 0, checks = 0;
  const queue = new AsyncQuestionCheckQueue(() => now, 20);
  const release = deferred<void>();
  const work = async () => { checks++; active++; maximum = Math.max(maximum, active); await release.promise; active--; return true; };
  const reads = Array.from({ length: 8 }, (_, i) => queue.check(String(i), work));
  await tick(); assert.equal(active, 2); assert.equal(checks, 2);
  release.resolve(); await Promise.all(reads);
  assert.equal(maximum, 2); assert.equal(checks, 8);
  await queue.check('0', work); assert.equal(checks, 8);
  now += 21;
  await queue.check('0', work); assert.equal(checks, 9);
  queue.clear();
  await queue.check('0', work); assert.equal(checks, 10);
});

test('failed or obsolete reconciliation is retryable and duplicate in-flight checks share one read', async () => {
  const queue = new AsyncQuestionCheckQueue();
  let checks = 0;
  const release = deferred<boolean>();
  const first = queue.check('same', () => { checks++; return release.promise; });
  const second = queue.check('same', async () => { checks++; return true; });
  assert.equal(first, second); assert.equal(checks, 1);
  release.resolve(false); await first;
  await queue.check('same', async () => { checks++; throw new Error('Disconnected'); });
  await queue.check('same', async () => { checks++; return true; });
  assert.equal(checks, 3);
});

test('logout cancels queued history checks and the queue bounds long-lived pending work', async () => {
  const queue = new AsyncQuestionCheckQueue();
  const release = deferred<void>();
  let started = 0;
  const checks = Array.from({ length: 300 }, (_, i) => queue.check(String(i), async () => { started++; await release.promise; return true; }));
  assert.equal(started, 2);
  queue.clear();
  release.resolve(); await Promise.all(checks);
  assert.equal(started, 2);
  await queue.check('new-login', async () => { started++; return true; });
  assert.equal(started, 3);
});
