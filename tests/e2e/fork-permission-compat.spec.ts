import type { AskForApproval } from '../../shared/protocol/v2/AskForApproval'
import type { SandboxPolicy } from '../../shared/protocol/v2/SandboxPolicy'
import { test, expect, login, send, type MockCodex } from './fixtures'
import type { Page } from '@playwright/test'

const sourceId = 'thread-existing'
const readOnly: SandboxPolicy = { type: 'readOnly', networkAccess: false }

/** Loaded native actors keep their existing policy when a client only rejoins
 * them. Permission changes become sticky only after an accepted turn. */
function nativeForkPermissions(mock: MockCodex, initial: SandboxPolicy = { type: 'dangerFullAccess' }) {
  const policies = new Map<string, { sandbox: SandboxPolicy; approvalPolicy: AskForApproval }>([[sourceId, { sandbox: initial, approvalPolicy: 'never' }]])
  const receive = (mock as any).receive.bind(mock)
  let forkCount = 0
  ;(mock as any).receive = (socket: any, request: any) => {
    const p = request.params || {}
    if (request.method === 'turn/start' && p.sandboxPolicy) {
      policies.set(p.threadId, { sandbox: structuredClone(p.sandboxPolicy), approvalPolicy: p.approvalPolicy })
      return receive(socket, request)
    }
    if (request.method !== 'thread/resume' && request.method !== 'thread/fork') return receive(socket, request)
    mock.requests.push(request)
    let thread = mock.threads.find(entry => entry.id === p.threadId)!
    const policy = policies.get(p.threadId)!
    if (request.method === 'thread/fork') {
      thread = { ...structuredClone(thread), id: `native-permission-fork-${++forkCount}`, name: '继承权限的分支', forkedFromId: p.threadId, status: { type: 'idle' }, ephemeral: false }
      mock.threads.unshift(thread)
      mock.turns.set(thread.id, structuredClone(mock.turns.get(p.threadId) || []))
      policies.set(thread.id, structuredClone(policy))
      mock.emit('thread/started', { thread })
    }
    socket.send(JSON.stringify({ id: request.id, result: {
      thread, model: mock.config.model, reasoningEffort: 'medium',
      sandbox: policy.sandbox, approvalPolicy: policy.approvalPolicy,
      activePermissionProfile: { id: policy.sandbox.type === 'readOnly' ? ':read-only' : 'project-native', extends: null },
      approvalsReviewer: 'guardian_subagent',
    } }))
  }
}
async function openSource(page: Page) {
  const sidebar = page.getByRole('button', { name: '打开侧边栏', exact: true })
  if (await sidebar.isVisible()) await sidebar.click()
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '选择权限' })).toBeEnabled()
}
async function forkSource(page: Page) {
  await page.getByRole('button', { name: '对话操作', exact: true }).click()
  await page.getByRole('button', { name: '创建分支', exact: true }).click()
  await expect(page.getByRole('heading', { name: '继承权限的分支', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled()
}

for (const width of [1440, 390]) test(`${width}px fork keeps acknowledged parent restrictions under a broader global default`, async ({ page, mock }) => {
  await page.setViewportSize({ width, height: 844 })
  mock.preferences.defaultPermission = 'danger-full-access'
  mock.preferences.defaultPermissionExplicit = true
  nativeForkPermissions(mock)
  await login(page); await openSource(page)
  await page.getByRole('combobox', { name: '选择权限' }).selectOption('read-only')
  await send(page, '父会话先明确采用只读')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  expect(mock.request('turn/start')!.params.sandboxPolicy).toEqual(readOnly)
  await forkSource(page)
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('resumed')
  const fork = mock.request('thread/fork')!.params
  expect(fork).not.toHaveProperty('sandbox')
  expect(fork).not.toHaveProperty('approvalPolicy')
  const resume = mock.request('thread/resume')!.params
  expect(resume.threadId).toBe('native-permission-fork-1')
  expect(resume).not.toHaveProperty('sandbox')
  expect(resume).not.toHaveProperty('approvalPolicy')
  expect(resume).not.toHaveProperty('permissions')
  await send(page, '分支继续沿用已确认的只读和审核设置')
  await expect(page.locator('.agent-message')).toHaveCount(3)
  const inheritedTurn = mock.request('turn/start')!.params
  expect(inheritedTurn).not.toHaveProperty('sandboxPolicy')
  expect(inheritedTurn).not.toHaveProperty('approvalPolicy')
  expect(inheritedTurn).not.toHaveProperty('permissions')
  // A new choice made in the child is deliberate and must still be submitted.
  await page.getByRole('combobox', { name: '选择权限' }).selectOption('workspace-write')
  await send(page, '分支明确更改工作区权限')
  await expect(page.locator('.agent-message')).toHaveCount(4)
  expect(mock.request('turn/start')!.params).toMatchObject({ sandboxPolicy: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'on-request' })
})

test('fork carries an explicit source restriction that its loaded native writer has not accepted yet', async ({ page, mock }) => {
  mock.preferences.defaultPermission = 'danger-full-access'
  mock.preferences.defaultPermissionExplicit = true
  nativeForkPermissions(mock)
  await login(page); await openSource(page)
  await page.getByRole('combobox', { name: '选择权限' }).selectOption('read-only')
  await forkSource(page)
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('read-only')
  expect(mock.request('thread/resume')!.params).toMatchObject({ threadId: 'native-permission-fork-1', sandbox: 'read-only', approvalPolicy: 'on-request' })
  expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(0)
  await send(page, '先前明确选择的只读必须生效')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  expect(mock.request('turn/start')!.params).toMatchObject({ sandboxPolicy: readOnly, approvalPolicy: 'on-request' })
})

test('fork does not bypass an explicit global read-only policy while a loaded source still reports full access', async ({ page, mock }) => {
  mock.preferences.defaultPermission = 'read-only'
  mock.preferences.defaultPermissionExplicit = true
  nativeForkPermissions(mock)
  await login(page); await openSource(page)
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('read-only')
  await forkSource(page)
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('read-only')
  await send(page, '分支必须保留网页中明确要求的只读')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  expect(mock.request('turn/start')!.params).toMatchObject({ sandboxPolicy: readOnly, approvalPolicy: 'on-request' })
})
