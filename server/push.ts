import fs from 'node:fs/promises'
import path from 'node:path'
import { createECDH, createHash, randomUUID } from 'node:crypto'
import type { Express, RequestHandler } from 'express'
import webPush, { type PushSubscription, type RequestOptions } from 'web-push'
import { z } from 'zod'
import type { AuthenticatedRequest, Host, RpcId, RpcMessage } from './types.js'
import { isInteractiveServerRequest } from '../shared/server-requests.js'

const GRANT_TTL = 30 * 24 * 60 * 60 * 1000
const EVENT_TTL = 24 * 60 * 60 * 1000
const MAX_DEVICES = 64
const MAX_EVENTS = 2000
const MAX_THREAD_TITLES = 2000
const DELIVERY_TTL = 60 * 60 * 1000
const MAX_OUTBOX = 1024
const MAX_ATTEMPTS = 8
type DeliveryFailure = 'provider_unavailable' | 'rate_limited' | 'timeout' | 'rejected' | 'metadata_pending' | 'expired' | 'queue_full'
type DeliveryHealth = { delivered: number; failed: number; expired: number; overflow?: number; lastDeliveredAt?: number; lastFailureAt?: number; lastFailure?: DeliveryFailure }
const preferencesSchema = z.object({ completed: z.boolean(), approval: z.boolean(), errors: z.boolean() }).strict()
export type PushPreferences = z.infer<typeof preferencesSchema>
const defaultPreferences: PushPreferences = { completed: true, approval: true, errors: true }
const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(4096),
  expirationTime: z.number().nonnegative().nullable().optional(),
  keys: z.object({ p256dh: z.string().max(128), auth: z.string().max(64) }).strict(),
}).strict()
type Device = { subscription: PushSubscription; preferences: PushPreferences; sessionHash: string; expiresAt: number; credentialVersion?: string; grantId: string; delivery: DeliveryHealth }
type PushNotice = { title: string; body: string; tag: string; data: { hostId?: string; threadId?: string; url: string; kind: 'completed' | 'approval' | 'errors' | 'test' } }
type PendingNotice = { requestId: RpcId; deadline?: number }
type OutboxDelivery = { id: string; endpoint: string; grantId: string; sessionHash: string; credentialVersion?: string; notice: PushNotice; createdAt: number; expiresAt: number; attempts: number; nextAttemptAt: number; metadataHost?: Host; failure?: DeliveryFailure; requestId?: RpcId }
type DeliveryOutcome = { ok: true; queued?: true; retryAt?: number } | { error: Error }
export type PushOptions = {
  vapidPublicKey?: string; vapidPrivateKey?: string; subject?: string
  sendNotification?: (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>
  now?: () => number
  /** Bound to the persisted web credential generation; provided by the application. */
  credentialVersion?: string
  /** Read thread metadata without loading turns or starting a model request. */
  resolveThread?: (host: Host, threadId: string) => Promise<unknown>
  /** Durable auth logout tombstones take precedence even if the push store write failed. */
  isSessionRevoked?: (sessionHash: string) => boolean
  /** Test hooks; production uses a one-hour TTL, 1,024 deliveries and five-second initial backoff. */
  retryBaseMs?: number; deliveryTtlMs?: number; maxQueuedDeliveries?: number
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
type ThreadTitle = { name?: string; preview?: string; subagent?: boolean; ephemeral?: boolean; sourceKnown?: boolean; sourceChecked?: boolean }
const failureSchema = z.enum(['provider_unavailable', 'rate_limited', 'timeout', 'rejected', 'metadata_pending', 'expired', 'queue_full'])
const healthSchema = z.object({ delivered: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), expired: z.number().int().nonnegative(), overflow: z.number().int().nonnegative().optional(), lastDeliveredAt: z.number().nonnegative().optional(), lastFailureAt: z.number().nonnegative().optional(), lastFailure: failureSchema.optional() }).strict()
const noticeSchema = z.object({ title: z.string().max(100), body: z.string().max(100), tag: z.string().max(100), data: z.object({ hostId: z.string().max(256).optional(), threadId: z.string().max(256).optional(), url: z.string().max(4096), kind: z.enum(['completed', 'approval', 'errors', 'test']) }).strict() }).strict()
const outboxSchema = z.object({ id: z.string().uuid(), endpoint: z.string().max(4096), grantId: z.string().uuid(), sessionHash: z.string().regex(/^[a-zA-Z0-9_-]{43}$/), credentialVersion: z.string().optional(), notice: noticeSchema, createdAt: z.number().nonnegative(), expiresAt: z.number().nonnegative(), attempts: z.number().int().min(0).max(MAX_ATTEMPTS), nextAttemptAt: z.number().nonnegative(), metadataHost: z.object({ id: z.string().min(1).max(256), name: z.string().max(256), kind: z.enum(['local', 'ssh']) }).strict().optional(), failure: failureSchema.optional(), requestId: z.union([z.string().max(256), z.number().int().safe()]).optional() }).strict()
function emptyHealth(): DeliveryHealth { return { delivered: 0, failed: 0, expired: 0 } }
function providerError(expired = false) { return Object.assign(new Error(expired ? 'This device subscription expired; enable notifications again' : 'Unable to deliver the notification; check server access to the push provider'), { status: expired ? 410 : 502 }) }

async function atomicPrivateJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
    await fs.chmod(file, 0o600)
  } finally { await fs.rm(temporary, { force: true }) }
}

