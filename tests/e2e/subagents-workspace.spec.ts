import type { Page, WebSocketRoute } from '@playwright/test'
import { test, expect, login, type MockCodex } from './fixtures'

const rootId = 'thread-existing'
const makeAgent = (id: string, name: string, status: any = { type: 'active', activeFlags: [] }, parent = rootId) => ({
  id, parentThreadId: parent, name: `内部名称 ${name}`, agentNickname: name, agentRole: 'explorer',
  preview: '检查布局和协议', source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: `/root/${name}`, agent_nickname: name, agent_role: 'explorer' } } },
  status, createdAt: Math.floor(Date.now() / 1000) - 33, updatedAt: Math.floor(Date.now() / 1000) - 2,
  cwd: '/workspace/demo', historyMode: 'paginated', ephemeral: false, modelProvider: 'openai', turns: [],
})
const makeTurn = (id: string, text: string) => ({ id, status: 'completed', itemsView: 'full',
  startedAt: 1791300000, completedAt: 1791300001, durationMs: 1000,
  items: [{ id: `${id}-user`, type: 'userMessage', content: [{ type: 'text', text: '子智能体任务', text_elements: [] }] },
    { id: `${id}-agent`, type: 'agentMessage', text }],
})

/** Ancestor-filtered wire responses, entirely local to this test. Child reads
 * do not connect to a backend, initialize an agent or execute any model work. */
function agentWire(mock: MockCodex, initial = [makeAgent('agent-active', 'Ada')]) {
  const wire = {
    rows: initial as any[], moreRows: [] as any[],
    turns: new Map<string, any[]>(initial.map(row => [row.id, [makeTurn(`${row.id}-latest`, '子智能体最新回复')]])),
    olderTurns: new Map<string, any[]>(), failList: false, failRead: false,
    holdRoot: '', held: [] as (() => void)[],
  }
  const original = (mock as any).receive.bind(mock)
  ;(mock as any).receive = (socket: WebSocketRoute, request: any) => {
    const p = request.params || {}
    const reply = (result: any) => socket.send(JSON.stringify({ id: request.id, result }))
    const fail = (message: string) => socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message } }))
    if (request.method === 'thread/list' && p.ancestorThreadId) {
      mock.requests.push(request)
      if (wire.failList) return fail('此 Codex 暂不支持祖先查询')
      const result = {
        data: (p.cursor === 'agent-page-2' ? wire.moreRows : wire.rows).filter(row => row.parentThreadId === p.ancestorThreadId),
        nextCursor: !p.cursor && wire.moreRows.some(row => row.parentThreadId === p.ancestorThreadId) ? 'agent-page-2' : null,
      }
      if (wire.holdRoot === p.ancestorThreadId) wire.held.push(() => reply(result))
      else reply(result)
      return
    }
    const agent = [...wire.rows, ...wire.moreRows].find(row => row.id === p.threadId)
    if (agent && request.method === 'thread/read') {
      mock.requests.push(request)
      return wire.failRead ? fail('读取子智能体失败') : reply({ thread: { ...agent, turns: [] } })
    }
    if (agent && request.method === 'thread/turns/list') {
      mock.requests.push(request)
      return wire.failRead ? fail('读取子智能体失败') : reply({
        data: [...(p.cursor === 'agent-history-2' ? wire.olderTurns.get(agent.id) : wire.turns.get(agent.id)) || []].reverse(),
        nextCursor: !p.cursor && wire.olderTurns.has(agent.id) ? 'agent-history-2' : null,
      })
    }
    original(socket, request)
  }
  return wire
}

async function openRoot(page: Page) {
  await login(page)
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: '已有测试历史' }).first().click()
  await expect(page.locator('.conversation-scroll')).toContainText('历史保持可读')
}
async function openAgents(page: Page) {
  await page.getByRole('button', { name: '切换工作区', exact: true }).click()
  await page.locator('#workspace-panel').getByRole('button', { name: '子智能体', exact: true }).click()
  return page.getByRole('region', { name: '子智能体工作区', exact: true })
}

