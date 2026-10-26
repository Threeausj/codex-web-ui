import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { writePrivateJson } from './storage.js'
import type { Bridge } from './bridge.js'
import type { Host, RpcMessage } from './types.js'

const MAX_THREADS = 1024
const MAX_CHECKS_PER_HOST = 8
const MAX_AGE = 7 * 24 * 60 * 60 * 1000
const identifier = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const watchedSchema = z.object({ hostId: identifier, threadId: identifier, turnId: identifier.optional(), observedAt: z.number().safe().nonnegative() }).strict()
const journalSchema = z.object({ version: z.literal(1), threads: z.array(watchedSchema).max(MAX_THREADS) }).strict()
type Watched = z.infer<typeof watchedSchema>
type HostState = { failures: number; nextAt: number; lastConnectedAt: number | null; lastCheckedAt: number | null; lastFailureAt: number | null; error: 'unavailable' | null; paused?: boolean; cursor?: string | null }
type ObserverBridge = Pick<Bridge, 'connect' | 'request' | 'connected' | 'paused'>
export type PushObserverOptions = {
  getHosts: () => Host[]
  getBridge: (hostId: string) => Promise<ObserverBridge>
  hasSubscriptions: () => boolean
  /** Resolves after the event/outbox record is durable, independently of provider delivery. */
  observe: (host: Host, message: RpcMessage, responseMethod?: string) => void | Promise<void>
  flushPush: () => Promise<void>
  now?: () => number
  intervalMs?: number
  retryBaseMs?: number
  /** createApp starts supervisors only after all private stores/routes initialized. */
  autoStart?: boolean
}
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
const validId = (value: unknown): value is string => identifier.safeParse(value).success
const keyFor = (hostId: string, threadId: string) => JSON.stringify([hostId, threadId])
const liveDeltaMethods = new Set(['item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta'])
function liveItemActivity(method: string | undefined, params: Record<string, any> | undefined) {
  if (!params) return false
  if (liveDeltaMethods.has(method || '')) return validId(params.itemId) && typeof params.delta === 'string' && params.delta.length > 0
  if (method !== 'item/started') return false
  const item = object(params.item)
  return validId(item?.id) && ['agentMessage', 'plan', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall',
    'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration', 'contextCompaction'].includes(item?.type) &&
    (item?.status === undefined || item.status === 'inProgress')
}

/** Durable, read-only supervision: browsers never own the push observer lifecycle.
 * Reconnecting a transport is safe; resuming a thread would acquire a writer,
 * so recovery only reads metadata and turn summaries for work observed running.
 */
