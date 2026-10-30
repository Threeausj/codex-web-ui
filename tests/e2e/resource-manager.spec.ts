import { test, expect, login } from './fixtures';

function sample(hostId = 'local', at = Date.now(), paused = false) {
  return { hostId, sampledAt: at, scope: hostId === 'local' ? 'container' : 'host',
    cpu: { usagePercent: 59.1, load: [2.88, 2.30, 1.84], cores: 8 },
    memory: { usedBytes: 4.8 * 1073741824, totalBytes: 7.8 * 1073741824, usagePercent: 62.4 },
    network: { rxBytesPerSecond: 24.7 * 1024, txBytesPerSecond: 30.6 * 1024 },
    disk: { readBytesPerSecond: 394.5 * 1024, writeBytesPerSecond: 14.7 * 1048576 },
    gpus: { available: true, devices: [{ index: 0, name: 'NVIDIA RTX fixture', utilizationPercent: 73, memoryUsedBytes: 4 * 1073741824, memoryTotalBytes: 24 * 1073741824, temperatureC: 61, powerWatts: 212 }] },
    runtime: { paused, connected: !paused, managed: true, mode: 'spawn', loadedThreadCount: paused ? 0 : 3, activeThreadCount: 0, activeProcesses: [], processes: paused ? [] : [{ pid: 456, role: 'app-server', local: true }] },
  };
}

test('resource menu opens host charts and GPU usage, retaining chat while polling; close only submits after confirmation', async ({ page, mock }) => {
  let paused = false;
  let inspections = 0;
  const mutations: any[] = [];
  await page.route(/\/api\/hosts\/local\/resources(?:\?|$)/, route => {
    inspections++;
    return route.fulfill({ json: sample('local', Date.now(), paused) });
  });
  await page.route(/\/api\/hosts\/local\/runtime\/(close|resume)$/, route => {
    const close = route.request().url().endsWith('/close');
    mutations.push({ close, body: route.request().postDataJSON() }); paused = close;
    mock.emit('bridge/status', { connected: !paused, paused, hostId: 'local', mode: 'spawn', pendingRequests: [], activeProcesses: [] });
    return route.fulfill({ json: { ok: true, runtime: sample('local', Date.now(), paused).runtime } });
  });
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('关闭后保留的草稿');
  await page.locator('.resources-button').click();
  const panel = page.getByRole('dialog', { name: '资源管理', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('img', { name: /CPU趋势/ })).toBeVisible();
  await expect(panel.getByRole('img', { name: /内存趋势/ })).toBeVisible();
  await expect(panel).toContainText('NVIDIA RTX fixture');
  await expect(panel).toContainText('73.0%');
  await expect(panel).toContainText('PID 456');
  await expect(panel).toContainText('容器可见');
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('3 个会话'); await dialog.dismiss(); });
  await panel.getByRole('button', { name: '关闭 Web Codex', exact: true }).click();
  expect(mutations).toHaveLength(0);
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: '关闭 Web Codex', exact: true }).click();
  await expect(panel).toContainText('Web Codex 已暂停');
  expect(mutations).toEqual([{ close: true, body: { confirmed: true } }]);
  await panel.getByRole('button', { name: '重新连接 Web Codex', exact: true }).click();
  await expect(panel).toContainText('Web Codex 已重新连接');
  expect(mutations.at(-1)).toEqual({ close: false, body: {} });
  await panel.getByRole('button', { name: '关闭资源管理', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('关闭后保留的草稿');
  expect(mock.request('turn/start')).toBeUndefined();
  expect(inspections).toBeGreaterThanOrEqual(2);
});

