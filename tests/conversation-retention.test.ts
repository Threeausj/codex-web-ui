import assert from 'node:assert/strict';
import test from 'node:test';
import { boundConversationOutputs, COMMAND_OUTPUT_WINDOW, RETAINED_COMMAND_OUTPUTS, retainConversationHistory } from '../src/lib/conversation-retention';
import { LazyHistoryReader } from '../src/lib/lazy-history';
import { applyItemEvent } from '../src/lib/events';

test('old folded intermediate history releases strings while preserving every user, final answer, compaction and failure', () => {
  const turns = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, status: i === 7 ? 'inProgress' : 'completed' }));
  const items = turns.flatMap(turn => [
    { id: `${turn.id}-user`, turnId: turn.id, type: 'userMessage', text: '输入' },
    { id: `${turn.id}-tool`, turnId: turn.id, type: 'commandExecution', aggregatedOutput: 'x'.repeat(200_000), status: 'completed', exitCode: 0 },
    { id: `${turn.id}-reason`, turnId: turn.id, type: 'reasoning', summary: ['公开中间摘要'.repeat(1000)] },
    { id: `${turn.id}-compaction`, turnId: turn.id, type: 'contextCompaction', status: 'completed' },
    { id: `${turn.id}-failure`, turnId: turn.id, type: 'commandExecution', exitCode: 1, aggregatedOutput: 'specific failure' },
    { id: `${turn.id}-steer`, turnId: turn.id, type: 'userMessage', text: '追加输入' },
    { id: `${turn.id}-answer`, turnId: turn.id, type: 'agentMessage', phase: 'final_answer', text: '最终回复' },
  ]);
  const before = Buffer.byteLength(JSON.stringify(items));
  const value = retainConversationHistory(items, turns, new Set(['t2']));
  assert.deepEqual([...value.evicted], ['t0', 't1', 't3', 't4']);
  for (const turn of turns) for (const suffix of ['user', 'steer', 'answer', 'failure', 'compaction'])
    assert.ok(value.items.some(item => item.id === `${turn.id}-${suffix}`));
  assert.equal(value.turns[0].historyItemsStarted, false);
  assert.equal(value.turns[0].historySummary, true);
  assert.equal(value.turns[2], turns[2], 'expanded history stays intact');
  assert.ok(before - Buffer.byteLength(JSON.stringify(value.items)) > 800_000);
  console.log(JSON.stringify({ retentionFixtureTurns: turns.length, sourceBytes: before, retainedBytes: Buffer.byteLength(JSON.stringify(value.items)), evictedCompletedTurns: value.evicted.size }));
  assert.equal(value.items.findIndex(item => item.id === 't0-steer') < value.items.findIndex(item => item.id === 't0-answer'), true);
});

test('an active turn with 2000 completed commands retains at most sixteen output windows and explicit reload anchors', () => {
  const items: any[] = [{ id: 'input', type: 'userMessage', turnId: 'live', text: 'run' },
    ...Array.from({ length: 2000 }, (_, i) => ({ id: `command-${i}`, turnId: 'live', type: 'commandExecution', status: 'completed', aggregatedOutput: `${i}:` + 'x'.repeat(160_000) }))];
  const bounded = boundConversationOutputs(items);
  assert.equal(bounded.filter(item => !!item.aggregatedOutput).length, RETAINED_COMMAND_OUTPUTS);
  assert.ok(bounded.reduce((sum, item) => sum + (item.aggregatedOutput?.length || 0), 0) <= RETAINED_COMMAND_OUTPUTS * COMMAND_OUTPUT_WINDOW);
  assert.equal(bounded[1].outputPreviousItemId, 'input');
  assert.equal(bounded[100].outputPreviousItemId, 'command-98');
  assert.equal(bounded[1].outputTotalLength, items[1].aggregatedOutput.length);
  assert.equal(items[1].aggregatedOutput.length > 160_000, true, 'source arrays are not mutated');
  assert.equal(boundConversationOutputs(bounded), bounded, 'stable snapshots do not copy unchanged windows');
  console.log(JSON.stringify({ activeTurnCommands: 2000, sourceOutputChars: items.reduce((sum, item) => sum + (item.aggregatedOutput?.length || 0), 0), retainedOutputChars: bounded.reduce((sum, item) => sum + (item.aggregatedOutput?.length || 0), 0) }));
});

test('windowed deltas count new bytes once and authoritative completion resets previous truncation metadata', () => {
  let items: any[] = [{ id: 'c', type: 'commandExecution', turnId: 'turn', status: 'inProgress', aggregatedOutput: 'x'.repeat(COMMAND_OUTPUT_WINDOW + 500) }];
  items = boundConversationOutputs(items);
  applyItemEvent(items, 'item/commandExecution/outputDelta', { itemId: 'c', delta: 'more' });
  items = boundConversationOutputs(items);
  assert.equal(items[0].outputTotalLength, COMMAND_OUTPUT_WINDOW + 504);
  applyItemEvent(items, 'item/completed', { turnId: 'turn', item: { id: 'c', type: 'commandExecution', status: 'completed', aggregatedOutput: 'authoritative output' } });
  items = boundConversationOutputs(items);
  assert.equal(items[0].outputTotalLength, undefined);
  assert.equal(items[0].aggregatedOutput, 'authoritative output');
});

test('only a successful native item-page response authorizes destructive history retention', async () => {
  const reader = new LazyHistoryReader();
  assert.equal(reader.canReloadItems('runtime', 'thread'), false);
  assert.equal(await reader.probeItems('empty', async () => ({ data: [], nextCursor: null }), 'thread', 'active'), false,
    'an active turn not yet readable from native history does not authorize output removal');
  assert.equal(await reader.probeItems('runtime', async () => { throw { code: -32601, message: 'thread/items/list unsupported' }; }, 'thread', 'turn'), false);
  let called = false;
  await reader.probeItems('runtime', async () => { called = true; return { data: [] }; }, 'thread', 'turn');
  assert.equal(called, false, 'unsupported runtimes keep their irreplaceable output');
  assert.equal(reader.canReloadItems('runtime', 'thread'), false);
  assert.equal(await reader.probeItems('runtime-new', async () => ({ data: [{ turnId: 'turn', item: { id: 'user', type: 'userMessage' } }] }), 'thread', 'turn'), true);
  assert.equal(reader.canReloadItems('runtime-new', 'thread'), true);
  reader.clear(); assert.equal(reader.canReloadItems('runtime-new', 'thread'), false);
});

test('released command output is retrieved through an exclusive native anchor with an older-runtime cursor fallback', async () => {
  const reader = new LazyHistoryReader(), calls: any[] = [];
  const target = { id: 'target', type: 'commandExecution', aggregatedOutput: 'exact original output' };
  const direct = await reader.readItem(async (_method, params) => {
    calls.push(params); return { data: [{ turnId: 'turn', item: target }], nextCursor: null };
  }, 'thread', 'turn', 'target', 'previous');
  assert.equal(direct, target);
  assert.deepEqual(calls[0].cursor, { type: 'item', itemId: 'previous' });
  const fallback = await reader.readItem(async (_method, params) => {
    if (typeof params.cursor === 'object' && params.cursor) throw { code: -32602 };
    return params.cursor ? { data: [{ turnId: 'turn', item: target }], nextCursor: null } :
      { data: [{ turnId: 'turn', item: { id: 'before', type: 'userMessage' } }], nextCursor: 'next' };
  }, 'thread', 'turn', 'target', 'previous');
  assert.equal(fallback, target);
});
