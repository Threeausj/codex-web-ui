import { test, expect, login, MockCodex } from './fixtures';

function goalWire(mock: MockCodex) {
  const original = (mock as any).receive.bind(mock);
  const control = { goal: null as any, failPause: false, holdSettings: false, holdRead: false, reads: [] as { threadId: string; fail(): void; reply(): void }[], releaseSettings: undefined as (() => void) | undefined };
  (mock as any).receive = (socket: any, request: any) => {
    const reply = (result: any) => socket.send(JSON.stringify({ id: request.id, result }));
    const error = (message: string, code = -32600) => socket.send(JSON.stringify({ id: request.id, error: { code, message } }));
    const p = request.params || {};
    if (!['collaborationMode/list', 'thread/goal/get', 'thread/goal/set', 'thread/settings/update', 'turn/interrupt'].includes(request.method)) return original(socket, request);
    mock.requests.push(request);
    if (request.method === 'collaborationMode/list') return reply({ data: [{ mode: 'default' }, { mode: 'plan' }] });
    if (request.method === 'thread/goal/get') {
      if (p.threadId === '00000000-0000-0000-0000-000000000000') return error(`thread not found: ${p.threadId}`);
      control.reads.push({ threadId: p.threadId, fail: () => error('Late superseded goal read failure'), reply: () => reply({ goal: control.goal }) });
      if (control.holdRead) return;
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

test('a timed-out goal read retries automatically, restores the Goal and clears only its own error', async ({ page, mock }) => {
  const control = goalWire(mock); control.holdRead = true;
  control.goal = { threadId: 'thread-existing', objective: '恢复读取的目标', status: 'paused', tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1791200000, updatedAt: 1791200001 };
  await login(page); await page.clock.install();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect.poll(() => control.reads.length).toBe(1);
  await page.clock.fastForward(15000);
  await expect(page.locator('.composer-mode-error')).toContainText('thread/goal/get 请求超时');
  await expect(page.getByRole('button', { name: '重新读取目标', exact: true })).toBeEnabled();
  control.holdRead = false; await page.clock.fastForward(2500);
  await expect(page.locator('.composer-goal')).toContainText('恢复读取的目标');
  await expect(page.locator('.composer-mode-error')).toHaveCount(0);
  control.failPause = true;
  await page.getByRole('button', { name: '继续目标', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停目标', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '暂停目标', exact: true }).click();
  await expect(page.locator('.composer-mode-error')).toContainText('Synthetic pause failure');
  mock.emit('thread/goal/updated', { threadId: 'thread-existing', goal: control.goal });
  await expect(page.locator('.composer-mode-error')).toContainText('Synthetic pause failure');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a healthy bridge returning clears a goal read timeout after one read without replaying mutations', async ({ page, mock }) => {
  const control = goalWire(mock); control.holdRead = true;
  await login(page); await page.clock.install();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect.poll(() => control.reads.length).toBe(1);
  await page.clock.fastForward(15000);
  await expect(page.locator('.composer-mode-error')).toContainText('请求超时');
  mock.emit('bridge/status', { connected: false });
  await expect(page.getByRole('button', { name: '重新读取目标', exact: true })).toBeDisabled();
  control.holdRead = false; mock.emit('bridge/status', { connected: true });
  await expect(page.locator('.composer-mode-error')).toHaveCount(0);
  expect(control.reads).toHaveLength(2);
  expect(mock.request('thread/goal/set')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
});

for (const event of ['updated', 'cleared'] as const) {
  test(`an authoritative goal/${event} event clears its read warning and suppresses the pending read failure`, async ({ page, mock }) => {
    const control = goalWire(mock); control.holdRead = true;
    await login(page); await page.clock.install();
    await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
    await expect.poll(() => control.reads.length).toBe(1);
    await page.clock.fastForward(15000);
    await expect(page.locator('.composer-mode-error')).toContainText('请求超时');
    await page.clock.fastForward(2500);
    await expect.poll(() => control.reads.length).toBe(2);
    mock.emit(`thread/goal/${event}`, { threadId: 'thread-existing', goal: { objective: '实时确认的目标', status: 'paused' } });
    await expect(page.locator('.composer-mode-error')).toHaveCount(0);
    control.reads[1]!.fail();
    await expect(page.locator('.composer-mode-error')).toHaveCount(0);
    await page.clock.fastForward(30000);
    expect(control.reads).toHaveLength(2);
    expect(mock.request('thread/goal/set')).toBeUndefined();
    expect(mock.request('turn/start')).toBeUndefined();
  });
}

test('a delayed goal read from the previous selection cannot add a warning to a new conversation', async ({ page, mock }) => {
  const control = goalWire(mock); control.holdRead = true;
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect.poll(() => control.reads.length).toBe(1);
  await page.getByRole('button', { name: /新建对话/ }).first().click();
  control.reads[0]!.fail();
  await expect(page.locator('.composer-mode-error')).toHaveCount(0);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('reselecting the same conversation ignores a failed read from its previous selection', async ({ page, mock }) => {
  const control = goalWire(mock); control.holdRead = true;
  await login(page);
  const thread = page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first();
  await thread.click(); await expect.poll(() => control.reads.length).toBe(1);
  control.holdRead = false;
  await thread.click(); await expect.poll(() => control.reads.length).toBe(2);
  control.reads[0]!.fail();
  await expect(page.locator('.composer-mode-error')).toHaveCount(0);
  expect(mock.request('thread/goal/set')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('foreground recovery of a continuous connection refreshes a failed Goal read without reloading history', async ({ page, mock }) => {
  const control = goalWire(mock); control.holdRead = true;
  const receive = (mock as any).receive.bind(mock);
  const status = { connected: true, engineId: 'goal-continuous-engine', eventSequence: 0, loadedThreadIds: ['thread-existing'], pendingRequests: [] };
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'bridge/ping') return receive(socket, request);
    mock.requests.push(request); socket.send(JSON.stringify({ id: request.id, result: status }));
  };
  await login(page); mock.emit('bridge/status', status); await page.clock.install();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect.poll(() => control.reads.length).toBe(1);
  await page.clock.fastForward(15000);
  await expect(page.locator('.composer-mode-error')).toContainText('请求超时');
  const before = mock.requests.filter(request => ['thread/resume', 'thread/turns/list'].includes(request.method)).length;
  control.holdRead = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.fastForward(250);
  await expect(page.locator('.composer-mode-error')).toHaveCount(0);
  expect(control.reads).toHaveLength(2); expect(mock.sockets).toHaveLength(1);
  expect(mock.requests.filter(request => ['thread/resume', 'thread/turns/list'].includes(request.method))).toHaveLength(before);
  expect(mock.request('thread/goal/set')).toBeUndefined(); expect(mock.request('turn/start')).toBeUndefined();
});

test('manual retries share one Goal read and server-side transient errors recover automatically', async ({ page, mock }) => {
  const control = goalWire(mock); control.holdRead = true;
  await login(page); await page.clock.install();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect.poll(() => control.reads.length).toBe(1); await page.clock.fastForward(15000);
  const retry = page.getByRole('button', { name: '重新读取目标', exact: true });
  await retry.click(); await retry.click();
  expect(control.reads).toHaveLength(2);
  const pending = mock.requests.filter(request => request.method === 'thread/goal/get' && request.params.threadId === 'thread-existing').at(-1)!;
  mock.sockets[0]!.send(JSON.stringify({ id: pending.id, error: { code: -32000, message: 'Temporary native read unavailable' } }));
  await expect(page.locator('.composer-mode-error')).toContainText('Temporary native read unavailable');
  control.holdRead = false; await page.clock.fastForward(5000);
  await expect(page.locator('.composer-mode-error')).toHaveCount(0);
  expect(control.reads).toHaveLength(3);
  expect(mock.request('thread/goal/set')).toBeUndefined(); expect(mock.request('turn/start')).toBeUndefined();
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
