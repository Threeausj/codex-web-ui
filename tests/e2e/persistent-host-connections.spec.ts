import { test, expect, login, MockCodex } from './fixtures';
import type { Page } from '@playwright/test';
const editor = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const selected = (page: Page, host: string) => page.locator(`.chat-tab[data-host-id="${host}"][data-thread-id="thread-existing"]`).getByRole('tab');
function remoteFixture(mock: MockCodex) {
  const remote = new MockCodex();
  remote.threads[0] = { ...remote.threads[0], name: '远端持久连接', preview: '远端持久连接' };
  remote.turns.get('thread-existing')![0].items[1].text = '远端持久会话正文';
  mock.hosts.push({ id: 'persistent-remote', name: '持久连接主机', kind: 'ssh', hostname: 'remote.invalid', cwd: '/workspace/demo' });
  mock.projects.push({ ...mock.projects[0], id: 'persistent-project', hostId: 'persistent-remote' });
  mock.hostMocks.set('persistent-remote', remote);
  return remote;
}
async function open(page: Page, host: string, name: string) {
  await page.locator(`[data-section="recent"] .nav-thread[data-host-id="${host}"] .thread-row`).filter({ hasText: name }).click();
  await expect(selected(page, host)).toHaveAttribute('aria-selected', 'true');
  await expect(editor(page)).toBeEnabled();
}
async function visitBoth(page: Page) {
  await open(page, 'local', '已有测试历史');
  await open(page, 'persistent-remote', '远端持久连接');
}

test('cross-host tab returns reuse healthy WebSockets without a connecting banner or extra handshakes', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  await login(page); await visitBoth(page);
  await page.evaluate(() => {
    (window as any).__hostBanners = [];
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('.connection-banner'))
        if (node.textContent?.includes('正在连接目标主机')) (window as any).__hostBanners.push(node.textContent);
    }).observe(document.body, { childList: true, subtree: true });
  });
  for (let index = 0; index < 3; index++) {
    await selected(page, 'local').click(); await expect(editor(page)).toBeEnabled();
    await expect(page.locator('.agent-message')).toContainText('历史保持可读');
    await selected(page, 'persistent-remote').click(); await expect(editor(page)).toBeEnabled();
    await expect(page.locator('.agent-message')).toContainText('远端持久会话正文');
  }
  expect(mock.sockets).toHaveLength(1); expect(remote.sockets).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).__hostBanners)).toEqual([]);
  expect(mock.request('turn/start')).toBeUndefined(); expect(remote.request('turn/start')).toBeUndefined();
});

test('inactive host events cannot enter the selected host and fresh history reconciles them on return', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  await login(page); await visitBoth(page);
  mock.emit('item/agentMessage/delta', { threadId: 'thread-existing', turnId: 'turn-old', itemId: 'ghost', delta: '本机背景流不能混入远端' });
  mock.emit('bridge/status', { connected: true, hostId: 'local', pendingRequests: [{ id: 'local-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-existing', command: 'local-only' } }] });
  await expect(page.locator('.agent-message')).toContainText('远端持久会话正文');
  await expect(page.getByText('本机背景流不能混入远端')).toHaveCount(0);
  mock.turns.get('thread-existing')![0].items[1].text = '本机后台完成后的新正文';
  await selected(page, 'local').click(); await expect(editor(page)).toBeEnabled();
  await expect(page.locator('.agent-message')).toContainText('本机后台完成后的新正文');
  expect(mock.sockets).toHaveLength(1);
});

test('a closed inactive transport reconnects only when selected and keeps the other host healthy', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  await login(page); await visitBoth(page);
  mock.sockets[0]!.close({ code: 1006, reason: 'Fixture inactive connection closed' });
  await expect(editor(page)).toBeEnabled();
  await expect(page.locator('.agent-message')).toContainText('远端持久会话正文');
  await selected(page, 'local').click(); await expect(editor(page)).toBeEnabled();
  expect(mock.sockets).toHaveLength(2); expect(remote.sockets).toHaveLength(1);
  await selected(page, 'persistent-remote').click(); await expect(editor(page)).toBeEnabled();
  expect(remote.sockets).toHaveLength(1);
});

test('all visited host transports close on logout and cannot inject private events into a later login', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  await login(page); await visitBoth(page);
  await page.locator('.sidebar-footer').getByRole('button', { name: /设置/ }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '账户', exact: true }).click();
  await settings.getByRole('button', { name: '退出网页', exact: true }).click();
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await login(page); await expect(editor(page)).toBeVisible();
  expect(remote.sockets).toHaveLength(2);
  expect(mock.request('turn/start')).toBeUndefined(); expect(remote.request('turn/start')).toBeUndefined();
});

