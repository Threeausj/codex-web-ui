import { test, expect, login, type MockCodex } from './fixtures';
import type { Page, BrowserContext } from '@playwright/test';

const threadId = 'thread-existing';
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];

async function twoPages(page: Page, context: BrowserContext, mock: MockCodex) {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  const other = await context.newPage();
  await mock.install(other);
  await other.goto('/');
  await expect(other.getByText('历史保持可读', { exact: true })).toBeVisible();
  await other.getByRole('textbox', { name: '消息输入框', exact: true }).fill('其他网页未发送的草稿');
  return other;
}

function change(mock: MockCodex, params: any) {
  mock.sockets.at(-1)!.send(JSON.stringify({ method: 'bridge/thread/changed', params }));
}

test('native started items reach both pages; a late response snapshot preserves the completed answer without duplicate deltas', async ({ page, context, mock }) => {
  const other = await twoPages(page, context, mock);
  const user = { id: 'remote-user', clientId: 'remote-client-user', type: 'userMessage', content: input('另一网页提交的问题') };
  const turn = { id: 'remote-turn', status: 'inProgress', items: [user] };
  mock.turns.get(threadId)!.push(turn);
  mock.emit('turn/started', { threadId, turn });
  for (const target of [page, other]) await expect(target.getByText('另一网页提交的问题', { exact: true })).toBeVisible();
  mock.emit('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: 'remote-agent', delta: '完整回复' });
  mock.emit('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: 'remote-agent', delta: '只出现一次' });
  const completed = { ...turn, status: 'completed', items: [user, { id: 'remote-agent', type: 'agentMessage', text: '完整回复只出现一次' }] };
  mock.turns.get(threadId)![mock.turns.get(threadId)!.length - 1] = completed;
  mock.emit('turn/completed', { threadId, turn: completed });
  change(mock, { threadId, method: 'turn/start', changeId: 'web:10',
    result: { turn: { ...turn, items: [user, { id: 'remote-agent', type: 'agentMessage', text: '完整' }] } },
    request: { input: user.content, clientUserMessageId: user.clientId },
  });
  await expect(other.locator('.agent-message').last()).toContainText('完整回复只出现一次');
  await expect(other.getByText('另一网页提交的问题', { exact: true })).toHaveCount(1);
  await expect(other.getByRole('button', { name: '停止运行', exact: true })).toHaveCount(0);
  await expect(other.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(other.getByRole('textbox', { name: '消息输入框' })).toHaveValue('其他网页未发送的草稿');
  expect(mock.request('turn/start')).toBeUndefined();
  expect(mock.request('turn/steer')).toBeUndefined();
  await other.close();
});

test('response-only starts and steering show accepted user messages; official client aliases deduplicate and drafts stay local', async ({ page, context, mock }) => {
  const other = await twoPages(page, context, mock);
  mock.sockets.at(-1)!.send(JSON.stringify({ method: 'item/agentMessage/delta', params: {
    threadId, turnId: 'response-only-turn', itemId: 'response-only-agent', delta: '先于确认到达的回复delta',
  } }));
  const turn = { id: 'response-only-turn', status: 'inProgress', items: [
    { id: 'start-canonical', clientId: 'start-client', type: 'userMessage', content: input('只在确认响应里的问题') },
  ] };
  change(mock, { threadId, method: 'turn/start', changeId: 'web:11', result: { turn },
    request: { input: input('只在确认响应里的问题'), clientUserMessageId: 'start-client' },
  });
  await expect(other.getByText('只在确认响应里的问题', { exact: true })).toBeVisible();
  const sequence = await other.locator('.message').evaluateAll(elements => elements.map(element => element.textContent || ''));
  expect(sequence.findIndex(text => text.includes('只在确认响应里的问题')))
    .toBeLessThan(sequence.findIndex(text => text.includes('先于确认到达的回复delta')));
  await expect(other.getByText('先于确认到达的回复delta', { exact: true })).toBeVisible();
  const steer = { threadId, method: 'turn/steer', changeId: 'web:12', result: { turnId: turn.id },
    request: { input: input('响应确认后的追加要求'), clientUserMessageId: 'steer-client' },
  };
  change(mock, steer);
  change(mock, steer);
  await expect(other.getByText('响应确认后的追加要求', { exact: true })).toHaveCount(1);
  mock.emit('item/completed', { threadId, turnId: turn.id, item: {
    id: 'steer-canonical', clientId: 'steer-client', type: 'userMessage', content: input('响应确认后的追加要求'),
  } });
  await expect(other.getByText('响应确认后的追加要求', { exact: true })).toHaveCount(1);
  await expect(other.getByRole('textbox', { name: '消息输入框' })).toHaveValue('其他网页未发送的草稿');
  expect(mock.request('turn/start')).toBeUndefined();
  expect(mock.request('turn/steer')).toBeUndefined();
  await other.close();
});

test('canonical rename and revert refresh the observing page and late discarded-turn events cannot revive removed history', async ({ page, context, mock }) => {
  const removed = { id: 'removed-turn', status: 'completed', items: [
    { id: 'removed-user', type: 'userMessage', content: input('另一网页将编辑的问题') },
    { id: 'removed-agent', type: 'agentMessage', text: '应该移除的旧回复' },
  ] };
  mock.turns.get(threadId)!.push(removed);
  const other = await twoPages(page, context, mock);
  await expect(other.getByText('应该移除的旧回复', { exact: true })).toBeVisible();
  mock.threads[0].name = '其他网页修改后的名称';
  change(mock, { threadId, method: 'thread/name/set', changeId: 'web:13', result: {}, request: { name: mock.threads[0].name } });
  await expect(other.locator('.main-header')).toContainText('其他网页修改后的名称');
  mock.turns.set(threadId, mock.turns.get(threadId)!.filter(turn => turn.id !== removed.id));
  // Native Codex emits this before replying, and the reply never includes its
  // retained turns. The browser must retain old IDs until it reads real history.
  mock.sockets.at(-1)!.send(JSON.stringify({ method: 'thread/reverted', params: { threadId } }));
  change(mock, { threadId, method: 'thread/revert', changeId: 'web:14', result: { thread: { ...mock.threads[0], turns: [] } }, request: { beforeTurnId: removed.id } });
  await expect(other.getByText('应该移除的旧回复', { exact: true })).toHaveCount(0);
  await expect(other.getByText('历史保持可读', { exact: true })).toBeVisible();
  // Delayed native completion and deltas from the reverted turn are stale.
  const send = mock.sockets.at(-1)!.send.bind(mock.sockets.at(-1)!);
  send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: removed } }));
  send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId: removed.id, itemId: 'removed-agent', delta: '过期回复不能重现' } }));
  await expect(other.getByText('应该移除的旧回复', { exact: true })).toHaveCount(0);
  await expect(other.getByText('过期回复不能重现', { exact: true })).toHaveCount(0);
  await expect(other.getByRole('textbox', { name: '消息输入框' })).toHaveValue('其他网页未发送的草稿');
  expect(mock.request('turn/start')).toBeUndefined();
  await other.close();
});

