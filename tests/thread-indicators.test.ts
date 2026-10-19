import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadIndicators, threadIndicatorStorageKey } from '../src/lib/thread-indicators';
import type { StoredThreadReadReceipt, ThreadReadReceipt } from '../shared/thread-read-receipts';

function fixture(onRead?: (receipt: ThreadReadReceipt) => void) {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) };
  let clock = 1000;
  return { values, storage, tracker: createThreadIndicators(storage, () => ++clock, onRead) };
}
const turn = (method: 'started' | 'completed', id: string, status = method === 'started' ? 'inProgress' : 'completed', threadId = 't') =>
  ({ method: `turn/${method}`, params: { threadId, turn: { id, status } } });
const snapshot = (status: string, activityAt: number, hostId = 'nas', id = 't') => ({ hostId, id, status: { type: status }, activityAt });

test('running, failed and unread completions have distinct indicators and viewing clears only unread', () => {
  const { tracker } = fixture();
  tracker.observe('nas', turn('started', 'one'));
  assert.equal(tracker.indicator('nas', 't'), 'running');
  tracker.observe('nas', turn('completed', 'one'));
  assert.equal(tracker.indicator('nas', 't'), 'unread');
  tracker.setVisible('nas', 't');
  assert.equal(tracker.indicator('nas', 't'), null);
  tracker.observe('nas', turn('started', 'two'));
  tracker.observe('nas', turn('completed', 'two', 'failed'));
  assert.equal(tracker.indicator('nas', 't'), 'error');
  tracker.setVisible('nas', 't');
  assert.equal(tracker.indicator('nas', 't'), 'error');
  tracker.observe('nas', turn('started', 'three'));
  assert.equal(tracker.indicator('nas', 't'), 'running');
  tracker.observe('nas', turn('completed', 'three'));
  assert.equal(tracker.indicator('nas', 't'), null);
});

test('a selected but hidden conversation retains its unread completion until it becomes visible', () => {
  const { tracker } = fixture();
  tracker.setVisible('nas', 't');
  tracker.observe('nas', turn('started', 'one'));
  tracker.setVisible('nas', null);
  tracker.observe('nas', turn('completed', 'one'));
  assert.equal(tracker.indicator('nas', 't'), 'unread');
  tracker.setVisible('nas', 't');
  assert.equal(tracker.indicator('nas', 't'), null);
});

test('old completed turns, duplicate delivery and metadata writes cannot make a read conversation unread again', () => {
  const { tracker } = fixture();
  tracker.observeThreads([snapshot('idle', 100)]);
  tracker.observe('nas', turn('started', 'one'));
  tracker.observe('nas', turn('completed', 'one'));
  tracker.setVisible('nas', 't');
  tracker.setVisible('nas', null);
  tracker.observe('nas', turn('completed', 'one'));
  tracker.observeThreads([snapshot('idle', 100), snapshot('notLoaded', 100)]);
  tracker.observe('nas', { method: 'thread/status/changed', params: { threadId: 't', status: { type: 'idle' } } });
  tracker.observe('nas', { method: 'thread/name/updated', params: { threadId: 't', name: 'renamed', updatedAt: 999 } });
  assert.equal(tracker.indicator('nas', 't'), null);
  tracker.observe('nas', turn('started', 'two'));
  tracker.observe('nas', turn('completed', 'one'));
  assert.equal(tracker.indicator('nas', 't'), 'running');
});

test('host scoped indicators and read receipts survive a reload without storing conversation content', () => {
  const { tracker, storage, values } = fixture();
  tracker.observe('nas', turn('completed', 'nas-turn'));
  tracker.observe('gpu', turn('completed', 'gpu-turn'));
  tracker.setVisible('nas', 't');
  const restored = createThreadIndicators(storage);
  assert.equal(restored.indicator('nas', 't'), null);
  assert.equal(restored.indicator('gpu', 't'), 'unread');
  assert.equal(values.size, 1);
  const raw = values.get(threadIndicatorStorageKey)!;
  for (const forbidden of ['prompt', 'output', 'title', 'message', 'command']) assert.equal(raw.includes(`"${forbidden}"`), false);
});

