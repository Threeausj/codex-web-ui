import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Host, RpcMessage } from './types.js'
import { writePrivateJson } from './storage.js'

const MAX_IDS = 1024
const MAX_BYTES = 1024 * 1024
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const identifier = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const entrySchema = z.object({
  hostId: identifier, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), threadId: identifier,
  seenAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()
const documentSchema = z.object({ version: z.literal(1), sessions: z.array(entrySchema).max(MAX_IDS) }).strict()
type Entry = z.infer<typeof entrySchema>
type Change = { hostId: string; fingerprint: string; threadId: string; remove: boolean; seenAt: number }
const entryKey = (entry: Pick<Entry, 'hostId' | 'fingerprint' | 'threadId'>) => JSON.stringify([entry.hostId, entry.fingerprint, entry.threadId])
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function fingerprint(host: Host, localIdentity?: string) {
  return createHash('sha256').update(JSON.stringify([
    host.kind, host.hostname || null, host.username || null, host.port || null,
    host.identityFile || null, host.codexPath || null, host.cwd || null, host.connectionMode || null,
    host.kind === 'local' ? localIdentity || null : null,
  ])).digest('hex')
}
function id(value: unknown): string | undefined {
  const parsed = identifier.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
function safeError(message: string) { return Object.assign(new Error(message), { code: 'daemon_sessions_unavailable' }) }

/** A bounded recovery hint, never a transcript or a pending-request journal.
 * The daemon remains authoritative; these IDs only tell a replacement Web
 * process which saved sessions it previously observed and should resubscribe. */
export class DaemonSessions {
  readonly file: string
  private readonly now: () => number
  private readonly localIdentity?: string
  private entries: Entry[] = []
  private queue: Promise<void> = Promise.resolve()
  private initializing?: Promise<void>
  private initialized = false
  private closed = false
  private forgotten = new Set<string>()
  private excluded = new Set<string>()
  private writeFailure?: Error

  constructor(dataDir: string, options: { now?: () => number; localIdentity?: string } = {}) {
    this.file = path.join(dataDir, 'daemon-sessions.json')
    this.now = options.now || Date.now
    this.localIdentity = options.localIdentity
  }

  /** Non-fatal for accepted user input; callers can surface this on diagnostics. */
  get persistenceError(): Error | undefined { return this.writeFailure }

  init(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    if (this.initializing) return this.initializing
    const work = (async () => {
      try {
        const handle = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > MAX_BYTES) throw safeError('Daemon 会话恢复记录超出容量或不是普通文件，请先检查该记录。')
          const parsed = documentSchema.safeParse(JSON.parse(await handle.readFile('utf8')))
          if (!parsed.success) throw safeError('Daemon 会话恢复记录损坏，未自动覆盖，请先检查该记录。')
          const keys = new Set(parsed.data.sessions.map(entryKey))
          if (keys.size !== parsed.data.sessions.length) throw safeError('Daemon 会话恢复记录包含重复身份，未自动覆盖，请先检查该记录。')
          this.entries = this.live(parsed.data.sessions)
          await handle.chmod(0o600)
        } finally { await handle.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if ((error as { code?: string }).code === 'daemon_sessions_unavailable') throw error
          throw safeError('无法读取 Daemon 会话恢复记录，未自动覆盖，请检查记录格式及访问权限。')
        }
      }
      this.initialized = true
    })()
    this.initializing = work
    return work.finally(() => { if (this.initializing === work) this.initializing = undefined })
  }

  async threadIds(host: Host): Promise<string[]> {
    await this.init()
    await this.queue
    if (this.closed || host.connectionMode !== 'daemon' || this.forgotten.has(host.id)) return []
    const identity = fingerprint(host, this.localIdentity)
    return this.live(this.entries).filter(entry => entry.hostId === host.id && entry.fingerprint === identity).map(entry => entry.threadId)
  }

  observe(host: Host, message: RpcMessage, responseMethod?: string): Promise<void> | void {
    if (this.closed || host.connectionMode !== 'daemon' || this.forgotten.has(host.id)) return
    const change = this.change(host, message, responseMethod)
    if (!change) return
    // Keep only the small metadata change in the write closure. Original RPC
    // bodies can contain prompts, answers or secrets and are never retained.
    const operation = this.queue.then(async () => {
      await this.init()
      if (this.forgotten.has(change.hostId)) return
      const next = new Map(this.live(this.entries).filter(entry => entry.hostId !== change.hostId || entry.fingerprint === change.fingerprint).map(entry => [entryKey(entry), entry]))
      const key = entryKey(change)
      const previous = next.get(key)
      next.delete(key)
      if (!change.remove) next.set(key, { hostId: change.hostId, fingerprint: change.fingerprint, threadId: change.threadId, seenAt: Math.max(previous?.seenAt || 0, change.seenAt) })
      await this.persist(this.bounded([...next.values()]))
    })
    // A failed metadata write must never turn an already accepted native turn
    // into a retryable send error. Recovery can still use this process's IDs.
    this.queue = operation.catch(() => { this.writeFailure = safeError('Daemon 会话恢复记录未能保存，请检查服务器存储状态。') })
    return this.queue
  }

  async forgetHost(hostId: string): Promise<void> {
    this.forgotten.add(hostId)
    const operation = this.queue.then(async () => {
      await this.init()
      await this.persist(this.entries.filter(entry => entry.hostId !== hostId))
    })
    this.queue = operation.catch(() => { this.writeFailure = safeError('Daemon 会话恢复记录未能保存，请检查服务器存储状态。') })
    await this.queue
  }

  async close(): Promise<void> {
    this.closed = true
    await this.queue
    if (this.writeFailure) throw this.writeFailure
  }

  private change(host: Host, message: RpcMessage, responseMethod?: string): Change | undefined {
    if (message.error) return
    const params = record(message.params)
    const result = record(message.result)
    let threadId: string | undefined, remove = false
    if (message.method === 'thread/archived' || message.method === 'thread/deleted') {
      threadId = id(params?.threadId) || id(record(params?.thread)?.id)
      remove = true
    } else if (message.method === 'thread/started' || !message.method && ['thread/start', 'thread/resume', 'thread/fork'].includes(responseMethod || '')) {
      const thread = record(message.method ? params?.thread : result?.thread)
      if (!thread) return
      threadId = id(thread.id)
      if (threadId && (thread.ephemeral === true || thread.threadSource === 'thread_title')) {
        const key = entryKey({ hostId: host.id, fingerprint: fingerprint(host, this.localIdentity), threadId })
        this.excluded.add(key)
        while (this.excluded.size > 2048) this.excluded.delete(this.excluded.values().next().value!)
        remove = true
      }
    } else if (message.method === 'bridge/thread/changed' && ['turn/start', 'turn/steer', 'thread/queue/start'].includes(String(params?.method))) {
      threadId = id(params?.threadId)
    }
    if (!threadId || !id(host.id)) return
    if (!remove && this.excluded.has(entryKey({ hostId: host.id, fingerprint: fingerprint(host, this.localIdentity), threadId }))) return
    return { hostId: host.id, fingerprint: fingerprint(host, this.localIdentity), threadId, remove, seenAt: Math.max(0, Math.floor(this.now())) }
  }

  private live(entries: Entry[]) {
    const now = this.now()
    return entries.filter(entry => entry.seenAt <= now + 5 * 60_000 && now - entry.seenAt <= TTL_MS)
  }
  private bounded(entries: Entry[]) {
    const sorted = entries.sort((a, b) => a.seenAt - b.seenAt)
    if (sorted.length > MAX_IDS) sorted.splice(0, sorted.length - MAX_IDS)
    while (sorted.length && Buffer.byteLength(JSON.stringify({ version: 1, sessions: sorted }, null, 2) + '\n') > MAX_BYTES) sorted.shift()
    return sorted
  }
  private async persist(entries: Entry[]) {
    this.entries = entries
    await writePrivateJson(this.file, { version: 1, sessions: entries })
    this.writeFailure = undefined
  }
}
