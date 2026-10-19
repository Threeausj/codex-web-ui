import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { createServer } from './app.js'
import { Storage } from './storage.js'
import { AutomationService } from './automations.js'
import type { Host, RpcMessage } from './types.js'
import type { Transport } from './bridge.js'

function peer(host: Host) {
  const input = new PassThrough(), output = new PassThrough()
  const sent: RpcMessage[] = []
  let buffer = '', disposed = 0
  const held = new Set<string>()
  let loaded: string[] = [], nativeActive = false
  const receive = (message: RpcMessage) => output.write(`${JSON.stringify(message)}\n`)
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, index)) as RpcMessage
      buffer = buffer.slice(index + 1)
      sent.push(message)
      if (message.id === undefined || held.has(message.method!)) continue
      const result = message.method === 'thread/loaded/list' ? { data: loaded, nextCursor: null }
        : message.method === 'thread/read' ? { thread: { id: (message.params as any)?.threadId, status: { type: nativeActive ? 'active' : 'idle' } } }
        : message.method === 'thread/backgroundTerminals/list' ? { data: [], nextCursor: null }
        : message.method === 'config/read' ? { config: {} } : {}
      queueMicrotask(() => receive({ id: message.id, result }))
    }
  })
  const transport: Transport = { input, output, events: new EventEmitter(), dispose: () => { disposed++; input.destroy(); output.destroy() } }
  return { host, transport, sent, receive, held, get disposed() { return disposed }, setLoaded(ids: string[], active = false) { loaded = ids; nativeActive = active } }
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-optional-local-'))
  const peers: ReturnType<typeof peer>[] = []
  const application = await createServer({ dataDir: directory, codexHome: path.join(directory, 'home'), cwd: '/workspace', password: 'optional-local-test-password-123', serveStatic: false, secureCookie: false,
    bridgeOptions: { transportFactory: host => { const value = peer(host); peers.push(value); return value.transport } } })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'optional-local-test-password-123' }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const { csrfToken } = await login.json() as { csrfToken: string }
  const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }
  const request = (url: string, method = 'GET', body?: unknown) => fetch(base + url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { directory, application, peers, base, cookie, headers, request,
    async close() { await application.close(); await fs.rm(directory, { recursive: true, force: true }) } }
}

