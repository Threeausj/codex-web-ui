import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const capabilities = (live = true) => ({ status: 'known', methods: {
  'thread/settings/update': { available: true, params: ['threadId', 'model', 'effort', 'serviceTier'], required: ['threadId'] },
  'turn/settings/update': { available: live, params: ['threadId', 'turnId', 'model', 'effort', 'serviceTier'], required: ['threadId', 'turnId'] },
  'thread/start': { available: true, params: ['serviceTier'], required: [] },
  'turn/start': { available: true, params: ['threadId', 'input', 'serviceTier'], required: ['threadId', 'input'] },
} });
async function settingsWire(page: Page, mock: MockCodex, live = true) {
  await page.route('**/api/hosts/*/native-capabilities?*', route => route.fulfill({ json: capabilities(live) }));
  const receive = mock.receive.bind(mock);
  const controls = { rejectSaved: false, liveStatus: 'applied', liveError: '', hold: false, release: undefined as (() => void) | undefined };
  mock.receive = (socket, request) => {
    const reply = (result: any) => { mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result })); };
    if (request.method === 'model/list') return reply({ data: [
      { id: 'model-a', model: 'mock-model-a', displayName: 'Model A', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority', name: 'Fast' }] },
      { id: 'model-b', model: 'mock-model-b', displayName: 'Model B', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    ], nextCursor: null });
    if (request.method === 'thread/settings/update') {
      mock.requests.push(request);
      const finish = () => socket.send(JSON.stringify(controls.rejectSaved
        ? { id: request.id, error: { code: -32000, message: '拒绝修改模型设置' } }
        : { id: request.id, result: {} }));
      if (controls.hold) controls.release = finish; else finish();
      return;
    }
    if (request.method === 'turn/settings/update') {
      if (!controls.liveError) return reply({ status: controls.liveStatus });
      mock.requests.push(request); return socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: controls.liveError } }));
    }
    return receive(socket, request);
  };
  return controls;
}
async function openRunning(page: Page, mock: MockCodex) {
  mock.holdFinalMessage = true;
  await login(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('运行中的任务');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '选择模型', exact: true })).toBeEnabled();
}
for (const width of [1280, 390]) test(`${width}px running controls update later sampling without restarting and retain draft and next-turn settings`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 900 });
  await settingsWire(page, mock);
  await openRunning(page, mock);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('保留运行中尚未发送的草稿');
  const model = page.getByRole('combobox', { name: '选择模型', exact: true });
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  const speed = page.getByRole('combobox', { name: '模型服务层级', exact: true });
  await model.selectOption('mock-model-b');
  await expect(model).toHaveValue('mock-model-b');
  await expect(effort).toHaveValue('low');
  await expect(effort).toBeEnabled();
  await effort.selectOption('high');
  await expect(effort).toHaveValue('high');
  await expect(speed).toBeEnabled();
  await speed.selectOption('priority');
  await expect(speed).toHaveValue('priority');
  await expect(page.locator('.composer-setting-notice')).toContainText('当前任务后续模型请求生效');
  await expect(input).toHaveValue('保留运行中尚未发送的草稿');
  await expect(page.getByRole('button', { name: '追加指令', exact: true })).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'turn/settings/update').map(request => request.params)).toEqual([
    expect.objectContaining({ model: 'mock-model-b', effort: 'low' }),
    expect.objectContaining({ effort: 'high' }),
    expect.objectContaining({ serviceTier: 'priority' }),
  ]);
  expect(mock.requests.filter(request => ['turn/interrupt', 'turn/steer'].includes(request.method!))).toHaveLength(0);
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  mock.finishStream();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await input.fill('按新设置执行下一轮');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/start').length).toBe(2);
  expect(mock.requests.filter(request => request.method === 'turn/start').at(-1)!.params).toMatchObject({ model: 'mock-model-b', effort: 'high', serviceTier: 'priority' });
});

test('an older runtime saves future settings without attempting an unsupported live change', async ({ page, mock }) => {
  await settingsWire(page, mock, false); await openRunning(page, mock);
  await page.getByRole('combobox', { name: '推理强度', exact: true }).selectOption('high');
  await expect(page.locator('.composer-setting-notice')).toContainText('后续新一轮生效');
  expect(mock.requests.some(request => request.method === 'turn/settings/update')).toBe(false);
  expect(mock.requests.find(request => request.method === 'thread/settings/update')?.params).toMatchObject({ effort: 'high' });
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
});

test('a completed live target keeps saved future settings without restarting its task', async ({ page, mock }) => {
  const control = await settingsWire(page, mock); control.liveStatus = 'targetUnavailable';
  await openRunning(page, mock);
  await page.getByRole('combobox', { name: '推理强度', exact: true }).selectOption('high');
  await expect(page.locator('.composer-setting-notice')).toContainText('后续新一轮生效');
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  expect(mock.requests.filter(request => request.method === 'turn/interrupt')).toHaveLength(0);
});

test('a rejected saved model update restores native selection and keeps the original draft', async ({ page, mock }) => {
  const control = await settingsWire(page, mock); control.rejectSaved = true;
  await openRunning(page, mock);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('拒绝后保留的草稿');
  const model = page.getByRole('combobox', { name: '选择模型', exact: true });
  await model.selectOption('mock-model-b');
  await expect(page.locator('.composer-setting-notice')).toContainText('拒绝修改模型设置');
  await expect(model).toHaveValue('mock-model-a');
  await expect(input).toHaveValue('拒绝后保留的草稿');
  expect(mock.requests.some(request => request.method === 'turn/settings/update')).toBe(false);
});

