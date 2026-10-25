import { test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expect, login, MockCodex } from './fixtures';
import type { StoredThreadReadReceipt, ThreadReadReceipt } from '../../shared/thread-read-receipts';

const targetId = 'shared-completed-task';
const targetTitle = '跨设备完成的任务';
const completedAt = 1792300001;
const receiptKey = (receipt: { hostId: string; threadId: string }) => JSON.stringify([receipt.hostId, receipt.threadId]);
const row = (page: Page, hostId = 'local', title = targetTitle) => page.locator(`[data-section="recent"] .nav-thread[data-host-id="${hostId}"]`)
  .filter({ has: page.locator('.thread-title').filter({ hasText: new RegExp(`^${title}$`) }) });
const input = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });

function addTarget(mock: MockCodex, title = targetTitle) {
  mock.threads.push({ ...mock.threads[0]!, id: targetId, name: title, preview: title });
  mock.turns.set(targetId, [{ ...mock.turns.get('thread-existing')![0], id: 'target-history', items: [
    { id: 'target-user', type: 'userMessage', content: [{ type: 'text', text: `${title}的问题` }] },
    { id: 'target-agent', type: 'agentMessage', text: `${title}的回复` },
  ] }]);
}

type Device = { context: BrowserContext; page: Page; mock: MockCodex };

/** A single server, with no browser-storage or MockCodex instance shared by the devices. */
class ReceiptBackend {
  records = new Map<string, StoredThreadReadReceipt>();
  requests: { page: Page; receipts: ThreadReadReceipt[] }[] = [];
  reads = new Map<Page, number>();
  muted = new Set<Page>();
  failNextWrite = false;
  devices: Device[] = [];

  broadcast(receipts: StoredThreadReadReceipt[]) {
    for (const device of this.devices) {
      if (this.muted.has(device.page)) continue;
      for (const mock of [device.mock, ...device.mock.hostMocks.values()]) {
        mock.emit('bridge/thread-read-receipts', { receipts });
      }
    }
  }

  async install(device: Device) {
    this.devices.push(device);
    await device.page.route('**/api/thread-read-receipts*', async route => {
      if (new URL(route.request().url()).pathname !== '/api/thread-read-receipts') return route.fallback();
      if (route.request().method() === 'GET') {
        this.reads.set(device.page, (this.reads.get(device.page) || 0) + 1);
        return route.fulfill({ json: { receipts: [...this.records.values()] } });
      }
      const receipts = route.request().postDataJSON().receipts as ThreadReadReceipt[];
      this.requests.push({ page: device.page, receipts });
      if (this.failNextWrite) {
        this.failNextWrite = false;
        return route.fulfill({ status: 503, json: { error: '模拟短暂网络故障' } });
      }
      const changed: StoredThreadReadReceipt[] = [];
      for (const receipt of receipts) {
        const previous = this.records.get(receiptKey(receipt));
        const stored = {
          hostId: receipt.hostId,
          threadId: receipt.threadId,
          turnIds: [...(previous?.turnIds || []).filter(id => id !== receipt.turnId), receipt.turnId].slice(-16),
          activityAt: Math.max(previous?.activityAt || 0, receipt.activityAt),
        };
        this.records.set(receiptKey(receipt), stored);
        changed.push(stored);
      }
      await route.fulfill({ json: { receipts: changed } });
      this.broadcast(changed);
    });
  }
}

async function devices(browser: Browser, baseURL: string | undefined, remote = false) {
  const backend = new ReceiptBackend();
  const result: Device[] = [];
  for (let index = 0; index < 2; index++) {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const mock = new MockCodex();
    addTarget(mock);
    if (remote) {
      const host = new MockCodex();
      addTarget(host, '远程同 ID 的任务');
      mock.hosts.push({ id: 'ssh-test', name: '远程主机', kind: 'ssh', cwd: '/workspace/demo' });
      mock.projects.push({ ...mock.projects[0], id: 'remote-project', hostId: 'ssh-test', name: 'Remote Project' });
      mock.hostMocks.set('ssh-test', host);
    }
    await mock.install(page);
    const device = { context, page, mock };
    await backend.install(device);
    result.push(device);
    await login(page);
    await expect(row(page)).toBeVisible();
    await expect.poll(() => backend.reads.get(page) || 0).toBeGreaterThan(0);
  }
  const [a, b] = result as [Device, Device];
  // A storage event or shared localStorage must never make this test pass.
  await a.page.evaluate(() => localStorage.setItem('read-receipt-device-proof', 'device-a-only'));
  expect(await b.page.evaluate(() => localStorage.getItem('read-receipt-device-proof'))).toBeNull();
  return { a, b, backend, close: () => Promise.all(result.map(device => device.context.close())) };
}

