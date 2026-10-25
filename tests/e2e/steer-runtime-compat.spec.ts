import type { Page } from '@playwright/test';
import { test, expect, login, type MockCodex } from './fixtures';

const threadId = 'thread-existing';
const oldId = 'steer-cached-turn';
const nativeId = 'steer-native-turn';
const thirdId = 'steer-newer-live-turn';
const question = '即时补充：保留当前任务，优先处理手机布局';
const input = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const stop = (page: Page) => page.getByRole('button', { name: '停止生成', exact: true });
const steers = (mock: MockCodex) => mock.requests.filter(request => request.method === 'turn/steer');
const probes = (mock: MockCodex) => mock.requests.filter(request => request.method === 'thread/turns/list' && request.params.limit === 1 && request.params.cursor === null);
const makeTurn = (id: string, status = 'inProgress') => ({ id, status, itemsView: 'full', items: [] as any[] });

function steeringWire(mock: MockCodex) {
  const old = makeTurn(oldId);
  old.items.push({ id: 'steer-original-input', type: 'userMessage', content: [{ type: 'text', text: '原始任务' }] });
  mock.turns.get(threadId)!.push(old);
  mock.threads[0]!.status = { type: 'active' };
  const receive = (mock as any).receive.bind(mock);
  const control = {
    currentId: oldId,
    reverseIds: false,
    holdProbe: false,
    probeRelease: undefined as (() => void) | undefined,
    onSteer: undefined as ((socket: any, request: any) => void) | undefined,
    advance(id = nativeId) {
      mock.turns.get(threadId)!.at(-1)!.status = 'completed';
      mock.turns.get(threadId)!.push(makeTurn(id));
      control.currentId = id;
    },
    acknowledge(socket: any, request: any) {
      const turn = mock.turns.get(threadId)!.find(turn => turn.id === request.params.expectedTurnId)!;
      turn.items.push({ id: 'accepted-steer-native-item', clientId: request.params.clientUserMessageId,
        type: 'userMessage', content: request.params.input });
      // Codex 0.163 steering can acknowledge without a new turn/started or a
      // canonical user item. The existing active turn must remain usable.
      socket.send(JSON.stringify({ id: request.id, result: { turnId: turn.id } }));
    },
  };
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/turns/list' && request.params.limit === 1 && request.params.cursor === null) {
      mock.requests.push(request);
      const data = structuredClone(mock.turns.get(threadId)!.slice(-1).reverse());
      control.probeRelease = () => socket.send(JSON.stringify({ id: request.id, result: { data, nextCursor: null } }));
      if (!control.holdProbe) control.probeRelease();
      return;
    }
    if (request.method !== 'turn/steer') return receive(socket, request);
    mock.requests.push(request);
    if (control.onSteer) return control.onSteer(socket, request);
    if (request.params.expectedTurnId !== control.currentId) {
      const ids = control.reverseIds ? [control.currentId, request.params.expectedTurnId] : [request.params.expectedTurnId, control.currentId];
      return socket.send(JSON.stringify({ id: request.id, error: { code: -32600,
        message: `expected active turn id ${ids[0]} but found ${ids[1]}` } }));
    }
    control.acknowledge(socket, request);
  };
  return control;
}

async function openRunning(page: Page) {
  await login(page);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect(stop(page)).toBeVisible();
  await expect(input(page)).toHaveAttribute('aria-placeholder', /追加指令/);
}

async function sendSteer(page: Page) {
  await input(page).fill(question);
  await page.getByRole('button', { name: '追加指令', exact: true }).click();
}

