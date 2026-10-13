import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { z } from 'zod'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { Auth } from './auth.js'
import { Bridge, type Transport } from './bridge.js'
import { AutomationService, type AutomationInput } from './automations.js'
import { registerHostResources } from './host-resources.js'
import type { Host, RpcMessage } from './types.js'

const host: Host = { id: 'local', kind: 'local', name: 'Runtime fixture' }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
class Browser extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent: RpcMessage[] = []
  send(value: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(value)); callback?.() }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
  request(value: RpcMessage) { this.emit('message', Buffer.from(JSON.stringify(value))) }
  ws() { return this as unknown as WebSocket }
}
type NativePeer = { transport: Transport; sent: RpcMessage[]; disposed: boolean; receive(message: RpcMessage): void; releaseClose(): void }
function fixture(options: { host?: Host; mode?: 'spawn' | 'proxy'; reply?: (message: RpcMessage, index: number, peer: NativePeer) => unknown; holdClose?: boolean } = {}) {
  const peers: NativePeer[] = []
  const bridge = new Bridge(options.host || host, { mode: options.mode, transportFactory: () => {
    const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter()
    let buffer = '', releaseClose!: () => void
    const closed = new Promise<void>(resolve => { releaseClose = resolve })
    const peer: NativePeer = { sent: [], disposed: false, releaseClose, receive: message => { if (!peer.disposed) output.write(`${JSON.stringify(message)}\n`) },
      transport: { input, output, events, closed, dispose: () => { peer.disposed = true; input.destroy(); output.destroy(); if (!options.holdClose) releaseClose() } } }
    peers.push(peer)
    input.on('data', chunk => {
      buffer += chunk.toString(); let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, at)) as RpcMessage; buffer = buffer.slice(at + 1); peer.sent.push(message)
        if (message.id === undefined) continue
        const custom = options.reply?.(message, peers.length, peer)
        if (custom === false) continue
        const params = message.params as any
        const result = custom ?? (message.method === 'initialize' ? { userAgent: `codex fixture/${peers.length}`, codexHome: '/fixture' }
          : ['thread/loaded/list', 'thread/backgroundTerminals/list'].includes(message.method || '') ? { data: [], nextCursor: null }
          : ['thread/resume', 'thread/start', 'thread/read'].includes(message.method || '') ? { thread: { id: params?.threadId || 'internal-thread', status: { type: 'idle' } } } : {})
        queueMicrotask(() => peer.receive({ id: message.id, result }))
      }
    })
    return peer.transport
  } })
  return { bridge, peers }
}

test('explicit idle reconnect renews initialize metadata and engine while retaining browser sockets and released threads', async t => {
  const f = fixture(); t.after(() => f.bridge.close())
  const browser = new Browser(); f.bridge.attach('reader', browser.ws(), 'reader')
  await f.bridge.request('thread/resume', { threadId: 'read-thread' })
  const before = f.bridge.runtime.engineId
  f.bridge.releasedThreads.set('released-thread', { name: 'Preserved release', restoreThreadIds: [] })
  await f.bridge.reconnect()
  assert.equal(f.peers.length, 2); assert.equal(f.peers[0]!.disposed, true)
  assert.notEqual(f.bridge.runtime.engineId, before)
  assert.equal(f.bridge.userAgent, 'codex fixture/2'); assert.equal(f.bridge.connected, true)
  assert.equal(browser.readyState, 1); assert.equal(f.bridge.releasedThreads.get('released-thread')?.name, 'Preserved release')
  assert.ok(browser.sent.some(message => message.method === 'bridge/status' && (message.params as any).connected === false))
  assert.equal((browser.sent.at(-1)!.params as any).userAgent, 'codex fixture/2')
  assert.equal(f.bridge.diagnostics().lastDisconnect?.category, 'runtimeReconnect')
  assert.ok(!f.peers.flatMap(peer => peer.sent).some(message => ['turn/start', 'turn/interrupt', 'thread/archive', 'thread/delete'].includes(message.method || '')))
})

