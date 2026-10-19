import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const sourcePath = '/workspace/demo';
const targetPath = '/workspace/second';
const group = (page: Page, hostId: string, path: string) =>
  page.locator(`.nav-project-group[data-host-id="${hostId}"][data-project-path="${path}"]`);
const input = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });

function prepare(mock: MockCodex) {
  mock.nativeProjectSupported = true;
  mock.projects[0].name = '源项目 A';
  mock.nativeProjectIds.set(JSON.stringify(['local', sourcePath]), 'native-a');
  mock.nativeProjectIds.set(JSON.stringify(['local', targetPath]), 'native-b');
  mock.projects.push({ id: 'web-b', name: '目标项目 B', hostId: 'local', path: targetPath, source: 'web' });
  (mock.threads[0] as any).projectId = 'native-a';
}

async function bareProjectResponses(page: Page, mock: MockCodex) {
  const mutations: Array<{ method: string; fields: any }> = [];
  await page.route('**/api/projects', async route => {
    const method = route.request().method();
    if (!['POST', 'PATCH', 'DELETE'].includes(method)) return route.fallback();
    const fields = route.request().postDataJSON();
    mutations.push({ method, fields });
    const matches = (project: any) => (project.hostId || 'local') === fields.hostId && project.path === fields.path;
    if (method === 'DELETE') mock.projects = mock.projects.filter(project => !matches(project));
    else if (method === 'PATCH') mock.projects = mock.projects.map(project => matches(project) ? { ...project, ...fields } : project);
    else mock.projects.push({ id: `added-${mutations.length}`, ...fields, source: 'web' });
    // Project CRUD returns Web metadata. Native identities come from the
    // separate host-scoped native-bindings endpoint, as in production.
    const projects = mock.projects.map(({ nativeProjectId: _, ...project }) => project);
    await route.fulfill({ json: { projects } });
  });
  return mutations;
}

