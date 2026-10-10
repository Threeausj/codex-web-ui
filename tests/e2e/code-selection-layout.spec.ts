import type { Locator, Page } from '@playwright/test';
import { test, expect, login } from './fixtures';

const sourcePath = '/workspace/demo/selection-layout.ts';
const source = Array.from({ length: 1200 }, (_, index) => `export const row${String(index + 1).padStart(4, '0')} = 'line ${index + 1}';`).join('\n');

async function nextPaint(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function viewport(scroller: Locator) {
  return scroller.evaluate(element => {
    const box = element.getBoundingClientRect();
    const first = [...element.querySelectorAll<HTMLElement>('.cm-line')].find(line => {
      const rect = line.getBoundingClientRect();
      return rect.bottom > box.top + 1 && rect.top < box.bottom - 1;
    });
    return { top: box.top, height: box.height, width: box.width, scrollTop: element.scrollTop, firstLine: first?.textContent };
  });
}

async function expectUnmoved(scroller: Locator, before: Awaited<ReturnType<typeof viewport>>) {
  const after = await viewport(scroller);
  expect(after.top).toBeCloseTo(before.top, 0);
  expect(after.height).toBeCloseTo(before.height, 0);
  expect(after.width).toBeCloseTo(before.width, 0);
  expect(after.scrollTop).toBeCloseTo(before.scrollTop, 0);
  expect(after.firstLine).toBe(before.firstLine);
}

async function selectCode(page: Page, editor: Locator) {
  await editor.press('Shift+ArrowRight');
  await editor.press('Shift+ArrowRight');
  await editor.press('Shift+ArrowRight');
  await nextPaint(page);
}

for (const size of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow tablet panel', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${size.name}: file selection actions stay below the editor without moving the scrolled viewport`, async ({ page, mock }) => {
    const receive = (mock as any).receive.bind(mock);
    (mock as any).receive = (socket: any, request: any) => {
      if (request.params?.path === sourcePath) {
        if (request.method === 'fs/getMetadata') return socket.send(JSON.stringify({ id: request.id, result: { isDirectory: false, isFile: true } }));
        if (request.method === 'fs/readFile') return socket.send(JSON.stringify({ id: request.id, result: { dataBase64: Buffer.from(source).toString('base64') } }));
      }
      return receive(socket, request);
    };
    mock.turns.get('thread-existing')![0].items[1].text = `[长源码](${sourcePath})`;
    await page.setViewportSize({ width: size.width, height: size.height });
    await login(page);
    if (size.width <= 760) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
    await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click();
    await page.getByRole('link', { name: '长源码', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'selection-layout.ts 文件内容', exact: true });
    const scroller = page.locator('#workspace-panel .cm-scroller');
    const toolbar = page.locator('#workspace-panel .code-selection-toolbar');
    await expect(editor).toBeVisible();
    await expect(page.locator('#workspace-panel').getByRole('button', { name: '添加到对话', exact: true })).toHaveCount(0);
    await scroller.evaluate(element => { element.scrollTop = 1400; });
    await nextPaint(page);
    await expect.poll(async () => {
      const value = await viewport(scroller);
      return value.scrollTop > 1000 && value.firstLine !== source.split('\n')[0];
    }).toBe(true);
    const line = await scroller.evaluate(element => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll<HTMLElement>('.cm-line')].find(candidate => {
        const rect = candidate.getBoundingClientRect();
        return rect.top >= box.top + box.height / 3 && rect.bottom <= box.top + box.height * 2 / 3;
      })?.textContent;
    });
    expect(line).toBeTruthy();
    await page.locator('#workspace-panel .cm-line').filter({ hasText: line! }).click({ position: { x: 85, y: 6 } });
    await editor.press('Home');
    await editor.press('ArrowRight');
    await editor.press('ArrowRight');
    await nextPaint(page);
    const before = await viewport(scroller);
    expect(before.height).toBeGreaterThan(200);
    const inactiveBox = await toolbar.boundingBox();
    expect(inactiveBox).toBeTruthy();
    expect(inactiveBox!.y).toBeGreaterThanOrEqual(before.top + before.height - 1);
    const add = toolbar.getByRole('button', { name: '添加到对话', exact: true });
    const ask = toolbar.getByRole('button', { name: '在侧边聊天中提问', exact: true });
    for (let index = 0; index < 3; index++) {
      await selectCode(page, editor);
      await expect(add).toBeVisible();
      await expect(ask).toBeVisible();
      await expectUnmoved(scroller, before);
      const [bar, panel, addBox, askBox] = await Promise.all([toolbar.boundingBox(), page.locator('#workspace-panel').boundingBox(), add.boundingBox(), ask.boundingBox()]);
      expect(bar!.y).toBeGreaterThanOrEqual(before.top + before.height - 1);
      expect(bar!.height).toBeCloseTo(inactiveBox!.height, 0);
      expect(addBox!.x).toBeGreaterThanOrEqual(panel!.x);
      expect(askBox!.x + askBox!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
      expect(askBox!.y + askBox!.height).toBeLessThanOrEqual(panel!.y + panel!.height + 1);
      await editor.press('ArrowRight');
      await nextPaint(page);
      await expect(add).toBeHidden();
      await expect(ask).toBeHidden();
      await expectUnmoved(scroller, before);
    }
    await selectCode(page, editor);
    await add.click();
    await expect(page.locator('.composer-quote')).toContainText('selection-layout.ts');
    if (!await page.locator('#workspace-panel').isVisible()) {
      await page.getByRole('link', { name: '长源码', exact: true }).click();
      await expect(editor).toBeVisible();
      await page.locator('#workspace-panel .cm-line').first().click();
      await editor.press('Home');
      await selectCode(page, editor);
    }
    await expect(page.locator('#workspace-panel')).toBeVisible();
    await expect(ask).toBeVisible();
    if (process.env.EDITOR_TOOLBAR_SCREENSHOT_DIR && (size.name === 'desktop' || size.name === 'mobile')) {
      await page.locator('#workspace-panel').screenshot({ path: `${process.env.EDITOR_TOOLBAR_SCREENSHOT_DIR}/editor-toolbar-${size.name}.png` });
    }
    await ask.click();
    await expect(page.getByRole('region', { name: '侧边聊天', exact: true })).toBeVisible();
    const quote = page.locator('.side-chat-quote blockquote');
    await expect(quote).toContainText(/\S/);
    expect(source).toContain((await quote.textContent())!);
    await expect(page.getByRole('textbox', { name: '围绕引用内容提问', exact: true })).toBeFocused();
    expect(mock.requests.some(request => request.method === 'turn/start')).toBe(false);
    expect(mock.requests.some(request => request.method === 'fs/writeFile')).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
