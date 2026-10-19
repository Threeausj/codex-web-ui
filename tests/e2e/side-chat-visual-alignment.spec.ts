import type { Locator, Page } from '@playwright/test';
import { test, expect, login, MockCodex } from './fixtures';

const sideId = 'visual-side-branch';
function sideBranch(mock: MockCodex) {
  const receive = (mock as any).receive.bind(mock);
  (mock as any).receive = (socket: any, request: any) => {
    if (request.method === 'turn/interrupt' && request.params?.threadId === sideId) {
      mock.requests.push(request);
      const turn = mock.turns.get(sideId)!.find(turn => turn.id === request.params.turnId)!;
      turn.status = 'interrupted';
      socket.send(JSON.stringify({ id: request.id, result: {} }));
      mock.emit('turn/completed', { threadId: sideId, turn });
      return;
    }
    if (request.method === 'thread/fork' && request.params?.ephemeral) {
      mock.requests.push(request);
      const source = mock.threads.find(thread => thread.id === request.params.threadId)!;
      mock.turns.set(sideId, []);
      socket.send(JSON.stringify({ id: request.id, result: {
        thread: { ...source, id: sideId, ephemeral: true, forkedFromId: source.id, turns: [] },
        model: mock.config.model, reasoningEffort: 'medium', sandbox: { type: 'readOnly' },
      } }));
      return;
    }
    return receive(socket, request);
  };
}

async function openSide(page: Page) {
  await login(page);
  if ((page.viewportSize()?.width || 1280) <= 760)
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建侧边聊天', exact: true }).click();
  await expect(page.locator('.side-chat-panel')).toBeVisible();
}

