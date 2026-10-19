import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { Storage } from './storage.js'
import { createServer } from './app.js'
import { orderHosts } from '../shared/host-order.js'
import type { Transport } from './bridge.js'
import type { RpcMessage } from './types.js'

const ids = (storage: Storage) => storage.hosts.map(host => host.id)
const directory = () => fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-order-'))
const setupStorage = async (root: string) => {
  const storage = new Storage(root, path.join(root, 'home'), '/workspace')
  await storage.init()
  const a = await storage.addHost({ name: 'First', hostname: 'a.example' })
  const b = await storage.addHost({ name: 'Second', hostname: 'b.example' })
  return { storage, a, b }
}

test('host order applies saved entries and appends unknown/new hosts without mutating inputs', () => {
  const hosts = [{ id: 'local', name: 'Local' }, { id: 'a', name: 'First' }, { id: 'b', name: 'Second' }]
  const order = ['b', 'missing', 'b', 'local']
  const result = orderHosts(hosts, order)
  assert.deepEqual(result.map(host => host.id), ['b', 'local', 'a'])
  assert.equal(result[0], hosts[2])
  assert.deepEqual(hosts.map(host => host.id), ['local', 'a', 'b'])
  assert.deepEqual(order, ['b', 'missing', 'b', 'local'])
})

test('host presentation order survives restart privately and preserves SSH configuration', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage, a, b } = await setupStorage(root)
  const originalConfiguration = await fs.readFile(path.join(root, 'hosts.json'), 'utf8')
  const events: string[][] = []
  const unsubscribe = storage.subscribeHostOrder(hostIds => { events.push(hostIds) })
  await storage.reorderHosts({ hostIds: [b.id, 'local', a.id] })
  assert.deepEqual(ids(storage), [b.id, 'local', a.id])
  assert.deepEqual(events, [[b.id, 'local', a.id]])
  const file = path.join(root, 'host-order.json')
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { hostIds: [b.id, 'local', a.id] })
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700)
  assert.equal(await fs.readFile(path.join(root, 'hosts.json'), 'utf8'), originalConfiguration)
  const restored = new Storage(root); await restored.init()
  assert.deepEqual(restored.hosts, storage.hosts)
  unsubscribe()
  await storage.reorderHosts({ hostIds: [a.id, b.id, 'local'] })
  assert.equal(events.length, 1)
  assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), [])
})

test('a disabled local host keeps its slot while visible remote hosts are reordered', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage, a, b } = await setupStorage(root)
  await storage.reorderHosts({ hostIds: [a.id, 'local', b.id] })
  await storage.setLocalEnabled(false)
  assert.deepEqual(ids(storage), [a.id, b.id])
  await storage.reorderHosts({ hostIds: [b.id, a.id] })
  assert.deepEqual(ids(storage), [b.id, a.id])
  const restored = new Storage(root); await restored.init()
  assert.equal(restored.localEnabled, false)
  assert.deepEqual(ids(restored), [b.id, a.id])
  await restored.setLocalEnabled(true)
  assert.deepEqual(ids(restored), [b.id, 'local', a.id])
})

test('a maximum visible-host request retains the hidden local slot in a readable journal', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const hosts = Array.from({ length: 1000 }, (_, i) => ({ id: `ssh-${i.toString(16)}`, name: `Host ${i}`, hostname: `host-${i}.example`, kind: 'ssh' }))
  await fs.writeFile(path.join(root, 'hosts.json'), JSON.stringify(hosts))
  await fs.writeFile(path.join(root, 'local-host.json'), JSON.stringify({ enabled: false }))
  const storage = new Storage(root); await storage.init()
  const reversed = hosts.map(host => host.id).reverse()
  await storage.reorderHosts({ hostIds: reversed })
  const restored = new Storage(root); await restored.init()
  assert.deepEqual(ids(restored), reversed)
  await restored.setLocalEnabled(true)
  assert.deepEqual(ids(restored), ['local', ...reversed])
})

test('new hosts append after custom ordering and deleted IDs are pruned on the next save', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage, a, b } = await setupStorage(root)
  await storage.reorderHosts({ hostIds: [b.id, a.id, 'local'] })
  const c = await storage.addHost({ name: 'Third', hostname: 'c.example' })
  assert.deepEqual(ids(storage), [b.id, a.id, 'local', c.id])
  await storage.updateHost(a.id, { name: 'Renamed', port: 2222 })
  assert.deepEqual(ids(storage), [b.id, a.id, 'local', c.id])
  await storage.deleteHost(b.id)
  const restored = new Storage(root); await restored.init()
  assert.deepEqual(ids(restored), [a.id, 'local', c.id])
  await restored.reorderHosts({ hostIds: [c.id, a.id, 'local'] })
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'host-order.json'), 'utf8')), { hostIds: [c.id, a.id, 'local'] })
})

