import { test, expect, login } from './fixtures';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=', 'base64');
const inlinePng = `data:image/png;base64,${png.toString('base64')}`;
const largeImage = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#467458"/></svg>';

async function openExisting(page: import('@playwright/test').Page) {
  await login(page);
  if (await page.getByRole('button', { name: '打开侧边栏', exact: true }).isVisible()) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeVisible();
}

function preview(page: import('@playwright/test').Page) { return page.getByRole('dialog', { name: /上传的图片|result\.png|local\.png|Markdown 图|网页图|missing\.png/ }); }

test('uploaded images open above the conversation with zoom controls and restore focus and draft on close', async ({ page, mock }) => {
  mock.turns.get('thread-existing')![0].items[0].content.push({ type: 'image', url: inlinePng });
  await openExisting(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('保留输入草稿');
  const button = page.getByRole('button', { name: '放大上传的图片', exact: true });
  await button.click();
  const viewer = preview(page);
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('img')).toHaveAttribute('src', inlinePng);
  await expect(viewer.locator('.image-viewer-zoom')).toHaveText('100%');
  await viewer.getByRole('button', { name: '放大图片', exact: true }).click();
  await expect(viewer.locator('.image-viewer-zoom')).toHaveText('125%');
  await viewer.getByRole('button', { name: '适应窗口', exact: true }).click();
  await expect(viewer.locator('.image-viewer-zoom')).toHaveText('100%');
  await page.keyboard.press('Control+Shift+O');
  await expect(viewer).toBeVisible();
  await expect(page.locator('h1')).toContainText('已有测试历史');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(button).toBeFocused();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('保留输入草稿');
  await expect(page.locator('.workspace-panel')).not.toBeVisible();
  expect(mock.requests.some(request => request.method === 'fs/readFile')).toBe(false);
});

test('local and Markdown pictures use the existing authenticated image URL and never open the workspace', async ({ page, mock }) => {
  await page.route('**/api/hosts/*/images?*', route => route.fulfill({ contentType: 'image/svg+xml', body: largeImage }));
  await page.route('https://images.example/result.png', route => route.fulfill({ contentType: 'image/png', body: png }));
  mock.turns.get('thread-existing')![0].items[0].content.push({ type: 'localImage', path: '/workspace/demo/local.png' });
  mock.turns.get('thread-existing')![0].items[1].text = '![Markdown 图](./result.png)\n\n![网页图](https://images.example/result.png)\n\n[普通文件](/workspace/demo/README.md)';
  await openExisting(page);
  await page.getByRole('button', { name: '查看图片 local.png', exact: true }).click();
  let viewer = preview(page);
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('img')).toHaveAttribute('src', '/api/hosts/local/images?path=%2Fworkspace%2Fdemo%2Flocal.png');
  await viewer.getByRole('button', { name: '原始尺寸', exact: true }).click();
  await expect(viewer.locator('.image-viewer-zoom')).toHaveText('100%');
  await expect.poll(() => viewer.locator('img').evaluate(element => element.getBoundingClientRect().width)).toBe(1600);
  await viewer.getByRole('button', { name: '适应窗口', exact: true }).click();
  expect(await viewer.locator('img').evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(1600);
  await page.screenshot({ path: '.data/chat-image-viewer-desktop.png' });
  await viewer.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  const markdown = page.getByRole('button', { name: '放大图片 Markdown 图', exact: true });
  await markdown.focus();
  await page.keyboard.press('Enter');
  viewer = preview(page);
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('img')).toHaveAttribute('src', '/api/hosts/local/images?path=%2Fworkspace%2Fdemo%2Fresult.png');
  await page.keyboard.press('Escape');
  await expect(markdown).toBeFocused();
  const remote = page.getByRole('button', { name: '放大图片 网页图', exact: true });
  await remote.focus();
  await page.keyboard.press('Space');
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator('img')).toHaveAttribute('src', 'https://images.example/result.png');
  await page.keyboard.press('Escape');
  await expect(page.locator('.workspace-panel')).not.toBeVisible();
  expect(mock.requests.some(request => request.method === 'fs/readFile')).toBe(false);
  await page.getByRole('link', { name: '普通文件', exact: true }).click();
  await expect(page.locator('.workspace-panel')).toBeVisible();
  await expect.poll(() => mock.requests.some(request => request.method === 'fs/readFile')).toBe(true);
});

