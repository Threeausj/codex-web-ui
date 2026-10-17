import { test, expect, login, slash, type MockCodex } from './fixtures';

function holdCompaction(mock: MockCodex) {
  let finish!: (status?: string) => void;
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/compact/start') return receive(socket, request);
    mock.requests.push(request);
    const threadId = request.params.threadId;
    const turn = { id: 'held-compaction', items: [] as any[], status: 'inProgress', itemsView: 'full' };
    const item = { id: 'held-compaction-item', type: 'contextCompaction', status: 'inProgress' };
    mock.turns.get(threadId)!.push(turn);
    mock.emit('turn/started', { threadId, turn });
    mock.emit('item/started', { threadId, turnId: turn.id, item });
    socket.send(JSON.stringify({ id: request.id, result: {} }));
    finish = (status = 'completed') => {
      turn.status = status;
      if (status === 'completed') {
        turn.items = [{ ...item, status: 'completed' }];
        mock.emit('item/completed', { threadId, turnId: turn.id, item: turn.items[0] });
        mock.emit('thread/compacted', { threadId, turnId: turn.id });
      }
      mock.emit('turn/completed', { threadId, turn });
    };
  };
  return (status?: string) => finish(status);
}
const submissions = (mock: MockCodex) => mock.requests.filter(request => ['turn/start', 'turn/steer', 'thread/queue/add'].includes(request.method || ''));

for (const width of [1440, 390]) {
  test(`${width}px one send action accepts a prompt during compression and submits exactly once afterwards`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 900 });
    const finish = holdCompaction(mock);
    await login(page);
    if (width < 760) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
    await page.locator('[data-section="recent"] .thread-row').first().click();
    await slash(page, 'compact');
    await expect(page.locator('.context-usage')).toContainText('正在压缩');
    const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
    await input.fill('压缩结束继续执行');
    await expect(page.locator('.composer-submit .send-button')).toHaveCount(1);
    const button = page.getByRole('button', { name: '追加指令', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByRole('button', { name: '压缩结束后发送', exact: true })).toBeDisabled();
    await expect(page.locator('.compaction-send-note')).toBeVisible();
    await expect(input).toHaveValue('压缩结束继续执行');
    expect(submissions(mock)).toHaveLength(0);
    await input.press('Enter');
    expect(submissions(mock)).toHaveLength(0);
    finish();
    await expect.poll(() => submissions(mock).length).toBe(1);
    expect(submissions(mock)[0].method).toBe('turn/start');
    expect(submissions(mock)[0].params.input[0].text).toBe('压缩结束继续执行');
    await expect(input).toHaveValue('');
    await expect(page.locator('.compaction-send-note')).toHaveCount(0);
  });
}

test('compression preserves the submitted text snapshot and new draft typed while waiting', async ({ page, mock }) => {
  const finish = holdCompaction(mock);
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await slash(page, 'compact');
  await expect(page.locator('.context-usage')).toContainText('正在压缩');
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('第一条已提交消息');
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await input.fill('保留的新草稿');
  finish();
  await expect.poll(() => submissions(mock).length).toBe(1);
  expect(submissions(mock)[0].params.input[0].text).toBe('第一条已提交消息');
  await expect(input).toHaveValue('保留的新草稿');
});

test('automatic compression releases a deferred prompt into the running task without waiting for the task to end', async ({ page, mock }) => {
  mock.holdFinalMessage = true;
  await login(page);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('运行中的任务');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  const threadId = mock.request('turn/start')!.params.threadId;
  const turn = mock.turns.get(threadId)!.find(turn => turn.status === 'inProgress');
  const item = { id: 'automatic-compaction', type: 'contextCompaction', status: 'inProgress' };
  mock.emit('item/started', { threadId, turnId: turn.id, item });
  await expect(page.locator('.context-usage')).toContainText('正在压缩');
  await input.fill('压缩后立即补充给当前任务');
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  expect(mock.requests.filter(request => request.method === 'turn/steer')).toHaveLength(0);
  mock.emit('item/completed', { threadId, turnId: turn.id, item: { ...item, status: 'completed' } });
  mock.emit('thread/compacted', { threadId, turnId: turn.id });
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/steer').length).toBe(1);
  expect(mock.request('turn/steer')!.params).toMatchObject({
    expectedTurnId: turn.id, input: [{ type: 'text', text: '压缩后立即补充给当前任务' }],
  });
  expect(turn.status).toBe('inProgress');
  await expect(input).toHaveValue('');
});