test('malformed order documents fail closed but nonexistent host IDs are ignored on restart', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { a, b } = await setupStorage(root)
  const file = path.join(root, 'host-order.json')
  for (const document of [null, [], {}, { hostIds: [] }, { hostIds: ['local', 'local'] }, { hostIds: ['local'], extra: true },
    { hostIds: ['local\n'] }, { hostIds: ['arbitrary'] }, { hostIds: Array(1001).fill('local') }]) {
    const text = JSON.stringify(document); await fs.writeFile(file, text)
    await assert.rejects(new Storage(root).init())
    assert.equal(await fs.readFile(file, 'utf8'), text)
  }
  await fs.writeFile(file, JSON.stringify({ hostIds: [b.id, 'ssh-deadbeef', 'local'] }))
  const storage = new Storage(root); await storage.init()
  assert.deepEqual(ids(storage), [b.id, 'local', a.id])
})

test('sort collection validation runs inside the shared host-write queue', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage, a, b } = await setupStorage(root)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const blocked = new Promise<void>(resolve => { entered = resolve })
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (source: string, target: string) => {
    if (target === path.join(root, 'hosts.json')) { entered(); await gate }
    return rename(source, target)
  })
  try {
    let events = 0; storage.subscribeHostOrder(() => { ++events })
    const adding = storage.addHost({ name: 'Concurrent', hostname: 'concurrent.example' })
    await blocked
    const stale = assert.rejects(storage.reorderHosts({ hostIds: [b.id, a.id, 'local'] }), { status: 409 })
    release()
    const [c] = await Promise.all([adding, stale])
    assert.deepEqual(ids(storage), ['local', a.id, b.id, c.id])
    assert.equal(events, 0)
    assert.equal(await fs.access(path.join(root, 'host-order.json')).then(() => true, () => false), false)
    await storage.reorderHosts({ hostIds: [c.id, b.id, a.id, 'local'] })
    assert.equal(events, 1)
    assert.deepEqual(ids(storage), [c.id, b.id, a.id, 'local'])
  } finally { release(); t.mock.restoreAll() }
})

test('failed atomic order writes do not reorder or notify and leave the queue usable', async t => {
  const root = await directory(); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { storage, a, b } = await setupStorage(root)
  await storage.reorderHosts({ hostIds: [a.id, b.id, 'local'] })
  const file = path.join(root, 'host-order.json'), previous = await fs.readFile(file, 'utf8')
  let events = 0; storage.subscribeHostOrder(() => { ++events })
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (source: string, target: string) => {
    if (target === file) throw new Error('Order disk failure')
    return rename(source, target)
  })
  try {
    await assert.rejects(storage.reorderHosts({ hostIds: [b.id, 'local', a.id] }), /Order disk failure/)
    assert.deepEqual(ids(storage), [a.id, b.id, 'local'])
    assert.equal(events, 0)
    assert.equal(await fs.readFile(file, 'utf8'), previous)
    assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), [])
    t.mock.restoreAll()
    storage.subscribeHostOrder(() => { throw new Error('Listener failure') })
    await storage.reorderHosts({ hostIds: [b.id, 'local', a.id] })
    assert.deepEqual(ids(storage), [b.id, 'local', a.id])
    assert.equal(events, 1)
  } finally { t.mock.restoreAll() }
})

const password = 'host-order-test-password-123'
async function login(base: string) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
  assert.equal(response.status, 200)
  const { csrfToken } = await response.json() as { csrfToken: string }
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json', 'x-csrf-token': csrfToken }
}
function transport(methods: string[]): Transport {
  const input = new PassThrough(), output = new PassThrough(); let buffer = ''
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, index)) as RpcMessage
      buffer = buffer.slice(index + 1); methods.push(message.method || '')
      if (message.id !== undefined) output.write(JSON.stringify({ id: message.id, result: { userAgent: 'host-order-test', codexHome: '/test' } }) + '\n')
    }
  })
  return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } }
}
async function serve(root: string, transportFactory: () => Transport = () => { throw new Error('Sorting must not start Codex') }) {
  const app = await createServer({ dataDir: root, cwd: root, codexHome: path.join(root, 'home'), password, secureCookie: false, serveStatic: false, bridgeOptions: { transportFactory } })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  return { app, base: 'http://127.0.0.1:' + (app.server.address() as { port: number }).port }
}
function nextFrame(ws: WebSocket, method: string, accepts: (frame: any) => boolean = () => true): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('Timed out waiting for ' + method)) }, 5000)
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()); if (frame.method !== method || !accepts(frame)) return
      clearTimeout(timer); ws.off('message', onMessage); resolve(frame)
    }
    ws.on('message', onMessage)
  })
}
async function connect(base: string, cookie: string, hostId: string, clientId: string) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/rpc?host=' + hostId + '&clientId=' + clientId, { headers: { cookie, origin: 'http://localhost:8787' } })
  const status = nextFrame(ws, 'bridge/status', frame => frame.params?.connected === true)
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  await status; return ws
}

