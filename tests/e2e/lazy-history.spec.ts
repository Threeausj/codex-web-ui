import { test, expect, login, type MockCodex } from './fixtures';
import type { Page, WebSocketRoute } from '@playwright/test';

const threadId = 'thread-existing';
function lazyWire(mock: MockCodex, count = 64) {
  const turn = mock.turns.get(threadId)![0];
  turn.items.splice(1, 0, ...Array.from({ length: count }, (_, index) => ({
    id: `lazy-command-${index}`, type: 'commandExecution', command: `printf operation-${index}`,
    aggregatedOutput: `detail output ${index}\n${'x'.repeat(256 * 1024)}`, status: 'completed', exitCode: 0,
  })));
  turn.items.at(-1).phase = 'final_answer';
  const original = (mock as any).receive.bind(mock);
  const control = { hold: false, failNext: false, unsupported: false, summaryUnsupported: false, held: [] as (() => void)[] };
  (mock as any).receive = (socket: WebSocketRoute, request: any) => {
    if (!['thread/turns/list', 'thread/items/list'].includes(request.method)) return original(socket, request);
    mock.requests.push(request);
    if (request.method === 'thread/turns/list') {
      if (control.summaryUnsupported && request.params.itemsView === 'summary') return socket.send(JSON.stringify({ id: request.id, error: { code: -32602, message: 'unknown variant summary for itemsView' } }));
      const all = [...(mock.turns.get(request.params.threadId) || [])].reverse();
      const offset = Number(request.params.cursor || 0);
      const data = all.slice(offset, offset + request.params.limit).map(entry => ({ ...entry,
        itemsView: request.params.itemsView,
        items: request.params.itemsView === 'notLoaded' ? [] : request.params.itemsView === 'summary'
          ? [entry.items.find((item: any) => item.type === 'userMessage'), entry.items.filter((item: any) => item.type === 'agentMessage').at(-1)].filter(Boolean) : entry.items,
      }));
      return socket.send(JSON.stringify({ id: request.id, result: { data, nextCursor: offset + request.params.limit < all.length ? String(offset + request.params.limit) : null } }));
    }
    if (control.unsupported) return socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'unsupported method' } }));
    if (control.failNext) { control.failNext = false; return socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: 'temporary detail failure' } })); }
    const source = (mock.turns.get(request.params.threadId) || []).find(entry => entry.id === request.params.turnId);
    const offset = Number(request.params.cursor || 0);
    const response = JSON.stringify({ id: request.id, result: { data: (source?.items || []).slice(offset, offset + request.params.limit)
      .map((item: any) => ({ turnId: source.id, item })), nextCursor: offset + request.params.limit < (source?.items.length || 0) ? String(offset + request.params.limit) : null } });
    const send = () => socket.send(response);
    if (control.hold) control.held.push(send); else send();
  };
  return { turn, control, release: () => { control.hold = false; for (const send of control.held.splice(0)) send(); } };
}
async function open(page: Page, name = '已有测试历史') {
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: name }).first().click();
}
const group = (page: Page) => page.locator('.conversation-turn[data-turn-id="turn-history"]');
const itemReads = (mock: MockCodex) => mock.requests.filter(request => request.method === 'thread/items/list');

test('16 MiB operation history opens with messages only, then loads the selected turn in bounded pages', async ({ page, mock }) => {
  const fixture = lazyWire(mock); fixture.control.hold = true;
  await login(page); await open(page);
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '消息输入框' }).fill('无需等待过程详情即可继续');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(itemReads(mock)).toHaveLength(0);
  expect(mock.requests.filter(request => request.method === 'thread/turns/list' && request.params.itemsView === 'full')).toHaveLength(0);
  const turn = group(page);
  await turn.locator('.turn-activity > summary').click();
  await expect(turn.getByText('正在加载过程记录…', { exact: true })).toBeVisible();
  await expect(turn.getByText('此轮没有额外的过程记录。', { exact: true })).toHaveCount(0);
  expect(itemReads(mock)).toHaveLength(1);
  expect(itemReads(mock)[0]!.params).toMatchObject({ threadId, turnId: 'turn-history', limit: 40, sortDirection: 'asc' });
  fixture.release();
  await expect(turn.locator('.activity-batch > summary')).toContainText('运行 39 条命令');
  await turn.getByRole('button', { name: '加载更多过程记录', exact: true }).click();
  await expect(turn.locator('.activity-batch > summary')).toContainText('运行 64 条命令');
  await expect(turn.getByRole('button', { name: '加载更多过程记录', exact: true })).toHaveCount(0);
  expect(itemReads(mock)).toHaveLength(2);
  await expect(page.getByText('历史保持可读', { exact: true })).toHaveCount(1);
  await turn.locator('.activity-batch > summary').click();
  await turn.locator('.tool-item').last().locator(':scope > summary').click();
  await expect(turn.locator('.tool-item').last()).toContainText('detail output 63');
});

test('loading details is deduplicated and a temporary failure has a local retry without a full history download', async ({ page, mock }) => {
  const fixture = lazyWire(mock, 1); fixture.control.hold = true;
  await login(page); await open(page);
  const summary = group(page).locator('.turn-activity > summary');
  await summary.click(); await expect.poll(() => fixture.control.held.length).toBe(1);
  await summary.click(); await summary.click();
  expect(itemReads(mock)).toHaveLength(1);
  fixture.release();
  await expect(group(page).locator('.activity-batch')).toHaveCount(1);
  // A new selection on an unvalidated history loses detail authorization.
  fixture.turn.items.push({ id: 'new-anchor', type: 'agentMessage', text: 'changed anchor' });
  fixture.control.failNext = true;
  await open(page);
  const newSummary = group(page).locator('.turn-activity > summary');
  if ((await group(page).locator('.turn-activity').getAttribute('open')) === null) await newSummary.click();
  await expect(group(page).getByRole('alert')).toContainText('temporary detail failure');
  await expect(page.locator('.global-error')).toHaveCount(0);
  await group(page).getByRole('button', { name: '重试加载过程', exact: true }).click();
  await expect(group(page).getByRole('alert')).toHaveCount(0);
  expect(mock.requests.filter(request => request.method === 'thread/turns/list' && request.params.itemsView === 'full')).toHaveLength(0);
});

