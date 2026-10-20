import { test, expect, login, MockCodex } from './fixtures';
import type { Page, WebSocketRoute } from '@playwright/test';

const threadId = 'thread-existing';
const turnId = 'turn-history';
const group = (page: Page) => page.locator(`.conversation-turn[data-turn-id="${turnId}"]`);

function runningTurn(mock: MockCodex, label = '运行中的对话') {
  mock.threads[0] = { ...mock.threads[0], name: label, preview: label, status: { type: 'active' } };
  const turn = mock.turns.get(threadId)![0];
  Object.assign(turn, { status: 'inProgress', completedAt: null, durationMs: null });
  turn.items.splice(1, 0, {
    id: 'restored-command', type: 'commandExecution', command: 'printf running-operation',
    status: 'inProgress', exitCode: null, aggregatedOutput: '当前命令输出',
  });
  Object.assign(turn.items.at(-1), { phase: 'commentary', text: '恢复后的运行进展' });
  return turn;
}

async function select(page: Page, label: string, hostId?: string) {
  if (await page.getByRole('button', { name: '打开侧边栏', exact: true }).isVisible())
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  let row = page.locator('[data-section="recent"] .nav-thread').filter({ hasText: label });
  if (hostId) row = row.locator(`xpath=self::*[@data-host-id="${hostId}"]`);
  await row.locator('.thread-row').click();
}

function finish(mock: MockCodex, turn: any) {
  Object.assign(turn, { status: 'completed', completedAt: 1791200002, durationMs: 2000 });
  turn.items.push({ id: 'restored-final', type: 'agentMessage', phase: 'final_answer', text: '完成后直接显示最终答复' });
  mock.threads[0].status = { type: 'idle' };
  mock.emit('turn/completed', { threadId, turn });
}

for (const width of [1440, 390]) {
  test(`${width}px: restored and reselected running chats show operation rows, respect temporary collapse and fold only after completion`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 844 });
    const turn = runningTurn(mock);
    mock.threads.push({ ...mock.threads[0], id: 'other', name: '另一个已结束对话', status: { type: 'idle' } });
    mock.turns.set('other', []);
    await login(page);
    await select(page, '运行中的对话');
    const activity = group(page).locator('.turn-activity');
    const batch = group(page).locator('.activity-batch');
    await expect(activity).toHaveAttribute('open', '');
    await expect(batch).toHaveAttribute('open', '');
    await expect(batch.locator('.tool-item > summary')).toBeVisible();
    await expect(group(page).getByText('恢复后的运行进展', { exact: true })).toBeVisible();
    await expect(batch.locator('.tool-item')).not.toHaveAttribute('open', '');

    await batch.locator(':scope > summary').click();
    mock.emit('item/commandExecution/outputDelta', { threadId, turnId, itemId: 'restored-command', delta: ' · 实时输出' });
    await expect(batch).not.toHaveAttribute('open', '');
    await activity.locator(':scope > summary').click();
    turn.items.at(-1).text += ' · 新进展';
    mock.emit('item/agentMessage/delta', { threadId, turnId, itemId: 'history-agent', delta: ' · 新进展' });
    await expect(activity).not.toHaveAttribute('open', '');

    await select(page, '另一个已结束对话');
    await select(page, '运行中的对话');
    await expect(activity).toHaveAttribute('open', '');
    await expect(batch).toHaveAttribute('open', '');
    await expect(batch.locator('.tool-item > summary')).toBeVisible();
    await expect(group(page).getByText('恢复后的运行进展 · 新进展', { exact: true })).toBeVisible();

    finish(mock, turn);
    await expect(activity).not.toHaveAttribute('open', '');
    await expect(group(page).getByText('完成后直接显示最终答复', { exact: true })).toBeVisible();
    await expect(group(page).locator('.tool-item')).toHaveCount(0);
    await activity.locator(':scope > summary').click();
    await expect(batch).not.toHaveAttribute('open', '');
    await batch.locator(':scope > summary').click();
    await expect(batch.locator('.tool-item > summary')).toBeVisible();
  });
}