test('local execution is optional across restart, with its project settings retained through SSH writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-optional-local-storage-'))
  try {
    const storage = new Storage(directory, path.join(directory, 'home'), '/workspace')
    await storage.init()
    assert.equal(storage.localEnabled, true)
    await storage.addProject('local', '/project', 'Saved local project')
    const remote = await storage.addHost({ name: 'Remote', hostname: 'remote.fixture' })
    await storage.addProject(remote.id, '/remote')
    await storage.setLocalEnabled(false)
    assert.equal(storage.host('local'), undefined)
    assert.deepEqual(storage.hosts.map(host => host.id), [remote.id])
    assert.equal((await storage.projects()).some(project => project.hostId === 'local'), false)
    await storage.updateHost(remote.id, { name: 'Updated remote' })
    const restored = new Storage(directory, path.join(directory, 'home'), '/workspace')
    await restored.init()
    assert.equal(restored.localEnabled, false)
    assert.equal(restored.host('local'), undefined)
    assert.equal(restored.host(remote.id)?.name, 'Updated remote')
    await restored.setLocalEnabled(true)
    assert.ok(restored.host('local'))
    assert.equal((await restored.projects()).find(project => project.path === '/project')?.name, 'Saved local project')
    assert.equal((await fs.stat(path.join(directory, 'local-host.json'))).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'hosts.json'), 'utf8')).some((host: Host) => host.id === 'local'), false)
    await assert.rejects(restored.deleteHost('local'), { status: 400 })
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('failed optional-local persistence keeps the node available and later changes succeed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-optional-local-write-'))
  const storage = new Storage(directory)
  await storage.init()
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (source: string, target: string) => {
    if (target === path.join(directory, 'local-host.json')) throw new Error('Disk failure')
    return rename(source, target)
  })
  try {
    await assert.rejects(storage.setLocalEnabled(false), /Disk failure/)
    assert.equal(storage.localEnabled, true)
    assert.ok(storage.host('local'))
    assert.equal((await fs.readdir(directory)).some(file => file.endsWith('.tmp')), false)
    t.mock.restoreAll()
    await storage.setLocalEnabled(false)
    assert.equal(storage.localEnabled, false)
  } finally { t.mock.restoreAll(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('local disable requires authentication and CSRF and an empty host list still supports adding SSH', async () => {
  const f = await fixture()
  try {
    const endpoint = '/api/hosts/local/enabled'
    assert.equal((await fetch(f.base + endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' })).status, 401)
    assert.equal((await fetch(f.base + endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: f.cookie }, body: '{"enabled":false}' })).status, 403)
    assert.equal((await f.request(endpoint, 'PATCH', { enabled: 'false' })).status, 400)
    assert.equal((await f.request(endpoint, 'PATCH', { enabled: false, codexPath: '/bad' })).status, 400)
    assert.equal((await f.request(endpoint, 'PATCH', { enabled: false })).status, 200)
    const bootstrap = await (await f.request('/api/bootstrap')).json() as any
    assert.equal(bootstrap.localEnabled, false)
    assert.deepEqual(bootstrap.hosts, [])
    assert.deepEqual(bootstrap.projects, [])
    assert.deepEqual(await (await f.request('/api/hosts')).json(), { localEnabled: false, hosts: [], projects: [] })
    await assert.rejects(f.application.getBridge('local'), { status: 404 })
    assert.equal(f.peers.length, 0, 'Disabled local execution must never launch a native process')
    const saved = await f.request('/api/hosts', 'POST', { name: 'Remote', hostname: 'remote.fixture' })
    assert.equal(saved.status, 201)
    const { host } = await saved.json() as { host: Host }
    assert.deepEqual(f.application.storage.hosts.map(host => host.id), [host.id])
    assert.equal((await f.request(endpoint, 'PATCH', { enabled: true })).status, 200)
    assert.equal(f.peers.length, 0, 'Re-enabling a node does not automatically connect Codex')
    assert.ok(f.application.storage.host('local'))
  } finally { await f.close() }
})

test('disabling the idle local bridge notifies other tabs and leaves the SSH runtime connected', async () => {
  const f = await fixture()
  let socket: WebSocket | undefined
  try {
    const remote = await f.application.storage.addHost({ name: 'Remote', hostname: 'remote.fixture' })
    const remoteBridge = await f.application.getBridge(remote.id)
    await remoteBridge.connect()
    socket = new WebSocket(f.base.replace('http:', 'ws:') + '/api/rpc?host=local&clientId=optional_local_tab', { headers: { cookie: f.cookie, origin: 'http://localhost:8787' } })
    const messages: RpcMessage[] = []
    await new Promise<void>((resolve, reject) => {
      socket!.on('message', value => { const message = JSON.parse(value.toString()); messages.push(message); if (message.method === 'bridge/status' && message.params.connected) resolve() })
      socket!.once('error', reject)
    })
    const localPeer = f.peers.find(value => value.host.id === 'local')!
    const closed = new Promise<{ code: number; reason: string }>(resolve => socket!.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    assert.equal((await f.request('/api/hosts/local/enabled', 'PATCH', { enabled: false })).status, 200)
    assert.deepEqual(await closed, { code: 4004, reason: 'Host execution disabled' })
    assert.deepEqual(messages.find(message => message.method === 'bridge/host-disabled')?.params, { hostId: 'local' })
    assert.equal(localPeer.disposed, 1)
    assert.equal(f.application.bridges.has('local'), false)
    assert.equal(remoteBridge.connected, true)
    assert.equal(f.peers.find(value => value.host.id === remote.id)?.disposed, 0)
  } finally { socket?.terminate(); await f.close() }
})

test('a failed disabled-state commit leaves the connected local runtime and its native writes usable', async t => {
  const f = await fixture()
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (source: string, target: string) => {
    if (target === path.join(f.directory, 'local-host.json')) throw new Error('Disk unavailable')
    return rename(source, target)
  })
  try {
    const bridge = await f.application.getBridge('local')
    await bridge.connect()
    assert.equal((await f.request('/api/hosts/local/enabled', 'PATCH', { enabled: false })).status, 500)
    assert.equal(f.application.storage.localEnabled, true)
    assert.equal(bridge.connected, true)
    assert.equal(f.peers[0]?.disposed, 0)
    assert.equal(await f.application.getBridge('local'), bridge)
    assert.deepEqual(await bridge.request('config/read', {}), { config: {} })
    assert.ok((await (await f.request('/api/bootstrap')).json() as any).hosts.some((host: Host) => host.id === 'local'))
  } finally { t.mock.restoreAll(); await f.close() }
})

test('a saved zero-node server starts and serves login/bootstrap without launching local Codex', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-optional-local-startup-'))
  const storage = new Storage(directory, path.join(directory, 'home'), '/workspace')
  await storage.init()
  await storage.setLocalEnabled(false)
  let launches = 0
  const application = await createServer({ dataDir: directory, codexHome: path.join(directory, 'home'), cwd: '/workspace', password: 'optional-local-startup-password-123', serveStatic: false, secureCookie: false,
    bridgeOptions: { transportFactory: () => { launches++; throw new Error('No local Codex installed') } } })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  try {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'optional-local-startup-password-123' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const response = await fetch(base + '/api/bootstrap', { headers: { cookie } })
    assert.equal(response.status, 200)
    const bootstrap = await response.json() as any
    assert.equal(bootstrap.localEnabled, false)
    assert.deepEqual(bootstrap.hosts, [])
    assert.deepEqual(bootstrap.projects, [])
    assert.equal(application.bridges.size, 0)
    assert.equal(launches, 0)
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

for (const busy of ['turn', 'approval', 'terminal', 'native-child'] as const) test(`local disable refuses a busy ${busy} without terminating its runtime`, async () => {
  const f = await fixture()
  try {
    const bridge = await f.application.getBridge('local')
    await bridge.connect()
    const native = f.peers[0]!
    if (busy === 'turn') native.receive({ method: 'turn/started', params: { threadId: 'active', turn: { id: 'turn', status: 'inProgress' } } })
    if (busy === 'approval') native.receive({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'waiting', turnId: 'turn', itemId: 'item', command: 'example' } })
    if (busy === 'terminal') { native.held.add('command/exec'); void bridge.request('command/exec', { processId: 'terminal', command: ['/bin/sh'], tty: true }).catch(() => {}); await new Promise<void>(resolve => setImmediate(resolve)) }
    if (busy === 'native-child') native.setLoaded(['child'], true)
    const response = await f.request('/api/hosts/local/enabled', 'PATCH', { enabled: false })
    assert.equal(response.status, 409)
    assert.equal(f.application.storage.localEnabled, true)
    assert.equal(bridge.connected, true)
    assert.equal(native.disposed, 0)
    assert.equal(await fs.access(path.join(f.directory, 'local-host.json')).then(() => true, () => false), false)
  } finally { await f.close() }
})

test('retiring the local node reserves native writes while its disabled state is being committed', async t => {
  const f = await fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const writing = new Promise<void>(resolve => { entered = resolve })
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (source: string, target: string) => {
    if (target === path.join(f.directory, 'local-host.json')) { entered(); await gate }
    return rename(source, target)
  })
  try {
    const bridge = await f.application.getBridge('local')
    await bridge.connect()
    const disabling = f.request('/api/hosts/local/enabled', 'PATCH', { enabled: false })
    await writing
    await assert.rejects(bridge.request('turn/start', { threadId: 'race', input: [] }), { status: 409 })
    await assert.rejects(f.application.getBridge('local'), { status: 409 })
    assert.equal((await f.request('/api/hosts/local/enabled', 'PATCH', { enabled: true })).status, 409)
    release()
    assert.equal((await disabling).status, 200)
    assert.equal(f.peers[0]!.sent.some(message => message.method === 'turn/start'), false)
    assert.equal(f.peers[0]!.disposed, 1)
  } finally { release(); t.mock.restoreAll(); await f.close() }
})

test('disabled local schedules retain their next occurrence without reconnecting or producing failed runs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-optional-local-schedule-'))
  let enabled = true, connects = 0, now = Date.parse('2026-10-18T00:00:00Z')
  const host: Host = { id: 'local', kind: 'local', name: 'Local fixture' }
  const service = new AutomationService(directory, {
    now: () => now, getHost: () => enabled ? host : undefined,
    getBridge: async () => ({ paused: false, runtime: { engineId: 'fixture' }, connect: async () => { connects++ },
      request: async (method: string) => method === 'thread/start' ? { thread: { id: 'scheduled-thread' } } : method === 'turn/start' ? { turn: { id: 'scheduled-turn', status: 'inProgress' } } : {},
    }) as any,
  })
  try {
    await service.initialize(false)
    const task = await service.put({ name: 'Saved schedule', hostId: 'local', cwd: '/workspace', prompt: 'Read the project', model: 'fixture', effort: 'high', permission: 'read-only', timezone: 'Asia/Shanghai', cadence: { kind: 'interval', minutes: 5 }, enabled: true, maxRetries: 0 })
    enabled = false
    now += 10 * 60000
    await service.tick()
    assert.equal(connects, 0)
    assert.equal(service.list().runs.length, 0)
    assert.equal(service.list().tasks[0]?.nextAt, task.nextAt)
    await assert.rejects(service.runNow(task.id), { status: 409 })
    enabled = true
    await service.tick()
    await Promise.all((service as any).operations.values())
    assert.equal(connects, 1)
    assert.equal(service.list().runs.length, 1)
    service.observe(host, { method: 'turn/completed', params: { threadId: 'scheduled-thread', turn: { id: 'scheduled-turn', status: 'completed' } } })
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
