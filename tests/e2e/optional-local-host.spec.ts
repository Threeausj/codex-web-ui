import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const local = { id: 'local', name: '本机', kind: 'local' };
const ssh = { id: 'ssh-only', name: '计算服务器', kind: 'ssh', hostname: 'compute.invalid', cwd: '/workspace/demo' };
async function availability(page: Page, mock: MockCodex, options: { enabled?: boolean; remote?: boolean } = {}) {
  let enabled = options.enabled !== false;
  const allProjects = [...mock.projects];
  const remote = new MockCodex();
  remote.threads[0] = { ...remote.threads[0], name: '远程历史', preview: '远程历史' };
  remote.turns.get('thread-existing')![0].items[1].text = '远程内容保留';
  let remotePresent = options.remote === true;
  mock.hostMocks.set(ssh.id, remote);
  const calls: { enabled: boolean }[] = [];
  let rejectDisable = false;
  const refresh = () => {
    mock.hosts = [...(enabled ? [local] : []), ...(remotePresent ? [ssh] : [])];
    return { hosts: mock.hosts, localEnabled: enabled,
      projects: allProjects.filter(project => enabled || project.hostId !== 'local') };
  };
  refresh();
  await page.route(/\/api\/(?:bootstrap|hosts(?:\/local\/enabled|\/ssh-only)?)(?:\?|$)/, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/local/enabled')) {
      const body = request.postDataJSON();
      calls.push(body);
      if (!body.enabled && rejectDisable) return route.fulfill({ status: 409, json: { error: '本机仍有正在运行的任务，请等待任务结束后重试' } });
      enabled = body.enabled;
      const inventory = refresh();
      // Deliver before the HTTP ACK as on the real shared engine.
      if (!enabled) mock.emit('bridge/host-disabled', { hostId: 'local' });
      return route.fulfill({ json: { ok: true, ...inventory } });
    }
    if (path === '/api/hosts' && request.method() === 'POST') {
      remotePresent = true;
      return route.fulfill({ json: { host: ssh, ...refresh() } });
    }
    if (path === '/api/hosts/ssh-only' && request.method() === 'DELETE') {
      remotePresent = false;
      return route.fulfill({ json: refresh() });
    }
    if (path === '/api/bootstrap') return route.fulfill({ json: { ...refresh(),
      preferences: mock.preferences, cwd: '/workspace/demo', connectionMode: 'spawn', runtimeReleasedThreads: [],
    } });
    return route.fulfill({ json: refresh() });
  });
  return { remote, calls, rejectDisable: () => { rejectDisable = true; }, externallyDisable: () => { enabled = false; refresh(); mock.emit('bridge/host-disabled', { hostId: 'local' }); } };
}
async function connections(page: Page) {
  const openSidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await openSidebar.isVisible()) await openSidebar.click();
  await page.locator('.settings-button').click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.locator('.settings-nav').getByRole('button', { name: '连接', exact: true }).click();
  return dialog;
}
async function authenticatedEmpty(page: Page, mock: MockCodex) {
  mock.authenticated = true;
  await page.goto('/');
  await expect(page.locator('.settings-button')).toBeVisible();
}