test('workspace groups only the current conversation’s agents with names, roles, progress and elapsed times', async ({ page, mock }) => {
  agentWire(mock, [makeAgent('active', 'Ada'), makeAgent('waiting', 'Lin', { type: 'active', activeFlags: ['waitingOnUserInput'] }),
    makeAgent('finished', 'Max', { type: 'idle' }), makeAgent('unrelated', '其他会话代理', { type: 'active', activeFlags: [] }, 'other-root')])
  await openRoot(page)
  const panel = await openAgents(page)
  await expect(panel.getByText('已开启 · 1', { exact: true })).toBeVisible()
  await expect(panel.getByText('等待输入 · 1', { exact: true })).toBeVisible()
  await expect(panel.getByText('完成 · 1', { exact: true })).toBeVisible()
  const active = panel.locator('[data-agent-id="active"]')
  await expect(active).toContainText('Ada')
  await expect(active).toContainText('explorer')
  await expect(active).toContainText('处理中')
  await expect(active.locator('.subagent-time')).toHaveText(/\d+ 秒/)
  await expect(panel).not.toContainText('其他会话代理')
  const query = mock.requests.find(request => request.method === 'thread/list' && request.params.ancestorThreadId)
  expect(query?.params).toMatchObject({ ancestorThreadId: rootId, sourceKinds: ['subAgent'], modelProviders: [], limit: 60 })
})

