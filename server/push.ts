import fs from 'node:fs/promises'
import path from 'node:path'
import { createECDH, createHash, randomUUID } from 'node:crypto'
import type { Express, RequestHandler } from 'express'
import webPush, { type PushSubscription, type RequestOptions } from 'web-push'
import { z } from 'zod'
import type { AuthenticatedRequest, Host, RpcMessage } from './types.js'

const GRANT_TTL = 30 * 24 * 60 * 60 * 1000
const EVENT_TTL = 24 * 60 * 60 * 1000
const MAX_DEVICES = 64
const MAX_EVENTS = 2000
const MAX_THREAD_TITLES = 2000
const preferencesSchema = z.object({ completed: z.boolean(), approval: z.boolean(), errors: z.boolean() }).strict()
export type PushPreferences = z.infer<typeof preferencesSchema>
const defaultPreferences: PushPreferences = { completed: true, approval: true, errors: true }
const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(4096),
  expirationTime: z.number().nonnegative().nullable().optional(),
  keys: z.object({ p256dh: z.string().max(128), auth: z.string().max(64) }).strict(),
}).strict()
type Device = { subscription: PushSubscription; preferences: PushPreferences; sessionHash: string; expiresAt: number; credentialVersion?: string }
type PushNotice = { title: string; body: string; tag: string; data: { hostId?: string; threadId?: string; url: string; kind: 'completed' | 'approval' | 'errors' | 'test' } }
export type PushOptions = {
  vapidPublicKey?: string; vapidPrivateKey?: string; subject?: string
  sendNotification?: (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>
  now?: () => number
  /** Bound to the persisted web credential generation; provided by the application. */
  credentialVersion?: string
  /** Read thread metadata without loading turns or starting a model request. */
  resolveThread?: (host: Host, threadId: string) => Promise<unknown>
}

/** Only browser-owned push infrastructure is a valid destination, never an arbitrary URL. */
export function validatePushEndpoint(endpoint: string) {
  let url: URL
  try { url = new URL(endpoint) } catch { throw Object.assign(new Error('Invalid push endpoint'), { status: 400 }) }
  const hostname = url.hostname
  const official = hostname === 'fcm.googleapis.com' || hostname === 'updates.push.services.mozilla.com' ||
    hostname === 'push.services.mozilla.com' || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.push\.apple\.com$/.test(hostname) ||
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.notify\.windows\.com$/.test(hostname)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !official || url.pathname.length < 2)
    throw Object.assign(new Error('Push endpoint must use a supported HTTPS push provider'), { status: 400 })
  return endpoint
}

function decodeKey(value: string, length: number) {
  if (!/^[a-zA-Z0-9_-]+={0,2}$/.test(value)) throw new Error('Invalid push encryption key')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== length) throw new Error('Invalid push encryption key')
  return decoded
}

function validateSubscription(raw: unknown): PushSubscription {
  const subscription = subscriptionSchema.parse(raw)
  validatePushEndpoint(subscription.endpoint)
  try {
    const publicKey = decodeKey(subscription.keys.p256dh, 65)
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); ecdh.computeSecret(publicKey)
    decodeKey(subscription.keys.auth, 16)
  } catch { throw Object.assign(new Error('Invalid push encryption keys'), { status: 400 }) }
  return subscription
}

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function id(value: unknown) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value) ? value : undefined }
function hash(value: string) { return createHash('sha256').update(value).digest('base64url') }
function titleText(value: unknown) {
  if (typeof value !== 'string') return undefined
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100).replace(/[\ud800-\udbff]$/, '') || undefined
}
type ThreadTitle = { name?: string; preview?: string }

async function atomicPrivateJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
    await fs.chmod(file, 0o600)
  } finally { await fs.rm(temporary, { force: true }) }
}

const actionableRequests = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'item/tool/requestUserInput', 'execCommandApproval', 'applyPatchApproval',
])
const elicitationModes = new Set(['form', 'url', 'openai/form', 'openaiForm', 'openai/userVerification'])

