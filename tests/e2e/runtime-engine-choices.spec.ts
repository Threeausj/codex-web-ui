import { test, expect, login } from './fixtures';

for (const rapidRestart of [false, true]) test(rapidRestart
  ? 'two rapid observed engine changes retire the newest preservation marker after metadata refresh'
  : 'an observed engine restart preserves acknowledged choices through concurrent focus recovery and native resume', async ({ page, mock }) => {
  let engineId = 'engine-original';
  let metadataReads = 0;
  let loadedThreadIds = ['thread-existing'];
  const status = () => ({ hostId: 'local', connected: true, paused: false, engineId, pendingRequests: [], loadedThreadIds, mode: 'spawn' });
  const models = ['mock-model-a', 'mock-model-b'].map(model => ({ id: model, model, displayName: model,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }));
  await page.route('**/api/hosts/local/runtime/information*', route => {
    metadataReads++;
    return route.fulfill({ json: { runtime: { ...status(), managed: true }, config: mock.config, models, canReconnect: true } });
  });
  const original = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'bridge/ping') {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, result: status() }));
    }
    return original(socket, request);
  };
  await login(page);
  mock.emit('bridge/status', status());
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('并行恢复也要保留的草稿');
  const model = page.getByRole('combobox', { name: '选择模型', exact: true });
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  await model.selectOption('mock-model-b');
  await expect(model).toBeEnabled();
  await effort.selectOption('high');
  await expect(effort).toBeEnabled();
  await expect(effort).toHaveValue('high');
  const previousResumes = mock.requests.filter(request => request.method === 'thread/resume').length;
  const previousConfigReads = mock.requests.filter(request => request.method === 'config/read').length;
  if (rapidRestart) {
    // Both engine changes arrive before the first 250ms metadata refresh.
    // The stale refresh is skipped, so the latest engine must own cleanup.
    engineId = 'engine-intermediate';
    mock.emit('bridge/status', status());
  }
  engineId = 'engine-upgraded';
  mock.emit('bridge/status', status());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => mock.requests.filter(request => request.method === 'thread/resume').length).toBeGreaterThan(previousResumes);
  await expect.poll(() => metadataReads).toBeGreaterThan(0);
  await expect.poll(() => mock.requests.filter(request => request.method === 'config/read').length).toBeGreaterThan(previousConfigReads);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('并行恢复也要保留的草稿');
  await expect(model).toHaveValue('mock-model-b');
  await expect(effort).toHaveValue('high');
  if (rapidRestart) {
    // Later writer recovery on the same engine should read native settings,
    // rather than keep a stale temporary metadata-preservation marker forever.
    const recoveredResumes = mock.requests.filter(request => request.method === 'thread/resume').length;
    loadedThreadIds = [];
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => mock.requests.filter(request => request.method === 'thread/resume').length).toBeGreaterThan(recoveredResumes);
    await expect(effort).toHaveValue('medium');
    await expect(input).toHaveValue('并行恢复也要保留的草稿');
  }
  expect(mock.request('turn/start')).toBeUndefined();
});
