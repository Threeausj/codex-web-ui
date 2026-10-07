import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

async function foreground(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('resume'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
function persistentBridge(mock: MockCodex) {
  let engine = 'persistent-native-engine';
  let sequence = 0;
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'bridge/ping') {
      mock.requests.push(request);
      if (!mock.unresponsiveSockets.has(socket)) socket.send(JSON.stringify({ id: request.id, result: {
        connected: true, paused: false, engineId: engine, eventSequence: sequence, loadedThreadIds: ['thread-existing'],
      } }));
    } else receive(socket, request);
  };
  const status = () => mock.emit('bridge/status', { connected: true, engineId: engine, eventSequence: sequence });
  const emit = (method: string, params: unknown) => {
    ++sequence;
    for (const socket of mock.sockets) socket.send(JSON.stringify({ method, params, bridgeEventSequence: sequence }));
  };
  return { status, emit, skipEvent() { ++sequence; }, restart() { engine = 'new-native-engine'; status(); },
    async install(page: Page) {
      await page.routeWebSocket(/\/api\/rpc(?:\?|$)/, socket => {
        mock.sockets.push(socket);
        socket.onMessage(raw => (mock as any).receive(socket, JSON.parse(raw.toString())));
        socket.send(JSON.stringify({ method: 'bridge/status', params: { connected: true, mode: 'spawn',
          engineId: engine, eventSequence: sequence, pendingRequests: [] } }));
      });
    },
  };
}

test('a fresh browser restores persisted context without waiting for another model response', async ({ page, mock }) => {
  await page.route('**/api/hosts/local/threads/thread-existing/context*', route => route.fulfill({ json: {
    tokenUsage: { last: { totalTokens: 42000 }, modelContextWindow: 100000 }, compacting: false,
  } }));
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator('.context-usage')).toHaveText('上下文 42%');
  await page.reload();
  await expect(page.locator('.context-usage')).toHaveText('上下文 42%');
  expect(mock.request('turn/start')).toBeUndefined();
});

test('slow persisted context cannot overwrite newer native measurements or a compaction started after the read', async ({ page, mock }) => {
  let release!: () => Promise<void>;
  await page.route('**/api/hosts/local/threads/thread-existing/context*', async route => {
    await new Promise<void>(resolve => { release = async () => {
      await route.fulfill({ json: { tokenUsage: { last: { totalTokens: 90000 }, modelContextWindow: 100000 }, compacting: false } });
      resolve();
    }; });
  });
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect.poll(() => !!release).toBe(true);
  mock.emit('thread/tokenUsage/updated', { threadId: 'thread-existing', tokenUsage: {
    last: { totalTokens: 7000 }, modelContextWindow: 100000,
  } });
  mock.emit('turn/started', { threadId: 'thread-existing', turn: { id: 'compress-race', status: 'inProgress', items: [] } });
  mock.emit('item/started', { threadId: 'thread-existing', turnId: 'compress-race', item: { id: 'race-compaction', type: 'contextCompaction' } });
  await release();
  await expect(page.locator('.context-usage')).toContainText(/7%|正在压缩/);
  await expect(page.locator('.compaction-divider')).toContainText('正在压缩');
  await expect(page.locator('.compaction-divider')).not.toContainText('已压缩');
});

test('compression acknowledgement retains usage and in-progress reminder until native completion', async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/compact/start') {
      mock.requests.push(request);
      socket.send(JSON.stringify({ id: request.id, result: {} }));
    } else receive(socket, request);
  };
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  mock.emit('thread/tokenUsage/updated', { threadId: 'thread-existing', tokenUsage: { last: { totalTokens: 24000 }, modelContextWindow: 100000 } });
  await expect(page.locator('.context-usage')).toHaveText('上下文 24%');
  await page.locator('.context-usage').click();
  await expect.poll(() => !!mock.request('thread/compact/start')).toBe(true);
  await expect(page.locator('.compaction-status')).toContainText('正在压缩');
  await expect(page.locator('.compaction-divider')).toHaveCount(0);
  await expect(page.locator('.context-usage')).toContainText(/24%|正在压缩/);
  const turn = { id: 'native-compact', status: 'inProgress', items: [] as any[] };
  mock.emit('turn/started', { threadId: 'thread-existing', turn });
  mock.emit('item/started', { threadId: 'thread-existing', turnId: turn.id, item: { id: 'compression', type: 'contextCompaction' } });
  await expect(page.locator('.compaction-divider')).toContainText('正在压缩');
  mock.emit('thread/tokenUsage/updated', { threadId: 'thread-existing', tokenUsage: { last: { totalTokens: 3000 }, modelContextWindow: null } });
  const item = { id: 'compression', type: 'contextCompaction' };
  mock.emit('item/completed', { threadId: 'thread-existing', turnId: turn.id, item });
  mock.emit('turn/completed', { threadId: 'thread-existing', turn: { ...turn, status: 'completed', items: [item] } });
  await expect(page.locator('.compaction-divider')).toContainText('上下文已压缩');
  await expect(page.locator('.compaction-status')).toHaveCount(0);
  await expect(page.locator('.context-usage')).toHaveText('上下文 3%');
});

test('continuous foreground probes retain the native writer and skip unchanged history and configuration', async ({ page, mock }) => {
  const bridge = persistentBridge(mock);
  await login(page); bridge.status();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  const resumed = mock.requests.filter(request => request.method === 'thread/resume').length;
  const histories = mock.requests.filter(request => request.method === 'thread/turns/list').length;
  const configs = mock.requests.filter(request => request.method === 'config/read').length;
  await foreground(page);
  await expect.poll(() => mock.requests.filter(request => request.method === 'bridge/ping').length).toBe(1);
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(resumed);
  expect(mock.requests.filter(request => request.method === 'thread/turns/list')).toHaveLength(histories);
  expect(mock.requests.filter(request => request.method === 'config/read')).toHaveLength(configs);
  expect(mock.sockets).toHaveLength(1);
});

