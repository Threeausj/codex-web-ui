import type { Page } from '@playwright/test';
import { test, expect, login, MockCodex } from './fixtures';

const remoteId = 'ssh-update-host';
const panel = (page: Page) => page.getByRole('region', { name: '主机 Codex 更新', exact: true });
const button = (page: Page) => panel(page).getByRole('button', { name: '更新并重启 Codex', exact: true });
type Operation = { id: string; state: string; beforeVersion: string; installedVersion?: string; runtimeVersion?: string;
  startedAt: number; updatedAt: number; message?: string; error?: string };
type Information = { operation: Operation | null; canUpdate: boolean; disabledReason?: string; runtimeVersion: string; command: string };
const info = (version = '0.164.0'): Information => ({ operation: null, canUpdate: true, runtimeVersion: version, command: 'codex update' });
function operation(state = 'updating', overrides: Partial<Operation> = {}): Operation {
  return { id: '00000000-0000-4000-8000-000000000165', state, beforeVersion: '0.164.0', startedAt: Date.now(), updatedAt: Date.now(), ...overrides };
}
async function setup(page: Page, mock: MockCodex) {
  mock.hosts.push({ id: remoteId, name: 'NAS 更新主机', kind: 'ssh', hostname: 'nas-update.invalid' });
  const remote = new MockCodex();
  mock.hostMocks.set(remoteId, remote);
  const wire = {
    states: new Map<string, Information>([['local', info()], [remoteId, info()]]),
    posts: [] as { hostId: string; body: { requestId: string } }[],
    gets: [] as string[],
    informationReads: [] as string[],
    reject: undefined as { status: number; message: string } | undefined,
    loseAcknowledgement: false,
    deferAdmission: false,
    holdPost: undefined as Promise<void> | undefined,
    holdGet: undefined as { hostId: string; promise: Promise<void>; used: boolean } | undefined,
  };
  await page.route(/\/api\/hosts\/[^/]+\/codex-update(?:\?|$)/, async route => {
    const hostId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!);
    if (route.request().method() === 'POST') {
      wire.posts.push({ hostId, body: route.request().postDataJSON() });
      if (wire.reject) return route.fulfill({ status: wire.reject.status, json: { error: wire.reject.message } });
      if (!wire.deferAdmission) wire.states.get(hostId)!.operation = operation('checking', { id: wire.posts.at(-1)!.body.requestId });
      if (wire.holdPost) await wire.holdPost;
      if (wire.loseAcknowledgement) return route.abort('failed');
      return route.fulfill({ status: 202, json: wire.states.get(hostId) });
    }
    wire.gets.push(hostId);
    const snapshot = structuredClone(wire.states.get(hostId));
    if (wire.holdGet?.hostId === hostId && !wire.holdGet.used) {
      wire.holdGet.used = true;
      await wire.holdGet.promise;
    }
    return route.fulfill({ json: snapshot });
  });
  await page.route(/\/api\/hosts\/[^/]+\/runtime\/information(?:\?|$)/, route => {
    const hostId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!);
    wire.informationReads.push(hostId);
    return route.fulfill({ json: {
      checkedAt: Date.now(), runtime: { connected: true, paused: false, managed: true, mode: hostId === 'local' ? 'spawn' : 'ssh',
        userAgent: `codex_cli_rs/${wire.states.get(hostId)!.runtimeVersion}`, activeThreadCount: 0, activeProcesses: [] },
      config: { model: 'mock-model-a', model_context_window: 500000 }, models: [], canReconnect: true,
    } });
  });
  return wire;
}
async function settings(page: Page, section: '性能' | 'Codex' | '连接' = '性能', hostId = remoteId) {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.settings-button').click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('combobox', { name: '设置主机', exact: true }).selectOption(hostId);
  await dialog.locator('.settings-nav').getByRole('button', { name: section, exact: true }).click();
  await expect(panel(page)).toBeVisible();
  return dialog;
}
function noTaskMutation(mock: MockCodex) {
  expect(mock.requests.filter(request => ['turn/start', 'turn/interrupt', 'thread/archive', 'thread/delete', 'command/exec/terminate'].includes(request.method || ''))).toEqual([]);
}

