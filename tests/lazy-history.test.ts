import test from 'node:test';
import assert from 'node:assert/strict';
import { LazyHistoryReader, mergeHistoryDetails, retainHistoryDetails } from '../src/lib/lazy-history.js';
import { conversationBlocks } from '../src/lib/presentation.js';

const params = { threadId: 'thread', cursor: null, limit: 30, sortDirection: 'desc' as const };
test('summary-only completed shell turns remain visible and full export reads stay full', async () => {
  const reader = new LazyHistoryReader();
  const calls: any[] = [];
  const request = async (_method: any, input: any) => { calls.push(input); return { data: [{ id: 'shell', itemsView: input.itemsView, status: 'completed', items: [] }], nextCursor: null }; };
  const page = await reader.turns('engine', request, params);
  assert.equal(page.data[0].historySummary, true);
  assert.equal(conversationBlocks([], page.data)[0]?.id, 'shell');
  const full = await reader.turns('engine', request, params, true);
  assert.deepEqual(calls.map(input => input.itemsView), ['summary', 'full']);
  assert.equal('historySummary' in full.data[0], false);
});

test('unsupported summaries downgrade only their runtime, while timeouts never cause another history request', async () => {
  const reader = new LazyHistoryReader(); const calls: string[] = [];
  const request = async (_method: any, input: any) => {
    calls.push(input.itemsView);
    if (input.itemsView === 'summary') throw Object.assign(new Error('unknown variant summary for itemsView'), { code: -32602 });
    return { data: [], nextCursor: null };
  };
  await reader.turns('old-engine', request, params);
  await reader.turns('old-engine', request, params);
  assert.deepEqual(calls, ['summary', 'full', 'full']);
  await reader.turns('new-engine', request, params);
  assert.deepEqual(calls.slice(-2), ['summary', 'full']);
  let attempts = 0;
  await assert.rejects(reader.turns('timeout-engine', async () => { attempts++; throw new Error('request timeout'); }, params), /timeout/);
  assert.equal(attempts, 1);
});

test('an older item store re-reads the source page read-only and refuses a removed turn', async () => {
  const reader = new LazyHistoryReader(); const calls: any[] = [];
  let retained = true;
  const turn = { id: 'turn', historySourceCursor: 'older-anchor', historyPageLimit: 30 };
  const request = async (method: any, input: any) => {
    calls.push({ method, input });
    if (method === 'thread/items/list') throw Object.assign(new Error('unsupported method'), { code: -32601 });
    return { data: retained ? [{ id: 'turn', itemsView: 'full', items: [{ id: 'tool', type: 'commandExecution', aggregatedOutput: 'complete' }] }] : [] };
  };
  const page = await reader.items('engine', request, 'thread', turn);
  assert.equal(page.data[0].item.aggregatedOutput, 'complete');
  assert.deepEqual(calls.map(call => call.method), ['thread/items/list', 'thread/turns/list']);
  assert.equal(calls[1].input.cursor, 'older-anchor');
  retained = false;
  await assert.rejects(reader.items('engine', request, 'thread', turn), /历史已变化/);
  assert.equal(calls.at(-1).method, 'thread/turns/list');
});

test('item-page network failures do not downgrade or start full-history reads', async () => {
  const reader = new LazyHistoryReader(); let attempts = 0;
  const request = async () => { attempts++; throw new Error('connection lost'); };
  for (let i = 0; i < 2; i++) await assert.rejects(reader.items('engine', request, 'thread', { id: 'turn' }), /connection lost/);
  assert.equal(attempts, 2);
});

test('wrong-turn items and repeated cursors fail without being applied', async () => {
  const reader = new LazyHistoryReader();
  await assert.rejects(reader.items('engine', async () => ({ data: [{ turnId: 'wrong', item: { id: 'tool' } }], nextCursor: null }), 'thread', { id: 'turn' }), /不匹配/);
  await assert.rejects(reader.items('engine', async () => ({ data: [], nextCursor: 'same' }), 'thread', { id: 'turn', historyItemsStarted: true, historyItemsCursor: 'same' }), /游标重复/);
  await assert.rejects(reader.items('engine', async () => ({ data: [], nextCursor: 'first' }), 'thread', { id: 'turn', historyItemsStarted: true, historyItemsCursor: 'second', historyItemCursors: ['first'] }), /游标重复/);
});

test('prefix pages retain final answers, place compaction before them, and protect concurrent live output', () => {
  const turn = { id: 'turn', status: 'completed', historySummary: true };
  const user = { id: 'user', type: 'userMessage', turnId: 'turn' };
  const answer = { id: 'answer', type: 'agentMessage', turnId: 'turn', text: 'complete answer' };
  const command = { id: 'command', type: 'commandExecution', turnId: 'turn', aggregatedOutput: 'new live output' };
  const older = { id: 'older', type: 'agentMessage', turnId: 'older-turn' };
  const initial = mergeHistoryDetails([older, user, answer, command], [{ id: 'older-turn' }, turn], turn, { data: [
    { item: user }, { item: { ...command, aggregatedOutput: 'stale snapshot' } },
  ], nextCursor: 'next' }, new Set(['command']));
  assert.deepEqual(initial.items.map(item => item.id), ['older', 'user', 'command', 'answer']);
  assert.equal(initial.items[2].aggregatedOutput, 'new live output');
  assert.equal(initial.turn.historySummary, true);
  const final = mergeHistoryDetails(initial.items, [turn], initial.turn, { data: [
    { item: { id: 'compact', type: 'contextCompaction' } }, { item: answer },
  ], nextCursor: null }, new Set());
  assert.deepEqual(final.items.map(item => item.id), ['older', 'user', 'command', 'compact', 'answer']);
  assert.equal(final.turn.historySummary, false);
  assert.equal(final.items.filter(item => item.id === 'answer').length, 1);
});

test('a detail-only turn is inserted at its historical position instead of the conversation tail', () => {
  const turn = { id: 'shell' };
  const result = mergeHistoryDetails([{ id: 'later', type: 'agentMessage', turnId: 'later-turn' }], [turn, { id: 'later-turn' }], turn,
    { data: [{ item: { id: 'command', type: 'commandExecution' } }], nextCursor: null }, new Set());
  assert.deepEqual(result.items.map(item => item.id), ['command', 'later']);
});

test('completed details are reused only when message anchors still match and cached data is complete', () => {
  const items = [{ id: 'user', type: 'userMessage', turnId: 'turn' }, { id: 'tool', type: 'commandExecution', turnId: 'turn', aggregatedOutput: 'cached' }];
  const incoming = [{ id: 'turn', status: 'completed', historySummary: true, items: [items[0]] }];
  const previous = [{ id: 'turn', status: 'completed', historySummary: false, historyItemsStarted: true }];
  assert.equal(retainHistoryDetails(incoming, previous, items)[0].historySummary, false);
  assert.equal(retainHistoryDetails(incoming, previous, items)[0].items.length, 2);
  assert.equal(retainHistoryDetails(incoming, previous, [{ ...items[0], cacheTruncated: true }, items[1]])[0].historySummary, true);
  assert.equal(retainHistoryDetails([{ ...incoming[0], items: [{ id: 'replacement-user', type: 'userMessage' }] }], previous, items)[0].historySummary, true);
  assert.equal(retainHistoryDetails([{ ...incoming[0], status: 'inProgress' }], [{ ...previous[0], status: 'inProgress' }], items)[0].historySummary, true);
});
