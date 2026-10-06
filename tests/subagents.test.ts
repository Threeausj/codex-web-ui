import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeSubagents, subagentParent, subagentStatus, subagentTime, timestampMs } from '../src/lib/subagents'

const root = 'root-conversation'
const child = (id: string, overrides: any = {}) => ({
  id, parentThreadId: root, agentNickname: 'Ada', agentRole: 'explorer', preview: '检查布局',
  createdAt: 1791300000, updatedAt: 1791300060, status: { type: 'active', activeFlags: [] },
  source: { subagent: { thread_spawn: { parent_thread_id: root, agent_nickname: 'Lin', agent_role: 'worker', agent_path: '/root/layout' } } },
  ...overrides,
})
const collab = (id: string, status = 'running', message = '正在检查') => ({
  type: 'collabAgentToolCall', senderThreadId: root, receiverThreadIds: [id],
  agentsStates: { [id]: { status, message } }, prompt: '检查项目', tool: 'spawnAgent',
})

test('modern parent links and both protocol source spellings preserve agent names and roles', () => {
  const modern = child('modern')
  const older = child('older', { parentThreadId: null, agentNickname: null, agentRole: null })
  const legacy = { ...older, id: 'legacy', source: { subAgent: older.source.subagent } }
  for (const item of [modern, older, legacy]) assert.equal(subagentParent(item), root)
  const agents = mergeSubagents(root, [modern, older, legacy])
  assert.equal(agents.find(agent => agent.id === 'modern')?.name, 'Ada')
  assert.equal(agents.find(agent => agent.id === 'modern')?.role, 'explorer')
  assert.equal(agents.find(agent => agent.id === 'older')?.name, 'Lin')
  assert.equal(agents.find(agent => agent.id === 'legacy')?.role, 'worker')
})

test('the ancestor-scoped page excludes the main conversation and ordinary CLI histories', () => {
  const agents = mergeSubagents(root, [child('child'), child(root), { id: 'ordinary', source: 'cli', name: '无关对话' }])
  assert.deepEqual(agents.map(agent => agent.id), ['child'])
  assert.deepEqual(mergeSubagents('', [child('child')], [collab('temporary')]), [])
})

test('nested agents remain visible on a descendant page before their parent page arrives', () => {
  const nested = child('nested', { parentThreadId: 'unloaded-parent', source: { subagent: { thread_spawn: { parent_thread_id: 'unloaded-parent', depth: 2 } } } })
  assert.equal(mergeSubagents(root, [nested])[0]?.id, 'nested')
  assert.equal(mergeSubagents(root, [nested])[0]?.parentId, 'unloaded-parent')
})

test('approval and choice flags form a waiting group rather than pretending an agent completed', () => {
  for (const flag of ['waitingOnUserInput', 'waitingOnApproval']) {
    const agent = mergeSubagents(root, [child('waiting', { status: { type: 'active', activeFlags: [flag] } })])[0]!
    assert.equal(agent.status, 'waiting')
    assert.equal(agent.group, 'waiting')
  }
  assert.equal(subagentStatus('pendingInit'), 'pendingInit')
  assert.equal(mergeSubagents(root, [child('cold', { status: { type: 'notLoaded' } })])[0]?.group, 'other')
})

test('canonical collaboration items merge temporary agents and identify their latest known result', () => {
  const items = [collab('temporary'), collab('temporary', 'completed', '布局已修复'),
    { type: 'subAgentActivity', agentThreadId: 'activity-only', agentPath: '/root/dark_theme', kind: 'started' }]
  const agents = mergeSubagents(root, [], items)
  assert.equal(agents.length, 2)
  assert.equal(agents.find(agent => agent.id === 'temporary')?.summary, '布局已修复')
  assert.equal(agents.find(agent => agent.id === 'temporary')?.group, 'completed')
  assert.equal(agents.find(agent => agent.id === 'activity-only')?.name, 'dark_theme')
  assert.equal(agents.find(agent => agent.id === 'activity-only')?.group, 'active')
})

test('old collaboration snapshots cannot overwrite current active metadata or newer live activity', () => {
  const metadata = child('agent')
  const old = collab('agent', 'completed', '以前的结果')
  assert.equal(mergeSubagents(root, [metadata], [old])[0]?.group, 'active')
  const live = { agent: { status: 'waiting', text: '请选择方案', updatedAt: 1791300061000 },
    unrelated: { status: 'running', text: '其他主会话的消息', updatedAt: 1791300062000 } }
  const agents = mergeSubagents(root, [metadata], [old], live)
  assert.equal(agents.length, 1)
  assert.equal(agents[0]?.summary, '请选择方案')
  assert.equal(agents[0]?.group, 'waiting')
  assert.equal(mergeSubagents(root, [metadata], [], { agent: { status: 'completed', updatedAt: 1791300000000 } })[0]?.group, 'active')
})

