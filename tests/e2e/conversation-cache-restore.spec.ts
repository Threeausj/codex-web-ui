import { test, expect, login, type MockCodex } from './fixtures';
import type { Page, WebSocketRoute } from '@playwright/test';

const first = 'thread-existing';
function addSecond(mock: MockCodex) {
  mock.threads.push({ ...mock.threads[0], id: 'thread-second', name: '另一个缓存测试对话' });
  mock.turns.set('thread-second', [{ id: 'second-turn', status: 'completed', items: [
    { id: 'second-answer', type: 'agentMessage', text: '第二个对话的独立历史' },
  ] }]);
}
async function open(page: Page, name: string) {
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: name }).first().click();
}
function holdNative(mock: MockCodex, methods: string[], threadId = first) {
  const native = mock as any;
  const receive = native.receive.bind(mock);
  const held: { socket: WebSocketRoute; request: any }[] = [];
  let holding = true;
  native.receive = (socket: WebSocketRoute, request: any) => {
    if (holding && methods.includes(request.method) && (request.params?.threadId === threadId || request.method === 'config/read')) {
      mock.requests.push(request);
      held.push({ socket, request });
    } else receive(socket, request);
  };
  return { held, release: () => { holding = false; for (const entry of held) receive(entry.socket, entry.request); } };
}
async function persistedCount(page: Page) {
  return page.evaluate(async () => {
    return new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('codex-private-conversations', 1);
      request.onsuccess = () => {
        if (!request.result.objectStoreNames.contains('snapshots')) { request.result.close(); resolve(0); return; }
        const count = request.result.transaction('snapshots').objectStore('snapshots').count();
        count.onsuccess = () => { request.result.close(); resolve(count.result); };
        count.onerror = () => reject(count.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

test('cached switching paints history immediately, loads resume and history in parallel, and cannot send before the writer is confirmed', async ({ page, mock }) => {
  addSecond(mock);
  await login(page);
  await open(page, '已有测试历史');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '消息输入框' }).fill('第一个对话自己的草稿');
  await open(page, '另一个缓存测试对话');
  await expect(page.getByText('第二个对话的独立历史', { exact: true })).toBeVisible();
  const delayed = holdNative(mock, ['thread/resume', 'thread/turns/list']);
  await open(page, '已有测试历史');
  await expect.poll(() => delayed.held.map(entry => entry.request.method).sort()).toEqual(['thread/resume', 'thread/turns/list']);
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('第一个对话自己的草稿');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  // A live update received during revalidation must survive a stale snapshot.
  mock.emit('item/agentMessage/delta', { threadId: first, turnId: 'turn-history', itemId: 'history-agent', delta: '，实时变化保留' });
  delayed.release();
  await expect(page.getByText('历史保持可读，实时变化保留', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a fresh installed-app window restores private cached history and draft before slow integrations or resume finish', async ({ page, context, mock }) => {
  await login(page);
  await open(page, '已有测试历史');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '消息输入框' }).fill('关闭应用后继续的草稿');
  await expect.poll(() => persistedCount(page)).toBe(1);
  await page.close();
  const delayed = holdNative(mock, ['thread/resume', 'thread/turns/list', 'config/read']);
  const reopened = await context.newPage();
  await mock.install(reopened);
  await reopened.goto('/');
  await expect(reopened.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(reopened.locator('.welcome-content')).toHaveCount(0);
  await expect(reopened.getByRole('textbox', { name: '消息输入框' })).toHaveValue('关闭应用后继续的草稿');
  await expect(reopened.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await expect.poll(() => delayed.held.filter(entry => entry.request.method === 'thread/resume').length).toBe(1);
  delayed.release();
  await expect(reopened.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(mock.request('turn/start')).toBeUndefined();
  await reopened.close();
});

test('a failed history refresh keeps the saved target and cached history, and a later foreground recovery restores sending', async ({ page, mock }) => {
  addSecond(mock);
  await login(page);
  await open(page, '已有测试历史');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '消息输入框' }).fill('同步失败也保留草稿');
  await open(page, '另一个缓存测试对话');
  await expect(page.getByText('第二个对话的独立历史', { exact: true })).toBeVisible();
  mock.failHistoryNext = true;
  await open(page, '已有测试历史');
  await expect(page.locator('.global-error')).toContainText('Test history read failed');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('codex.selectedThreadIds') || '{}').local)).toBe(first);
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('同步失败也保留草稿');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('unselected token usage is cached by conversation and fresh usage arriving before compaction completion remains valid', async ({ page, mock }) => {
  addSecond(mock);
  await login(page);
  await open(page, '已有测试历史');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await open(page, '另一个缓存测试对话');
  await expect(page.getByText('第二个对话的独立历史', { exact: true })).toBeVisible();
  mock.emit('thread/tokenUsage/updated', { threadId: first, tokenUsage: { last: { totalTokens: 250 }, total: { totalTokens: 9999 }, modelContextWindow: 1000 } });
  await open(page, '已有测试历史');
  await expect(page.locator('.context-usage')).toContainText('25%');
  mock.emit('item/started', { threadId: first, turnId: 'turn-compact', item: { id: 'compact-item', type: 'contextCompaction' } });
  await expect(page.locator('.context-usage')).toContainText('—');
  mock.emit('thread/tokenUsage/updated', { threadId: first, tokenUsage: { last: { totalTokens: 100 }, modelContextWindow: 1000 } });
  mock.emit('item/completed', { threadId: first, turnId: 'turn-compact', item: { id: 'compact-item', type: 'contextCompaction' } });
  await expect(page.locator('.context-usage')).toContainText('10%');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a paused Web runtime survives app restart without restarting Codex or discarding cached conversation and draft', async ({ page, context, mock }) => {
  await login(page);
  await open(page, '已有测试历史');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '消息输入框' }).fill('切换桌面端前的草稿');
  await expect.poll(() => persistedCount(page)).toBe(1);
  await page.close();
  const before = mock.requests.length;
  const reopened = await context.newPage();
  await mock.install(reopened);
  await reopened.route('**/api/bootstrap*', route => route.fulfill({ json: {
    hosts: mock.hosts, projects: mock.projects, preferences: mock.preferences, cwd: '/workspace/demo', connectionMode: 'spawn', runtimePausedHostIds: ['local'],
  } }));
  await reopened.routeWebSocket(/\/api\/rpc(?:\?|$)/, socket => {
    socket.onMessage(raw => mock.requests.push(JSON.parse(raw.toString())));
    mock.sockets.push(socket);
    socket.send(JSON.stringify({ method: 'bridge/status', params: { connected: false, paused: true, mode: 'spawn', pendingRequests: [] } }));
  });
  await reopened.goto('/');
  await expect(reopened.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(reopened.getByRole('textbox', { name: '消息输入框' })).toHaveValue('切换桌面端前的草稿');
  await expect(reopened.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await reopened.evaluate(() => document.dispatchEvent(new Event('resume')));
  await reopened.waitForTimeout(400);
  expect(mock.requests.slice(before)).toEqual([]);
  await reopened.close();
});

test('logout deletes private snapshots and an expired session cannot paint them in the next app window', async ({ page, context, mock }) => {
  await login(page);
  await open(page, '已有测试历史');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect.poll(() => persistedCount(page)).toBe(1);
  await page.getByRole('button', { name: /^设置\s/ }).click();
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '退出网页', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '访问密码' })).toBeVisible();
  await expect.poll(() => persistedCount(page)).toBe(0);
  const reopened = await context.newPage();
  await mock.install(reopened);
  await reopened.goto('/');
  await expect(reopened.getByRole('textbox', { name: '访问密码' })).toBeVisible();
  await expect(reopened.getByText('历史保持可读', { exact: true })).toHaveCount(0);
  await reopened.close();
});