test('completed detail cache is reused across conversation switches without re-reading item pages', async ({ page, mock }) => {
  lazyWire(mock, 1);
  mock.threads.push({ ...mock.threads[0], id: 'other', name: '另一个懒加载对话' }); mock.turns.set('other', []);
  await login(page); await open(page);
  await group(page).locator('.turn-activity > summary').click();
  await expect(group(page).locator('.activity-batch')).toHaveCount(1);
  await open(page, '另一个懒加载对话'); await open(page);
  await group(page).locator('.turn-activity > summary').click();
  await group(page).locator('.activity-batch > summary').click();
  await group(page).locator('.tool-item > summary').click();
  await expect(group(page).locator('.tool-item')).toContainText('detail output 0');
  expect(itemReads(mock)).toHaveLength(1);
});

test('a late item response never paints the conversation selected afterward', async ({ page, mock }) => {
  const fixture = lazyWire(mock, 1); fixture.control.hold = true;
  mock.threads.push({ ...mock.threads[0], id: 'other', name: '切换目标' });
  mock.turns.set('other', [{ id: 'other-turn', itemsView: 'full', status: 'completed', items: [{ id: 'other-answer', type: 'agentMessage', text: '目标会话内容' }] }]);
  await login(page); await open(page);
  await group(page).locator('.turn-activity > summary').click();
  await expect.poll(() => fixture.control.held.length).toBe(1);
  await open(page, '切换目标'); fixture.release();
  await expect(page.getByText('目标会话内容', { exact: true })).toBeVisible();
  await expect(page.locator('.tool-item')).toHaveCount(0);
  await expect(page.getByText('已有测试问题', { exact: true })).toHaveCount(0);
});

test('new live output arriving during item hydration wins over the persisted snapshot', async ({ page, mock }) => {
  const fixture = lazyWire(mock, 1); fixture.control.hold = true;
  await login(page); await open(page);
  await group(page).locator('.turn-activity > summary').click();
  await expect.poll(() => fixture.control.held.length).toBe(1);
  mock.emit('item/completed', { threadId, turnId: 'turn-history', item: { ...fixture.turn.items[1], aggregatedOutput: 'newer streamed output' } });
  fixture.release();
  await group(page).locator('.activity-batch > summary').click();
  await group(page).locator('.tool-item > summary').click();
  await expect(group(page).locator('.tool-item')).toContainText('newer streamed output');
  await expect(group(page).locator('.tool-item')).not.toContainText('detail output 0');
});

test('older stores fall back to the full source page, and older summary interfaces fall back on first open', async ({ page, mock }) => {
  const fixture = lazyWire(mock, 1); fixture.control.unsupported = true;
  await login(page); await open(page);
  await group(page).locator('.turn-activity > summary').click();
  await expect(group(page).locator('.activity-batch')).toHaveCount(1);
  expect(mock.requests.filter(request => request.method === 'thread/turns/list' && request.params.itemsView === 'full')).toHaveLength(1);
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(1);
  fixture.control.summaryUnsupported = true;
  await page.reload(); await open(page);
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await group(page).locator('.turn-activity > summary').click();
  await expect(group(page).locator('.activity-batch')).toHaveCount(1);
});

test('a compaction marker discovered in the second item page keeps its position before the final answer', async ({ page, mock }) => {
  const fixture = lazyWire(mock, 41);
  fixture.turn.items.splice(41, 0, { id: 'paged-compaction', type: 'contextCompaction', status: 'completed' });
  await login(page); await open(page);
  await group(page).locator('.turn-activity > summary').click();
  await group(page).getByRole('button', { name: '加载更多过程记录', exact: true }).click();
  await expect(group(page).locator('.compaction-divider')).toHaveCount(1);
  const order = await group(page).evaluate(element => [...element.querySelectorAll('.compaction-divider, .agent-message')].map(item => item.classList.contains('compaction-divider') ? 'compaction' : 'answer'));
  expect(order).toEqual(['compaction', 'answer']);
});

test('native summary omissions do not discard loaded commentary or steering messages from the detail cache', async ({ page, mock }) => {
  const fixture = lazyWire(mock, 1);
  fixture.turn.items.splice(2, 0,
    { id: 'steering-history', type: 'userMessage', content: [{ type: 'text', text: '此前的补充要求' }] },
    { id: 'commentary-history', type: 'agentMessage', phase: 'commentary', text: '此前的中间进展' });
  mock.threads.push({ ...mock.threads[0], id: 'other', name: '另一个懒加载对话' }); mock.turns.set('other', []);
  await login(page); await open(page);
  await expect(page.getByText('此前的补充要求', { exact: true })).toHaveCount(0);
  await group(page).locator('.turn-activity > summary').click();
  await expect(page.getByText('此前的补充要求', { exact: true })).toBeVisible();
  await expect(group(page).getByText('此前的中间进展', { exact: true })).toBeVisible();
  await open(page, '另一个懒加载对话'); await open(page);
  await group(page).locator('.turn-activity > summary').click();
  await expect(page.getByText('此前的补充要求', { exact: true })).toBeVisible();
  await expect(group(page).getByText('此前的中间进展', { exact: true })).toBeVisible();
  expect(itemReads(mock)).toHaveLength(1);
});
