import { test, expect, login, send, type MockCodex } from './fixtures';
import type { Page } from '@playwright/test';

const input = (page: Page) => page.getByRole('textbox', { name: '消息输入框', exact: true });
const stop = (page: Page) => page.getByRole('button', { name: '停止生成', exact: true });
const interruptions = (mock: MockCodex) => mock.requests.filter(request => request.method === 'turn/interrupt');

function holdUntilStopped(mock: MockCodex) {
  mock.holdFinalMessage = true;
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'turn/interrupt') return receive(socket, request);
    mock.requests.push(request);
    socket.send(JSON.stringify({ id: request.id, result: {} }));
    const { threadId, turnId } = request.params;
    const turn = mock.turns.get(threadId)!.find(turn => turn.id === turnId)!;
    turn.status = 'interrupted';
    mock.emit('turn/completed', { threadId, turn });
  };
}

async function tapSendTwice(page: Page, buttonName: string, mock: MockCodex) {
  const button = page.getByRole('button', { name: buttonName, exact: true });
  const before = (await button.boundingBox())!;
  const x = before.x + before.width / 2, y = before.y + before.height / 2;
  const tap = () => page.viewportSize()!.width < 760 ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
  await tap();
  await expect(input(page)).toHaveValue('');
  await expect(stop(page)).toBeVisible();
  await page.waitForTimeout(120);
  await tap();
  await page.waitForTimeout(120);
  expect(interruptions(mock), 'a second tap at the former send position must not stop the task').toHaveLength(0);
  await expect(stop(page)).toBeVisible();
}

async function explicitlyStop(page: Page, mock: MockCodex) {
  const threadId = mock.request('turn/start')!.params.threadId;
  const turnId = mock.turns.get(threadId)!.at(-1)!.id;
  await stop(page).click();
  await expect.poll(() => interruptions(mock).map(request => request.params)).toEqual([{ threadId, turnId }]);
  await expect(stop(page)).toHaveCount(0);
  await expect(input(page)).toBeEnabled();
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) test.describe(`Stop button stability at ${viewport.width}px`, () => {
  test.use({ hasTouch: viewport.width < 760 });
  test(`consecutive send taps preserve the new task while an explicit Stop remains immediate at ${viewport.width}px`, async ({ page, mock }) => {
    await page.setViewportSize(viewport);
    holdUntilStopped(mock);
    await login(page);
    await input(page).fill('开始检查这个项目');
    await tapSendTwice(page, '发送消息', mock);
    expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    await explicitlyStop(page, mock);
  });

  test(`consecutive steering taps preserve the current task and Stop still works at ${viewport.width}px`, async ({ page, mock }) => {
    await page.setViewportSize(viewport);
    holdUntilStopped(mock);
    await login(page);
    await send(page, '开始检查这个项目');
    await expect(input(page)).toHaveValue('');
    await expect(stop(page)).toBeVisible();
    await input(page).fill('补充：请检查手机布局');
    await tapSendTwice(page, '追加指令', mock);
    expect(mock.requests.filter(request => request.method === 'turn/steer')).toHaveLength(1);
    expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    await explicitlyStop(page, mock);
  });

  test(`active conversations cannot be archived from sidebar or header menus at ${viewport.width}px`, async ({ page, mock }) => {
    await page.setViewportSize(viewport);
    const threadId = 'thread-existing';
    mock.threads[0]!.status = { type: 'active' };
    mock.turns.get(threadId)!.push({ id: 'running-archive-guard', status: 'inProgress', items: [], itemsView: 'full' });
    await login(page);
    const openSidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
    if (await openSidebar.isVisible()) await openSidebar.click();
    const row = page.locator('[data-section="recent"] .nav-thread').filter({ hasText: '已有测试历史' });
    await row.locator('.nav-row-menu').click();
    await expect(row.getByRole('button', { name: '归档对话', exact: true })).toBeDisabled();
    await row.getByRole('button', { name: '关闭菜单', exact: true }).click();
    await row.locator('.thread-row').click();
    await expect(stop(page)).toBeVisible();
    await page.getByRole('button', { name: '对话操作', exact: true }).click();
    await expect(page.locator('.thread-menu').getByRole('button', { name: '归档对话', exact: true })).toBeDisabled();
    expect(mock.request('thread/archive')).toBeUndefined();
    const turn = mock.turns.get(threadId)!.at(-1)!;
    turn.status = 'completed';
    mock.emit('turn/completed', { threadId, turn });
    mock.threads[0]!.status = { type: 'idle' };
    mock.emit('thread/status/changed', { threadId, status: { type: 'idle' } });
    await expect(page.locator('.thread-menu').getByRole('button', { name: '归档对话', exact: true })).toBeEnabled();
  });
});
