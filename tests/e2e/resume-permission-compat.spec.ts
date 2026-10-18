import type { AskForApproval } from '../../shared/protocol/v2/AskForApproval'
import type { SandboxPolicy } from '../../shared/protocol/v2/SandboxPolicy'
import { test, expect, login, send, MockCodex } from './fixtures'

const workspacePolicy: SandboxPolicy = {
  type: 'workspaceWrite', writableRoots: ['/workspace/demo', '/approved/data'],
  networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
}
function nativeResume(mock: MockCodex, sandbox: SandboxPolicy, approvalPolicy?: AskForApproval, activePermissionProfile?: { id: string; extends: string | null }) {
  const receive = (mock as any).receive.bind(mock)
  ;(mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/resume') return receive(socket, request)
    mock.requests.push(request)
    const p = request.params
    const effectiveSandbox = p.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : p.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
      : p.sandbox === 'workspace-write' ? { ...workspacePolicy, networkAccess: p.config?.sandbox_workspace_write?.network_access ?? false }
      : sandbox
    socket.send(JSON.stringify({ id: request.id, result: {
      thread: mock.threads.find(thread => thread.id === p.threadId), model: mock.config.model,
      reasoningEffort: 'medium', sandbox: effectiveSandbox, approvalPolicy: p.approvalPolicy ?? approvalPolicy,
      ...(activePermissionProfile ? { activePermissionProfile } : {}),
    } }))
  }
}
async function openHistory(page: Parameters<typeof login>[0]) {
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click()
  await expect(page.getByText('历史保持可读', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
}

for (const approval of [
  'untrusted',
  { granular: { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: true, mcp_elicitations: false } },
] as AskForApproval[]) test(`native resume retains saved network grants and ${typeof approval === 'string' ? approval : 'granular'} approvals`, async ({ page, mock }) => {
  mock.preferences.defaultPermission = 'workspace-write'
  mock.preferences.defaultPermissionExplicit = false
  if (typeof approval !== 'string') mock.requirements = { allowedSandboxModes: ['workspace-write'], allowedApprovalPolicies: [approval] }
  nativeResume(mock, workspacePolicy, approval)
  await login(page)
  await openHistory(page)
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('resumed')
  const resume = mock.request('thread/resume')!.params
  expect(resume).not.toHaveProperty('sandbox')
  expect(resume).not.toHaveProperty('approvalPolicy')
  expect(resume).not.toHaveProperty('permissions')
  expect(resume.config).not.toHaveProperty('sandbox_workspace_write')
  await send(page, '延续保存的权限')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  expect(mock.request('turn/start')!.params).not.toHaveProperty('approvalPolicy')
  expect(mock.request('turn/start')!.params).not.toHaveProperty('sandboxPolicy')
  expect(mock.request('turn/start')!.params).not.toHaveProperty('permissions')
  if (typeof approval !== 'string') {
    await page.getByRole('button', { name: '编辑消息', exact: true }).click()
    await page.getByRole('textbox', { name: '编辑消息内容' }).fill('编辑后仍沿用原生细粒度审批')
    await page.getByRole('button', { name: '保存并重新发送', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '编辑消息内容' })).toHaveCount(0)
    await expect(page.getByText('编辑后仍沿用原生细粒度审批', { exact: true })).toBeVisible()
    expect(mock.requests.filter(request => request.method === 'turn/start')).toHaveLength(2)
    expect(mock.request('turn/start')!.params).not.toHaveProperty('approvalPolicy')
    expect(mock.request('turn/start')!.params).not.toHaveProperty('sandboxPolicy')
    expect(mock.request('turn/start')!.params).not.toHaveProperty('permissions')
  }
})

test('an explicit global read-only choice overrides a saved full-access native thread', async ({ page, mock }) => {
  mock.preferences.defaultPermission = 'read-only'
  mock.preferences.defaultPermissionExplicit = true
  nativeResume(mock, { type: 'dangerFullAccess' }, 'never')
  await login(page)
  await openHistory(page)
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('read-only')
  expect(mock.request('thread/resume')!.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' })
  await send(page, '明确只读覆盖原权限')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  expect(mock.request('turn/start')!.params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
})

test('a managed native resume and a later explicit conversation choice preserve the current restrictions', async ({ page, mock }) => {
  mock.preferences.defaultPermission = 'workspace-write'
  mock.preferences.defaultPermissionExplicit = false
  mock.requirements = { allowedSandboxModes: ['read-only'], allowedApprovalPolicies: ['on-request'] }
  nativeResume(mock, { type: 'readOnly', networkAccess: false }, 'on-request')
  await login(page)
  await openHistory(page)
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('resumed')
  expect(mock.request('thread/resume')!.params).not.toHaveProperty('sandbox')
  await send(page, '保留管理策略后的有效权限')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  expect(mock.request('turn/start')!.params).not.toHaveProperty('approvalPolicy')
  expect(mock.request('turn/start')!.params).not.toHaveProperty('sandboxPolicy')
  const choice = page.getByRole('combobox', { name: '选择权限' })
  await choice.selectOption('read-only')
  await send(page, '会话明确选择也遵守策略')
  await expect(page.locator('.agent-message')).toHaveCount(3)
  expect(mock.request('turn/start')!.params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
})

test('legacy runtime responses continue without fabricating permission overrides or requiring native profile ids', async ({ page, mock }) => {
  nativeResume(mock, { type: 'workspaceWrite' } as SandboxPolicy)
  await login(page)
  await openHistory(page)
  await send(page, '兼容缺少新版权限信息的运行时')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  const request = mock.request('turn/start')!.params
  expect(request).not.toHaveProperty('approvalPolicy')
  expect(request).not.toHaveProperty('sandboxPolicy')
  expect(request).not.toHaveProperty('permissions')
})

test('native queue settings retain a managed granular approval policy and saved network access', async ({ page, mock }) => {
  const approval = { granular: { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: true, mcp_elicitations: false } }
  mock.preferences.defaultPermission = 'workspace-write'
  mock.preferences.defaultPermissionExplicit = false
  mock.requirements = { allowedSandboxModes: ['workspace-write'], allowedApprovalPolicies: [approval] }
  mock.turns.get('thread-existing')!.push({ id: 'native-permission-running', status: 'inProgress', items: [] })
  nativeResume(mock, workspacePolicy, approval)
  const fields: Record<string, string[]> = {
    'thread/queue/add': ['threadId', 'input', 'clientUserMessageId'],
    'thread/queue/list': ['threadId', 'limit', 'cursor'],
    'thread/queue/update': ['threadId', 'queuedSubmissionId', 'input'],
    'thread/queue/delete': ['threadId', 'queuedSubmissionId'],
    'thread/queue/reorder': ['threadId', 'queuedSubmissionIds'],
    'thread/queue/start': ['threadId', 'queuedSubmissionId'],
    'thread/settings/update': ['threadId', 'cwd', 'model', 'effort', 'sandboxPolicy', 'approvalPolicy', 'collaborationMode'],
  }
  await page.route('**/api/hosts/*/native-capabilities*', route => route.fulfill({ json: {
    status: 'known', checkedAt: Date.now(), methods: Object.fromEntries(Object.entries(fields).map(([method, params]) => [method, { available: true, params, required: ['threadId'] }])),
  } }))
  const receive = (mock as any).receive.bind(mock)
  const queued: any[] = []
  ;(mock as any).receive = (socket: any, request: any) => {
    if (!fields[request.method]) return receive(socket, request)
    mock.requests.push(request)
    const reply = (result: any) => socket.send(JSON.stringify({ id: request.id, result }))
    if (request.method === 'thread/queue/list') return reply({ data: queued, nextCursor: null })
    if (request.method === 'thread/queue/add') {
      const item = { id: 'native-permission-queued', input: request.params.input, clientUserMessageId: request.params.clientUserMessageId }
      queued.push(item)
      return reply({ queuedSubmission: item })
    }
    return reply({})
  }
  await login(page)
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).click()
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('resumed')
  await expect.poll(() => mock.requests.some(request => request.method === 'thread/queue/list')).toBe(true)
  await page.getByRole('combobox', { name: '消息发送方式' }).selectOption('queue')
  await page.getByRole('textbox', { name: '消息输入框' }).fill('下一轮沿用保存的审批和网络设置')
  await page.getByRole('button', { name: '加入下一轮队列', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('')
  expect(mock.request('thread/settings/update')!.params).not.toHaveProperty('sandboxPolicy')
  expect(mock.request('thread/settings/update')!.params).not.toHaveProperty('approvalPolicy')
  expect(mock.request('thread/settings/update')!.params).not.toHaveProperty('permissions')
  expect(queued).toHaveLength(1)
  expect(mock.requests.some(request => ['turn/start', 'turn/steer'].includes(request.method || ''))).toBe(false)
})

test('a native named permission profile stays authoritative without being replayed as a bare legacy sandbox', async ({ page, mock }) => {
  mock.preferences.defaultPermission = 'workspace-write'
  mock.preferences.defaultPermissionExplicit = false
  nativeResume(mock, workspacePolicy, 'on-request', { id: 'project-audited', extends: ':workspace' })
  await login(page)
  await openHistory(page)
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('resumed')
  await send(page, '沿用原生权限预设中的文件拒绝规则')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  expect(mock.request('thread/resume')!.params).not.toHaveProperty('sandbox')
  const request = mock.request('turn/start')!.params
  expect(request).not.toHaveProperty('sandboxPolicy')
  expect(request).not.toHaveProperty('approvalPolicy')
  expect(request).not.toHaveProperty('permissions')
  await page.getByRole('combobox', { name: '选择权限' }).selectOption('read-only')
  await send(page, '用户明确选择只读后才覆盖')
  await expect(page.locator('.agent-message')).toHaveCount(3)
  expect(mock.request('turn/start')!.params).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request' })
})

test('rejoining a loaded full-access native thread keeps an explicit Web read-only choice for the next turn', async ({ page, mock }) => {
  mock.preferences.defaultPermission = 'read-only'
  mock.preferences.defaultPermissionExplicit = true
  const receive = (mock as any).receive.bind(mock)
  ;(mock as any).receive = (socket: any, request: any) => {
    if (request.method !== 'thread/resume') return receive(socket, request)
    mock.requests.push(request)
    socket.send(JSON.stringify({ id: request.id, result: {
      thread: mock.threads[0], sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never',
    } }))
  }
  await login(page)
  await openHistory(page)
  await expect(page.getByRole('combobox', { name: '选择权限' })).toHaveValue('read-only')
  expect(mock.request('thread/resume')!.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' })
  await send(page, '下一轮明确使用网页选择的只读权限')
  await expect(page.locator('.agent-message')).toHaveCount(2)
  expect(mock.request('turn/start')!.params).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request' })
})