test('a native engine restart reacquires the writer before sending instead of trusting cached history', async ({ page, mock }) => {
  const bridge = persistentBridge(mock);
  await login(page); bridge.status();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  const resumed = mock.requests.filter(request => request.method === 'thread/resume').length;
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('等待重新获得写入权');
  bridge.restart();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await expect.poll(() => mock.requests.filter(request => request.method === 'thread/resume').length).toBe(resumed + 1);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a legacy completion-only compression stays before subsequent turns, survives hydration and releases busy state', async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/compact/start') {
      mock.requests.push(request);
      socket.send(JSON.stringify({ id: request.id, result: {} }));
    } else receive(socket, request);
  };
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.locator('.context-usage').click();
  await expect(page.locator('.compaction-status')).toBeVisible();
  mock.emit('thread/compacted', { threadId: 'thread-existing' });
  await expect(page.locator('.compaction-divider')).toContainText('上下文已压缩');
  await expect(page.locator('.compaction-status')).toHaveCount(0);
  mock.turns.get('thread-existing')!.push({ id: 'after-legacy', status: 'completed', items: [
    { id: 'next-user', type: 'userMessage', content: [{ type: 'text', text: '压缩后继续' }] },
    { id: 'next-answer', type: 'agentMessage', text: '后续回复保持位置' },
  ] });
  await foreground(page);
  await expect(page.getByText('后续回复保持位置', { exact: true })).toBeVisible();
  await expect(page.locator('.compaction-divider')).toHaveCount(1);
  await expect(page.locator('.conversation-turn').first().locator('.compaction-divider')).toHaveCount(1);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('压缩完成可以发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('an engine change cannot let delayed old history certify a writer in the new engine', async ({ page, mock }) => {
  for (const thread of mock.threads) thread.recencyAt = thread.updatedAt;
  const bridge = persistentBridge(mock);
  await bridge.install(page);
  let heldHistory: (() => void) | undefined;
  let heldResume: (() => void) | undefined;
  let resumeCount = 0;
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/resume' && ++resumeCount > 1) {
      mock.requests.push(request);
      heldResume = () => socket.send(JSON.stringify({ id: request.id, result: {
        thread: mock.threads[0], model: mock.config.model, reasoningEffort: 'medium', sandbox: { type: 'workspaceWrite' },
      } }));
      return;
    }
    if (request.method === 'thread/turns/list') {
      mock.requests.push(request);
      const reply = () => socket.send(JSON.stringify({ id: request.id, result: {
        data: [...mock.turns.get('thread-existing')!].reverse(), nextCursor: null,
      } }));
      if (!heldHistory) heldHistory = reply;
      else reply();
      return;
    }
    receive(socket, request);
  };
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect.poll(() => !!heldHistory).toBe(true);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('新引擎确认前不能发送');
  bridge.restart();
  await expect.poll(() => !!heldResume).toBe(true);
  heldHistory!();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  heldResume!();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a definitive compression failure keeps the last usage and dismisses the progress reminder', async ({ page, mock }) => {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/compact/start') {
      mock.requests.push(request);
      socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: '压缩测试失败' } }));
    } else receive(socket, request);
  };
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  mock.emit('thread/tokenUsage/updated', { threadId: 'thread-existing', tokenUsage: { last: { totalTokens: 24000 }, modelContextWindow: 100000 } });
  await expect(page.locator('.context-usage')).toHaveText('上下文 24%');
  await page.locator('.context-usage').click();
  await expect(page.getByText('压缩测试失败', { exact: true })).toBeVisible();
  await expect(page.locator('.context-usage')).toHaveText('上下文 24%');
  await expect(page.locator('.compaction-status')).toHaveCount(0);
  await expect(page.locator('.compaction-divider')).toHaveCount(0);
});

test('a replacement browser socket rejoins the same native writer and reads missed history without resuming it', async ({ page, mock }) => {
  const bridge = persistentBridge(mock);
  await bridge.install(page);
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  expect(mock.sockets).toHaveLength(1);
  const resumed = mock.requests.filter(request => request.method === 'thread/resume').length;
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('重连不重复提交');
  mock.turns.get('thread-existing')!.push({ id: 'missed-answer-turn', status: 'completed', items: [
    { id: 'missed-answer', type: 'agentMessage', text: '重连补回遗漏历史' },
  ] });
  bridge.skipEvent();
  await mock.sockets[0]!.close({ code: 1006, reason: 'Network lost' });
  await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2);
  await expect(page.getByText('重连补回遗漏历史', { exact: true })).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(resumed);
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('重连不重复提交');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('a native event gap triggers a read-only history refresh while retaining the live writer', async ({ page, mock }) => {
  const bridge = persistentBridge(mock);
  await bridge.install(page);
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  const resumed = mock.requests.filter(request => request.method === 'thread/resume').length;
  mock.turns.get('thread-existing')!.push({ id: 'gap-answer-turn', status: 'completed', items: [
    { id: 'gap-answer', type: 'agentMessage', text: '序列缺口自动补齐' },
  ] });
  bridge.skipEvent();
  bridge.emit('thread/tokenUsage/updated', { threadId: 'thread-existing', tokenUsage: { last: { totalTokens: 100 }, modelContextWindow: 1000 } });
  await foreground(page);
  await expect(page.getByText('序列缺口自动补齐', { exact: true })).toBeVisible();
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(resumed);
  expect(mock.sockets).toHaveLength(1);
});
