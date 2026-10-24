import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';
import type { ConversationBookmark } from '../../shared/bookmarks';

const row = (page: Page, hostId = 'local') => page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"]`).first();
const naming = (page: Page) => page.getByRole('dialog', { name: '收藏聊天', exact: true });
const excerpt: ConversationBookmark = {
  id: '00000000-0000-4000-8000-000000000100', hostId: 'local', projectPath: '/workspace/demo', name: '旧版选中内容',
  source: { threadId: 'thread-existing', turnId: 'turn-history', itemId: 'history-agent', text: '历史保持可读', threadName: '已有测试历史' },
  createdAt: 1791200000000, updatedAt: 1791200000000,
};
function chat(name = '整条研发聊天', hostId = 'local'): ConversationBookmark {
  return { id: `00000000-0000-4000-8000-${hostId === 'local' ? '000000000101' : '000000000102'}`, kind: 'thread', hostId,
    projectPath: '/workspace/demo', name, source: { threadId: 'thread-existing', threadName: '已有测试历史' },
    createdAt: 1791200000000, updatedAt: 1791200000000 };
}
async function sidebar(page: Page) {
  if ((page.viewportSize()?.width || 1280) <= 760 && !await page.locator('.sidebar').evaluate(element => element.classList.contains('mobile-open')))
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
}
async function catalog(page: Page) {
  await sidebar(page);
  await page.locator('.sidebar').getByRole('button', { name: '收藏对话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '收藏对话', exact: true })).toBeVisible();
}
async function favoriteRow(page: Page, hostId = 'local', action = '收藏聊天') {
  await row(page, hostId).locator('.nav-row-menu').click();
  await row(page, hostId).getByRole('button', { name: action, exact: true }).click();
}
async function saveName(page: Page, name: string) {
  await naming(page).getByRole('textbox', { name: '收藏名称', exact: true }).fill(name);
  await naming(page).getByRole('button', { name: '收藏', exact: true }).click();
  await expect(naming(page)).toHaveCount(0);
}
function noModelMutation(mock: MockCodex) {
  expect(mock.requests.filter(request => ['turn/start', 'turn/steer', 'thread/revert', 'thread/delete', 'turn/interrupt'].includes(request.method || ''))).toHaveLength(0);
}

test('header favorite names and persists a whole chat alongside old selected-content bookmarks without changing its draft', async ({ page, mock }) => {
  mock.bookmarks = [{ ...excerpt }];
  await login(page); await row(page).locator('.thread-row').click();
  const draft = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await draft.fill('保留收藏前的草稿');
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await page.locator('.thread-menu').getByRole('button', { name: '收藏聊天', exact: true }).click();
  await expect(naming(page).getByRole('textbox', { name: '收藏名称', exact: true })).toHaveValue('已有测试历史');
  await naming(page).getByRole('button', { name: '取消', exact: true }).click();
  expect(mock.bookmarkRequests.filter(request => request.method === 'POST')).toHaveLength(0);
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await page.locator('.thread-menu').getByRole('button', { name: '收藏聊天', exact: true }).click();
  await saveName(page, '整条研发聊天');
  expect(mock.bookmarks.find(entry => entry.kind === 'thread')).toMatchObject({ kind: 'thread', hostId: 'local', projectPath: '/workspace/demo', name: '整条研发聊天', source: { threadId: 'thread-existing', threadName: '已有测试历史' } });
  const stored = mock.bookmarks.find(entry => entry.kind === 'thread')!;
  expect(Object.keys(stored.source).sort()).toEqual(['threadId', 'threadName']);
  await expect(draft).toHaveValue('保留收藏前的草稿');
  await page.reload(); await expect(draft).toBeEnabled(); await catalog(page);
  await expect(page.locator('.bookmark-entry')).toHaveCount(2);
  await expect(page.locator('.bookmark-entry').filter({ hasText: '整条研发聊天' }).locator('.bookmark-kind')).toHaveText('聊天');
  await expect(page.locator('.bookmark-entry').filter({ hasText: '旧版选中内容' }).locator('.bookmark-kind')).toHaveText('选中内容');
  expect(mock.bookmarks).toHaveLength(2); noModelMutation(mock);
});

test('favoriting an unopened remote chat with an identical native ID keeps the selected host and draft and opens it normally later', async ({ page, mock }) => {
  const remote = new MockCodex(); remote.threads[0]!.name = '远程收藏目标';
  mock.hosts.push({ id: 'remote-favorite', kind: 'ssh', name: '远程收藏主机', hostname: 'remote.invalid' });
  mock.projects.push({ ...mock.projects[0], id: 'remote-project', hostId: 'remote-favorite', name: 'Remote Project' });
  mock.hostMocks.set('remote-favorite', remote);
  mock.bookmarks = [chat('本机同 ID 聊天')];
  await login(page); await row(page).locator('.thread-row').click();
  const draft = page.getByRole('textbox', { name: '消息输入框', exact: true }); await draft.fill('本机草稿不能丢失');
  await favoriteRow(page, 'remote-favorite'); await saveName(page, '远程整条聊天');
  await expect(page.locator('.header-host')).toHaveText('本机');
  await expect(draft).toHaveValue('本机草稿不能丢失');
  expect(remote.request('thread/resume')).toBeUndefined();
  expect(mock.bookmarks.filter(entry => entry.kind === 'thread')).toHaveLength(2);
  const itemReads = remote.requests.filter(request => request.method === 'thread/items/list').length;
  await catalog(page); await page.getByRole('button', { name: '跳转到收藏 远程整条聊天', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '收藏对话', exact: true })).toHaveCount(0);
  await expect(page.locator('.header-host')).toHaveText('远程收藏主机');
  expect(remote.request('thread/resume')?.params.threadId).toBe('thread-existing');
  expect(remote.requests.filter(request => request.method === 'thread/items/list')).toHaveLength(itemReads);
  await catalog(page); await page.getByRole('button', { name: '跳转到收藏 本机同 ID 聊天', exact: true }).click();
  await expect(page.locator('.header-host')).toHaveText('本机'); await expect(draft).toHaveValue('本机草稿不能丢失');
  noModelMutation(mock); noModelMutation(remote);
});

test('chat favorites share project grouping, searching, renaming and removal with excerpt favorites', async ({ page, mock }) => {
  mock.bookmarks = [chat(), { ...excerpt }];
  await login(page); await catalog(page);
  await expect(page.locator('.bookmark-project-group')).toHaveCount(1);
  const search = page.getByRole('searchbox', { name: '搜索收藏', exact: true });
  await search.fill('研发'); await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  await page.getByRole('button', { name: '重命名收藏 整条研发聊天', exact: true }).click();
  await page.getByRole('textbox', { name: '收藏名称', exact: true }).fill('新名称工程聊天');
  await page.locator('.bookmark-name-dialog').getByRole('button', { name: '保存名称', exact: true }).click();
  await search.fill('新名称'); await expect(page.getByRole('button', { name: '跳转到收藏 新名称工程聊天', exact: true })).toBeVisible();
  await search.fill('历史保持可读'); await expect(page.locator('.bookmark-entry')).toHaveCount(1); await expect(page.locator('.bookmark-name')).toHaveText('旧版选中内容');
  await search.fill('新名称'); await page.getByRole('button', { name: '取消收藏 新名称工程聊天', exact: true }).click();
  await search.fill(''); await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  expect(mock.bookmarks).toEqual([excerpt]); noModelMutation(mock);
});

test('chat menu refresh discovers a favorite added by another client and cancellation removes only that favorite', async ({ page, mock }) => {
  await login(page);
  mock.bookmarks.push(chat('其他设备保存的聊天'), { ...excerpt });
  await favoriteRow(page, 'local', '取消收藏聊天');
  await expect.poll(() => mock.bookmarks.length).toBe(1);
  expect(mock.bookmarks[0]).toEqual(excerpt);
  expect(mock.bookmarkRequests.filter(request => request.method === 'POST')).toHaveLength(0);
  noModelMutation(mock);
});

test('failed whole-chat save keeps its name and source for retry and failed removal remains actionable', async ({ page, mock }) => {
  await login(page); await favoriteRow(page);
  mock.failBookmarkSaveNext = true;
  await naming(page).getByRole('textbox', { name: '收藏名称', exact: true }).fill('保留失败重试名称');
  await naming(page).getByRole('button', { name: '收藏', exact: true }).click();
  await expect(naming(page).getByRole('alert')).toContainText('模拟收藏保存失败');
  await expect(naming(page).getByRole('textbox', { name: '收藏名称', exact: true })).toHaveValue('保留失败重试名称');
  await naming(page).getByRole('button', { name: '收藏', exact: true }).click(); await expect(naming(page)).toHaveCount(0);
  let rejectDelete = true;
  await page.route('**/api/bookmarks/*', route => route.request().method() === 'DELETE' && rejectDelete
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法取消收藏' }) }) : route.fallback());
  await favoriteRow(page, 'local', '取消收藏聊天');
  await expect(page.locator('.global-error')).toContainText('暂时无法取消收藏');
  expect(mock.bookmarks).toHaveLength(1);
  rejectDelete = false; await favoriteRow(page, 'local', '取消收藏聊天');
  await expect.poll(() => mock.bookmarks.length).toBe(0); noModelMutation(mock);
});

test('mobile chat favorites fit the unified catalog and can be recalled from sidebar search', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page); await sidebar(page); await favoriteRow(page); await saveName(page, '移动端完整聊天收藏');
  await catalog(page); const panel = page.getByRole('dialog', { name: '收藏对话', exact: true });
  await expect(panel.locator('.bookmark-kind')).toHaveText('聊天');
  const bounds = await panel.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: '关闭收藏对话', exact: true }).click();
  await sidebar(page); await page.getByRole('textbox', { name: '搜索对话', exact: true }).fill('完整聊天收藏');
  await page.getByRole('button', { name: '跳转到收藏 移动端完整聊天收藏', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已有测试历史', exact: true })).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'thread/items/list')).toHaveLength(0); noModelMutation(mock);
});

test('a running conversation can be bookmarked and recalled through command search without stopping its task', async ({ page, mock }) => {
  mock.holdFinalMessage = true;
  await login(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('保持任务运行');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await page.locator('.thread-menu').getByRole('button', { name: '收藏聊天', exact: true }).click();
  await saveName(page, '运行中聊天收藏');
  expect(mock.bookmarks[0]).toMatchObject({ kind: 'thread', source: { threadId: mock.threads[0]!.id } });
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: '搜索对话或指令', exact: true }).fill('运行中聊天收藏');
  const result = page.locator('.palette-results button').filter({ hasText: '运行中聊天收藏' });
  await expect(result).toContainText('收藏聊天'); await result.click();
  await expect(page.locator('.command-palette')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  expect(mock.requests.filter(request => ['turn/interrupt', 'turn/steer', 'thread/revert', 'thread/items/list'].includes(request.method || ''))).toHaveLength(0);
});
