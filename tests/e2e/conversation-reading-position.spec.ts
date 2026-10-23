import { test, expect, login, MockCodex } from './fixtures';
import type { Page, WebSocketRoute } from '@playwright/test';

const threadId = 'thread-existing';
const gap = (page: Page) => page.locator('.conversation-scroll').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
function history(mock: MockCodex, name = '阅读位置会话', active = true) {
  mock.threads[0] = { ...mock.threads[0], name, status: { type: active ? 'active' : 'idle' } };
  const turns = Array.from({ length: 24 }, (_, index) => ({
    id: `reading-${index}`, status: active && index === 23 ? 'inProgress' : 'completed', itemsView: 'full',
    items: [{ id: `reading-agent-${index}`, type: 'agentMessage', phase: index === 23 && active ? 'commentary' : 'final_answer',
      text: Array.from({ length: 5 }, (_, line) => `阅读位置 ${index} 第 ${line} 行，有意保留内容以验证上下文中的阅读位置。`).join('\n\n') }],
  }));
  mock.turns.set(threadId, turns);
  return turns;
}
function other(mock: MockCodex) {
  mock.threads.push({ ...mock.threads[0], id: 'reading-other', name: '另一个阅读会话', status: { type: 'idle' } });
  mock.turns.set('reading-other', []);
}
async function select(page: Page, label: string, hostId = 'local') {
  const open = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await open.isVisible()) await open.click();
  await page.locator(`[data-section="recent"] [data-host-id="${hostId}"] .thread-row`).filter({ hasText: label }).click();
  await expect(page.locator('.main-header h1')).toHaveText(label);
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
}
async function readHistory(page: Page) {
  const position = await page.locator('.conversation-scroll').evaluate(element => {
    const block = element.querySelector<HTMLElement>('[data-history-id="reading-8"]')!;
    element.scrollTop += block.getBoundingClientRect().top - element.getBoundingClientRect().top - 35;
    element.dispatchEvent(new Event('scroll'));
    return element.scrollTop;
  });
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  return position;
}
const anchorOffset = (page: Page) => page.locator('.conversation-scroll').evaluate(element =>
  element.querySelector('[data-history-id="reading-8"]')!.getBoundingClientRect().top - element.getBoundingClientRect().top);
function append(mock: MockCodex, turns: any[], text: string) {
  turns[23].items[0].text += text;
  mock.emit('item/agentMessage/delta', { threadId, turnId: 'reading-23', itemId: 'reading-agent-23', delta: text });
}

for (const width of [1440, 390]) {
  test(`${width}px: leaving at the latest answer follows new output when returning to a running chat`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 844 });
    const turns = history(mock); other(mock);
    await login(page); await select(page, '阅读位置会话');
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
    await select(page, '另一个阅读会话');
    append(mock, turns, '\n\n' + '离开期间的新进展。\n\n'.repeat(40));
    await select(page, '阅读位置会话');
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
    // Horizontal table gestures and attempting to scroll beyond the latest
    // answer must not disable following when no historical reading occurred.
    await page.locator('.conversation-scroll').dispatchEvent('wheel', { deltaX: 180, deltaY: 0 });
    append(mock, turns, '\n\n' + '横向滚动后继续跟随。\n\n'.repeat(20));
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
    await page.locator('.conversation-scroll').dispatchEvent('wheel', { deltaX: 0, deltaY: 180 });
    append(mock, turns, '\n\n' + '最底部向下滚动后继续跟随。\n\n'.repeat(20));
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
    await page.locator('.conversation-scroll').evaluate(element => {
      const gesture = (type: string, x: number, y: number) => element.dispatchEvent(new TouchEvent(type, {
        bubbles: true, touches: [new Touch({ identifier: 1, target: element, clientX: x, clientY: y })],
      }));
      gesture('touchstart', 100, 300); gesture('touchmove', 250, 305); // Wide-table horizontal drag.
      gesture('touchstart', 100, 300); gesture('touchmove', 100, 200); // Toward the latest answer.
    });
    append(mock, turns, '\n\n' + '返回后持续输出。\n\n'.repeat(40));
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
    expect(mock.request('turn/start')).toBeUndefined();
  });

  test(`${width}px: historical reading restores its anchor after earlier content grows and streaming never steals the position`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 844 });
    const turns = history(mock); other(mock);
    await login(page); await select(page, '阅读位置会话');
    const top = await readHistory(page), offset = await anchorOffset(page);
    await select(page, '另一个阅读会话');
    turns[0].items[0].text += '\n\n' + '更早轮次补齐后的历史记录。\n\n'.repeat(30);
    await select(page, '阅读位置会话');
    await expect.poll(() => anchorOffset(page)).toBeCloseTo(offset, 0);
    expect(await page.locator('.conversation-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(top + 300);
    append(mock, turns, '\n\n' + '底部持续输出，历史阅读应保持。\n\n'.repeat(30));
    await expect.poll(() => anchorOffset(page)).toBeCloseTo(offset, 0);
    await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '跳到最新消息', exact: true }).click();
    append(mock, turns, '\n\n' + '恢复跟随最新进展。\n\n'.repeat(30));
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  });
}