/** Durable device grants expire independently and are revoked when the access password changes. */
export class PushService {
  private devices = new Map<string, Device>()
  private events = new Map<string, number>()
  private testTimes = new Map<string, number[]>()
  private threadTitles = new Map<string, ThreadTitle>()
  private threadLookups = new Map<string, Promise<string>>()
  private writes: Promise<void> = Promise.resolve()
  private pending = new Set<Promise<void>>()
  private deliveries: { run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void }[] = []
  private activeDeliveries = 0
  private closed = false
  private readonly file: string
  private readonly now: () => number
  private keys!: { publicKey: string; privateKey: string; subject: string }
  private readonly send: NonNullable<PushOptions['sendNotification']>
  private credentialVersion?: string
  private constructor(private readonly dataDir: string, private readonly options: PushOptions, private readonly origins: Set<string>) {
    this.file = path.join(dataDir, 'push-subscriptions.json')
    this.now = options.now || Date.now
    this.send = options.sendNotification || webPush.sendNotification.bind(webPush)
    this.credentialVersion = options.credentialVersion
  }

  static async create(dataDir: string, origins: Set<string>, options: PushOptions = {}) {
    const service = new PushService(dataDir, options, origins)
    await service.initialize()
    return service
  }

  private async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    const publicKey = this.options.vapidPublicKey ?? process.env.PUSH_VAPID_PUBLIC_KEY
    const privateKey = this.options.vapidPrivateKey ?? process.env.PUSH_VAPID_PRIVATE_KEY
    if (Boolean(publicKey) !== Boolean(privateKey)) throw new Error('Set both PUSH_VAPID_PUBLIC_KEY and PUSH_VAPID_PRIVATE_KEY, or leave both unset')
    const subject = this.options.subject || process.env.PUSH_SUBJECT || [...this.origins].find(origin => origin.startsWith('https:')) || 'https://github.com/Threeausj/codex-web-ui'
    let parsed: URL
    try { parsed = new URL(subject) } catch { throw new Error('PUSH_SUBJECT must be an HTTPS URL or mailto address') }
    if (!['https:', 'mailto:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || (parsed.protocol === 'mailto:' && !/^[^\s@]+@[^\s@]+$/.test(parsed.pathname)))
      throw new Error('PUSH_SUBJECT must be an HTTPS URL or mailto address')
    const keyFile = path.join(this.dataDir, 'push-vapid.json')
    let pair: { publicKey: string; privateKey: string }
    if (publicKey && privateKey) pair = { publicKey, privateKey }
    else {
      try { pair = JSON.parse(await fs.readFile(keyFile, 'utf8')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read persisted Web Push keys')
        pair = webPush.generateVAPIDKeys()
        try { await fs.writeFile(keyFile, `${JSON.stringify(pair)}\n`, { mode: 0o600, flag: 'wx' }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') pair = JSON.parse(await fs.readFile(keyFile, 'utf8')); else throw error }
      }
      await fs.chmod(keyFile, 0o600)
    }
    try {
      const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(decodeKey(pair.privateKey, 32))
      if (!ecdh.getPublicKey().equals(decodeKey(pair.publicKey, 65))) throw new Error('Key mismatch')
      webPush.getVapidHeaders('https://fcm.googleapis.com', subject, pair.publicKey, pair.privateKey, 'aes128gcm')
    } catch { throw new Error('Web Push VAPID keys are invalid or do not form a matching pair') }
    this.keys = { ...pair, subject }
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8')) as { version?: number; subscriptions?: unknown[]; events?: unknown[] }
      if ((saved.version !== 1 && saved.version !== 2) || !Array.isArray(saved.subscriptions) || saved.subscriptions.length > MAX_DEVICES) throw new Error('Invalid subscription storage')
      for (const raw of saved.subscriptions) {
        const device = record(raw)
        if (!device || typeof device.expiresAt !== 'number' || device.expiresAt <= this.now() || typeof device.sessionHash !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(device.sessionHash)) continue
        // Grants from older releases have no provable credential generation. Require
        // re-registration rather than restoring them after a password reset or backup.
        if (this.credentialVersion && device.credentialVersion !== this.credentialVersion) continue
        try {
          const subscription = validateSubscription(device.subscription)
          if (subscription.expirationTime && subscription.expirationTime <= this.now()) continue
          this.devices.set(subscription.endpoint, { subscription, preferences: preferencesSchema.parse(device.preferences), sessionHash: device.sessionHash, expiresAt: device.expiresAt, ...(this.credentialVersion ? { credentialVersion: this.credentialVersion } : typeof device.credentialVersion === 'string' ? { credentialVersion: device.credentialVersion } : {}) })
        } catch { /* Invalid or unsupported saved device data is never sent to the network. */ }
      }
      if (Array.isArray(saved.events)) for (const raw of saved.events.slice(-MAX_EVENTS)) {
        const event = record(raw)
        if (event && typeof event.key === 'string' && event.key.length <= 1200 && typeof event.expiresAt === 'number' && event.expiresAt > this.now()) this.events.set(event.key, event.expiresAt)
      }
      await this.save()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read persisted Web Push subscriptions') }
  }

  config() { return { enabled: true, publicKey: this.keys.publicKey } }
  get hasActiveSubscriptions() { return [...this.devices.values()].some(device => device.expiresAt > this.now()) }

  private save() {
    const snapshot = { version: 2, subscriptions: [...this.devices.values()], events: [...this.events].map(([key, expiresAt]) => ({ key, expiresAt })) }
    const writing = this.writes.then(() => atomicPrivateJson(this.file, snapshot))
    this.writes = writing.catch(() => {})
    return writing
  }

  async subscribe(sessionId: string, raw: unknown, preferences: PushPreferences = defaultPreferences) {
    const subscription = validateSubscription(raw)
    if (subscription.expirationTime && subscription.expirationTime <= this.now()) throw Object.assign(new Error('Push subscription has expired'), { status: 400 })
    if (!this.devices.has(subscription.endpoint) && this.devices.size >= MAX_DEVICES) {
      for (const [endpoint, device] of this.devices) if (device.expiresAt <= this.now()) { this.devices.delete(endpoint); this.testTimes.delete(endpoint) }
      if (this.devices.size >= MAX_DEVICES) throw Object.assign(new Error('Too many push devices; remove an existing device first'), { status: 409 })
    }
    const expiresAt = Math.min(this.now() + GRANT_TTL, subscription.expirationTime || Infinity)
    this.devices.set(subscription.endpoint, { subscription, preferences: preferencesSchema.parse(preferences), sessionHash: hash(sessionId), expiresAt, ...(this.credentialVersion ? { credentialVersion: this.credentialVersion } : {}) })
    await this.save()
    return { ok: true, expiresAt }
  }

  private ownedDevice(sessionId: string, endpoint: string) {
    validatePushEndpoint(endpoint)
    const device = this.devices.get(endpoint)
    if (!device || device.expiresAt <= this.now()) throw Object.assign(new Error('This device is not subscribed; enable notifications again'), { status: 404 })
    if (device.sessionHash !== hash(sessionId)) throw Object.assign(new Error('Re-enable notifications for the current login before changing this device'), { status: 403 })
    return device
  }

  async unsubscribe(sessionId: string, endpoint: string) {
    validatePushEndpoint(endpoint)
    if (this.devices.has(endpoint)) { this.ownedDevice(sessionId, endpoint); this.devices.delete(endpoint); this.testTimes.delete(endpoint); await this.save() }
    return { ok: true }
  }

  async updatePreferences(sessionId: string, endpoint: string, preferences: PushPreferences) {
    this.ownedDevice(sessionId, endpoint).preferences = preferencesSchema.parse(preferences)
    await this.save()
    return { ok: true }
  }

  async revokeSession(sessionId: string) {
    const sessionHash = hash(sessionId)
    let changed = false
    for (const [endpoint, device] of this.devices) if (device.sessionHash === sessionHash) { this.devices.delete(endpoint); this.testTimes.delete(endpoint); changed = true }
    if (changed) await this.save()
  }

  async changeCredentialVersion(credentialVersion: string, retainedSessionId: string) {
    this.credentialVersion = credentialVersion
    const retainedHash = hash(retainedSessionId)
    for (const [endpoint, device] of this.devices) {
      if (device.sessionHash !== retainedHash) { this.devices.delete(endpoint); this.testTimes.delete(endpoint) }
      else device.credentialVersion = credentialVersion
    }
    await this.save()
  }

  async test(sessionId: string, endpoint: string) {
    const device = this.ownedDevice(sessionId, endpoint)
    const recent = (this.testTimes.get(endpoint) || []).filter(time => time > this.now() - 60000)
    if (recent.length >= 5) throw Object.assign(new Error('Wait a minute before sending another test notification'), { status: 429 })
    this.testTimes.set(endpoint, [...recent, this.now()])
    await this.enqueue(() => this.deliver(device, { title: 'Codex', body: '后台通知已开启。', tag: `codex-push-test-${randomUUID()}`, data: { url: '/', kind: 'test' } }))
    return { ok: true }
  }

  private rememberThread(host: Host, raw: unknown) {
    const thread = record(raw); const threadId = id(thread?.id)
    if (!thread || !threadId || (!('name' in thread) && !('preview' in thread))) return
    const key = JSON.stringify([host.id, threadId])
    const title = { ...this.threadTitles.get(key),
      ...('name' in thread ? { name: titleText(thread.name) } : {}),
      ...('preview' in thread ? { preview: titleText(thread.preview) } : {}),
    }
    this.threadTitles.delete(key)
    this.threadTitles.set(key, title)
    while (this.threadTitles.size > MAX_THREAD_TITLES) this.threadTitles.delete(this.threadTitles.keys().next().value!)
  }

  private observeThread(host: Host, message: RpcMessage, responseMethod?: string) {
    const params = record(message.params)
    if (message.method === 'thread/started') this.rememberThread(host, params?.thread)
    if (message.method === 'thread/name/updated' && params) this.rememberThread(host, {
      id: params.threadId, name: 'threadName' in params ? params.threadName : params.name,
    })
    if (message.error) return
    const result = record(message.result)
    const readId = id(record(result?.thread)?.id)
    if (responseMethod === 'thread/read' && readId && this.threadLookups.has(JSON.stringify([host.id, readId]))) return
    if (['thread/start', 'thread/resume', 'thread/read', 'thread/fork'].includes(responseMethod || '')) this.rememberThread(host, result?.thread)
    if (['thread/list', 'thread/search'].includes(responseMethod || '') && Array.isArray(result?.data))
      for (const thread of result.data) this.rememberThread(host, thread)
  }

  private threadTitle(host: Host, threadId: string): Promise<string> {
    const key = JSON.stringify([host.id, threadId])
    const cached = this.threadTitles.get(key)
    const title = cached?.name || cached?.preview
    if (title || !this.options.resolveThread) return Promise.resolve(title || '未命名对话')
    const pending = this.threadLookups.get(key)
    if (pending) return pending
    const lookup = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        const raw = await Promise.race([
          this.options.resolveThread!(host, threadId),
          new Promise<undefined>(resolve => { deadline = setTimeout(() => resolve(undefined), 3000); deadline.unref() }),
        ])
        // A rename received during the lookup is newer than its response.
        if (id(record(raw)?.id) === threadId && this.threadTitles.get(key) === cached) this.rememberThread(host, raw)
      } catch { /* Missing metadata never prevents delivery of the event. */ }
      finally { clearTimeout(deadline) }
      const current = this.threadTitles.get(key)
      return current?.name || current?.preview || '未命名对话'
    })()
    this.threadLookups.set(key, lookup)
    void lookup.finally(() => { if (this.threadLookups.get(key) === lookup) this.threadLookups.delete(key) })
    return lookup
  }

  observe(host: Host, message: RpcMessage, responseMethod?: string) {
    if (this.closed) return
    this.observeThread(host, message, responseMethod)
    if (!this.hasActiveSubscriptions) return
    const params = record(message.params)
    const threadId = id(params?.threadId) || id(params?.conversationId)
    if (!params || !threadId) return
    let kind: 'completed' | 'approval' | 'errors' | undefined
    let identity: string | undefined
    let body: string | undefined
    if (message.method === 'turn/completed') {
      const turn = record(params.turn); const turnId = id(turn?.id)
      if (!turnId || !['completed', 'failed'].includes(String(turn?.status))) return
      kind = turn?.status === 'failed' || turn?.error ? 'errors' : 'completed'
      body = kind === 'errors' ? '运行失败' : '运行完成'
      identity = `turn:${turnId}`
    } else if (message.method === 'error' && params.willRetry === false) {
      const turnId = id(params.turnId)
      if (!turnId) return
      kind = 'errors'; identity = `turn:${turnId}`
      body = '运行失败'
    } else if (message.id !== undefined && (actionableRequests.has(message.method || '') ||
      (message.method === 'mcpServer/elicitation/request' && elicitationModes.has(String(params.mode))))) {
      if ((typeof message.id !== 'string' && typeof message.id !== 'number') || String(message.id).length > 256) return
      kind = 'approval'; identity = `request:${id(params.turnId) || id(params.callId) || ''}:${message.method}:${JSON.stringify(message.id)}`
      body = ['item/commandExecution/requestApproval', 'execCommandApproval'].includes(message.method || '') ? '等待命令执行确认'
        : ['item/fileChange/requestApproval', 'applyPatchApproval'].includes(message.method || '') ? '等待文件修改确认'
        : message.method === 'item/permissions/requestApproval' ? '等待权限确认'
        : message.method === 'item/tool/requestUserInput' ? '等待补充输入' : '等待确认或补充输入'
    }
    if (!kind || !identity || !body) return
    const key = JSON.stringify([host.id, threadId, identity])
    for (const [key, expiry] of this.events) if (expiry <= this.now()) this.events.delete(key)
    if (this.events.has(key)) return
    this.events.set(key, this.now() + EVENT_TTL)
    while (this.events.size > MAX_EVENTS) this.events.delete(this.events.keys().next().value!)
    const notice: PushNotice = { title: 'Codex', body, tag: `codex-${hash(key).slice(0, 24)}`, data: { hostId: host.id, threadId, url: `/?host=${encodeURIComponent(host.id)}&thread=${encodeURIComponent(threadId)}`, kind } }
    const task = this.notify(host, threadId, kind, notice).catch(() => {})
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }

  private async notify(host: Host, threadId: string, kind: keyof PushPreferences, notice: PushNotice) {
    await this.save()
    notice.title = await this.threadTitle(host, threadId)
    let pruned = false
    const jobs: Promise<void>[] = []
    for (const [endpoint, device] of this.devices) {
      if (device.expiresAt <= this.now()) { this.devices.delete(endpoint); this.testTimes.delete(endpoint); pruned = true; continue }
      if (device.preferences[kind]) jobs.push(this.enqueue(() => this.deliver(device, notice)).catch(() => {}))
    }
    if (pruned) await this.save()
    await Promise.all(jobs)
  }

  private enqueue(run: () => Promise<void>) {
    if (this.closed || this.deliveries.length >= 256) return Promise.reject(new Error('Push delivery queue is unavailable'))
    return new Promise<void>((resolve, reject) => {
      this.deliveries.push({ run, resolve, reject })
      this.runDeliveries()
    })
  }

  private runDeliveries() {
    while (this.activeDeliveries < 4 && this.deliveries.length) {
      const job = this.deliveries.shift()!
      this.activeDeliveries++
      void job.run().then(job.resolve, job.reject).finally(() => { this.activeDeliveries--; this.runDeliveries() })
    }
  }

  private async deliver(device: Device, notice: PushNotice) {
    const endpoint = device.subscription.endpoint
    // A queued job may outlive a preference change, logout or subscription replacement.
    if (this.devices.get(endpoint) !== device || device.expiresAt <= this.now() || (notice.data.kind !== 'test' && !device.preferences[notice.data.kind])) return
    validatePushEndpoint(endpoint)
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.send(device.subscription, JSON.stringify(notice), { vapidDetails: this.keys, TTL: 3600, timeout: 10000, contentEncoding: 'aes128gcm', urgency: 'high', topic: hash(notice.tag).slice(0, 32) }),
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Push delivery timed out')), 12000); deadline.unref() }),
      ])
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode
      if ((status === 404 || status === 410) && this.devices.get(endpoint) === device) { this.devices.delete(endpoint); this.testTimes.delete(endpoint); await this.save() }
      // Upstream errors often contain endpoint tokens and must never reach HTTP clients or logs.
      throw Object.assign(new Error(status === 404 || status === 410 ? 'This device subscription expired; enable notifications again' : 'Unable to deliver the notification; check server access to the push provider'), { status: status === 404 || status === 410 ? 410 : 502 })
    } finally { clearTimeout(deadline) }
  }

  async flush() { while (this.pending.size) await Promise.allSettled([...this.pending]); await this.writes }
  async close() { await this.flush(); this.closed = true }
}

export function registerPush(app: Express, push: PushService) {
  const route = (handler: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next) }
  const endpointBody = z.object({ endpoint: z.string().min(1).max(4096) }).strict()
  app.get('/api/push/config', (_req, res) => res.json(push.config()))
  app.post('/api/push/subscription', route(async (req: AuthenticatedRequest, res) => {
    const body = z.object({ subscription: subscriptionSchema, preferences: preferencesSchema.optional() }).strict().parse(req.body)
    res.json(await push.subscribe(req.session!.id, body.subscription, body.preferences))
  }))
  app.patch('/api/push/subscription', route(async (req: AuthenticatedRequest, res) => {
    const body = endpointBody.extend({ preferences: preferencesSchema }).parse(req.body)
    res.json(await push.updatePreferences(req.session!.id, body.endpoint, body.preferences))
  }))
  app.delete('/api/push/subscription', route(async (req: AuthenticatedRequest, res) => {
    res.json(await push.unsubscribe(req.session!.id, endpointBody.parse(req.body).endpoint))
  }))
  app.post('/api/push/test', route(async (req: AuthenticatedRequest, res) => {
    res.json(await push.test(req.session!.id, endpointBody.parse(req.body).endpoint))
  }))
}
