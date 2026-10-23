import { test, expect, login, slash } from './fixtures';
import type { Page } from '@playwright/test';
import type { TmuxMonitor, TmuxMonitorEvent } from '../../shared/tmux-monitors';

const pane = { serverPid: 100, sessionId: '$1', sessionName: '训练任务', sessionCreatedAt: 1000, windowId: '@1', windowIndex: 0, windowName: 'train', paneId: '%1', paneIndex: 0, command: 'python', cwd: '/workspace/demo', active: true, dead: false, exitCode: null, jobKey: '123:456:python' };
async function monitorFixture(page: Page) {
  const state = { monitors: [] as TmuxMonitor[], history: [] as TmuxMonitorEvent[], hosts: [], requests: [] as any[], failNext: false };
  await page.route(/\/api\/tmux-monitors(?:\/[^?]*)?(?:\?|$)/, route => {
    const req = route.request(), url = new URL(req.url()), body = req.postData() ? req.postDataJSON() : undefined;
    state.requests.push({ path: url.pathname, method: req.method(), body });
    if (req.method() === 'GET') return route.fulfill({ json: { monitors: state.monitors, history: state.history, hosts: [] } });
    if (state.failNext) { state.failNext = false; return route.fulfill({ status: 503, json: { error: '模拟监控保存失败' } }); }
    if (url.pathname.endsWith('/discover')) return route.fulfill({ json: { hostId: body.hostId, hostName: '本机', sampledAt: Date.now(), available: true, panes: [pane] } });
    if (req.method() === 'POST') {
      const monitor: TmuxMonitor = { ...pane, hostId: body.hostId, hostName: body.hostId === 'local' ? '本机' : '训练服务器', id: '00000000-0000-4000-8000-000000000001', mode: body.mode, status: 'running', run: 1, createdAt: Date.now(), updatedAt: Date.now(), lastCheckedAt: Date.now(), ...(body.threadId ? { threadId: body.threadId } : {}) };
      state.monitors.push(monitor); return route.fulfill({ status: 201, json: monitor });
    }
    if (req.method() === 'PATCH') { const monitor = state.monitors[0]!; monitor.status = body.paused ? 'paused' : 'waiting'; return route.fulfill({ json: monitor }); }
    if (url.pathname.endsWith('/history')) state.history = [];
    else if (req.method() === 'DELETE') state.monitors = [];
    return route.fulfill({ json: { ok: true } });
  });
  return state;
}
async function open(page: Page) {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.resources-button').click();
  const panel = page.getByRole('dialog', { name: '资源管理', exact: true });
  await panel.getByRole('button', { name: 'Tmux 任务监控', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Tmux 任务监控', exact: true })).toBeVisible();
  return panel;
}

test('cross-host task monitoring discovers panes, saves permanent monitoring, pauses and deletes metadata without stopping jobs', async ({ page, mock }) => {
  mock.hosts.push({ id: 'ssh-gpu', name: '训练服务器', kind: 'ssh', cwd: '/workspace/demo' });
  const fixture = await monitorFixture(page);
  await login(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('任务监控不能丢掉主对话草稿');
  const panel = await open(page);
  await panel.getByRole('combobox', { name: '发现 Tmux 主机' }).selectOption('ssh-gpu');
  await panel.getByRole('combobox', { name: 'Tmux 监控方式' }).selectOption('permanent');
  await panel.getByRole('button', { name: '发现窗格', exact: true }).click();
  await panel.getByRole('button', { name: '监控窗格 训练任务 %1', exact: true }).click();
  const monitor = panel.getByRole('article', { name: '任务监控 训练任务', exact: true });
  await expect(monitor).toContainText('运行中 · 持续');
  expect(fixture.requests.find(req => req.method === 'POST' && req.path === '/api/tmux-monitors').body).toEqual({ hostId: 'ssh-gpu', sessionId: '$1', paneId: '%1', mode: 'permanent' });
  await monitor.getByRole('button', { name: '暂停监控', exact: true }).click();
  await expect(monitor).toContainText('已暂停');
  await monitor.getByRole('button', { name: '恢复监控', exact: true }).click();
  await expect(monitor).toContainText('等待任务');
  page.once('dialog', dialog => dialog.dismiss());
  await monitor.getByRole('button', { name: '删除监控 训练任务', exact: true }).click();
  expect(fixture.requests.filter(req => req.method === 'DELETE')).toHaveLength(0);
  page.once('dialog', dialog => dialog.accept());
  await monitor.getByRole('button', { name: '删除监控 训练任务', exact: true }).click();
  await expect(monitor).toHaveCount(0);
  await panel.getByRole('button', { name: '关闭资源管理', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('任务监控不能丢掉主对话草稿');
  expect(mock.request('turn/start')).toBeUndefined();
  expect(mock.request('command/exec')).toBeUndefined();
});

test('phone monitor failures retain discovered targets and retry without duplicate destructive actions', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await monitorFixture(page);
  await login(page); const panel = await open(page);
  await panel.getByRole('button', { name: '发现窗格', exact: true }).click();
  fixture.failNext = true;
  await panel.getByRole('button', { name: '监控窗格 训练任务 %1', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('模拟监控保存失败');
  await panel.getByRole('button', { name: '监控窗格 训练任务 %1', exact: true }).click();
  await expect(panel.getByRole('article', { name: '任务监控 训练任务', exact: true })).toContainText('单次');
  expect(fixture.monitors).toHaveLength(1);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await panel.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('GPU process table shows user, PID, memory, elapsed time and command while inaccessible metadata stays unknown', async ({ page }) => {
  await page.route(/\/api\/hosts\/local\/resources(?:\?|$)/, route => route.fulfill({ json: {
    hostId: 'local', sampledAt: Date.now(), scope: 'host', cpu: { usagePercent: 20, load: [1, 2, 3], cores: 8 }, memory: { usedBytes: 4e9, totalBytes: 16e9, usagePercent: 25 }, network: {}, disk: {},
    gpus: { available: true, devices: [{ index: 0, name: 'NVIDIA Fixture', utilizationPercent: 60, memoryUsedBytes: 2e9, memoryTotalBytes: 24e9, temperatureC: 60, powerWatts: 140 }], processes: [{ gpuIndex: 0, gpuUuid: 'GPU-fixture', pid: 3456, user: 'researcher', name: 'python', command: 'python train.py --fold=3', memoryUsedBytes: 3 * 1024 ** 3, elapsedSeconds: 3665 }, { gpuIndex: 0, gpuUuid: 'GPU-fixture', pid: 3457, user: null, name: 'unavailable process', command: null, memoryUsedBytes: null, elapsedSeconds: null }] }, runtime: { paused: false, connected: false, managed: true, threads: [], processes: [], loadedThreadCount: 0, activeThreadCount: 0 },
  } }));
  await login(page); await page.locator('.resources-button').click();
  const table = page.getByRole('region', { name: 'GPU 进程归属', exact: true });
  await expect(table).toContainText('researcher'); await expect(table).toContainText('PID 3456'); await expect(table).toContainText('3.0 GiB'); await expect(table).toContainText('1 小时 1 分'); await expect(table).toContainText('python train.py --fold=3');
  await expect(table).toContainText('PID 3457'); await expect(table).toContainText('unavailable process');
});

test('workspace tmux offers current-pane once monitoring without sending a command to the pane', async ({ page, mock }) => {
  const fixture = await monitorFixture(page);
  await page.route('**/api/tmux/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').pop();
    if (action === 'list') return route.fulfill({ json: { available: true, sessions: [{ id: '$1', name: '训练任务', windows: 1, attached: 0, createdAt: 100 }] } });
    if (action === 'read') return route.fulfill({ json: { sessionId: '$1', paneId: '%1', text: 'epoch 2 / 120', panes: [{ id: '%1', windowId: '@1', active: true, windowActive: true, command: 'python', path: '/workspace/demo', windowName: 'train', title: 'training' }] } });
    return route.fulfill({ status: 404, json: { error: 'Unexpected write' } });
  });
  await login(page); await slash(page, 'terminal');
  await page.getByRole('button', { name: 'Tmux', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Tmux 会话管理', exact: true });
  await expect(panel.getByLabel('Tmux 输出快照')).toContainText('epoch 2 / 120');
  await panel.getByRole('button', { name: '监控当前窗格', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('监控已保存');
  expect(fixture.monitors).toHaveLength(1); expect(fixture.monitors[0]!.mode).toBe('once');
  expect(mock.request('turn/start')).toBeUndefined();
});

for (const existingWindow of [false, true]) test(`a tmux notification ${existingWindow ? 'focuses an existing page' : 'survives login'} and selects the exact pane without starting work`, async ({ page, mock }) => {
  const reads: any[] = [];
  await page.route('**/api/tmux/**', route => {
    const action = new URL(route.request().url()).pathname.split('/').pop();
    if (action === 'list') return route.fulfill({ json: { available: true, sessions: [
      { id: '$1', name: '另一个任务', windows: 1, attached: 0, createdAt: 100 },
      { id: '$2', name: '通知的训练任务', windows: 1, attached: 0, createdAt: 100 },
    ] } });
    if (action === 'read') {
      const body = route.request().postDataJSON(); reads.push(body);
      return route.fulfill({ json: { sessionId: body.sessionId, paneId: body.paneId || '%5', text: 'notification job output', panes: [
        { id: '%5', windowId: '@2', active: true, windowActive: true, command: 'python', path: '/workspace/demo', windowName: 'train', title: 'training' },
      ] } });
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected action' } });
  });
  if (existingWindow) {
    await login(page);
    await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('通知不能发送主对话草稿');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('codex:push-navigate', {
      detail: { hostId: 'local', tmuxSession: '$2', tmuxPane: '%5' },
    })));
  } else {
    await page.goto('/?host=local&tmuxSession=%242&tmuxPane=%255&keep=yes');
    await page.getByRole('textbox', { name: '访问密码' }).fill('test-password-123');
    await page.getByRole('button', { name: '进入工作区', exact: true }).click();
  }
  const manager = page.getByRole('region', { name: 'Tmux 会话管理', exact: true });
  await expect(manager.getByLabel('Tmux 输出快照')).toContainText('notification job output');
  await expect.poll(() => reads.some(read => read.sessionId === '$2' && read.paneId === '%5')).toBe(true);
  expect(mock.request('turn/start')).toBeUndefined(); expect(mock.request('command/exec')).toBeUndefined();
  if (existingWindow) await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('通知不能发送主对话草稿');
  else { expect(new URL(page.url()).searchParams.get('keep')).toBe('yes'); expect(new URL(page.url()).searchParams.has('tmuxSession')).toBe(false); }
});