function complete(targets: Device[], turnId: string, at = completedAt, hostId = 'local') {
  for (const device of targets) {
    const mock = hostId === 'local' ? device.mock : device.mock.hostMocks.get(hostId)!;
    const turn = { id: turnId, status: 'inProgress', items: [
      { id: `${turnId}-agent`, type: 'agentMessage', text: `已完成 ${turnId}` },
    ], startedAt: at - 1, completedAt: null as number | null };
    mock.turns.get(targetId)!.push(turn);
    mock.emit('turn/started', { threadId: targetId, turn });
    turn.status = 'completed';
    turn.completedAt = at;
    Object.assign(mock.threads.find(thread => thread.id === targetId)!, { recencyAt: at, status: { type: 'idle' } });
    mock.emit('turn/completed', { threadId: targetId, turn });
  }
}

async function openTarget(device: Device, hostId = 'local', title = targetTitle) {
  await device.page.bringToFront();
  await row(device.page, hostId, title).locator('.thread-row').click();
  await expect(device.page.locator('.main-header h1')).toHaveText(title);
  await expect(device.page.getByText(`${title}的回复`, { exact: true })).toBeVisible();
}

async function unread(targets: Device[], count: number, hostId = 'local', title = targetTitle) {
  for (const device of targets) await expect(row(device.page, hostId, title).locator('.thread-status-unread')).toHaveCount(count);
}

test('reading on one independent device immediately clears the other device and remains read after reload', async ({ browser, baseURL }) => {
  const { a, b, backend, close } = await devices(browser, baseURL);
  try {
    await b.page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click();
    await input(b.page).fill('另一台设备保留的草稿');
    complete([a, b], 'device-shared-turn');
    await unread([a, b], 1);
    await openTarget(a);
    await unread([a, b], 0);
    expect(backend.records.get(receiptKey({ hostId: 'local', threadId: targetId }))?.turnIds).toContain('device-shared-turn');
    await expect(input(b.page)).toHaveValue('另一台设备保留的草稿');
    await expect(b.page.locator('.main-header h1')).toHaveText('已有测试历史');
    await b.page.reload();
    await expect(input(b.page)).toBeEnabled();
    await unread([b], 0);
    await expect(input(b.page)).toHaveValue('另一台设备保留的草稿');
    expect(a.mock.request('turn/start')).toBeUndefined();
    expect(b.mock.request('turn/start')).toBeUndefined();
  } finally { await close(); }
});

for (const recovery of ['focus', 'reconnect'] as const) {
  test(`a device that missed the read notification recovers its receipt on ${recovery}`, async ({ browser, baseURL }) => {
    const { a, b, backend, close } = await devices(browser, baseURL);
    try {
      complete([a, b], 'missed-receipt-turn');
      await unread([a, b], 1);
      backend.muted.add(b.page);
      await openTarget(a);
      await expect.poll(() => backend.records.size).toBe(1);
      await unread([b], 1);
      const reads = backend.reads.get(b.page) || 0;
      if (recovery === 'focus') {
        await b.page.bringToFront();
        await b.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      } else {
        const sockets = b.mock.sockets.length;
        await b.mock.sockets.at(-1)!.close({ code: 4003, reason: '模拟设备重新连接' });
        await expect.poll(() => b.mock.sockets.length, { timeout: 12000 }).toBeGreaterThan(sockets);
      }
      await expect.poll(() => backend.reads.get(b.page) || 0).toBeGreaterThan(reads);
      await unread([b], 0);
    } finally { await close(); }
  });
}

