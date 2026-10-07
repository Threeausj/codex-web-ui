import { test, expect, login, type MockCodex } from './fixtures';
import type { WebSocketRoute } from '@playwright/test';

const threadId = 'thread-existing';
const secondId = 'history-other';
async function open(page: any, name = '已有测试历史') {
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: name }).first().click();
}
function pagedHistory(mock: MockCodex, count = 360) {
  mock.threads.push({ ...mock.threads[0], id: secondId, name: '历史性能另一个对话' });
  mock.turns.set(secondId, []);
  const turns = Array.from({ length: count }, (_, index) => ({ id: `history-${index}`, status: 'completed', items: [
    { id: `answer-${index}`, type: 'agentMessage', text: `历史轮次 ${index}` },
  ] }));
  mock.turns.set(threadId, turns);
  const original = (mock as any).receive.bind(mock);
  const control = { holdOlder: false, held: [] as { socket: WebSocketRoute; request: any }[] };
  const replyPage = (socket: WebSocketRoute, request: any) => {
    const all = [...(mock.turns.get(threadId) || [])].reverse();
    const offset = Number(request.params.cursor || 0);
    socket.send(JSON.stringify({ id: request.id, result: { data: all.slice(offset, offset + 30),
      nextCursor: offset + 30 < all.length ? String(offset + 30) : null } }));
  };
  (mock as any).receive = (socket: WebSocketRoute, request: any) => {
    if (request.method !== 'thread/turns/list' || request.params.threadId !== threadId) return original(socket, request);
    mock.requests.push(request);
    if (control.holdOlder && request.params.cursor) control.held.push({ socket, request });
    else replyPage(socket, request);
  };
  return { turns, control, release: () => { control.holdOlder = false; for (const { socket, request } of control.held.splice(0)) replyPage(socket, request); } };
}

test('reselecting a loaded 360-round conversation retains its oldest history and validates only the latest page', async ({ page, mock }) => {
  pagedHistory(mock);
  await login(page); await open(page);
  await expect(page.getByText('历史轮次 359', { exact: true })).toBeVisible();
  for (let index = 0; index < 11; index++) {
    await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
    await expect(page.getByText(`历史轮次 ${330 - 30 * (index + 1)}`, { exact: true })).toHaveCount(1);
  }
  await expect(page.getByText('历史轮次 0', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '加载更早的消息', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('保留原草稿');
  await open(page, '历史性能另一个对话');
  const before = mock.requests.length;
  await open(page);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(page.getByText('历史轮次 0', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '加载更早的消息', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('保留原草稿');
  expect(mock.requests.slice(before).filter(request => request.method === 'thread/turns/list' && request.params.threadId === threadId)).toHaveLength(1);
});

test('an invalid cached anchor confirms the latest writer before older revalidation and does not resurrect native reverted turns', async ({ page, mock }) => {
  const { control, release, turns } = pagedHistory(mock);
  await login(page); await open(page);
  for (let index = 0; index < 2; index++) await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
  await open(page, '历史性能另一个对话');
  mock.turns.set(threadId, turns.slice(0, 120));
  control.holdOlder = true;
  await open(page);
  await expect(page.getByText('历史轮次 119', { exact: true })).toBeVisible();
  await expect(page.getByText('历史轮次 359', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('同步最新历史后可发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect.poll(() => control.held.length).toBe(1);
  release();
  await expect(page.getByText('历史轮次 30', { exact: true })).toHaveCount(1);
  await expect(page.getByText('历史轮次 359', { exact: true })).toHaveCount(0);
  expect(mock.request('turn/start')).toBeUndefined();
});

test('an app-server engine change refreshes mode and skill capabilities without requiring logout or host switching', async ({ page, mock }) => {
  const original = (mock as any).receive.bind(mock);
  let upgraded = false;
  (mock as any).receive = (socket: WebSocketRoute, request: any) => {
    const reply = (result: any) => socket.send(JSON.stringify({ id: request.id, result }));
    if (request.method === 'collaborationMode/list') {
      mock.requests.push(request);
      return reply({ data: upgraded ? [{ mode: 'plan' }] : [{ mode: 'default' }] });
    }
    if (request.method === 'thread/goal/get') {
      mock.requests.push(request);
      return upgraded ? reply({ goal: null }) : socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Method not found' } }));
    }
    if (request.method === 'skills/list') {
      mock.requests.push(request);
      return reply({ data: [{ cwd: request.params.cwds[0], skills: upgraded ? [
        { name: 'upgraded-skill', path: '/test/skills/upgraded/SKILL.md', enabled: true, description: '升级后技能' },
      ] : [] }] });
    }
    return original(socket, request);
  };
  await login(page);
  mock.emit('bridge/status', { connected: true, engineId: 'before-upgrade', eventSequence: 0, pendingRequests: [] });
  const before = mock.requests.length;
  upgraded = true;
  mock.emit('bridge/status', { connected: true, engineId: 'after-upgrade', eventSequence: 0, pendingRequests: [] });
  await expect.poll(() => mock.requests.slice(before).filter(request => request.method === 'collaborationMode/list').length).toBe(1);
  await expect.poll(() => mock.requests.slice(before).filter(request => request.method === 'skills/list').length).toBe(1);
  const input = page.getByRole('textbox', { name: '消息输入框' });
  await input.fill('/upgraded');
  await expect(page.getByRole('listbox', { name: '对话指令' })).toContainText('upgraded-skill');
  await input.fill('@plan');
  await expect(page.getByRole('option').filter({ hasText: 'Plan' })).toBeEnabled();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('temporary mode probe errors retry rather than permanently declaring native modes unsupported', async ({ page, mock }) => {
  const original = (mock as any).receive.bind(mock);
  let probes = 0;
  (mock as any).receive = (socket: WebSocketRoute, request: any) => {
    if (request.method === 'collaborationMode/list') {
      mock.requests.push(request); probes++;
      return socket.send(JSON.stringify({ id: request.id, ...(probes === 1
        ? { error: { code: -32000, message: 'Temporary startup unavailable' } }
        : { result: { data: [{ mode: 'plan' }] } }) }));
    }
    if (request.method === 'thread/goal/get') {
      mock.requests.push(request);
      return socket.send(JSON.stringify({ id: request.id, result: { goal: null } }));
    }
    return original(socket, request);
  };
  await login(page);
  await expect.poll(() => probes, { timeout: 7000 }).toBe(2);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('@plan');
  await expect(page.getByRole('option').filter({ hasText: 'Plan' })).toBeEnabled();
  expect(mock.request('turn/start')).toBeUndefined();
});
