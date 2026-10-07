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
function protocolFixture(response?: (message: RpcMessage) => unknown) {
  const input = new PassThrough(); const output = new PassThrough(); let buffer = ''; let disposed = false
  const messages: RpcMessage[] = []
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const message = JSON.parse(buffer.slice(0, end)) as RpcMessage; buffer = buffer.slice(end + 1)
      messages.push(message)
      if (message.id !== undefined && message.method) queueMicrotask(async () => {
        const result = message.method === 'initialize' ? { userAgent: 'push-test' } : await response?.(message) ?? {}
        output.write(`${JSON.stringify({ id: message.id, result })}\n`)
      })
    }
  })
  const transport: Transport = { input, output, events: new EventEmitter(), dispose: () => { disposed = true; input.destroy(); output.destroy() } }
  return { transport, messages, get disposed() { return disposed }, receive: (message: RpcMessage) => output.write(`${JSON.stringify(message)}\n`) }
}
async function application(options: PushOptions = {}, dataDir?: string, observer?: (message: RpcMessage, responseMethod?: string) => void, response?: (message: RpcMessage) => unknown) {
  const directory = dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-http-'))
  const transports: ReturnType<typeof protocolFixture>[] = []
  const sent: { subscription: PushSubscription; payload: Record<string, unknown>; options: RequestOptions }[] = []
  const context = await createServer({ dataDir: directory, codexHome: path.join(directory, 'codex'), cwd: directory, password, secureCookie: false, serveStatic: false,
    pushOptions: { sendNotification: async (subscription, payload, options) => { sent.push({ subscription, payload: JSON.parse(payload), options }) }, ...options },
    bridgeOptions: { transportFactory: () => { const fixture = protocolFixture(response || (message => message.method === 'thread/read' ? { thread: { id: (message.params as { threadId: string }).threadId, source: 'cli', ephemeral: false } } : {})); transports.push(fixture); return fixture.transport }, onProtocolMessage: (_host, message, responseMethod) => observer?.(message, responseMethod) },
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
    assert.deepEqual(await push.test('test-session', device.endpoint), { ok: true, queued: true }); await push.flush()
    assert.equal(requests.length, 1)
    const sent = requests[0]!
    assert.equal(sent.options.hostname, 'fcm.googleapis.com')
    assert.equal(sent.options.method, 'POST')
    assert.equal(sent.options.path, '/push/default-sender-device')
    assert.equal(sent.options.timeout, 10000)
    const headers = sent.options.headers as Record<string, string>
    assert.equal(headers['Content-Encoding'], 'aes128gcm')
    assert.equal(String(headers.TTL), '3600')
    assert.equal(headers.Urgency, 'high')
    assert.match(headers.Authorization!, /^vapid /)
    const ciphertext = Buffer.concat(sent.chunks)
    assert.ok(ciphertext.length > 100 && !ciphertext.includes(Buffer.from('后台通知已开启')))
    statusCode = 410
    assert.deepEqual(await push.test('test-session', device.endpoint), { ok: true, queued: true }); await push.flush()
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
    assert.equal(test.status, 202); await app.push.flush()
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

test('repeated tests have independent notification tags and push topics, including in the same millisecond', async () => {
  const app = await application({ now: () => 1791216000000 })
  try {
    const device = subscription('repeated-test')
    await app.push.subscribe('session', device)
    await app.push.test('session', device.endpoint); await app.push.flush()
    await app.push.test('session', device.endpoint); await app.push.flush()
    assert.equal(app.sent.length, 2)
    assert.notEqual(app.sent[0]!.payload.tag, app.sent[1]!.payload.tag)
    assert.notEqual(app.sent[0]!.options.topic, app.sent[1]!.options.topic)
    assert.ok(app.sent.every(entry => entry.options.urgency === 'high'))
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
    const fixture = app.transports[0]!
    fixture.receive({ method: 'thread/started', params: { thread: { id: 'thread/private?name=秘密', name: '旧名称', preview: 'Private initial prompt' } } })
    fixture.receive({ method: 'thread/started', params: { thread: { id: 'thread-a', name: '另一条对话', preview: 'Private initial prompt' } } })
    const closed = new Promise<void>(resolve => socket!.once('close', () => resolve()))
    socket.close(); await closed
    assert.equal(fixture.disposed, false)
    fixture.receive({ method: 'thread/name/updated', params: { threadId: 'thread/private?name=秘密', threadName: '后台改名后的对话' } })
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
    assert.ok(app.sent.every(entry => entry.options.urgency === 'high'))
    assert.equal(app.sent.filter(entry => (entry.payload.data as { kind: string }).kind === 'completed').length, 1)
    assert.equal(app.sent.filter(entry => (entry.payload.data as { kind: string }).kind === 'approval').length, 4)
    assert.equal(app.sent.filter(entry => (entry.payload.data as { kind: string }).kind === 'errors').length, 1)
    const notice = app.sent[0]!.payload
    assert.equal(notice.title, '后台改名后的对话')
    assert.equal(notice.body, '运行完成')
    assert.deepEqual(app.sent.slice(1).map(entry => entry.payload.body), ['等待命令执行确认', '等待命令执行确认', '等待补充输入', '等待确认或补充输入', '运行失败'])
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

test('thread RPC responses provide notification titles without an extra metadata lookup', async () => {
  const methods = ['thread/start', 'thread/resume', 'thread/read', 'thread/fork', 'thread/list', 'thread/search']
  const observedResponses: string[] = []
  const app = await application({}, undefined, (_message, responseMethod) => { if (responseMethod) observedResponses.push(responseMethod) }, message => {
    if (!methods.includes(message.method!)) return {}
    const thread = { id: message.method!, source: 'cli', name: `${message.method} 的对话`, preview: 'Unused initial prompt' }
    return ['thread/list', 'thread/search'].includes(message.method!) ? { data: [thread], nextCursor: null } : { thread }
  })
  try {
    await app.push.subscribe('session', subscription('rpc-thread-names'))
    const bridge = await app.getBridge('local')
    for (const method of methods) await bridge.request(method, method === 'thread/read' ? { threadId: method, includeTurns: false } : {})
    for (const method of methods) {
      app.transports[0]!.receive({ method: 'turn/completed', params: { threadId: method, turn: { id: `turn-${method}`, status: 'completed' } } })
      await app.push.flush()
    }
    assert.deepEqual(app.sent.map(entry => entry.payload.title), methods.map(method => `${method} 的对话`))
    assert.ok(methods.every(method => observedResponses.includes(method)))
    assert.equal(app.transports[0]!.messages.filter(message => message.method === 'thread/read').length, 1)
  } finally { await app.cleanup() }
})

test('conversation titles cached before subscribing remain isolated per host and support clearing a name', async () => {
  const app = await application({ resolveThread: async () => { throw new Error('Known names need no lookup') } })
  const otherHost = { ...host, id: 'other-host' }
  try {
    for (const [source, name] of [[host, '本机对话'], [otherHost, '远端对话']] as const)
      app.push.observe(source, { method: 'thread/started', params: { thread: { id: 'shared-id', name, preview: '第一条消息', source: 'cli' } } })
    await app.push.subscribe('session', subscription('host-thread-names'))
    for (const source of [host, otherHost]) {
      app.push.observe(source, { method: 'turn/completed', params: { threadId: 'shared-id', turn: { id: 'same-turn-id', status: 'completed' } } })
      await app.push.flush()
    }
    app.push.observe(host, { method: 'thread/name/updated', params: { threadId: 'shared-id', name: '兼容旧版改名' } })
    app.push.observe(host, { id: 'legacy-name', method: 'item/tool/requestUserInput', params: { threadId: 'shared-id' } })
    await app.push.flush()
    app.push.observe(host, { method: 'thread/name/updated', params: { threadId: 'shared-id' } })
    app.push.observe(host, { id: 'cleared-name', method: 'item/tool/requestUserInput', params: { threadId: 'shared-id' } })
    await app.push.flush()
    assert.deepEqual(app.sent.map(entry => entry.payload.title), ['本机对话', '远端对话', '兼容旧版改名', '第一条消息'])
    assert.deepEqual(app.sent.slice(0, 2).map(entry => (entry.payload.data as { hostId: string }).hostId), ['local', 'other-host'])
  } finally { await app.cleanup() }
})

test('notification titles normalize whitespace, fall back to preview and fit the worker title limit', async () => {
  const app = await application({ resolveThread: async () => undefined })
  try {
    await app.push.subscribe('session', subscription('formatted-thread-names'))
    const threads = [
      { id: 'whitespace-name', name: '  检查\n\t消息推送  ', preview: 'Unused preview' },
      { id: 'preview-name', name: ' \n\x00\t', preview: '  首条\n\t消息  ' },
      { id: 'long-name', name: `\x00${'🌟'.repeat(60)}\x7f`, preview: '' },
      { id: 'no-name', name: null, preview: '' },
    ]
    for (const thread of threads) {
      app.push.observe(host, { method: 'thread/started', params: { thread: { ...thread, source: 'cli' } } })
      app.push.observe(host, { method: 'turn/completed', params: { threadId: thread.id, turn: { id: `turn-${thread.id}`, status: 'completed' } } })
      await app.push.flush()
    }
    assert.equal(app.sent[0]!.payload.title, '检查 消息推送')
    assert.equal(app.sent[1]!.payload.title, '首条 消息')
    const longTitle = String(app.sent[2]!.payload.title)
    assert.ok(longTitle.length <= 100 && longTitle.startsWith('🌟'))
    assert.ok(!/[\x00-\x1f\x7f]/.test(longTitle))
    assert.equal(app.sent[3]!.payload.title, '未命名对话')
  } finally { await app.cleanup() }
})

test('new unnamed threads resolve persisted metadata through a read-only RPC and reuse it', async () => {
  const app = await application({}, undefined, undefined, message => {
    if (message.method === 'thread/read') return { thread: { id: 'fresh-thread', source: 'cli', name: null, preview: '新会话第一条消息' } }
    return {}
  })
  try {
    await app.push.subscribe('session', subscription('fresh-thread-name'))
    const bridge = await app.getBridge('local'); await bridge.connect()
    const fixture = app.transports[0]!
    fixture.receive({ method: 'thread/started', params: { thread: { id: 'fresh-thread', name: null, preview: '' } } })
    for (const turnId of ['first-turn', 'continued-turn']) {
      fixture.receive({ method: 'turn/completed', params: { threadId: 'fresh-thread', turn: { id: turnId, status: 'completed' } } })
      await app.push.flush()
    }
    assert.deepEqual(app.sent.map(entry => entry.payload.title), ['新会话第一条消息', '新会话第一条消息'])
    const reads = fixture.messages.filter(message => message.method === 'thread/read')
    assert.equal(reads.length, 1)
    assert.deepEqual(reads[0]!.params, { threadId: 'fresh-thread', includeTurns: false })
    assert.ok(!fixture.messages.some(message => ['thread/resume', 'turn/start'].includes(message.method!)))
  } finally { await app.cleanup() }
})

test('a failed source lookup defers completion without disclosing the failure or notifying possible children', async () => {
  let lookups = 0
  const app = await application({ resolveThread: async () => { lookups++; throw new Error('private lookup failure') } })
  try {
    await app.push.subscribe('session', subscription('failed-title-lookup'))
    // Non-thread list responses must never supply a conversation name.
    app.push.observe(host, { id: 'model-list', result: { data: [{ id: 'missing-thread', name: 'Unrelated model name' }] } }, 'model/list')
    const event = { method: 'turn/completed', params: { threadId: 'missing-thread', turn: { id: 'finished-turn', status: 'completed' } } }
    app.push.observe(host, event); app.push.observe(host, event)
    await app.push.flush()
    assert.equal(lookups, 1)
    assert.equal(app.sent.length, 0)
    assert.equal(app.push.status('session').queued, 1)
    assert.equal(app.push.status('session').lastFailure, 'metadata_pending')
    assert.ok(!JSON.stringify(app.push.status('session')).includes('private lookup failure'))
  } finally { await app.cleanup() }
})

test('a title lookup timeout delivers its event with a fallback instead of waiting indefinitely', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-title-timeout-'))
  const sent: Record<string, unknown>[] = []
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const push = await PushService.create(directory, new Set([origin]), {
    resolveThread: () => { markStarted(); return new Promise(() => {}) },
    sendNotification: async (_device, payload) => { sent.push(JSON.parse(payload)) },
  })
  try {
    await push.subscribe('session', subscription('title-timeout'))
    push.observe(host, { method: 'thread/started', params: { thread: { id: 'missing-title', source: 'cli' } } })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    push.observe(host, { method: 'turn/completed', params: { threadId: 'missing-title', turn: { id: 'timed-out', status: 'completed' } } })
    await started
    t.mock.timers.tick(2999); await tick()
    assert.equal(sent.length, 0)
    t.mock.timers.tick(1)
    await push.flush()
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.title, '未命名对话')
    assert.equal(sent[0]!.body, '运行完成')
  } finally { await push.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('a live rename received during a metadata lookup wins over its older RPC response', async () => {
  let finishRead: ((value: unknown) => void) | undefined
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const app = await application({}, undefined, undefined, message => {
    if (message.method !== 'thread/read') return {}
    return new Promise(resolve => { finishRead = resolve; markStarted() })
  })
  try {
    await app.push.subscribe('session', subscription('renamed-during-lookup'))
    const bridge = await app.getBridge('local'); await bridge.connect()
    const fixture = app.transports[0]!
    fixture.receive({ method: 'thread/started', params: { thread: { id: 'renaming-thread', name: null, preview: '' } } })
    fixture.receive({ method: 'turn/completed', params: { threadId: 'renaming-thread', turn: { id: 'before-read-returned', status: 'completed' } } })
    await started
    fixture.receive({ method: 'thread/name/updated', params: { threadId: 'renaming-thread', threadName: '刚修改的对话名' } })
    finishRead!({ thread: { id: 'renaming-thread', source: 'cli', name: '旧响应中的名称', preview: '' } })
    await app.push.flush()
    fixture.receive({ method: 'turn/completed', params: { threadId: 'renaming-thread', turn: { id: 'after-read-returned', status: 'completed' } } })
    await app.push.flush()
    assert.deepEqual(app.sent.map(entry => entry.payload.title), ['刚修改的对话名', '刚修改的对话名'])
    assert.equal(fixture.messages.filter(message => message.method === 'thread/read').length, 1)
  } finally { finishRead?.({}); await app.cleanup() }
})

test('a late response after the internal metadata RPC timeout cannot overwrite a newer conversation name', async t => {
  let finishRead: ((value: unknown) => void) | undefined
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const app = await application({}, undefined, undefined, message => {
    if (message.method !== 'thread/read') return {}
    return new Promise(resolve => { finishRead = resolve; markStarted() })
  })
  try {
    await app.push.subscribe('session', subscription('late-metadata-response'))
    const bridge = await app.getBridge('local'); await bridge.connect()
    const fixture = app.transports[0]!
    fixture.receive({ method: 'thread/started', params: { thread: { id: 'late-read-thread', source: 'cli' } } })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    fixture.receive({ method: 'turn/completed', params: { threadId: 'late-read-thread', turn: { id: 'before-timeout', status: 'completed' } } })
    await started
    t.mock.timers.tick(2499); await tick()
    assert.equal(app.sent.length, 0)
    t.mock.timers.tick(1)
    await app.push.flush()
    assert.equal(app.sent[0]!.payload.title, '未命名对话')
    fixture.receive({ method: 'thread/name/updated', params: { threadId: 'late-read-thread', threadName: '超时后修改的对话名' } })
    finishRead!({ thread: { id: 'late-read-thread', name: '迟到响应中的旧名称', preview: '' } })
    await tick()
    fixture.receive({ method: 'turn/completed', params: { threadId: 'late-read-thread', turn: { id: 'after-late-response', status: 'completed' } } })
    await app.push.flush()
    assert.deepEqual(app.sent.map(entry => entry.payload.title), ['未命名对话', '超时后修改的对话名'])
    assert.equal(fixture.messages.filter(message => message.method === 'thread/read').length, 1)
  } finally { finishRead?.({}); await app.cleanup() }
})

test('event text distinguishes completion, failure and the requested confirmation', async () => {
  const app = await application()
  const events: [RpcMessage, string, string][] = [
    [{ method: 'turn/completed', params: { threadId: 'event-thread', turn: { id: 'completed', status: 'completed' } } }, '运行完成', 'completed'],
    [{ method: 'turn/completed', params: { threadId: 'event-thread', turn: { id: 'failed', status: 'failed', error: { message: 'private error detail' } } } }, '运行失败', 'errors'],
    [{ id: 'command', method: 'item/commandExecution/requestApproval', params: { threadId: 'event-thread', command: 'private command' } }, '等待命令执行确认', 'approval'],
    [{ id: 'legacy-command', method: 'execCommandApproval', params: { conversationId: 'event-thread', command: 'private command' } }, '等待命令执行确认', 'approval'],
    [{ id: 'file', method: 'item/fileChange/requestApproval', params: { threadId: 'event-thread', changes: 'private patch' } }, '等待文件修改确认', 'approval'],
    [{ id: 'legacy-file', method: 'applyPatchApproval', params: { conversationId: 'event-thread', changes: 'private patch' } }, '等待文件修改确认', 'approval'],
    [{ id: 'permissions', method: 'item/permissions/requestApproval', params: { threadId: 'event-thread' } }, '等待权限确认', 'approval'],
    [{ id: 'input', method: 'item/tool/requestUserInput', params: { threadId: 'event-thread', questions: 'private question' } }, '等待补充输入', 'approval'],
    [{ id: 'choice', method: 'item/tool/requestUserInput', params: { threadId: 'event-thread', isBlocking: false, questions: [{ id: 'split', question: 'private question', options: [{ label: 'private option', description: 'private explanation' }] }] } }, '等待你的选择', 'approval'],
    [{ id: 'legacy-choice', method: 'tool/requestUserInput', params: { threadId: 'event-thread', questions: [{ options: [{ label: 'private option' }] }] } }, '等待你的选择', 'approval'],
    [{ id: 'mcp', method: 'mcpServer/elicitation/request', params: { threadId: 'event-thread', mode: 'form' } }, '等待确认或补充输入', 'approval'],
  ]
  try {
    await app.push.subscribe('session', subscription('event-text'))
    app.push.observe(host, { method: 'thread/started', params: { thread: { id: 'event-thread', name: '推送逻辑修改', preview: '' } } })
    for (const [message] of events) { app.push.observe(host, message); await app.push.flush() }
    assert.deepEqual(app.sent.map(entry => entry.payload.title), events.map(() => '推送逻辑修改'))
    assert.deepEqual(app.sent.map(entry => entry.payload.body), events.map(([, body]) => body))
    assert.deepEqual(app.sent.map(entry => (entry.payload.data as { kind: string }).kind), events.map(([, , kind]) => kind))
    assert.ok(!JSON.stringify(app.sent.map(entry => ({ title: entry.payload.title, body: entry.payload.body }))).includes('private'))
  } finally { await app.cleanup() }
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
    // Session persistence and device grants both survive a server restart.
    assert.equal((await fetch(second.base + '/api/push/config', { headers: { cookie: session.cookie } })).status, 200)
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
    assert.equal(response.status, 202); await app.push.flush()
    const body = await response.text()
    assert.ok(!body.includes('private-token') && !body.includes('secret-body') && !body.includes('fcm.googleapis.com'))
    assert.equal(app.push.hasActiveSubscriptions, false)
    assert.equal(JSON.parse(await fs.readFile(path.join(app.directory, 'push-subscriptions.json'), 'utf8')).subscriptions.length, 0)
    assert.equal((await fetch(app.base + '/api/push/test', { method: 'POST', headers: session.headers, body: JSON.stringify({ endpoint: device.endpoint }) })).status, 404)
  } finally { await app.cleanup() }
})

test('delivery concurrency is bounded and slow or failed push delivery does not block protocol observers', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-concurrency-'))
  let active = 0; let peak = 0; let delivered = 0; let started = 0
  let releaseFirstBatch!: () => void
  const firstBatch = new Promise<void>(resolve => { releaseFirstBatch = resolve })
  const push = await PushService.create(directory, new Set([origin]), { sendNotification: async () => {
    active++; peak = Math.max(peak, active)
    // Hold the first batch until every delivery slot is occupied. Disk speed
    // must not determine whether this test exercises the concurrency limit.
    if (++started <= 4) { if (started === 4) releaseFirstBatch(); await firstBatch }
    active--; delivered++
    if (delivered === 2) throw new Error('A provider can fail independently')
  } })
  try {
    for (let index = 0; index < 9; index++) await push.subscribe(`session-${index}`, subscription(`concurrent-${index}`))
    push.observe(host, { method: 'thread/started', params: { thread: { id: 'thread-a', source: 'cli', name: '并发测试' } } })
    const began = performance.now()
    push.observe(host, { method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'bounded', status: 'completed' } } })
    assert.ok(performance.now() - began < 50)
    await push.flush()
    assert.equal(delivered, 9)
    assert.equal(peak, 4)
    assert.equal(push.hasActiveSubscriptions, true)
  } finally { await push.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('the durable outbox retries a 503 per device without duplicating successful devices or replayed events', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-outbox-retry-'))
  let clock = Date.now()
  const a = subscription('successful'); const b = subscription('retry-private-token')
  const attempts: { endpoint: string; payload: string; topic: string | undefined }[] = []
  let failing = true
  const service = await PushService.create(directory, new Set([origin]), { now: () => clock, sendNotification: async (device, payload, options) => {
    const durable = JSON.parse(await fs.readFile(path.join(directory, 'push-subscriptions.json'), 'utf8'))
    assert.ok(durable.outbox.some((job: any) => job.endpoint === device.endpoint))
    assert.ok(durable.events.length > 0, 'dedupe and per-device delivery are persisted before dispatch')
    attempts.push({ endpoint: device.endpoint, payload, topic: options.topic })
    if (device.endpoint === b.endpoint && failing) throw Object.assign(new Error('provider response includes retry-private-token'), { statusCode: 503 })
  } })
  const event = { method: 'turn/completed', params: { threadId: 'outbox-thread', turn: { id: 'turn-one', status: 'completed' } } }
  try {
    await service.subscribe('session', a); await service.subscribe('session', b)
    service.observe(host, { method: 'thread/started', params: { thread: { id: 'outbox-thread', name: '可靠推送', source: 'cli' } } })
    service.observe(host, event); service.observe(host, event); await service.flush()
    assert.equal(attempts.length, 2)
    assert.equal(service.status('session').queued, 1)
    assert.equal(service.status('session').retrying, 1)
    assert.equal(service.status('session').lastFailure, 'provider_unavailable')
    assert.ok(!JSON.stringify(service.status('session')).includes('private-token'))
    failing = false; clock += 5000; await service.flush()
    assert.equal(attempts.filter(attempt => attempt.endpoint === a.endpoint).length, 1)
    const retries = attempts.filter(attempt => attempt.endpoint === b.endpoint)
    assert.equal(retries.length, 2); assert.equal(retries[0]!.payload, retries[1]!.payload); assert.equal(retries[0]!.topic, retries[1]!.topic)
    assert.equal(service.status('session').queued, 0); assert.equal(service.status('session').delivered, 2)
    service.observe(host, event); await service.flush(); assert.equal(attempts.length, 3)
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'push-subscriptions.json'), 'utf8'))
    assert.equal(stored.version, 3); assert.equal(stored.outbox.length, 0); assert.equal(stored.events.length, 1)
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('restart restores only failed deliveries and close never waits for a future backoff', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-outbox-restart-'))
  let clock = Date.now(); const a = subscription('restart-success'); const b = subscription('restart-failed'); const attempts: string[] = []
  const event = { method: 'turn/completed', params: { threadId: 'restart-thread', turn: { id: 'restart-turn', status: 'completed' } } }
  const first = await PushService.create(directory, new Set([origin]), { now: () => clock, sendNotification: async device => { attempts.push(device.endpoint); if (device.endpoint === b.endpoint) throw Object.assign(new Error('503'), { statusCode: 503 }) } })
  let second: PushService | undefined
  try {
    await first.subscribe('session', a); await first.subscribe('session', b)
    const publicKey = first.config().publicKey
    first.observe(host, { method: 'thread/started', params: { thread: { id: 'restart-thread', name: '恢复', source: 'cli' } } })
    first.observe(host, event); await first.flush()
    const began = performance.now(); await first.close(); assert.ok(performance.now() - began < 1000)
    clock += 5000
    second = await PushService.create(directory, new Set([origin]), { now: () => clock, resolveThread: async (_host, threadId) => ({ id: threadId, name: '恢复', source: 'cli' }), sendNotification: async device => { attempts.push(device.endpoint) } })
    await second.flush(); second.observe(host, event); await second.flush()
    assert.equal(second.config().publicKey, publicKey)
    assert.deepEqual(attempts, [a.endpoint, b.endpoint, b.endpoint])
    assert.equal(second.status('session').delivered, 2); assert.equal(second.status('session').queued, 0)
  } finally { await first.close(); await second?.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('logout, durable revocation and grant expiry purge pending retries before sending', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-outbox-revoke-'))
  let clock = Date.now(); let revoked = false; let calls = 0
  const device = subscription('revoked-retry')
  const options: PushOptions = { now: () => clock, isSessionRevoked: () => revoked, sendNotification: async () => { calls++; throw Object.assign(new Error('503'), { statusCode: 503 }) } }
  let service = await PushService.create(directory, new Set([origin]), options)
  try {
    await service.subscribe('session', device)
    const result = await service.test('session', device.endpoint); await service.flush()
    assert.equal(result.queued, true); assert.equal(calls, 1)
    await service.revokeSession('session'); clock += 5000; await service.flush()
    assert.equal(calls, 1); assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'push-subscriptions.json'), 'utf8')).outbox.length, 0)
    await service.subscribe('session', device); await service.test('session', device.endpoint); await service.flush(); await service.close()
    revoked = true; clock += 5000; service = await PushService.create(directory, new Set([origin]), options); await service.flush()
    assert.equal(calls, 2); assert.equal(service.hasActiveSubscriptions, false)
    await assert.rejects(service.subscribe('session', device), /Sign in again/)
    revoked = false
    await service.subscribe('session', { ...device, expirationTime: clock + 2000 }); await service.test('session', device.endpoint); await service.flush()
    clock += 5000; await service.flush(); assert.equal(calls, 3); assert.equal(service.hasActiveSubscriptions, false)
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('test notification failure returns a persisted 202 retry with sanitized own-device status', async () => {
  const app = await application({ sendNotification: async device => { throw Object.assign(new Error(`secret ${device.endpoint}`), { statusCode: 429, headers: { 'retry-after': '30' } }) } })
  try {
    const session = await app.login(); const stranger = await app.login(); const device = subscription('test-retry-token')
    await app.push.subscribe(app.auth.getSession(session.cookie)!.id, device)
    const response = await fetch(app.base + '/api/push/test', { method: 'POST', headers: session.headers, body: JSON.stringify({ endpoint: device.endpoint }) })
    assert.equal(response.status, 202)
    const result = await response.json() as { ok: boolean; queued: boolean; retryAt: number }
    assert.ok(result.ok && result.queued); await app.push.flush()
    const statusResponse = await fetch(app.base + '/api/push/status', { headers: { cookie: session.cookie } })
    assert.equal(statusResponse.status, 200); assert.equal(statusResponse.headers.get('cache-control'), 'no-store')
    const status = await statusResponse.json() as Record<string, unknown>
    assert.equal(status.queued, 1); assert.equal(status.lastFailure, 'rate_limited')
    const plain = JSON.stringify(status); assert.ok(!plain.includes('test-retry-token') && !plain.includes('keys') && !plain.includes('sessionHash') && !plain.includes('后台通知'))
    const other = await fetch(app.base + '/api/push/status', { headers: { cookie: stranger.cookie } })
    assert.equal((await other.json() as { devices: number }).devices, 0)
    assert.equal((await fetch(app.base + '/api/push/status')).status, 401)
  } finally { await app.cleanup() }
})

test('unknown source is retained for retry and a recovered child source suppresses its completion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-outbox-source-'))
  let clock = Date.now(); let available = false; let sent = 0
  const service = await PushService.create(directory, new Set([origin]), { now: () => clock, resolveThread: async (_host, threadId) => available ? ({ id: threadId, source: { subAgent: 'review' }, name: '子智能体' }) : undefined, sendNotification: async () => { sent++ } })
  try {
    await service.subscribe('session', subscription('unknown-child'))
    service.observe(host, { method: 'turn/completed', params: { threadId: 'cold-child', turn: { id: 'child-finished', status: 'completed' } } }); await service.flush()
    assert.equal(sent, 0); assert.equal(service.status('session').queued, 1)
    available = true; clock += 5000; await service.flush()
    assert.equal(sent, 0); assert.equal(service.status('session').queued, 0)
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('outbox TTL expires notifications rather than retrying indefinitely', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-outbox-expiry-'))
  let clock = Date.now(); let sent = 0
  const service = await PushService.create(directory, new Set([origin]), { now: () => clock, deliveryTtlMs: 1000, sendNotification: async () => { sent++; throw Object.assign(new Error('503'), { statusCode: 503 }) } })
  try {
    const device = subscription('expire-event'); await service.subscribe('session', device); await service.test('session', device.endpoint); await service.flush()
    clock += 1001; await service.flush()
    assert.equal(sent, 1); assert.equal(service.status('session').queued, 0); assert.equal(service.status('session').expired, 1)
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('retry attempts remain bounded even when the provider is continuously unavailable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-outbox-attempts-'))
  let clock = Date.now(); let sent = 0
  const service = await PushService.create(directory, new Set([origin]), { now: () => clock, retryBaseMs: 1, sendNotification: async () => { sent++; throw Object.assign(new Error('503'), { statusCode: 503 }) } })
  try {
    const device = subscription('bounded-attempts'); await service.subscribe('session', device); await service.test('session', device.endpoint); await service.flush()
    for (let attempt = 1; attempt < 10; attempt++) { clock += 1000; await service.flush() }
    assert.equal(sent, 8); assert.equal(service.status('session').queued, 0); assert.equal(service.status('session').failed, 1)
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('subscription replacement and preference changes cancel old queued deliveries', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-outbox-replace-'))
  let clock = Date.now(); let sent = 0
  const service = await PushService.create(directory, new Set([origin]), { now: () => clock, sendNotification: async () => { sent++; throw Object.assign(new Error('503'), { statusCode: 503 }) } })
  try {
    const device = subscription('replace-grant'); await service.subscribe('old-session', device); await service.test('old-session', device.endpoint); await service.flush()
    await service.subscribe('new-session', device); clock += 5000; await service.flush()
    assert.equal(sent, 1); assert.equal(service.status('old-session').devices, 0); assert.equal(service.status('new-session').queued, 0)
    service.observe(host, { method: 'thread/started', params: { thread: { id: 'preference-thread', source: 'cli' } } })
    service.observe(host, { method: 'turn/completed', params: { threadId: 'preference-thread', turn: { id: 'finish', status: 'completed' } } }); await service.flush()
    assert.equal(sent, 2); assert.equal(service.status('new-session').queued, 1)
    await service.updatePreferences('new-session', device.endpoint, { ...preferences, completed: false }); clock += 5000; await service.flush()
    assert.equal(sent, 2); assert.equal(service.status('new-session').queued, 0)
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('a durable bounded backlog retains one-time events and drains without requiring protocol replay', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-outbox-bound-'))
  let clock = Date.now(); let failing = true; let sent = 0
  const service = await PushService.create(directory, new Set([origin]), { now: () => clock, maxQueuedDeliveries: 2, sendNotification: async () => { sent++; if (failing) throw Object.assign(new Error('503'), { statusCode: 503 }) } })
  try {
    await service.subscribe('session', subscription('bounded-outbox'))
    service.observe(host, { method: 'thread/started', params: { thread: { id: 'bounded-thread', source: 'cli', name: '容量' } } })
    const event = (turn: string) => ({ method: 'turn/completed', params: { threadId: 'bounded-thread', turn: { id: turn, status: 'completed' } } })
    for (const turn of ['one', 'two', 'overflow']) service.observe(host, event(turn))
    await service.flush()
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'push-subscriptions.json'), 'utf8'))
    assert.equal(stored.outbox.length, 3); assert.equal(stored.events.length, 3); assert.equal(sent, 3); assert.equal(service.status('session').backlog, 1)
    failing = false; clock += 5000; await service.flush()
    service.observe(host, event('overflow')); await service.flush()
    assert.equal(sent, 6); assert.equal(service.status('session').queued, 0)
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('test notification receipt returns after durable enqueue while all delivery workers are occupied', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-test-accepted-'));
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let started = 0;
  const service = await PushService.create(directory, new Set([origin]), { sendNotification: async () => { started++; await held; } });
  try {
    for (let i = 0; i < 5; i++) await service.subscribe('session', subscription(`test-accepted-${i}`));
    service.observe(host, { method: 'thread/started', params: { thread: { id: 'busy', source: 'cli' } } });
    service.observe(host, { method: 'turn/completed', params: { threadId: 'busy', turn: { id: 't', status: 'completed' } } });
    while (started < 4) await tick();
    const result = await service.test('session', subscription('test-accepted-4').endpoint);
    assert.deepEqual(result, { ok: true, queued: true }); assert.equal(started, 4);
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'push-subscriptions.json'), 'utf8'));
    assert.equal(stored.outbox.length, 6); assert.equal(service.status('session').queued, 6);
  } finally { release(); await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('long provider Retry-After survives restart and does not retry at the shorter local backoff', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-long-retry-'));
  let clock = Date.now(), sent = 0;
  const options = { now: () => clock, sendNotification: async () => { sent++; throw Object.assign(new Error('429'), { statusCode: 429, headers: { 'retry-after': '1800' } }); } };
  let service = await PushService.create(directory, new Set([origin]), options);
  try {
    const device = subscription('long-retry'); await service.subscribe('session', device); await service.test('session', device.endpoint); await service.flush();
    assert.equal(service.status('session').nextRetryAt, clock + 1800000);
    await service.close(); service = await PushService.create(directory, new Set([origin]), options);
    clock += 600000; await service.flush(); assert.equal(sent, 1);
    clock += 1200000; await service.flush(); assert.equal(sent, 2);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('durable backlog overflow is counted per device and accepted events survive a cold restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-overflow-'));
  let clock = Date.now(), failing = true, sent = 0;
  const options = { now: () => clock, maxQueuedDeliveries: 1, resolveThread: async (_host: any, id: string) => ({ id, source: 'cli' }), sendNotification: async () => { sent++; if (failing) throw Object.assign(new Error('503'), { statusCode: 503 }); } };
  let service = await PushService.create(directory, new Set([origin]), options);
  try {
    await service.subscribe('session', subscription('overflow'));
    service.observe(host, { method: 'thread/started', params: { thread: { id: 'main', source: 'cli' } } });
    for (let i = 0; i < 6; i++) service.observe(host, { method: 'turn/completed', params: { threadId: 'main', turn: { id: `t-${i}`, status: 'completed' } } });
    await service.flush(); assert.equal(service.status('session').queued, 5); assert.equal(service.status('session').overflow, 1);
    await service.close(); failing = false; clock += 5000; service = await PushService.create(directory, new Set([origin]), options); await service.flush();
    assert.equal(sent, 10); assert.equal(service.status('session').queued, 0); assert.equal(service.status('session').overflow, 1);
    assert.equal(service.status('session').failed, 1);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('failed atomic outbox persistence never dispatches or dedupes an uncommitted event', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-outbox-atomic-'))
  let fail = true; let sent = 0
  const service = await PushService.create(directory, new Set([origin]), { sendNotification: async () => { sent++ } })
  const originalRename = fs.rename.bind(fs)
  const destination = path.join(directory, 'push-subscriptions.json')
  try {
    await service.subscribe('session', subscription('atomic-outbox'))
    service.observe(host, { method: 'thread/started', params: { thread: { id: 'atomic-thread', source: 'cli' } } })
    t.mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (fail && to === destination) throw Object.assign(new Error('disk unavailable'), { code: 'EIO' })
      return originalRename(from, to)
    })
    const event = { method: 'turn/completed', params: { threadId: 'atomic-thread', turn: { id: 'atomic-turn', status: 'completed' } } }
    service.observe(host, event); await service.flush()
    assert.equal(sent, 0)
    const stored = JSON.parse(await fs.readFile(destination, 'utf8'))
    assert.equal(stored.events.length, 0); assert.equal(stored.outbox.length, 0)
    fail = false; service.observe(host, event); await service.flush()
    assert.equal(sent, 1); assert.equal(service.status('session').delivered, 1)
  } finally { fail = false; await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('hard delivery timeout schedules a durable retry instead of hanging or disclosing network errors', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-outbox-timeout-'))
  let clock = Date.now(); let calls = 0
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const service = await PushService.create(directory, new Set([origin]), { now: () => clock, sendNotification: async () => {
    calls++; if (calls === 1) { markStarted(); await new Promise<void>(() => {}) }
  } })
  try {
    const device = subscription('hard-timeout'); await service.subscribe('session', device)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const response = service.test('session', device.endpoint)
    await started; clock += 12000; t.mock.timers.tick(12000)
    assert.equal((await response).queued, true); await service.flush(); assert.equal(service.status('session').lastFailure, 'timeout')
    clock += 5000; await service.flush()
    assert.equal(calls, 2); assert.equal(service.status('session').queued, 0); assert.equal(service.status('session').delivered, 1)
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('subagent completion and failure never notify, including cold metadata and renamed lookup races; main completion still does', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-child-'))
  const sent: any[] = []; let resolve: (value: unknown) => void = () => {}; let lookups = 0
  const service = await PushService.create(directory, new Set([origin]), { sendNotification: async (_subscription, payload) => { sent.push(JSON.parse(payload)) }, resolveThread: async (_host, id) => { lookups++; if (id === 'cold-child') return new Promise(done => { resolve = done }); return { id, source: 'cli', name: '主任务' } } })
  try {
    await service.subscribe('child-test-session', subscription('child-notifications'))
    const host = { id: 'local', name: 'Fixture', kind: 'local' } as const
    service.observe(host, { method: 'thread/started', params: { thread: { id: 'child', name: '子任务', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } } })
    const done = (threadId: string, turn: string, status = 'completed') => service.observe(host, { method: 'turn/completed', params: { threadId, turn: { id: turn, status } } })
    done('child', 'a'); done('child', 'b', 'failed')
    service.observe(host, { method: 'item/completed', params: { threadId: 'parent', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['spawn-child'] } } })
    done('spawn-child', 'c')
    done('cold-child', 'd')
    while (!lookups) await new Promise<void>(done => setImmediate(done))
    service.observe(host, { method: 'thread/name/updated', params: { threadId: 'cold-child', threadName: '重命名子任务' } })
    resolve({ id: 'cold-child', name: '旧名称', source: { subagent: 'review' } })
    await service.flush(); assert.equal(sent.length, 0)
    done('parent', 'e'); await service.flush(); assert.equal(sent.length, 1); assert.equal(sent[0].title, '主任务')
    done('parent', 'e'); await service.flush(); assert.equal(sent.length, 1)
    const other = { id: 'remote', name: 'Other', kind: 'local' } as const
    done('child', 'again'); service.observe(other, { method: 'thread/started', params: { thread: { id: 'child', name: '另一主机主任务', source: 'cli' } } }); service.observe(other, { method: 'turn/completed', params: { threadId: 'child', turn: { id: 'a', status: 'completed' } } }); await service.flush(); assert.equal(sent.length, 2)
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('ephemeral side chat completion and failures do not notify; metadata races and host isolation preserve main notices', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-side-'))
  const sent: any[] = []
  let resolve: (value: unknown) => void = () => {}
  let lookupStarted = false
  const service = await PushService.create(directory, new Set([origin]), {
    sendNotification: async (_subscription, payload) => { sent.push(JSON.parse(payload)) },
    resolveThread: async (_host, threadId) => {
      if (threadId === 'cold-side') { lookupStarted = true; return new Promise(done => { resolve = done }) }
      return { id: threadId, source: 'cli', name: '主对话', ephemeral: false }
    },
  })
  try {
    await service.subscribe('side-test-session', subscription('side-notifications'))
    const done = (threadId: string, turnId: string, status = 'completed') => service.observe(host, { method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } })
    service.observe(host, { method: 'thread/started', params: { thread: { id: 'side', name: '侧边提问', source: 'cli', ephemeral: true } } })
    done('side', 'complete'); done('side', 'failure', 'failed')
    done('cold-side', 'cold')
    while (!lookupStarted) await tick()
    service.observe(host, { method: 'thread/name/updated', params: { threadId: 'cold-side', threadName: '后来修改的侧边标题' } })
    resolve({ id: 'cold-side', name: '旧标题', source: 'cli', ephemeral: true })
    await service.flush(); assert.equal(sent.length, 0)
    done('parent', 'main'); await service.flush(); assert.equal(sent.length, 1)
    const other = { ...host, id: 'other' }
    service.observe(other, { method: 'thread/started', params: { thread: { id: 'side', name: '另一台主机的主对话', source: 'cli', ephemeral: false } } })
    service.observe(other, { method: 'turn/completed', params: { threadId: 'side', turn: { id: 'complete', status: 'completed' } } })
    await service.flush(); assert.equal(sent.length, 2)
    service.observe(host, { id: 'side-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'side', turnId: 'approval-turn' } })
    await service.flush(); assert.equal(sent.length, 3); assert.equal(sent[2].data.kind, 'approval')
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