test('read-only history retains final failure status and uses the latest assistant output', () => {
  const turns = [{ id: 'a', status: 'completed', items: [{ type: 'agentMessage', text: '旧结果' }] },
    { id: 'b', status: 'failed', startedAt: 1791300050, items: [{ type: 'agentMessage', text: '最新结果' }] }]
  const metadata = child('agent', { status: { type: 'idle' }, turns })
  const before = JSON.stringify(metadata)
  const agent = mergeSubagents(root, [metadata])[0]!
  assert.equal(agent.status, 'errored')
  assert.equal(agent.summary, '最新结果')
  assert.equal(agent.startedAt, 1791300050000)
  assert.equal(JSON.stringify(metadata), before)
})

test('elapsed labels use actual timestamps, accept seconds or milliseconds, and avoid invented times', () => {
  const agent = mergeSubagents(root, [child('agent')])[0]!
  assert.equal(timestampMs(1791300000), 1791300000000)
  assert.equal(timestampMs(1791300000000), 1791300000000)
  assert.equal(timestampMs(NaN), 0)
  assert.equal(subagentTime(agent, 1791300011000), '11 秒')
  assert.equal(subagentTime({ ...agent, group: 'completed' }, 1791301560000), '25 分钟前')
  assert.equal(subagentTime({ ...agent, startedAt: 0 }, 1791300011000), '')
})

test('cold metadata retains the latest parent-reported failure, interruption or closure', () => {
  for (const type of ['idle', 'notLoaded'])
    for (const status of ['errored', 'interrupted', 'shutdown']) {
      const metadata = child('agent', { status: { type }, turns: [] })
      const agent = mergeSubagents(root, [metadata], [collab('agent', 'completed', '以前完成'), collab('agent', status, '最新终态')])[0]!
      assert.equal(agent.status, status, `${type} must retain the latest ${status}`)
      assert.equal(agent.group, 'completed')
      assert.equal(agent.summary, '最新终态')
    }
  const cold = child('agent', { status: { type: 'notLoaded' } })
  assert.equal(mergeSubagents(root, [cold], [collab('agent', 'errored'), collab('agent', 'running')])[0]?.status, 'running')
  const idle = child('agent', { status: { type: 'idle' } })
  assert.equal(mergeSubagents(root, [idle], [collab('agent', 'errored'), collab('agent', 'completed')])[0]?.status, 'completed')
})

test('durable terminal turns override stale parent snapshots for idle and unloaded agents', () => {
  for (const type of ['idle', 'notLoaded'])
    for (const [turnStatus, expected] of [['failed', 'errored'], ['interrupted', 'interrupted'], ['completed', 'completed']]) {
      const metadata = child('agent', { status: { type }, turns: [{ id: 'latest', status: turnStatus, items: [] }] })
      const opposite = expected === 'completed' ? 'errored' : 'completed'
      assert.equal(mergeSubagents(root, [metadata], [collab('agent', opposite)])[0]?.status, expected)
    }
})

test('old parent terminal snapshots cannot replace current active or waiting metadata', () => {
  for (const activeFlags of [[], ['waitingOnUserInput'], ['waitingOnApproval']])
    for (const status of ['completed', 'errored', 'interrupted', 'shutdown']) {
      const metadata = child('agent', { status: { type: 'active', activeFlags } })
      assert.equal(mergeSubagents(root, [metadata], [collab('agent', status)])[0]?.status, activeFlags.length ? 'waiting' : 'running')
    }
})

test('a newer unknown or idle runtime status cannot erase a known terminal failure but a new active turn can', () => {
  for (const runtimeStatus of ['unknown', 'idle']) {
  for (const terminal of ['errored', 'interrupted', 'shutdown']) {
    const metadata = child('agent', { status: { type: 'idle' } })
    const parent = [collab('agent', terminal, '终态输出')]
    const live = { agent: { status: runtimeStatus, text: '最新可读输出', updatedAt: 1791300061000 } }
    const agent = mergeSubagents(root, [metadata], parent, live)[0]!
    assert.equal(agent.status, terminal)
    assert.equal(agent.summary, '最新可读输出')
    assert.equal(agent.updatedAt, 1791300061000)
    assert.equal(mergeSubagents(root, [metadata], parent, { agent: { ...live.agent, status: 'running' } })[0]?.status, 'running')
  }
  const metadata = child('agent', { status: { type: 'notLoaded' }, turns: [{ id: 'last', status: 'failed', items: [] }] })
  assert.equal(mergeSubagents(root, [metadata], [], { agent: { status: 'unknown', updatedAt: 1791300061000 } })[0]?.status, 'errored')
  }
})
