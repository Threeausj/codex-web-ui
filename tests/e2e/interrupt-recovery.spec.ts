import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const threadId = 'thread-existing';
const oldId = '01a11b61-7955-7a63-bcb5-14a86f187007';
const newId = '01a120c4-0c69-7db1-9d02-d4470eb796db';
const thirdId = '01a120c4-0c69-7db1-9d02-d4470eb796dc';
const makeTurn = (id: string) => ({ id, status: 'inProgress', items: [], itemsView: 'full' });

function interruptWire(mock: MockCodex) {
  const old = makeTurn(oldId);
  mock.turns.get(threadId)!.push(old);
  mock.threads[0]!.status = { type: 'active', activeFlags: [] };
  const original = (mock as any).receive.bind(mock);
  const control = {
    currentId: oldId,
    reverseIds: false,
    holdProbe: false,
    releaseProbe: undefined as (() => void) | undefined,
    handleInterrupt: undefined as ((socket: any, request: any) => void) | undefined,
    advance(id = newId) {
      const previous = mock.turns.get(threadId)!.at(-1)!;
      previous.status = 'completed';
      mock.turns.get(threadId)!.push(makeTurn(id));
      control.currentId = id;
    },
  };
  (mock as any).receive = (socket: any, request: any) => {
    const p = request.params || {};
    const reply = (result: any) => socket.send(JSON.stringify({ id: request.id, result }));
    if (request.method === 'thread/turns/list' && p.limit === 1 && p.cursor === null) {
      mock.requests.push(request);
      const data = structuredClone(mock.turns.get(p.threadId)!.slice(-1).reverse());
      control.releaseProbe = () => reply({ data, nextCursor: null });
      if (!control.holdProbe) control.releaseProbe();
      return;
    }
    if (request.method !== 'turn/interrupt') return original(socket, request);
    mock.requests.push(request);
    if (control.handleInterrupt) return control.handleInterrupt(socket, request);
    if (p.turnId !== control.currentId) {
      const [expected, found] = control.reverseIds ? [control.currentId, p.turnId] : [p.turnId, control.currentId];
      return socket.send(JSON.stringify({ id: request.id, error: { code: -32600,
        message: `expected active turn id ${expected} but found ${found}` } }));
    }
    reply({});
    const turn = mock.turns.get(p.threadId)!.find(turn => turn.id === p.turnId)!;
    turn.status = 'interrupted';
    mock.emit('turn/completed', { threadId: p.threadId, turn });
  };
  return control;
}

async function openRunning(page: Page) {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
}
const stops = (mock: MockCodex) => mock.requests.filter(request => request.method === 'turn/interrupt');
const probes = (mock: MockCodex) => mock.requests.filter(request => request.method === 'thread/turns/list' && request.params.limit === 1 && request.params.cursor === null);

for (const reverseIds of [false, true]) {
  test(`Stop confirms a missed newer native turn before retrying a mismatch (${reverseIds ? 'current ID first' : 'requested ID first'})`, async ({ page, mock }) => {
    const control = interruptWire(mock); control.reverseIds = reverseIds;
    await openRunning(page);
    control.advance();
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect.poll(() => stops(mock).map(request => request.params.turnId)).toEqual([oldId, newId]);
    expect(probes(mock)).toHaveLength(1);
    expect(probes(mock)[0]!.params).toMatchObject({ threadId, cursor: null, sortDirection: 'desc', itemsView: 'summary' });
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    await expect(page.locator('.global-error')).toHaveCount(0);
  });
}

test('a normal Stop stays immediate and does not read history', async ({ page, mock }) => {
  interruptWire(mock);
  await openRunning(page);
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  expect(stops(mock)).toHaveLength(1);
  expect(probes(mock)).toHaveLength(0);
});

test('repeated Stop clicks share the same confirmation instead of duplicating interruption requests', async ({ page, mock }) => {
  const control = interruptWire(mock); control.holdProbe = true;
  await openRunning(page); control.advance();
  const stop = page.getByRole('button', { name: '停止生成', exact: true });
  await stop.click(); await expect.poll(() => probes(mock).length).toBe(1);
  await stop.click();
  expect(stops(mock)).toHaveLength(1); expect(probes(mock)).toHaveLength(1);
  control.releaseProbe!();
  await expect(stop).toHaveCount(0);
  expect(stops(mock).map(request => request.params.turnId)).toEqual([oldId, newId]);
});

test('switching conversations while Stop confirms a mismatch prevents the retry and preserves the new view', async ({ page, mock }) => {
  const control = interruptWire(mock); control.holdProbe = true;
  mock.threads.push({ ...mock.threads[0]!, id: 'other-thread', name: '另一个运行中的会话' });
  mock.turns.set('other-thread', [makeTurn('other-turn')]);
  await openRunning(page); control.advance();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect.poll(() => probes(mock).length).toBe(1);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '另一个运行中的会话' }).first().click();
  await expect(page.locator('.main-header')).toContainText('另一个运行中的会话');
  control.releaseProbe!();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  expect(stops(mock)).toHaveLength(1);
  await expect(page.locator('.global-error')).toHaveCount(0);
});