test('change IDs may be reused after reconnect while the draft and selected thread remain intact', async ({ page, mock }) => {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const draft = page.getByRole('textbox', { name: '消息输入框' });
  await draft.fill('断线重连也保留草稿');
  mock.threads[0].name = '断线前的名称';
  change(mock, { threadId, method: 'thread/name/set', changeId: 'web:1', result: {}, request: { name: mock.threads[0].name } });
  await expect(page.locator('.main-header')).toContainText('断线前的名称');
  await mock.sockets[0]!.close({ code: 4003, reason: 'Reconnect fixture' });
  await expect.poll(() => mock.sockets.length, { timeout: 12_000 }).toBe(2);
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  change(mock, { threadId, method: 'thread/name/set', changeId: 'web:1', result: {}, request: { name: '新连接复用编号后的名称' } });
  await expect(page.locator('.main-header')).toContainText('新连接复用编号后的名称');
  await expect(draft).toHaveValue('断线重连也保留草稿');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a revert on an inactive cached conversation discards its old events without replacing the currently selected chat', async ({ page, context, mock }) => {
  const removed = { id: 'inactive-removed-turn', status: 'completed', items: [
    { id: 'inactive-old-answer', type: 'agentMessage', text: '缓存里待回退的旧回复' },
  ] };
  mock.turns.get(threadId)!.push(removed);
  mock.threads.push({ ...mock.threads[0], id: 'other-view', name: '当前保持的另一个对话' });
  mock.turns.set('other-view', [{ id: 'other-turn', status: 'completed', items: [{ id: 'other-content', type: 'agentMessage', text: '当前视图不会跳走' }] }]);
  const other = await twoPages(page, context, mock);
  await other.locator('[data-section="recent"] .thread-row').filter({ hasText: '当前保持的另一个对话' }).click();
  await expect(other.getByText('当前视图不会跳走', { exact: true })).toBeVisible();
  mock.turns.set(threadId, mock.turns.get(threadId)!.filter(turn => turn.id !== removed.id));
  const socket = mock.sockets.at(-1)!;
  socket.send(JSON.stringify({ method: 'thread/reverted', params: { threadId } }));
  change(mock, { threadId, method: 'thread/revert', changeId: 'web:20', result: { thread: { ...mock.threads[0], turns: [] } }, request: { beforeTurnId: removed.id } });
  socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId: removed.id, itemId: 'inactive-old-answer', delta: '缓存中过期事件' } }));
  await expect(other.getByText('当前视图不会跳走', { exact: true })).toBeVisible();
  await other.locator('[data-section="recent"] .thread-row').filter({ hasText: mock.threads[0].name }).click();
  await expect(other.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect(other.getByText('缓存里待回退的旧回复', { exact: true })).toHaveCount(0);
  await expect(other.getByText('缓存中过期事件', { exact: true })).toHaveCount(0);
  await expect(other.getByRole('textbox', { name: '消息输入框' })).toHaveValue('其他网页未发送的草稿');
  expect(mock.request('turn/start')).toBeUndefined();
  await other.close();
});
