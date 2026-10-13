import { test, expect, login, send } from './fixtures';
import type { Page } from '@playwright/test';

const menu = (page: Page) => page.getByRole('dialog', { name: '上下文用量与压缩' });
const indicator = (page: Page) => page.locator('.composer-submit .context-usage');
const existingRow = (page: Page) => page.locator('[data-section="recent"] .nav-thread[data-host-id="local"]')
  .filter({ hasText: '已有测试历史' }).locator('.thread-row');

test('desktop context opens usage details without compacting or moving the conversation, then explicitly compacts', async ({ page, mock }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await existingRow(page).click();
  mock.emit('thread/tokenUsage/updated', { threadId: 'thread-existing', tokenUsage: {
    last: { totalTokens: 218000 }, total: { totalTokens: 9000000 }, modelContextWindow: 500000,
  } });
  await expect(indicator(page)).toHaveText('上下文 44%');
  const message = page.getByText('历史保持可读', { exact: true });
  const beforeMessage = await message.boundingBox();
  const beforeComposer = await page.locator('.composer-area').boundingBox();
  await indicator(page).click();
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).locator('.context-token-count')).toHaveText('218k / 500ktokens');
  await expect(menu(page).locator('.context-token-count')).toHaveAttribute('title', '218,000 / 500,000 tokens');
  await expect(menu(page).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '44');
  expect(mock.request('thread/compact/start')).toBeUndefined();
  expect(await message.boundingBox()).toEqual(beforeMessage);
  expect(await page.locator('.composer-area').boundingBox()).toEqual(beforeComposer);
  await menu(page).screenshot({ path: '.data/context-usage-menu-desktop.png' });
  await menu(page).getByRole('button', { name: '立即压缩', exact: true }).click();
  await expect.poll(() => mock.request('thread/compact/start')?.params.threadId).toBe('thread-existing');
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator('.compaction-divider')).toContainText('上下文已压缩');
});

