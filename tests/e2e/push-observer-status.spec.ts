import { test, expect, login } from './fixtures'

test('notification settings distinguish disconnected background observers from device delivery status', async ({ page }) => {
  await page.route('**/api/push/status*', route => route.fulfill({ json: {
    devices: 0, queued: 0, retrying: 0, delivered: 0, failed: 0, expired: 0,
    nextRetryAt: null, lastDeliveredAt: null, lastFailureAt: null, lastFailure: null,
    observers: { enabled: true, journalAvailable: true, hosts: [
      { hostId: 'local', state: 'observing', watchedThreads: 1, nextRetryAt: null },
      { hostId: 'remote', state: 'retrying', watchedThreads: 1, nextRetryAt: Date.now() + 1000 },
      { hostId: 'paused', state: 'paused', watchedThreads: 0, nextRetryAt: null },
    ] },
  } }))
  await login(page)
  await page.locator('.settings-button').click()
  await page.getByRole('button', { name: '应用与通知', exact: true }).click()
  const observers = page.getByLabel('后台通知观察状态', { exact: true })
  await expect(observers).toContainText('1 个主机已连接')
  await expect(observers).toContainText('1 个主机正在自动重连')
  await expect(observers).toContainText('1 个主机已暂停')
  await expect(observers).toContainText('关闭全部网页后仍会继续')
  await expect(page.getByRole('button', { name: '发送测试通知', exact: true })).toHaveCount(0)
})

test('observer persistence failures remain visible while phone push settings are disabled', async ({ page }) => {
  await page.route('**/api/push/status*', route => route.fulfill({ json: {
    devices: 0, queued: 0, retrying: 0, delivered: 0, failed: 0, expired: 0,
    nextRetryAt: null, lastDeliveredAt: null, lastFailureAt: null, lastFailure: null,
    observers: { enabled: true, journalAvailable: false, hosts: [] },
  } }))
  await login(page)
  await page.locator('.settings-button').click()
  await page.getByRole('button', { name: '应用与通知', exact: true }).click()
  await expect(page.getByLabel('后台通知观察状态', { exact: true })).toContainText('后台恢复记录暂时无法保存')
})
