import type { Page } from '@playwright/test';
import { test, expect, login } from './fixtures';

async function openConnections(page: Page) {
  await login(page);
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.settings-button').click();
  await page.locator('.settings-nav').getByRole('button', { name: '连接', exact: true }).click();
}

async function addConnection(page: Page) {
  await page.getByRole('button', { name: '添加 SSH 连接', exact: true }).click();
  return page.getByRole('dialog', { name: '添加 SSH 连接', exact: true });
}

const savedHost = () => ({
  id: 'ssh-password-fixture', kind: 'ssh', name: '密码开发机',
  hostname: 'password.example.test', username: 'developer', port: 2222,
  authentication: 'password', hasPassword: true,
});

for (const phone of [false, true]) {
  test(`password connection tests and saves a masked unsaved password on ${phone ? 'phone' : 'desktop'}`, async ({ page, mock }) => {
    if (phone) {
      await page.setViewportSize({ width: 390, height: 667 });
      await page.emulateMedia({ colorScheme: 'dark' });
    }
    const probes: any[] = [], saves: any[] = [];
    await page.route('**/api/hosts/test', async route => {
      probes.push(route.request().postDataJSON());
      expect(route.request().headers()['x-csrf-token']).toBe('mock-csrf');
      await route.fulfill({ json: { ok: true, stage: 'ready' } });
    });
    await page.route(/\/api\/hosts$/, async route => {
      const body = route.request().postDataJSON();
      saves.push(body);
      const { password: _password, ...publicFields } = body;
      const host = { ...publicFields, id: 'ssh-password-fixture', kind: 'ssh', hasPassword: true };
      mock.hosts.push(host);
      await route.fulfill({ status: 201, json: { host, hosts: mock.hosts } });
    });
    await openConnections(page);
    const dialog = await addConnection(page);
    await dialog.getByLabel('SSH 显示名称', { exact: true }).fill('密码开发机');
    await dialog.getByLabel('SSH 主机地址', { exact: true }).fill('developer@password.example.test');
    await dialog.getByLabel('SSH 端口', { exact: true }).fill('2222');
    await dialog.getByRole('button', { name: '密码登录', exact: true }).click();
    const password = dialog.getByLabel('SSH 登录密码', { exact: true });
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).toHaveAttribute('required', '');
    const secret = '  Test-only !@#$ 密码  ';
    await password.fill(secret);
    await dialog.getByRole('button', { name: '显示 SSH 密码', exact: true }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await dialog.getByRole('button', { name: '隐藏 SSH 密码', exact: true }).click();
    await expect(password).toHaveAttribute('type', 'password');
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `.data/ssh-password-login-${phone ? 'mobile' : 'desktop'}.png` });
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('连接成功');
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ authentication: 'password', password: secret, identityFile: '', hostname: 'developer@password.example.test', port: 2222 });
    expect(probes[0]).not.toHaveProperty('hostId');
    expect(mock.hosts).toHaveLength(1);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(saves).toHaveLength(1);
    expect(saves[0].password).toBe(secret);
    const browserStorage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    expect(browserStorage).not.toContain(secret);
    expect(JSON.stringify(mock.hosts)).not.toContain(secret);
  });
}