for (const recovery of ['new assistant output', 'authoritative context read'] as const) {
  test(`automatic compression recovers from missed completion through ${recovery} and sends a deferred prompt once`, async ({ page, mock }) => {
    mock.holdFinalMessage = true;
    let persistedCompacting = false;
    const contextReads: boolean[] = [];
    await page.route('**/api/hosts/local/threads/*/context*', route => {
      contextReads.push(persistedCompacting);
      return route.fulfill({ json: {
        tokenUsage: { last: { totalTokens: persistedCompacting ? 80000 : 12000 }, modelContextWindow: 100000 },
        compacting: persistedCompacting,
      } });
    });
    await login(page);
    const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
    await input.fill('任务在自动压缩后继续运行');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
    const threadId = mock.request('turn/start')!.params.threadId;
    const turn = mock.turns.get(threadId)!.find(turn => turn.status === 'inProgress');
    persistedCompacting = true;
    const item = { id: 'missed-automatic-completion', type: 'contextCompaction', status: 'inProgress' };
    turn.items.push(item);
    mock.emit('item/started', { threadId, turnId: turn.id, item });
    await expect(page.locator('.context-usage')).toContainText('正在压缩');
    await input.fill('压缩结束后只补充一次');
    await page.getByRole('button', { name: '追加指令', exact: true }).click();
    await expect(page.locator('.compaction-send-note')).toBeVisible();
    expect(mock.requests.filter(request => request.method === 'turn/steer')).toHaveLength(0);

    // A late command's stream may arrive while compaction is still running;
    // it must not release the queued user input or dismiss the progress marker.
    mock.emit('item/commandExecution/outputDelta', { threadId, turnId: turn.id, itemId: 'older-command', delta: '迟到的命令输出' });
    await expect(page.locator('.context-usage')).toContainText('正在压缩');
    expect(mock.requests.filter(request => request.method === 'turn/steer')).toHaveLength(0);

    item.status = 'completed';
    persistedCompacting = false;
    if (recovery === 'new assistant output') {
      const response = { id: 'response-after-compaction', type: 'agentMessage', text: '压缩结束继续执行当前任务' };
      turn.items.push(response);
      mock.emit('item/started', { threadId, turnId: turn.id, item: response });
      await expect(page.getByText(response.text, { exact: true })).toBeVisible();
    }
    await expect.poll(() => mock.requests.filter(request => request.method === 'turn/steer').length, { timeout: 10000 }).toBe(1);
    expect(mock.request('turn/steer')!.params).toMatchObject({
      expectedTurnId: turn.id, input: [{ type: 'text', text: '压缩结束后只补充一次' }],
    });
    expect(turn.status).toBe('inProgress');
    await expect(page.locator('.compaction-divider')).toContainText('上下文已压缩');
    await expect(page.locator('.context-usage')).not.toContainText('正在压缩');
    await expect(page.locator('.compaction-send-note')).toHaveCount(0);
    await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
    if (recovery === 'authoritative context read') expect(contextReads).toContain(false);
    // A duplicate late native completion cannot submit the same input again.
    mock.emit('item/completed', { threadId, turnId: turn.id, item });
    mock.emit('thread/compacted', { threadId, turnId: turn.id });
    await input.fill('新的草稿保持不变');
    await expect(input).toHaveValue('新的草稿保持不变');
    expect(mock.requests.filter(request => request.method === 'turn/steer')).toHaveLength(1);
  });
}

