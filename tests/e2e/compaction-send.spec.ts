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
