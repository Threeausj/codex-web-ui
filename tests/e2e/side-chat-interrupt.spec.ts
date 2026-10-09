import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const parentId = 'thread-existing';
const sideId = 'side-interrupt-branch';
const oldId = 'side-old-turn';
const newId = 'side-new-turn';
const thirdId = 'side-third-turn';
const makeTurn = (id: string, status = 'inProgress') => ({ id, status, itemsView: 'full', items: [] as any[] });

/** All branches and protocol replies are fixtures; no live Codex is involved. */
function sidebarWire(mock: MockCodex) {
  const receive = (mock as any).receive.bind(mock);
  const control = {
    currentId: oldId,
    reverseIds: false,
    holdProbe: false,
    holdStart: false,
    releaseProbe: undefined as (() => void) | undefined,
    releaseStart: undefined as (() => void) | undefined,
    handleInterrupt: undefined as ((socket: any, request: any) => void) | undefined,
    advance(id = newId) {
      const previous = mock.turns.get(sideId)!.at(-1)!;
      previous.status = 'completed';
      mock.turns.get(sideId)!.push(makeTurn(id));
      control.currentId = id;
    },
  };
  (mock as any).receive = (socket: any, request: any) => {
    const p = request.params || {};
    const reply = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
    const tracked = (result: unknown) => { mock.requests.push(request); reply(result); };
    if (request.method === 'thread/goal/get') return tracked({ goal: null });
    if (request.method === 'thread/fork' && p.ephemeral) {
      const thread = { ...mock.threads[0], id: sideId, ephemeral: true, forkedFromId: parentId, turns: [] };
      mock.turns.set(sideId, []);
      return tracked({ thread });
    }
    if (request.method === 'thread/unsubscribe') return tracked({});
    if (p.threadId !== sideId) return receive(socket, request);
    if (request.method === 'turn/start') {
      mock.requests.push(request);
      const turn = makeTurn(oldId);
      mock.turns.get(sideId)!.push(turn);
      mock.emit('turn/started', { threadId: sideId, turn });
      control.releaseStart = () => reply({ turn });
      if (!control.holdStart) control.releaseStart();
      return;
    }
    if (request.method === 'thread/turns/list' && p.limit === 1) {
      mock.requests.push(request);
      const data = structuredClone(mock.turns.get(sideId)!.slice(-1).reverse());
      control.releaseProbe = () => reply({ data, nextCursor: null });
      if (!control.holdProbe) control.releaseProbe();
      return;
    }
    if (request.method !== 'turn/interrupt') return receive(socket, request);
    mock.requests.push(request);
    if (control.handleInterrupt) return control.handleInterrupt(socket, request);
    if (p.turnId !== control.currentId) {
      const [expected, found] = control.reverseIds ? [control.currentId, p.turnId] : [p.turnId, control.currentId];
      return socket.send(JSON.stringify({ id: request.id, error: { code: -32600,
        message: `expected active turn id ${expected} but found ${found}` } }));
    }
    reply({});
    const turn = mock.turns.get(sideId)!.find(turn => turn.id === p.turnId)!;
    turn.status = 'interrupted';
    mock.emit('turn/completed', { threadId: sideId, turn });
  };
  return control;
}

async function openRunningSidebar(page: Page) {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  const body = page.locator('[data-selection-item-id="history-agent"]');
  await expect(body).toBeVisible();
  await body.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await body.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: '在侧边聊天中提问', exact: true }).click();
  await page.getByRole('textbox', { name: '围绕引用内容提问', exact: true }).fill('请解释引用内容');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止侧边回答', exact: true })).toBeVisible();
}
const stop = (page: Page) => page.getByRole('button', { name: '停止侧边回答', exact: true });
const stops = (mock: MockCodex) => mock.requests.filter(request => request.method === 'turn/interrupt');
const probes = (mock: MockCodex) => mock.requests.filter(request => request.method === 'thread/turns/list' && request.params.threadId === sideId && request.params.limit === 1);
const assertOnlySideStopped = (mock: MockCodex) => expect(stops(mock).every(request => request.params.threadId === sideId)).toBe(true);