for (const contextState of ['still compacting', 'temporarily unavailable'] as const) {
  test(`recovery probes preserve a deferred prompt while context is ${contextState}`, async ({ page, mock }) => {
    let reads = 0;
    let finished = false;
    await page.route('**/api/hosts/local/threads/*/context*', route => {
      ++reads;
      return contextState === 'still compacting'
        ? route.fulfill({ json: { compacting: !!mock.request('thread/compact/start') && !finished } })
        : route.fulfill({ status: 503, json: { error: '临时上下文读取失败' } });
    });
    const finish = holdCompaction(mock);
    await login(page);
    await page.locator('[data-section="recent"] .thread-row').first().click();
    await slash(page, 'compact');
    await expect(page.locator('.context-usage')).toContainText('正在压缩');
    const before = reads;
    const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
    await input.fill('等待真正完成再发送');
    await page.getByRole('button', { name: '追加指令', exact: true }).click();
    await expect.poll(() => reads, { timeout: 10000 }).toBeGreaterThan(before + 1);
    await expect(page.locator('.context-usage')).toContainText('正在压缩');
    await expect(page.locator('.compaction-send-note')).toBeVisible();
    await expect(input).toHaveValue('等待真正完成再发送');
    expect(submissions(mock)).toHaveLength(0);
    finished = true;
    finish();
    await expect.poll(() => submissions(mock).length).toBe(1);
    expect(submissions(mock)[0].params.input[0].text).toBe('等待真正完成再发送');
  });
}

test('a dedicated compaction recovers from a native idle context read and submits its deferred prompt exactly once', async ({ page, mock }) => {
  const finish = holdCompaction(mock);
  let finishedOnServer = false;
  const recoveryQueries: string[] = [];
  await page.route('**/api/hosts/local/threads/thread-existing/context*', route => {
    recoveryQueries.push(new URL(route.request().url()).search);
    return route.fulfill({ json: {
      compacting: !!mock.request('thread/compact/start') && !finishedOnServer,
      runtimeStatus: finishedOnServer ? 'idle' : 'active',
      tokenUsage: { last: { totalTokens: finishedOnServer ? 12000 : 80000 }, modelContextWindow: 100000 },
    } });
  });
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await slash(page, 'compact');
  await expect(page.locator('.context-usage')).toContainText('正在压缩');
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('恢复专用压缩后只发送一次');
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await expect(page.locator('.compaction-send-note')).toBeVisible();
  const compactionTurn = mock.turns.get('thread-existing')!.at(-1)!;
  compactionTurn.status = 'completed';
  compactionTurn.items = [{ id: 'held-compaction-item', type: 'contextCompaction' }];
  finishedOnServer = true;
  // The server has completed, but the browser receives no completion event.
  await expect.poll(() => submissions(mock).length, { timeout: 10000 }).toBe(1);
  expect(submissions(mock)[0].method).toBe('turn/start');
  expect(submissions(mock)[0].params.input[0].text).toBe('恢复专用压缩后只发送一次');
  expect(recoveryQueries.some(query => new URLSearchParams(query).get('recoverCompaction') === '1')).toBe(true);
  await expect(page.locator('.context-usage')).not.toContainText('正在压缩');
  await expect(page.locator('.compaction-divider')).toContainText('上下文已压缩');
  await expect(page.locator('.compaction-send-note')).toHaveCount(0);
  await expect(input).toHaveValue('');
  finish();
  await expect(page.getByText('流式回复完成 ✅', { exact: true })).toBeVisible();
  expect(submissions(mock)).toHaveLength(1);
});

