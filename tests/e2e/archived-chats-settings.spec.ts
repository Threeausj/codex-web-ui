import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const panel = (page: Page) => page.getByRole('region', { name: '已归档的聊天', exact: true });
const rows = (page: Page) => panel(page).locator('.nav-thread');
const titles = (page: Page) => panel(page).locator('.thread-title');
const archived = (mock: MockCodex, id: string, name: string, cwd = '/workspace/demo') => ({ ...mock.threads[0], id, name, preview: `正文不参与搜索 ${name}`, cwd });
function remoteFixture(mock: MockCodex) {
  const remote = new MockCodex();
  mock.hosts.push({ id: 'ssh-archive', name: '归档服务器', kind: 'ssh', hostname: 'server.invalid', cwd: '/srv/project' });
  mock.projects.push({ id: 'remote-project', name: '远程项目', path: '/srv/project', hostId: 'ssh-archive', source: 'web' });
  mock.hostMocks.set('ssh-archive', remote);
  return remote;
}
async function openSettings(page: Page) {
  await page.locator('.settings-button').click();
  await page.locator('.settings-nav').getByRole('button', { name: '已归档的聊天', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
async function menu(page: Page, title: string, action: string) {
  const row = rows(page).filter({ has: page.locator('.thread-title', { hasText: title }) });
  await row.locator('.nav-row-menu').click();
  await row.getByRole('button', { name: action, exact: true }).click();
}

test('settings manage the chosen host archives without replacing the active conversation or draft', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  mock.archivedThreads.push(archived(mock, 'local-archive', '本机归档'));
  remote.archivedThreads.push(archived(remote, 'remote-archive', '远程结论', '/srv/project'));
  await login(page);
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"] .thread-row').click();
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('保留当前草稿');
  await openSettings(page);
  await expect(titles(page)).toHaveText(['本机归档']);
  await page.getByRole('combobox', { name: '设置主机', exact: true }).selectOption('ssh-archive');
  await expect(titles(page)).toHaveText(['远程结论']);
  await expect(panel(page).getByRole('region', { name: '远程项目的归档', exact: true })).toBeVisible();
  await menu(page, '远程结论', '恢复对话');
  await expect(titles(page)).toHaveCount(0);
  await expect(panel(page)).toContainText('此主机还没有归档聊天');
  expect(remote.request('thread/unarchive')?.params.threadId).toBe('remote-archive');
  expect(remote.request('thread/resume')).toBeUndefined();
  expect(mock.request('thread/unarchive')).toBeUndefined();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'local');
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('保留当前草稿');
});

test('title search and project filtering retain pagination when the first page has no project match', async ({ page, mock }) => {
  const receive = mock.receive.bind(mock);
  const first = archived(mock, 'archive-other', '归档设计', '/outside/project');
  const second = archived(mock, 'archive-project', '归档部署');
  mock.receive = (socket, request) => {
    if (request.method !== 'thread/list' || !request.params.archived) return receive(socket, request);
    mock.requests.push(request);
    const more = request.params.cursor === 'archive-page-2';
    socket.send(JSON.stringify({ id: request.id, result: { data: more ? [second] : [first], nextCursor: more ? null : 'archive-page-2' } }));
  };
  await login(page);
  await openSettings(page);
  await expect(titles(page)).toHaveText(['归档设计']);
  await page.getByRole('combobox', { name: '筛选归档项目', exact: true }).selectOption('demo');
  await expect(titles(page)).toHaveCount(0);
  await expect(panel(page)).toContainText('已加载的对话中没有匹配项');
  await panel(page).getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(titles(page)).toHaveText(['归档部署']);
  await expect(panel(page)).toContainText('已加载 2 条');
  await expect(panel(page).getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
  expect(mock.requests.filter(request => request.method === 'thread/list' && request.params?.archived).at(-1)?.params.cursor).toBe('archive-page-2');
  await page.getByRole('searchbox', { name: '搜索归档标题', exact: true }).fill('正文不参与搜索');
  await expect(panel(page)).toContainText('没有匹配的归档聊天');
  await expect(titles(page)).toHaveCount(0);
  expect(mock.request('thread/search')).toBeUndefined();
});

test('archive deletion reuses permanent confirmation, preserves errors for retry and never deletes on cancel', async ({ page, mock }) => {
  mock.archivedThreads.push(archived(mock, 'archive-delete', '待删除归档'));
  const receive = mock.receive.bind(mock);
  let fail = true;
  mock.receive = (socket, request) => {
    if (request.method !== 'thread/delete' || !fail) return receive(socket, request);
    mock.requests.push(request);
    socket.send(JSON.stringify({ id: request.id, error: { code: -32603, message: '暂时无法删除，请重试' } }));
  };
  await login(page);
  await openSettings(page);
  await menu(page, '待删除归档', '删除对话');
  const dialog = page.getByRole('dialog', { name: '删除对话', exact: true });
  await expect(dialog).toContainText('项目文件不会被删除');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(mock.request('thread/delete')).toBeUndefined();
  await menu(page, '待删除归档', '删除对话');
  await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('暂时无法删除');
  expect(mock.archivedThreads).toHaveLength(1);
  fail = false;
  await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(titles(page)).toHaveCount(0);
  expect(mock.archivedThreads).toHaveLength(0);
});

test('late archive responses from another settings host do not replace the new host list', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  mock.archivedThreads.push(archived(mock, 'local-archive', '本机保留归档'));
  let release: (() => void) | undefined;
  const receive = remote.receive.bind(remote);
  remote.receive = (socket, request) => {
    if (request.method !== 'thread/list' || !request.params.archived) return receive(socket, request);
    remote.requests.push(request);
    release = () => socket.send(JSON.stringify({ id: request.id, result: { data: [archived(remote, 'remote-late', '远程迟到归档')], nextCursor: null } }));
  };
  await login(page);
  await openSettings(page);
  await expect(titles(page)).toHaveText(['本机保留归档']);
  await page.getByRole('combobox', { name: '设置主机', exact: true }).selectOption('ssh-archive');
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole('combobox', { name: '设置主机', exact: true }).selectOption('local');
  await expect(titles(page)).toHaveText(['本机保留归档']);
  release!();
  await expect(panel(page).getByRole('button', { name: '刷新已归档的聊天', exact: true })).toBeEnabled();
  await expect(titles(page)).toHaveText(['本机保留归档']);
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});

test('archive list failures stay local and refresh retries the read', async ({ page, mock }) => {
  mock.archivedThreads.push(archived(mock, 'archive-retry', '恢复读取归档'));
  const receive = mock.receive.bind(mock);
  let fail = true;
  mock.receive = (socket, request) => {
    if (request.method !== 'thread/list' || !request.params.archived || !fail) return receive(socket, request);
    mock.requests.push(request);
    socket.send(JSON.stringify({ id: request.id, error: { code: -32603, message: '归档读取失败' } }));
  };
  await login(page);
  await openSettings(page);
  await expect(panel(page).getByRole('alert')).toContainText('归档读取失败');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  fail = false;
  await panel(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect(titles(page)).toHaveText(['恢复读取归档']);
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});

test('archive grouping respects native project moves and retries unavailable project bindings without blocking the list', async ({ page, mock }) => {
  mock.projects.push({ id: 'second-project', name: '归档目标项目', path: '/workspace/target', hostId: 'local', source: 'web' });
  mock.archivedThreads.push(
    { ...archived(mock, 'archive-moved', '移入其他项目的归档'), projectId: 'native-target' },
    { ...archived(mock, 'archive-legacy', '旧版目录归档'), projectId: null },
    { ...archived(mock, 'archive-unmapped', '其他原生项目的归档'), projectId: 'native-unmapped' },
  );
  let fail = true;
  await page.route(/\/api\/projects\/native-bindings\?/, route => route.fulfill(fail
    ? { status: 503, json: { error: '项目映射暂不可用' } }
    : { json: { supported: true, bindings: [{ path: '/workspace/demo', projectId: 'native-demo' }, { path: '/workspace/target', projectId: 'native-target' }] } }));
  await login(page);
  await openSettings(page);
  await expect(titles(page)).toHaveCount(3);
  await expect(panel(page)).toContainText('项目归属暂时无法同步');
  await expect(panel(page).getByRole('region', { name: '其他对话的归档', exact: true })).toContainText('移入其他项目的归档');
  fail = false;
  await panel(page).getByRole('button', { name: '刷新已归档的聊天', exact: true }).click();
  await expect(panel(page).getByRole('region', { name: '归档目标项目的归档', exact: true })).toContainText('移入其他项目的归档');
  await expect(panel(page).getByRole('region', { name: 'Demo Project的归档', exact: true })).toContainText('旧版目录归档');
  await page.getByRole('combobox', { name: '筛选归档项目', exact: true }).selectOption('demo');
  await expect(titles(page)).toHaveText(['旧版目录归档']);
  await page.getByRole('combobox', { name: '筛选归档项目', exact: true }).selectOption('second-project');
  await expect(titles(page)).toHaveText(['移入其他项目的归档']);
  await page.getByRole('combobox', { name: '筛选归档项目', exact: true }).selectOption('__other__');
  await expect(titles(page)).toHaveText(['其他原生项目的归档']);
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});

test('moving a remote archived chat updates its project group without a selected remote socket', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  mock.nativeProjectSupported = true;
  mock.projects.push({ id: 'remote-target', name: '远程归档目标', path: '/srv/target', hostId: 'ssh-archive', source: 'web' });
  mock.nativeProjectIds.set(JSON.stringify(['ssh-archive', '/srv/project']), 'native-source');
  mock.nativeProjectIds.set(JSON.stringify(['ssh-archive', '/srv/target']), 'native-target');
  remote.archivedThreads.push({ ...archived(remote, 'remote-move', '需要调整项目的远程归档', '/srv/project'), projectId: 'native-source' });
  await login(page);
  await openSettings(page);
  await page.getByRole('combobox', { name: '设置主机', exact: true }).selectOption('ssh-archive');
  await expect(panel(page).getByRole('region', { name: '远程项目的归档', exact: true })).toContainText('需要调整项目的远程归档');
  await menu(page, '需要调整项目的远程归档', '移动到项目');
  const dialog = page.getByRole('dialog', { name: '移动到项目', exact: true });
  await expect(dialog.getByRole('combobox', { name: '目标项目', exact: true })).toBeEnabled();
  await dialog.getByRole('combobox', { name: '目标项目', exact: true }).selectOption('/srv/target');
  await dialog.getByRole('button', { name: '移动对话', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel(page).getByRole('region', { name: '远程归档目标的归档', exact: true })).toContainText('需要调整项目的远程归档');
  await expect(panel(page).getByRole('region', { name: '远程项目的归档', exact: true })).toHaveCount(0);
  expect(remote.archivedThreads[0].cwd).toBe('/srv/project');
  expect(remote.sockets).toHaveLength(0);
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'local');
});

test('mobile archive management fits the settings pane and keeps row actions accessible', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  remote.archivedThreads.push(archived(remote, 'remote-1', '邮件服务部署与运行记录', '/srv/project'), archived(remote, 'remote-2', '这个标题较长，用于确认手机端菜单仍可以触摸并正常显示', '/srv/project'));
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await openSettings(page);
  await page.getByRole('combobox', { name: '设置主机', exact: true }).selectOption('ssh-archive');
  await expect(titles(page)).toHaveCount(2);
  await expect(rows(page).first().locator('.nav-row-menu')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await rows(page).first().locator('.nav-row-menu').boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(36);
  expect(box!.height).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: '.data/archived-chats-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: '.data/archived-chats-desktop.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '.data/archived-chats-dark.png' });
});
