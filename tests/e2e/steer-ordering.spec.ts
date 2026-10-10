import type { Page } from '@playwright/test';
import { test, expect, login } from './fixtures';

const threadId = 'thread-existing';
const turnId = 'steer-order-active-turn';
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];
const progressText = '追加消息之前的工作进展';
const steerText = '工作中途追加的约束';
const afterText = '接受追加约束之后的工作进展';
const turnGroup = (page: Page) => page.locator(`.conversation-turn[data-turn-id="${turnId}"]`);

function activeTurn(mock: any) {
  const turn = { id: turnId, status: 'inProgress', startedAt: 1791200002, completedAt: null, durationMs: null, itemsView: 'full', items: [
    { id: 'order-initial-user', type: 'userMessage', content: input('本轮最初的要求') },
    { id: 'order-progress', type: 'agentMessage', phase: 'commentary', text: progressText },
    { id: 'order-command', type: 'commandExecution', command: 'printf before-steer', status: 'completed', exitCode: 0, aggregatedOutput: 'before-steer' },
  ] as any[] };
  mock.turns.get(threadId).push(turn);
  mock.threads[0].status = { type: 'active' };
  return turn;
}

async function openActive(page: Page) {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveAttribute('placeholder', /追加指令/);
  await expect(page.getByText(progressText, { exact: true })).toBeVisible();
}

async function expectChronology(page: Page, after = false) {
  await expect(page.getByText(steerText, { exact: true })).toHaveCount(1);
  await expect(page.getByText(steerText, { exact: true })).toBeVisible();
  await expect(page.getByText(progressText, { exact: true })).toBeVisible();
  if (after) await expect(page.getByText(afterText, { exact: true })).toBeVisible();
  const order = await turnGroup(page).locator('.message').evaluateAll(elements => elements.map(element => element.textContent || ''));
  const progress = order.findIndex(text => text.includes(progressText));
  const steer = order.findIndex(text => text.includes(steerText));
  expect(progress).toBeGreaterThanOrEqual(0);
  expect(steer).toBeGreaterThan(progress);
  if (after) expect(order.findIndex(text => text.includes(afterText))).toBeGreaterThan(steer);
}

async function cachedSteer(page: Page, clientId: string) {
  return page.evaluate(async ({ clientId, threadId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('codex-private-conversations', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains('snapshots')) return null;
      const records: any[] = await new Promise((resolve, reject) => {
        const request = db.transaction('snapshots').objectStore('snapshots').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const item = records.filter(record => record.threadId === threadId).flatMap(record => record.items)
        .find(item => item.clientId === clientId);
      return item ? { status: item.status ?? null, turnId: item.turnId ?? null } : null;
    } finally { db.close(); }
  }, { clientId, threadId });
}

test('local steering retains its chronological position through optimistic rendering, native alias, confirmation and history reload', async ({ page, mock }) => {
  const turn = activeTurn(mock);
  const receive = (mock as any).receive.bind(mock);
  let held: { socket: any; request: any } | undefined;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'turn/steer') {
      mock.requests.push(request);
      held = { socket, request };
      return;
    }
    return receive(socket, request);
  };
  await openActive(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill(steerText);
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await expect.poll(() => !!held).toBe(true);
  await expectChronology(page);
  const user = { id: 'order-steer-canonical', clientId: held!.request.params.clientUserMessageId, type: 'userMessage', content: input(steerText) };
  turn.items.push(user);
  mock.emit('item/completed', { threadId, turnId, item: user });
  await expect(page.locator('[data-selection-item-id="order-steer-canonical"]')).toBeVisible();
  await expectChronology(page);
  held!.socket.send(JSON.stringify({ id: held!.request.id, result: { turnId } }));
  await expectChronology(page);
  const after = { id: 'order-progress-after', type: 'agentMessage', phase: 'commentary', text: afterText };
  turn.items.push(after);
  mock.emit('item/completed', { threadId, turnId, item: after });
  await expect(page.getByText(after.text, { exact: true })).toBeVisible();
  const order = await page.locator('.message').evaluateAll(elements => elements.map(element => element.textContent || ''));
  expect(order.findIndex(text => text.includes(steerText))).toBeLessThan(order.findIndex(text => text.includes(after.text)));
  await page.reload();
  await expect(page.getByText(progressText, { exact: true })).toBeVisible();
  await expectChronology(page);
  expect(mock.requests.filter(request => request.method === 'turn/steer')).toHaveLength(1);
  expect(mock.requests.some(request => request.method === 'turn/start')).toBe(false);
});

test('steering confirmed by another web client stays after preceding progress before and after native history hydration', async ({ page, mock }) => {
  const turn = activeTurn(mock);
  await openActive(page);
  const change = { threadId, method: 'turn/steer', changeId: 'steer-order:remote', result: { turnId }, request: { input: input(steerText), clientUserMessageId: 'order-remote-client' } };
  mock.emit('bridge/thread/changed', change);
  await expectChronology(page);
  const user = { id: 'order-remote-canonical', clientId: 'order-remote-client', type: 'userMessage', content: input(steerText) };
  turn.items.push(user);
  mock.emit('item/completed', { threadId, turnId, item: user });
  await expect(page.locator('[data-selection-item-id="order-remote-canonical"]')).toBeVisible();
  await expectChronology(page);
  await page.reload();
  await expect(page.getByText(progressText, { exact: true })).toBeVisible();
  await expectChronology(page);
  expect(mock.requests.some(request => ['turn/start', 'turn/steer'].includes(request.method || ''))).toBe(false);
});

test('a response-only steering acknowledgment clears the optimistic status without hiding or moving it before the native alias arrives', async ({ page, mock }) => {
  const turn = activeTurn(mock);
  const receive = (mock as any).receive.bind(mock);
  let held: { socket: any; request: any } | undefined;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'turn/steer') return receive(socket, request);
    mock.requests.push(request);
    held = { socket, request };
  };
  await openActive(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill(steerText);
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
  await expect.poll(() => !!held).toBe(true);
  // Neither a request reply nor a canonical notification has arrived yet.
  await expectChronology(page);
  const clientId = held!.request.params.clientUserMessageId;
  held!.socket.send(JSON.stringify({ id: held!.request.id, result: { turnId } }));
  await expect.poll(() => cachedSteer(page, clientId)).toEqual({ status: null, turnId });
  await expectChronology(page);
  const after = { id: 'order-response-after', type: 'agentMessage', phase: 'commentary', text: afterText };
  turn.items.push(after);
  mock.emit('item/completed', { threadId, turnId, item: after });
  await expectChronology(page, true);
  const user = { id: 'order-response-canonical', clientId, type: 'userMessage', content: input(steerText) };
  turn.items.splice(turn.items.indexOf(after), 0, user);
  mock.emit('item/completed', { threadId, turnId, item: user });
  await expect(page.locator('[data-selection-item-id="order-response-canonical"]')).toBeVisible();
  await expectChronology(page, true);
  await page.reload();
  await expectChronology(page, true);
  expect(mock.requests.filter(request => request.method === 'turn/steer')).toHaveLength(1);
});