test('updating another host reports each stage and refreshed runtime version while preserving the selected conversation and draft', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  await login(page);
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"] .thread-row').click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('主机更新时保留我的对话草稿');
  const dialog = await settings(page);
  await expect(button(page)).toBeEnabled();
  await button(page).click();
  await expect(panel(page).getByRole('status')).toContainText('正在检查主机');
  await expect(dialog.getByRole('combobox', { name: '设置主机', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '重新连接 Codex', exact: true })).toBeDisabled();
  expect(wire.posts).toHaveLength(1);
  expect(wire.posts[0]!.hostId).toBe(remoteId);
  expect(wire.posts[0]!.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  wire.states.get(remoteId)!.operation = operation('restarting', { installedVersion: '0.165.0' });
  await panel(page).getByRole('button', { name: '刷新更新状态', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('正在重启并核对运行版本');
  wire.states.set(remoteId, { ...info('0.165.0'), operation: operation('completed', { installedVersion: '0.165.0', runtimeVersion: '0.165.0' }) });
  await panel(page).getByRole('button', { name: '刷新更新状态', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('更新并重启完成');
  await expect(panel(page).getByText('0.165.0', { exact: true })).toHaveCount(2);
  await expect(dialog.locator('.performance-information')).toContainText('codex_cli_rs/0.165.0');
  await expect(dialog.getByRole('combobox', { name: '设置主机', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'local');
  await expect(input).toHaveValue('主机更新时保留我的对话草稿');
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  expect(mock.hostMocks.get(remoteId)!.request('thread/resume')).toBeUndefined();
  noTaskMutation(mock); noTaskMutation(mock.hostMocks.get(remoteId)!);
});

test('server busy tasks, terminals and unmanaged proxy runtimes disable update without sending a command', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  wire.states.get(remoteId)!.canUpdate = false;
  wire.states.get(remoteId)!.disabledReason = '主机上有运行中的任务，请等待完成';
  await login(page); await settings(page);
  for (const reason of ['主机上有运行中的任务，请等待完成', '主机上有运行中的终端，请先关闭终端', '共享代理进程由外部管理，无法在网页更新并重启']) {
    wire.states.get(remoteId)!.disabledReason = reason;
    await panel(page).getByRole('button', { name: '刷新更新状态', exact: true }).click();
    await expect(button(page)).toBeDisabled();
    await expect(panel(page).locator('.host-update-reason')).toHaveText(reason);
  }
  expect(wire.posts).toEqual([]);
  noTaskMutation(mock);
});

test('duplicate clicks start once and closing settings keeps the server operation discoverable on reopening', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  let release!: () => void;
  wire.holdPost = new Promise<void>(resolve => { release = resolve; });
  await login(page);
  let dialog = await settings(page);
  await button(page).dblclick();
  await expect(panel(page).getByRole('button', { name: '更新进行中…', exact: true })).toBeDisabled();
  await expect.poll(() => wire.posts.length).toBe(1);
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  release(); wire.holdPost = undefined;
  dialog = await settings(page, '性能', 'local');
  await expect(dialog.getByRole('combobox', { name: '设置主机', exact: true })).toBeEnabled();
  await dialog.getByRole('combobox', { name: '设置主机', exact: true }).selectOption(remoteId);
  await expect(panel(page).getByRole('status')).toContainText('正在检查主机');
  expect(wire.posts).toHaveLength(1);
  wire.states.set(remoteId, { ...info('0.165.0'), operation: operation('completed', { installedVersion: '0.165.0', runtimeVersion: '0.165.0' }) });
  await panel(page).getByRole('button', { name: '刷新更新状态', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('更新并重启完成');
  noTaskMutation(mock);
});

test('a lost update acknowledgement recovers with GET polling and never resubmits the command', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  wire.loseAcknowledgement = true;
  await login(page); await settings(page);
  await button(page).click();
  await expect(panel(page).getByRole('alert')).toContainText('更新请求结果未确认');
  await panel(page).getByRole('button', { name: '刷新更新状态', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('正在检查主机');
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  expect(wire.posts).toHaveLength(1);
  wire.states.set(remoteId, { ...info('0.165.0'), operation: operation('completed', { installedVersion: '0.165.0', runtimeVersion: '0.165.0' }) });
  await expect(panel(page).getByRole('status')).toContainText('更新并重启完成');
  expect(wire.posts).toHaveLength(1);
  noTaskMutation(mock);
});

test('a definite update refusal remains visible and an explicit retry gets a new request identity', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  wire.reject = { status: 409, message: '另一页面刚启动了任务，请等待完成后更新' };
  await login(page); await settings(page);
  await button(page).click();
  await expect(panel(page).getByRole('alert')).toContainText('另一页面刚启动了任务');
  await expect(button(page)).toBeDisabled();
  wire.reject = undefined;
  await panel(page).getByRole('button', { name: '刷新更新状态', exact: true }).click();
  await expect(button(page)).toBeEnabled(); await button(page).click();
  expect(wire.posts).toHaveLength(2);
  expect(wire.posts[0]!.body.requestId).not.toBe(wire.posts[1]!.body.requestId);
  await expect(panel(page).getByRole('status')).toContainText('正在检查主机');
  noTaskMutation(mock);
});

test('a prior completed operation cannot confirm a lost new request and reopening preserves the same explicit retry identity', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  // An earlier completed update can coexist with a slow, newly dispatched POST.
  wire.states.set(remoteId, { ...info('0.166.0'), operation: operation('completed', {
    runtimeVersion: '0.165.0', installedVersion: '0.165.0', message: '上一次更新已完成',
  }) });
  wire.deferAdmission = wire.loseAcknowledgement = true;
  await login(page);
  let dialog = await settings(page);
  await expect(panel(page).getByText('0.166.0', { exact: true })).toBeVisible();
  await expect(button(page)).toBeEnabled();
  await button(page).click();
  await expect(panel(page).getByRole('alert')).toContainText('更新请求结果未确认');
  const pendingId = wire.posts[0]!.body.requestId;
  const completedRefreshes = wire.informationReads.length;
  await panel(page).getByRole('button', { name: '刷新更新状态', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('本次更新请求结果尚未确认');
  await expect(panel(page).getByRole('button', { name: '重新提交同一更新请求', exact: true })).toBeEnabled();
  expect(wire.informationReads).toHaveLength(completedRefreshes);
  expect(wire.posts).toHaveLength(1);
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  dialog = await settings(page);
  await expect(panel(page).getByRole('status')).toContainText('本次更新请求结果尚未确认');
  await expect(panel(page).getByRole('button', { name: '重新提交同一更新请求', exact: true })).toBeEnabled();
  expect(wire.posts).toHaveLength(1);
  wire.deferAdmission = wire.loseAcknowledgement = false;
  await panel(page).getByRole('button', { name: '重新提交同一更新请求', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('正在检查主机');
  expect(wire.posts.map(post => post.body.requestId)).toEqual([pendingId, pendingId]);
  await expect(dialog.getByRole('combobox', { name: '设置主机', exact: true })).toBeDisabled();
  noTaskMutation(mock);
});

test('switching the settings host retires a late read without showing its operation or refreshing the wrong host', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  let release!: () => void;
  wire.holdGet = { hostId: 'local', promise: new Promise<void>(resolve => { release = resolve; }), used: false };
  wire.states.set('local', { ...info('0.111.0'), operation: operation('completed', { runtimeVersion: '0.111.0', installedVersion: '0.111.0', message: '旧主机的更新结果不应该串入新主机' }) });
  await login(page);
  const dialog = await settings(page);
  await expect(panel(page)).toContainText('NAS 更新主机');
  await expect(panel(page)).not.toContainText('0.111.0');
  const localReads = wire.informationReads.filter(hostId => hostId === 'local').length;
  release();
  await expect(button(page)).toBeEnabled();
  await expect(panel(page)).not.toContainText('旧主机的更新结果');
  await expect(panel(page)).not.toContainText('0.111.0');
  expect(wire.informationReads.filter(hostId => hostId === 'local')).toHaveLength(localReads);
  await expect(dialog.getByRole('combobox', { name: '设置主机', exact: true })).toHaveValue(remoteId);
  noTaskMutation(mock);
});

test('connection cards open the chosen host updater and the mobile update controls fit the settings pane', async ({ page, mock }) => {
  const wire = await setup(page, mock);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const dialog = await settings(page, '连接', 'local');
  await dialog.getByRole('button', { name: '更新并重启 NAS 更新主机 的 Codex', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '设置主机', exact: true })).toHaveValue(remoteId);
  await expect(dialog.locator('.performance-settings')).toBeVisible();
  await expect(button(page)).toBeEnabled();
  await button(page).scrollIntoViewIfNeeded();
  const bounds = await button(page).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await dialog.screenshot({ path: '.data/host-codex-update-mobile.png' });
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'local');
  expect(wire.posts).toHaveLength(0);
});
