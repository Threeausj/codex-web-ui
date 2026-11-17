import { test, expect, login, type MockCodex } from './fixtures';

const family = (model: string, displayName: string, isDefault = false) => ({
  id: model, model, displayName, description: '', modelSpecialty: null, hidden: false,
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
  defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], isDefault,
  serviceTiers: [{ id: 'priority', name: 'Fast' }], defaultServiceTier: 'priority',
});

function nativeDefaultConversation(mock: MockCodex, serviceTier: string | null = null) {
  mock.config.model = 'gpt-6.1-sol';
  mock.modelCatalog = [family('gpt-6.1-sol', 'GPT-6.1-Sol', true), family('gpt-6-astra', 'GPT-6-Astra'), family('gpt-6-sol', 'GPT-6-Sol')];
  const receive = mock.receive.bind(mock);
  mock.receive = (socket, request) => request.method !== 'thread/resume' ? receive(socket, request) : receive({
    send(raw: string) {
      const message = JSON.parse(raw);
      if (message.result) message.result.serviceTier = serviceTier;
      socket.send(JSON.stringify(message));
    },
  } as typeof socket, request);
}

for (const width of [1280, 390]) for (const reason of ['runtime_version_mismatch', 'schema_unavailable'])
test(`${width}px: a resumed native-default thread can choose and send 6.2 even when ${reason}`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 900 });
  nativeDefaultConversation(mock);
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: { status: 'unknown', reason, checkedCliVersion: '0.169.0', methods: {} } }));
  await login(page);
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"]').filter({ hasText: '已有测试历史' }).locator('.thread-row').click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  const model = page.getByRole('combobox', { name: '选择模型', exact: true });
  await expect(model).toBeEnabled();
  await model.selectOption('gpt-6.2-astra');
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('gpt-6.2-astra');
  await page.getByRole('combobox', { name: '推理强度', exact: true }).selectOption('high');
  await expect(page.getByRole('combobox', { name: '推理强度', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('按选择的 6.2 Astra 执行');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params?.model).toBe('gpt-6.2-astra');
  expect(mock.request('turn/start')!.params).toMatchObject({ threadId: 'thread-existing', effort: 'high' });
  expect(mock.request('turn/start')!.params).not.toHaveProperty('serviceTier');
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('gpt-6.2-astra');
  expect(mock.requests.some(request => ['thread/settings/update', 'turn/interrupt'].includes(request.method!))).toBe(false);
  await expect(page.locator('.composer-setting-notice')).toHaveCount(0);
});

test('a model incompatible with saved Fast cannot silently reset that tier on an unverified runtime', async ({ page, mock }) => {
  nativeDefaultConversation(mock, 'priority');
  mock.modelCatalog!.find(model => model.model === 'gpt-6-astra')!.serviceTiers = [];
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: { status: 'unknown', reason: 'runtime_version_mismatch', checkedCliVersion: '0.169.0', methods: {} } }));
  await login(page);
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"]').filter({ hasText: '已有测试历史' }).locator('.thread-row').click();
  await expect(page.locator('.agent-message')).toContainText('历史保持可读');
  const speed = page.getByRole('combobox', { name: '模型服务层级', exact: true });
  await expect(speed).toHaveValue('priority');
  await expect(speed).toBeDisabled();
  const model = page.getByRole('combobox', { name: '选择模型', exact: true });
  await model.selectOption('gpt-6.2-astra');
  await expect(model).toBeEnabled();
  // Unlike a redundant native-default reset, a saved tier is an actual change
  // whose protocol must be verified before it can be resubmitted or cleared.
  await expect(page.locator('.composer-setting-notice')).toContainText('安装的 Codex CLI');
  await expect(model).toHaveValue('gpt-6.1-sol');
  await expect(speed).toHaveValue('priority');
  expect(mock.requests.some(request => ['thread/settings/update', 'turn/settings/update', 'turn/start'].includes(request.method!))).toBe(false);
});

test('new GPT-6.2 Astra and Sol remain selectable with their family reasoning and speed controls', async ({ page, mock }) => {
  mock.modelCatalog = [
    family('gpt-6.1-sol', 'GPT-6.1-Sol', true),
    family('gpt-6-astra', 'GPT-6-Astra'),
    family('gpt-6-sol', 'GPT-6-Sol'),
  ];
  await login(page);
  const model = page.getByRole('combobox', { name: '选择模型', exact: true });
  await expect(model.locator('option[value="gpt-6.2-astra"]')).toHaveText('GPT-6.2-Astra');
  await expect(model.locator('option[value="gpt-6.2-sol"]')).toHaveText('GPT-6.2-Sol');
  await model.selectOption('gpt-6.2-astra');await expect(model).toHaveValue('gpt-6.2-astra');
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  await expect(effort.locator('option[value="ultra"]')).toHaveCount(1);
  const speed = page.getByRole('combobox', { name: '模型服务层级', exact: true });
  await expect(speed.locator('option[value="priority"]')).toHaveCount(1);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('验证新模型');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params?.model).toBe('gpt-6.2-astra');
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('gpt-6.2-astra');
  await model.selectOption('gpt-6.2-sol');await expect(model).toHaveValue('gpt-6.2-sol');
});
