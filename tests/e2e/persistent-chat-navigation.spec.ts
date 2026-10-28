import { test, expect, login, MockCodex } from './fixtures';
import type { Page, WebSocketRoute } from '@playwright/test';

function addConversation(mock: MockCodex, id: string, name: string, text: string) {
  mock.threads.push({ ...mock.threads[0], id, name, preview: name });
  mock.turns.set(id, [{ id: `${id}-turn`, status: 'completed', itemsView: 'full',
    items: [{ id: `${id}-answer`, type: 'agentMessage', text }] }]);
}
function addRemote(mock: MockCodex, id = 'remote') {
  const remote = new MockCodex();
  remote.threads[0] = { ...remote.threads[0], name: `${id} first`, cwd: `/srv/${id}` };
  remote.turns.get('thread-existing')![0].items[1].text = `${id} first answer`;
  addConversation(remote, `${id}-second`, `${id} second`, `${id} second answer`);
  addConversation(remote, `${id}-third`, `${id} third`, `${id} third answer`);
  mock.hosts.push({ id, name: id, kind: 'ssh', hostname: `${id}.invalid`, cwd: `/srv/${id}` });
  mock.hostMocks.set(id, remote);
  return remote;
}
function row(page: Page, hostId: string, name: string) {
  return page.locator(`[data-section="recent"] [data-host-id="${hostId}"] .thread-row`).filter({ hasText: name });
}
async function shown(page: Page, name: string, answer: string) {
  await expect(page.locator('.main-header h1')).toHaveText(name);
  await expect(page.locator('.agent-message').last()).toHaveText(answer);
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  await expect(page.locator('.global-error')).toHaveCount(0);
}
async function trackDisconnectNotices(page: Page) {
  await page.evaluate(() => {
    (window as any).__navigationDisconnectNotices = [];
    new MutationObserver(() => {
      for (const banner of document.querySelectorAll('.connection-banner')) {
        const text = banner.textContent || '';
        if (text.includes('App Server 已断开')) (window as any).__navigationDisconnectNotices.push(text);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}
async function holdHandshake(page: Page, hostId: string, remote: MockCodex) {
  const sockets: WebSocketRoute[] = [];
  const closed: WebSocketRoute[] = [];
  await page.routeWebSocket(url => url.pathname === '/api/rpc' && url.searchParams.get('host') === hostId, socket => {
    sockets.push(socket);
    remote.sockets.push(socket);
    socket.onMessage(raw => (remote as any).receive(socket, JSON.parse(raw.toString())));
    socket.onClose(() => { closed.push(socket); });
  });
  return { sockets, closed, release() {
    for (const socket of sockets) if (!closed.includes(socket)) socket.send(JSON.stringify({ method: 'bridge/status',
      params: { connected: true, activeProcesses: [], pendingRequests: [], hostId, mode: 'spawn' } }));
  } };
}

test('same-host conversation navigation retains one healthy socket, live output and drafts', async ({ page, mock }) => {
  addConversation(mock, 'second-local', 'Second local', 'Second local answer');
  await login(page);
  await row(page, 'local', '已有测试历史').click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('Local draft must survive');
  await trackDisconnectNotices(page);
  await row(page, 'local', 'Second local').click();
  await shown(page, 'Second local', 'Second local answer');
  await row(page, 'local', '已有测试历史').click();
  await shown(page, '已有测试历史', '历史保持可读');
  await expect(input).toHaveValue('Local draft must survive');
  mock.emit('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'turn-history', itemId: 'history-agent', delta: ' continued live' });
  await expect(page.locator('.agent-message').last()).toHaveText('历史保持可读 continued live');
  expect(mock.sockets).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).__navigationDisconnectNotices)).toEqual([]);
  expect(mock.requests.filter(request => ['turn/start', 'turn/interrupt', 'thread/unsubscribe', 'command/exec/terminate'].includes(request.method || ''))).toEqual([]);
});

test('rapid choices during one destination handshake share the connection and keep only the latest conversation', async ({ page, mock }) => {
  const remote = addRemote(mock);
  const connection = await holdHandshake(page, 'remote', remote);
  await login(page);
  await trackDisconnectNotices(page);
  await row(page, 'remote', 'remote first').click();
  await expect(page.locator('.connection-banner')).toContainText('正在连接目标主机');
  await row(page, 'remote', 'remote second').click();
  await row(page, 'remote', 'remote third').click();
  expect(connection.sockets).toHaveLength(1);
  expect(connection.closed).toEqual([]);
  connection.release();
  await shown(page, 'remote third', 'remote third answer');
  expect(remote.requests.filter(request => request.method === 'thread/resume').map(request => request.params.threadId)).toEqual(['remote-third']);
  expect(await page.evaluate(() => (window as any).__navigationDisconnectNotices)).toEqual([]);
  expect(remote.request('turn/start')).toBeUndefined();
});

test('selecting another conversation during destination configuration keeps its socket and rejects the older selection', async ({ page, mock }) => {
  const remote = addRemote(mock);
  remote.holdConfigReadResponse = true;
  await login(page);
  await row(page, 'remote', 'remote first').click();
  await expect.poll(() => remote.requests.filter(request => request.method === 'config/read').length).toBe(1);
  await row(page, 'remote', 'remote second').click();
  await row(page, 'remote', 'remote third').click();
  expect(remote.sockets).toHaveLength(1);
  remote.releaseConfigReadResponse();
  await shown(page, 'remote third', 'remote third answer');
  expect(remote.requests.filter(request => request.method === 'thread/resume').map(request => request.params.threadId)).toEqual(['remote-third']);
  expect(remote.requests.filter(request => request.method === 'config/read')).toHaveLength(1);
});

test('a parked destination handshake cannot replace a newer host and remains reusable on return', async ({ page, mock }) => {
  const remote = addRemote(mock), other = addRemote(mock, 'other');
  const connection = await holdHandshake(page, 'remote', remote);
  await login(page);
  await row(page, 'remote', 'remote first').click();
  await row(page, 'remote', 'remote second').click();
  await row(page, 'other', 'other third').click();
  await shown(page, 'other third', 'other third answer');
  expect(connection.closed).toEqual([]);
  connection.release();
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'other');
  await shown(page, 'other third', 'other third answer');
  expect(remote.request('thread/resume')).toBeUndefined();
  expect(other.sockets).toHaveLength(1);
  await row(page, 'remote', 'remote second').click();
  await shown(page, 'remote second', 'remote second answer');
  expect(connection.sockets).toHaveLength(1);
  expect(connection.closed).toEqual([]);
});

test('a real disconnected transport still shows the retry notice and restores the selected conversation', async ({ page, mock }) => {
  await login(page);
  await row(page, 'local', '已有测试历史').click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('Do not submit while reconnecting');
  await mock.sockets[0]!.close({ code: 1011, reason: 'Synthetic transport outage' });
  await expect(page.locator('.connection-banner')).toContainText('App Server 已断开，正在尝试重连');
  await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2);
  await shown(page, '已有测试历史', '历史保持可读');
  await expect(input).toHaveValue('Do not submit while reconnecting');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('same-host choices share an automatic recovery handshake without closing it or resubmitting drafts', async ({ page, mock }) => {
  addConversation(mock, 'second-local', 'Second local', 'Second local answer');
  addConversation(mock, 'third-local', 'Third local', 'Third local answer');
  await login(page);
  await row(page, 'local', '已有测试历史').click();
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('Recover draft only');
  const connection = await holdHandshake(page, 'local', mock);
  await mock.sockets[0]!.close({ code: 1011, reason: 'Recoverable outage' });
  await expect.poll(() => connection.sockets.length, { timeout: 12000 }).toBe(1);
  await row(page, 'local', 'Second local').click();
  await row(page, 'local', 'Third local').click();
  expect(connection.sockets).toHaveLength(1);
  expect(connection.closed).toEqual([]);
  connection.release();
  await shown(page, 'Third local', 'Third local answer');
  await row(page, 'local', '已有测试历史').click();
  await shown(page, '已有测试历史', '历史保持可读');
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('Recover draft only');
  expect(mock.sockets).toHaveLength(2);
  expect(connection.closed).toEqual([]);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a late configuration from a retired destination cannot overwrite a newer host selection', async ({ page, mock }) => {
  const remote = addRemote(mock), other = addRemote(mock, 'other');
  remote.holdConfigReadResponse = true;
  remote.config.model_reasoning_effort = 'high';
  await login(page);
  await row(page, 'remote', 'remote first').click();
  await expect.poll(() => !!remote.request('config/read')).toBe(true);
  await row(page, 'remote', 'remote second').click();
  await row(page, 'other', 'other third').click();
  await shown(page, 'other third', 'other third answer');
  remote.releaseConfigReadResponse();
  await expect(page.locator('.main-header')).toHaveAttribute('data-host-id', 'other');
  await shown(page, 'other third', 'other third answer');
  expect(other.sockets).toHaveLength(1);
  expect(remote.request('thread/resume')).toBeUndefined();
});

test('an inactive destination handshake failure cannot publish an error over the currently selected host', async ({ page, mock }) => {
  const remote = addRemote(mock), other = addRemote(mock, 'other');
  const connection = await holdHandshake(page, 'remote', remote);
  await login(page);
  await row(page, 'remote', 'remote first').click();
  await row(page, 'remote', 'remote second').click();
  await row(page, 'other', 'other third').click();
  await shown(page, 'other third', 'other third answer');
  connection.sockets[0]!.send(JSON.stringify({ method: 'bridge/status', params: { hostId: 'remote', connected: false, error: '后台主机握手失败不得进入当前聊天' } }));
  await expect.poll(() => connection.closed.length).toBe(1);
  await shown(page, 'other third', 'other third answer');
  await expect(page.getByText('后台主机握手失败不得进入当前聊天', { exact: true })).toHaveCount(0);
  expect(other.sockets).toHaveLength(1);
  expect(remote.request('thread/resume')).toBeUndefined();
});
