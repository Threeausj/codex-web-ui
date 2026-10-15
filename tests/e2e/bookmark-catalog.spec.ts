import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';
import type { ConversationBookmark } from '../../shared/bookmarks';

const projectPath = '/workspace/demo';
let sequence = 0;
function bookmark(name: string, overrides: Partial<ConversationBookmark> = {}): ConversationBookmark {
  return {
    id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    hostId: 'local', projectPath, name,
    source: { threadId: 'thread-existing', turnId: 'turn-history', itemId: 'history-agent', text: '历史保持可读', threadName: '已有测试历史' },
    createdAt: 1791200000000, updatedAt: 1791200000000, ...overrides,
  };
}
async function showSidebar(page: Page) {
  if ((page.viewportSize()?.width || 1280) <= 760 && !await page.locator('.sidebar').evaluate(element => element.classList.contains('mobile-open')))
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
}
async function openCatalog(page: Page) {
  await showSidebar(page);
  await page.locator('.sidebar').getByRole('button', { name: '收藏对话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '收藏对话', exact: true })).toBeVisible();
  await expect(page.locator('.bookmarks-heading')).toContainText('全部项目');
}
function expectNoMutation(mock: MockCodex) {
  expect(mock.requests.filter(request => ['turn/start', 'turn/steer', 'thread/revert', 'thread/delete'].includes(request.method || ''))).toHaveLength(0);
}

test('global bookmark entry groups every known host by project and retains a readable removed-project fallback', async ({ page, mock }) => {
  mock.hosts.push({ id: 'remote', name: '远程 NAS', kind: 'ssh', hostname: 'remote.invalid' });
  mock.projects.push({ ...mock.projects[0], id: 'remote-project', hostId: 'remote' },
    { id: 'alias-project', name: '多目录项目', hostId: 'local', path: '/workspace/primary', rootPaths: ['/workspace/alias/'] });
  mock.bookmarks = [bookmark('本机结论'), bookmark('远程结论', { hostId: 'remote' }),
    bookmark('第二目录结论', { projectPath: '/workspace/alias' }), bookmark('主目录结论', { projectPath: '/workspace/primary' }),
    bookmark('已移除项目结论', { projectPath: '/workspace/removed-project' }),
    bookmark('已移除主机不应呈现', { hostId: 'removed-host' })];
  await login(page); await openCatalog(page);
  await expect(page.locator('.bookmark-project-group')).toHaveCount(4);
  await expect(page.getByRole('region', { name: 'Demo Project · 本机', exact: true })).toContainText('本机结论');
  await expect(page.getByRole('region', { name: 'Demo Project · 远程 NAS', exact: true })).toContainText('远程结论');
  await expect(page.getByRole('region', { name: '多目录项目 · 本机', exact: true })).toContainText('第二目录结论');
  await expect(page.getByRole('region', { name: '多目录项目 · 本机', exact: true }).locator('.bookmark-entry')).toHaveCount(2);
  await expect(page.getByRole('region', { name: '多目录项目 · 本机', exact: true }).locator('.bookmark-project-path')).toHaveText('/workspace/primary');
  await expect(page.getByRole('region', { name: 'removed-project · 本机', exact: true })).toContainText('/workspace/removed-project');
  await expect(page.locator('.bookmarks-panel')).not.toContainText('已移除主机不应呈现');
  await expect(page.locator('.bookmarks-panel footer')).toContainText('5 条收藏');
  await page.screenshot({ path: '.data/bookmark-catalog-desktop.png' });
  expect(mock.bookmarkRequests.some(request => request.method === 'GET' && request.hostId === null && request.projectPath === null)).toBe(true);
  expectNoMutation(mock);
});

test('catalog search matches names, quotations, source titles and combined project-host terms without mixing scopes', async ({ page, mock }) => {
  mock.hosts.push({ id: 'remote', name: '远程 NAS', kind: 'ssh', hostname: 'remote.invalid' });
  mock.projects.push({ ...mock.projects[0], id: 'remote-project', hostId: 'remote', name: '远程研发' });
  mock.bookmarks = [bookmark('架构方案', { source: { threadId: 'thread-existing', turnId: 'turn-history', itemId: 'history-agent', text: '重试队列保持幂等', threadName: '可靠性设计' } }),
    bookmark('部署结论', { hostId: 'remote' })];
  await login(page); await openCatalog(page);
  const search = page.getByRole('searchbox', { name: '搜索收藏', exact: true });
  for (const query of ['架构', '幂等', '可靠性']) {
    await search.fill(query); await expect(page.locator('.bookmark-entry')).toHaveCount(1);
    await expect(page.locator('.bookmark-name')).toHaveText('架构方案');
  }
  await search.fill('研发 NAS 部署'); await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  await expect(page.locator('.bookmark-name')).toHaveText('部署结论');
  await expect(page.locator('.bookmarks-panel footer')).toContainText('1 / 2 条收藏');
  await search.fill('没有这个收藏'); await expect(page.locator('.bookmarks-panel')).toContainText('没有匹配的收藏');
  await search.fill(''); await expect(page.locator('.bookmark-project-group')).toHaveCount(2);
  expectNoMutation(mock);
});

test('global catalog rename and remove update the index, and opening a bookmark jumps to its original message', async ({ page, mock }) => {
  mock.bookmarks = [bookmark('要重命名的收藏'), bookmark('要取消的收藏')];
  await login(page); await openCatalog(page);
  await page.getByRole('button', { name: '重命名收藏 要重命名的收藏', exact: true }).click();
  await page.getByRole('textbox', { name: '收藏名称', exact: true }).fill('整理后的结论');
  await page.locator('.bookmark-name-dialog').getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(page.getByRole('button', { name: '跳转到收藏 整理后的结论', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消收藏 要取消的收藏', exact: true }).click();
  await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  await page.getByRole('button', { name: '跳转到收藏 整理后的结论', exact: true }).click();
  await expect(page.locator('.bookmarks-panel')).toHaveCount(0);
  await expect(page.locator('[data-selection-item-id="history-agent"]')).toHaveClass(/bookmark-location/);
  await openCatalog(page); await expect(page.locator('.bookmark-name')).toHaveText('整理后的结论');
  expect(mock.bookmarks.map(entry => entry.name)).toEqual(['整理后的结论']); expectNoMutation(mock);
});

test('sidebar title search includes matching bookmark names and excerpts and opens the quoted source', async ({ page, mock }) => {
  mock.bookmarks = [bookmark('唯一收藏检索词', { source: { threadId: 'thread-existing', turnId: 'turn-history', itemId: 'history-agent', text: '历史保持可读', threadName: '普通源标题' } })];
  await login(page);
  const search = page.getByRole('textbox', { name: '搜索对话', exact: true });
  await search.fill('唯一收藏检索词');
  await expect(page.getByRole('button', { name: '跳转到收藏 唯一收藏检索词', exact: true })).toBeVisible();
  await search.fill('历史保持可读');
  await page.getByRole('button', { name: '跳转到收藏 唯一收藏检索词', exact: true }).click();
  await expect(page.locator('[data-selection-item-id="history-agent"]')).toHaveClass(/bookmark-location/);
  expectNoMutation(mock);
});

test('catalog refresh recovers an index read failure and discovers externally added bookmarks', async ({ page, mock }) => {
  let fail = true;
  await page.route(url => url.pathname === '/api/bookmarks' && url.searchParams.get('all') === 'true', async route => {
    if (fail) return route.fulfill({ status: 503, json: { error: '模拟全局收藏读取失败' } });
    return route.fallback();
  });
  await login(page); await openCatalog(page);
  await expect(page.locator('.bookmarks-panel').getByRole('alert')).toContainText('模拟全局收藏读取失败');
  mock.bookmarks = [bookmark('刷新发现的新收藏')];
  fail = false;
  await page.getByRole('button', { name: '刷新收藏', exact: true }).click();
  await expect(page.locator('.bookmark-name')).toHaveText('刷新发现的新收藏');
  await expect(page.locator('.bookmarks-panel').getByRole('alert')).toHaveCount(0);
  expectNoMutation(mock);
});

test('360px dark catalog fits long project paths and quotations, and mobile Back closes it without leaving the conversation', async ({ page, mock }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.addInitScript(() => localStorage.setItem('codex.theme', 'dark'));
  const longPath = `/workspace/${'very-long-directory-'.repeat(25)}`;
  mock.projects[0] = { ...mock.projects[0], name: '跨端研发项目', path: longPath };
  mock.bookmarks = [bookmark('移动端跨设备同步的关键结论'.repeat(3), { projectPath: longPath, source: { threadId: 'thread-existing', turnId: 'turn-history', itemId: 'history-agent', text: '使用服务端索引同步收藏，重连后保留原消息定位。'.repeat(20), threadName: '长会话名称'.repeat(35) } })];
  await login(page); const url = page.url(); await openCatalog(page);
  await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  const bounds = await page.locator('.bookmarks-panel').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(780);
  expect(await page.locator('.bookmarks-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: '.data/bookmark-catalog-mobile-dark.png' });
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.codexMobilePanel))).toBe(true);
  await page.evaluate(() => history.back()); await expect(page.locator('.bookmarks-panel')).toHaveCount(0);
  expect(page.url()).toBe(url); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expectNoMutation(mock);
});