export class PushObservers {
  private watched = new Map<string, Watched>()
  private checked = new Map<string, number>()
  private auxiliary = new Set<string>()
  private hosts = new Map<string, HostState>()
  private active = new Map<string, Promise<void>>()
  private pending = new Set<Promise<void>>()
  private writes: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private journalError = false
  private started: boolean
  private readonly now: () => number
  private readonly file: string
  constructor(dataDir: string, private readonly options: PushObserverOptions) {
    this.file = path.join(dataDir, 'push-observers.json')
    this.now = options.now || Date.now
    this.started = options.autoStart !== false
  }
  async init() {
    try {
      const stat = await fs.lstat(this.file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid push observer journal')
      const journal = journalSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')))
      for (const entry of journal.threads) {
        const key = keyFor(entry.hostId, entry.threadId)
        if (this.watched.has(key)) throw new Error('Duplicate push observer thread')
        if (entry.observedAt > this.now() - MAX_AGE) this.watched.set(key, entry)
      }
      await fs.chmod(this.file, 0o600)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read push-observers.json; restore the background notification journal', { cause })
    }
    this.wake()
  }
  private persist() {
    const snapshot = { version: 1, threads: [...this.watched.values()].map(value => ({ ...value })) }
    const operation = this.writes.then(() => writePrivateJson(this.file, snapshot)).then(() => { this.journalError = false }, cause => { this.journalError = true; throw cause })
    this.writes = operation.catch(() => {})
    return operation
  }
  private track(work: Promise<void>) {
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work)).catch(() => {})
  }
  private remember(host: Host, threadId: string, turnId?: string) {
    if (!this.options.hasSubscriptions() || !validId(threadId) || turnId !== undefined && !validId(turnId)) return
    const key = keyFor(host.id, threadId)
    if (this.auxiliary.has(key)) return
    const previous = this.watched.get(key)
    if (previous && (!turnId || previous.turnId === turnId) && this.now() - previous.observedAt < 60 * 60 * 1000) return
    if (!previous && this.watched.size >= MAX_THREADS) return
    this.watched.set(key, { hostId: host.id, threadId, ...(turnId || previous?.turnId ? { turnId: turnId || previous!.turnId } : {}), observedAt: this.now() })
    this.track(this.persist())
  }
  private forget(key: string, expected?: Watched) {
    if (expected && this.watched.get(key) !== expected) return
    if (!this.watched.delete(key)) return
    this.checked.delete(key)
    this.track(this.persist())
  }
  observe(host: Host, message: RpcMessage, responseMethod?: string) {
    if (this.stopped) return
    const p = object(message.params), result = object(message.result)
    if (message.method === 'bridge/disconnected') {
      const state = this.hosts.get(host.id)
      if (state) { state.nextAt = Math.min(state.nextAt, this.now() + (this.options.retryBaseMs || 1000)); state.error = 'unavailable' }
      this.schedule(this.options.retryBaseMs || 1000)
      return
    }
    const thread = message.method === 'thread/started' ? object(p?.thread) :
      ['thread/start', 'thread/resume', 'thread/read', 'thread/fork'].includes(responseMethod || '') ? object(result?.thread) : undefined
    if (thread && validId(thread.id)) {
      const key = keyFor(host.id, thread.id), source = object(thread.source)
      if (thread.ephemeral === true || thread.parentThreadId || source && ('subagent' in source || 'subAgent' in source) || ['subagent', 'subAgent'].includes(thread.source)) {
        this.auxiliary.add(key); this.forget(key)
        if (this.auxiliary.size > MAX_THREADS) this.auxiliary.delete(this.auxiliary.values().next().value!)
      } else if (thread.status?.type === 'active') {
        const running = Array.isArray(thread.turns) ? thread.turns.find((turn: any) => turn.status === 'inProgress') : undefined
        this.remember(host, thread.id, validId(running?.id) ? running.id : undefined)
      }
    }
    const threadId = p?.threadId || p?.conversationId
    if (!validId(threadId)) return
    const key = keyFor(host.id, threadId)
    if (['thread/closed', 'thread/archived', 'thread/deleted'].includes(message.method || '')) { this.forget(key); return }
    const turn = object(p?.turn)
    if (message.method === 'turn/started' && (!turn?.status || turn.status === 'inProgress')) this.remember(host, threadId, validId(turn?.id) ? turn.id : undefined)
    if (message.method === 'thread/status/changed' && p?.status?.type === 'active') this.remember(host, threadId)
    if (message.method === 'bridge/thread/changed' && ['turn/start', 'turn/steer'].includes(p?.method)) {
      const accepted = object(p?.result)
      this.remember(host, threadId, validId(accepted?.turn?.id) ? accepted!.turn.id : validId(accepted?.turnId) ? accepted!.turnId : undefined)
    }
    // Metadata can report active without its turn ID. Bind a later live item
    // to that existing watch so a missed completion remains recoverable. An
    // old delta cannot start observation or replace an already identified turn.
    const watched = this.watched.get(key)
    if (watched && !watched.turnId && validId(p?.turnId) && liveItemActivity(message.method, p))
      this.remember(host, threadId, p!.turnId)
    if (message.method === 'turn/completed' && validId(turn?.id)) {
      const watched = this.watched.get(key)
      if (watched && (!watched.turnId || watched.turnId === turn!.id)) {
        // The completion event/outbox must commit before its recovery marker is
        // removed. A crash can then safely replay through PushService's dedupe.
        // App dispatch may already have started this event. PushService shares
        // its pending acknowledgement so a failed enqueue keeps this marker.
        this.track(Promise.resolve(this.options.observe(host, message, responseMethod)).then(() => { this.forget(key, watched) }))
      }
    }
  }
  wake() {
    if (this.stopped || !this.started) return
    for (const state of this.hosts.values()) state.nextAt = 0
    this.schedule(0)
  }
  start() { if (!this.stopped) { this.started = true; this.wake() } }
  private schedule(delay: number) {
    if (this.stopped || !this.started) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll().catch(() => {}) }, delay)
    this.timer.unref()
  }
  /** Exposed for deterministic checks; requests never start a turn or acquire a writer. */
  async poll() {
    if (this.stopped || !this.started) return
    if (this.journalError) this.track(this.persist())
    const hosts = this.options.getHosts(), live = new Set(hosts.map(host => host.id))
    for (const key of this.hosts.keys()) if (!live.has(key)) this.hosts.delete(key)
    for (const [key, entry] of this.watched) if (!live.has(entry.hostId) || entry.observedAt <= this.now() - MAX_AGE) this.forget(key, entry)
    if (this.options.hasSubscriptions()) {
      const available = hosts.filter(host => !this.active.has(host.id) && (this.hosts.get(host.id)?.nextAt || 0) <= this.now())
      // Limit connection handshakes across hosts as well as per-host reads.
      const workers = Array.from({ length: Math.min(2, available.length) }, async () => {
        while (available.length && !this.stopped && this.options.hasSubscriptions()) {
          const host = available.shift()!
          const task = this.pollHost(host)
          this.active.set(host.id, task)
          try { await task } finally { if (this.active.get(host.id) === task) this.active.delete(host.id) }
        }
      })
      await Promise.allSettled(workers)
    }
    const interval = this.options.intervalMs || 15000
    const retry = this.options.hasSubscriptions() ? [...this.hosts.values()].filter(state => state.error && !state.paused).map(state => Math.max(1, state.nextAt - this.now())) : []
    this.schedule(Math.min(interval, ...retry))
  }
  private async pollHost(host: Host) {
    const state = this.hosts.get(host.id) || { failures: 0, nextAt: 0, lastConnectedAt: null, lastCheckedAt: null, lastFailureAt: null, error: null }
    this.hosts.set(host.id, state)
    try {
      const bridge = await this.options.getBridge(host.id)
      state.paused = bridge.paused
      if (this.stopped || bridge.paused || !this.options.hasSubscriptions()) return
      const wasConnected = bridge.connected
      await bridge.connect()
      if (this.stopped || bridge.paused || this.options.getHosts().find(value => value.id === host.id) !== host) return
      if (!wasConnected) { state.cursor = null; state.lastConnectedAt = this.now() }
      let loaded: Record<string, any> | undefined
      try { loaded = object(await bridge.request('thread/loaded/list', { limit: 50, ...(state.cursor ? { cursor: state.cursor } : {}) }, 5000)) }
      catch (cause) {
        // Older versions still recover already observed work through metadata;
        // an unsupported discovery method must not disable every notification.
        if ((cause as any)?.rpc?.code !== -32601 && (cause as any)?.code !== -32601) throw cause
      }
      if (this.stopped || bridge.paused || !this.options.hasSubscriptions()) return
      state.cursor = typeof loaded?.nextCursor === 'string' ? loaded.nextCursor : null
      const known = [...this.watched.values()].filter(entry => entry.hostId === host.id)
      const candidates = new Set<string>(known.sort((a, b) => (this.checked.get(keyFor(host.id, a.threadId)) || 0) - (this.checked.get(keyFor(host.id, b.threadId)) || 0)).map(entry => entry.threadId))
      if (Array.isArray(loaded?.data)) for (const value of loaded.data) {
        const threadId = typeof value === 'string' ? value : object(value)?.id
        if (validId(threadId)) candidates.add(threadId)
      }
      // Rotate all loaded candidates, including idle ones, without one large
      // host starving the notification work on another.
      const selected = [...candidates].sort((a, b) => (this.checked.get(keyFor(host.id, a)) || 0) - (this.checked.get(keyFor(host.id, b)) || 0)).slice(0, MAX_CHECKS_PER_HOST)
      for (const threadId of selected) {
        if (this.stopped || bridge.paused || !this.options.hasSubscriptions()) break
        await this.checkThread(host, bridge, threadId)
        this.checked.set(keyFor(host.id, threadId), this.now())
      }
      while (this.checked.size > MAX_THREADS * 2) this.checked.delete(this.checked.keys().next().value!)
      state.failures = 0; state.error = null; state.lastCheckedAt = this.now(); state.nextAt = this.now() + (this.options.intervalMs || 15000)
    } catch {
      if (this.stopped) return
      ++state.failures; state.error = 'unavailable'; state.lastFailureAt = this.now()
      state.nextAt = this.now() + Math.min(5 * 60 * 1000, (this.options.retryBaseMs || 1000) * 2 ** Math.min(9, state.failures - 1))
    }
  }
  private async checkThread(host: Host, bridge: ObserverBridge, threadId: string) {
    const key = keyFor(host.id, threadId)
    try {
      const metadata = object(await bridge.request('thread/read', { threadId, includeTurns: false }, 5000))
      if (this.stopped || bridge.paused) return
      const thread = object(metadata?.thread)
      if (!thread || thread.id !== threadId) return
      this.options.observe(host, { result: { thread } }, 'thread/read')
      this.observe(host, { result: { thread } }, 'thread/read')
      const watched = this.watched.get(key)
      if (!watched && thread.status?.type !== 'active') return
      // summary contains only final replies/statistics, never command-output
      // hydration; old native versions can leave recovery to their live stream.
      const page = object(await bridge.request('thread/turns/list', { threadId, limit: 20, sortDirection: 'desc', itemsView: 'summary' }, 5000))
      if (this.stopped || bridge.paused || !Array.isArray(page?.data)) return
      const turn = page.data.find((entry: any) => validId(entry?.id) && (watched?.turnId ? entry.id === watched.turnId : entry.status === 'inProgress'))
      if (!turn) return
      if (turn.status === 'inProgress') { this.remember(host, threadId, turn.id); return }
      if (!watched?.turnId || watched.turnId !== turn.id) return
      if (['completed', 'failed'].includes(turn.status)) {
        await this.options.observe(host, { method: 'turn/completed', params: { threadId, turn: { id: turn.id, status: turn.status, ...(turn.error ? { error: { message: '运行失败' } } : {}) } } })
        this.forget(key, watched)
      } else if (turn.status === 'interrupted') this.forget(key, watched)
    } catch {
      // One unavailable/deleted thread must not block this host's other jobs.
    }
  }
  status() {
    const hosts = this.options.getHosts().map(host => {
      const state = this.hosts.get(host.id)
      return { hostId: host.id, state: state?.paused ? 'paused' : state?.error ? 'retrying' : state?.lastCheckedAt ? 'observing' : 'waiting',
        lastCheckedAt: state?.lastCheckedAt || null, lastFailureAt: state?.lastFailureAt || null,
        nextRetryAt: state?.error ? state.nextAt : null, watchedThreads: [...this.watched.values()].filter(entry => entry.hostId === host.id).length }
    })
    return { enabled: this.options.hasSubscriptions(), journalAvailable: !this.journalError, hosts }
  }
  async flush() {
    // A provider can accept a delivery while pollHost is still committing its
    // recovery marker. Include current polls in this durability barrier.
    await Promise.allSettled([...this.active.values()])
    while (this.pending.size) await Promise.allSettled([...this.pending])
    await this.writes
  }
  async close() {
    this.stopped = true; clearTimeout(this.timer)
    await Promise.allSettled([...this.active.values()])
    await this.flush()
  }
}