async function appearance(element: Locator) {
  return element.evaluate(node => {
    const value = getComputedStyle(node);
    return {
      radius: value.borderRadius, border: value.borderWidth,
      background: value.backgroundColor, color: value.color,
      padding: value.padding, resize: value.resize,
    };
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} side chat matches main header and input shape, with a distinct primary button`, async ({ page, mock }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(() => localStorage.setItem('codex.workspaceWidth', '750'));
    sideBranch(mock);
    await openSide(page);
    const mainHeader = (await page.locator('.main-header').boundingBox())!;
    const sideHeader = (await page.locator('.side-chat-heading').boundingBox())!;
    expect(sideHeader.y).toBe(mainHeader.y);
    expect(sideHeader.height).toBe(mainHeader.height);
    const main = page.locator('.main-column .composer-area');
    const side = page.locator('.side-chat-composer');
    const mainBox = (await main.boundingBox())!;
    const sideBox = (await side.boundingBox())!;
    expect(Math.abs(mainBox.y + mainBox.height - sideBox.y - sideBox.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(mainBox.height - sideBox.height)).toBeLessThanOrEqual(1);
    const mainStyle = await appearance(main);
    const sideStyle = await appearance(side);
    expect(sideStyle.radius).toBe(mainStyle.radius);
    expect(sideStyle.border).toBe(mainStyle.border);
    expect(sideStyle.background).toBe(mainStyle.background);
    expect((await appearance(page.locator('.side-chat-composer-body'))).padding)
      .toBe((await appearance(page.locator('.main-column .composer'))).padding);
    const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
    expect((await appearance(input)).resize).toBe('none');
    await input.fill('保留同样形状的侧边输入框');
    await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('保留同样形状的主输入框');
    const mainButton = page.getByRole('button', { name: '发送消息', exact: true });
    const sideButton = page.getByRole('button', { name: '发送侧边问题', exact: true });
    const mainButtonBox = (await mainButton.boundingBox())!;
    const sideButtonBox = (await sideButton.boundingBox())!;
    expect(sideButtonBox.height).toBe(mainButtonBox.height);
    expect(sideButtonBox.width).toBe(mainButtonBox.width);
    expect(Math.abs(sideButtonBox.y - mainButtonBox.y)).toBeLessThanOrEqual(1);
    expect((await appearance(sideButton)).background).not.toBe((await appearance(mainButton)).background);
    await page.screenshot({ path: test.info().outputPath(`side-chat-${theme}-aligned.png`) });
  });

  test(`${theme} mobile side chat retains the main input frame and accessible controls with the keyboard open`, async ({ page, mock }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    sideBranch(mock);
    await openSide(page);
    const mainHeader = (await page.locator('.main-header').boundingBox())!;
    const sideHeader = (await page.locator('.side-chat-heading').boundingBox())!;
    expect(sideHeader.height).toBe(mainHeader.height);
    expect((await appearance(page.locator('.side-chat-composer'))).radius)
      .toBe((await appearance(page.locator('.main-column .composer-area'))).radius);
    const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
    await input.fill('手机侧边提问');
    await page.setViewportSize({ width: 390, height: 400 });
    await input.fill('短屏上也能继续输入\n'.repeat(12));
    await expect(input).toBeInViewport();
    await expect(page.getByRole('button', { name: '发送侧边问题', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: '结束侧边聊天', exact: true })).toBeInViewport();
    await page.locator('.side-chat-context-details > summary').click();
    await expect(page.locator('.side-chat-context-description')).toBeVisible();
    for (const height of [400, 360, 320]) {
      await page.setViewportSize({ width: 390, height });
      const contextBox = (await page.locator('.side-chat-context-description').boundingBox())!;
      expect(contextBox.y).toBeGreaterThanOrEqual(sideHeader.height);
      expect(contextBox.y + contextBox.height).toBeLessThanOrEqual(height);
      await expect(input).toBeInViewport();
      await expect(page.getByRole('button', { name: '发送侧边问题', exact: true })).toBeInViewport();
      await expect(page.getByRole('button', { name: '结束侧边聊天', exact: true })).toBeInViewport();
    }
    expect(await page.locator('.side-chat-panel').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`side-chat-${theme}-keyboard.png`) });
  });
}

test('side context and branch controls stay at the bottom while long answers scroll; send, stop and close still work', async ({ page, mock }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  sideBranch(mock);
  mock.holdFinalMessage = true;
  await openSide(page);
  const input = page.getByRole('textbox', { name: '基于当前对话提问', exact: true });
  await input.fill('查看长回答');
  await page.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  const stop = page.getByRole('button', { name: '停止侧边回答', exact: true });
  await expect(stop).toBeVisible();
  const turn = mock.turns.get(sideId)!.at(-1)!;
  mock.emit('item/completed', { threadId: sideId, turnId: turn.id,
    item: { id: 'long-side-answer', type: 'agentMessage', text: '可滚动的侧边回答。\n\n'.repeat(80) } });
  await expect(page.locator('.side-chat-transcript')).toContainText('可滚动的侧边回答');
  const toolbar = page.locator('.side-chat-context-controls');
  const before = (await toolbar.boundingBox())!;
  const transcript = page.locator('.side-chat-transcript');
  expect(await transcript.evaluate(node => node.scrollHeight > node.clientHeight + 100)).toBe(true);
  await transcript.evaluate(node => { node.scrollTop = 0; });
  await expect(page.getByRole('button', { name: '另开侧边分支', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '保存并置顶正式分支', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '引用回答到主对话', exact: true })).toBeInViewport();
  await transcript.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const after = (await toolbar.boundingBox())!;
  expect(after.y).toBe(before.y);
  await input.fill('运行时仍能保存草稿');
  await stop.click();
  await expect(stop).toHaveCount(0);
  expect(mock.requests.filter(request => request.method === 'turn/interrupt').map(request => request.params.threadId)).toEqual([sideId]);
  await expect(input).toHaveValue('运行时仍能保存草稿');
  await page.getByRole('button', { name: '结束侧边聊天', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '结束侧边聊天？', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(input).toHaveValue('运行时仍能保存草稿');
});
