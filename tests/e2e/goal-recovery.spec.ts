import { test, expect, login, MockCodex } from './fixtures';

function goalWire(mock: MockCodex) {
  const original = (mock as any).receive.bind(mock);
  const control = { goal: null as any, failPause: false, holdSettings: false, releaseSettings: undefined as (() => void) | undefined };
  (mock as any).receive = (socket: any, request: any) => {
    const reply = (result: any) => socket.send(JSON.stringify({ id: request.id, result }));
    const error = (message: string, code = -32600) => socket.send(JSON.stringify({ id: request.id, error: { code, message } }));
    const p = request.params || {};
    if (!['collaborationMode/list', 'thread/goal/get', 'thread/goal/set', 'thread/settings/update', 'turn/interrupt'].includes(request.method)) return original(socket, request);
    mock.requests.push(request);
    if (request.method === 'collaborationMode/list') return reply({ data: [{ mode: 'default' }, { mode: 'plan' }] });
    if (request.method === 'thread/goal/get') {
      if (p.threadId === '00000000-0000-0000-0000-000000000000') return error(`thread not found: ${p.threadId}`);
      return reply({ goal: control.goal });
    }
    if (request.method === 'thread/settings/update') {
      if (control.holdSettings) control.releaseSettings = () => reply({});
      else reply({});
      return;
    }
    if (request.method === 'thread/goal/set') {
      if (p.status === 'paused' && control.failPause) return error('Synthetic pause failure');
      control.goal = { threadId: p.threadId, objective: p.objective ?? control.goal?.objective,
        status: p.status ?? control.goal?.status, tokenBudget: p.tokenBudget ?? null, tokensUsed: 0,
        timeUsedSeconds: 0, createdAt: 1791200000, updatedAt: 1791200001 };
      reply({ goal: control.goal });
      return mock.emit('thread/goal/updated', { threadId: p.threadId, turnId: null, goal: control.goal });
    }
    if (request.method === 'turn/interrupt') {
      reply({});
      // A native interrupt also stops the engine's automatic continuation.
      control.goal = { ...control.goal, status: 'paused' };
      mock.emit('thread/goal/updated', { threadId: p.threadId, turnId: null, goal: control.goal });
      return mock.emit('turn/completed', { threadId: p.threadId,
        turn: { id: p.turnId, status: 'interrupted', items: [], startedAt: 1791200000, completedAt: 1791200001 } });
    }
  };
  return control;
}

test('Stop still interrupts a Goal when its pause request fails', async ({ page, mock }) => {
  const control = goalWire(mock);
  mock.holdFinalMessage = true;
  await login(page);
  const input = page.getByRole('textbox', { name: '消息输入框' });
  await input.fill('@goal');
  await input.press('Enter');
  await expect(page.locator('.composer-goal')).toContainText('输入目标后发送');
  await input.fill('验证停止操作');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停目标', exact: true })).toBeEnabled();
  control.failPause = true;
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect.poll(() => mock.request('turn/interrupt')?.params.turnId).toBeTruthy();
  await expect(page.locator('.composer-goal')).toContainText('已暂停');
  await expect(page.locator('.composer-mode-error')).toContainText('Synthetic pause failure');
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
});

test('a paused native Goal is restored after reload without starting a model turn', async ({ page, mock }) => {
  const control = goalWire(mock);
  control.goal = { threadId: 'thread-existing', objective: '已保存的暂停目标', status: 'paused',
    tokenBudget: 500, tokensUsed: 120, timeUsedSeconds: 7, createdAt: 1791200000, updatedAt: 1791200001 };
  await login(page);
  await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect(page.locator('.composer-goal')).toContainText('已保存的暂停目标');
  await expect(page.getByRole('button', { name: '继续目标', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator('.composer-goal')).toContainText('已保存的暂停目标');
  await expect(page.locator('.composer-goal')).toContainText('已暂停');
  expect(mock.request('thread/goal/set')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
});

for (const terminalEvent of ['complete', 'cleared'] as const) {
  test(`a Goal ${terminalEvent} notification during resume settings ACK cannot reactivate the target`, async ({ page, mock }) => {
    const control = goalWire(mock);
    control.goal = { threadId: 'thread-existing', objective: '恢复过程中的目标', status: 'paused',
      tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 7, createdAt: 1791200000, updatedAt: 1791200001 };
    await login(page);
    await page.locator('[data-section="recent"] [data-host-id="local"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
    await expect(page.getByRole('button', { name: '继续目标', exact: true })).toBeEnabled();
    control.holdSettings = true;
    await page.getByRole('button', { name: '继续目标', exact: true }).click();
    await expect.poll(() => typeof control.releaseSettings).toBe('function');
    if (terminalEvent === 'complete') {
      control.goal = { ...control.goal, status: 'complete' };
      mock.emit('thread/goal/updated', { threadId: 'thread-existing', turnId: null, goal: control.goal });
      await expect(page.locator('.composer-goal')).toContainText('已完成');
    } else {
      control.goal = null;
      mock.emit('thread/goal/cleared', { threadId: 'thread-existing' });
      await expect(page.locator('.composer-goal')).toContainText('输入目标后发送');
    }
    control.releaseSettings?.();
    await expect(page.getByRole('button', { name: '恢复默认模式', exact: true })).toBeEnabled();
    expect(mock.request('thread/goal/set')).toBeUndefined();
  });
}
