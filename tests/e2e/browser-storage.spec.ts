import { test, expect, login } from './fixtures';

test('a resumed model absent from the current inventory remains visible and is not silently replaced', async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/resume') {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, result: {
        thread: mock.threads.find(thread => thread.id === request.params.threadId),
        model: 'custom-gateway-model', reasoningEffort: 'medium', sandbox: { type: 'workspaceWrite' },
      } }));
    }
    return receive(socket, request);
  };
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const model = page.getByRole('combobox', { name: '选择模型', exact: true });
  await expect(model).toHaveValue('custom-gateway-model');
  await expect(model.locator('option:checked')).toHaveText('custom-gateway-model');
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('保留会话当前模型');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params.model).toBe('custom-gateway-model');
  await model.selectOption('mock-model-b');
  await expect(model.locator('option:checked')).toHaveText('Test Model B');
});

test('quota failures preserve thread drafts and accepted sends do not become apparent failures', async ({ page, mock }) => {
  mock.threads.push({ ...mock.threads[0], id: 'other', name: '另一个对话', preview: '另一个对话' });
  mock.turns.set('other', []);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('codex.draft.')) throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  const row = (name: string) => page.locator('[data-section="recent"] .thread-row').filter({ hasText: name });
  await row('已有测试历史').click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('请保留这份未发送草稿');
  await expect(page.getByRole('status', { name: '草稿保存状态' })).toContainText('关闭前请复制保存');
  await row('另一个对话').click();
  await input.fill('另一个对话的草稿');
  await row('已有测试历史').click();
  await expect(input).toHaveValue('请保留这份未发送草稿');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/start').length).toBe(1);
  await row('另一个对话').click();
  await expect(input).toHaveValue('另一个对话的草稿');
  await row('已有测试历史').click();
  await expect(input).toHaveValue('');
  expect(errors).toEqual([]);
});

test('blocked local and session storage permit login, thread selection and sending in the current window', async ({ page, mock }) => {
  await page.addInitScript(() => {
    for (const name of ['localStorage', 'sessionStorage'])
      Object.defineProperty(window, name, { get() { throw new DOMException('Denied', 'SecurityError'); } });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('当前窗口仍可发送');
  await expect(page.getByRole('status', { name: '草稿保存状态' })).toBeVisible();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/start').length).toBe(1);
  await expect(input).toHaveValue('');
  expect(errors).toEqual([]);
});