test('a delayed old idle context response cannot dismiss a newer compaction in the same running turn', async ({ page, mock }) => {
  mock.holdFinalMessage = true;
  let holdNextRecovery = true;
  let releaseOld!: () => Promise<void>;
  await page.route('**/api/hosts/local/threads/*/context*', async route => {
    if (new URL(route.request().url()).searchParams.has('recoverCompaction') && holdNextRecovery) {
      holdNextRecovery = false;
      await new Promise<void>(resolve => { releaseOld = async () => {
        await route.fulfill({ json: { compacting: false, runtimeStatus: 'idle' } });
        resolve();
      }; });
      return;
    }
    return route.fulfill({ json: { compacting: true } });
  });
  await login(page);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('连续自动压缩的任务');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  const threadId = mock.request('turn/start')!.params.threadId;
  const turn = mock.turns.get(threadId)!.find(turn => turn.status === 'inProgress');
  const first = { id: 'first-compaction', type: 'contextCompaction', status: 'inProgress' };
  turn.items.push(first);
  mock.emit('item/started', { threadId, turnId: turn.id, item: first });
  await expect.poll(() => !!releaseOld, { timeout: 10000 }).toBe(true);
  first.status = 'completed';
  mock.emit('item/completed', { threadId, turnId: turn.id, item: first });
  const second = { id: 'second-compaction', type: 'contextCompaction', status: 'inProgress' };
  turn.items.push(second);
  mock.emit('item/started', { threadId, turnId: turn.id, item: second });
  await expect(page.locator('.compaction-divider').last()).toContainText('正在压缩');
  await input.fill('第二次压缩真正完成后再补充');
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await releaseOld();
  await expect(page.locator('.context-usage')).toContainText('正在压缩');
  await expect(page.locator('.compaction-divider').last()).toContainText('正在压缩');
  await expect(page.locator('.compaction-send-note')).toBeVisible();
  expect(mock.request('turn/steer')).toBeUndefined();
  second.status = 'completed';
  // The next read must agree with the completed event, rather than recreating it.
  await page.unroute('**/api/hosts/local/threads/*/context*');
  await page.route('**/api/hosts/local/threads/*/context*', route => route.fulfill({ json: { compacting: false, runtimeStatus: 'active' } }));
  mock.emit('item/completed', { threadId, turnId: turn.id, item: second });
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/steer').length).toBe(1);
  expect(turn.status).toBe('inProgress');
  expect(mock.request('turn/steer')!.params.input[0].text).toBe('第二次压缩真正完成后再补充');
});

test('a duplicate old completed item cannot clear a newer acknowledged compaction before its item starts', async ({ page, mock }) => {
  let compactRequests = 0;
  let nativeCompacting = false;
  const first = { id: 'already-finished-compaction', status: 'inProgress', items: [
    { id: 'already-finished-compaction-item', type: 'contextCompaction' },
  ] };
  const second = { id: 'acknowledged-next-compaction', status: 'inProgress', items: [
    { id: 'acknowledged-next-compaction-item', type: 'contextCompaction' },
  ] };
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/compact/start') return receive(socket, request);
    mock.requests.push(request);
    nativeCompacting = true;
    if (++compactRequests === 1) {
      mock.turns.get(request.params.threadId)!.push(first);
      mock.emit('turn/started', { threadId: request.params.threadId, turn: first });
      mock.emit('item/started', { threadId: request.params.threadId, turnId: first.id, item: first.items[0] });
    }
    socket.send(JSON.stringify({ id: request.id, result: {} }));
  };
  await page.route('**/api/hosts/local/threads/thread-existing/context*', route => route.fulfill({ json: { compacting: nativeCompacting } }));
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await slash(page, 'compact');
  await expect(page.locator('.context-usage')).toContainText('正在压缩');
  first.status = 'completed';
  nativeCompacting = false;
  mock.emit('item/completed', { threadId: 'thread-existing', turnId: first.id, item: first.items[0] });
  mock.emit('turn/completed', { threadId: 'thread-existing', turn: first });
  await expect(page.locator('.context-usage')).not.toContainText('正在压缩');
  await expect(page.locator('.compaction-divider')).toContainText('上下文已压缩');
  await slash(page, 'compact');
  await expect.poll(() => compactRequests).toBe(2);
  await expect(page.locator('.context-usage')).toContainText('正在压缩');
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('第二次压缩完成后继续');
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await expect(page.locator('.compaction-send-note')).toBeVisible();
  // This is the old, already completed item. The new compaction only has its
  // ACK so far and must not be accidentally matched by a missing itemId.
  mock.emit('item/completed', { threadId: 'thread-existing', turnId: first.id, item: first.items[0] });
  await expect(page.locator('.context-usage')).toContainText('正在压缩');
  await expect(page.locator('.compaction-send-note')).toBeVisible();
  expect(submissions(mock)).toHaveLength(0);
  mock.turns.get('thread-existing')!.push(second);
  mock.emit('turn/started', { threadId: 'thread-existing', turn: second });
  mock.emit('item/started', { threadId: 'thread-existing', turnId: second.id, item: second.items[0] });
  second.status = 'completed';
  nativeCompacting = false;
  mock.emit('item/completed', { threadId: 'thread-existing', turnId: second.id, item: second.items[0] });
  mock.emit('turn/completed', { threadId: 'thread-existing', turn: second });
  await expect.poll(() => submissions(mock).length).toBe(1);
  expect(submissions(mock)[0].method).toBe('turn/start');
  expect(submissions(mock)[0].params.input[0].text).toBe('第二次压缩完成后继续');
  await expect(input).toHaveValue('');
});