test('an accepted 0.163 steering acknowledgement continues streaming without a new turn-start event', async ({ page, mock }) => {
  const control = steeringWire(mock);
  await openRunning(page);
  await sendSteer(page);
  await expect(input(page)).toHaveValue('');
  await expect(page.getByText(question, { exact: true })).toHaveCount(1);
  await expect(stop(page)).toBeVisible();
  const turn = mock.turns.get(threadId)!.at(-1)!;
  const agent = { id: 'steer-after-ack-agent', type: 'agentMessage', text: '已收到追加要求，继续原任务。', phase: 'commentary' };
  turn.items.push(agent);
  mock.emit('item/completed', { threadId, turnId: control.currentId, item: agent });
  await expect(page.getByText(agent.text, { exact: true })).toBeVisible();
  expect(steers(mock)).toHaveLength(1);
  expect(probes(mock)).toHaveLength(0);
  expect(mock.requests.some(request => ['turn/start', 'turn/interrupt'].includes(request.method || ''))).toBe(false);
});

for (const reverseIds of [false, true]) test(`steering confirms a missed native continuation once before reusing the same input (${reverseIds ? 'current first' : 'cached first'})`, async ({ page, mock }) => {
  const control = steeringWire(mock); control.reverseIds = reverseIds;
  await openRunning(page);
  control.advance();
  await sendSteer(page);
  await expect.poll(() => steers(mock).map(request => request.params.expectedTurnId)).toEqual([oldId, nativeId]);
  await expect(input(page)).toHaveValue('');
  await expect(page.getByText(question, { exact: true })).toHaveCount(1);
  await expect(stop(page)).toBeVisible();
  await expect(page.locator('.global-error')).toHaveCount(0);
  expect(probes(mock)).toHaveLength(1);
  expect(probes(mock)[0]!.params).toMatchObject({ threadId, cursor: null, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
  expect(steers(mock)[1]!.params).toMatchObject({ input: steers(mock)[0]!.params.input, clientUserMessageId: steers(mock)[0]!.params.clientUserMessageId });
  expect(mock.requests.some(request => ['turn/start', 'turn/interrupt'].includes(request.method || ''))).toBe(false);
});

test('a delayed recovered steering acknowledgement cannot revive an already completed turn', async ({ page, mock }) => {
  const control = steeringWire(mock);
  let acknowledge!: () => void;
  await openRunning(page); control.advance();
  control.onSteer = (socket, request) => {
    if (request.params.expectedTurnId === oldId) return socket.send(JSON.stringify({ id: request.id,
      error: { code: -32600, message: `expected active turn id ${oldId} but found ${nativeId}` } }));
    acknowledge = () => control.acknowledge(socket, request);
  };
  await sendSteer(page);
  await expect.poll(() => !!acknowledge).toBe(true);
  const turn = mock.turns.get(threadId)!.at(-1)!;
  turn.status = 'completed';
  mock.threads[0]!.status = { type: 'idle' };
  mock.emit('turn/completed', { threadId, turn });
  acknowledge();
  await expect(input(page)).toHaveValue('');
  await expect(stop(page)).toHaveCount(0);
  await expect(page.getByText(question, { exact: true })).toHaveCount(1);
  expect(steers(mock)).toHaveLength(2);
});

test('a third live turn during confirmation preserves the draft and blocks replay into a different task', async ({ page, mock }) => {
  const control = steeringWire(mock); control.holdProbe = true;
  await openRunning(page); control.advance();
  await sendSteer(page);
  await expect.poll(() => probes(mock).length).toBe(1);
  control.advance(thirdId);
  mock.emit('turn/started', { threadId, turn: mock.turns.get(threadId)!.at(-1) });
  control.probeRelease!();
  await expect(page.locator('.global-error')).toContainText('消息尚未发送');
  await expect(input(page)).toHaveValue(question);
  await expect(input(page)).toHaveAttribute('aria-placeholder', /追加指令/);
  await expect(page.getByRole('button', { name: '追加指令', exact: true })).toBeVisible();
  expect(steers(mock)).toHaveLength(1);
  expect(mock.requests.some(request => request.method === 'turn/start')).toBe(false);
});

test('a continuation that finished before confirmation never becomes a new turn/start', async ({ page, mock }) => {
  const control = steeringWire(mock);
  await openRunning(page); control.advance();
  mock.turns.get(threadId)!.at(-1)!.status = 'completed';
  await sendSteer(page);
  await expect(page.locator('.global-error')).toContainText('消息尚未发送');
  await expect(input(page)).toHaveValue(question);
  expect(steers(mock)).toHaveLength(1);
  expect(probes(mock)).toHaveLength(1);
  expect(mock.requests.some(request => request.method === 'turn/start')).toBe(false);
});

test('an uncertain steering failure does not resend the input even if its message contains a turn mismatch', async ({ page, mock }) => {
  const control = steeringWire(mock);
  control.onSteer = (socket, request) => socket.send(JSON.stringify({ id: request.id, error: { code: -32600,
    message: `expected active turn id ${oldId} but found ${nativeId}`, data: { uncertain: true } } }));
  await openRunning(page);
  await sendSteer(page);
  await expect(page.locator('.global-error')).toContainText('expected active turn id');
  await expect(input(page)).toHaveValue(question);
  expect(steers(mock)).toHaveLength(1);
  expect(probes(mock)).toHaveLength(0);
  expect(mock.requests.some(request => request.method === 'turn/start')).toBe(false);
});

test('changing conversations while confirming steering never sends it to the newly selected conversation', async ({ page, mock }) => {
  const control = steeringWire(mock); control.holdProbe = true;
  mock.threads.push({ ...mock.threads[0]!, id: 'other-steer-thread', name: '另一个即时引导会话' });
  mock.turns.set('other-steer-thread', [makeTurn('other-steer-active-turn')]);
  await openRunning(page); control.advance();
  await sendSteer(page);
  await expect.poll(() => probes(mock).length).toBe(1);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '另一个即时引导会话' }).first().click();
  await expect(page.locator('.main-header h1')).toHaveText('另一个即时引导会话');
  control.probeRelease!();
  await expect(stop(page)).toBeVisible();
  expect(steers(mock)).toHaveLength(1);
  expect(mock.requests.some(request => request.method === 'turn/start')).toBe(false);
});

