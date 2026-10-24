import { test, expect, login } from './fixtures';

const capabilities = { status: 'known', methods: {
  'thread/settings/update': { available: true, params: ['threadId', 'serviceTier'], required: ['threadId'] },
  'thread/start': { available: true, params: ['serviceTier'], required: [] },
  'turn/start': { available: true, params: ['threadId', 'input', 'serviceTier'], required: ['threadId', 'input'] },
} };

for (const width of [1280, 390]) for (const current of [null, 'priority']) {
  test(`${width}px initially displays the native ${current || 'default'} speed without clicking`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/hosts/local/native-capabilities?*', route => route.fulfill({ json: capabilities }));
    const receive = (mock as any).receive.bind(mock);
    (mock as any).receive = (socket: any, request: any) => {
      const reply = (result: any) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
      if (request.method === 'model/list') return reply({ data: [{ id: 'model-a', model: 'mock-model-a', displayName: 'Mock model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Native catalog' }] }], nextCursor: null });
      if (request.method === 'thread/resume') return reply({ thread: mock.threads.find(thread => thread.id === request.params.threadId), model: 'mock-model-a', serviceTier: current });
      return receive(socket, request);
    };
    await login(page);
    if (width < 760) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
    await page.locator('[data-section="recent"] .thread-row').first().click();
    const speed = page.getByRole('combobox', { name: '模型服务层级' });
    await expect(speed).toBeVisible();
    await expect(speed).toHaveValue(current || '');
    const label = page.locator('.service-tier-value');
    await expect(label).toBeVisible();
    await expect(label).toHaveText(current === 'priority' ? 'Fast' : '原生默认');
    await expect(speed.locator('option:checked')).toHaveText(current === 'priority' ? 'Fast' : '原生默认');
    expect(await speed.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(20);
    expect(mock.requests.filter(request => request.method === 'thread/settings/update')).toHaveLength(0);
    await page.screenshot({ path: `.data/speed-label-${width}-${current || 'native'}.png` });
  });
}

test('an unlisted native tier stays visible, and rejected changes restore the real selection', async ({ page, mock }) => {
  await page.route('**/api/hosts/local/native-capabilities?*', route => route.fulfill({ json: capabilities }));
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    const reply = (result: any) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'model/list') return reply({ data: [{ id: 'model-a', model: 'mock-model-a', displayName: 'Mock model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], serviceTiers: [{ id: 'priority', name: 'Fast' }] }], nextCursor: null });
    if (request.method === 'thread/resume') return reply({ thread: mock.threads.find(thread => thread.id === request.params.threadId), model: 'mock-model-a', serviceTier: 'native-saved-tier' });
    if (request.method === 'thread/settings/update') {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: '原生拒绝修改速度' } }));
    }
    return receive(socket, request);
  };
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  const speed = page.getByRole('combobox', { name: '模型服务层级' });
  await expect(page.locator('.service-tier-value')).toHaveText('原生：native-saved-tier');
  await expect(speed).toHaveValue('native-saved-tier');
  await speed.selectOption('priority');
  await expect(page.locator('.service-tier-error')).toContainText('原生拒绝修改速度');
  await expect(page.locator('.service-tier-value')).toHaveText('原生：native-saved-tier');
  await expect(speed).toHaveValue('native-saved-tier');
  await expect(speed).toBeEnabled();
});

test('late catalogs and model changes preserve the displayed native tier before any pointer interaction', async ({ page, mock }) => {
  let released = false;
  const pendingCapabilities: (() => Promise<void>)[] = [];
  await page.route('**/api/hosts/local/native-capabilities?*', route => released ? route.fulfill({ json: capabilities }) : new Promise<void>(resolve => {
    pendingCapabilities.push(async () => { await route.fulfill({ json: capabilities }); resolve(); });
  }));
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    const reply = (result: any) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'model/list') return reply({ data: [
      { id: 'model-a', model: 'mock-model-a', displayName: 'Mock model A', isDefault: true, serviceTiers: [{ id: 'priority', name: 'Fast' }] },
      { id: 'model-b', model: 'mock-model-b', displayName: 'Mock model B', serviceTiers: [{ id: 'default-speed', name: 'Normal' }] },
    ], nextCursor: null });
    if (request.method === 'thread/resume') return reply({ thread: mock.threads.find(thread => thread.id === request.params.threadId), model: 'mock-model-a', serviceTier: 'priority' });
    return receive(socket, request);
  };
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect.poll(() => pendingCapabilities.length).toBeGreaterThan(0);
  released = true;
  await Promise.all(pendingCapabilities.map(finish => finish()));
  const speed = page.getByRole('combobox', { name: '模型服务层级' });
  await expect(page.locator('.service-tier-value')).toHaveText('Fast');
  await expect(speed).toHaveValue('priority');
  await page.getByRole('combobox', { name: '选择模型', exact: true }).selectOption('mock-model-b');
  await expect(page.locator('.service-tier-value')).toHaveText('原生：priority');
  await expect(speed).toHaveValue('priority');
  await page.getByRole('combobox', { name: '选择模型', exact: true }).selectOption('mock-model-a');
  await expect(page.locator('.service-tier-value')).toHaveText('Fast');
  await expect(speed).toHaveValue('priority');
});

test('speed changes from another device update the current label without clicking or affecting another thread', async ({ page, mock }) => {
  await page.route('**/api/hosts/local/native-capabilities?*', route => route.fulfill({ json: capabilities }));
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    const reply = (result: any) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'model/list') return reply({ data: [{ id: 'model-a', model: 'mock-model-a', displayName: 'Mock model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority', name: 'Fast' }] }], nextCursor: null });
    if (request.method === 'thread/resume') return reply({ thread: mock.threads.find(thread => thread.id === request.params.threadId), model: 'mock-model-a', serviceTier: 'priority' });
    return receive(socket, request);
  };
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  const label = page.locator('.service-tier-value');
  await expect(label).toHaveText('Fast');
  mock.emit('bridge/thread/changed', { threadId: 'thread-existing', method: 'thread/settings/update', changeId: 'other-device:default', request: { serviceTier: null }, result: {} });
  await expect(label).toHaveText('原生默认');
  await expect(page.getByRole('combobox', { name: '模型服务层级' })).toHaveValue('');
  mock.emit('bridge/thread/changed', { threadId: 'different-thread', method: 'thread/settings/update', changeId: 'other-device:other-thread', request: { serviceTier: 'priority' }, result: {} });
  await expect(label).toHaveText('原生默认');
  mock.emit('bridge/thread/changed', { threadId: 'thread-existing', method: 'thread/settings/update', changeId: 'other-device:priority', request: { serviceTier: 'priority' }, result: {} });
  await expect(label).toHaveText('Fast');
  mock.emit('bridge/thread/changed', { threadId: 'thread-existing', method: 'thread/settings/update', changeId: 'other-device:effort-only', request: { effort: 'high' }, result: {} });
  await expect(page.getByRole('combobox', { name: '推理强度', exact: true })).toHaveValue('high');
  await expect(label).toHaveText('Fast');
  expect(mock.requests.filter(request => request.method === 'thread/settings/update')).toHaveLength(0);
});