test('independent daemon resource controls preserve background work, close Web terminals and prevent per-chat writer release', async ({ page, mock }) => {
  const hostId = 'ssh-daemon-resources';
  mock.hosts.push({ id: hostId, name: 'NAS daemon', kind: 'ssh', connectionMode: 'daemon' });
  let paused = false;
  const mutations: { path: string; body: any; csrf?: string }[] = [];
  const daemonRuntime = () => ({
    ...sample(hostId, Date.now(), paused).runtime, mode: 'ssh', connectionMode: 'daemon', independentDaemon: true,
    activeThreadCount: paused ? 0 : 1,
    threads: paused ? [] : [{ id: 'daemon-thread', name: '后台进行中的聊天', loaded: true, active: true, released: false, pid: 456 }],
  });
  await page.route(/\/api\/hosts\/local\/resources(?:\?|$)/, route => route.fulfill({ json: sample() }));
  await page.route(/\/api\/hosts\/ssh-daemon-resources\/resources(?:\?|$)/, route => route.fulfill({ json: { ...sample(hostId), runtime: daemonRuntime() } }));
  await page.route(/\/api\/hosts\/ssh-daemon-resources\/runtime\/(close|resume)$/, route => {
    const request = route.request();
    mutations.push({ path: new URL(request.url()).pathname, body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
    paused = request.url().endsWith('/close');
    return route.fulfill({ json: { ok: true, runtime: daemonRuntime() } });
  });
  await login(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('保留本机聊天草稿');
  await page.locator('.resources-button').click();
  const panel = page.getByRole('dialog', { name: '资源管理', exact: true });
  await panel.getByRole('button', { name: 'NAS daemon', exact: true }).click();
  await expect(panel.getByRole('button', { name: '关闭会话 后台进行中的聊天', exact: true })).toBeDisabled();
  await expect(panel).toContainText('关闭 Web 连接保留后台对话任务，普通 Web 终端会关闭');
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('后台 daemon 和对话任务继续运行');
    expect(dialog.message()).toContain('普通 Web 交互终端会关闭');
    expect(dialog.message()).not.toContain('运行任务和交互终端将中断');
    await dialog.dismiss();
  });
  await panel.getByRole('button', { name: '关闭 Web Codex', exact: true }).click();
  expect(mutations).toHaveLength(0);
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: '关闭 Web Codex', exact: true }).click();
  await expect(panel).toContainText('后台对话任务继续运行');
  await expect(panel).not.toContainText('已释放会话供桌面端或 CLI 使用');
  expect(mutations).toEqual([{ path: `/api/hosts/${hostId}/runtime/close`, body: { confirmed: true }, csrf: 'mock-csrf' }]);
  await panel.getByRole('button', { name: '重新连接 Web Codex', exact: true }).click();
  await expect(panel).toContainText('Web Codex 已重新连接');
  expect(mutations.at(-1)).toEqual({ path: `/api/hosts/${hostId}/runtime/resume`, body: {}, csrf: 'mock-csrf' });
  await expect(panel.getByRole('button', { name: '关闭会话 后台进行中的聊天', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '关闭资源管理', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('保留本机聊天草稿');
  expect(mock.requests.some(request => ['thread/archive', 'turn/interrupt'].includes(request.method || ''))).toBe(false);
});

test('changing resource host ignores an old response, refresh errors retain the latest sample, and phone panel fits', async ({ page, mock }) => {
  mock.hosts.push({ id: 'ssh-resource', name: 'GPU 服务器', kind: 'ssh', cwd: '/workspace/demo' });
  await page.setViewportSize({ width: 390, height: 844 });
  let release: (() => Promise<void>) | undefined;
  await page.route(/\/api\/hosts\/local\/resources(?:\?|$)/, async route => {
    await new Promise<void>(resolve => { release = async () => { await route.fulfill({ json: sample('local') }); resolve(); }; });
  });
  let fail = false;
  await page.route(/\/api\/hosts\/ssh-resource\/resources(?:\?|$)/, route => fail
    ? route.fulfill({ status: 502, json: { error: '资源采集暂时失败' } })
    : route.fulfill({ json: { ...sample('ssh-resource'), gpus: { available: false, reason: '未检测到可用 NVIDIA 显卡', devices: [] } } }));
  await login(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('.resources-button').click();
  const panel = page.getByRole('dialog', { name: '资源管理', exact: true });
  await expect.poll(() => !!release).toBe(true);
  await panel.getByRole('button', { name: 'GPU 服务器', exact: true }).click();
  await expect(panel).toContainText('未检测到可用 NVIDIA 显卡');
  await release!();
  await expect(panel).not.toContainText('容器可见');
  fail = true;
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('资源采集暂时失败');
  await expect(panel).toContainText('59.1%');
  const layout = await panel.evaluate(element => ({ right: element.getBoundingClientRect().right, scroll: element.scrollWidth, width: element.clientWidth }));
  expect(layout.right).toBeLessThanOrEqual(390);
  expect(layout.scroll).toBeLessThanOrEqual(layout.width);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('resource sampling pauses while hidden, resumes on foreground and stops after closing', async ({ page }) => {
  await page.clock.install();
  let samples = 0;
  await page.route(/\/api\/hosts\/local\/resources(?:\?|$)/, route => route.fulfill({ json: sample('local', 1700000000000 + ++samples * 3500) }));
  await login(page);
  await page.locator('.resources-button').click();
  await expect.poll(() => samples).toBe(1);
  await page.clock.runFor(4000);
  await expect.poll(() => samples).toBe(2);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(14000);
  expect(samples).toBe(2);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => samples).toBe(3);
  await page.getByRole('button', { name: '关闭资源管理', exact: true }).click();
  await page.clock.runFor(14000);
  expect(samples).toBe(3);
});