test('offline clears both selected and parked transports and online restores only the selected host', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  await login(page); await visitBoth(page);
  const closed: string[] = [];
  mock.sockets[0]!.onClose(() => closed.push('local'));
  remote.sockets[0]!.onClose(() => closed.push('remote'));
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline')); });
  await expect(page.getByText('目前离线，联网后将重新连接。操作不会自动提交。', { exact: true })).toBeVisible();
  await expect.poll(() => [...closed].sort()).toEqual(['local', 'remote']);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); });
  await expect(editor(page)).toBeEnabled();
  expect(remote.sockets).toHaveLength(2); expect(mock.sockets).toHaveLength(1);
  await selected(page, 'local').click(); await expect(editor(page)).toBeEnabled();
  expect(mock.sockets).toHaveLength(2);
});

test('a paused parked host stays paused when selected and cannot auto-resume a writer', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  await login(page); await visitBoth(page);
  const before = mock.requests.filter(request => request.method === 'thread/resume').length;
  mock.emit('bridge/status', { hostId: 'local', connected: false, paused: true, pendingRequests: [], activeProcesses: [] });
  await expect(editor(page)).toBeEnabled();
  await selected(page, 'local').click();
  await expect(page.getByText('Web Codex 已释放，可切换桌面端。', { exact: false }).first()).toBeVisible();
  await expect(editor(page)).toBeDisabled();
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(before);
  expect(mock.sockets).toHaveLength(1);
  expect(remote.sockets).toHaveLength(1);
});

test('visited host sockets use a bounded pool and retire the least recently selected connection', async ({ page, mock }) => {
  const remotes = Array.from({ length: 8 }, (_, index) => {
    const id = `pool-${index}`, remote = new MockCodex();
    remote.threads[0] = { ...remote.threads[0], name: `连接池聊天 ${index}`, preview: `连接池聊天 ${index}` };
    mock.hosts.push({ id, name: `连接池主机 ${index}`, kind: 'ssh', hostname: `${id}.invalid`, cwd: '/workspace/demo' });
    mock.hostMocks.set(id, remote);
    return { id, remote };
  });
  await login(page); await open(page, 'local', '已有测试历史');
  let localClosed = false;
  mock.sockets[0]!.onClose(() => { localClosed = true; });
  for (const [index, { id, remote }] of remotes.entries()) {
    await open(page, id, `连接池聊天 ${index}`);
    expect(remote.sockets).toHaveLength(1);
  }
  await expect.poll(() => localClosed).toBe(true);
  // The last selected host remains connected; only the evicted oldest needs a
  // fresh transport, and reopening it never starts or interrupts model work.
  await selected(page, 'local').click(); await expect(editor(page)).toBeEnabled();
  expect(mock.sockets).toHaveLength(2);
  expect(remotes[7]!.remote.sockets).toHaveLength(1);
  expect(mock.request('turn/start')).toBeUndefined();
  expect(mock.request('turn/interrupt')).toBeUndefined();
});

test('returning to a parked host restores new approvals and removes ones resolved in the background', async ({ page, mock }) => {
  const remote = remoteFixture(mock);
  await login(page); await visitBoth(page);
  const approval = { id: 'parked-approval', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-existing', turnId: 'parked-turn', itemId: 'parked-item', command: 'printf parked-approval', cwd: '/workspace/demo', availableDecisions: ['accept', 'decline'] } };
  mock.pendingRequests = [approval];
  mock.sockets[0]!.send(JSON.stringify(approval));
  await expect(page.locator('.approval-card')).toHaveCount(0);
  await selected(page, 'local').click();
  await expect(page.locator('.approval-card')).toContainText('printf parked-approval');
  await selected(page, 'persistent-remote').click(); await expect(editor(page)).toBeEnabled();
  mock.pendingRequests = [];
  mock.emit('serverRequest/resolved', { requestId: approval.id });
  await selected(page, 'local').click(); await expect(editor(page)).toBeEnabled();
  await expect(page.locator('.approval-card')).toHaveCount(0);
  expect(mock.sockets).toHaveLength(1); expect(remote.sockets).toHaveLength(1);
});

test('an older bridge without an authoritative return snapshot is reattached before enabling its writer', async ({ page, mock }) => {
  remoteFixture(mock);
  const original = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'bridge/ping' && request.params?.includeState) {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, result: { connected: true, paused: false, engineId: 'older-bridge', loadedThreadIds: ['thread-existing'] } }));
    }
    return original(socket, request);
  };
  await login(page); await visitBoth(page);
  await selected(page, 'local').click(); await expect(editor(page)).toBeEnabled();
  expect(mock.sockets).toHaveLength(2);
  expect(mock.request('turn/start')).toBeUndefined();
});