test('host order HTTP route enforces auth, CSRF and complete strict input without opening Codex', async t => {
  const root = await directory(), { app, base } = await serve(root)
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }) })
  const headers = await login(base)
  const write = (body: unknown, supplied = headers) => fetch(base + '/api/hosts/order', { method: 'PATCH', headers: supplied, body: JSON.stringify(body) })
  assert.equal((await write({ hostIds: ['local'] }, { 'content-type': 'application/json' } as any)).status, 401)
  assert.equal((await write({ hostIds: ['local'] }, { cookie: headers.cookie, 'content-type': 'application/json' } as any)).status, 403)
  assert.equal((await write({ hostIds: ['local'] }, { ...headers, origin: 'https://attacker.invalid' })).status, 403)
  for (const body of [{}, { hostIds: [] }, { hostIds: ['local', 'local'] }, { hostIds: [''] }, { hostIds: ['local\n'] },
    { hostIds: ['arbitrary'] }, { hostIds: ['local'], hostname: 'injected.example' }, { hostIds: Array(1001).fill('local') }])
    assert.equal((await write(body)).status, 400)
  assert.equal((await write({ hostIds: ['ssh-deadbeef'] })).status, 409)
  const add = await fetch(base + '/api/hosts', { method: 'POST', headers, body: JSON.stringify({ name: 'Remote', hostname: 'remote.example' }) })
  assert.equal(add.status, 201)
  const added = await add.json() as { host: { id: string }; hosts: { id: string }[] }
  assert.deepEqual(added.hosts.map(host => host.id), ['local', added.host.id])
  assert.equal((await write({ hostIds: ['local'] })).status, 409)
  const ordered = await write({ hostIds: [added.host.id, 'local'] })
  assert.equal(ordered.status, 200, 'static /order route is not parsed as an editable host ID')
  assert.deepEqual((await ordered.json() as { hosts: { id: string }[] }).hosts.map(host => host.id), [added.host.id, 'local'])
  for (const endpoint of ['/api/hosts', '/api/bootstrap']) {
    const result = await fetch(base + endpoint, { headers })
    assert.deepEqual((await result.json() as { hosts: { id: string }[] }).hosts.map(host => host.id), [added.host.id, 'local'])
    assert.equal(result.headers.get('cache-control'), 'no-store')
  }
  assert.equal(app.bridges.size, 0)
})

test('successful host reorder reaches authenticated devices across hosts without native RPC or reconnection', async t => {
  const root = await directory(), methods: string[] = []
  let transports = 0
  const { app, base } = await serve(root, () => { ++transports; return transport(methods) })
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }) })
  const remote = await app.storage.addHost({ name: 'Remote', hostname: 'remote.example' })
  const first = await login(base), second = await login(base)
  const a = await connect(base, first.cookie, 'local', 'first_device'), b = await connect(base, second.cookie, remote.id, 'second_device')
  t.after(() => { a.terminate(); b.terminate() })
  const beforeMethods = [...methods], beforeBridges = [...app.bridges.values()], beforeTransports = transports
  const frameA = nextFrame(a, 'bridge/host-order/changed'), frameB = nextFrame(b, 'bridge/host-order/changed')
  const response = await fetch(base + '/api/hosts/order', { method: 'PATCH', headers: first, body: JSON.stringify({ hostIds: [remote.id, 'local'] }) })
  assert.equal(response.status, 200)
  for (const frame of await Promise.all([frameA, frameB])) assert.deepEqual(frame.params, { hostIds: [remote.id, 'local'] })
  assert.deepEqual(methods, beforeMethods)
  assert.equal(transports, beforeTransports)
  assert.deepEqual([...app.bridges.values()], beforeBridges)
  assert.equal(a.readyState, WebSocket.OPEN); assert.equal(b.readyState, WebSocket.OPEN)
})