test('initial idle history establishes a baseline while fresh content can recover a missed completion', () => {
  const { tracker } = fixture();
  tracker.observeThreads([snapshot('idle', 0)]);
  tracker.observeThreads([snapshot('idle', 100)]);
  assert.equal(tracker.indicator('nas', 't'), null);
  tracker.observeThreads([snapshot('active', 101)]);
  assert.equal(tracker.indicator('nas', 't'), 'running');
  tracker.observeThreads([snapshot('idle', 102)]);
  assert.equal(tracker.indicator('nas', 't'), 'unread');
  tracker.setVisible('nas', 't');
  tracker.setVisible('nas', null);
  tracker.observeThreads([snapshot('idle', 102), snapshot('idle', 99), snapshot('notLoaded', 102)]);
  assert.equal(tracker.indicator('nas', 't'), null);
  tracker.observeThreads([snapshot('idle', 105)]);
  assert.equal(tracker.indicator('nas', 't'), 'unread');
});

test('an old idle snapshot cannot finish a turn which has just started before native active metadata arrives', () => {
  const { tracker } = fixture();
  tracker.observeThreads([snapshot('idle', 100)]);
  tracker.observe('nas', turn('started', 'one'));
  tracker.observeThreads([snapshot('idle', 101)]);
  assert.equal(tracker.indicator('nas', 't'), 'running');
  tracker.observeThreads([snapshot('active', 101)]);
  tracker.observe('nas', turn('completed', 'one', 'interrupted'));
  tracker.observeThreads([snapshot('active', 101)]);
  assert.equal(tracker.indicator('nas', 't'), null);
  tracker.observeThreads([snapshot('idle', 101)]);
  assert.equal(tracker.indicator('nas', 't'), null);
});

test('a native error followed by a fresh active transition returns to orange even before its first output', () => {
  const { tracker } = fixture();
  tracker.observeThreads([snapshot('systemError', 100)]);
  assert.equal(tracker.indicator('nas', 't'), 'error');
  tracker.observeThreads([snapshot('active', 100)]);
  assert.equal(tracker.indicator('nas', 't'), 'running');
});

test('a fresh idle content timestamp recovers a missed completion even when active metadata was never received', () => {
  const { tracker } = fixture();
  tracker.observeThreads([snapshot('idle', 100)]);
  tracker.observe('nas', { method: 'turn/started', params: { threadId: 't', turn: { id: 'one', status: 'inProgress', startedAt: 101 } } });
  tracker.observeThreads([snapshot('idle', 101)]);
  assert.equal(tracker.indicator('nas', 't'), 'running');
  tracker.observeThreads([snapshot('idle', 102)]);
  assert.equal(tracker.indicator('nas', 't'), 'unread');
  tracker.setVisible('nas', 't');
  tracker.setVisible('nas', null);
  tracker.observeThreads([snapshot('idle', 102)]);
  assert.equal(tracker.indicator('nas', 't'), null);
});

test('authoritative completed history retires a running marker with missing or same-second timestamps', () => {
  const { tracker } = fixture();
  tracker.observe('nas', turn('started', 'one'));
  tracker.reconcileCompletedTurn('nas', 't', { id: 'older', status: 'completed' });
  assert.equal(tracker.indicator('nas', 't'), 'running');
  tracker.reconcileCompletedTurn('nas', 't', { id: 'one', status: 'completed' });
  assert.equal(tracker.indicator('nas', 't'), 'unread');
});

test('another browser tab marking the same completed turn read clears its unread dot', () => {
  const { tracker, storage, values } = fixture();
  tracker.observe('nas', turn('completed', 'one'));
  const other = createThreadIndicators(storage);
  other.setVisible('nas', 't');
  tracker.merge(values.get(threadIndicatorStorageKey)!);
  assert.equal(tracker.indicator('nas', 't'), null);
  tracker.observe('nas', turn('completed', 'one'));
  assert.equal(tracker.indicator('nas', 't'), null);
});

test('native errors are red, retryable errors keep running, and deletion clears the exact host record', () => {
  const { tracker } = fixture();
  tracker.observeThreads([snapshot('systemError', 100)]);
  assert.equal(tracker.indicator('nas', 't'), 'error');
  tracker.observe('nas', turn('started', 'one'));
  tracker.observe('nas', { method: 'error', params: { threadId: 't', turnId: 'one', willRetry: true } });
  assert.equal(tracker.indicator('nas', 't'), 'running');
  tracker.observe('nas', { method: 'error', params: { threadId: 't', turnId: 'one', willRetry: false } });
  assert.equal(tracker.indicator('nas', 't'), 'error');
  tracker.observe('gpu', turn('completed', 'gpu-one'));
  tracker.observe('nas', { method: 'thread/deleted', params: { threadId: 't' } });
  assert.equal(tracker.indicator('nas', 't'), null);
  assert.equal(tracker.indicator('gpu', 't'), 'unread');
});

