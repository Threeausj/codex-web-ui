import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAcceptedTurnItems, mergeTurnSnapshot, writerConflict } from '../src/lib/thread-sync.js';
import { applyItemEvent, type DisplayItem } from '../src/lib/events.js';

test('accepted turn snapshots hydrate users while preserving newer agent deltas and replacing optimistic aliases', () => {
  const items: DisplayItem[] = [
    { id: 'client-user', clientId: 'client-user', type: 'userMessage', status: 'sending', content: [{ type: 'text', text: '问题' }] },
    { id: 'agent', type: 'agentMessage', text: '已经完成的流式回复', turnId: 'turn' },
  ];
  mergeAcceptedTurnItems(items, { id: 'turn', items: [
    { id: 'canonical-user', clientId: 'client-user', type: 'userMessage', content: [{ type: 'text', text: '问题' }] },
    { id: 'agent', type: 'agentMessage', text: '已经' },
  ] }, { input: [{ type: 'text', text: '问题' }], clientUserMessageId: 'client-user' });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'canonical-user');
  assert.equal(items[0].status, undefined);
  assert.equal(items[1].text, '已经完成的流式回复');
  applyItemEvent(items, 'item/completed', { turnId: 'turn', item: items[0] });
  assert.equal(items.length, 2);
});

test('accepted steering input appears once and the later official item replaces its alias', () => {
  const items: DisplayItem[] = [];
  const input = [{ type: 'text', text: '补充要求' }];
  for (let repeat = 0; repeat < 2; repeat++)
    mergeAcceptedTurnItems(items, { id: 'turn' }, { input, clientUserMessageId: 'client-steer' });
  assert.equal(items.length, 1);
  applyItemEvent(items, 'item/completed', { turnId: 'turn', item: {
    id: 'canonical-steer', clientId: 'client-steer', type: 'userMessage', content: input,
  } });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'canonical-steer');
});

test('a reconnect acknowledgement confirms the existing optimistic steering alias', () => {
  const items: DisplayItem[] = [{ id: 'client-steer', clientId: 'client-steer', type: 'userMessage', status: 'unconfirmed', content: [{ type: 'text', text: '已接收的补充' }] }];
  mergeAcceptedTurnItems(items, { id: 'turn' }, { input: items[0].content, clientUserMessageId: 'client-steer' });
  assert.equal(items.length, 1);
  assert.equal(items[0].status, undefined);
  assert.equal(items[0].turnId, 'turn');
});

test('a late canonical start user precedes its streamed answer while earlier turns remain in place', () => {
  const items: DisplayItem[] = [
    { id: 'older-answer', type: 'agentMessage', turnId: 'older', text: '较早轮回复' },
    { id: 'streamed-answer', type: 'agentMessage', turnId: 'current', text: '当前轮已收到delta' },
  ];
  mergeAcceptedTurnItems(items, { id: 'current', items: [
    { id: 'current-user', type: 'userMessage', content: [{ type: 'text', text: '本轮问题' }] },
    { id: 'streamed-answer', type: 'agentMessage', text: '当前' },
  ] });
  assert.deepEqual(items.map(item => item.id), ['older-answer', 'current-user', 'streamed-answer']);
  assert.equal(items[2].text, '当前轮已收到delta');
});

test('response-only accepted start input precedes its answer and steering input stays after it', () => {
  const items: DisplayItem[] = [
    { id: 'older-answer', type: 'agentMessage', turnId: 'older', text: '较早轮回复' },
    { id: 'streamed-answer', type: 'agentMessage', turnId: 'current', text: '当前轮delta' },
  ];
  mergeAcceptedTurnItems(items, { id: 'current', items: [
    { id: 'streamed-answer', type: 'agentMessage', text: '当前' },
  ] }, { clientUserMessageId: 'fallback-user', input: [{ type: 'text', text: '本轮问题' }], placement: 'start' });
  mergeAcceptedTurnItems(items, { id: 'current' }, { clientUserMessageId: 'steer-user', input: [{ type: 'text', text: '追加要求' }] });
  assert.deepEqual(items.map(item => item.id), ['older-answer', 'fallback-user', 'streamed-answer', 'steer-user']);
  assert.equal(items[2].text, '当前轮delta');
});

test('a late start acknowledgement never changes a completed turn back to running', () => {
  const completed = { id: 'turn', status: 'completed', completedAt: 20, error: null, items: [{ id: 'answer', text: '完整结果' }] };
  const snapshot = mergeTurnSnapshot(completed, { id: 'turn', status: 'inProgress', completedAt: null, items: [{ id: 'answer', text: '完' }] });
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.completedAt, 20);
  assert.deepEqual(snapshot.items, completed.items);
});

test('only native writer conflicts or explicit backend markers enable takeover', () => {
  assert.equal(writerConflict(new Error('thread id already has an active writer')), true);
  assert.equal(writerConflict({ data: { takeoverAvailable: true } }), true);
  assert.equal(writerConflict(new Error('Permission denied')), false);
  assert.equal(writerConflict(new Error('Thread not found')), false);
  assert.equal(writerConflict(new Error('Connection refused')), false);
});

test('a delayed compaction completion follows native item order within its own turn', () => {
  const items: DisplayItem[] = [
    { id: 'older', type: 'agentMessage', turnId: 'older' },
    { id: 'before', type: 'agentMessage', turnId: 'current', text: 'Before' },
    { id: 'after', type: 'agentMessage', turnId: 'current', text: 'After' },
    { id: 'compact', type: 'contextCompaction', turnId: 'current' },
    { id: 'next', type: 'userMessage', turnId: 'next' },
  ];
  mergeAcceptedTurnItems(items, { id: 'current', items: [items[1], items[3], items[2]] }, undefined, false);
  assert.deepEqual(items.map(item => item.id), ['older', 'before', 'compact', 'after', 'next']);
  applyItemEvent(items, 'item/started', { turnId: 'current', item: { id: 'compact', type: 'contextCompaction' } });
  assert.equal(items[2].status, 'inProgress');
  applyItemEvent(items, 'item/completed', { turnId: 'current', item: { id: 'compact', type: 'contextCompaction' } });
  assert.equal(items[2].status, 'completed');
});
