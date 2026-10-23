import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationTimelineRows } from '../src/lib/conversation-timeline';
import { conversationBlocks, turnPresentation } from '../src/lib/presentation';

test('one giant active turn projects each tool into a separate bounded virtual row instead of one oversized batch', () => {
  const items = [{ id: 'user', type: 'userMessage', turnId: 'turn', text: 'start' },
    ...Array.from({ length: 2000 }, (_, i) => ({ id: `command-${i}`, type: 'commandExecution', turnId: 'turn', status: 'completed' })),
    { id: 'answer', type: 'agentMessage', turnId: 'turn', phase: 'final_answer', text: 'done' }];
  const blocks = conversationBlocks(items, [{ id: 'turn', status: 'inProgress' }]);
  const rows = conversationTimelineRows(blocks, { expanded: new Set(['turn']), runningTurnId: 'turn', batchExpanded: () => true, detailState: () => undefined });
  assert.equal(rows.filter(row => row.kind === 'item').length, 2002);
  assert.equal(rows.filter(row => row.kind === 'batch').length, 1);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.equal(rows[0].item!.id, 'user'); assert.equal(rows.at(-1)!.item!.id, 'answer');
});

test('flat virtualization retains steering chronology, compaction position and visible failures across disclosure changes', () => {
  const items = [
    { id: 'user', type: 'userMessage', turnId: 'turn', text: 'start' },
    { id: 'work-before', type: 'commandExecution', turnId: 'turn' },
    { id: 'compaction', type: 'contextCompaction', turnId: 'turn' },
    { id: 'steer', type: 'userMessage', turnId: 'turn', text: 'change' },
    { id: 'work-after', type: 'commandExecution', turnId: 'turn' },
    { id: 'answer', type: 'agentMessage', turnId: 'turn', phase: 'final_answer', text: 'done' },
  ];
  const blocks = conversationBlocks(items, [{ id: 'turn', status: 'failed', error: { message: 'visible error' } }]).map(block => block.kind === 'turn' ? { ...block, ...turnPresentation(block.items) } : block);
  const rows = conversationTimelineRows(blocks, { expanded: new Set(['turn']), runningTurnId: null, batchExpanded: () => true, detailState: () => undefined });
  assert.deepEqual(rows.filter(row => row.item).map(row => row.item!.id), items.map(item => item.id));
  assert.equal(rows.at(-1)!.text, 'visible error');
  const closed = conversationTimelineRows(blocks, { expanded: new Set(), runningTurnId: null, batchExpanded: () => false, detailState: () => undefined });
  assert.deepEqual(closed.filter(row => row.item).map(row => row.item!.id), ['user', 'compaction', 'steer', 'answer']);
  assert.equal(closed.at(-1)!.text, 'visible error');
});
