import { test, expect, login, send, type MockCodex } from './fixtures';

function appendEditableTurn(mock: MockCodex, withImage = false) {
  const turn = {
    id: 'turn-latest',
    status: 'completed',
    itemsView: 'full',
    error: null,
    startedAt: 1791200010,
    completedAt: 1791200011,
    durationMs: 1000,
    items: [
      {
        id: 'latest-user',
        type: 'userMessage',
        content: [
          { type: 'text', text: '最近一条问题', text_elements: [] },
          ...(withImage ? [{ type: 'localImage', path: '/workspace/demo/reference.png' }] : []),
        ],
      },
      { id: 'latest-agent', type: 'agentMessage', text: '待替换的上一轮回复' },
    ],
  };
  mock.turns.get('thread-existing')!.push(turn);
  return turn;
}

async function selectHistory(page: Parameters<typeof login>[0]) {
  await login(page);
  if ((page.viewportSize()?.width || 1280) <= 760)
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(1);
}

test('only the latest message has a pencil; cancel preserves history, composer draft and attachments', async ({ page, mock }) => {
  appendEditableTurn(mock);
  await selectHistory(page);
  await expect(page.getByRole('button', { name: '复制消息', exact: true })).toHaveCount(2);
  const composer = page.getByRole('textbox', { name: '消息输入框' });
  await composer.fill('尚未发送的草稿');
  await page.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('draft attachment') });
  await expect(page.locator('.attachment')).toHaveCount(2);
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑消息内容' });
  await expect(editor).toHaveValue('最近一条问题');
  await expect(page.getByText('重新发送会替换本轮回复，已执行的文件修改不会撤销。', { exact: true })).toBeVisible();
  await editor.fill('取消的改动');
  await page.locator('.message-editor').getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('最近一条问题', { exact: true })).toBeVisible();
  await expect(page.getByText('待替换的上一轮回复', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('尚未发送的草稿');
  await expect(page.locator('.attachment')).toHaveCount(2);
  expect(mock.request('thread/revert')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('saving replaces the latest turn in the same thread and survives reload while preserving earlier history and image input', async ({ page, mock }) => {
  appendEditableTurn(mock, true);
  await selectHistory(page);
  const composer = page.getByRole('textbox', { name: '消息输入框' });
  await composer.fill('下一条消息草稿');
  await page.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('next attachment') });
  await expect(page.locator('.attachment')).toHaveCount(2);
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByRole('textbox', { name: '编辑消息内容' }).fill('修改后的问题\n第二行补充');
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveCount(0);
  await expect(page.getByText('修改后的问题\n第二行补充', { exact: true })).toBeVisible();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(page.getByText('流式回复完成 ✅', { exact: true })).toBeVisible();
  await expect(page.getByText('待替换的上一轮回复', { exact: true })).toHaveCount(0);
  await expect(page.locator('.user-message')).toHaveCount(2);
  await expect(composer).toHaveValue('下一条消息草稿');
  await expect(page.locator('.attachment')).toHaveCount(2);
  expect(mock.request('thread/revert')?.params).toEqual({ threadId: 'thread-existing', beforeTurnId: 'turn-latest' });
  expect(mock.request('turn/start')?.params.threadId).toBe('thread-existing');
  expect(mock.request('turn/start')?.params.input).toContainEqual({ type: 'localImage', path: '/workspace/demo/reference.png' });
  expect(mock.request('thread/start')).toBeUndefined();
  await page.reload();
  await expect(page.getByText('修改后的问题\n第二行补充', { exact: true })).toBeVisible();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(page.getByText('待替换的上一轮回复', { exact: true })).toHaveCount(0);
});

test('revert failures leave the original answer and editable draft available for retry', async ({ page, mock }) => {
  appendEditableTurn(mock);
  await selectHistory(page);
  mock.failRevertNext = true;
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑消息内容' });
  await editor.fill('失败后保留的编辑');
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(page.locator('.message-edit-error')).toContainText('Test revert failed');
  await expect(editor).toHaveValue('失败后保留的编辑');
  await expect(editor).toBeEnabled();
  await expect(page.getByText('待替换的上一轮回复', { exact: true })).toBeVisible();
  expect(mock.request('turn/start')).toBeUndefined();
  expect(mock.turns.get('thread-existing')).toHaveLength(2);
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('失败后保留的编辑', { exact: true })).toBeVisible();
  await expect(page.getByText('待替换的上一轮回复', { exact: true })).toHaveCount(0);
});

test('a failed replacement retains the editor after revert; retry never removes another older turn', async ({ page, mock }) => {
  appendEditableTurn(mock);
  await selectHistory(page);
  mock.failTurnStartNext = true;
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑消息内容' });
  await editor.fill('回退成功但发送失败的内容');
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(page.locator('.message-edit-error')).toContainText('Test turn start failed');
  await expect(editor).toHaveValue('回退成功但发送失败的内容');
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(page.getByText('待替换的上一轮回复', { exact: true })).toHaveCount(0);
  expect(mock.turns.get('thread-existing')).toHaveLength(1);
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('回退成功但发送失败的内容', { exact: true })).toBeVisible();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  expect(mock.requests.filter((request) => request.method === 'thread/revert')).toHaveLength(1);
  expect(mock.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
  expect(mock.turns.get('thread-existing')).toHaveLength(2);
});