test('sidebar Stop immediately interrupts its own branch without reading history or stopping the parent', async ({ page, mock }) => {
  sidebarWire(mock);
  await openRunningSidebar(page);
  await expect(page.locator('.side-chat-status').filter({ hasText: '正在准备侧边对话' })).toHaveCount(0);
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0);
  expect(stops(mock).map(request => request.params.turnId)).toEqual([oldId]);
  expect(probes(mock)).toHaveLength(0);
  assertOnlySideStopped(mock);
  expect(mock.turns.get(parentId)).toHaveLength(1);
});

for (const reverseIds of [false, true]) {
  test(`sidebar Stop confirms a newer native turn with one bounded read before retrying (${reverseIds ? 'current ID first' : 'requested ID first'})`, async ({ page, mock }) => {
    const control = sidebarWire(mock); control.reverseIds = reverseIds;
    await openRunningSidebar(page); control.advance();
    await stop(page).click();
    await expect(stop(page)).toHaveCount(0);
    expect(stops(mock).map(request => request.params.turnId)).toEqual([oldId, newId]);
    expect(probes(mock)).toHaveLength(1);
    expect(probes(mock)[0]!.params).toEqual({ threadId: sideId, cursor: null, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
    await expect(page.locator('.side-chat-error')).toHaveCount(0);
    assertOnlySideStopped(mock);
  });
}

test('rapid repeated sidebar Stop clicks share one pending operation and one confirmed retry', async ({ page, mock }) => {
  const control = sidebarWire(mock); control.holdProbe = true;
  await openRunningSidebar(page); control.advance();
  await stop(page).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => probes(mock).length).toBe(1);
  expect(stops(mock)).toHaveLength(1);
  control.releaseProbe!();
  await expect(stop(page)).toHaveCount(0);
  expect(stops(mock).map(request => request.params.turnId)).toEqual([oldId, newId]);
  assertOnlySideStopped(mock);
});

test('switching the parent while sidebar Stop confirms a conflict prevents its retry', async ({ page, mock }) => {
  const control = sidebarWire(mock); control.holdProbe = true;
  mock.threads.push({ ...mock.threads[0], id: 'another-parent', name: '另一个父对话', preview: '另一个父对话' });
  mock.turns.set('another-parent', []);
  await openRunningSidebar(page); control.advance();
  await stop(page).click();
  await expect.poll(() => probes(mock).length).toBe(1);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '另一个父对话' }).first().click();
  await expect(page.locator('.main-header')).toContainText('另一个父对话');
  control.releaseProbe!();
  await expect(page.locator('.side-chat-panel')).toHaveCount(0);
  expect(stops(mock).some(request => request.params.turnId === newId)).toBe(false);
  assertOnlySideStopped(mock);
});

test('closing the sidebar during confirmation prevents a retry on the released branch', async ({ page, mock }) => {
  const control = sidebarWire(mock); control.holdProbe = true;
  await openRunningSidebar(page); control.advance();
  await stop(page).click();
  await expect.poll(() => probes(mock).length).toBe(1);
  await page.getByRole('button', { name: '关闭侧边聊天', exact: true }).click();
  control.releaseProbe!();
  await expect(page.locator('.side-chat-panel')).toHaveCount(0);
  expect(stops(mock).some(request => request.params.turnId === newId)).toBe(false);
  assertOnlySideStopped(mock);
});

test('a newer streamed sidebar turn invalidates an older confirmation instead of stopping it', async ({ page, mock }) => {
  const control = sidebarWire(mock); control.holdProbe = true;
  await openRunningSidebar(page); control.advance();
  await stop(page).click();
  await expect.poll(() => probes(mock).length).toBe(1);
  control.advance(thirdId);
  mock.emit('turn/started', { threadId: sideId, turn: mock.turns.get(sideId)!.at(-1) });
  control.releaseProbe!();
  await expect(page.locator('.side-chat-error')).toContainText('侧边任务轮次已变化');
  expect(stops(mock).map(request => request.params.turnId)).toEqual([oldId]);
  await expect(stop(page)).toBeVisible();
});

test('sidebar Stop timeouts remain uncertain and never repeat the mutation or read history', async ({ page, mock }) => {
  const control = sidebarWire(mock); control.handleInterrupt = () => {};
  await openRunningSidebar(page);
  await page.clock.install();
  await stop(page).click();
  await page.clock.fastForward(45000);
  await expect(page.locator('.side-chat-error')).toContainText('turn/interrupt 请求超时');
  expect(stops(mock)).toHaveLength(1);
  expect(probes(mock)).toHaveLength(0);
  assertOnlySideStopped(mock);
});

