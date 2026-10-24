import { test, expect, login, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const sourceId = 'thread-existing';
function runningSource(mock: MockCodex, virtual = false) {
  const completed = structuredClone(mock.turns.get(sourceId)![0]);
  const active = { id: 'active-fork-turn', status: 'inProgress', itemsView: 'full', error: null, items: [
    { id: 'active-fork-user', type: 'userMessage', content: [{ type: 'text', text: '继续执行父任务' }] },
    ...(virtual ? Array.from({ length: 100 }, (_, i) => ({ id: `active-fork-command-${i}`, type: 'commandExecution', command: `echo ${i}`, aggregatedOutput: '', status: 'completed', exitCode: 0 })) : []),
    { id: 'active-fork-progress', type: 'agentMessage', phase: 'commentary', text: '父任务正在持续运行' },
  ] };
  mock.threads[0].status = { type: 'active' };
  mock.turns.set(sourceId, [completed, active]);
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/fork') {
      // Match the native boundary contract rather than accepting a bad active
      // lastTurnId in the generic fixture. Real CLI verification is separate.
      const selected = mock.turns.get(request.params.threadId)?.find(turn => turn.id === request.params.lastTurnId);
      if (selected?.status === 'inProgress') {
        mock.requests.push(request);
        return socket.send(JSON.stringify({ id: request.id, error: { code: -32602, message: 'Cannot fork through an in-progress lastTurnId' } }));
      }
      receive(socket, request);
      const branch = mock.threads.find(thread => thread.id.startsWith('fork-'));
      if (branch) for (const turn of mock.turns.get(branch.id) || []) if (turn.status === 'inProgress') turn.status = 'interrupted';
      return;
    }
    return receive(socket, request);
  };
  return { completed, active };
}
async function selectSource(page: Page) {
  const open = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await open.isVisible()) await open.click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect(page.getByRole('button', { name: /^(停止生成|追加指令)$/ })).toBeVisible();
}
async function checkBranch(page: Page, mock: MockCodex, includesActive = true) {
  await expect(page.getByRole('heading', { name: '分支测试对话', exact: true })).toBeVisible();
  const request = mock.request('thread/fork')!;
  expect(request.params).toMatchObject({ threadId: sourceId, excludeTurns: true, deferGoalContinuation: true });
  const branch = mock.threads.find(thread => thread.id.startsWith('fork-'))!;
  expect(mock.turns.get(branch.id)!.map(turn => turn.status)).toEqual(includesActive ? ['completed', 'interrupted'] : ['completed']);
  expect(mock.turns.get(sourceId)!.at(-1)!.status).toBe('inProgress');
  for (const method of ['turn/interrupt', 'turn/start', 'turn/steer', 'thread/goal/set', 'thread/goal/clear']) expect(mock.request(method)).toBeUndefined();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
}

for (const width of [1440, 390]) test(`${width}px header forks a running thread and its source keeps streaming`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 844 });
  const { active } = runningSource(mock);
  await login(page); await selectSource(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('父会话的独立草稿');
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建分支', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '压缩上下文', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '创建分支', exact: true }).click();
  await checkBranch(page, mock);
  expect(mock.request('thread/fork')!.params.lastTurnId).toBeUndefined();
  active.items.at(-1)!.text += ' · 分支后继续';
  mock.emit('item/agentMessage/delta', { threadId: sourceId, turnId: active.id, itemId: 'active-fork-progress', delta: ' · 分支后继续' });
  await selectSource(page);
  await expect(page.getByText('父任务正在持续运行 · 分支后继续', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('父会话的独立草稿');
});

for (const virtual of [false, true]) test(`current input forks an in-progress snapshot in ${virtual ? 'virtual' : 'normal'} history`, async ({ page, mock }) => {
  runningSource(mock, virtual); await login(page); await selectSource(page);
  if (virtual) {
    await expect(page.locator('[data-virtual-timeline]')).toBeVisible();
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
  }
  const input = page.locator('.user-message').filter({ hasText: '继续执行父任务' });
  await input.getByRole('button', { name: '从此处创建分支', exact: true }).click();
  await checkBranch(page, mock);
  expect(mock.request('thread/fork')!.params.lastTurnId).toBeUndefined();
});

test('a completed reply keeps its exact boundary while a later turn runs', async ({ page, mock }) => {
  const { completed } = runningSource(mock); await login(page); await selectSource(page);
  await page.locator('.agent-message').filter({ hasText: '历史保持可读' }).getByRole('button', { name: '从此处创建分支', exact: true }).click();
  await checkBranch(page, mock, false);
  expect(mock.request('thread/fork')!.params.lastTurnId).toBe(completed.id);
});

for (const preset of [false, true]) test(`${preset ? 'a command preset' : 'slash fork'} can branch during generation without sending a new model turn`, async ({ page, mock }) => {
  runningSource(mock);
  if (preset) {
    Object.assign(mock.promptPresets.presets[0], { name: '运行中分支', kind: 'command', content: '/fork', version: 1 });
    mock.promptPresets.revision = 1;
  }
  await login(page); await selectSource(page);
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill(preset ? '/1' : '/fork');
  await page.getByRole('option', { name: preset ? /\/1 · 运行中分支/ : /\/fork/ }).click();
  await checkBranch(page, mock);
});

test('a delayed message fork preserves the next conversation and its historical reading position', async ({ page, mock }) => {
  runningSource(mock);
  mock.threads.push({ ...mock.threads[0], id: 'reading-during-fork', name: '分支等待期间阅读', status: { type: 'idle' } });
  mock.turns.set('reading-during-fork', [{ id: 'reading-turn', status: 'completed', items: [
    { id: 'reading-answer', type: 'agentMessage', text: '应保留的历史位置\n\n' + '历史正文。\n\n'.repeat(140) },
  ] }]);
  const receive = (mock as any).receive.bind(mock);
  let release: (() => void) | undefined;
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'thread/fork') { release = () => receive(socket, request); return; }
    return receive(socket, request);
  };
  await login(page); await selectSource(page);
  await page.locator('.user-message').filter({ hasText: '继续执行父任务' }).getByRole('button', { name: '从此处创建分支', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '分支等待期间阅读' }).click();
  await expect(page.getByRole('heading', { name: '分支等待期间阅读', exact: true })).toBeVisible();
  const scroll = page.locator('.conversation-scroll');
  await scroll.evaluate(element => { element.scrollTop = 300; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('button', { name: '跳到最新消息', exact: true })).toBeVisible();
  const before = await scroll.evaluate(element => element.scrollTop);
  release!();
  await expect(page.locator('[data-section="recent"] .thread-row').filter({ hasText: '分支测试对话' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '分支等待期间阅读', exact: true })).toBeVisible();
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeCloseTo(before, 0);
  expect(mock.request('thread/resume')?.params.threadId).toBe('reading-during-fork');
});