test('an older read receipt cannot clear a different completed turn even within the same second', async ({ browser, baseURL }) => {
  const { a, b, backend, close } = await devices(browser, baseURL);
  try {
    complete([a, b], 'first-read-turn');
    await unread([a, b], 1);
    await openTarget(a);
    await unread([a, b], 0);
    const oldReceipt = structuredClone(backend.records.get(receiptKey({ hostId: 'local', threadId: targetId }))!);
    await a.page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click();
    complete([a, b], 'new-unread-turn', completedAt);
    await unread([a, b], 1);
    backend.broadcast([oldReceipt]);
    // A rendered WebSocket name update is a barrier after the stale receipt.
    for (const device of [a, b]) device.mock.emit('thread/name/updated', { threadId: 'thread-existing', name: '旧回执之后的同步屏障' });
    for (const device of [a, b]) await expect(row(device.page, 'local', '旧回执之后的同步屏障')).toBeVisible();
    await unread([a, b], 1);
    await openTarget(a);
    await unread([a, b], 0);
    expect(backend.records.get(receiptKey({ hostId: 'local', threadId: targetId }))?.turnIds).toEqual(['first-read-turn', 'new-unread-turn']);
  } finally { await close(); }
});

test('read receipts keep identical thread IDs on different hosts separate', async ({ browser, baseURL }) => {
  const { a, b, backend, close } = await devices(browser, baseURL, true);
  try {
    complete([a, b], 'same-turn-id');
    await unread([a, b], 1);
    // Each device keeps its local completion while connecting to the remote
    // runtime. Background host navigation uses HTTP rather than a second RPC socket.
    for (const device of [a, b]) {
      await device.page.getByRole('combobox', { name: '新对话主机', exact: true }).selectOption('ssh-test');
      await expect(device.page.locator('.main-header')).toHaveAttribute('data-host-id', 'ssh-test');
      await expect.poll(() => device.mock.hostMocks.get('ssh-test')!.sockets.length).toBe(1);
    }
    complete([a, b], 'same-turn-id', completedAt, 'ssh-test');
    await unread([a, b], 1);
    await unread([a, b], 1, 'ssh-test', '远程同 ID 的任务');
    await openTarget(a);
    await unread([a, b], 0);
    await unread([a, b], 1, 'ssh-test', '远程同 ID 的任务');
    expect(backend.records.has(receiptKey({ hostId: 'ssh-test', threadId: targetId }))).toBe(false);
    await openTarget(a, 'ssh-test', '远程同 ID 的任务');
    await unread([a, b], 0, 'ssh-test', '远程同 ID 的任务');
    expect(backend.records.size).toBe(2);
  } finally { await close(); }
});

test('a selected conversation finishing in a hidden tab stays unread until the device actually views it', async ({ browser, baseURL }) => {
  const { a, b, backend, close } = await devices(browser, baseURL);
  try {
    await openTarget(a);
    await input(a.page).fill('隐藏前尚未发送的草稿');
    await a.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    complete([a, b], 'hidden-completion-turn');
    await unread([a, b], 1);
    // A subsequent bridge event confirms the page has processed the completion.
    a.mock.emit('thread/name/updated', { threadId: 'thread-existing', name: '隐藏标签未自动已读' });
    await expect(row(a.page, 'local', '隐藏标签未自动已读')).toBeVisible();
    expect(backend.requests.flatMap(request => request.receipts).filter(receipt => receipt.turnId === 'hidden-completion-turn')).toEqual([]);
    await a.page.bringToFront();
    await a.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await unread([a, b], 0);
    await expect(input(a.page)).toHaveValue('隐藏前尚未发送的草稿');
    expect(a.mock.request('turn/start')).toBeUndefined();
  } finally { await close(); }
});

test('a transient failure while saving a read receipt retries and synchronizes without submitting the draft', async ({ browser, baseURL }) => {
  const { a, b, backend, close } = await devices(browser, baseURL);
  try {
    complete([a, b], 'retry-receipt-turn');
    await unread([a, b], 1);
    backend.failNextWrite = true;
    await openTarget(a);
    await input(a.page).fill('回执重试不发送这条草稿');
    await expect.poll(() => backend.requests.length).toBe(1);
    await unread([a], 0);
    await unread([b], 1);
    await expect.poll(() => backend.requests.length, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
    await unread([b], 0);
    await expect(input(a.page)).toHaveValue('回执重试不发送这条草稿');
    await expect(a.page.locator('.error-banner')).toHaveCount(0);
    expect(a.mock.request('turn/start')).toBeUndefined();
  } finally { await close(); }
});