test('a disabled local executor selects an available SSH host instead of reconnecting local', async ({ page, mock }) => {
  const wire = await availability(page, mock, { enabled: false, remote: true });
  await page.addInitScript(() => localStorage.setItem('codex.hostId', JSON.stringify('local')));
  await login(page);
  await expect(page.locator('.header-host')).toHaveText('计算服务器');
  expect(mock.sockets).toHaveLength(0);
  expect(wire.remote.sockets).toHaveLength(1);
  const settings = await connections(page);
  await expect(settings.getByRole('combobox', { name: '设置主机' })).toHaveValue('ssh-only');
  await expect(settings.getByRole('button', { name: '启用本机 Codex', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.reload();
  await expect(page.locator('.header-host')).toHaveText('计算服务器');
  expect(mock.sockets).toHaveLength(0);
});

test('disabling local switches to SSH and restoring it preserves local history and drafts', async ({ page, mock }) => {
  await availability(page, mock, { remote: true });
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').click();
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('保留这份本机草稿');
  const settings = await connections(page);
  await settings.getByRole('button', { name: '停用本机 Codex', exact: true }).click();
  await expect(settings.getByRole('button', { name: '启用本机 Codex', exact: true })).toBeVisible();
  await expect(settings.getByRole('combobox', { name: '设置主机' })).toHaveValue('ssh-only');
  await expect(page.locator('.nav-project-group[data-host-id="local"]')).toHaveCount(0);
  await settings.getByRole('button', { name: '启用本机 Codex', exact: true }).click();
  await expect(settings.getByRole('button', { name: '停用本机 Codex', exact: true })).toBeVisible();
  await expect(settings.getByRole('combobox', { name: '设置主机' })).toHaveValue('ssh-only');
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('保留这份本机草稿');
});

test('the only local executor can be disabled and re-enabled without losing the Web service', async ({ page, mock }) => {
  await availability(page, mock);
  await login(page);
  const settings = await connections(page);
  await settings.getByRole('button', { name: '停用本机 Codex', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: '设置主机' })).toHaveValue('');
  await expect(settings.getByRole('combobox', { name: '设置主机' })).toBeDisabled();
  await expect(settings.getByRole('button', { name: '启用本机 Codex', exact: true })).toBeVisible();
  const sockets = mock.sockets.length;
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  await expect.poll(() => mock.sockets.length).toBe(sockets);
  await page.reload();
  await expect(page.locator('.settings-button')).toBeVisible();
  expect(mock.sockets).toHaveLength(sockets);
  const restoredSettings = await connections(page);
  await restoredSettings.getByRole('button', { name: '启用本机 Codex', exact: true }).click();
  await expect(restoredSettings.getByRole('combobox', { name: '设置主机' })).toHaveValue('local');
  await restoredSettings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
});

test('a deployment-only installation can add its first SSH host without a local CLI connection', async ({ page, mock }) => {
  const wire = await availability(page, mock, { enabled: false });
  await authenticatedEmpty(page, mock);
  expect(mock.sockets).toHaveLength(0);
  const settings = await connections(page);
  await settings.getByRole('button', { name: '添加 SSH 连接', exact: true }).click();
  const connection = page.getByRole('dialog', { name: '添加 SSH 连接', exact: true });
  await connection.getByLabel('SSH 主机地址', { exact: true }).fill('compute.invalid');
  await connection.getByLabel('SSH 显示名称', { exact: true }).fill('计算服务器');
  await connection.getByRole('button', { name: '保存', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: '设置主机' })).toHaveValue('ssh-only');
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  expect(mock.sockets).toHaveLength(0);
  expect(wire.remote.sockets).toHaveLength(1);
});

test('a busy local executor cannot be disabled and keeps its current draft', async ({ page, mock }) => {
  const wire = await availability(page, mock, { remote: true });
  wire.rejectDisable();
  await login(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('任务草稿');
  const settings = await connections(page);
  await settings.getByRole('button', { name: '停用本机 Codex', exact: true }).click();
  await expect(settings.locator('.panel-error')).toContainText('正在运行的任务');
  await expect(settings.getByRole('button', { name: '停用本机 Codex', exact: true })).toBeVisible();
  await expect(settings.getByRole('combobox', { name: '设置主机' })).toHaveValue('local');
  expect(wire.calls).toEqual([{ enabled: false }]);
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('任务草稿');
  expect(mock.sockets).toHaveLength(1);
});

test('another browser disabling local updates the selected executor without a reconnect loop', async ({ page, mock }) => {
  const wire = await availability(page, mock, { remote: true });
  await login(page);
  wire.externallyDisable();
  await expect(page.locator('.header-host')).toHaveText('计算服务器');
  const localSockets = mock.sockets.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => mock.sockets.length).toBe(localSockets);
  expect(wire.remote.sockets).toHaveLength(1);
  await connections(page);
  await expect(page.getByRole('button', { name: '启用本机 Codex', exact: true })).toBeVisible();
});

test('removing the last SSH executor while local is disabled leaves settings available', async ({ page, mock }) => {
  await availability(page, mock, { enabled: false, remote: true });
  await login(page);
  const settings = await connections(page);
  await settings.getByRole('button', { name: '移除 计算服务器', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: '设置主机' })).toHaveValue('');
  await expect(settings.getByRole('button', { name: '启用本机 Codex', exact: true })).toBeVisible();
  await settings.locator('.settings-nav').getByRole('button', { name: '配置', exact: true }).click();
  await expect(settings.getByRole('button', { name: '打开连接设置', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '打开连接设置', exact: true }).click();
  await expect(settings.getByRole('button', { name: '添加 SSH 连接', exact: true })).toBeVisible();
  expect(mock.sockets).toHaveLength(0);
});

test('a closed disabled-host socket refreshes availability even when its notification was missed', async ({ page, mock }) => {
  const wire = await availability(page, mock, { remote: true });
  await login(page);
  // Change inventory with no live notification, then deliver the close code.
  const emit = mock.emit.bind(mock);
  mock.emit = () => {};
  wire.externallyDisable();
  mock.emit = emit;
  await mock.sockets[0]!.close({ code: 4004, reason: 'Host execution disabled' });
  await expect(page.locator('.header-host')).toHaveText('计算服务器');
  expect(mock.sockets).toHaveLength(1);
  expect(wire.remote.sockets).toHaveLength(1);
});

test('mobile deployment-only settings provide touch controls to add SSH or restore local', async ({ page, mock }) => {
  await availability(page, mock, { enabled: false });
  await page.setViewportSize({ width: 390, height: 844 });
  mock.authenticated = true;
  await page.goto('/');
  const settings = await connections(page);
  await expect(settings.getByRole('button', { name: '添加 SSH 连接', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '启用本机 Codex', exact: true })).toBeVisible();
  const size = await settings.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  expect(size.content).toBeLessThanOrEqual(size.width + 1);
  await settings.getByRole('button', { name: '启用本机 Codex', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: '设置主机' })).toHaveValue('local');
});
