import type { Page, Route } from '@playwright/test';
import { test, expect, login } from './fixtures';

const oldPassword = 'test-password-123';
const replacement = 'new-access-password-456';
type PasswordCall = { body: any; csrf?: string; method: string };

async function openPasswordSettings(page: Page) {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.settings-button').click();
  await page.locator('.settings-nav').getByRole('button', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '修改访问密码', exact: true }).click();
  await expect(page.locator('#password-change-form')).toBeVisible();
}
async function fillPasswords(page: Page, current = oldPassword, next = replacement, confirmation = next) {
  await page.getByLabel('当前访问密码', { exact: true }).fill(current);
  await page.getByLabel('新访问密码', { exact: true }).fill(next);
  await page.getByLabel('确认新访问密码', { exact: true }).fill(confirmation);
}
async function capturePasswordApi(page: Page, calls: PasswordCall[], status = 200, error?: string) {
  await page.route('**/api/auth/password', (route) => {
    const request = route.request();
    calls.push({ body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'], method: request.method() });
    return route.fulfill({ status, json: status === 200 ? { ok: true, expiresAt: Date.now() + 30 * 86_400_000 } : { error } });
  });
}
async function expectEmptyPasswords(page: Page) {
  for (const name of ['当前访问密码', '新访问密码', '确认新访问密码']) await expect(page.getByLabel(name, { exact: true })).toHaveValue('');
}

test('password changes validate length, confirmation and a different password before making any request', async ({ page }) => {
  const calls: PasswordCall[] = [];
  await capturePasswordApi(page, calls);
  await login(page);
  await openPasswordSettings(page);
  const save = page.getByRole('button', { name: '保存访问密码', exact: true });
  await save.click();
  await expect(page.getByRole('alert')).toContainText('请输入当前访问密码');
  await fillPasswords(page, oldPassword, 'short-value');
  await save.click();
  await expect(page.getByRole('alert')).toContainText('12 至 1024');
  await fillPasswords(page, oldPassword, replacement, 'does-not-match');
  await save.click();
  await expect(page.getByRole('alert')).toContainText('两次输入的新访问密码不一致');
  await fillPasswords(page, oldPassword, oldPassword);
  await save.click();
  await expect(page.getByRole('alert')).toContainText('与当前密码不同');
  // Programmatic values bypass maxlength, so the submit handler must enforce the upper bound too.
  await page.getByLabel('新访问密码', { exact: true }).evaluate((input: HTMLInputElement) => {
    input.value = 'x'.repeat(1025);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await save.click();
  await expect(page.getByRole('alert')).toContainText('12 至 1024');
  expect(calls).toHaveLength(0);
});

test('an incorrect current password leaves the user logged in, clears that field and never renders an error payload', async ({ page, mock }) => {
  const calls: PasswordCall[] = [];
  const wrong = 'wrong-current-secret';
  const echoedError = `Request payload: ${wrong} / ${replacement}`;
  await capturePasswordApi(page, calls, 403, echoedError);
  await login(page);
  await openPasswordSettings(page);
  await fillPasswords(page, wrong);
  await page.getByRole('button', { name: '保存访问密码', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('当前访问密码不正确，请重新输入。');
  await expect(page.getByLabel('当前访问密码', { exact: true })).toHaveValue('');
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '进入工作区', exact: true })).toHaveCount(0);
  expect(mock.authenticated).toBe(true);
  expect(calls).toHaveLength(1);
  expect(await page.locator('body').innerText()).not.toContain(echoedError);
  expect(await page.locator('body').innerText()).not.toContain(wrong);
  expect(await page.locator('body').innerText()).not.toContain(replacement);
  await expect(page.locator('.settings-content > .panel-error')).toHaveCount(0);
});

test('a successful password change sends the protected payload, preserves this login and clears all secrets', async ({ page, mock }) => {
  const calls: PasswordCall[] = [];
  await capturePasswordApi(page, calls);
  await login(page);
  await openPasswordSettings(page);
  await expect(page.getByText('使用访问密码验证，网页保持登录 30 天', { exact: true })).toBeVisible();
  await fillPasswords(page);
  await page.getByRole('button', { name: '保存访问密码', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '访问密码已更新，其他设备需要重新登录。' })).toBeVisible();
  await expect(page.locator('#password-change-form')).toHaveCount(0);
  expect(calls).toEqual([{ method: 'POST', body: { currentPassword: oldPassword, newPassword: replacement }, csrf: 'mock-csrf' }]);
  expect(mock.authenticated).toBe(true);
  await page.getByRole('button', { name: '修改访问密码', exact: true }).click();
  await expectEmptyPasswords(page);
  await fillPasswords(page, replacement, 'another-new-password-789');
  await page.getByRole('button', { name: '保存访问密码', exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].csrf).toBe('mock-csrf');
  await expect(page.getByRole('button', { name: '进入工作区', exact: true })).toHaveCount(0);
});

test('saving locks the form and duplicate submissions cannot issue a second password change', async ({ page }) => {
  const calls: PasswordCall[] = [];
  let pending: Route | undefined;
  await page.route('**/api/auth/password', (route) => {
    pending = route;
    calls.push({ body: route.request().postDataJSON(), csrf: route.request().headers()['x-csrf-token'], method: route.request().method() });
  });
  await login(page);
  await openPasswordSettings(page);
  await fillPasswords(page);
  await page.getByRole('button', { name: '保存访问密码', exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  await expect(page.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled();
  for (const name of ['当前访问密码', '新访问密码', '确认新访问密码']) await expect(page.getByLabel(name, { exact: true })).toBeDisabled();
  await page.locator('#password-change-form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(calls).toHaveLength(1);
  await pending!.fulfill({ json: { ok: true, expiresAt: Date.now() + 30 * 86_400_000 } });
  await expect(page.getByText('访问密码已更新，其他设备需要重新登录。', { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);
});

test('the web access password can be changed while the selected Codex host is disconnected', async ({ page, mock }) => {
  const calls: PasswordCall[] = [];
  await capturePasswordApi(page, calls);
  await login(page);
  mock.emit('bridge/status', { connected: false, hostId: 'local', error: 'Selected Codex host is offline' });
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeDisabled();
  await openPasswordSettings(page);
  await fillPasswords(page);
  const save = page.getByRole('button', { name: '保存访问密码', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('访问密码已更新，其他设备需要重新登录。', { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(mock.authenticated).toBe(true);
});

test('cancel, switching settings sections and closing the settings panel discard password fields', async ({ page }) => {
  const calls: PasswordCall[] = [];
  await capturePasswordApi(page, calls);
  await login(page);
  await openPasswordSettings(page);
  await fillPasswords(page);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '修改访问密码', exact: true }).click();
  await expectEmptyPasswords(page);
  await fillPasswords(page);
  await page.locator('.settings-nav').getByRole('button', { name: '通用', exact: true }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '修改访问密码', exact: true }).click();
  await expectEmptyPasswords(page);
  await fillPasswords(page);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await openPasswordSettings(page);
  await expectEmptyPasswords(page);
  expect(calls).toHaveLength(0);
});

test('the 390px password form stays within the viewport and offline changes are never queued', async ({ page, context }) => {
  const calls: PasswordCall[] = [];
  await capturePasswordApi(page, calls);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await openPasswordSettings(page);
  await fillPasswords(page);
  for (const [name, autocomplete] of [['当前访问密码', 'current-password'], ['新访问密码', 'new-password'], ['确认新访问密码', 'new-password']]) {
    await expect(page.getByLabel(name, { exact: true })).toHaveAttribute('type', 'password');
    await expect(page.getByLabel(name, { exact: true })).toHaveAttribute('autocomplete', autocomplete);
    await expect(page.getByLabel(name, { exact: true })).toHaveAttribute('maxlength', '1024');
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await page.locator('.settings-content').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: '保存访问密码', exact: true })).toBeDisabled();
  await expect(page.getByText('连接网络后可修改访问密码。', { exact: true })).toBeVisible();
  await page.locator('#password-change-form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(calls).toHaveLength(0);
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: '保存访问密码', exact: true })).toBeEnabled();
  expect(calls).toHaveLength(0);
  await page.getByRole('button', { name: '保存访问密码', exact: true }).click();
  await expect(page.getByText('访问密码已更新，其他设备需要重新登录。', { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);
});