test('running tasks can inspect live context measurements while compaction remains disabled until completion', async ({ page, mock }) => {
  mock.holdFinalMessage = true;
  await login(page);
  await send(page, '保持运行以查看上下文');
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  const threadId = mock.request('turn/start')!.params.threadId;
  mock.emit('thread/tokenUsage/updated', { threadId, tokenUsage: {
    last: { totalTokens: 218000 }, modelContextWindow: 500000,
  } });
  await expect(indicator(page)).toHaveText('上下文 44%');
  await expect(indicator(page)).toBeEnabled();
  await indicator(page).click();
  await expect(menu(page)).toContainText('218k / 500k');
  await expect(menu(page)).toContainText('任务结束后可压缩上下文');
  await expect(menu(page).getByRole('button', { name: '立即压缩', exact: true })).toBeDisabled();
  mock.emit('thread/tokenUsage/updated', { threadId, tokenUsage: {
    last: { totalTokens: 225000 }, modelContextWindow: 500000,
  } });
  await expect(menu(page)).toContainText('225k / 500k');
  await expect(menu(page).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
  expect(mock.request('thread/compact/start')).toBeUndefined();
  expect(mock.request('turn/interrupt')).toBeUndefined();
  mock.finishStream();
  await expect(menu(page).getByRole('button', { name: '立即压缩', exact: true })).toBeEnabled();
  await expect(menu(page)).not.toContainText('任务结束后可压缩上下文');
});

test('context menu closes on outside clicks, Escape, conversation changes and logout without carrying old usage', async ({ page, mock }) => {
  mock.threads.push({ ...mock.threads[0], id: 'thread-second', name: '第二个上下文会话' });
  mock.turns.set('thread-second', []);
  await login(page);
  await existingRow(page).click();
  await indicator(page).click();
  await expect(menu(page)).toContainText('Codex 尚未报告当前上下文用量');
  await page.getByText('历史保持可读', { exact: true }).click();
  await expect(menu(page)).toHaveCount(0);
  await indicator(page).click();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(indicator(page)).toBeFocused();
  await indicator(page).click();
  await page.locator('[data-section="recent"] .nav-thread[data-host-id="local"]').filter({ hasText: '第二个上下文会话' })
    .locator('.thread-row').evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByRole('heading', { name: '第二个上下文会话', exact: true })).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await indicator(page).click();
  await page.getByRole('button', { name: /^设置(?: |$)/ }).evaluate((element: HTMLButtonElement) => element.click());
  await page.getByRole('button', { name: '账户', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(menu(page)).toBeVisible();
  await page.getByRole('button', { name: '退出网页', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  expect(mock.request('thread/compact/start')).toBeUndefined();
});

test('new conversations explain unavailable compaction and switching to mobile restores direct compaction', async ({ page, mock }) => {
  await login(page);
  await indicator(page).click();
  await expect(menu(page)).toContainText('新对话尚未使用上下文');
  await expect(menu(page)).toContainText('先开始一个对话，再压缩上下文');
  await expect(menu(page).getByRole('button', { name: '立即压缩', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(menu(page)).toHaveCount(0);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await existingRow(page).click();
  await indicator(page).click();
  await expect.poll(() => mock.request('thread/compact/start')?.params.threadId).toBe('thread-existing');
  await expect(menu(page)).toHaveCount(0);
});

test('a narrow desktop conversation wraps its tools without overlap, keeps context accessible and repeated send clicks never stop the task', async ({ page, mock }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  mock.holdFinalMessage = true;
  await login(page);
  await existingRow(page).click();
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  const handle = page.getByRole('separator', { name: '调整工作区宽度', exact: true });
  await handle.focus();
  await page.keyboard.press('End');
  mock.emit('thread/tokenUsage/updated', { threadId: 'thread-existing', tokenUsage: {
    last: { totalTokens: 218000 }, modelContextWindow: 500000,
  } });
  await expect(indicator(page)).toHaveText('上下文 44%');
  async function expectControlsFit() {
    const layout = await page.locator('.composer-toolbar').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll('.composer-tools > .icon-button, .composer-tools > .composer-select, .composer-submit > button, .composer-submit > .composer-select')]
        .map(control => {
          const box = control.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        }).filter(box => box.width > 0 && box.height > 0);
      return { left: bounds.left, right: bounds.right, width: bounds.width, controls };
    });
    expect(layout.width).toBeLessThan(240);
    for (const control of layout.controls) {
      expect(control.left).toBeGreaterThanOrEqual(layout.left - 1);
      expect(control.right).toBeLessThanOrEqual(layout.right + 1);
    }
    for (let first = 0; first < layout.controls.length; first++) {
      for (const second of layout.controls.slice(first + 1)) {
        const control = layout.controls[first]!;
        const overlaps = Math.min(control.right, second.right) - Math.max(control.left, second.left) > 1 &&
          Math.min(control.bottom, second.bottom) - Math.max(control.top, second.top) > 1;
        expect(overlaps, 'visible tool controls must not cover each other').toBe(false);
      }
    }
  }
  await expectControlsFit();
  await indicator(page).click();
  await expect(menu(page)).toContainText('218k / 500k');
  await page.keyboard.press('Escape');
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('窄列继续任务');
  const before = (await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox())!;
  const x = before.x + before.width / 2, y = before.y + before.height / 2;
  await page.mouse.click(x, y);
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await page.waitForTimeout(120);
  await page.mouse.click(x, y);
  await page.waitForTimeout(120);
  expect(mock.request('turn/interrupt')).toBeUndefined();
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  await expectControlsFit();
  const current = (await page.getByRole('button', { name: '追加指令', exact: true }).boundingBox())!;
  expect(current.x + current.width).toBeCloseTo(before.x + before.width, 0);
  expect(current.y + current.height).toBeCloseTo(before.y + before.height, 0);
  await indicator(page).click();
  await expect(menu(page)).toContainText('任务结束后可压缩上下文');
  await expect(menu(page).getByRole('button', { name: '立即压缩', exact: true })).toBeDisabled();
});
