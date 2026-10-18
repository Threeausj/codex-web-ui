import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadIndicators, threadIndicatorStorageKey } from '../src/lib/thread-indicators';

function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) };
  let clock = 1000;
  return { values, storage, tracker: createThreadIndicators(storage, () => ++clock) };
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