/** Durable device grants expire independently and are revoked when the access password changes. */
export class PushService {
  private devices = new Map<string, Device>()
  private events = new Map<string, number>()
  private testTimes = new Map<string, number[]>()
  private threadTitles = new Map<string, ThreadTitle>()
  private threadLookups = new Map<string, Promise<string>>()
  private writes: Promise<void> = Promise.resolve()
  private pending = new Set<Promise<void>>()
  private outbox = new Map<string, OutboxDelivery>()
  private uncommitted = new Set<string>()
  private pendingEvents = new Set<string>()
  private active = new Map<string, Promise<void>>()
  private outcomes = new Map<string, (outcome: DeliveryOutcome) => void>()
  private retryTimer?: ReturnType<typeof setTimeout>
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
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8')) as { version?: number; subscriptions?: unknown[]; events?: unknown[]; outbox?: unknown[] }
      if (![1, 2, 3].includes(saved.version || 0) || !Array.isArray(saved.subscriptions) || saved.subscriptions.length > MAX_DEVICES) throw new Error('Invalid subscription storage')
      for (const raw of saved.subscriptions) {
        const device = record(raw)
        if (!device || typeof device.expiresAt !== 'number' || device.expiresAt <= this.now() || typeof device.sessionHash !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(device.sessionHash)) continue
        // Grants from older releases have no provable credential generation. Require
        // re-registration rather than restoring them after a password reset or backup.
        if (this.credentialVersion && device.credentialVersion !== this.credentialVersion) continue
        if (this.options.isSessionRevoked?.(device.sessionHash)) continue
        try {
          const subscription = validateSubscription(device.subscription)
          if (subscription.expirationTime && subscription.expirationTime <= this.now()) continue
          const grantId = z.string().uuid().safeParse(device.grantId)
          const health = healthSchema.safeParse(device.delivery)
          this.devices.set(subscription.endpoint, { subscription, preferences: preferencesSchema.parse(device.preferences), sessionHash: device.sessionHash, expiresAt: device.expiresAt, grantId: grantId.success ? grantId.data : randomUUID(), delivery: health.success ? health.data : emptyHealth(), ...(this.credentialVersion ? { credentialVersion: this.credentialVersion } : typeof device.credentialVersion === 'string' ? { credentialVersion: device.credentialVersion } : {}) })
        } catch { /* Invalid or unsupported saved device data is never sent to the network. */ }
      }
      if (Array.isArray(saved.events)) for (const raw of saved.events.slice(-MAX_EVENTS)) {
        const event = record(raw)
        if (event && typeof event.key === 'string' && event.key.length <= 1200 && typeof event.expiresAt === 'number' && event.expiresAt > this.now()) this.events.set(event.key, event.expiresAt)
      }
      if (saved.version === 3 && Array.isArray(saved.outbox)) for (const raw of saved.outbox.slice(0, this.maxOutbox * 5)) {
        const parsed = outboxSchema.safeParse(raw)
        if (!parsed.success) continue
        const job = parsed.data
        if (!job.notice.data.url.startsWith('/?') && job.notice.data.url !== '/') continue
        if (job.expiresAt <= this.now() || job.attempts >= MAX_ATTEMPTS || !this.liveDevice(job)) continue
        this.outbox.set(job.id, job)
      }
      await this.save()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read persisted Web Push subscriptions') }
    this.runDeliveries()
  }

  config() { return { enabled: true, publicKey: this.keys.publicKey } }
  get hasActiveSubscriptions() { return [...this.devices.values()].some(device => this.authorized(device)) }
  private get maxOutbox() { return Math.max(1, Math.min(MAX_OUTBOX, this.options.maxQueuedDeliveries || MAX_OUTBOX)) }
  private get deliveryTtl() { return Math.max(1000, Math.min(DELIVERY_TTL, this.options.deliveryTtlMs || DELIVERY_TTL)) }
  private authorized(device: Device) { return device.expiresAt > this.now() && (!this.credentialVersion || device.credentialVersion === this.credentialVersion) && !this.options.isSessionRevoked?.(device.sessionHash) }
  private liveDevice(job: OutboxDelivery) {
    const device = this.devices.get(job.endpoint)
    if (!device || !this.authorized(device) || device.grantId !== job.grantId || device.sessionHash !== job.sessionHash || device.credentialVersion !== job.credentialVersion || (job.notice.data.kind !== 'test' && !device.preferences[job.notice.data.kind])) return undefined
    return device
  }

  private save() {
    // Clone now: later mutations must never sneak into a queued snapshot before its commit.
    const snapshot = structuredClone({ version: 3, subscriptions: [...this.devices.values()], events: [...this.events].map(([key, expiresAt]) => ({ key, expiresAt })), outbox: [...this.outbox.values()] })
    const writing = this.writes.then(() => atomicPrivateJson(this.file, snapshot))
    this.writes = writing.catch(() => {})
    return writing
  }

  async subscribe(sessionId: string, raw: unknown, preferences: PushPreferences = defaultPreferences) {
    const subscription = validateSubscription(raw)
    const sessionHash = hash(sessionId)
    if (this.options.isSessionRevoked?.(sessionHash)) throw Object.assign(new Error('Sign in again before enabling notifications'), { status: 401 })
    this.prune()
    if (subscription.expirationTime && subscription.expirationTime <= this.now()) throw Object.assign(new Error('Push subscription has expired'), { status: 400 })
    if (!this.devices.has(subscription.endpoint) && this.devices.size >= MAX_DEVICES) {
      for (const [endpoint, device] of this.devices) if (device.expiresAt <= this.now()) { this.devices.delete(endpoint); this.testTimes.delete(endpoint) }
      if (this.devices.size >= MAX_DEVICES) throw Object.assign(new Error('Too many push devices; remove an existing device first'), { status: 409 })
    }
    const expiresAt = Math.min(this.now() + GRANT_TTL, subscription.expirationTime || Infinity)
    const previous = this.devices.get(subscription.endpoint)
    const sameGrant = previous?.sessionHash === sessionHash && previous.credentialVersion === this.credentialVersion && previous.subscription.keys.auth === subscription.keys.auth && previous.subscription.keys.p256dh === subscription.keys.p256dh
    this.devices.set(subscription.endpoint, { subscription, preferences: preferencesSchema.parse(preferences), sessionHash, expiresAt, grantId: sameGrant ? previous.grantId : randomUUID(), delivery: sameGrant ? previous.delivery : emptyHealth(), ...(this.credentialVersion ? { credentialVersion: this.credentialVersion } : {}) })
    this.prune()
    await this.save()
    this.runDeliveries()
    return { ok: true, expiresAt }
  }

  private ownedDevice(sessionId: string, endpoint: string) {
    validatePushEndpoint(endpoint)
    const device = this.devices.get(endpoint)
    if (!device || !this.authorized(device)) throw Object.assign(new Error('This device is not subscribed; enable notifications again'), { status: 404 })
    if (device.sessionHash !== hash(sessionId)) throw Object.assign(new Error('Re-enable notifications for the current login before changing this device'), { status: 403 })
    return device
  }

  async unsubscribe(sessionId: string, endpoint: string) {
    validatePushEndpoint(endpoint)
    if (this.devices.has(endpoint)) { this.ownedDevice(sessionId, endpoint); this.devices.delete(endpoint); this.testTimes.delete(endpoint); this.prune(); await this.save() }
    return { ok: true }
  }

  async updatePreferences(sessionId: string, endpoint: string, preferences: PushPreferences) {
    this.ownedDevice(sessionId, endpoint).preferences = preferencesSchema.parse(preferences)
    this.prune()
    await this.save()
    return { ok: true }
  }

  async revokeSession(sessionId: string) {
    const sessionHash = hash(sessionId)
    let changed = false
    for (const [endpoint, device] of this.devices) if (device.sessionHash === sessionHash) { this.devices.delete(endpoint); this.testTimes.delete(endpoint); changed = true }
    if (changed) { this.prune(); await this.save() }
  }

  async changeCredentialVersion(credentialVersion: string, retainedSessionId: string) {
    this.credentialVersion = credentialVersion
    const retainedHash = hash(retainedSessionId)
    for (const [endpoint, device] of this.devices) {
      if (device.sessionHash !== retainedHash) { this.devices.delete(endpoint); this.testTimes.delete(endpoint) }
      else device.credentialVersion = credentialVersion
    }
    for (const job of this.outbox.values()) if (job.sessionHash === retainedHash) job.credentialVersion = credentialVersion
    this.prune()
    await this.save()
  }

  async test(sessionId: string, endpoint: string) {
    const device = this.ownedDevice(sessionId, endpoint)
    const recent = (this.testTimes.get(endpoint) || []).filter(time => time > this.now() - 60000)
    if (recent.length >= 5) throw Object.assign(new Error('Wait a minute before sending another test notification'), { status: 429 })
    this.testTimes.set(endpoint, [...recent, this.now()])
    this.prune()
    if (this.closed || this.outbox.size >= this.maxOutbox) throw Object.assign(new Error('Push delivery queue is full; try again shortly'), { status: 503 })
    const job = this.newDelivery(device, { title: 'Codex', body: '后台通知已开启。', tag: `codex-push-test-${randomUUID()}`, data: { url: '/', kind: 'test' } })
    this.outbox.set(job.id, job)
    this.uncommitted.add(job.id)
    try { await this.save() } catch (error) { this.outbox.delete(job.id); this.outcomes.delete(job.id); throw error }
    finally { this.uncommitted.delete(job.id) }
    this.runDeliveries()
    return { ok: true as const, queued: true as const }
  }

  /** Own-device aggregate health only: no endpoint, keys, conversation text or credential hashes. */
  status(sessionId: string) {
    const own = [...this.devices.values()].filter(device => device.sessionHash === hash(sessionId) && this.authorized(device))
    const grants = new Set(own.map(device => device.grantId))
    const queued = [...this.outbox.values()].filter(job => grants.has(job.grantId) && job.expiresAt > this.now() && this.liveDevice(job))
    const recent = own.map(device => device.delivery).sort((a, b) => (b.lastFailureAt || 0) - (a.lastFailureAt || 0))
    return { devices: own.length, queued: queued.length, retrying: queued.filter(job => job.attempts > 0 || job.failure).length,
      overflow: own.reduce((sum, device) => sum + (device.delivery.overflow || 0), 0), backlog: Math.max(0, queued.length - this.maxOutbox),
      delivered: own.reduce((sum, device) => sum + device.delivery.delivered, 0), failed: own.reduce((sum, device) => sum + device.delivery.failed, 0), expired: own.reduce((sum, device) => sum + device.delivery.expired, 0),
      nextRetryAt: queued.length ? Math.min(...queued.map(job => job.nextAttemptAt)) : null,
      lastDeliveredAt: Math.max(0, ...own.map(device => device.delivery.lastDeliveredAt || 0)) || null,
      lastFailureAt: recent[0]?.lastFailureAt || null, lastFailure: recent[0]?.lastFailure || null }
  }

  private newDelivery(device: Device, notice: PushNotice, metadataHost?: Host): OutboxDelivery {
    return { id: randomUUID(), endpoint: device.subscription.endpoint, grantId: device.grantId, sessionHash: device.sessionHash, ...(device.credentialVersion ? { credentialVersion: device.credentialVersion } : {}), notice: structuredClone(notice), createdAt: this.now(), expiresAt: Math.min(this.now() + this.deliveryTtl, device.expiresAt), attempts: 0, nextAttemptAt: this.now(), ...(metadataHost ? { metadataHost: { id: metadataHost.id, name: metadataHost.name.slice(0, 256), kind: metadataHost.kind } } : {}) }
  }

  private finish(job: OutboxDelivery, outcome: DeliveryOutcome) {
    const resolve = this.outcomes.get(job.id); this.outcomes.delete(job.id); resolve?.(outcome)
  }

  private prune() {
    let changed = false
    for (const [endpoint, device] of this.devices) if (!this.authorized(device)) { this.devices.delete(endpoint); this.testTimes.delete(endpoint); changed = true }
    for (const [key, expiry] of this.events) if (expiry <= this.now()) { this.events.delete(key); changed = true }
    for (const [key, job] of this.outbox) {
      const device = this.liveDevice(job)
      if (device && job.expiresAt > this.now()) continue
      if (device) { device.delivery.expired++; device.delivery.lastFailure = 'expired'; device.delivery.lastFailureAt = this.now() }
      this.outbox.delete(key); this.finish(job, { error: providerError() }); changed = true
    }
    return changed
  }

  private rememberThread(host: Host, raw: unknown) {
    const thread = record(raw); const threadId = id(thread?.id)
    if (!thread || !threadId) return
    const key = JSON.stringify([host.id, threadId])
    const source = record(thread.source)
    const child = !!thread.parentThreadId || !!(source && ('subagent' in source || 'subAgent' in source)) || ['subagent', 'subAgent'].includes(String(thread.source))
    const title = { ...this.threadTitles.get(key),
      ...(child ? { subagent: true, sourceKnown: true } : typeof thread.source === 'string' && ['cli', 'vscode', 'exec', 'appServer'].includes(thread.source) || source && typeof source.custom === 'string' ? { sourceKnown: true } : {}),
      ...(typeof thread.ephemeral === 'boolean' ? { ephemeral: thread.ephemeral } : {}),
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
    const item = record(params?.item)
    if (['item/started', 'item/completed'].includes(message.method || '') && item?.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds))
      for (const childId of item.receiverThreadIds) if (id(childId) && childId !== params?.threadId) this.rememberThread(host, { id: childId, parentThreadId: params?.threadId || 'subagent' })
    if (message.error) return
    const result = record(message.result)
    const readId = id(record(result?.thread)?.id)
    if (responseMethod === 'thread/read' && readId && this.threadLookups.has(JSON.stringify([host.id, readId]))) return
    if (['thread/start', 'thread/resume', 'thread/read', 'thread/fork'].includes(responseMethod || '')) this.rememberThread(host, result?.thread)
    if (['thread/list', 'thread/search'].includes(responseMethod || '') && Array.isArray(result?.data))
      for (const thread of result.data) this.rememberThread(host, thread)
  }

  private threadTitle(host: Host, threadId: string, needSource = false): Promise<string> {
    const key = JSON.stringify([host.id, threadId])
    const cached = this.threadTitles.get(key)
    const title = cached?.name || cached?.preview
    if ((title || cached?.sourceChecked) && (!needSource || cached?.sourceKnown) || !this.options.resolveThread) return Promise.resolve(title || '未命名对话')
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
        if (id(record(raw)?.id) === threadId) {
          if (this.threadTitles.get(key) === cached) this.rememberThread(host, raw)
          else { const thread = record(raw)!; this.rememberThread(host, { id: threadId, ...('source' in thread ? { source: thread.source } : {}), ...('parentThreadId' in thread ? { parentThreadId: thread.parentThreadId } : {}), ...('ephemeral' in thread ? { ephemeral: thread.ephemeral } : {}) }) }
        }
      } catch { /* Defer completion until source metadata can exclude auxiliary threads. */ }
      finally { clearTimeout(deadline); const latest = this.threadTitles.get(key); this.threadTitles.set(key, { ...latest, sourceChecked: true }); while (this.threadTitles.size > MAX_THREAD_TITLES) this.threadTitles.delete(this.threadTitles.keys().next().value!) }
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
    if (message.method === 'serverRequest/resolved') {
      const resolved = record(message.params)
      let changed = false
      for (const [key, job] of this.outbox) {
        if (job.notice.data.hostId !== host.id || job.requestId === undefined || job.requestId !== resolved?.requestId ||
            resolved.threadId && job.notice.data.threadId !== resolved.threadId) continue
        this.outbox.delete(key); this.finish(job, { ok: true }); changed = true
      }
      if (changed) {
        const task = this.save().catch(() => {})
        this.pending.add(task); void task.finally(() => this.pending.delete(task))
      }
      return
    }
    if (!this.hasActiveSubscriptions) return
    const params = record(message.params)
    const threadId = id(params?.threadId) || id(params?.conversationId)
    if (!params || !threadId) return
    let kind: 'completed' | 'approval' | 'errors' | undefined
    let identity: string | undefined
    let body: string | undefined
    let request: PendingNotice | undefined
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
    } else if (isInteractiveServerRequest(message)) {
      if ((typeof message.id !== 'string' && typeof message.id !== 'number') || String(message.id).length > 256) return
      kind = 'approval'; identity = `request:${id(params.turnId) || id(params.callId) || ''}:${message.method}:${JSON.stringify(message.id)}`
      request = { requestId: message.id }
      body = ['item/commandExecution/requestApproval', 'execCommandApproval'].includes(message.method || '') ? '等待命令执行确认'
        : ['item/fileChange/requestApproval', 'applyPatchApproval'].includes(message.method || '') ? '等待文件修改确认'
        : message.method === 'item/permissions/requestApproval' ? '等待权限确认'
        : message.method?.endsWith('requestUserInput') ? (Array.isArray(params.questions) && params.questions.some(question => Array.isArray(record(question)?.options) && (record(question)!.options as unknown[]).length) ? '等待你的选择' : '等待补充输入') : '等待确认或补充输入'
      if (['item/tool/requestUserInput', 'tool/requestUserInput'].includes(message.method || '')) {
        const context = record(params.bridgeUserInputContext), ms = params.autoResolutionMs
        const deadline = context ? context.autoResolveAt : typeof ms === 'number' && Number.isSafeInteger(ms) && ms >= 0 ? this.now() + ms : null
        if (typeof deadline === 'number' && Number.isSafeInteger(deadline) && deadline >= 0) {
          if (deadline <= this.now()) return
          request.deadline = deadline
          body += '（限时）'
        }
      }
    }
    if (!kind || !identity || !body) return
    const key = JSON.stringify([host.id, threadId, identity])
    for (const [key, expiry] of this.events) if (expiry <= this.now()) this.events.delete(key)
    if (this.events.has(key) || this.pendingEvents.has(key)) return
    this.pendingEvents.add(key)
    const notice: PushNotice = { title: 'Codex', body, tag: `codex-${hash(key).slice(0, 24)}`, data: { hostId: host.id, threadId, url: `/?host=${encodeURIComponent(host.id)}&thread=${encodeURIComponent(threadId)}`, kind } }
    const task = this.notify(key, host, threadId, kind, notice, request).catch(() => {}).finally(() => this.pendingEvents.delete(key))
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }

  private async notify(key: string, host: Host, threadId: string, kind: keyof PushPreferences, notice: PushNotice, request?: PendingNotice) {
    const auxiliary = () => { const metadata = this.threadTitles.get(JSON.stringify([host.id, threadId])); return metadata?.subagent || metadata?.ephemeral }
    this.prune()
    const jobs = kind !== 'approval' && auxiliary() ? [] : [...this.devices.values()].filter(device => this.authorized(device) && device.preferences[kind]).map(device => {
      const job = this.newDelivery(device, notice, host)
      if (request) {
        job.requestId = request.requestId
        if (request.deadline !== undefined) job.expiresAt = Math.min(job.expiresAt, request.deadline)
      }
      return job
    })
    // The first 1,024 jobs are the delivery queue; up to four more queue-sized
    // batches form a durable backlog. Provider recovery drains the same journal.
    const accepted: OutboxDelivery[] = [];
    for (const job of jobs) {
      if (this.outbox.size < this.maxOutbox * 5) {
        accepted.push(job); this.outbox.set(job.id, job); this.uncommitted.add(job.id);
      } else {
        const device = this.liveDevice(job);
        if (device) { device.delivery.failed++; device.delivery.overflow = (device.delivery.overflow || 0) + 1; device.delivery.lastFailure = 'queue_full'; device.delivery.lastFailureAt = this.now(); }
      }
    }
    this.events.set(key, this.now() + EVENT_TTL)
    while (this.events.size > MAX_EVENTS) this.events.delete(this.events.keys().next().value!)
    try { await this.save() } catch (error) { this.events.delete(key); for (const job of accepted) this.outbox.delete(job.id); throw error }
    finally { for (const job of accepted) this.uncommitted.delete(job.id) }
    this.runDeliveries()
  }

  private runDeliveries() {
    clearTimeout(this.retryTimer); this.retryTimer = undefined
    if (this.closed) return
    if (this.prune()) void this.save().catch(() => {})
    for (const job of this.outbox.values()) {
      if (this.active.size >= 4) break
      if (this.active.has(job.id) || this.uncommitted.has(job.id) || job.nextAttemptAt > this.now()) continue
      const running = this.deliver(job).catch(() => {
        // Keep the last committed state for recovery, and avoid a hot loop if disk
        // writes fail. Never report success before recording the acknowledgement.
        job.nextAttemptAt = this.now() + 5000; this.finish(job, { error: providerError() })
      }).finally(() => { this.active.delete(job.id); this.runDeliveries() })
      this.active.set(job.id, running)
    }
    const waiting = [...this.outbox.values()].filter(job => !this.active.has(job.id) && !this.uncommitted.has(job.id))
    if (!waiting.length || this.active.size >= 4 && waiting.some(job => job.nextAttemptAt <= this.now())) return
    const next = Math.min(...waiting.map(job => Math.min(job.nextAttemptAt, job.expiresAt)))
    this.retryTimer = setTimeout(() => this.runDeliveries(), Math.max(1, next - this.now())); this.retryTimer.unref()
  }

  private async retry(job: OutboxDelivery, device: Device, failure: DeliveryFailure, retryAfter?: number) {
    job.failure = failure
    device.delivery.lastFailureAt = this.now(); device.delivery.lastFailure = failure
    const delay = Math.max(retryAfter || 0, Math.min(10 * 60 * 1000, (this.options.retryBaseMs || 5000) * 2 ** Math.max(0, job.attempts - 1)))
    job.nextAttemptAt = Math.min(job.expiresAt, this.now() + delay)
    if (job.attempts >= MAX_ATTEMPTS || job.expiresAt <= this.now()) {
      this.outbox.delete(job.id); device.delivery.failed++
    }
    await this.save()
    this.finish(job, this.outbox.has(job.id) ? { ok: true, queued: true, retryAt: job.nextAttemptAt } : { error: providerError() })
  }

  private async deliver(job: OutboxDelivery) {
    let device = this.liveDevice(job)
    if (!device || !this.outbox.has(job.id)) return
    if (job.attempts >= MAX_ATTEMPTS) { this.outbox.delete(job.id); device.delivery.failed++; await this.save(); this.finish(job, { error: providerError() }); return }
    job.attempts++
    // Record attempts before dispatch, including metadata failures, so crashes and
    // permanent upstream failures cannot cause unlimited restart retries.
    await this.save()
    if (job.metadataHost && job.notice.data.threadId) {
      job.notice.title = await this.threadTitle(job.metadataHost, job.notice.data.threadId, job.notice.data.kind !== 'approval')
      const metadata = this.threadTitles.get(JSON.stringify([job.metadataHost.id, job.notice.data.threadId]))
      if (job.notice.data.kind !== 'approval') {
        if (metadata?.subagent || metadata?.ephemeral) { this.outbox.delete(job.id); await this.save(); this.finish(job, { ok: true }); return }
        if (!metadata?.sourceKnown) { await this.retry(job, device, 'metadata_pending'); return }
      }
    }
    device = this.liveDevice(job)
    if (!device || !this.outbox.has(job.id) || job.expiresAt <= this.now()) { this.prune(); await this.save(); return }
    const endpoint = device.subscription.endpoint
    validatePushEndpoint(endpoint)
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.send(device.subscription, JSON.stringify(job.notice), { vapidDetails: this.keys, TTL: Math.max(1, Math.ceil((job.expiresAt - this.now()) / 1000)), timeout: 10000, contentEncoding: 'aes128gcm', urgency: 'high', topic: hash(job.notice.tag).slice(0, 32) }),
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(Object.assign(new Error('Push delivery timed out'), { code: 'ETIMEDOUT' })), 12000); deadline.unref() }),
      ])
      if (this.liveDevice(job) === device) { device.delivery.delivered++; device.delivery.lastDeliveredAt = this.now() }
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode
      if (!this.outbox.has(job.id) || this.liveDevice(job) !== device) return
      if (status === 404 || status === 410) { this.devices.delete(endpoint); this.testTimes.delete(endpoint); this.outbox.delete(job.id); this.prune(); await this.save(); this.finish(job, { error: providerError(true) }); return }
      // Upstream errors often contain endpoint tokens and must never reach HTTP clients or logs.
      if (status === undefined || status === 408 || status === 429 || status >= 500 && status < 600) {
        const rawRetry = record((error as { headers?: unknown })?.headers)?.['retry-after']
        const retryAfter = typeof rawRetry === 'string' ? /^\d+$/.test(rawRetry) ? Number(rawRetry) * 1000 : Math.max(0, Date.parse(rawRetry) - this.now()) : undefined
        await this.retry(job, device, status === 429 ? 'rate_limited' : (error as { code?: string })?.code === 'ETIMEDOUT' ? 'timeout' : 'provider_unavailable', retryAfter)
      } else {
        this.outbox.delete(job.id); device.delivery.failed++; device.delivery.lastFailureAt = this.now(); device.delivery.lastFailure = 'rejected'; await this.save(); this.finish(job, { error: providerError() })
      }
      return
    } finally { clearTimeout(deadline) }
    this.outbox.delete(job.id); await this.save(); this.finish(job, { ok: true })
  }

  /** Finish current attempts and writes; scheduled backoff is deliberately not awaited. */
  async flush() {
    while (this.pending.size) await Promise.allSettled([...this.pending])
    this.runDeliveries()
    while (this.active.size) await Promise.allSettled([...this.active.values()])
    await this.writes
  }
  async close() { this.closed = true; clearTimeout(this.retryTimer); await this.flush() }
}

export function registerPush(app: Express, push: PushService) {
  const route = (handler: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next) }
  const endpointBody = z.object({ endpoint: z.string().min(1).max(4096) }).strict()
  app.get('/api/push/config', (_req, res) => res.json(push.config()))
  app.get('/api/push/status', (req: AuthenticatedRequest, res) => res.json(push.status(req.session!.id)))
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
    const result = await push.test(req.session!.id, endpointBody.parse(req.body).endpoint)
    res.status(result.queued ? 202 : 200).json(result)
  }))
}