test('two web clients retain live steering and its neighboring progress through repeated summarized syncs and a collapsed completion', async ({ page, context, mock }) => {
  const turn = activeTurn(mock);
  const receive = (mock as any).receive.bind(mock);
  let summarize = false;
  let summaryReads = 0;
  const heldDetails: { socket: any; request: any }[] = [];
  (mock as any).receive = (socket: any, request: any) => {
    if (!summarize || !['thread/turns/list', 'thread/items/list'].includes(request.method)) return receive(socket, request);
    mock.requests.push(request);
    if (request.method === 'thread/items/list') {
      // Loading details must not conceal a bad summary merge in this regression.
      heldDetails.push({ socket, request });
      return;
    }
    summaryReads++;
    const data = [...(mock.turns.get(request.params.threadId) || [])].reverse().map((entry: any) => ({
      ...entry, itemsView: 'summary', items: [
        entry.items.find((item: any) => item.type === 'userMessage'),
        entry.items.filter((item: any) => item.type === 'agentMessage').at(-1),
      ].filter(Boolean),
    }));
    socket.send(JSON.stringify({ id: request.id, result: { data, nextCursor: null } }));
  };
  await openActive(page);
  const other = await context.newPage();
  await mock.install(other);
  await other.goto('/');
  await expect(other.getByText(progressText, { exact: true })).toBeVisible();
  const draft = other.getByRole('textbox', { name: '消息输入框', exact: true });
  await draft.fill('观察端的草稿应当保留');
  const change = { threadId, method: 'turn/steer', changeId: 'steer-order:summary', result: { turnId },
    request: { input: input(steerText), clientUserMessageId: 'order-summary-client' } };
  mock.emit('bridge/thread/changed', change);
  const after = { id: 'order-summary-after', type: 'agentMessage', phase: 'commentary', text: afterText };
  turn.items.push(after);
  mock.emit('item/completed', { threadId, turnId, item: after });
  for (const target of [page, other]) await expectChronology(target, true);
  summarize = true;
  // No new item revision occurs between these validations. Native summaries
  // intentionally omit the accepted steering message and earlier progress.
  for (let round = 0; round < 2; round++) {
    for (const target of [page, other]) {
      const reads = summaryReads;
      await target.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click();
      await expect.poll(() => summaryReads).toBeGreaterThan(reads);
      await expect(target.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveAttribute('placeholder', /追加指令/);
      await expectChronology(target, true);
      await expect(turnGroup(target).locator('.turn-activity > summary')).toHaveCount(1);
      expect(await turnGroup(target).locator('.activity-loading').count()).toBeLessThanOrEqual(1);
    }
  }
  await expect(draft).toHaveValue('观察端的草稿应当保留');
  const answer = { id: 'order-summary-final', type: 'agentMessage', phase: 'final_answer', text: '包含追加要求的最终答复' };
  turn.items.push(answer);
  turn.status = 'completed';
  turn.completedAt = 1791200010;
  turn.durationMs = 8000;
  mock.threads[0].status = { type: 'idle' };
  // The completion snapshot also lacks the accepted input. Its omission must
  // preserve the live input's existing place, rather than append it after output.
  mock.emit('turn/completed', { threadId, turn });
  for (const target of [page, other]) {
    await expect(target.getByText(answer.text, { exact: true })).toBeVisible();
    await expect(target.getByText(steerText, { exact: true })).toBeVisible();
    await expect(target.getByText(steerText, { exact: true })).toHaveCount(1);
    await expect(turnGroup(target).locator('.turn-activity[open]')).toHaveCount(0);
    await expect(turnGroup(target).locator('.turn-activity > summary')).toHaveCount(1);
    const visible = await turnGroup(target).locator('.message').evaluateAll(elements => elements.map(element => element.textContent || ''));
    expect(visible.findIndex(text => text.includes(steerText))).toBeLessThan(visible.findIndex(text => text.includes(answer.text)));
    await turnGroup(target).locator('.turn-activity > summary').click();
    await expectChronology(target, true);
  }
  expect(mock.requests.some(request => ['turn/start', 'turn/steer'].includes(request.method || ''))).toBe(false);
  await other.close();
});