test('opening a child shows read-only history without resuming it or replacing the main chat and draft', async ({ page, mock }) => {
  agentWire(mock)
  await openRoot(page)
  const composer = page.getByRole('textbox', { name: '消息输入框', exact: true })
  await composer.fill('主对话草稿保持不变')
  const panel = await openAgents(page)
  const beforeResumes = mock.requests.filter(request => request.method === 'thread/resume').length
  await panel.getByRole('button', { name: '查看子智能体 Ada', exact: true }).click()
  await expect(panel.getByLabel('子智能体对话内容', { exact: true })).toContainText('子智能体最新回复')
  await expect(panel).toContainText('只读')
  await expect(panel.getByRole('textbox')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(0)
  await expect(page.locator('.conversation-scroll')).toContainText('历史保持可读')
  await expect(composer).toHaveValue('主对话草稿保持不变')
  expect(mock.requests.filter(request => request.method === 'thread/resume')).toHaveLength(beforeResumes)
  expect(mock.requests.some(request => ['turn/start', 'turn/interrupt', 'thread/archive'].includes(request.method || ''))).toBe(false)
  expect(mock.requests.find(request => request.method === 'thread/read' && request.params.threadId === 'agent-active')?.params.includeTurns).toBe(false)
  expect(mock.requests.find(request => request.method === 'thread/turns/list' && request.params.threadId === 'agent-active')?.params).toMatchObject({ sortDirection: 'desc', itemsView: 'full' })
  await panel.getByRole('button', { name: '返回子智能体列表', exact: true }).click()
  await expect(panel.getByRole('button', { name: '查看子智能体 Ada', exact: true })).toBeVisible()
})

test('agent and child history pagination preserve ordering and avoid duplicate turns', async ({ page, mock }) => {
  const wire = agentWire(mock)
  wire.moreRows = [makeAgent('agent-older', 'Lin', { type: 'idle' })]
  wire.olderTurns.set('agent-active', [makeTurn('first-child-turn', '子智能体早期回复')])
  await openRoot(page)
  const panel = await openAgents(page)
  await panel.getByRole('button', { name: '加载更多子智能体', exact: true }).click()
  await expect(panel.getByRole('button', { name: '查看子智能体 Lin', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '查看子智能体 Ada', exact: true }).click()
  await expect(panel.getByLabel('子智能体对话内容', { exact: true })).toContainText('子智能体最新回复')
  await panel.getByRole('button', { name: '加载更早的消息', exact: true }).click()
  await expect(panel.locator('.subagent-turn')).toHaveCount(2)
  await expect(panel.locator('.subagent-turn').first()).toContainText('子智能体早期回复')
  await expect(panel.locator('.subagent-turn').last()).toContainText('子智能体最新回复')
  await expect(panel.getByRole('button', { name: '加载更早的消息', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: '刷新子智能体', exact: true }).click()
  await expect(panel.locator('.subagent-turn')).toHaveCount(2)
  await expect(panel.locator('.subagent-turn').first()).toContainText('子智能体早期回复')
})

test('known temporary agents remain visible when ancestor queries fail and an explicit retry recovers', async ({ page, mock }) => {
  const wire = agentWire(mock)
  wire.failList = true
  mock.turns.get(rootId)![0].items.push({ id: 'spawn-temporary', type: 'collabAgentToolCall',
    tool: 'spawnAgent', status: 'completed', senderThreadId: rootId, receiverThreadIds: ['temporary-agent'],
    agentsStates: { 'temporary-agent': { status: 'running', message: '临时代理正在检查' } }, prompt: '检查项目',
  }, { id: 'temporary-activity', type: 'subAgentActivity', agentThreadId: 'temporary-agent', agentPath: '/root/temporary', kind: 'started' })
  await openRoot(page)
  const panel = await openAgents(page)
  await expect(panel.getByRole('alert')).toContainText('此 Codex 暂不支持祖先查询')
  await expect(panel.locator('[data-agent-id="temporary-agent"]')).toContainText('临时代理正在检查')
  wire.failList = false
  await panel.getByRole('button', { name: '重试', exact: true }).click()
  await expect(panel.getByRole('button', { name: '查看子智能体 Ada', exact: true })).toBeVisible()
  await expect(panel.locator('[data-agent-id="temporary-agent"]')).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
})

test('child notifications update recent output and completion while the parent remains idle', async ({ page, mock }) => {
  agentWire(mock)
  await openRoot(page)
  const panel = await openAgents(page)
  const row = panel.locator('[data-agent-id="agent-active"]')
  await expect(row).toBeVisible()
  mock.emit('turn/started', { threadId: 'agent-active', turn: { id: 'child-live', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000), items: [] } })
  mock.emit('item/agentMessage/delta', { threadId: 'agent-active', turnId: 'child-live', itemId: 'child-live-output', delta: '子智能体实时进度' })
  await expect(row).toContainText('子智能体实时进度')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
  mock.emit('thread/status/changed', { threadId: 'agent-active', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } })
  await expect(panel.getByText('等待输入 · 1', { exact: true })).toBeVisible()
  mock.emit('turn/completed', { threadId: 'agent-active', turn: { id: 'child-live', status: 'completed', items: [] } })
  await expect(panel.getByText('完成 · 1', { exact: true })).toBeVisible()
  await expect(row).toContainText('已完成')
  mock.emit('turn/started', { threadId: 'agent-active', turn: { id: 'child-failure', status: 'inProgress', items: [] } })
  mock.emit('turn/completed', { threadId: 'agent-active', turn: { id: 'child-failure', status: 'failed', items: [] } })
  mock.emit('thread/status/changed', { threadId: 'agent-active', status: { type: 'idle' } })
  await expect(row).toContainText('运行失败')
  mock.emit('thread/status/changed', { threadId: 'agent-active', status: { type: 'notLoaded' } })
  await expect(row).toContainText('运行失败')
  mock.emit('turn/started', { threadId: 'agent-active', turn: { id: 'child-retry', status: 'inProgress', items: [] } })
  await expect(row).toContainText('处理中')
  await expect(panel.getByText('已开启 · 1', { exact: true })).toBeVisible()
})

test('a late ancestor response cannot overwrite the newly selected parent conversation', async ({ page, mock }) => {
  const wire = agentWire(mock)
  wire.holdRoot = rootId
  const second = { ...mock.threads[0]!, id: 'thread-second', name: '第二主会话', preview: '第二主会话' }
  mock.threads.push(second)
  mock.turns.set(second.id, [makeTurn('second-parent-turn', '第二主会话回复')])
  wire.rows.push(makeAgent('second-child', 'Grace', { type: 'active', activeFlags: [] }, second.id))
  await openRoot(page)
  const panel = await openAgents(page)
  await expect.poll(() => wire.held.length).toBeGreaterThan(0)
  await page.locator('[data-section="recent"] .thread-row').filter({ hasText: second.name }).first().click()
  await expect(page.locator('.conversation-scroll')).toContainText('第二主会话回复')
  await expect(panel.getByRole('button', { name: '查看子智能体 Grace', exact: true })).toBeVisible()
  for (const reply of wire.held.splice(0)) reply()
  await page.waitForTimeout(100)
  await expect(panel.locator('.subagent-row')).toHaveCount(1)
  await expect(panel).not.toContainText('Ada')
})

test('phone dark agent list and details fit the viewport with readable surfaces', async ({ page, mock }) => {
  agentWire(mock, [makeAgent('agent-active', '非常长的子智能体名称用于检查手机布局和自动省略')])
  await page.emulateMedia({ colorScheme: 'dark' })
  await openRoot(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openAgents(page)
  const row = panel.locator('.subagent-row').first()
  await expect(row).toBeVisible()
  const background = await panel.evaluate(node => getComputedStyle(node).backgroundColor)
  expect(background).not.toBe('rgb(255, 255, 255)')
  expect(background).not.toBe('rgba(0, 0, 0, 0)')
  const colors = await panel.evaluate(node => {
    const luminance = (color: string) => (color.match(/[\d.]+/g) || []).slice(0, 3).map(value => Number(value) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
    const bg = luminance(getComputedStyle(node).backgroundColor)
    const fg = luminance(getComputedStyle(node.querySelector('.subagent-summary')!).color)
    return { background: bg, contrast: (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05) }
  })
  expect(colors.background).toBeLessThan(.1)
  expect(colors.contrast).toBeGreaterThanOrEqual(4.5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('dark-phone-subagents.png') })
  await row.click()
  await expect(panel.getByLabel('子智能体对话内容', { exact: true })).toContainText('子智能体最新回复')
  await expect(panel.getByRole('button', { name: '返回子智能体列表', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})

test('empty and failed child reads provide usable feedback and retry controls', async ({ page, mock }) => {
  const wire = agentWire(mock, [])
  await openRoot(page)
  const panel = await openAgents(page)
  await expect(panel.getByText('暂无子智能体', { exact: true })).toBeVisible()
  wire.rows.push(makeAgent('agent-active', 'Ada'))
  wire.turns.set('agent-active', [makeTurn('child-latest', '重试读取已成功')])
  await panel.getByRole('button', { name: '刷新子智能体', exact: true }).click()
  await expect(panel.getByRole('button', { name: '查看子智能体 Ada', exact: true })).toBeVisible()
  wire.failRead = true
  await panel.getByRole('button', { name: '查看子智能体 Ada', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('读取子智能体失败')
  wire.failRead = false
  await panel.getByRole('button', { name: '重试读取', exact: true }).click()
  await expect(panel.getByLabel('子智能体对话内容', { exact: true })).toContainText('重试读取已成功')
  await expect(panel.getByRole('alert')).toHaveCount(0)
})

test('a disconnected bridge keeps known rows visible and disables reads until reconnection', async ({ page, mock }) => {
  agentWire(mock)
  await openRoot(page)
  const panel = await openAgents(page)
  const row = panel.getByRole('button', { name: '查看子智能体 Ada', exact: true })
  await expect(row).toBeEnabled()
  mock.emit('bridge/status', { connected: false, hostId: 'local', mode: 'spawn' })
  await expect(panel).toContainText('连接已断开，重新连接后可刷新状态。')
  await expect(row).toBeVisible()
  await expect(row).toBeDisabled()
  await expect(panel.getByRole('button', { name: '刷新子智能体', exact: true })).toBeDisabled()
  mock.emit('bridge/status', { connected: true, hostId: 'local', mode: 'spawn', pendingRequests: [] })
  await expect(row).toBeEnabled()
  await expect(panel.getByRole('button', { name: '刷新子智能体', exact: true })).toBeEnabled()
  await expect(panel).not.toContainText('连接已断开，重新连接后可刷新状态。')
})