for (const activity of ['own-turn', 'child-turn', 'internal-turn', 'approval', 'terminal', 'command'] as const) {
  test(`reconnect preserves a runtime with ${activity} and never applies configuration preparation`, async t => {
    const f = fixture({ reply: message => message.method === 'command/exec' ? false : undefined }); t.after(() => f.bridge.close())
    await f.bridge.connect(); const peer = f.peers[0]!
    let command: Promise<unknown> | undefined
    if (activity === 'own-turn') {
      await f.bridge.request('thread/resume', { threadId: 'own' })
      peer.receive({ method: 'turn/started', params: { threadId: 'own', turn: { id: 'active', status: 'inProgress' } } })
    } else if (activity === 'child-turn') peer.receive({ method: 'thread/started', params: { thread: { id: 'unopened-child', status: { type: 'active' } } } })
    else if (activity === 'internal-turn') {
      await f.bridge.request('thread/start', { ephemeral: true, threadSource: 'thread_title' })
      peer.receive({ method: 'turn/started', params: { threadId: 'internal-thread', turn: { id: 'title', status: 'inProgress' } } })
    } else if (activity === 'approval') peer.receive({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', itemId: 'item', turnId: 'turn' } })
    else { command = f.bridge.request('command/exec', activity === 'terminal' ? { processId: 'pty', tty: true, command: ['bash'] } : { command: ['sleep', '5'] }); command.catch(() => {}); await tick() }
    let prepared = 0
    await assert.rejects(f.bridge.reconnect(async () => { prepared++ }), error => (error as any).status === 409)
    assert.equal(f.peers.length, 1); assert.equal(peer.disposed, false); assert.equal(prepared, 0)
    assert.equal(f.bridge.reconnectStatus.canReconnect, false)
    f.bridge.close(); if (command) await command.catch(() => {})
  })
}

for (const state of ['active-child', 'unknown-state', 'background-terminal', 'unsupported-probe', 'during-probe'] as const) {
  test(`native preflight rejects ${state} without closing the original transport or changing configuration`, async t => {
    const f = fixture({ reply: (message, _index, peer) => {
      if (message.method === 'thread/loaded/list') {
        if (state === 'unsupported-probe') { queueMicrotask(() => peer.receive({ id: message.id, error: { code: -32601, message: 'unsupported' } })); return false }
        return { data: ['unopened-child'], nextCursor: null }
      }
      if (message.method === 'thread/read') {
        if (state === 'during-probe') queueMicrotask(() => peer.receive({ method: 'turn/started', params: { threadId: 'unopened-child', turn: { id: 'late', status: 'inProgress' } } }))
        return { thread: { id: 'unopened-child', status: { type: state === 'active-child' ? 'active' : state === 'unknown-state' ? 'unknown' : 'idle' } } }
      }
      if (message.method === 'thread/backgroundTerminals/list') return { data: state === 'background-terminal' ? [{ processId: 'training' }] : [], nextCursor: null }
    } }); t.after(() => f.bridge.close()); await f.bridge.connect()
    let prepared = 0
    await assert.rejects(f.bridge.reconnect(async () => { prepared++ }), error => (error as any).status === 409)
    assert.equal(f.peers.length, 1); assert.equal(f.peers[0]!.disposed, false); assert.equal(prepared, 0)
    assert.equal(f.bridge.connected, true)
    assert.equal(f.peers[0]!.sent.some(message => ['thread/resume', 'thread/archive', 'turn/interrupt', 'config/value/write'].includes(message.method || '')), false)
  })
}

test('concurrent reconnect coalesces, rejects new browser writes, and waits for the old transport to close', async t => {
  const f = fixture({ holdClose: true }); t.after(() => { for (const peer of f.peers) peer.releaseClose(); f.bridge.close() })
  const browser = new Browser(); f.bridge.attach('reader', browser.ws(), 'reader'); await f.bridge.connect()
  const first = f.bridge.reconnect(), second = f.bridge.reconnect()
  assert.equal(first, second)
  await tick(); assert.equal(f.peers[0]!.disposed, true); assert.equal(f.peers.length, 1)
  browser.request({ id: 'new-turn', method: 'turn/start', params: { threadId: 'old', input: [] } })
  await tick()
  assert.equal((browser.sent.find(message => message.id === 'new-turn')?.error?.data as any)?.code, 'runtime_reconnecting')
  f.peers[0]!.releaseClose(); await Promise.all([first, second])
  assert.equal(f.peers.length, 2); assert.equal(f.bridge.connected, true)
  assert.equal(f.peers.flatMap(peer => peer.sent).some(message => message.method === 'turn/start'), false)
})

test('proxy reconnect only disposes the owned proxy transport and has no archive, terminate or interrupt request', async t => {
  const f = fixture({ mode: 'proxy' }); t.after(() => f.bridge.close()); await f.bridge.connect()
  await f.bridge.reconnect()
  assert.equal(f.bridge.runtime.managed, false); assert.equal(f.peers.length, 2)
  assert.deepEqual(f.peers[0]!.sent.map(message => message.method), ['initialize', 'initialized', 'thread/loaded/list'])
  assert.equal(f.peers[0]!.disposed, true)
})

test('runtime configuration preparation runs only within the idle reservation before the replacement handshake', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); await f.bridge.connect()
  await f.bridge.reconnect(async request => {
    await assert.rejects(f.bridge.request('turn/start', {}), error => (error as any).code === 'runtime_reconnecting')
    await request('config/value/write', { keyPath: 'model_context_window', value: 500000 })
  })
  assert.equal(f.peers.length, 2)
  assert.equal(f.peers[0]!.sent.at(-1)?.method, 'config/value/write')
  assert.equal(f.peers[1]!.sent[0]?.method, 'initialize')
})

