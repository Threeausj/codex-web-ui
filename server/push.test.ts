import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { createECDH, randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import webPush, { type PushSubscription, type RequestOptions } from 'web-push'
import { PushService, validatePushEndpoint, type PushOptions } from './push.js'
import { createServer } from './app.js'
import type { Transport } from './bridge.js'
import type { RpcMessage } from './types.js'

const origin = 'http://localhost:8787'
const password = 'push-isolated-password-123'
const preferences = { completed: true, approval: true, errors: true }
const host = { id: 'local', name: 'Private project host', kind: 'local' as const }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function subscription(name: string, provider = 'fcm.googleapis.com'): PushSubscription {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
  return { endpoint: `https://${provider}/push/${name}`, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}
function protocolFixture() {
  const input = new PassThrough(); const output = new PassThrough(); let buffer = ''; let disposed = false
  const messages: RpcMessage[] = []
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const message = JSON.parse(buffer.slice(0, end)) as RpcMessage; buffer = buffer.slice(end + 1)
      messages.push(message)
      if (message.id !== undefined && message.method) queueMicrotask(() => output.write(`${JSON.stringify({ id: message.id, result: message.method === 'initialize' ? { userAgent: 'push-test' } : {} })}\n`))
    }
  })
  const transport: Transport = { input, output, events: new EventEmitter(), dispose: () => { disposed = true; input.destroy(); output.destroy() } }
  return { transport, messages, get disposed() { return disposed }, receive: (message: RpcMessage) => output.write(`${JSON.stringify(message)}\n`) }
}
async function application(options: PushOptions = {}, dataDir?: string, observer?: (message: RpcMessage) => void) {
  const directory = dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-http-'))
  const transports: ReturnType<typeof protocolFixture>[] = []
  const sent: { subscription: PushSubscription; payload: Record<string, unknown>; options: RequestOptions }[] = []
  const context = await createServer({ dataDir: directory, codexHome: path.join(directory, 'codex'), cwd: directory, password, secureCookie: false, serveStatic: false,
    pushOptions: { sendNotification: async (subscription, payload, options) => { sent.push({ subscription, payload: JSON.parse(payload), options }) }, ...options },
    bridgeOptions: { transportFactory: () => { const fixture = protocolFixture(); transports.push(fixture); return fixture.transport }, onProtocolMessage: (_host, message) => observer?.(message) },
  })
  await new Promise<void>(resolve => context.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(context.server.address() as { port: number }).port}`
  const login = async () => {
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password }) })
    assert.equal(response.status, 200)
    const session = await response.json() as { csrfToken: string }
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    return { cookie, csrfToken: session.csrfToken, headers: { cookie, origin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } }
  }
  const cleanup = async (remove = true) => { await context.close(); if (remove) await fs.rm(directory, { recursive: true, force: true }) }
  return { ...context, directory, base, transports, sent, login, cleanup }
}

test('push endpoints accept only HTTPS browser providers and reject SSRF destinations', () => {
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/test', 'https://updates.push.services.mozilla.com/wpush/v2/test', 'https://web.push.apple.com/Q/test', 'https://wns2-db5p.notify.windows.com/w/?token=test']) assert.equal(validatePushEndpoint(endpoint), endpoint)
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/test', 'https://127.0.0.1/api/admin', 'https://[::1]/test', 'https://2130706433/test',
    'https://fcm.googleapis.com.evil.invalid/test', 'https://evilpush.apple.com/test', 'https://evilnotify.windows.com/test',
    'https://user:password@fcm.googleapis.com/test', 'https://fcm.googleapis.com:8443/test', 'https://fcm.googleapis.com/test#fragment',
    'https://fcm.googleapis.com./test', 'file:///etc/passwd', 'https://updates.push.services.mozilla.com.evil.invalid/test',
  ]) assert.throws(() => validatePushEndpoint(endpoint), /push endpoint|push provider/)
})

test('VAPID keys are private, persist across restarts and validate optional overrides', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-vapid-'))
  try {
    const first = await PushService.create(directory, new Set(['https://codex.example.com']))
    const key = first.config().publicKey
    assert.equal(Buffer.from(key, 'base64url').length, 65)
    assert.equal((await fs.stat(path.join(directory, 'push-vapid.json'))).mode & 0o777, 0o600)
    await first.close()
    const second = await PushService.create(directory, new Set([origin]))
    assert.equal(second.config().publicKey, key)
    await second.close()
    await assert.rejects(PushService.create(directory, new Set(), { vapidPublicKey: key, vapidPrivateKey: '' }), /Set both/)
    await assert.rejects(PushService.create(directory, new Set(), { subject: 'http://localhost' }), /PUSH_SUBJECT/)
    const generated = webPush.generateVAPIDKeys()
    await assert.rejects(PushService.create(directory, new Set(), { vapidPublicKey: key, vapidPrivateKey: generated.privateKey }), /matching pair/)
    const override = await PushService.create(directory, new Set(), { vapidPublicKey: generated.publicKey, vapidPrivateKey: generated.privateKey, subject: 'mailto:operator@example.com' })
    assert.equal(override.config().publicKey, generated.publicKey)
    await override.close()
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'push-vapid.json'), 'utf8')).publicKey, key)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('the default production sender generates encrypted VAPID requests and handles provider responses', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-default-sender-'))
  const requests: { options: https.RequestOptions; chunks: Buffer[] }[] = []
  let statusCode = 201
  t.mock.method(https, 'request', (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    const chunks: Buffer[] = []
    requests.push({ options, chunks })
    const request = new EventEmitter() as ClientRequest
    request.write = (chunk: Uint8Array | string) => { chunks.push(Buffer.from(chunk)); return true }
    request.end = (() => {
      queueMicrotask(() => {
        const response = new EventEmitter() as IncomingMessage
        response.statusCode = statusCode
        response.headers = {}
        callback(response)
        response.emit('data', statusCode === 201 ? '' : 'Private provider response')
        response.emit('end')
      })
      return request
    }) as ClientRequest['end']
    request.destroy = (error?: Error) => { if (error) request.emit('error', error); return request }
    return request
  })
  const push = await PushService.create(directory, new Set(['https://codex.example.com']))
  try {
    const device = subscription('default-sender-device')
    await push.subscribe('test-session', device)
    assert.deepEqual(await push.test('test-session', device.endpoint), { ok: true })
    assert.equal(requests.length, 1)
    const sent = requests[0]!
    assert.equal(sent.options.hostname, 'fcm.googleapis.com')
    assert.equal(sent.options.method, 'POST')
    assert.equal(sent.options.path, '/push/default-sender-device')
    assert.equal(sent.options.timeout, 10000)
    const headers = sent.options.headers as Record<string, string>
    assert.equal(headers['Content-Encoding'], 'aes128gcm')
    assert.equal(String(headers.TTL), '3600')
    assert.match(headers.Authorization!, /^vapid /)
    const ciphertext = Buffer.concat(sent.chunks)
    assert.ok(ciphertext.length > 100 && !ciphertext.includes(Buffer.from('后台通知已开启')))
    statusCode = 410
    await assert.rejects(push.test('test-session', device.endpoint), error => {
      const failure = error as Error & { status?: number }
      assert.equal(failure.status, 410)
      assert.ok(!failure.message.includes('default-sender-device') && !failure.message.includes('Private provider response'))
      return true
    })
    assert.equal(requests.length, 2)
    assert.equal(push.hasActiveSubscriptions, false)
  } finally { await push.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('push HTTP routes require authentication, CSRF and valid device keys without leaking endpoints', async () => {
  const app = await application()
  try {
    assert.equal((await fetch(app.base + '/api/push/config')).status, 401)
    const session = await app.login()
    const config = await fetch(app.base + '/api/push/config', { headers: { cookie: session.cookie } })
    assert.equal(config.status, 200)
    assert.equal(config.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Object.keys(await config.json()).sort(), ['enabled', 'publicKey'])
    const device = subscription('private-token-a')
    const body = JSON.stringify({ subscription: device, preferences })
    assert.equal((await fetch(app.base + '/api/push/subscription', { method: 'POST', headers: { cookie: session.cookie, origin, 'content-type': 'application/json' }, body })).status, 403)
    assert.equal((await fetch(app.base + '/api/push/subscription', { method: 'POST', headers: { ...session.headers, origin: 'https://evil.invalid' }, body })).status, 403)
    const invalid = await fetch(app.base + '/api/push/subscription', { method: 'POST', headers: session.headers, body: JSON.stringify({ subscription: { ...device, endpoint: 'https://127.0.0.1/private-token' } }) })
    assert.equal(invalid.status, 400)
    assert.ok(!(await invalid.text()).includes('private-token'))
    const invalidKey = await fetch(app.base + '/api/push/subscription', { method: 'POST', headers: session.headers, body: JSON.stringify({ subscription: { ...device, keys: { ...device.keys, p256dh: randomBytes(65).toString('base64url') } } }) })
    assert.equal(invalidKey.status, 400)
    const saved = await fetch(app.base + '/api/push/subscription', { method: 'POST', headers: session.headers, body })
    assert.equal(saved.status, 200)
    const result = await saved.json() as { ok: boolean; expiresAt: number }
    assert.ok(result.ok && result.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000)
    assert.equal((await fs.stat(path.join(app.directory, 'push-subscriptions.json'))).mode & 0o777, 0o600)
    const stranger = await app.login()
    assert.equal((await fetch(app.base + '/api/push/test', { method: 'POST', headers: stranger.headers, body: JSON.stringify({ endpoint: device.endpoint }) })).status, 403)
    const test = await fetch(app.base + '/api/push/test', { method: 'POST', headers: session.headers, body: JSON.stringify({ endpoint: device.endpoint }) })
    assert.equal(test.status, 200)
    assert.equal(app.sent.length, 1)
    assert.equal(app.sent[0]!.options.TTL, 3600)
    assert.equal(app.sent[0]!.options.contentEncoding, 'aes128gcm')
    assert.equal(app.sent[0]!.options.timeout, 10000)
    assert.ok(!JSON.stringify(app.sent[0]!.payload).includes(device.endpoint))
    const encrypted = webPush.generateRequestDetails(device, JSON.stringify(app.sent[0]!.payload), app.sent[0]!.options)
    assert.equal(encrypted.headers['Content-Encoding'], 'aes128gcm')
    assert.match(encrypted.headers.Authorization!, /^vapid /)
    assert.ok(Buffer.isBuffer(encrypted.body) && !encrypted.body.includes(Buffer.from('后台通知已开启')))
    assert.equal((await fetch(app.base + '/api/push/subscription', { method: 'DELETE', headers: session.headers, body: JSON.stringify({ endpoint: device.endpoint }) })).status, 200)
    assert.equal(app.push.hasActiveSubscriptions, false)
  } finally { await app.cleanup() }
})

test('completed turns and pending approvals push after all browser sockets close without changing RPC', async () => {
  const observed: RpcMessage[] = []
  const app = await application({}, undefined, message => { observed.push(message); if (message.method === 'turn/completed') throw new Error('External observer failure') })
  let socket: WebSocket | undefined
  try {
    const session = await app.login(); const device = subscription('closed-browser')
    await fetch(app.base + '/api/push/subscription', { method: 'POST', headers: session.headers, body: JSON.stringify({ subscription: device, preferences }) })
    socket = new WebSocket(app.base.replace('http:', 'ws:') + '/api/rpc?clientId=phone_test', { headers: { cookie: session.cookie, origin } })
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
    await tick(); await tick()
    const closed = new Promise<void>(resolve => socket!.once('close', () => resolve()))
    socket.close(); await closed
    const fixture = app.transports[0]!
    assert.equal(fixture.disposed, false)
    const complete = { method: 'turn/completed', params: { threadId: 'thread/private?name=秘密', turn: { id: 'turn-1', status: 'completed', items: [{ text: 'Private response' }] } } }
    fixture.receive(complete); fixture.receive(complete)
    fixture.receive({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'interrupted', status: 'interrupted' } } })
    fixture.receive({ id: 'approve-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', turnId: 'turn-a', command: 'secret-token-command' } })
    fixture.receive({ id: 'approve-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', turnId: 'turn-a' } })
    fixture.receive({ id: 'approve-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', turnId: 'turn-b' } })
    fixture.receive({ id: 'input-1', method: 'item/tool/requestUserInput', params: { threadId: 'thread-a' } })
    fixture.receive({ id: 'internal-tool', method: 'item/tool/call', params: { threadId: 'thread-a' } })
    fixture.receive({ id: 'elicitation-1', method: 'mcpServer/elicitation/request', params: { threadId: 'thread-a', mode: 'url', url: 'https://private.example.com' } })
    fixture.receive({ id: 'unknown-elicitation', method: 'mcpServer/elicitation/request', params: { threadId: 'thread-a', mode: 'internal' } })
    fixture.receive({ method: 'error', params: { threadId: 'thread-a', turnId: 'retrying', willRetry: true, error: { message: 'secret retry' } } })
    fixture.receive({ method: 'error', params: { threadId: 'thread-a', turnId: 'failed', willRetry: false, error: { message: 'secret error' } } })
    fixture.receive({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'failed', status: 'failed' } } })
    await app.push.flush()
    assert.equal(app.sent.length, 6)
    assert.equal(app.sent.filter(entry => (entry.payload.data as { kind: string }).kind === 'completed').length, 1)
    assert.equal(app.sent.filter(entry => (entry.payload.data as { kind: string }).kind === 'approval').length, 4)
    assert.equal(app.sent.filter(entry => (entry.payload.data as { kind: string }).kind === 'errors').length, 1)
    const notice = app.sent[0]!.payload
    assert.equal(notice.title, 'Codex')
    assert.ok(!String(notice.body).includes('Private'))
    assert.ok(!JSON.stringify(app.sent.map(entry => ({ body: entry.payload.body, title: entry.payload.title }))).includes('secret'))
    const data = notice.data as { hostId: string; threadId: string; url: string }
    const target = new URL(data.url, 'https://codex.example.com')
    assert.equal(target.origin, 'https://codex.example.com')
    assert.equal(target.searchParams.get('host'), 'local')
    assert.equal(target.searchParams.get('thread'), 'thread/private?name=秘密')
    assert.equal(app.bridges.get('local')!.connected, true)
    assert.ok(observed.some(message => message.method === 'turn/completed'))
  } finally { socket?.terminate(); await app.cleanup() }
})

test('per-device preferences, natural login expiry and explicit logout preserve the correct grants', async () => {
  let clock = Date.now()
  const app = await application({ now: () => clock })
  try {
    const a = await app.login(); const b = await app.login()
    const deviceA = subscription('device-a'); const deviceB = subscription('device-b', 'web.push.apple.com')
    for (const [session, device] of [[a, deviceA], [b, deviceB]] as const) assert.equal((await fetch(app.base + '/api/push/subscription', { method: 'POST', headers: session.headers, body: JSON.stringify({ subscription: device, preferences }) })).status, 200)
    assert.equal((await fetch(app.base + '/api/push/subscription', { method: 'PATCH', headers: a.headers, body: JSON.stringify({ endpoint: deviceA.endpoint, preferences: { ...preferences, completed: false } }) })).status, 200)
    app.push.observe(host, { method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'first', status: 'completed' } } }); await app.push.flush()
    assert.deepEqual(app.sent.map(entry => entry.subscription.endpoint), [deviceB.endpoint])
    app.auth.getSession(a.cookie)!.expiresAt = Date.now() - 1
    assert.equal((await fetch(app.base + '/api/push/config', { headers: { cookie: a.cookie } })).status, 401)
    app.push.observe(host, { id: 'confirm-after-expiry', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-a' } }); await app.push.flush()
    assert.equal(app.sent.length, 3)
    assert.equal((await fetch(app.base + '/api/auth/logout', { method: 'POST', headers: b.headers })).status, 200)
    app.push.observe(host, { id: 'confirm-after-logout', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-a' } }); await app.push.flush()
    assert.equal(app.sent.length, 4)
    assert.equal(app.sent.at(-1)!.subscription.endpoint, deviceA.endpoint)
    const stored = JSON.parse(await fs.readFile(path.join(app.directory, 'push-subscriptions.json'), 'utf8'))
    assert.equal(stored.subscriptions.length, 1)
    assert.equal(stored.subscriptions[0].subscription.endpoint, deviceA.endpoint)
    clock += 31 * 24 * 60 * 60 * 1000
    app.push.observe(host, { id: 'past-device-grant', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-a' } }); await app.push.flush()
    assert.equal(app.sent.length, 4)
    assert.equal(app.push.hasActiveSubscriptions, false)
  } finally { await app.cleanup() }
})

test('server restarts restore VAPID, device grants and host monitoring while deduplicating replayed events', async () => {
  const first = await application()
  let second: Awaited<ReturnType<typeof application>> | undefined
  try {
    const session = await first.login(); const device = subscription('restart-device')
    await fetch(first.base + '/api/push/subscription', { method: 'POST', headers: session.headers, body: JSON.stringify({ subscription: device, preferences }) })
    const publicKey = first.push.config().publicKey
    const oldEvent = { method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'before-restart', status: 'completed' } } }
    first.push.observe(host, oldEvent); await first.push.flush()
    assert.equal(first.sent.length, 1)
    await first.cleanup(false)
    second = await application({}, first.directory)
    await tick(); await tick()
    assert.equal(second.push.config().publicKey, publicKey)
    assert.equal(second.push.hasActiveSubscriptions, true)
    assert.equal(second.transports.length, 1)
    assert.equal(second.bridges.get('local')!.connected, true)
    second.transports[0]!.receive(oldEvent)
    second.transports[0]!.receive({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'after-restart', status: 'completed' } } })
    await second.push.flush()
    assert.equal(second.sent.length, 1)
    // Natural in-memory cookie invalidation during restart does not revoke device authorization.
    assert.equal((await fetch(second.base + '/api/push/config', { headers: { cookie: session.cookie } })).status, 401)
    const renewed = await second.login()
    assert.equal((await fetch(second.base + '/api/push/subscription', { method: 'POST', headers: renewed.headers, body: JSON.stringify({ subscription: device, preferences }) })).status, 200)
    assert.equal((await fetch(second.base + '/api/auth/logout', { method: 'POST', headers: renewed.headers })).status, 200)
    assert.equal(second.push.hasActiveSubscriptions, false)
  } finally { if (second) await second.cleanup(); else { await first.close(); await fs.rm(first.directory, { recursive: true, force: true }) } }
})

test('expired upstream subscriptions are removed and provider errors never expose private tokens', async () => {
  const app = await application({ sendNotification: async device => { throw Object.assign(new Error(`private provider failure: ${device.endpoint}`), { statusCode: 410, endpoint: device.endpoint, body: 'secret-body' }) } })
  try {
    const session = await app.login(); const device = subscription('private-token-upstream')
    await fetch(app.base + '/api/push/subscription', { method: 'POST', headers: session.headers, body: JSON.stringify({ subscription: device, preferences }) })
    const response = await fetch(app.base + '/api/push/test', { method: 'POST', headers: session.headers, body: JSON.stringify({ endpoint: device.endpoint }) })
    assert.equal(response.status, 410)
    const body = await response.text()
    assert.ok(!body.includes('private-token') && !body.includes('secret-body') && !body.includes('fcm.googleapis.com'))
    assert.equal(app.push.hasActiveSubscriptions, false)
    assert.equal(JSON.parse(await fs.readFile(path.join(app.directory, 'push-subscriptions.json'), 'utf8')).subscriptions.length, 0)
    assert.equal((await fetch(app.base + '/api/push/test', { method: 'POST', headers: session.headers, body: JSON.stringify({ endpoint: device.endpoint }) })).status, 404)
  } finally { await app.cleanup() }
})

test('delivery concurrency is bounded and slow or failed push delivery does not block protocol observers', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-concurrency-'))
  let active = 0; let peak = 0; let delivered = 0
  const push = await PushService.create(directory, new Set([origin]), { sendNotification: async () => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 15))
    active--; delivered++
    if (delivered === 2) throw new Error('A provider can fail independently')
  } })
  try {
    for (let index = 0; index < 9; index++) await push.subscribe(`session-${index}`, subscription(`concurrent-${index}`))
    const began = performance.now()
    push.observe(host, { method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'bounded', status: 'completed' } } })
    assert.ok(performance.now() - began < 50)
    await push.flush()
    assert.equal(delivered, 9)
    assert.equal(peak, 4)
    assert.equal(push.hasActiveSubscriptions, true)
  } finally { await push.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
