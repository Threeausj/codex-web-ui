export type SubagentGroup = 'active' | 'waiting' | 'completed' | 'other'
export type SubagentEntry = {
  id: string
  name: string
  role: string
  parentId: string
  status: string
  group: SubagentGroup
  summary: string
  startedAt: number
  updatedAt: number
  ephemeral: boolean
  thread?: any
}

export function timestampMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value < 100_000_000_000 ? value * 1000 : value
}

function spawnSource(thread: any): any {
  const source = thread?.source?.subagent ?? thread?.source?.subAgent
  return source && typeof source === 'object' ? source.thread_spawn : null
}

export function subagentParent(thread: any): string {
  return thread?.parentThreadId || spawnSource(thread)?.parent_thread_id || ''
}

function isSubagent(thread: any): boolean {
  return !!subagentParent(thread) || !!(thread?.source && typeof thread.source === 'object' &&
    ('subagent' in thread.source || 'subAgent' in thread.source))
}

export function subagentStatus(value: any): string {
  const status = typeof value === 'string' ? value : value?.type
  if (status === 'active')
    return value?.activeFlags?.some((flag: string) => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) ? 'waiting' : 'running'
  const aliases: Record<string, string> = {
    inProgress: 'running', started: 'running', interacted: 'running', idle: 'completed',
    systemError: 'errored', failed: 'errored', notLoaded: 'unknown',
  }
  return aliases[status] || status || 'unknown'
}

export function subagentGroup(status: string): SubagentGroup {
  if (status === 'waiting') return 'waiting'
  if (['running', 'pendingInit'].includes(status)) return 'active'
  if (['completed', 'interrupted', 'errored', 'shutdown'].includes(status)) return 'completed'
  return 'other'
}

export function subagentStatusLabel(status: string): string {
  return ({ running: '处理中', pendingInit: '正在启动', waiting: '等待输入', completed: '已完成',
    interrupted: '已中断', errored: '运行失败', shutdown: '已关闭', notFound: '未找到', unknown: '状态未知' } as Record<string, string>)[status] || '状态未知'
}

function textContent(item: any): string {
  return item?.text || (item?.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
}

function lastOutput(thread: any): string {
  for (const turn of [...(thread?.turns || [])].reverse())
    for (const item of [...(turn.items || [])].reverse())
      if (item.type === 'agentMessage' && textContent(item)) return textContent(item)
  return ''
}

/** `threads` is an ancestor-scoped page, never the host's general thread list.
 * Activity is applied only to agents already identified by that page or by the
 * current conversation's collaboration items; arbitrary host events cannot leak in. */
export function mergeSubagents(rootThreadId: string, threads: any[], items: any[] = [], activity: Record<string, any> = {}): SubagentEntry[] {
  if (!rootThreadId) return []
  const entries = new Map<string, SubagentEntry>()
  const latestCollabStates = new Map<string, string>()
  const terminalFailures = ['errored', 'interrupted', 'shutdown']
  for (const thread of threads) {
    if (!thread?.id || thread.id === rootThreadId || !isSubagent(thread)) continue
    const source = spawnSource(thread)
    const latestTurn = thread.turns?.at(-1)
    const runtime = subagentStatus(thread.status)
    const turnStatus = subagentStatus(latestTurn?.status)
    const status = ['completed', 'unknown'].includes(runtime) && subagentGroup(turnStatus) === 'completed' ? turnStatus : runtime
    entries.set(thread.id, {
      id: thread.id,
      name: thread.agentNickname || source?.agent_nickname || thread.name || source?.agent_path?.split('/').filter(Boolean).at(-1) || `子智能体 ${thread.id.slice(0, 8)}`,
      role: thread.agentRole || source?.agent_role || '',
      parentId: subagentParent(thread), status, group: subagentGroup(status),
      summary: lastOutput(thread) || thread.preview || '',
      startedAt: timestampMs(latestTurn?.startedAt || thread.createdAt),
      updatedAt: timestampMs(thread.updatedAt), ephemeral: !!thread.ephemeral, thread,
    })
  }
  function known(id: string): SubagentEntry | undefined {
    if (!id || id === rootThreadId) return
    if (!entries.has(id)) entries.set(id, {
      id, name: `子智能体 ${id.slice(0, 8)}`, role: '', parentId: rootThreadId,
      status: 'unknown', group: 'other', summary: '', startedAt: 0, updatedAt: 0, ephemeral: false,
    })
    return entries.get(id)
  }
  for (const item of items) {
    if (item.type === 'collabAgentToolCall') {
      // Item snapshots can include calls issued by descendants. They belong to
      // this conversation's canonical history and do not need a loaded parent.
      for (const id of new Set<string>([...(item.receiverThreadIds || []), ...Object.keys(item.agentsStates || {})])) {
        const entry = known(id)
        if (!entry) continue
        const state = item.agentsStates?.[id]
        if (state?.status) latestCollabStates.set(id, subagentStatus(state.status))
        if (state?.message && !lastOutput(entry.thread)) entry.summary = state.message
        else if (!entry.summary && item.prompt) entry.summary = item.prompt
        if (!entry.thread && state?.status) entry.status = subagentStatus(state.status)
        if (!entry.thread && item.tool === 'spawnAgent' && !state?.status) entry.status = 'pendingInit'
      }
    } else if (item.type === 'subAgentActivity') {
      const entry = known(item.agentThreadId)
      if (!entry) continue
      if (item.agentPath && !entry.thread)
        entry.name = item.agentPath.split('/').filter(Boolean).at(-1) || entry.name
      if (!entry.thread) entry.status = subagentStatus(item.kind)
    }
  }
  for (const entry of entries.values()) {
    // A cold metadata page reports runtime availability, not the last turn's
    // outcome. Preserve the latest collaboration failure when no durable turn
    // status exists, while current active/waiting metadata remains authoritative.
    const runtime = subagentStatus(entry.thread?.status)
    const parentStatus = latestCollabStates.get(entry.id)
    if (entry.thread && !entry.thread.turns?.at(-1)?.status && parentStatus &&
      (runtime === 'completed' && terminalFailures.includes(parentStatus) || runtime === 'unknown' && parentStatus !== 'unknown'))
      entry.status = parentStatus
    const latest = activity[entry.id]
    const updatedAt = timestampMs(latest?.updatedAt)
    if (latest && updatedAt >= entry.updatedAt) {
      if (latest.status) {
        const liveStatus = subagentStatus(latest.status)
        const runtimeOnly = liveStatus === 'unknown' || latest.status === 'idle'
        if (!runtimeOnly || !terminalFailures.includes(entry.status)) entry.status = liveStatus
      }
      if (latest.text) entry.summary = latest.text
      if (updatedAt) entry.updatedAt = updatedAt
      if (latest.startedAt) entry.startedAt = timestampMs(latest.startedAt)
    }
    entry.group = subagentGroup(entry.status)
  }
  return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

export function subagentTime(entry: SubagentEntry, now = Date.now()): string {
  const active = entry.group === 'active' || entry.group === 'waiting'
  const at = active ? entry.startedAt : entry.updatedAt
  if (!at) return ''
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (!active && seconds < 60) return '刚刚'
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟${active ? '' : '前'}`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时${active ? '' : '前'}`
  return `${Math.floor(seconds / 86400)} 天${active ? '' : '前'}`
}