test('different configuration preparation cannot be swallowed by an in-flight reconnect', async t => {
  const f = fixture({ holdClose: true }); t.after(() => { for (const peer of f.peers) peer.releaseClose(); f.bridge.close() }); await f.bridge.connect()
  let firstWrite = 0, secondWrite = 0
  const first = f.bridge.reconnect(async request => { firstWrite++; await request('config/value/write', { value: 'first' }) })
  await tick()
  await assert.rejects(f.bridge.reconnect(async () => { secondWrite++ }), error => (error as any).status === 409)
  assert.equal(firstWrite, 1); assert.equal(secondWrite, 0)
  f.peers[0]!.releaseClose(); await first
})

test('a request that passed connect before maintenance cannot dispatch a late native mutation', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); await f.bridge.connect()
  const lateWrite = f.bridge.request('turn/start', { threadId: 'existing', input: [] })
  const rejected = assert.rejects(lateWrite, error => (error as any).code === 'runtime_reconnecting')
  await f.bridge.reconnect(); await rejected
  assert.equal(f.peers.flatMap(peer => peer.sent).some(message => message.method === 'turn/start'), false)
  assert.equal(f.peers.length, 2)
})

test('native device login maintenance keeps its transport alive and reserves the same idle guard', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); await f.bridge.connect()
  const engine = f.bridge.runtime.engineId
  await f.bridge.withRuntimeMaintenance(async request => {
    await assert.rejects(f.bridge.reconnect(), error => (error as any).status === 409)
    await assert.rejects(f.bridge.withRuntimeMaintenance(async () => {}), error => (error as any).status === 409)
    await request('account/login/start', { type: 'chatgptDeviceCode' })
  })
  assert.equal(f.peers.length, 1); assert.equal(f.peers[0]!.disposed, false); assert.equal(f.bridge.runtime.engineId, engine)
  assert.equal(f.peers[0]!.sent.at(-1)?.method, 'account/login/start')
  assert.equal(f.bridge.reconnectStatus.canReconnect, true)
  await assert.rejects(f.bridge.withRuntimeMaintenance(async () => { throw new Error('Fixture write failed') }), /Fixture write failed/)
  assert.equal(f.bridge.reconnectStatus.canReconnect, true)
})

test('late child activity cannot enter configuration preparation during an idle maintenance probe', async t => {
  const f = fixture({ reply: (message, _index, peer) => {
    if (message.method === 'thread/loaded/list') {
      queueMicrotask(() => peer.receive({ method: 'thread/started', params: { thread: { id: 'late-child', status: { type: 'active' } } } }))
      return { data: [], nextCursor: null }
    }
  } }); t.after(() => f.bridge.close()); await f.bridge.connect()
  let called = false
  await assert.rejects(f.bridge.withRuntimeMaintenance(async () => { called = true }), error => (error as any).status === 409)
  assert.equal(called, false); assert.equal(f.peers[0]!.disposed, false)
})