test('an old conversation response cannot set the model or live turn of the newly selected conversation', async ({ page, mock }) => {
  const control = await settingsWire(page, mock); await openRunning(page, mock);
  control.hold = true;
  await page.getByRole('combobox', { name: '选择模型', exact: true }).selectOption('mock-model-b');
  await expect.poll(() => typeof control.release).toBe('function');
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  control.release!();
  mock.emit('thread/name/updated', { threadId: 'thread-existing', threadName: '新选中会话' });
  await expect(page.locator('.main-header h1')).toHaveText('新选中会话');
  await expect(page.getByRole('combobox', { name: '选择模型', exact: true })).toHaveValue('mock-model-a');
  await expect(page.locator('.composer-setting-notice')).toHaveCount(0);
  expect(mock.requests.some(request => request.method === 'turn/settings/update')).toBe(false);
});

for (const error of ['turn settings updates require the step_model_switching feature', 'the active model has only fallback metadata']) test(`native live rejection falls back to saved future defaults: ${error}`, async ({ page, mock }) => {
  const control = await settingsWire(page, mock); control.liveError = error;
  await openRunning(page, mock);
  await page.getByRole('combobox', { name: '推理强度', exact: true }).selectOption('high');
  await expect(page.locator('.composer-setting-notice')).toHaveText('已保存，后续新一轮生效');
  await expect(page.getByRole('combobox', { name: '推理强度', exact: true })).toHaveValue('high');
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  expect(mock.requests.some(request => request.method === 'turn/interrupt')).toBe(false);
});

test('existing native queue keeps saved defaults when running controls and later queued input change', async ({ page, mock }) => {
  await settingsWire(page, mock);
  const fields = {
    add: ['threadId', 'input', 'clientUserMessageId'], list: ['threadId', 'limit', 'cursor'],
    update: ['threadId', 'queuedSubmissionId', 'input'], delete: ['threadId', 'queuedSubmissionId'],
    reorder: ['threadId', 'queuedSubmissionIds'], start: ['threadId', 'queuedSubmissionId'],
  };
  const caps = capabilities(true);
  caps.methods['thread/settings/update'].params.push('cwd', 'sandboxPolicy', 'approvalPolicy');
  await page.route('**/api/hosts/*/native-capabilities?*', route => route.fulfill({ json: {
    ...caps, methods: { ...caps.methods, ...Object.fromEntries(Object.entries(fields).map(([name, params]) => [`thread/queue/${name}`, { available: true, params, required: ['threadId'] }])) },
  } }));
  const originalInput = [{ type: 'text', text: '此前已排队的任务', text_elements: [] }];
  const queued = [{ id: 'original', clientUserMessageId: 'original-client', input: originalInput }];
  const receive = mock.receive.bind(mock);
  mock.receive = (socket, request) => {
    if (!request.method.startsWith('thread/queue/')) return receive(socket, request);
    mock.requests.push(request);
    if (request.method === 'thread/queue/list') return socket.send(JSON.stringify({ id: request.id, result: { data: queued, nextCursor: null } }));
    if (request.method === 'thread/queue/add') {
      const item = { id: 'new', clientUserMessageId: request.params.clientUserMessageId, input: request.params.input };
      queued.push(item); mock.emit('thread/queue/changed', { threadId: request.params.threadId });
      return socket.send(JSON.stringify({ id: request.id, result: { queuedSubmission: item } }));
    }
    return socket.send(JSON.stringify({ id: request.id, result: {} }));
  };
  mock.turns.get('thread-existing')!.push({ id: 'native-running', status: 'inProgress', items: [] });
  mock.threads[0]!.status = { type: 'active', activeFlags: [] };
  await login(page); await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByRole('button', { name: /运行中 · 下一轮队列 1/ })).toBeVisible();
  const model = page.getByRole('combobox', { name: '选择模型', exact: true });
  await expect(model).toBeEnabled();
  await model.selectOption('mock-model-b');
  await expect(page.locator('.composer-setting-notice')).toContainText('已排队消息保留原设置');
  expect(mock.requests.filter(request => request.method === 'thread/settings/update')).toHaveLength(0);
  await page.getByRole('combobox', { name: '模型服务层级', exact: true }).selectOption('priority');
  await expect(page.locator('.service-tier-value')).toHaveText('Fast');
  expect(mock.requests.filter(request => request.method === 'thread/settings/update')).toHaveLength(0);
  await expect(page.getByRole('combobox', { name: '选择权限', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: '消息发送方式' }).selectOption('queue');
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('后来新排队的输入');
  await page.getByRole('button', { name: '加入下一轮队列', exact: true }).click();
  await expect.poll(() => queued.length).toBe(2);
  expect(queued[0]!.input).toEqual(originalInput);
  const saved = mock.requests.find(request => request.method === 'thread/settings/update')!.params;
  expect(saved).not.toHaveProperty('model'); expect(saved).not.toHaveProperty('effort'); expect(saved).not.toHaveProperty('serviceTier');
  expect(mock.requests.some(request => request.method === 'turn/interrupt')).toBe(false);
});