for (const status of ['interrupted', 'failed']) test(`a ${status} 0.163 Code Mode turn settles tools whose individual completion notifications were missed`, async ({ page, mock }) => {
  steeringWire(mock);
  const turn = mock.turns.get(threadId)!.at(-1)!;
  const tools = [
    { id: 'stopped-code-mode', type: 'dynamicToolCall', namespace: 'functions', tool: 'exec', arguments: { command: 'nested()' }, status: 'inProgress' },
    { id: 'stopped-nested-command', type: 'commandExecution', command: 'long-running-command', aggregatedOutput: 'kept partial command output', status: 'inProgress' },
    { id: 'stopped-nested-mcp', type: 'mcpToolCall', server: 'remote', tool: 'long-query', status: 'inProgress' },
  ];
  turn.items.push(...tools);
  await openRunning(page);
  const block = page.locator(`.conversation-turn[data-turn-id="${oldId}"]`);
  await expect(block.locator('.activity-batch-status')).toContainText('3 项运行中');
  turn.status = status;
  mock.threads[0]!.status = { type: 'idle' };
  mock.emit('turn/completed', { threadId, turn: { ...turn, items: [] } });
  await expect(stop(page)).toHaveCount(0);
  await block.locator('.turn-activity > summary').click();
  const batch = block.locator('.activity-batch');
  await expect(batch.locator('.activity-batch-status')).toHaveText(status === 'failed' ? '3 项失败' : '3 项已停止');
  await expect(batch.locator('summary .spin')).toHaveCount(0);
  await batch.locator(':scope > summary').click();
  const command = batch.locator('.tool-item').filter({ hasText: 'long-running-command' });
  await command.locator(':scope > summary').click();
  await expect(command).toContainText('kept partial command output');
  expect(mock.requests.some(request => ['turn/start', 'turn/interrupt'].includes(request.method || ''))).toBe(false);
});
