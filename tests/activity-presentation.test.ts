import test from 'node:test';
import assert from 'node:assert/strict';
import { activityBlocks, activityBatchSummary, publicReasoningSummary } from '../src/lib/activity-presentation';
import { turnPresentation } from '../src/lib/presentation';

test('only nonempty public reasoning is visible, including summaries that arrive after private deltas', () => {
  const thought = { id: 'thought', type: 'reasoning', summary: ['', '  ', null], content: ['private reasoning'] };
  assert.equal(publicReasoningSummary(thought), '');
  assert.deepEqual(turnPresentation([thought]).activity, []);
  assert.equal(publicReasoningSummary({ ...thought, summary: 'malformed' }), '');
  const publicThought = { ...thought, summary: ['公开摘要', '', '后续摘要'] };
  assert.equal(publicReasoningSummary(publicThought), '公开摘要\n\n后续摘要');
  assert.deepEqual(turnPresentation([publicThought]).activity.map(item => item.id), ['thought']);
});

test('consecutive operations share one stable batch across invisible reasoning and live additions', () => {
  const items = [
    { id: 'read', type: 'commandExecution', turnId: 'one' },
    { id: 'private', type: 'reasoning', turnId: 'one', content: ['private'] },
    { id: 'command', type: 'commandExecution', turnId: 'one' },
    { id: 'patch', type: 'fileChange', turnId: 'one' },
  ];
  const before = turnPresentation(items);
  assert.equal(before.activityBlocks.length, 1);
  const batch = before.activityBlocks[0];
  assert.equal(batch.kind, 'batch');
  assert.equal(batch.id, 'activity:read');
  assert.deepEqual(batch.kind === 'batch' && batch.items.map(item => item.id), ['read', 'command', 'patch']);
  assert.equal(turnPresentation([...items, { id: 'next', type: 'webSearch', turnId: 'one' }]).activityBlocks[0].id, batch.id);
});

test('public reasoning, assistant text, plans, compaction and turn changes each end a batch without reordering', () => {
  const items = [
    { id: 'tool-one', type: 'commandExecution', turnId: 'one' },
    { id: 'summary', type: 'reasoning', turnId: 'one', summary: ['公开摘要'] },
    { id: 'tool-two', type: 'mcpToolCall', turnId: 'one' },
    { id: 'commentary', type: 'agentMessage', turnId: 'one', phase: 'commentary', text: '正在处理' },
    { id: 'tool-three', type: 'webSearch', turnId: 'one' },
    { id: 'plan', type: 'plan', turnId: 'one', text: '计划' },
    { id: 'tool-four', type: 'fileChange', turnId: 'one' },
    { id: 'compact', type: 'contextCompaction', turnId: 'one' },
    { id: 'tool-five', type: 'imageView', turnId: 'one' },
    { id: 'final', type: 'agentMessage', turnId: 'one', phase: 'final_answer', text: '完成' },
    { id: 'tool-six', type: 'dynamicToolCall', turnId: 'one' },
    { id: 'tool-next-turn', type: 'commandExecution', turnId: 'two' },
  ];
  const result = turnPresentation(items);
  assert.deepEqual(result.activityBlocks.map(block => block.id), [
    'activity:tool-one', 'summary', 'activity:tool-two', 'commentary',
    'activity:tool-three', 'plan', 'activity:tool-four', 'activity:tool-five',
    'activity:tool-six', 'activity:tool-next-turn',
  ]);
  assert.deepEqual(result.activityBlocks.flatMap(block => block.kind === 'batch' ? block.items.map(item => item.id) : [block.id]), result.activity.map(item => item.id));
  // The caller may include a divider in the activity view in future.
  assert.equal(activityBlocks(items.slice(6, 9), items.slice(6, 9))[1].kind, 'item');
});

test('batch summaries count file targets and commands while preserving failures and ongoing work', () => {
  const result = activityBatchSummary([
    { id: 'read', type: 'commandExecution', commandActions: [{ type: 'read', path: '/a' }, { type: 'read', path: '/b' }], status: 'completed', exitCode: 0 },
    { id: 'command-one', type: 'commandExecution', status: 'inProgress' },
    { id: 'command-two', type: 'commandExecution', status: 'completed', exitCode: 1 },
    { id: 'patch', type: 'fileChange', changes: [{ path: '/a' }, { path: '/b' }], status: 'interrupted' },
  ]);
  assert.equal(result.label, '正在读取 2 个文件、运行 2 条命令、修改 2 个文件');
  assert.equal(result.status, '1 项运行中 · 1 项失败 · 1 项已停止');
  assert.equal(result.failed, 1);
  assert.equal(activityBatchSummary([{ id: 'command', type: 'commandExecution', status: 'completed' }]).label, '已运行 1 条命令');
});
