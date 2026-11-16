import { test, expect, login, MockCodex } from './fixtures';
import type { Page, WebSocketRoute } from '@playwright/test';

const input = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const send = (page: Page) => page.getByRole('button', { name: '发送消息', exact: true });
const row = (page: Page, hostId: string, name: string) => page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"] .thread-row`).filter({ hasText: name }).first();
const hostId = 'typing-remote';
const remotePath = '/srv/typing-app';
function setup(mock: MockCodex) {
  const remote = new MockCodex();
  remote.threads[0]!.name = remote.threads[0]!.preview = '远端加载中的会话';
  remote.threads[0]!.cwd = remotePath;
  mock.hosts.push({ id: hostId, name: '输入测试远端', kind: 'ssh', cwd: '/srv' });
  mock.projects.push({ id: 'typing-project', name: '输入测试项目', path: remotePath, hostId, source: 'web' });
  mock.hostMocks.set(hostId, remote);
  return remote;
}
function holdResume(mock: MockCodex, threadId: string) {
  const receive = (mock as any).receive.bind(mock);
  const held: { socket: WebSocketRoute; request: any }[] = [];
  (mock as any).receive = (socket: WebSocketRoute, request: any) => {
    if (request.method === 'thread/resume' && request.params.threadId === threadId) { held.push({ socket, request }); return; }
    return receive(socket, request);
  };
  return { held, release() { for (const entry of held.splice(0)) receive(entry.socket, entry.request); } };
}
async function noSubmission(page: Page, ...mocks: MockCodex[]) {
  await expect(send(page)).toBeDisabled();
  await input(page).press('Enter');
  for (const mock of mocks) {
    expect(mock.request('turn/start')).toBeUndefined();
    expect(mock.request('turn/steer')).toBeUndefined();
  }
}
for (const mobile of [false, true]) test(`${mobile ? 'mobile' : 'desktop'} can keep typing while a new host loads its final project without overwriting the draft`, async ({ page, mock }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const remote = setup(mock); remote.holdConfigReadResponse = true;
  await login(page);
  await input(page).fill('原有任务草稿');
  await page.getByRole('combobox', { name: '新对话主机', exact: true }).selectOption(hostId);
  await expect.poll(() => remote.request('config/read')?.method).toBe('config/read');
  await expect(page.getByRole('combobox', { name: '新对话项目', exact: true })).toHaveValue(remotePath);
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('原有任务草稿');
  await input(page).fill('原有任务草稿，连接期间继续编写');
  await noSubmission(page, mock, remote);
  remote.releaseConfigReadResponse();
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('原有任务草稿，连接期间继续编写');
  await send(page).click();
  await expect.poll(() => remote.request('turn/start')?.params.cwd).toBe(remotePath);
  expect(remote.request('turn/start')?.params.input[0].text).toBe('原有任务草稿，连接期间继续编写');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('same-host project loading preserves typing after transferring the new-chat draft', async ({ page, mock }) => {
  mock.projects.push({ id: 'other', name: '另一个项目', hostId: 'local', path: '/workspace/other', source: 'web' });
  await login(page); await input(page).fill('切项目前的草稿');
  mock.holdConfigReadResponse = true;
  await page.getByRole('combobox', { name: '新对话项目', exact: true }).selectOption('/workspace/other');
  await expect(page.getByRole('combobox', { name: '新对话项目', exact: true })).toBeDisabled();
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('切项目前的草稿');
  await input(page).fill('等待项目加载时的新内容');
  await noSubmission(page, mock);
  mock.releaseConfigReadResponse();
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('等待项目加载时的新内容');
  await send(page).click();
  await expect.poll(() => mock.request('turn/start')?.params.cwd).toBe('/workspace/other');
  expect(mock.request('turn/start')?.params.input[0].text).toBe('等待项目加载时的新内容');
});

test('opening a sidebar project on another host binds text to that project before its config response', async ({ page, mock }) => {
  const remote = setup(mock); remote.holdConfigReadResponse = true;
  await login(page);
  await row(page, 'local', '已有测试历史').click();
  await input(page).fill('本机会话保留的文字');
  await page.locator('.nav-project-group[data-project-path="/srv/typing-app"] .project-row').click();
  await expect.poll(() => remote.request('config/read')?.method).toBe('config/read');
  await expect(page.getByRole('combobox', { name: '新对话项目', exact: true })).toHaveValue(remotePath);
  await expect(input(page)).toBeEnabled();
  await input(page).fill('远端项目正在加载也能写');
  await noSubmission(page, mock, remote);
  remote.releaseConfigReadResponse();
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('远端项目正在加载也能写');
  await send(page).click();
  await expect.poll(() => remote.request('turn/start')?.params.cwd).toBe(remotePath);
  expect(remote.request('turn/start')?.params.input[0].text).toBe('远端项目正在加载也能写');
  await row(page, 'local', '已有测试历史').click();
  await expect(input(page)).toHaveValue('本机会话保留的文字');
});

test('a destination chat accepts text before the first host handshake and keeps its own draft after resume', async ({ page, mock }) => {
  const remote = setup(mock), sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(url => url.pathname === '/api/rpc' && url.searchParams.get('host') === hostId, socket => {
    sockets.push(socket); remote.sockets.push(socket);
    socket.onMessage(raw => (remote as any).receive(socket, JSON.parse(raw.toString())));
  });
  await login(page);
  await row(page, 'local', '已有测试历史').click();
  await input(page).fill('本机独立草稿');
  await row(page, hostId, '远端加载中的会话').click();
  await expect.poll(() => sockets.length).toBe(1);
  await expect(input(page)).toBeEnabled();
  await input(page).fill('握手前写好的远端问题');
  await noSubmission(page, mock, remote);
  sockets[0]!.send(JSON.stringify({ method: 'bridge/status', params: { connected: true, activeProcesses: [], pendingRequests: [], hostId, mode: 'spawn' } }));
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('握手前写好的远端问题');
  await row(page, 'local', '已有测试历史').click();
  await expect(input(page)).toHaveValue('本机独立草稿');
  await row(page, hostId, '远端加载中的会话').click();
  await expect(input(page)).toHaveValue('握手前写好的远端问题');
  await send(page).click();
  await expect.poll(() => remote.request('turn/start')?.params.threadId).toBe('thread-existing');
  expect(remote.request('turn/start')?.params.input[0].text).toBe('握手前写好的远端问题');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('rapid chat changes keep newly typed drafts separate and ignore late history responses', async ({ page, mock }) => {
  mock.threads.push({ ...mock.threads[0]!, id: 'waiting-thread', name: '等待恢复的聊天', preview: '等待恢复的聊天' });
  mock.turns.set('waiting-thread', []);
  const held = holdResume(mock, 'waiting-thread');
  await login(page); await row(page, 'local', '已有测试历史').click();
  await input(page).fill('第一条聊天的草稿');
  await row(page, 'local', '等待恢复的聊天').click();
  await expect.poll(() => held.held.length).toBeGreaterThan(0);
  await expect(input(page)).toBeEnabled();
  await input(page).fill('未恢复聊天自己的草稿');
  await noSubmission(page, mock);
  await row(page, 'local', '已有测试历史').click();
  await expect(input(page)).toHaveValue('第一条聊天的草稿');
  await input(page).fill('返回后继续编辑第一条');
  held.release();
  await expect(input(page)).toHaveValue('返回后继续编辑第一条');
  await row(page, 'local', '等待恢复的聊天').click();
  await expect(input(page)).toHaveValue('未恢复聊天自己的草稿');
  held.release();
});

test('offline text survives reconnection and is never automatically submitted', async ({ page, mock }) => {
  await login(page);
  mock.emit('bridge/status', { connected: false, hostId: 'local', mode: 'spawn' });
  await expect(input(page)).toBeEnabled();
  await input(page).fill('离线时继续编写');
  await noSubmission(page, mock);
  mock.emit('bridge/status', { connected: true, hostId: 'local', mode: 'spawn' });
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('离线时继续编写');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a second chat on the same connecting host selects its draft immediately without waiting for the first handshake', async ({ page, mock }) => {
  const remote = setup(mock), sockets: WebSocketRoute[] = [];
  remote.threads.push({ ...remote.threads[0]!, id: 'second-remote', name: '同一远端另一条聊天', preview: '同一远端另一条聊天' });
  remote.turns.set('second-remote', []);
  await page.routeWebSocket(url => url.pathname === '/api/rpc' && url.searchParams.get('host') === hostId, socket => {
    sockets.push(socket); remote.sockets.push(socket);
    socket.onMessage(raw => (remote as any).receive(socket, JSON.parse(raw.toString())));
  });
  await login(page);
  await row(page, hostId, '远端加载中的会话').click();
  await expect.poll(() => sockets.length).toBe(1);
  await input(page).fill('第一条还在连接的远端草稿');
  await row(page, hostId, '同一远端另一条聊天').click();
  await expect(page.getByRole('tab', { name: '同一远端另一条聊天', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(input(page)).toHaveValue('');
  await input(page).fill('第二条还在连接的远端草稿');
  await noSubmission(page, remote);
  sockets[0]!.send(JSON.stringify({ method: 'bridge/status', params: { connected: true, activeProcesses: [], pendingRequests: [], hostId, mode: 'spawn' } }));
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('第二条还在连接的远端草稿');
  expect(remote.requests.filter(request => request.method === 'thread/resume').every(request => request.params.threadId === 'second-remote')).toBe(true);
  await row(page, hostId, '远端加载中的会话').click();
  await expect(input(page)).toHaveValue('第一条还在连接的远端草稿');
  await row(page, hostId, '同一远端另一条聊天').click();
  await expect(input(page)).toHaveValue('第二条还在连接的远端草稿');
});

test('text entered during a first remote connection survives a refresh while configuration remains pending', async ({ page, mock }) => {
  const remote = setup(mock); remote.holdConfigReadResponse = true;
  await login(page);
  await page.getByRole('combobox', { name: '新对话主机', exact: true }).selectOption(hostId);
  await expect.poll(() => remote.request('config/read')?.method).toBe('config/read');
  await input(page).fill('等待连接时写下的持久草稿');
  await noSubmission(page, remote);
  await page.reload();
  await expect(input(page)).toHaveValue('等待连接时写下的持久草稿');
  await expect(input(page)).toBeEnabled();
  await expect(page.getByRole('combobox', { name: '新对话项目', exact: true })).toHaveValue(remotePath);
  await input(page).fill('刷新后继续写，也不会被旧加载覆盖');
  await noSubmission(page, remote);
  remote.releaseConfigReadResponse();
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('刷新后继续写，也不会被旧加载覆盖');
  expect(remote.request('turn/start')).toBeUndefined();
});
