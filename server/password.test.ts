import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { createECDH, randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { Auth, SESSION_TTL } from './auth.js'
import { createServer } from './app.js'
import { PushService } from './push.js'
import type { RpcMessage } from './types.js'
import type { Transport } from './bridge.js'

const origin = 'http://localhost:8787'
const password = 'password-change-initial-123'
const nextPassword = 'password-change-replacement-456'
const nextPasswordB = 'password-change-alternative-789'

async function authentication(directory?: string, explicit: string | null = password, secureCookie = false) {
  const dataDir = directory || await fs.mkdtemp(path.join(os.tmpdir(), 'codex-password-'))
  const auth = await Auth.create(dataDir, explicit ?? undefined, new Set([origin]), secureCookie)
  const app = express()
  app.use(express.json({ strict: false }))
  app.get('/session', auth.session)
  app.post('/login', auth.login)
  app.post('/password', auth.requireAuth, auth.requireCsrf, auth.changePassword)
  app.post('/logout', auth.requireAuth, auth.requireCsrf, auth.logout)
  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const login = async (value = password) => {
    const response = await post('/login', { password: value })
    assert.equal(response.status, 200)
    const cookieHeader = response.headers.get('set-cookie')!
    const cookie = cookieHeader.split(';')[0]!
    const body = await response.json() as { csrfToken: string; expiresAt: number }
    return { ...body, cookie, cookieHeader, headers: { cookie, 'x-csrf-token': body.csrfToken } }
  }
  const close = () => new Promise<void>(resolve => server.close(() => resolve()))
  return { auth, post, login, base, dataDir, close }
}

test('login cookies and live sessions last 30 days and expire at the boundary', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const app = await authentication(undefined, password, true)
  try {
    const session = await app.login()
    assert.equal(session.expiresAt, now + SESSION_TTL)
    assert.equal(SESSION_TTL, 30 * 24 * 60 * 60 * 1000)
    assert.match(session.cookieHeader, /Max-Age=2592000/i)
    assert.match(session.cookieHeader, /HttpOnly/i)
    assert.match(session.cookieHeader, /Secure/i)
    assert.match(session.cookieHeader, /SameSite=Strict/i)
    now += 29 * 24 * 60 * 60 * 1000
    assert.ok(app.auth.getSession(session.cookie))
    const revoked: string[] = []
    app.auth.onSessionRevoked(id => revoked.push(id))
    now += 24 * 60 * 60 * 1000
    assert.equal(app.auth.getSession(session.cookie), undefined)
    assert.equal(revoked.length, 1)
    const body = await (await fetch(app.base + '/session', { headers: { cookie: session.cookie } })).json() as { authenticated: boolean }
    assert.equal(body.authenticated, false)
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

test('password changes validate authentication, CSRF, current password and strict fields without signing out', async () => {
  const app = await authentication()
  try {
    const valid = { currentPassword: password, newPassword: nextPassword }
    assert.equal((await app.post('/password', valid)).status, 401)
    const session = await app.login()
    assert.equal((await app.post('/password', valid, { cookie: session.cookie })).status, 403)
    assert.equal((await app.post('/password', valid, { ...session.headers, origin: 'https://attacker.invalid' })).status, 403)
    const badPassword = await app.post('/password', { ...valid, currentPassword: 'private-wrong-password' }, session.headers)
    assert.equal(badPassword.status, 403)
    assert.deepEqual(await badPassword.json(), { error: '当前访问密码不正确。' })
    assert.ok(app.auth.getSession(session.cookie))
    for (const body of [null, [], { ...valid, extra: 'private-value' }, { newPassword: nextPassword }, { ...valid, currentPassword: 123 }, { ...valid, currentPassword: 'x'.repeat(1025) }, { ...valid, newPassword: 'too-short' }, { ...valid, newPassword: 'x'.repeat(1025) }]) {
      const response = await app.post('/password', body, session.headers)
      assert.equal(response.status, 400)
      assert.ok(!(await response.text()).includes('private-value'))
    }
    assert.equal((await app.post('/password', { currentPassword: password, newPassword: password }, session.headers)).status, 400)
    const longPassword = 'x'.repeat(1024)
    const updated = await app.post('/password', { currentPassword: password, newPassword: longPassword }, session.headers)
    assert.equal(updated.status, 200)
    const result = await updated.json() as { ok: boolean; expiresAt: number }
    assert.ok(result.ok && result.expiresAt > Date.now() + SESSION_TTL - 1000)
    assert.equal(updated.headers.get('set-cookie')!.split(';')[0], session.cookie)
    assert.match(updated.headers.get('set-cookie')!, /Max-Age=2592000/i)
    assert.equal(app.auth.getSession(session.cookie)!.csrfToken, session.csrfToken)
    assert.equal((await app.post('/login', { password })).status, 401)
    assert.equal((await app.post('/login', { password: longPassword })).status, 200)
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

test('password verification shares the login rate limit and cannot repeatedly probe an old password', async () => {
  const app = await authentication()
  try {
    const session = await app.login()
    for (let i = 0; i < 9; i++) assert.equal((await app.post('/password', { currentPassword: 'wrong-password', newPassword: nextPassword }, session.headers)).status, 403)
    const blocked = await app.post('/password', { currentPassword: password, newPassword: nextPassword }, session.headers)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '900')
    assert.equal((await app.post('/login', { password })).status, 429)
    assert.ok(app.auth.getSession(session.cookie))
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

test('the private password hash survives restarts and overrides environment and bootstrap credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-password-restart-'))
  const bootstrapFile = path.join(directory, 'bootstrap-password.txt')
  await fs.writeFile(bootstrapFile, password + '\n', { mode: 0o600 })
  const app = await authentication(directory, null)
  try {
    const initial = await fs.readFile(path.join(directory, 'web-password.json'), 'utf8')
    assert.ok(!initial.includes(password))
    assert.equal(JSON.parse(initial).algorithm, 'scrypt')
    assert.equal((await fs.stat(path.join(directory, 'web-password.json'))).mode & 0o777, 0o600)
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
    const session = await app.login()
    assert.equal((await app.post('/password', { currentPassword: password, newPassword: nextPassword }, session.headers)).status, 200)
    const stored = await fs.readFile(path.join(directory, 'web-password.json'), 'utf8')
    assert.ok(!stored.includes(password) && !stored.includes(nextPassword))
    assert.notEqual(JSON.parse(stored).salt, JSON.parse(initial).salt)
    assert.notEqual(JSON.parse(stored).credentialVersion, JSON.parse(initial).credentialVersion)
    assert.equal(await fs.readFile(bootstrapFile, 'utf8'), password + '\n')
    assert.ok(!(await fs.readdir(directory)).some(file => file.endsWith('.tmp')))
    await app.close()
    const restarted = await authentication(directory, 'stale-environment-password-123')
    try {
      assert.equal((await restarted.post('/login', { password })).status, 401)
      assert.equal((await restarted.post('/login', { password: 'stale-environment-password-123' })).status, 401)
      assert.equal((await restarted.post('/login', { password: nextPassword })).status, 200)
      assert.equal(restarted.auth.getSession(session.cookie)!.csrfToken, session.csrfToken)
    } finally { await restarted.close() }
  } finally { if (app) await app.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('malformed or unsupported password records fail closed instead of falling back to a known password', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-password-corrupt-'))
  try {
    await Auth.create(directory, password, new Set())
    const file = path.join(directory, 'web-password.json')
    const good = JSON.parse(await fs.readFile(file, 'utf8'))
    for (const content of ['not-json', JSON.stringify({ ...good, version: 2 }), JSON.stringify({ ...good, hash: 'bad' }), JSON.stringify({ ...good, password })]) {
      await fs.writeFile(file, content)
      await assert.rejects(Auth.create(directory, password, new Set()), /Unable to read persisted web password/)
    }
    await fs.rm(file)
    await fs.symlink(path.join(directory, 'missing-password.json'), file)
    await assert.rejects(Auth.create(directory, password, new Set()), /Unable to read persisted web password/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('a failed atomic write leaves the old credential and all sessions valid without exposing filesystem errors', async t => {
  const app = await authentication()
  try {
    const current = await app.login(); const other = await app.login()
    const file = path.join(app.dataDir, 'web-password.json')
    const before = await fs.readFile(file, 'utf8')
    const expiresBefore = app.auth.getSession(current.cookie)!.expiresAt
    const rename = fs.rename.bind(fs)
    t.mock.method(fs, 'rename', async (from, to) => {
      if (to === file) throw new Error('private-path-and-credentials')
      return rename(from, to)
    })
    const response = await app.post('/password', { currentPassword: password, newPassword: nextPassword }, current.headers)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: '无法保存新密码，请稍后重试。' })
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(await fs.readFile(file, 'utf8'), before)
    assert.equal(app.auth.getSession(current.cookie)!.expiresAt, expiresBefore)
    assert.ok(app.auth.getSession(other.cookie))
    assert.ok(!(await fs.readdir(app.dataDir)).some(file => file.endsWith('.tmp')))
    assert.equal((await app.post('/login', { password: nextPassword })).status, 401)
    assert.equal((await app.post('/login', { password })).status, 200)
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

test('concurrent password changes serialize verification so one old credential cannot rotate twice', async () => {
  const app = await authentication()
  try {
    const session = await app.login()
    const responses = await Promise.all([nextPassword, nextPasswordB].map(newPassword => app.post('/password', { currentPassword: password, newPassword }, session.headers)))
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 403])
    const changed = responses[0]!.status === 200 ? nextPassword : nextPasswordB
    const unchanged = responses[0]!.status === 200 ? nextPasswordB : nextPassword
    assert.equal((await app.post('/login', { password })).status, 401)
    assert.equal((await app.post('/login', { password: unchanged })).status, 401)
    assert.equal((await app.post('/login', { password: changed })).status, 200)
    assert.ok(app.auth.getSession(session.cookie))
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

function transport(): Transport {
  const input = new PassThrough(); const output = new PassThrough()
  let buffer = ''
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const message = JSON.parse(buffer.slice(0, end)) as RpcMessage; buffer = buffer.slice(end + 1)
      if (message.id === undefined || !message.method) continue
      void (async () => {
        const params = message.params as { path: string }
        let result: unknown = {}
        if (message.method === 'initialize') result = { userAgent: 'password-test' }
        else if (message.method === 'fs/getMetadata') { const stat = await fs.stat(params.path); result = { isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymlink: false } }
        else if (message.method === 'fs/readFile') result = { dataBase64: (await fs.readFile(params.path)).toString('base64') }
        output.write(`${JSON.stringify({ id: message.id, result })}\n`)
      })()
    }
  })
  return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } }
}

function pushSubscription(name: string) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
  return { endpoint: `https://fcm.googleapis.com/push/${name}`, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}

test('password rotation revokes other RPC sockets, preview tickets and push devices while preserving the current workflow', { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-password-workflow-'))
  const project = path.join(directory, 'project'); await fs.mkdir(project)
  const document = path.join(project, 'index.html'); await fs.writeFile(document, '<h1>Private preview</h1>')
  const sent: string[] = []
  const application = await createServer({ cwd: directory, dataDir: path.join(directory, 'data'), codexHome: path.join(directory, 'codex'), password, secureCookie: false, serveStatic: false,
    bridgeOptions: { transportFactory: () => transport() }, pushOptions: { sendNotification: async subscription => { sent.push(subscription.endpoint) } },
  })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const login = async () => {
    const response = await post('/api/auth/login', { password }); assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const { csrfToken } = await response.json() as { csrfToken: string }
    return { cookie, headers: { cookie, 'x-csrf-token': csrfToken } }
  }
  const socket = (cookie: string) => new WebSocket(base.replace('http:', 'ws:') + '/api/rpc?clientId=password_workflow', { headers: { cookie, origin } })
  let currentSocket: WebSocket | undefined; let otherSocket: WebSocket | undefined
  try {
    const current = await login(); const other = await login(); const expired = await login()
    const malformed = await fetch(base + '/api/auth/password', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...current.headers }, body: '{"currentPassword":"private-json-parse-value" broken}' })
    assert.equal(malformed.status, 400)
    assert.deepEqual(await malformed.json(), { error: '请求格式不正确，请重试。' })
    const currentDevice = pushSubscription('current-phone'); const otherDevice = pushSubscription('other-phone'); const expiredDevice = pushSubscription('expired-login-phone')
    for (const [session, subscription] of [[current, currentDevice], [other, otherDevice], [expired, expiredDevice]] as const) assert.equal((await post('/api/push/subscription', { subscription }, session.headers)).status, 200)
    application.auth.getSession(expired.cookie)!.expiresAt = Date.now() - 1
    assert.equal(application.auth.getSession(expired.cookie), undefined)
    currentSocket = socket(current.cookie); otherSocket = socket(other.cookie)
    await Promise.all([currentSocket, otherSocket].map(socket => new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })))
    const tickets = await Promise.all([current, other].map(async session => {
      const ticket = await fetch(base + '/api/preview?host=local&path=' + encodeURIComponent(document), { headers: { cookie: session.cookie }, redirect: 'manual' })
      assert.equal(ticket.status, 302)
      return ticket.headers.get('location')!
    }))
    application.auth.getSession(current.cookie)!.expiresAt = Date.now() + 100000
    const otherClosed = new Promise<number>(resolve => otherSocket!.once('close', code => resolve(code)))
    const updated = await post('/api/auth/password', { currentPassword: password, newPassword: nextPassword }, current.headers)
    assert.equal(updated.status, 200)
    assert.equal(updated.headers.get('set-cookie')!.split(';')[0], current.cookie)
    assert.equal(await otherClosed, 4003)
    assert.equal(currentSocket.readyState, WebSocket.OPEN)
    const reply = new Promise<void>(resolve => currentSocket!.on('message', data => { if (JSON.parse(data.toString()).id === 'workflow-still-running') resolve() }))
    currentSocket.send(JSON.stringify({ id: 'workflow-still-running', method: 'thread/list', params: {} })); await reply
    assert.equal((await fetch(base + '/api/push/config', { headers: { cookie: other.cookie } })).status, 401)
    assert.equal((await fetch(base + tickets[0])).status, 200)
    assert.equal((await fetch(base + tickets[1])).status, 403)
    application.push.observe({ id: 'local', name: 'Local', kind: 'local' }, { method: 'thread/started', params: { thread: { id: 'thread-1', source: 'cli' } } })
    application.push.observe({ id: 'local', name: 'Local', kind: 'local' }, { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'after-password-change', status: 'completed' } } })
    await application.push.flush()
    assert.deepEqual(sent, [currentDevice.endpoint])
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'data', 'push-subscriptions.json'), 'utf8'))
    assert.deepEqual(saved.subscriptions.map((device: { subscription: { endpoint: string } }) => device.subscription.endpoint), [currentDevice.endpoint])
    assert.equal((await post('/api/auth/login', { password })).status, 401)
    assert.equal((await post('/api/auth/login', { password: nextPassword })).status, 200)
  } finally { currentSocket?.terminate(); otherSocket?.terminate(); await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('persisted push generations retain the current device and cannot restore revoked grants after a failed push-file write', async t => {
  const app = await authentication()
  const sent: string[] = []
  const pushOptions = { credentialVersion: app.auth.pushCredentialVersion, sendNotification: async (subscription: { endpoint: string }) => { sent.push(subscription.endpoint) } }
  const push = await PushService.create(app.dataDir, new Set([origin]), pushOptions)
  app.auth.onPasswordChanged((sessionId, version) => push.changeCredentialVersion(version, sessionId))
  try {
    const current = await app.login(); const other = await app.login()
    const currentId = app.auth.getSession(current.cookie)!.id
    const otherId = app.auth.getSession(other.cookie)!.id
    const retained = pushSubscription('retain-after-restart'); const revoked = pushSubscription('revoke-after-restart')
    await push.subscribe(currentId, retained); await push.subscribe(otherId, revoked)
    assert.equal((await app.post('/password', { currentPassword: password, newPassword: nextPassword }, current.headers)).status, 200)
    const firstRestart = await PushService.create(app.dataDir, new Set([origin]), { ...pushOptions, credentialVersion: app.auth.pushCredentialVersion })
    try {
      await firstRestart.test(currentId, retained.endpoint)
      await firstRestart.flush()
      assert.deepEqual(sent, [retained.endpoint])
      await assert.rejects(firstRestart.test(otherId, revoked.endpoint), (error: { status?: number }) => error.status === 404)
    } finally { await firstRestart.close() }
    const newOther = await app.login(nextPassword)
    await push.subscribe(app.auth.getSession(newOther.cookie)!.id, revoked)
    const pushFile = path.join(app.dataDir, 'push-subscriptions.json')
    const persistedBeforeFailure = await fs.readFile(pushFile, 'utf8')
    const rename = fs.rename.bind(fs)
    t.mock.method(fs, 'rename', async (from, to) => { if (to === pushFile) throw new Error('private-push-write-failure'); return rename(from, to) })
    const logs: string[] = []
    t.mock.method(console, 'error', (message: string) => logs.push(message))
    assert.equal((await app.post('/password', { currentPassword: nextPassword, newPassword: nextPasswordB }, current.headers)).status, 200)
    assert.equal(await fs.readFile(pushFile, 'utf8'), persistedBeforeFailure)
    assert.equal(logs.length, 1)
    assert.ok(!logs[0]!.includes('private-push-write-failure'))
    // Password persistence committed a new generation, so stale grants are unusable
    // even if the separate subscription file could not be updated before a crash.
    t.mock.restoreAll()
    const restartedAuth = await Auth.create(app.dataDir, password, new Set([origin]))
    const secondRestart = await PushService.create(app.dataDir, new Set([origin]), { ...pushOptions, credentialVersion: restartedAuth.pushCredentialVersion })
    try { assert.equal(secondRestart.hasActiveSubscriptions, false) }
    finally { await secondRestart.close() }
  } finally { await push.close(); await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

test('unbound legacy devices are rejected and only matching credential generations survive restarts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-password-push-migration-'))
  const sent: string[] = []
  const sendNotification = async (subscription: { endpoint: string }) => { sent.push(subscription.endpoint) }
  try {
    const legacy = await PushService.create(directory, new Set([origin]), { sendNotification })
    const device = pushSubscription('legacy-browser')
    await legacy.subscribe('old-session', device)
    await legacy.close()
    const file = path.join(directory, 'push-subscriptions.json')
    const legacyFile = JSON.parse(await fs.readFile(file, 'utf8'))
    // The previous public release wrote version 1 without any credential generation.
    legacyFile.version = 1
    await fs.writeFile(file, JSON.stringify(legacyFile))
    const initialAuth = await Auth.create(directory, password, new Set([origin]))
    const upgraded = await PushService.create(directory, new Set([origin]), { sendNotification, credentialVersion: initialAuth.pushCredentialVersion })
    try {
      assert.equal(upgraded.hasActiveSubscriptions, false)
      await assert.rejects(upgraded.test('old-session', device.endpoint), (error: { status?: number }) => error.status === 404)
      // A newly authenticated page may explicitly register its browser subscription.
      await upgraded.subscribe('current-session', device)
    } finally { await upgraded.close() }
    assert.deepEqual(sent, [])
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(saved.version, 3)
    assert.equal(saved.subscriptions[0].credentialVersion, initialAuth.pushCredentialVersion)
    const unchangedAuth = await Auth.create(directory, nextPassword, new Set([origin]))
    assert.equal(unchangedAuth.pushCredentialVersion, initialAuth.pushCredentialVersion)
    const unchangedPush = await PushService.create(directory, new Set([origin]), { sendNotification, credentialVersion: unchangedAuth.pushCredentialVersion })
    try { assert.equal(unchangedPush.hasActiveSubscriptions, true); await unchangedPush.test('current-session', device.endpoint) }
    finally { await unchangedPush.close() }
    // Reset the initial password without ever having used the settings password form.
    await fs.rm(path.join(directory, 'web-password.json'))
    const resetAuth = await Auth.create(directory, nextPassword, new Set([origin]))
    assert.notEqual(resetAuth.pushCredentialVersion, initialAuth.pushCredentialVersion)
    const resetPush = await PushService.create(directory, new Set([origin]), { sendNotification, credentialVersion: resetAuth.pushCredentialVersion })
    try { assert.equal(resetPush.hasActiveSubscriptions, false) }
    finally { await resetPush.close() }
    // Restoring an old version 1 subscription backup during password recovery must
    // also fail closed; newly created credentials never legitimize unbound grants.
    await fs.writeFile(file, JSON.stringify(legacyFile))
    await fs.rm(path.join(directory, 'web-password.json'))
    const recoveredAuth = await Auth.create(directory, nextPasswordB, new Set([origin]))
    const restoredLegacyPush = await PushService.create(directory, new Set([origin]), { sendNotification, credentialVersion: recoveredAuth.pushCredentialVersion })
    try { assert.equal(restoredLegacyPush.hasActiveSubscriptions, false) }
    finally { await restoredLegacyPush.close() }
    assert.deepEqual(sent, [device.endpoint])
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('private hashed login records preserve the bearer ID, CSRF and expiry across a service restart', async () => {
  const app = await authentication(undefined, password, true)
  try {
    const current = await app.login(); const other = await app.login()
    const original = app.auth.getSession(current.cookie)!
    const content = await fs.readFile(path.join(app.dataDir, 'web-sessions.json'), 'utf8')
    const saved = JSON.parse(content)
    assert.equal(saved.sessions.length, 2)
    assert.ok(!content.includes(original.id) && !content.includes(password))
    assert.equal(saved.sessions[0].sessionHash.length, 43)
    assert.equal((await fs.stat(path.join(app.dataDir, 'web-sessions.json'))).mode & 0o777, 0o600)
    assert.ok(!(await fs.readdir(app.dataDir)).some(file => file.endsWith('.tmp')))
    await app.close()
    const restarted = await authentication(app.dataDir, 'stale-environment-password-123', true)
    try {
      assert.equal(restarted.auth.isSessionActive(original.id), true)
      const restored = restarted.auth.getSession(current.cookie)!
      assert.deepEqual(restored, original)
      assert.equal(restarted.auth.getSession(other.cookie)!.csrfToken, other.csrfToken)
      const status = await fetch(restarted.base + '/session', { headers: { cookie: current.cookie } })
      assert.equal(status.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await status.json(), { authenticated: true, authRequired: true, csrfToken: current.csrfToken, expiresAt: current.expiresAt })
      assert.equal((await restarted.post('/logout', {}, { cookie: current.cookie, 'x-csrf-token': 'stale-csrf' })).status, 403)
      assert.equal((await restarted.post('/logout', {}, { ...current.headers, origin: 'https://attacker.invalid' })).status, 403)
      assert.ok(restarted.auth.getSession(current.cookie))
    } finally { await restarted.close() }
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

test('durable logout revokes only its session and device hash despite failed browser-independent device cleanup', async t => {
  const app = await authentication()
  try {
    const current = await app.login(); const other = await app.login()
    const currentId = app.auth.getSession(current.cookie)!.id
    const { sessionHash } = await import('./auth-sessions.js')
    const revoked: string[] = []
    const logs: string[] = []
    app.auth.onSessionRevoked(id => revoked.push(id))
    app.auth.onLogout(async () => { throw new Error('private-push-file-failure') })
    t.mock.method(console, 'error', (message: string) => logs.push(message))
    const result = await app.post('/logout', {}, current.headers)
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.match(result.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/i)
    assert.deepEqual(await result.json(), { authenticated: false })
    assert.deepEqual(revoked, [currentId])
    assert.equal(app.auth.getSession(current.cookie), undefined)
    assert.equal(app.auth.isPushSessionRevokedHash(sessionHash(currentId)), true)
    assert.ok(app.auth.getSession(other.cookie))
    assert.equal(logs.length, 1)
    assert.ok(!logs[0]!.includes('private-push-file-failure'))
    await app.close()
    const restarted = await authentication(app.dataDir)
    try {
      assert.equal(restarted.auth.getSession(current.cookie), undefined)
      assert.equal(restarted.auth.isPushSessionRevokedHash(sessionHash(currentId)), true)
      assert.equal(restarted.auth.getSession(other.cookie)!.csrfToken, other.csrfToken)
    } finally { await restarted.close() }
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

test('password rotation retains the current durable login but permanently rejects the old generation and other cookies', async () => {
  const app = await authentication()
  try {
    const current = await app.login(); const other = await app.login()
    const oldRecord = await fs.readFile(path.join(app.dataDir, 'web-sessions.json'), 'utf8')
    assert.equal((await app.post('/password', { currentPassword: password, newPassword: nextPassword }, current.headers)).status, 200)
    await app.close()
    const restarted = await authentication(app.dataDir)
    try {
      assert.equal(restarted.auth.getSession(current.cookie)!.csrfToken, current.csrfToken)
      assert.equal(restarted.auth.getSession(other.cookie), undefined)
      assert.equal((await restarted.post('/login', { password })).status, 401)
      assert.equal((await restarted.post('/login', { password: nextPassword })).status, 200)
    } finally { await restarted.close() }
    // Restoring a stale session backup must not restore authorizations after rotation.
    await fs.writeFile(path.join(app.dataDir, 'web-sessions.json'), oldRecord)
    const reset = await Auth.create(app.dataDir, password, new Set([origin]))
    assert.equal(reset.getSession(current.cookie), undefined)
    assert.equal(reset.getSession(other.cookie), undefined)
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

test('expired durable sessions and revocations are not restored', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const app = await authentication()
  try {
    const current = await app.login(); const signedOut = await app.login()
    const { sessionHash } = await import('./auth-sessions.js')
    const signedOutHash = sessionHash(app.auth.getSession(signedOut.cookie)!.id)
    assert.equal((await app.post('/logout', {}, signedOut.headers)).status, 200)
    await app.close()
    now += SESSION_TTL
    const restarted = await Auth.create(app.dataDir, password, new Set([origin]))
    assert.equal(restarted.getSession(current.cookie), undefined)
    assert.equal(restarted.isPushSessionRevokedHash(signedOutHash), false)
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

test('corrupt, modified and linked session records fail closed without preventing a fresh password login', async t => {
  const app = await authentication()
  t.mock.method(console, 'error', () => {})
  try {
    const current = await app.login()
    const file = path.join(app.dataDir, 'web-sessions.json')
    const initial = await fs.readFile(file, 'utf8')
    const saved = JSON.parse(initial)
    const changedExpiry = structuredClone(saved)
    changedExpiry.sessions[0].expiresAt += 1
    for (const content of ['not-json', JSON.stringify({ ...saved, version: 2 }), JSON.stringify({ ...saved, credentialVersion: '0'.repeat(32) }), JSON.stringify({ ...saved, signature: 'a'.repeat(43) }), JSON.stringify({ ...saved, sessionId: current.cookie }), JSON.stringify(changedExpiry), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
      await fs.writeFile(file, content)
      const restarted = await Auth.create(app.dataDir, password, new Set([origin]))
      assert.equal(restarted.getSession(current.cookie), undefined)
    }
    const target = path.join(app.dataDir, 'untrusted-sessions.json')
    await fs.writeFile(target, initial)
    await fs.rm(file)
    await fs.symlink(target, file)
    const restarted = await authentication(app.dataDir)
    try {
      assert.equal(restarted.auth.getSession(current.cookie), undefined)
      const fresh = await restarted.login()
      assert.ok(restarted.auth.getSession(fresh.cookie))
      assert.equal((await fs.lstat(file)).isSymbolicLink(), false)
      assert.equal(await fs.readFile(target, 'utf8'), initial)
    } finally { await restarted.close() }
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})

test('failed durable login and logout writes never claim success or silently revive a completed logout', async t => {
  const app = await authentication()
  try {
    const current = await app.login()
    const file = path.join(app.dataDir, 'web-sessions.json')
    const before = await fs.readFile(file, 'utf8')
    const rename = fs.rename.bind(fs)
    t.mock.method(fs, 'rename', async (from, to) => { if (to === file) throw new Error('private-session-write-failure'); return rename(from, to) })
    const failedLogin = await app.post('/login', { password }, { cookie: current.cookie })
    assert.equal(failedLogin.status, 503)
    assert.equal(failedLogin.headers.get('set-cookie'), null)
    assert.ok(!(await failedLogin.text()).includes('private-session-write-failure'))
    const failedLogout = await app.post('/logout', {}, current.headers)
    assert.equal(failedLogout.status, 503)
    assert.equal(failedLogout.headers.get('set-cookie'), null)
    assert.ok(!(await failedLogout.text()).includes('private-session-write-failure'))
    assert.ok(app.auth.getSession(current.cookie))
    assert.equal(await fs.readFile(file, 'utf8'), before)
    assert.ok(!(await fs.readdir(app.dataDir)).some(name => name.endsWith('.tmp')))
    const stillValid = await Auth.create(app.dataDir, password, new Set([origin]))
    assert.ok(stillValid.getSession(current.cookie))
    t.mock.restoreAll()
    assert.equal((await app.post('/logout', {}, current.headers)).status, 200)
    const revoked = await Auth.create(app.dataDir, password, new Set([origin]))
    assert.equal(revoked.getSession(current.cookie), undefined)
  } finally { await app.close(); await fs.rm(app.dataDir, { recursive: true, force: true }) }
})
