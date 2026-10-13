import type { Page } from '@playwright/test';
import { test, expect, login } from './fixtures';

const handle = (page: Page) => page.getByRole('separator', { name: '调整左侧栏宽度', exact: true });
const sidebar = (page: Page) => page.locator('.sidebar');
const width = async (page: Page) => Math.round((await sidebar(page).boundingBox())!.width);
const saved = (page: Page) => page.evaluate(() => localStorage.getItem('codex.sidebarWidth'));
async function drag(page: Page, delta: number, release = true) {
  const bounds = (await handle(page).boundingBox())!;
  const x = bounds.x + bounds.width / 2, y = bounds.y + 180;
  await page.mouse.move(x, y); await page.mouse.down();
  await expect(page.locator('.sidebar-drag-overlay')).toBeVisible();
  await page.mouse.move(x + delta, y, { steps: 8 });
  if (release) { await page.mouse.up(); await expect(page.locator('.sidebar-drag-overlay')).toHaveCount(0); }
}
async function usable(page: Page, minimum = 320) {
  const layout = await page.evaluate(() => ({ chat: document.querySelector('.main-column')!.getBoundingClientRect().width, page: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(layout.chat).toBeGreaterThanOrEqual(minimum - 1);
  expect(layout.page).toBeLessThanOrEqual(layout.viewport + 1);
}

test('left sidebar drag persists across collapse, reopen and reload while the workspace remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await login(page);
  await expect.poll(() => width(page)).toBe(246);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await drag(page, 114);
  await expect.poll(() => width(page)).toBe(360); expect(await saved(page)).toBe('360');
  await usable(page);
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  await expect(sidebar(page)).toBeHidden();
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  await expect.poll(() => width(page)).toBe(360);
  await page.reload(); await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  await expect.poll(() => width(page)).toBe(360);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click(); await usable(page);
});

test('left keyboard resize and reset respect width limits without changing the right-side preference', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await login(page);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  const right = page.getByRole('separator', { name: '调整工作区宽度', exact: true });
  await right.focus(); await page.keyboard.press('ArrowLeft');
  const rightSaved = await page.evaluate(() => localStorage.getItem('codex.workspaceWidth'));
  await handle(page).focus(); await page.keyboard.press('Home');
  await expect.poll(() => width(page)).toBe(180);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => width(page)).toBe(230);
  await page.keyboard.press('End'); await expect.poll(() => width(page)).toBe(480);
  await page.keyboard.press('ArrowRight'); await expect.poll(() => width(page)).toBe(480);
  await usable(page);
  expect(await page.evaluate(() => localStorage.getItem('codex.workspaceWidth'))).toBe(rightSaved);
  await handle(page).dblclick(); await expect.poll(() => width(page)).toBe(246); expect(await saved(page)).toBeNull();
});

test('sidebar preference survives a narrower viewport and the mobile drawer keeps its existing width and Back behavior', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await login(page); await drag(page, 180);
  expect(await saved(page)).toBe('426');
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page.setViewportSize({ width: 820, height: 900 });
  await expect.poll(() => width(page)).toBe(270); await usable(page, 240);
  expect(await saved(page)).toBe('426');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle(page)).toBeHidden();
  await page.getByRole('button', { name: '关闭工作区', exact: true }).click();
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await expect.poll(() => width(page)).toBe(310);
  await expect(sidebar(page)).toHaveClass(/mobile-open/);
  await page.goBack(); await expect(sidebar(page)).not.toHaveClass(/mobile-open/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => width(page)).toBe(426); expect(await saved(page)).toBe('426'); await usable(page);
});

test('Escape cancels only the current sidebar drag and accidental capture loss retains its last visible width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await login(page);
  const original = await page.evaluate(() => ({ cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }));
  await drag(page, 84, false); await expect.poll(() => width(page)).toBe(330);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(() => width(page)).toBe(246); expect(await saved(page)).toBeNull();
  await drag(page, 84, false);
  await handle(page).evaluate(element => element.releasePointerCapture(1));
  await page.mouse.move((await handle(page).boundingBox())!.x, 181);
  await expect(page.locator('.sidebar-drag-overlay')).toHaveCount(0); await page.mouse.up();
  await expect.poll(() => width(page)).toBe(330); expect(await saved(page)).toBe('330');
  expect(await page.evaluate(() => ({ cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }))).toEqual(original);
});

test('left resize keeps the last pointer-up position and preserves desktop dimensions when storage is unavailable', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 }); await login(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); }; });
  const bounds = (await handle(page).boundingBox())!, x = bounds.x + bounds.width / 2, y = bounds.y + 180;
  await page.mouse.move(x, y); await page.mouse.down();
  await handle(page).dispatchEvent('pointerup', { pointerId: 1, button: 0, clientX: x + 100, clientY: y });
  await page.mouse.up();
  await expect.poll(() => width(page)).toBe(346); await expect(page.locator('.sidebar-drag-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  await expect.poll(() => width(page)).toBe(346);
  expect(errors).toEqual([]);
});

test('both panels retain their preferred widths while resizing each other and narrowing the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 }); await login(page);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  const right = page.getByRole('separator', { name: '调整工作区宽度', exact: true });
  const rightWidth = async () => Math.round((await page.locator('.resizable-workspace:visible').boundingBox())!.width);
  await right.focus(); await page.keyboard.press('End');
  const rightSaved = await page.evaluate(() => localStorage.getItem('codex.workspaceWidth'));
  await drag(page, 180);
  await expect.poll(() => width(page)).toBe(426);
  await expect.poll(rightWidth).toBe(854); await usable(page);
  await page.setViewportSize({ width: 820, height: 900 });
  await expect.poll(() => width(page)).toBe(270);
  await expect.poll(rightWidth).toBe(310); await usable(page, 240);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(() => width(page)).toBe(426); await expect.poll(rightWidth).toBe(854);
  expect(await saved(page)).toBe('426');
  expect(await page.evaluate(() => localStorage.getItem('codex.workspaceWidth'))).toBe(rightSaved);
});