for (const status of ['failed', 'interrupted']) test(`a ${status} compaction cancels deferred input and preserves its draft`, async ({ page, mock }) => {
  const finish = holdCompaction(mock);
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await slash(page, 'compact');
  await expect(page.locator('.context-usage')).toContainText('正在压缩');
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('压缩失败不能自动发送');
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  finish(status);
  await expect(page.locator('.compaction-send-note')).toHaveCount(0);
  await expect(input).toHaveValue('压缩失败不能自动发送');
  expect(submissions(mock)).toHaveLength(0);
});

test('navigating away and back cancels deferred input rather than silently sending after compression', async ({ page, mock }) => {
  const finish = holdCompaction(mock);
  const other = { ...mock.threads[0], id: 'thread-other', name: '另一条对话', preview: '另一条对话' };
  mock.threads.push(other);
  mock.turns.set(other.id, []);
  await login(page);
  const recent = page.locator('[data-section="recent"]');
  await recent.locator('.thread-row').filter({ hasText: '已有测试历史' }).click();
  await slash(page, 'compact');
  await expect(page.locator('.context-usage')).toContainText('正在压缩');
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('返回后仍然保留这个草稿');
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await recent.locator('.thread-row').filter({ hasText: '另一条对话' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '另一条对话', exact: true })).toBeVisible();
  finish();
  await recent.locator('.thread-row').filter({ hasText: '已有测试历史' }).click();
  await expect(input).toHaveValue('返回后仍然保留这个草稿');
  expect(submissions(mock)).toHaveLength(0);
});

test('losing the native connection cancels deferred input without clearing its draft', async ({ page, mock }) => {
  const finish = holdCompaction(mock);
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await slash(page, 'compact');
  await expect(page.locator('.context-usage')).toContainText('正在压缩');
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('断线后保留原始草稿');
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  mock.emit('bridge/status', { connected: false });
  await expect(page.locator('.compaction-send-note')).toHaveCount(0);
  await expect(input).toHaveValue('断线后保留原始草稿');
  finish();
  expect(submissions(mock)).toHaveLength(0);
});

test('a busy composer uses the same action slot for text and attachment steering, then Stop when empty', async ({ page, mock }) => {
  mock.holdFinalMessage = true;
  await login(page);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('开始运行任务');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await expect(page.locator('.composer-submit .send-button')).toHaveCount(1);
  await input.fill('追加一条消息');
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '追加指令', exact: true })).toBeEnabled();
  await input.fill('');
  await page.locator('.composer input[type="file"]').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') });
  await expect(page.getByRole('button', { name: '追加指令', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await expect.poll(() => mock.requests.filter(request => request.method === 'turn/steer').length).toBe(1);
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await expect(page.locator('.composer-submit .send-button')).toHaveCount(1);
});
