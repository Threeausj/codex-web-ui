import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const threadId = 'thread-existing';

function messageTurn(id: string, text: string, status = 'completed') {
  return {
    id,
    status,
    itemsView: 'full',
    error: null,
    startedAt: 1791200020,
    completedAt: status === 'completed' ? 1791200021 : null,
    durationMs: status === 'completed' ? 1000 : null,
    items: [
      {
        id: `${id}-user`,
        type: 'userMessage',
        content: [{ type: 'text', text, text_elements: [] }],
      },
      ...(status === 'completed'
        ? [{ id: `${id}-agent`, type: 'agentMessage', text: `${text}的回复` }]
        : []),
    ],
  };
}

async function openEditor(page: Page, mock: MockCodex) {
  mock.turns.get(threadId)!.push(messageTurn('turn-edit-target', '准备编辑的旧问题'));
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByRole('textbox', { name: '编辑消息内容' }).fill('跨客户端更新时也要保留的草稿');
}

test('a stale page cannot revert a newer completed turn that arrived without notifications', async ({ page, mock }) => {
  await openEditor(page, mock);
  // Another client has changed durable history, but this browser missed its
  // events. Its locally editable message is consequently no longer the tail.
  mock.turns.get(threadId)!.push(messageTurn('turn-other-completed', '其他客户端刚完成的新问题'));

  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();

  await expect(page.locator('.message-edit-error')).toContainText('其他客户端更新');
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveValue('跨客户端更新时也要保留的草稿');
  await expect(page.getByText('其他客户端刚完成的新问题', { exact: true })).toBeVisible();
  expect(mock.request('thread/revert')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
  expect(mock.request('turn/steer')).toBeUndefined();
  expect(mock.turns.get(threadId)!.map(turn => turn.id)).toEqual([
    'turn-history', 'turn-edit-target', 'turn-other-completed',
  ]);
});

test('another client starting a turn during post-revert hydration cannot receive the edited message as steering input', async ({ page, mock }) => {
  await openEditor(page, mock);
  const socket = mock.sockets[0];
  const sendResponse = socket.send.bind(socket);
  let releaseHistory: (() => void) | undefined;

  // Delay only the canonical history reply after a successful revert. Keep
  // live events flowing, including the revert notification and external turn.
  socket.send = message => {
    const response = JSON.parse(message.toString());
    const request = mock.requests.find(request => request.id === response.id);
    if (!releaseHistory && response.id !== undefined &&
        request?.method === 'thread/turns/list' && request.params?.limit === 30 &&
        mock.request('thread/revert')) {
      releaseHistory = () => sendResponse(message);
      return;
    }
    sendResponse(message);
  };

  try {
    await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
    await expect.poll(() => !!releaseHistory).toBe(true);
    expect(mock.turns.get(threadId)!.map(turn => turn.id)).toEqual(['turn-history']);

    const externalTurn = messageTurn('turn-other-running', '其他客户端正在处理的新问题', 'inProgress');
    mock.turns.get(threadId)!.push(externalTurn);
    mock.emit('turn/started', { threadId, turn: externalTurn });
    mock.emit('item/completed', {
      threadId, turnId: externalTurn.id, item: externalTurn.items[0],
    });
    await expect(page.getByText('其他客户端正在处理的新问题', { exact: true })).toBeVisible();
    releaseHistory!();

    await expect(page.locator('.message-edit-error')).toContainText('其他客户端更新');
    await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveValue('跨客户端更新时也要保留的草稿');
    await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toBeEnabled();
    await expect(page.getByText('其他客户端正在处理的新问题', { exact: true })).toBeVisible();
    expect(mock.requests.filter(request => request.method === 'thread/revert')).toHaveLength(1);
    expect(mock.request('turn/start')).toBeUndefined();
    expect(mock.request('turn/steer')).toBeUndefined();
    expect(mock.turns.get(threadId)!.map(turn => turn.id)).toEqual(['turn-history', externalTurn.id]);
  } finally {
    socket.send = sendResponse;
  }
});

test('retry after a failed replacement checks for newer durable history without reverting again', async ({ page, mock }) => {
  await openEditor(page, mock);
  mock.failTurnStartNext = true;

  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(page.locator('.message-edit-error')).toContainText('Test turn start failed');
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveValue('跨客户端更新时也要保留的草稿');
  expect(mock.turns.get(threadId)!.map(turn => turn.id)).toEqual(['turn-history']);

  // The edit's revert was confirmed, but another client added a new turn
  // before retry. No event updates the browser's cached prefix.
  mock.turns.get(threadId)!.push(messageTurn('turn-before-retry', '其他客户端在重试前完成的新问题'));
  await page.getByRole('button', { name: '保存并重新发送', exact: true }).click();

  await expect(page.locator('.message-edit-error')).toContainText('其他客户端更新');
  await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveValue('跨客户端更新时也要保留的草稿');
  await expect(page.getByText('其他客户端在重试前完成的新问题', { exact: true })).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'thread/revert')).toHaveLength(1);
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  expect(mock.request('turn/steer')).toBeUndefined();
  expect(mock.turns.get(threadId)!.map(turn => turn.id)).toEqual(['turn-history', 'turn-before-retry']);
});