test('generated and viewed images open the same viewer while failed images show a recoverable error', async ({ page, mock }) => {
  await page.route('**/api/hosts/*/images?*', route => {
    const path = new URL(route.request().url()).searchParams.get('path') || '';
    return path.includes('missing') ? route.fulfill({ status: 404, json: { error: 'Not found' } }) : route.fulfill({ contentType: 'image/png', body: png });
  });
  mock.turns.get('thread-existing')![0].items[0].content.push({ type: 'localImage', path: '/workspace/demo/missing.png' });
  mock.turns.get('thread-existing')![0].items.splice(1, 0,
    { id: 'generated-image', type: 'imageGeneration', savedPath: '/workspace/demo/result.png', status: 'completed' },
    { id: 'viewed-image', type: 'imageView', path: '/workspace/demo/local.png', status: 'completed' });
  await openExisting(page);
  await page.getByRole('button', { name: '查看图片 missing.png', exact: true }).click();
  await expect(preview(page)).toContainText('图片无法加载，文件可能已被移动或删除。');
  await page.mouse.click(1, 1);
  await expect(preview(page)).toBeHidden();
  await page.locator('.turn-activity > summary').click();
  await page.locator('.activity-batch > summary').click();
  const generated = page.locator('.tool-item').filter({ hasText: '生成图片' });
  await generated.locator('summary').click();
  await generated.getByRole('button', { name: '查看图片 result.png', exact: true }).click();
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press('Escape');
  const viewed = page.locator('.tool-item').filter({ has: page.locator('.tool-title').filter({ hasText: /^查看图片$/ }) });
  await viewed.locator('summary').click();
  await viewed.getByRole('button', { name: '查看图片 local.png', exact: true }).click();
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.workspace-panel')).not.toBeVisible();
});

test('mobile dark preview fits the viewport and Android Back closes the picture without leaving the conversation', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('codex.theme', 'dark'));
  await page.route('**/api/hosts/*/images?*', route => route.fulfill({ contentType: 'image/svg+xml', body: largeImage }));
  mock.turns.get('thread-existing')![0].items[0].content.push({ type: 'localImage', path: '/workspace/demo/local.png' });
  await openExisting(page);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('手机草稿');
  await page.getByRole('button', { name: '查看图片 local.png', exact: true }).click();
  const viewer = preview(page);
  await expect(viewer).toBeVisible();
  await expect.poll(() => viewer.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1600);
  const bounds = await viewer.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  expect(await viewer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: '.data/chat-image-viewer-mobile-dark.png' });
  await page.evaluate(() => history.back());
  await expect(viewer).toBeHidden();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('手机草稿');
  await expect(page.locator('h1')).toContainText('已有测试历史');
});

test('conversation navigation removes an open private image preview', async ({ page, mock }) => {
  const original = mock.threads[0]!;
  mock.threads.push({ ...original, id: 'thread-other', name: '另一个会话', preview: '另一个会话' });
  mock.turns.set('thread-other', [{ ...mock.turns.get('thread-existing')![0], id: 'turn-other', items: [{ id: 'other-agent', type: 'agentMessage', text: '新的会话内容' }] }]);
  mock.turns.get('thread-existing')![0].items[0].content.push({ type: 'image', url: inlinePng });
  await openExisting(page);
  await page.getByRole('button', { name: '放大上传的图片', exact: true }).click();
  await expect(preview(page)).toBeVisible();
  // Navigation can arrive from another app integration while a native modal is open.
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '另一个会话' }).evaluate(element => (element as HTMLElement).click());
  await expect(preview(page)).toBeHidden();
  await expect(page.locator('h1')).toContainText('另一个会话');
});
