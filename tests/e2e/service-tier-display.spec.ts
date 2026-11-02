import { test, expect, login, type MockCodex } from './fixtures';

const capabilities = { status: 'known', methods: {
  'thread/settings/update': { available: true, params: ['threadId', 'serviceTier'], required: ['threadId'] },
  'thread/start': { available: true, params: ['serviceTier'], required: [] },
  'turn/start': { available: true, params: ['threadId', 'input', 'serviceTier'], required: ['threadId', 'input'] },
} };

function nativeSpeed(mock: MockCodex, serviceTier: string | null) {
  const receive = mock.receive.bind(mock);
  mock.receive = (socket, request) => {
    const reply = (result: any) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'model/list') return reply({ data: [{
      id: 'model-a', model: 'mock-model-a', displayName: 'Mock model', isDefault: true,
      defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Native catalog' }],
    }], nextCursor: null });
    if (request.method === 'thread/resume') return reply({ thread: mock.threads.find(thread => thread.id === request.params.threadId), model: 'mock-model-a', serviceTier });
    return receive(socket, request);
  };
}

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

test('late catalogs preserve native speed and changing to an incompatible model resets the requested tier', async ({ page, mock }) => {
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
  const speed = page.getByRole('combobox', { name: '模型服务层级' });
  await expect(page.locator('.service-tier-value')).toHaveText('Fast');
  await expect(speed).toBeVisible();
  await expect(speed).toBeDisabled();
  await expect(speed).toHaveValue('priority');
  released = true;
  await Promise.all(pendingCapabilities.map(finish => finish()));
  await expect(speed).toBeEnabled();
  await expect(page.locator('.service-tier-value')).toHaveText('Fast');
  await expect(speed).toHaveValue('priority');
  await page.getByRole('combobox', { name: '选择模型', exact: true }).selectOption('mock-model-b');
  await expect(page.locator('.service-tier-value')).toHaveText('原生默认');
  await expect(speed).toHaveValue('');
  await page.getByRole('combobox', { name: '选择模型', exact: true }).selectOption('mock-model-a');
  await expect(page.locator('.service-tier-value')).toHaveText('原生默认');
  await expect(speed).toHaveValue('');
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

for (const width of [1280, 390]) test(`${width}px unknown native capabilities keep the real Fast selection visible without allowing unverified changes`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/hosts/local/native-capabilities?*', route => route.fulfill({ json: {
    status: 'unknown', reason: 'runtime_version_unknown', methods: {},
  } }));
  nativeSpeed(mock, 'priority');
  await login(page);
  if (width < 760) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const speed = page.getByRole('combobox', { name: '模型服务层级', exact: true });
  await expect(speed).toBeVisible();
  await expect(speed).toHaveValue('priority');
  await expect(speed).toBeDisabled();
  await expect(page.locator('.service-tier-value')).toHaveText('Fast');
  expect(mock.requests.filter(request => ['thread/settings/update', 'turn/settings/update', 'turn/start'].includes(request.method!))).toHaveLength(0);
});

test('a runtime with only turn-start tier support can select Fast for the next manual turn', async ({ page, mock }) => {
  await page.route('**/api/hosts/local/native-capabilities?*', route => route.fulfill({ json: {
    ...capabilities, methods: {
      ...capabilities.methods,
      'thread/settings/update': { available: false, params: [], required: [] },
    },
  } }));
  nativeSpeed(mock, null);
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  const speed = page.getByRole('combobox', { name: '模型服务层级', exact: true });
  await expect(speed).toBeEnabled();
  await speed.selectOption('priority');
  await expect(page.locator('.service-tier-value')).toHaveText('Fast');
  expect(mock.requests.some(request => request.method === 'thread/settings/update')).toBe(false);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('下一轮使用 Fast');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params?.serviceTier).toBe('priority');
  expect(mock.request('turn/start')!.params.threadId).toBe('thread-existing');
  expect(mock.requests.some(request => ['turn/interrupt', 'turn/settings/update'].includes(request.method!))).toBe(false);
});

test('explicitly unsupported native tier methods keep the saved label visible and disabled', async ({ page, mock }) => {
  await page.route('**/api/hosts/local/native-capabilities?*', route => route.fulfill({ json: {
    status: 'known', methods: Object.fromEntries(Object.keys(capabilities.methods).map(method => [method, {
      available: false, params: [], required: [],
    }])),
  } }));
  nativeSpeed(mock, 'priority');
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByRole('combobox', { name: '模型服务层级', exact: true })).toBeDisabled();
  await expect(page.locator('.service-tier-value')).toHaveText('Fast');
  expect(mock.requests.filter(request => ['thread/settings/update', 'turn/settings/update', 'turn/start'].includes(request.method!))).toHaveLength(0);
});

test('a transient capability failure recovers the visible Fast control without clicking or changing speed', async ({ page, mock }) => {
  let recover = false;
  let calls = 0;
  await page.route('**/api/hosts/local/native-capabilities?*', route => {
    calls++;
    return route.fulfill({ json: recover ? capabilities : { status: 'unknown', reason: 'schema_unavailable', methods: {} } });
  });
  nativeSpeed(mock, 'priority');
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  const speed = page.getByRole('combobox', { name: '模型服务层级', exact: true });
  await expect(speed).toBeVisible();
  await expect(page.locator('.service-tier-value')).toHaveText('Fast');
  await expect(speed).toBeDisabled();
  const before = calls;
  recover = true;
  await expect(speed).toBeEnabled({ timeout: 17_000 });
  expect(calls).toBeGreaterThan(before);
  await expect(page.locator('.service-tier-value')).toHaveText('Fast');
  await expect(speed).toHaveValue('priority');
  expect(mock.requests.filter(request => ['thread/settings/update', 'turn/settings/update', 'turn/start'].includes(request.method!))).toHaveLength(0);
});