test('matching thread IDs on different hosts keep independent follow-latest and historical positions', async ({ page, mock }) => {
  history(mock, '本机历史阅读');
  const remote = new MockCodex(), turns = history(remote, '远端最新进展');
  mock.hosts.push({ id: 'reading-remote', name: 'Reading Remote', kind: 'ssh', cwd: '/srv/reading' });
  mock.hostMocks.set('reading-remote', remote);
  await login(page); await select(page, '本机历史阅读');
  await readHistory(page);
  const offset = await anchorOffset(page);
  await select(page, '远端最新进展', 'reading-remote');
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  await select(page, '本机历史阅读');
  await expect.poll(() => anchorOffset(page)).toBeCloseTo(offset, 0);
  append(remote, turns, '\n\n' + '切主机期间远端继续输出。\n\n'.repeat(40));
  await select(page, '远端最新进展', 'reading-remote');
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  await select(page, '本机历史阅读');
  await expect.poll(() => anchorOffset(page)).toBeCloseTo(offset, 0);
});

test('late process-detail layout stays at the latest answer after the thread itself is already ready', async ({ page, mock }) => {
  const turns = history(mock);
  const commands = Array.from({ length: 60 }, (_, index) => ({ id: `late-command-${index}`, type: 'commandExecution', command: `echo operation-${index}`, status: 'completed', exitCode: 0, aggregatedOutput: 'done' }));
  turns[23].items.unshift(...commands as any[]);
  const original = (mock as any).receive.bind(mock);
  let release: (() => void) | undefined;
  (mock as any).receive = (socket: WebSocketRoute, request: any) => {
    if (request.method === 'thread/turns/list') {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, result: { data: [...turns].reverse().map(turn => turn.id !== 'reading-23' ? turn : {
        ...turn, itemsView: 'summary', items: turn.items.filter((item: any) => item.type === 'agentMessage'),
      }), nextCursor: null } }));
    }
    if (request.method === 'thread/items/list') {
      mock.requests.push(request);
      release = () => socket.send(JSON.stringify({ id: request.id, result: { data: turns[23].items.map(item => ({ turnId: 'reading-23', item })), nextCursor: null } }));
      return;
    }
    original(socket, request);
  };
  await login(page); await select(page, '阅读位置会话');
  await expect.poll(() => !!release).toBe(true);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  release!();
  await expect(page.locator('[data-virtual-timeline]')).toBeVisible();
  await expect.poll(() => page.locator('.tool-item').count()).toBeGreaterThan(0);
  expect(await page.locator('.tool-item').count()).toBeLessThan(60);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
});

test('a first-send conversation follows its new streaming output without a prior saved position', async ({ page, mock }) => {
  await login(page);
  mock.holdFinalMessage = true;
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('从新会话开始');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params.threadId).toBeTruthy();
  const request = mock.request('turn/start')!, thread = request.params.threadId;
  const turn = mock.turns.get(thread)!.at(-1)!;
  mock.emit('item/agentMessage/delta', { threadId: thread, turnId: turn.id, itemId: `agent-${turn.id}`, delta: '\n\n' + '新会话实时输出。\n\n'.repeat(80) });
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
});