test('invalid or unavailable browser storage does not break live indicators', () => {
  const unavailable = createThreadIndicators({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } });
  unavailable.observe('nas', turn('completed', 'one'));
  assert.equal(unavailable.indicator('nas', 't'), 'unread');
  unavailable.merge('{bad json');
  unavailable.merge(JSON.stringify({ version: 1, entries: [{ hostId: 'nas', threadId: 't', phase: 'unexpected' }] }));
  assert.equal(unavailable.indicator('nas', 't'), 'unread');
});


const storedReceipt = (receipt: ThreadReadReceipt): StoredThreadReadReceipt => ({
  hostId: receipt.hostId, threadId: receipt.threadId, turnIds: [receipt.turnId], activityAt: receipt.activityAt,
});
const completedAt = (id: string, activityAt: number, threadId = 't') => ({
  method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', completedAt: activityAt } },
});

test('independent devices synchronize reads without clearing a later completion in the same second', () => {
  const outgoing: ThreadReadReceipt[] = [], echoes: ThreadReadReceipt[] = [];
  const a = fixture(receipt => outgoing.push(receipt));
  const b = fixture(receipt => echoes.push(receipt));
  for (const device of [a, b]) device.tracker.observe('nas', completedAt('one', 100));
  a.tracker.setVisible('nas', 't');
  assert.deepEqual(outgoing, [{ hostId: 'nas', threadId: 't', turnId: 'one', activityAt: 100 }]);
  b.tracker.mergeReceipts(outgoing.map(storedReceipt));
  assert.equal(b.tracker.indicator('nas', 't'), null);
  assert.deepEqual(echoes, []);
  assert.deepEqual(b.tracker.readReceipts(), []);
  b.tracker.observe('nas', completedAt('two', 100));
  assert.equal(b.tracker.indicator('nas', 't'), 'unread');
  b.tracker.mergeReceipts(outgoing.map(storedReceipt));
  assert.equal(b.tracker.indicator('nas', 't'), 'unread');
});

test('receipts arriving before completion survive reload and remain isolated by host and thread', () => {
  const { tracker, storage } = fixture();
  const receipt = { hostId: 'nas', threadId: 't', turnIds: ['one'], activityAt: 100 };
  tracker.mergeReceipts([receipt]);
  assert.equal(tracker.known('nas', 't'), false);
  assert.equal(tracker.indicator('nas', 't'), null);
  const restored = createThreadIndicators(storage);
  restored.observe('nas', completedAt('one', 100));
  restored.observe('gpu', completedAt('one', 100));
  restored.observe('nas', completedAt('one', 100, 'other'));
  assert.equal(restored.indicator('nas', 't'), null);
  assert.equal(restored.indicator('gpu', 't'), 'unread');
  assert.equal(restored.indicator('nas', 'other'), 'unread');
  assert.deepEqual(restored.readReceipts(), []);
});

test('old receipts never replace an active turn or an error with a read completion', () => {
  const { tracker } = fixture();
  tracker.observe('nas', completedAt('one', 100));
  tracker.observe('nas', turn('started', 'two'));
  tracker.mergeReceipts([{ hostId: 'nas', threadId: 't', turnIds: ['one', 'two'], activityAt: 100 }]);
  assert.equal(tracker.indicator('nas', 't'), 'running');
  tracker.observe('nas', turn('completed', 'two', 'failed'));
  tracker.mergeReceipts([{ hostId: 'nas', threadId: 't', turnIds: ['two'], activityAt: 100 }]);
  assert.equal(tracker.indicator('nas', 't'), 'error');
  tracker.observe('nas', { method: 'thread/deleted', params: { threadId: 't' } });
  tracker.mergeReceipts([{ hostId: 'nas', threadId: 't', turnIds: ['two'], activityAt: 100 }]);
  assert.equal(tracker.known('nas', 't'), false);
});