async function move(page: Page, hostId: string, destination = targetPath) {
  await page.locator(`[data-section="recent"] [data-host-id="${hostId}"] .nav-row-menu`).first().click();
  await page.getByRole('button', { name: '移动到项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '移动到项目', exact: true });
  const select = dialog.getByRole('combobox', { name: '目标项目' });
  await expect(select).toBeEnabled();
  await select.selectOption(destination);
  await dialog.getByRole('button', { name: '移动对话', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(group(page, hostId, destination).locator('.thread-row')).toHaveCount(1);
}

async function remove(page: Page, hostId: string, path: string) {
  await group(page, hostId, path).locator('.project-row').click({ button: 'right' });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('menuitem', { name: '移除项目', exact: true }).click();
  await expect(group(page, hostId, path)).toHaveCount(0);
}

function expectNoChatDeletion(mock: MockCodex) {
  expect(mock.requests.filter(request => ['thread/archive', 'thread/delete', 'thread/settings/update'].includes(request.method || ''))).toEqual([]);
  expect(mock.archivedThreads).toHaveLength(0);
  expect(mock.threads).toHaveLength(1);
}

test('removing the source project retains a moved chat in its destination immediately and after reload', async ({ page, mock }) => {
  prepare(mock);
  const mutations = await bareProjectResponses(page, mock);
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await input(page).fill('移除旧项目时保留的草稿');
  await move(page, 'local');
  await expect(page.locator('.header-project > button')).toContainText('目标项目 B');
  await remove(page, 'local', sourcePath);
  await expect(group(page, 'local', targetPath).locator('.thread-row')).toHaveCount(1);
  await expect(page.locator('.header-project > button')).toContainText('目标项目 B');
  await expect(input(page)).toHaveValue('移除旧项目时保留的草稿');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  expect((mock.threads[0] as any).projectId).toBe('native-b');
  expect(mock.threads[0].cwd).toBe(sourcePath);
  expect(mutations).toEqual([{ method: 'DELETE', fields: { hostId: 'local', path: sourcePath } }]);
  expectNoChatDeletion(mock);
  await page.reload();
  await expect(group(page, 'local', targetPath).locator('.thread-row')).toHaveCount(1);
  await expect(group(page, 'local', sourcePath)).toHaveCount(0);
  await expect(page.locator('.header-project > button')).toContainText('目标项目 B');
  await expect(input(page)).toHaveValue('移除旧项目时保留的草稿');
  expectNoChatDeletion(mock);
});

test('removing a background host source project preserves moved membership on both hosts sharing the same paths', async ({ page, mock }) => {
  prepare(mock);
  (mock.threads[0] as any).projectId = 'native-b';
  const remote = new MockCodex();
  (remote.threads[0] as any).projectId = 'remote-native-a';
  mock.hosts.push({ id: 'ssh-nas', name: 'NAS', kind: 'ssh', cwd: sourcePath });
  mock.hostMocks.set('ssh-nas', remote);
  mock.projects.push({ id: 'nas-a', name: 'NAS 源项目', hostId: 'ssh-nas', path: sourcePath, source: 'web' },
    { id: 'nas-b', name: 'NAS 工作目录', hostId: 'ssh-nas', path: targetPath, source: 'web' });
  mock.nativeProjectIds.set(JSON.stringify(['ssh-nas', sourcePath]), 'remote-native-a');
  mock.nativeProjectIds.set(JSON.stringify(['ssh-nas', targetPath]), 'remote-native-b');
  const mutations = await bareProjectResponses(page, mock);
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(group(page, 'local', targetPath).locator('.thread-row')).toHaveCount(1);
  await input(page).fill('本机对话草稿不应受 NAS 项目影响');
  await move(page, 'ssh-nas');
  await remove(page, 'ssh-nas', sourcePath);
  await expect(group(page, 'ssh-nas', targetPath).locator('.thread-row')).toHaveCount(1);
  await expect(group(page, 'local', targetPath).locator('.thread-row')).toHaveCount(1);
  await expect(group(page, 'local', sourcePath)).toHaveCount(1);
  await expect(page.locator('.header-host')).toHaveText('本机');
  await expect(page.locator('.header-project > button')).toContainText('目标项目 B');
  await expect(input(page)).toHaveValue('本机对话草稿不应受 NAS 项目影响');
  expect(mutations).toEqual([{ method: 'DELETE', fields: { hostId: 'ssh-nas', path: sourcePath } }]);
  expectNoChatDeletion(mock);
  expectNoChatDeletion(remote);
  expect((remote.threads[0] as any).projectId).toBe('remote-native-b');
  await page.reload();
  await expect(group(page, 'ssh-nas', targetPath).locator('.thread-row')).toHaveCount(1);
  await expect(group(page, 'local', targetPath).locator('.thread-row')).toHaveCount(1);
  await expect(input(page)).toHaveValue('本机对话草稿不应受 NAS 项目影响');
});

test('editing and adding unrelated projects cannot discard a moved chat destination identity', async ({ page, mock }) => {
  prepare(mock);
  (mock.threads[0] as any).projectId = 'native-b';
  const remote = new MockCodex();
  mock.hosts.push({ id: 'ssh-other', name: '其他主机', kind: 'ssh', cwd: '/remote' });
  mock.hostMocks.set('ssh-other', remote);
  const mutations = await bareProjectResponses(page, mock);
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(group(page, 'local', targetPath).locator('.thread-row')).toHaveCount(1);
  await input(page).fill('项目管理操作保留当前草稿');
  await group(page, 'local', sourcePath).locator('.project-row').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await edit.getByRole('textbox', { name: '项目名称', exact: true }).fill('源项目已改名');
  await edit.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(group(page, 'local', targetPath).locator('.thread-row')).toHaveCount(1);
  await expect(page.locator('.header-project > button')).toContainText('目标项目 B');
  await page.locator('.settings-button').click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.locator('.settings-nav').getByRole('button', { name: '项目', exact: true }).click();
  await settings.getByRole('combobox', { name: '设置主机', exact: true }).selectOption('ssh-other');
  await settings.getByRole('textbox', { name: '项目路径', exact: true }).fill('/remote/new-project');
  await settings.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(settings.getByText('项目已添加', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(group(page, 'local', targetPath).locator('.thread-row')).toHaveCount(1);
  await expect(page.locator('.header-host')).toHaveText('本机');
  await expect(page.locator('.header-project > button')).toContainText('目标项目 B');
  await expect(input(page)).toHaveValue('项目管理操作保留当前草稿');
  expect(mutations.map(entry => entry.method)).toEqual(['PATCH', 'POST']);
  expectNoChatDeletion(mock);
  await page.reload();
  await expect(group(page, 'local', targetPath).locator('.thread-row')).toHaveCount(1);
  await expect(input(page)).toHaveValue('项目管理操作保留当前草稿');
});

test('a delayed current-host project page cannot restore obsolete history after project settings change', async ({ page, mock }) => {
  prepare(mock);
  (mock.threads[0] as any).projectId = 'native-b';
  let initialPages = 0;
  let releasePage: (() => void) | undefined;
  const receive = mock.receive.bind(mock);
  mock.receive = (socket, request) => {
    if (request.method !== 'thread/list' || request.params?.projectId !== 'native-a') return receive(socket, request);
    mock.requests.push(request);
    if (!request.params.cursor) {
      initialPages++;
      socket.send(JSON.stringify({ id: request.id, result: { data: [], nextCursor: initialPages === 1 ? 'source-next-page' : null } }));
    } else if (request.params.cursor === 'source-next-page') {
      releasePage = () => socket.send(JSON.stringify({ id: request.id, result: {
        data: [{ ...mock.threads[0], id: 'obsolete-project-history', name: '过期分页中的对话', projectId: 'native-a' }],
        nextCursor: 'obsolete-third-page',
      } }));
    } else socket.send(JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } }));
  };
  await bareProjectResponses(page, mock);
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await input(page).fill('旧项目分页返回时保留的草稿');
  const source = group(page, 'local', sourcePath);
  await source.getByRole('button', { name: '加载项目旧对话', exact: true }).click();
  await expect.poll(() => !!releasePage).toBe(true);
  await source.locator('.project-row').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await edit.getByRole('textbox', { name: '项目名称', exact: true }).fill('重新配置后的源项目');
  await edit.getByRole('button', { name: '保存项目', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect.poll(() => initialPages).toBe(2);
  await expect(source.getByRole('button', { name: '加载项目旧对话', exact: true })).toHaveCount(0);
  releasePage!();
  // The title notification is sent on the same socket after the old response.
  // Seeing it gives a render barrier without depending on an arbitrary delay.
  mock.emit('thread/name/updated', { threadId: 'thread-existing', threadName: '目标对话已同步' });
  await expect(page.locator('.main-header h1')).toHaveText('目标对话已同步');
  await expect(source.locator('.thread-row')).toHaveCount(0);
  await expect(source.getByRole('button', { name: '加载项目旧对话', exact: true })).toHaveCount(0);
  await expect(group(page, 'local', targetPath).locator('.thread-row')).toHaveCount(1);
  await expect(page.locator('.header-project > button')).toContainText('目标项目 B');
  await expect(input(page)).toHaveValue('旧项目分页返回时保留的草稿');
  expect(mock.requests.some(request => request.method === 'thread/list' && request.params?.cursor === 'obsolete-third-page')).toBe(false);
  expectNoChatDeletion(mock);
});