test('a failed history read after revert can be retried without reverting an earlier turn', async ({ page, mock }) => {
  appendEditableTurn(mock);
  await selectHistory(page);
  mock.holdRevertResponse = true;
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑消息内容' });
  await editor.fill('读取恢复后重新发送');
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect.poll(() => mock.requests.filter(request => request.method === 'thread/revert').length).toBe(1);
  mock.failHistoryNext = true;
  mock.releaseRevertResponse();
  await expect(page.locator('.message-edit-error')).toContainText('Test history read failed');
  await expect(editor).toHaveValue('读取恢复后重新发送');
  expect(mock.request('turn/start')).toBeUndefined();
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(page.getByText('读取恢复后重新发送', { exact: true })).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'thread/revert')).toHaveLength(1);
});

test('a revert from another client refreshes canonical history without generating a new turn', async ({ page, mock }) => {
  appendEditableTurn(mock);
  await selectHistory(page);
  mock.turns.set('thread-existing', mock.turns.get('thread-existing')!.slice(0, 1));
  mock.emit('thread/reverted', { threadId: 'thread-existing' });
  await expect(page.getByText('待替换的上一轮回复', { exact: true })).toHaveCount(0);
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('revert in flight blocks duplicate saves and cancellation', async ({ page, mock }) => {
  appendEditableTurn(mock);
  await selectHistory(page);
  mock.holdRevertResponse = true;
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑消息内容' });
  await editor.fill('只发送一次');
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect.poll(() => mock.requests.filter((request) => request.method === 'thread/revert').length).toBe(1);
  await expect(editor).toBeDisabled();
  await expect(page.getByRole('button', { name: '正在重新发送…', exact: true })).toBeDisabled();
  await expect(page.locator('.message-editor').getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await editor.press('Control+Enter');
  expect(mock.requests.filter((request) => request.method === 'thread/revert')).toHaveLength(1);
  mock.releaseRevertResponse();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('只发送一次', { exact: true })).toBeVisible();
  expect(mock.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
});

test('cancel after a failed replacement leaves canonical earlier history and permits a normal next message', async ({ page, mock }) => {
  appendEditableTurn(mock);
  await selectHistory(page);
  mock.failTurnStartNext = true;
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByRole('textbox', { name: '编辑消息内容' }).fill('不再重试的编辑');
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(page.locator('.message-edit-error')).toContainText('Test turn start failed');
  await page.locator('.message-editor').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveCount(0);
  await expect(page.getByText('待替换的上一轮回复', { exact: true })).toHaveCount(0);
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await send(page, '取消编辑后正常继续');
  await expect(page.getByText('流式回复完成 ✅', { exact: true })).toBeVisible();
  expect(mock.request('turn/start')?.params.threadId).toBe('thread-existing');
  expect(mock.requests.filter((request) => request.method === 'thread/revert')).toHaveLength(1);
  expect(mock.turns.get('thread-existing')).toHaveLength(2);
});

test('a user message without an authoritative turn cannot offer a destructive edit', async ({ page, mock }) => {
  await selectHistory(page);
  mock.emit('item/completed', {
    threadId: 'thread-existing',
    item: { id: 'orphan-user', type: 'userMessage', content: [{ type: 'text', text: '没有轮次元数据的消息', text_elements: [] }] },
  });
  await expect(page.getByText('没有轮次元数据的消息', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(0);
  expect(mock.request('thread/revert')).toBeUndefined();
});

test('running and steered multiple-input turns offer no edit action', async ({ page, mock }) => {
  mock.holdFinalMessage = true;
  await login(page);
  await send(page, '运行中不要回退');
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('运行中追加的输入');
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await expect.poll(() => mock.request('turn/steer')?.params.input[0].text).toBe('运行中追加的输入');
  mock.finishStream();
  await expect(page.getByText('流式回复完成 ✅', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(0);
  expect(mock.request('thread/revert')).toBeUndefined();
});

test('the message editor fits an Android-sized viewport and keeps multiline text', async ({ page, mock }) => {
  appendEditableTurn(mock);
  await page.setViewportSize({ width: 390, height: 844 });
  await selectHistory(page);
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑消息内容' });
  await editor.fill('手机编辑');
  await editor.press('End');
  await editor.press('Enter');
  await editor.type('保留换行');
  await expect(editor).toHaveValue('手机编辑\n保留换行');
  await expect(page.getByRole('button', { name: '保存并重新发送', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await editor.press('Escape');
  await expect(editor).toHaveCount(0);
  expect(mock.request('thread/revert')).toBeUndefined();
});