test('a native read acknowledges metadata-only completions using content recency', () => {
  const outgoing: ThreadReadReceipt[] = [];
  const a = fixture(receipt => outgoing.push(receipt)), b = fixture();
  a.tracker.setVisible('nas', 't');
  a.tracker.observe('nas', completedAt('one', 102));
  b.tracker.mergeReceipts(outgoing.map(storedReceipt));
  b.tracker.observeThreads([snapshot('idle', 100)]);
  b.tracker.observeThreads([snapshot('active', 101)]);
  b.tracker.observeThreads([snapshot('idle', 102)]);
  assert.equal(b.tracker.indicator('nas', 't'), null);
  b.tracker.observeThreads([snapshot('idle', 103)]);
  assert.equal(b.tracker.indicator('nas', 't'), 'unread');
});

test('a read metadata placeholder needs the actual history turn before clearing a native completion', () => {
  const outgoing: ThreadReadReceipt[] = [];
  const a = fixture(receipt => outgoing.push(receipt)), b = fixture();
  a.tracker.observeThreads([snapshot('idle', 100), snapshot('active', 101), snapshot('idle', 102)]);
  a.tracker.setVisible('nas', 't');
  assert.equal(outgoing[0]?.turnId, 'recency:102');
  b.tracker.observe('nas', completedAt('one', 102));
  b.tracker.mergeReceipts(outgoing.map(storedReceipt));
  assert.equal(b.tracker.indicator('nas', 't'), 'unread');
  a.tracker.reconcileCompletedTurn('nas', 't', { id: 'one', status: 'completed', completedAt: 102 });
  assert.equal(outgoing.at(-1)?.turnId, 'one');
  b.tracker.mergeReceipts(outgoing.map(storedReceipt));
  assert.equal(b.tracker.indicator('nas', 't'), null);
  b.tracker.observe('nas', completedAt('two', 102));
  assert.equal(b.tracker.indicator('nas', 't'), 'unread');
});

test('opening an idle history baseline acknowledges the actual completed turn with no duplicate writes', () => {
  const outgoing: ThreadReadReceipt[] = [], values = new Map<string, string>();
  let writes = 0;
  const storage = { getItem: (key: string) => values.get(key) || null,
    setItem(key: string, value: string) { writes++; values.set(key, value); } };
  const tracker = createThreadIndicators(storage, () => 1000, receipt => outgoing.push(receipt));
  tracker.setVisible('nas', 't');
  tracker.observeThreads([snapshot('idle', 120)]);
  tracker.reconcileCompletedTurn('nas', 't', { id: 'last', status: 'completed', completedAt: 120 });
  assert.equal(tracker.indicator('nas', 't'), null);
  assert.deepEqual(outgoing.map(receipt => receipt.turnId), ['recency:120', 'last']);
  const previousWrites = writes;
  tracker.setVisible('nas', 't');
  tracker.observeThreads([snapshot('idle', 120)]);
  tracker.reconcileCompletedTurn('nas', 't', { id: 'last', status: 'completed', completedAt: 120 });
  tracker.mergeReceipts(outgoing.map(storedReceipt));
  assert.equal(outgoing.length, 2);
  assert.equal(writes, previousWrites);
});

test('visible completions and existing history without timestamps produce exact receipts', () => {
  const outgoing: ThreadReadReceipt[] = [];
  const { tracker } = fixture(receipt => outgoing.push(receipt));
  tracker.setVisible('nas', 't');
  tracker.observe('nas', turn('started', 'one'));
  tracker.observe('nas', turn('completed', 'one'));
  assert.deepEqual(outgoing, [{ hostId: 'nas', threadId: 't', turnId: 'one', activityAt: 0 }]);
  tracker.setVisible('nas', 'existing');
  tracker.reconcileCompletedTurn('nas', 'existing', { id: 'history', status: 'completed' });
  assert.deepEqual(outgoing.at(-1), { hostId: 'nas', threadId: 'existing', turnId: 'history', activityAt: 0 });
  const other = fixture();
  other.tracker.mergeReceipts(outgoing.map(storedReceipt));
  other.tracker.observe('nas', turn('completed', 'one'));
  assert.equal(other.tracker.indicator('nas', 't'), null);
  other.tracker.observe('nas', turn('completed', 'two'));
  assert.equal(other.tracker.indicator('nas', 't'), 'unread');
});