test('a candidate completed during sidebar confirmation clears the stale busy state without another Stop', async ({ page, mock }) => {
  const control = sidebarWire(mock); control.holdProbe = true;
  await openRunningSidebar(page); control.advance();
  await stop(page).click();
  await expect.poll(() => probes(mock).length).toBe(1);
  const completed = mock.turns.get(sideId)!.at(-1)!;
  completed.status = 'completed';
  mock.emit('turn/completed', { threadId: sideId, turn: completed });
  control.releaseProbe!();
  await expect(stop(page)).toHaveCount(0);
  await expect(page.locator('.side-chat-error')).toHaveCount(0);
  expect(stops(mock).map(request => request.params.turnId)).toEqual([oldId]);
});

test('a second sidebar Stop conflict does not follow further turns or loop', async ({ page, mock }) => {
  const control = sidebarWire(mock);
  await openRunningSidebar(page); control.advance();
  control.handleInterrupt = (socket, request) => socket.send(JSON.stringify({ id: request.id,
    error: { code: -32600, message: `expected active turn id ${request.params.turnId} but found ${request.params.turnId === oldId ? newId : thirdId}` } }));
  await stop(page).click();
  await expect(page.locator('.side-chat-error')).toContainText('侧边任务轮次已变化');
  expect(stops(mock).map(request => request.params.turnId)).toEqual([oldId, newId]);
  expect(probes(mock)).toHaveLength(1);
  assertOnlySideStopped(mock);
});

test('preparing a sidebar turn cannot submit Stop before its start acknowledgement is confirmed', async ({ page, mock }) => {
  const control = sidebarWire(mock); control.holdStart = true;
  await openRunningSidebar(page);
  await stop(page).click();
  await expect(page.locator('.side-chat-error')).toContainText('侧边任务正在准备');
  expect(stops(mock)).toHaveLength(0);
  control.releaseStart!();
  await expect(page.locator('.side-chat-status').filter({ hasText: '正在准备侧边对话' })).toHaveCount(0);
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0);
  expect(stops(mock).map(request => request.params.turnId)).toEqual([oldId]);
  assertOnlySideStopped(mock);
});

test('a changed native identity prevents a pending sidebar confirmation from retrying', async ({ page, mock }) => {
  const control = sidebarWire(mock); control.holdProbe = true;
  await openRunningSidebar(page); control.advance();
  await stop(page).click();
  await expect.poll(() => probes(mock).length).toBe(1);
  mock.emit('bridge/status', { connected: true, hostId: 'local', engineId: 'new-side-engine', pendingRequests: [] });
  control.releaseProbe!();
  await expect(page.locator('.side-chat-error')).toHaveCount(0);
  expect(stops(mock).some(request => request.params.turnId === newId)).toBe(false);
  assertOnlySideStopped(mock);
});

for (const status of ['inProgress', 'completed']) {
  test(`a live third sidebar turn before the conflict reply outranks ${status} history without being stopped or cleared`, async ({ page, mock }) => {
    const control = sidebarWire(mock);
    let releaseConflict!: () => void;
    control.handleInterrupt = (socket, request) => {
      releaseConflict = () => socket.send(JSON.stringify({ id: request.id,
        error: { code: -32600, message: `expected active turn id ${request.params.turnId} but found ${newId}` } }));
    };
    await openRunningSidebar(page); control.advance();
    mock.turns.get(sideId)!.at(-1)!.status = status;
    await stop(page).click();
    await expect.poll(() => stops(mock).length).toBe(1);
    mock.emit('turn/started', { threadId: sideId, turn: { ...makeTurn(thirdId), items: [
      { id: 'third-side-live-input', type: 'userMessage', content: [{ type: 'text', text: '侧边第三轮实时任务' }] },
    ] } });
    await expect(page.locator('.side-chat-transcript').getByText('侧边第三轮实时任务', { exact: true })).toBeVisible();
    releaseConflict();
    await expect(page.locator('.side-chat-error')).toContainText('侧边任务轮次已变化');
    await expect(stop(page)).toBeVisible();
    expect(stops(mock)).toHaveLength(1);
    expect(probes(mock)).toHaveLength(0);
    assertOnlySideStopped(mock);
  });
}
