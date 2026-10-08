import { test, expect, login } from './fixtures';
import type { Page } from '@playwright/test';

const guard = (page: Page) => page.evaluate(() => Boolean(history.state?.codexMobilePanel));
async function mobileThread(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click();
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
  await expect.poll(() => guard(page)).toBe(false);
}
async function browserBack(page: Page) {
  // This is the same history traversal produced by Chrome/Android Back.
  await page.evaluate(() => history.back());
}
for (const panel of ['sidebar', 'workspace'] as const) {
  test(`mobile Back closes the ${panel} without leaving the conversation or discarding its draft`, async ({ page, mock }) => {
    await mobileThread(page);
    const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
    await input.fill('返回手势保留草稿');
    const before = mock.requests.filter(request => request.method === 'thread/resume').length;
    const url = page.url();
    await page.getByRole('button', { name: panel === 'sidebar' ? '打开侧边栏' : '切换工作区', exact: true }).click();
    await expect.poll(() => guard(page)).toBe(true);
    await browserBack(page);
    if (panel === 'sidebar') await expect(page.locator('.sidebar')).not.toHaveClass(/mobile-open/);
    else await expect(page.locator('#workspace-panel')).toHaveCount(0);
    expect(page.url()).toBe(url);
    await expect(input).toHaveValue('返回手势保留草稿');
    await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible();
    await expect.poll(() => guard(page)).toBe(false);
    expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(before);
    expect(mock.request('turn/start')).toBeUndefined();
  });
}

test('closing by button or backdrop consumes the guard, repeated opens do not accumulate exit-blocking history', async ({ page }) => {
  await mobileThread(page);
  const before = await page.evaluate(() => history.length);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
    await expect.poll(() => guard(page)).toBe(true);
    if (i === 1) await page.locator('.sidebar-backdrop').click({ position: { x: 365, y: 400 } });
    else await page.getByRole('button', { name: '关闭侧边栏', exact: true }).click();
    await expect.poll(() => guard(page)).toBe(false);
  }
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await expect.poll(() => guard(page)).toBe(true);
  await page.getByRole('button', { name: '关闭工作区', exact: true }).click();
  await expect.poll(() => guard(page)).toBe(false);
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(before + 1);
  await page.evaluate(() => history.forward());
  await expect.poll(() => guard(page)).toBe(false);
  await expect(page.locator('.sidebar')).not.toHaveClass(/mobile-open/);
  await expect(page.locator('#workspace-panel')).toHaveCount(0);
});

test('mobile Back closes the top right panel then the left panel, while an immediate close/reopen stays open', async ({ page }) => {
  await mobileThread(page);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await expect.poll(() => guard(page)).toBe(true);
  // A project file action can replace navigation with the right workspace.
  await page.evaluate(() => (document.querySelector('[aria-label="切换工作区"]') as HTMLButtonElement).click());
  await expect(page.locator('#workspace-panel')).toBeVisible();
  await browserBack(page);
  await expect(page.locator('#workspace-panel')).toHaveCount(0);
  await expect(page.locator('.sidebar')).toHaveClass(/mobile-open/);
  await expect.poll(() => guard(page)).toBe(true);
  await browserBack(page);
  await expect(page.locator('.sidebar')).not.toHaveClass(/mobile-open/);
  await expect.poll(() => guard(page)).toBe(false);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await expect.poll(() => guard(page)).toBe(true);
  await page.evaluate(async () => {
    (document.querySelector('[aria-label="关闭侧边栏"]') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    (document.querySelector('[aria-label="切换工作区"]') as HTMLButtonElement).click();
  });
  await expect(page.locator('#workspace-panel')).toBeVisible();
  await expect.poll(() => guard(page)).toBe(true);
  await browserBack(page);
  await expect(page.locator('#workspace-panel')).toHaveCount(0);
  await expect.poll(() => guard(page)).toBe(false);
});

test('desktop panels leave browser history unchanged and resizing clears a mobile guard', async ({ page }) => {
  await login(page);
  const before = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  expect(await guard(page)).toBe(false);
  expect(await page.evaluate(() => history.length)).toBe(before);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => guard(page)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => guard(page)).toBe(false);
  await expect(page.locator('#workspace-panel')).toBeVisible();
});

test('mobile Back hides a side question and keeps its draft when reopened', async ({ page, mock }) => {
  await mobileThread(page);
  const text = page.locator('[data-selection-item-id="history-agent"]');
  await text.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: '在侧边聊天中提问', exact: true }).click();
  const question = page.getByRole('textbox', { name: '围绕引用内容提问', exact: true });
  await question.fill('稍后继续的侧边问题');
  await expect.poll(() => guard(page)).toBe(true);
  await browserBack(page);
  await expect(page.locator('#side-chat-panel')).not.toBeVisible();
  await expect.poll(() => guard(page)).toBe(false);
  await page.getByRole('button', { name: '打开侧边聊天', exact: true }).click();
  await expect(question).toHaveValue('稍后继续的侧边问题');
  expect(mock.request('thread/fork')).toBeUndefined();
  expect(mock.request('turn/start')).toBeUndefined();
});

test('after a panel is dismissed, another Back can leave the app normally', async ({ page }) => {
  await page.route('**/mobile-back-origin', route => route.fulfill({ contentType: 'text/html', body: '<p>Previous page</p>' }));
  await page.goto('/mobile-back-origin');
  await mobileThread(page);
  const appUrl = page.url();
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await expect.poll(() => guard(page)).toBe(true);
  await browserBack(page);
  await expect(page.locator('.sidebar')).not.toHaveClass(/mobile-open/);
  expect(page.url()).toBe(appUrl);
  await browserBack(page);
  await expect(page).toHaveURL(/\/mobile-back-origin$/);
});
