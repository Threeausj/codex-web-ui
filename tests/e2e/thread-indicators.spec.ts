import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

function add(mock: MockCodex, id: string, name: string) {
  mock.threads.push({ ...mock.threads[0]!, id, name, preview: name });
  mock.turns.set(id, [{ ...mock.turns.get('thread-existing')![0], id: `${id}-history`, items: [
    { id: `${id}-user`, type: 'userMessage', content: [{ type: 'text', text: `${name}的问题` }] },
    { id: `${id}-agent`, type: 'agentMessage', text: `${name}的回复` },
  ] }]);
}
function begin(mock: MockCodex, threadId: string, id: string) {
  const turn: any = { id, status: 'inProgress', items: [], startedAt: 1792300000, completedAt: null };
  mock.turns.get(threadId)!.push(turn);
  mock.emit('turn/started', { threadId, turn });
  return turn;
}
function complete(mock: MockCodex, threadId: string, turn: any, status = 'completed') {
  turn.status = status; turn.completedAt = 1792300001;
  mock.emit('turn/completed', { threadId, turn });
}
const rows = (page: Page, title: string) => page.locator('.nav-thread').filter({ has: page.locator('.thread-title').filter({ hasText: new RegExp(`^${title}$`) }) });

test('all sidebar groups share orange running, red failed and green unread completion indicators', async ({ page, mock }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  add(mock, 'running-chat', '正在运行的任务');
  add(mock, 'failed-chat', '运行失败的任务');
  add(mock, 'done-chat', '完成待查看的任务');
  mock.preferences.pins.push({ kind: 'thread', hostId: 'local', id: 'done-chat', label: '完成待查看的任务' });
  await login(page);
  begin(mock, 'running-chat', 'running-turn');
  const failed = begin(mock, 'failed-chat', 'failed-turn');
  complete(mock, 'failed-chat', failed, 'failed');
  const finished = begin(mock, 'done-chat', 'done-turn');
  complete(mock, 'done-chat', finished);
  await expect(rows(page, '正在运行的任务').locator('.thread-status-running')).toHaveCount(2);
  await expect(rows(page, '运行失败的任务').locator('.thread-status-error')).toHaveCount(2);
  await expect(rows(page, '完成待查看的任务').locator('.thread-status-unread')).toHaveCount(2);
  await expect(page.locator('[data-section="pinned"] .thread-status-unread')).toHaveCount(1);
  await expect(page.locator('[data-section="projects"] .thread-status-unread')).toHaveCount(1);
  expect(await rows(page, '正在运行的任务').locator('.thread-status-running').first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(217, 138, 49)');
  await page.screenshot({ path: '.data/thread-indicators-desktop.png', animations: 'disabled' });
  await page.locator('[data-section="pinned"] .thread-row').filter({ hasText: '完成待查看的任务' }).click();
  await expect(page.getByText('完成待查看的任务的回复', { exact: true })).toBeVisible();
  await expect(rows(page, '完成待查看的任务').locator('.thread-status-unread')).toHaveCount(0);
  // Duplicate terminal events and title/status refreshes cannot revive green.
  complete(mock, 'done-chat', finished);
  mock.emit('thread/status/changed', { threadId: 'done-chat', status: { type: 'idle' } });
  mock.emit('thread/name/updated', { threadId: 'done-chat', name: '完成待查看的任务' });
  await expect(rows(page, '完成待查看的任务').locator('.thread-status-unread')).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索对话', exact: true }).fill('正在运行的任务');
  await expect(page.locator('.nav-search-results .thread-status-running')).toHaveCount(1);
});

test('unread completion and its read receipt survive page reloads', async ({ page, mock }) => {
  add(mock, 'background-chat', '后台完成的任务');
  await login(page);
  const turn = begin(mock, 'background-chat', 'background-turn');
  complete(mock, 'background-chat', turn);
  await expect(rows(page, '后台完成的任务').locator('.thread-status-unread')).toHaveCount(2);
  await page.reload();
  await expect(rows(page, '后台完成的任务').locator('.thread-status-unread')).toHaveCount(2);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '后台完成的任务' }).click();
  await expect(page.getByText('后台完成的任务的回复', { exact: true })).toBeVisible();
  await expect(rows(page, '后台完成的任务').locator('.thread-status-unread')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  await expect(rows(page, '后台完成的任务').locator('.thread-status-unread')).toHaveCount(0);
});

test('fresh idle navigation recovers a lost completion without ever receiving active metadata', async ({ page, mock }) => {
  add(mock, 'lost-completion', '漏收完成事件');
  await login(page);
  const turn = begin(mock, 'lost-completion', 'lost-turn');
  await expect(rows(page, '漏收完成事件').locator('.thread-status-running')).toHaveCount(2);
  // No turn/completed or active status notification reaches this browser.
  turn.status = 'completed';
  turn.completedAt = 1792300001;
  const thread = mock.threads.find(thread => thread.id === 'lost-completion')!;
  Object.assign(thread, { recencyAt: 1792300001, status: { type: 'idle' } });
  await page.getByRole('button', { name: '刷新对话', exact: true }).click();
  await expect(rows(page, '漏收完成事件').locator('.thread-status-unread')).toHaveCount(2);
  await expect(rows(page, '漏收完成事件').locator('.thread-status-running')).toHaveCount(0);
});

test('opening authoritative completed history clears a lost running marker when timestamps are missing', async ({ page, mock }) => {
  add(mock, 'untimed-completion', '没有时间的完成记录');
  await login(page);
  const turn = begin(mock, 'untimed-completion', 'untimed-turn');
  await expect(rows(page, '没有时间的完成记录').locator('.thread-status-running')).toHaveCount(2);
  Object.assign(turn, { status: 'completed', startedAt: null, completedAt: null });
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '没有时间的完成记录' }).click();
  await expect(page.getByText('没有时间的完成记录的回复', { exact: true })).toBeVisible();
  await expect(rows(page, '没有时间的完成记录').locator('.thread-status-running')).toHaveCount(0);
  await expect(rows(page, '没有时间的完成记录').locator('.thread-status-unread')).toHaveCount(0);
});

test('viewing a completed conversation clears green on a narrow dark sidebar while failed remains red', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('codex.theme', 'dark'));
  add(mock, 'mobile-done', '手机待查看');
  add(mock, 'mobile-error', '手机运行出错');
  await login(page);
  const done = begin(mock, 'mobile-done', 'mobile-done-turn'); complete(mock, 'mobile-done', done);
  const failed = begin(mock, 'mobile-error', 'mobile-error-turn'); complete(mock, 'mobile-error', failed, 'failed');
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await expect(page.locator('[data-section="recent"] .thread-status-unread')).toHaveCount(1);
  await expect(page.locator('[data-section="recent"] .thread-status-error')).toHaveCount(1);
  await page.screenshot({ path: '.data/thread-indicators-mobile-dark.png', animations: 'disabled' });
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '手机待查看' }).click();
  await expect(page.getByText('手机待查看的回复', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await expect(rows(page, '手机待查看').locator('.thread-status-unread')).toHaveCount(0);
  await expect(page.locator('[data-section="recent"] .thread-status-error')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