test('editing a password connection retains the stored secret without returning it and accepts an explicit replacement', async ({ page, mock }) => {
  const host = savedHost();
  mock.hosts.push(host);
  const probes: any[] = [], saves: any[] = [];
  await page.route('**/api/hosts/test', async route => {
    probes.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, stage: 'ready' } });
  });
  await page.route('**/api/hosts/ssh-password-fixture', async route => {
    const body = route.request().postDataJSON();
    saves.push(body);
    const { password: _password, ...publicFields } = body;
    Object.assign(host, publicFields);
    // The real API canonicalizes the address and never echoes a password.
    const [username, hostname] = body.hostname.split('@');
    Object.assign(host, { username, hostname });
    await route.fulfill({ json: { host, hosts: mock.hosts, connectionReset: false } });
  });
  await openConnections(page);
  await page.getByRole('button', { name: '编辑 密码开发机', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑 SSH 连接', exact: true });
  const password = dialog.getByLabel('SSH 登录密码', { exact: true });
  await expect(dialog.getByRole('button', { name: '密码登录', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(password).toHaveValue('');
  await expect(password).not.toHaveAttribute('required', '');
  await expect(password).toHaveAttribute('placeholder', '已保存，留空保留原密码');
  await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('连接成功');
  expect(probes[0]).toMatchObject({ hostId: host.id, authentication: 'password' });
  expect(probes[0]).not.toHaveProperty('password');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saves[0]).not.toHaveProperty('password');
  expect(saves[0]).not.toHaveProperty('hostId');

  await page.getByRole('button', { name: '编辑 密码开发机', exact: true }).click();
  await expect(password).toHaveValue('');
  await password.fill('new-test-password');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saves[1]).toMatchObject({ authentication: 'password', password: 'new-test-password', identityFile: '' });
  expect(JSON.stringify(mock.hosts)).not.toContain('new-test-password');
});

test('changing a password target requires a new password and leaving password mode discards the unsaved secret', async ({ page, mock }) => {
  mock.hosts.push(savedHost());
  const probes: any[] = [];
  await page.route('**/api/hosts/test', async route => {
    probes.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, stage: 'ready' } });
  });
  await openConnections(page);
  await page.getByRole('button', { name: '编辑 密码开发机', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑 SSH 连接', exact: true });
  const password = dialog.getByLabel('SSH 登录密码', { exact: true });
  await dialog.getByLabel('SSH 主机地址', { exact: true }).fill('other@password.example.test');
  await expect(dialog).toContainText('主机地址、用户名或端口已变更');
  await expect(password).toHaveAttribute('required', '');
  await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(password).toBeFocused();
  expect(probes).toEqual([]);
  await password.fill('new-target-test-password');
  await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('连接成功');
  expect(probes[0]).toMatchObject({ hostname: 'other@password.example.test', password: 'new-target-test-password' });
  await dialog.getByRole('button', { name: 'SSH 配置', exact: true }).click();
  await expect(password).toHaveCount(0);
  await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('连接成功');
  expect(probes[1]).toMatchObject({ authentication: 'key' });
  expect(probes[1]).not.toHaveProperty('password');
  expect(probes[1]).not.toHaveProperty('hostId');
  await dialog.getByRole('button', { name: '密码登录', exact: true }).click();
  await expect(password).toHaveValue('');
});

test('password login uses the existing fingerprint confirmation without disclosing a password to inspect or trust requests', async ({ page }) => {
  const probes: any[] = [], fingerprints: any[] = [];
  await page.route('**/api/hosts/test', async route => {
    probes.push(route.request().postDataJSON());
    await route.fulfill({ json: probes.length === 1
      ? { ok: false, hostKeyRequired: true, stage: 'ssh', message: '确认服务器指纹' }
      : { ok: true, stage: 'ready' } });
  });
  await page.route('**/api/hosts/key/inspect', async route => {
    fingerprints.push(route.request().postDataJSON());
    await route.fulfill({ json: {
      hostname: 'password.example.test', port: 22, status: 'unknown',
      keys: [{ type: 'ssh-ed25519', fingerprint: `SHA256:${'A'.repeat(43)}` }],
      challenge: 'test-password-host-challenge', expiresAt: Date.now() + 60_000,
    } });
  });
  await page.route('**/api/hosts/key/trust', async route => {
    fingerprints.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await openConnections(page);
  const dialog = await addConnection(page);
  await dialog.getByLabel('SSH 主机地址', { exact: true }).fill('developer@password.example.test');
  await dialog.getByRole('button', { name: '密码登录', exact: true }).click();
  await dialog.getByLabel('SSH 登录密码', { exact: true }).fill('fingerprint-test-password');
  await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(dialog).toContainText('首次连接：确认服务器指纹');
  await dialog.getByRole('button', { name: '信任并测试连接', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('连接成功');
  expect(probes).toHaveLength(2);
  expect(probes[1]).toEqual(probes[0]);
  expect(fingerprints).toHaveLength(2);
  for (const request of fingerprints) expect(request).not.toHaveProperty('password');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const reopened = await addConnection(page);
  await reopened.getByRole('button', { name: '密码登录', exact: true }).click();
  await expect(reopened.getByLabel('SSH 登录密码', { exact: true })).toHaveValue('');
});