test('old entries-only browser reads migrate after reload without uploading unread or error entries', () => {
  const { storage, tracker, values } = fixture();
  tracker.observe('nas', completedAt('one', 100));
  tracker.setVisible('nas', 't');
  tracker.setVisible('nas', null);
  tracker.observe('nas', completedAt('unread', 101, 'unread-thread'));
  tracker.observe('nas', turn('completed', 'failed', 'failed', 'failed-thread'));
  const saved = JSON.parse(values.get(threadIndicatorStorageKey)!);
  delete saved.receipts; delete saved.localReceipts;
  values.set(threadIndicatorStorageKey, JSON.stringify(saved));
  const callbacks: ThreadReadReceipt[] = [];
  const restored = createThreadIndicators(storage, () => 2000, receipt => callbacks.push(receipt));
  assert.deepEqual(restored.readReceipts(), [{ hostId: 'nas', threadId: 't', turnId: 'one', activityAt: 100 }]);
  assert.deepEqual(callbacks, []);
  assert.equal(restored.indicator('nas', 'unread-thread'), 'unread');
  assert.equal(restored.indicator('nas', 'failed-thread'), 'error');
  restored.setVisible('nas', 't');
  assert.deepEqual(callbacks, []);
});

test('local storage reads can be uploaded by another tab while server receipts do not echo', () => {
  const outgoing: ThreadReadReceipt[] = [];
  const a = fixture(), b = fixture(receipt => outgoing.push(receipt));
  a.tracker.observe('nas', completedAt('one', 100));
  a.tracker.setVisible('nas', 't');
  const localStorageEvent = a.values.get(threadIndicatorStorageKey)!;
  b.tracker.merge(localStorageEvent);
  b.tracker.merge(localStorageEvent);
  assert.deepEqual(outgoing, [{ hostId: 'nas', threadId: 't', turnId: 'one', activityAt: 100 }]);
  const c = fixture();
  c.tracker.observe('nas', completedAt('remote', 200, 'other'));
  c.tracker.mergeReceipts([{ hostId: 'nas', threadId: 'other', turnIds: ['remote'], activityAt: 200 }]);
  b.tracker.merge(c.values.get(threadIndicatorStorageKey)!);
  assert.equal(b.tracker.indicator('nas', 'other'), null);
  assert.equal(outgoing.length, 1);
});

test('receipt inputs are bounded and sanitized and never persist arbitrary conversation fields', () => {
  const outgoing: ThreadReadReceipt[] = [], { tracker, values } = fixture(receipt => outgoing.push(receipt));
  const receipts = Array.from({ length: 1100 }, (_, index) => ({ hostId: 'nas', threadId: `t${index}`,
    turnIds: [`turn${index}`], activityAt: index }));
  tracker.mergeReceipts(receipts);
  tracker.mergeReceipts([
    { hostId: 'nas', threadId: 'invalid', turnIds: ['one'], activityAt: -1 },
    { hostId: 'nas', threadId: 'invalid', turnIds: ['one', 'one'], activityAt: 100 },
    { hostId: 'nas', threadId: 'invalid', turnIds: ['one'], activityAt: 100, output: 'private content' } as any,
  ]);
  tracker.observe('nas', { ...completedAt('legitimate', 100), prompt: 'private prompt', output: 'private output', title: 'private title' });
  const raw = values.get(threadIndicatorStorageKey)!, saved = JSON.parse(raw);
  assert.equal(saved.receipts.length, 1000);
  assert.equal(saved.receipts.some((receipt: StoredThreadReadReceipt) => receipt.threadId === 'invalid'), false);
  assert.equal(saved.receipts.some((receipt: StoredThreadReadReceipt) => receipt.threadId === 't0'), false);
  assert.equal(raw.includes('private'), false);
  assert.deepEqual(outgoing, []);
  assert.deepEqual(tracker.readReceipts(), []);
});


test('an older acknowledgement cannot evict recent exact turn identities at the retention limit', () => {
  const { tracker, values } = fixture();
  const latest = Array.from({ length: 16 }, (_, index) => `recent-${index}`);
  tracker.mergeReceipts([{ hostId: 'nas', threadId: 't', turnIds: latest, activityAt: 200 }]);
  tracker.mergeReceipts([{ hostId: 'nas', threadId: 't', turnIds: ['older'], activityAt: 100 }]);
  const saved = JSON.parse(values.get(threadIndicatorStorageKey)!);
  assert.deepEqual(saved.receipts[0].turnIds, latest);
  tracker.observe('nas', completedAt('recent-15', 200));
  assert.equal(tracker.indicator('nas', 't'), null);
});