test('a restored running summary automatically fetches one bounded detail page without expanding completed history', async ({ page, mock }) => {
  const turn = runningTurn(mock);
  const original = (mock as any).receive.bind(mock);
  let pending: (() => void) | undefined;
  (mock as any).receive = (socket: WebSocketRoute, request: any) => {
    if (!['thread/turns/list', 'thread/items/list'].includes(request.method)) return original(socket, request);
    mock.requests.push(request);
    if (request.method === 'thread/turns/list') {
      const data = [...(mock.turns.get(request.params.threadId) || [])].reverse().map(entry => ({ ...entry,
        itemsView: request.params.itemsView,
        items: request.params.itemsView === 'notLoaded' ? [] : request.params.itemsView === 'summary'
          ? entry.items.filter((item: any) => ['userMessage', 'agentMessage'].includes(item.type)) : entry.items,
      }));
      return socket.send(JSON.stringify({ id: request.id, result: { data, nextCursor: null } }));
    }
    const response = JSON.stringify({ id: request.id, result: { data: turn.items.map((item: any) => ({ turnId, item })), nextCursor: null } });
    pending = () => socket.send(response);
  };
  await login(page);
  await select(page, '运行中的对话');
  await expect(group(page).getByText('正在加载过程记录…', { exact: true })).toBeVisible();
  await expect.poll(() => !!pending).toBe(true);
  const reads = () => mock.requests.filter(request => request.method === 'thread/items/list');
  expect(reads()).toHaveLength(1);
  expect(reads()[0]!.params).toMatchObject({ threadId, turnId, limit: 40, sortDirection: 'asc' });
  pending!();
  await expect(group(page).locator('.activity-batch')).toHaveAttribute('open', '');
  await expect(group(page).locator('.tool-item > summary')).toBeVisible();
  finish(mock, turn);
  await expect(group(page).locator('.turn-activity')).not.toHaveAttribute('open', '');
  await group(page).locator('.turn-activity > summary').click();
  await expect(group(page).locator('.activity-batch')).not.toHaveAttribute('open', '');
  expect(reads()).toHaveLength(1);
  expect(mock.requests.filter(request => request.method === 'thread/turns/list' && request.params.itemsView === 'full')).toHaveLength(0);
});

test('matching thread and turn IDs on different hosts keep running and finished disclosure states isolated', async ({ page, mock }) => {
  const remote = new MockCodex();
  const turn = runningTurn(remote, '远端运行中的对话');
  const local = mock.turns.get(threadId)![0];
  local.items.splice(1, 0, { id: 'restored-command', type: 'commandExecution', command: 'printf local-history', status: 'completed', exitCode: 0 });
  mock.hosts.push({ id: 'ssh-disclosure', name: '运行服务器', kind: 'ssh', hostname: 'disclosure.invalid' });
  mock.hostMocks.set('ssh-disclosure', remote);
  await login(page);
  await select(page, '已有测试历史', 'local');
  await expect(group(page).locator('.turn-activity')).not.toHaveAttribute('open', '');
  await group(page).locator('.turn-activity > summary').click();
  await group(page).locator('.activity-batch > summary').click();
  await expect(group(page).locator('.tool-item > summary')).toContainText('local-history');
  await select(page, '远端运行中的对话', 'ssh-disclosure');
  await expect(group(page).locator('.turn-activity')).toHaveAttribute('open', '');
  await expect(group(page).locator('.activity-batch')).toHaveAttribute('open', '');
  await expect(group(page).locator('.tool-item > summary')).toContainText('running-operation');
  await select(page, '已有测试历史', 'local');
  await expect(group(page).locator('.turn-activity')).not.toHaveAttribute('open', '');
  await select(page, '远端运行中的对话', 'ssh-disclosure');
  await expect(group(page).locator('.activity-batch')).toHaveAttribute('open', '');
  finish(remote, turn);
  await expect(group(page).locator('.turn-activity')).not.toHaveAttribute('open', '');
  await select(page, '已有测试历史', 'local');
  await select(page, '远端运行中的对话', 'ssh-disclosure');
  await expect(group(page).locator('.turn-activity')).not.toHaveAttribute('open', '');
});