test('a newer live turn supersedes the Stop confirmation and is never interrupted using an older probe', async ({ page, mock }) => {
  const control = interruptWire(mock); control.holdProbe = true;
  await openRunning(page); control.advance();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect.poll(() => probes(mock).length).toBe(1);
  control.advance(thirdId);
  mock.emit('turn/started', { threadId, turn: mock.turns.get(threadId)!.at(-1) });
  control.releaseProbe!();
  await expect(page.getByText('任务轮次已变化，请同步对话后再停止。', { exact: true })).toBeVisible();
  expect(stops(mock)).toHaveLength(1);
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
});

test('a second mismatch reports the change without looping or interrupting another turn', async ({ page, mock }) => {
  const control = interruptWire(mock);
  await openRunning(page); control.advance();
  control.handleInterrupt = (socket, request) => {
    const requested = request.params.turnId;
    socket.send(JSON.stringify({ id: request.id, error: { code: -32600,
      message: `expected active turn id ${requested} but found ${requested === oldId ? newId : thirdId}` } }));
  };
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.getByText('任务轮次已变化，请同步对话后再停止。', { exact: true })).toBeVisible();
  expect(stops(mock).map(request => request.params.turnId)).toEqual([oldId, newId]);
  expect(probes(mock)).toHaveLength(1);
});

test('a Stop timeout remains uncertain and never replays the mutation', async ({ page, mock }) => {
  const control = interruptWire(mock);
  control.handleInterrupt = () => {};
  await openRunning(page); await page.clock.install();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.clock.fastForward(45000);
  await expect(page.getByText(/turn\/interrupt 请求超时/, { exact: false })).toBeVisible();
  expect(stops(mock)).toHaveLength(1);
  expect(probes(mock)).toHaveLength(0);
});

test('history recovery selects the newest running turn when old history retained a stale inProgress marker', async ({ page, mock }) => {
  const control = interruptWire(mock);
  control.advance();
  mock.turns.get(threadId)!.find(turn => turn.id === oldId)!.status = 'inProgress';
  await openRunning(page);
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  expect(stops(mock).map(request => request.params.turnId)).toEqual([newId]);
  expect(probes(mock)).toHaveLength(0);
});

for (const pair of [[newId, thirdId], [oldId, oldId]]) {
  test(`a mismatched error pair ${pair.join(' / ')} never authorizes a retry`, async ({ page, mock }) => {
    const control = interruptWire(mock);
    control.handleInterrupt = (socket, request) => socket.send(JSON.stringify({ id: request.id,
      error: { code: -32600, message: `expected active turn id ${pair[0]} but found ${pair[1]}` } }));
    await openRunning(page);
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect(page.locator('.global-error')).toContainText('expected active turn id');
    expect(stops(mock)).toHaveLength(1); expect(probes(mock)).toHaveLength(0);
  });
}

test('a different or unconfirmed latest native turn cannot authorize interrupting the candidate', async ({ page, mock }) => {
  const control = interruptWire(mock);
  await openRunning(page); control.advance();
  mock.turns.get(threadId)!.at(-1)!.status = 'unknown';
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.getByText('任务轮次已变化，请同步对话后再停止。', { exact: true })).toBeVisible();
  expect(stops(mock)).toHaveLength(1); expect(probes(mock)).toHaveLength(1);
});

test('a native completion during Stop confirmation releases busy state without replaying the interruption', async ({ page, mock }) => {
  const control = interruptWire(mock); control.holdProbe = true;
  await openRunning(page); control.advance();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect.poll(() => probes(mock).length).toBe(1);
  const turn = mock.turns.get(threadId)!.at(-1)!; turn.status = 'completed';
  mock.emit('turn/completed', { threadId, turn });
  control.releaseProbe!();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await expect(page.locator('.global-error')).toHaveCount(0);
  expect(stops(mock)).toHaveLength(1);
});

for (const status of ['inProgress', 'completed']) {
  test(`a live third turn arriving before the conflict reply outranks ${status} history and cannot be overwritten or cleared`, async ({ page, mock }) => {
    const control = interruptWire(mock);
    let releaseConflict!: () => void;
    control.handleInterrupt = (socket, request) => {
      releaseConflict = () => socket.send(JSON.stringify({ id: request.id,
        error: { code: -32600, message: `expected active turn id ${request.params.turnId} but found ${newId}` } }));
    };
    await openRunning(page); control.advance();
    mock.turns.get(threadId)!.at(-1)!.status = status;
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect.poll(() => stops(mock).length).toBe(1);
    // The live event has advanced, while persisted history still trails it.
    mock.emit('turn/started', { threadId, turn: { ...makeTurn(thirdId), items: [
      { id: 'third-live-input', type: 'userMessage', content: [{ type: 'text', text: '第三轮实时任务' }] },
    ] } });
    await expect(page.getByText('第三轮实时任务', { exact: true })).toBeVisible();
    releaseConflict();
    await expect(page.getByText('任务轮次已变化，请同步对话后再停止。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
    expect(stops(mock)).toHaveLength(1);
    expect(probes(mock)).toHaveLength(0);
  });
}