test('runtime information is authenticated, host-isolated, complete, sanitized and never starts disconnected hosts', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runtime-information-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const origin = 'http://localhost:8787', auth = new Auth('information-fixture', new Set([origin]))
  const remote: Host = { id: 'remote', kind: 'ssh', name: 'Remote', hostname: 'host.invalid' }
  const f = fixture({ host: remote, reply: (message, index) => {
    if (message.method === 'thread/loaded/list') { setTimeout(() => f.peers.at(-1)!.receive({ id: message.id, result: { data: [], nextCursor: null } }), 20); return false }
    if (message.method === 'model/list') return (message.params as any).cursor ? { data: [{ id: `new-${index}`, model: `new-${index}`, displayName: 'New', authToken: 'private-model-key' }], nextCursor: null } : { data: [{ id: `model-${index}`, model: `model-${index}` }], nextCursor: 'more' }
    if (message.method === 'config/read') return { config: { model: `model-${index}`, model_context_window: 500000, model_auto_compact_token_limit: 480000, model_providers: { auth: { key: 'private-gateway-key' } }, arbitrary_secret: 'secret' }, layers: ['private-layer'] }
  } }); t.after(() => f.bridge.close())
  const app = express(); app.use(express.json()); app.post('/api/auth/login', auth.login); app.use('/api', auth.requireAuth, auth.requireCsrf)
  const pausedHosts = new Set<string>(); let created = 0, reservations = 0
  registerHostResources(app, { dataDir: directory, pausedHosts, getHost: id => id === 'local' ? host : id === 'remote' ? remote : undefined,
    getBridge: async id => { created++; assert.equal(id, 'remote'); return f.bridge }, getExistingBridge: id => id === 'remote' ? f.bridge : undefined,
    withRuntimeMaintenance: async (id, work) => { assert.equal(id, 'remote'); reservations++; return work() } })
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof z.ZodError ? 400 : error.status || 500).json({ error: error.message }))
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'information-fixture' }) })
  const { csrfToken } = await login.json(), cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const headers = { origin, 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }
  const info = (id = 'remote') => fetch(`${base}/api/hosts/${id}/runtime/information`, { headers })
  const reconnect = (custom: Record<string, string> = headers, body: unknown = {}) => fetch(`${base}/api/hosts/remote/runtime/reconnect`, { method: 'POST', headers: custom, body: JSON.stringify(body) })
  assert.equal((await fetch(`${base}/api/hosts/remote/runtime/information`)).status, 401)
  assert.equal((await reconnect({ origin, 'content-type': 'application/json' })).status, 401)
  assert.equal((await reconnect({ origin, 'content-type': 'application/json', cookie })).status, 403)
  assert.equal((await reconnect(headers, { force: true })).status, 400)
  assert.equal((await info('missing')).status, 404)
  assert.equal((await (await info('local')).json()).models.length, 0)
  assert.equal((await (await info()).json()).runtime.connected, false)
  assert.equal(created, 0); assert.equal(f.peers.length, 0)
  await f.bridge.connect()
  const [first, duplicate] = await Promise.all([info(), info()])
  const value = await first.json(); assert.deepEqual(await duplicate.json(), value)
  assert.equal(value.runtime.userAgent, 'codex fixture/1'); assert.equal(value.canReconnect, true)
  assert.deepEqual(value.models.map((model: any) => model.id), ['model-1', 'new-1'])
  assert.deepEqual(value.config, { model: 'model-1', model_context_window: 500000, model_auto_compact_token_limit: 480000 })
  assert.doesNotMatch(JSON.stringify(value), /private-gateway-key|private-model-key|arbitrary_secret|private-layer/)
  assert.equal(f.peers[0]!.sent.filter(message => message.method === 'model/list').length, 2)
  assert.equal(f.peers[0]!.sent.filter(message => message.method === 'config/read').length, 1)
  const [reconnected, again] = await Promise.all([reconnect(), reconnect()])
  assert.equal(reconnected.status, 200); assert.equal(again.status, 200)
  assert.equal(reservations, 1); assert.equal(f.peers.length, 2); assert.equal(created, 1)
  assert.equal((await reconnected.json()).userAgent, 'codex fixture/2')
  assert.deepEqual((await (await info()).json()).models.map((model: any) => model.id), ['model-2', 'new-2'])
  await f.bridge.pause(); pausedHosts.add('remote')
  const paused = await (await info()).json()
  assert.equal(paused.runtime.paused, true); assert.deepEqual(paused.models, []); assert.equal(f.peers.length, 2)
  assert.equal(paused.canReconnect, false); assert.match(paused.reconnectDisabledReason, /资源管理/)
  assert.equal((await reconnect()).status, 409); assert.equal(pausedHosts.has('remote'), true)
  assert.equal(f.peers.length, 2); assert.equal(created, 1)
})

const spec: AutomationInput = { name: 'Fixture', hostId: 'local', cwd: '/fixture', prompt: 'Never dispatched in maintenance', model: 'fixture', effort: 'high', permission: 'read-only', timezone: 'UTC', cadence: { kind: 'interval', minutes: 5 }, enabled: true, maxRetries: 0 }
test('automation reservation blocks new runs and due dispatch only for the maintained host and releases on failure', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-reconnect-automations-')); let clock = 1000
  const service = new AutomationService(directory, { getHost: id => id === 'local' ? host : id === 'other' ? { ...host, id } : undefined, getBridge: async () => { throw new Error('Fixture does not execute model calls') }, now: () => clock })
  await service.initialize(false); t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const task = await service.put(spec), other = await service.put({ ...spec, hostId: 'other' })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  const maintenance = service.withHostRuntimeMaintenance('local', async () => { entered(); await gate; throw new Error('Fixture maintenance failed') })
  const rejection = assert.rejects(maintenance, /maintenance failed/); await ready
  await assert.rejects(service.runNow(task.id), error => (error as any).status === 409)
  await assert.rejects(service.withHostRuntimeMaintenance('local', async () => {}), error => (error as any).status === 409)
  clock += 5 * 60000; await service.tick(); await tick()
  assert.equal(service.list().runs.some(run => run.spec.hostId === 'local'), false)
  assert.equal(service.list().runs.some(run => run.automationId === other.id), true)
  release(); await rejection
  let enteredAgain = false
  await service.withHostRuntimeMaintenance('local', async () => { enteredAgain = true })
  assert.equal(enteredAgain, true)
  const run = await service.runNow(task.id)
  assert.equal(run.spec.hostId, 'local')
})
