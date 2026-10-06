import type { Page } from '@playwright/test'
import { test, expect, login, send, slash } from './fixtures'

async function chooseGlobal(page: Page, mode: string) {
  await page.locator('.settings-button').click()
  await page.getByRole('combobox', { name: '全局默认权限' }).selectOption(mode)
  await expect(page.getByText('全局默认权限已保存，从下一次发送生效', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
}

for (const [mode, policy, approval] of [
  ['read-only', 'readOnly', 'on-request'],
  ['workspace-write', 'workspaceWrite', 'on-request'],
  ['danger-full-access', 'dangerFullAccess', 'never'],
]) test(`global ${mode} survives reload and reaches new and existing conversations`, async ({ page, mock }) => {
  await login(page)
  await chooseGlobal(page, mode)
  expect(mock.preferences.defaultPermission).toBe(mode)
  expect(mock.preferences.activePermissionProfileId).toBe('')
  await page.reload()
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue(mode)
  await send(page, '使用全局默认权限')
  await expect(page.locator('.agent-message')).toContainText('流式回复完成')
  expect(mock.request('thread/start')?.params).toMatchObject({ sandbox: mode, approvalPolicy: approval, historyMode: 'paginated' })
  expect(mock.request('turn/start')?.params).toMatchObject({ approvalPolicy: approval, sandboxPolicy: { type: policy } })
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue(mode)
  await send(page, '旧会话也使用全局权限')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  expect(mock.request('turn/start')?.params).toMatchObject({ threadId: 'thread-existing', approvalPolicy: approval, sandboxPolicy: { type: policy } })
})

test('a conversation can override the global choice until the global choice is changed again', async ({ page, mock }) => {
  await login(page)
  await chooseGlobal(page, 'danger-full-access')
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: '选择权限' }).selectOption('read-only')
  await send(page, '此会话只读')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  expect(mock.request('turn/start')?.params.sandboxPolicy.type).toBe('readOnly')
  expect(mock.preferences.defaultPermission).toBe('danger-full-access')
  await slash(page, 'new')
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('danger-full-access')
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click()
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('read-only')
  await chooseGlobal(page, 'workspace-write')
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('workspace-write')
  await send(page, '重新应用全局默认权限')
  await expect(page.locator('.agent-message')).toHaveCount(3)
  expect(mock.request('turn/start')?.params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } })
})

test('managed restrictions cannot be bypassed through the global selector', async ({ page, mock }) => {
  mock.requirements = { allowedSandboxModes: ['read-only'], allowedApprovalPolicies: ['on-request'] }
  await login(page)
  await page.locator('.settings-button').click()
  const choice = page.getByRole('combobox', { name: '全局默认权限' })
  await expect(choice.locator('option[value="danger-full-access"]')).toBeDisabled()
  await expect(choice.locator('option[value="workspace-write"]')).toBeDisabled()
  await choice.evaluate(element => {
    const select = element as HTMLSelectElement
    select.value = 'danger-full-access'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('.panel-error')).toContainText('管理策略')
  expect(mock.preferences.defaultPermission).toBeUndefined()
  await choice.selectOption('read-only')
  await expect(page.getByText('全局默认权限已保存，从下一次发送生效', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await send(page, '按管理策略只读')
  await expect(page.locator('.agent-message')).toContainText('流式回复完成')
  expect(mock.request('turn/start')?.params.sandboxPolicy.type).toBe('readOnly')
})
