import type { Page, Route } from '@playwright/test';
import { test, expect, login } from './fixtures';

async function forwarding(page: Page) {
  const connections: { hostId: string; port: number; path: string }[] = [];
  const released: string[] = [];
  const respond = async (route: Route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      connections.push(request.postDataJSON());
      const id = `port-forward-${connections.length}`;
      return route.fulfill({ json: { id, url: `/api/dev-preview/${id}/`, expiresAt: Date.now() + 3_600_000 } });
    }
    if (request.method() === 'DELETE') {
      released.push(new URL(request.url()).pathname.split('/').at(-1)!);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Forwarded app</p>' });
  };
  await page.route('**/api/dev-preview**', respond);
  await page.context().route('**/api/dev-preview/**', respond);
  return { connections, released };
}

async function openPreview(page: Page) {
  await login(page);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await page.locator('#workspace-panel').getByRole('button', { name: '预览', exact: true }).click();
}

for (const [address, port, path] of [
  ['5173', 5173, '/'],
  [':8080/dashboard?view=mail', 8080, '/dashboard?view=mail'],
  ['localhost:5173/mail', 5173, '/mail'],
  ['http://127.0.0.1:5173/mail?filter=unread', 5173, '/mail?filter=unread'],
  ['http://[::1]:3000/', 3000, '/'],
] as const) {
  test(`preview address forwards ${address} on the selected host`, async ({ page }) => {
    const fixture = await forwarding(page);
    await openPreview(page);
    await page.getByRole('textbox', { name: '预览地址', exact: true }).fill(address);
    await page.getByRole('button', { name: '打开预览', exact: true }).click();
    await expect(page.locator('iframe[title="开发服务预览"]')).toBeVisible();
    expect(fixture.connections).toEqual([{ hostId: 'local', port, path }]);
    await expect(page.locator('iframe[title="开发服务预览"]')).not.toHaveAttribute('sandbox', /allow-same-origin/);
    await expect(page.getByRole('link', { name: '在新标签页打开开发服务', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
  });
}

test('switching preview mode and workspace tabs retains the forwarded page and releases only on close', async ({ page }) => {
  const fixture = await forwarding(page);
  await openPreview(page);
  await page.getByRole('textbox', { name: '预览地址', exact: true }).fill('5173');
  await page.getByRole('button', { name: '打开预览', exact: true }).click();
  const frame = page.locator('iframe[title="开发服务预览"]');
  await expect(frame).toBeVisible();
  await expect(page.frameLocator('iframe[title="开发服务预览"]').getByText('Forwarded app')).toBeVisible();
  const childFrame = frame.contentFrame();
  await childFrame.getByText('Forwarded app').evaluate(element => { element.setAttribute('data-retained', 'yes'); });
  await page.locator('#workspace-panel').getByRole('button', { name: '文件', exact: true }).click();
  await expect(frame).toBeHidden();
  await page.locator('#workspace-panel').getByRole('button', { name: '预览', exact: true }).click();
  await expect(childFrame.locator('[data-retained="yes"]')).toBeVisible();
  await page.locator('#workspace-panel').getByRole('button', { name: '文件 / URL', exact: true }).click();
  await expect(frame).toBeHidden();
  await page.locator('#workspace-panel').getByRole('button', { name: '开发服务', exact: true }).click();
  await expect(childFrame.locator('[data-retained="yes"]')).toBeVisible();
  expect(fixture.connections).toHaveLength(1);
  expect(fixture.released).toEqual([]);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: '在新标签页打开开发服务', exact: true }).click();
  const popup = await popupPromise;
  await expect(popup.getByText('Forwarded app')).toBeVisible();
  await popup.close();
  await page.getByRole('button', { name: '关闭开发服务预览', exact: true }).click();
  await expect(frame).toHaveCount(0);
  await expect.poll(() => fixture.released).toEqual(['port-forward-1']);
});

test('port forwarding remains available when only the Codex connection is offline', async ({ page, mock }) => {
  const fixture = await forwarding(page);
  await openPreview(page);
  await page.locator('#workspace-panel').getByRole('button', { name: '开发服务', exact: true }).click();
  mock.emit('bridge/status', { connected: false, hostId: 'local', mode: 'spawn', pendingRequests: [] });
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('iframe[title="开发服务预览"]')).toBeVisible();
  expect(fixture.connections).toEqual([{ hostId: 'local', port: 5173, path: '/' }]);
});

test('invalid ports and HTTPS loopback addresses give an actionable error without creating a forward', async ({ page }) => {
  const fixture = await forwarding(page);
  await openPreview(page);
  const input = page.getByRole('textbox', { name: '预览地址', exact: true });
  await input.fill('99999');
  await page.getByRole('button', { name: '打开预览', exact: true }).click();
  await expect(page.locator('.panel-error')).toContainText('1024–65535');
  await input.fill('https://localhost:5173');
  await page.getByRole('button', { name: '打开预览', exact: true }).click();
  await expect(page.locator('.panel-error')).toContainText('HTTP 转发');
  expect(fixture.connections).toEqual([]);
});
