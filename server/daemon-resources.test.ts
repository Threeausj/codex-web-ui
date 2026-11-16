import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import express from 'express'
import { z } from 'zod'
import { Auth } from './auth.js'
import { Bridge, type Transport } from './bridge.js'
import { registerHostResources, readRuntimePausedHosts, type RawHostResources } from './host-resources.js'
import type { Host, RpcMessage } from './types.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
type Peer = { sent: RpcMessage[]; receive(message: RpcMessage): void; disposed: boolean }
async function fixture(options: { mode?: Host['connectionMode']; unmanaged?: boolean; nativeActive?: boolean; queued?: boolean; automationBusy?: boolean; restartFailure?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-daemon-resources-'))
  const hosts: Host[] = [
    { id: 'local', name: 'Local fixture', kind: 'local', connectionMode: 'spawn' },
    { id: 'remote', name: 'Remote fixture', kind: 'ssh', hostname: 'never-contact.invalid', connectionMode: options.mode || 'daemon' },
  ]
  const bridges = new Map<string, Bridge>(), peers = new Map<string, Peer[]>()
  const daemonRestarts: { hostId: string; daemonHome?: string }[] = []
  const preparations: string[] = []
  const pausedHosts = new Set<string>()
  let holdRestart: (() => Promise<void>) | undefined
  const raw: RawHostResources = { sampledAt: 1, scope: 'host', cpu: { total: 1000, idle: 800, load: [0, 0, 0], cores: 4 }, memory: { usedBytes: 100, totalBytes: 1000 }, network: { rxBytes: 0, txBytes: 0, interfaces: [] }, disk: { readBytes: 0, writeBytes: 0 }, gpus: { available: false, devices: [] } }
  for (const host of hosts) {
    const collection: Peer[] = []; peers.set(host.id, collection)
    const bridge = new Bridge(host, {
      prepareDaemon: async selected => {
        preparations.push(selected.id)
        return { status: 'alreadyRunning', backend: options.unmanaged ? null : 'process', cliVersion: '0.165.0', appServerVersion: '0.165.0', managedCodexVersion: options.unmanaged ? null : '0.165.0' }
      },
      transportFactory: () => {
        const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter()
        let buffer = ''
        const peer: Peer = { sent: [], disposed: false, receive: message => { if (!peer.disposed) output.write(JSON.stringify(message) + '\n') } }
        collection.push(peer)
        const transport: Transport = { input, output, events, dispose() { peer.disposed = true; input.destroy(); output.destroy() } }
        input.on('data', chunk => {
          buffer += chunk.toString()
          let index: number
          while ((index = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, index)) as RpcMessage; buffer = buffer.slice(index + 1); peer.sent.push(message)
            if (message.id === undefined) continue
            if (message.method === 'command/exec' && (message.params as any)?.processId || message.method === 'fixture/pending') continue
            const params = message.params as any
            const result = message.method === 'initialize' ? { userAgent: 'codex_cli_rs/0.165.0', codexHome: `/fixture/${host.id}/.codex` }
              : message.method === 'model/list' ? { data: [{ id: 'model-a', model: 'model-a', displayName: 'Model A' }], nextCursor: null }
                : message.method === 'config/read' ? { config: { model: 'model-a', model_context_window: 500000 } }
                  : message.method === 'thread/loaded/list' ? { data: options.nativeActive || options.queued ? ['native-thread'] : [], nextCursor: null }
                    : ['thread/read', 'thread/resume'].includes(message.method || '') ? { thread: { id: params.threadId, name: 'Native task', ephemeral: false, status: { type: options.nativeActive ? 'active' : 'idle' } } }
                      : message.method === 'thread/queue/list' ? { data: options.queued ? [{ id: 'queued-input' }] : [], nextCursor: null }
                        : message.method === 'command/exec' ? { exitCode: 0, stdout: '{}' }
                          : { data: [], nextCursor: null }
            queueMicrotask(() => peer.receive({ id: message.id, result }))
          }
        })
        return transport
      },
    })
    bridges.set(host.id, bridge); await bridge.connect()
  }
  const origin = 'http://localhost:8787', auth = new Auth('daemon-resources-test', new Set([origin]))
  const received: string[] = []
  const app = express(); app.use(express.json()); app.post('/api/auth/login', auth.login); app.use('/api', auth.requireAuth, auth.requireCsrf)
  app.use('/api/hosts', (req, _res, next) => { if (req.method === 'POST') received.push(req.path); next() })
  registerHostResources(app, {
    dataDir: directory, pausedHosts,
    getHost: id => hosts.find(host => host.id === id), getExistingBridge: id => bridges.get(id), getBridge: async id => bridges.get(id)!,
    collect: async () => raw,
    withRuntimeMaintenance: async (_id, work) => { if (options.automationBusy) throw Object.assign(new Error('Fixture automation is running'), { status: 409 }); return work() },
    daemonRestart: async (host, settings) => {
      daemonRestarts.push({ hostId: host.id, daemonHome: settings.daemonHome })
      if (holdRestart) await holdRestart()
      if (options.restartFailure) throw new Error('Fixture daemon restart failed; verify the host state')
      return { status: 'restarted' }
    },
  })
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof z.ZodError ? 400 : error.status || 500).json({ error: error.message }))
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'daemon-resources-test' }) })
  const { csrfToken } = await login.json(), cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const headers = { origin, 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }
  const post = (action: string, body: unknown = {}, hostId = 'remote', custom: Record<string, string> = headers) => fetch(`${base}/api/hosts/${hostId}/runtime/${action}`, { method: 'POST', headers: custom, body: JSON.stringify(body) })
  const get = (action = 'runtime/information', hostId = 'remote') => fetch(`${base}/api/hosts/${hostId}/${action}`, { headers })
  return { post, get, base, headers, bridges, peers, daemonRestarts, preparations, directory, pausedHosts, received,
    setRestartHold(value?: () => Promise<void>) { holdRestart = value },
    async close() { for (const bridge of bridges.values()) bridge.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }); await fs.rm(directory, { recursive: true, force: true }) },
  }
}
const messages = (f: Awaited<ReturnType<typeof fixture>>, hostId = 'remote') => f.peers.get(hostId)!.flatMap(peer => peer.sent)

test('daemon restart requires authentication, CSRF and a strict explicit confirmation', async t => {
  const f = await fixture(); t.after(() => f.close())
  assert.equal((await f.post('daemon/restart', { confirmed: true }, 'remote', { origin: f.headers.origin, 'content-type': 'application/json' })).status, 401)
  assert.equal((await f.post('daemon/restart', { confirmed: true }, 'remote', { ...f.headers, 'x-csrf-token': '' })).status, 403)
  for (const body of [{}, { confirmed: false }, { confirmed: true, force: true }]) assert.equal((await f.post('daemon/restart', body)).status, 400)
  assert.equal((await f.post('daemon/restart', { confirmed: true }, 'missing')).status, 404)
  assert.deepEqual(f.daemonRestarts, [])
  assert.equal(f.peers.get('remote')!.length, 1)
})

test('confirmed idle daemon restart targets the selected account and creates a fresh transport without updating the CLI', async t => {
  const f = await fixture(); t.after(() => f.close())
  const before = await (await f.get()).json()
  assert.equal(before.canReconnect, true, JSON.stringify(before)); assert.equal(before.canRestartDaemon, true, JSON.stringify(before))
  const restarted = await f.post('daemon/restart', { confirmed: true })
  assert.equal(restarted.status, 200)
  const result = await restarted.json()
  assert.equal(result.ok, true); assert.equal(result.runtime.connectionMode, 'daemon'); assert.equal(result.runtime.connected, true)
  assert.notEqual(result.runtime.engineId, before.runtime.engineId)
  assert.deepEqual(f.daemonRestarts, [{ hostId: 'remote', daemonHome: '/fixture/remote/.codex' }])
  assert.equal(f.peers.get('remote')!.length, 2); assert.equal(f.peers.get('local')!.length, 1)
  assert.equal(f.peers.get('remote')![0]!.disposed, true)
  assert.equal(messages(f).some(message => ['turn/start', 'turn/interrupt', 'thread/archive', 'command/exec'].includes(message.method || '')), false)
})

for (const [name, options] of [
  ['spawn', { mode: 'spawn' }], ['external proxy', { mode: 'proxy' }], ['reused external native service', { unmanaged: true }],
] as const) {
  test(`daemon restart refuses ${name} without changing its transport or lifecycle`, async t => {
    const f = await fixture(options); t.after(() => f.close())
    const information = await (await f.get()).json()
    assert.equal(information.canRestartDaemon, false)
    if (options.unmanaged) {
      assert.equal(information.runtime.daemonLifecycleManaged, false); assert.equal(information.runtime.managed, false)
      assert.equal(information.canReconnect, true); assert.match(information.daemonRestartDisabledReason, /其他客户端|外部/)
    }
    assert.equal((await f.post('daemon/restart', { confirmed: true })).status, 409)
    assert.deepEqual(f.daemonRestarts, []); assert.equal(f.peers.get('remote')!.length, 1)
    assert.equal(f.peers.get('remote')![0]!.disposed, false)
  })
}

for (const activity of ['turn', 'approval', 'native', 'terminal', 'pending RPC', 'queued input', 'automation'] as const) {
  test(`explicit daemon restart refuses ${activity} before dispatching a lifecycle command`, async t => {
    const f = await fixture({ nativeActive: activity === 'native', queued: activity === 'queued input', automationBusy: activity === 'automation' }); t.after(() => f.close())
    const bridge = f.bridges.get('remote')!, peer = f.peers.get('remote')![0]!
    if (activity === 'turn') peer.receive({ method: 'thread/started', params: { thread: { id: 'active', status: { type: 'active' } } } })
    if (activity === 'approval') peer.receive({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'active' } })
    if (activity === 'terminal') void bridge.request('command/exec', { processId: 'terminal-fixture', tty: true, command: ['sh'] }).catch(() => {})
    if (activity === 'pending RPC') void bridge.request('fixture/pending', {}).catch(() => {})
    await tick()
    if (activity === 'turn' || activity === 'approval') assert.equal(bridge.reconnectStatus.canReconnect, true)
    const response = await f.post('daemon/restart', { confirmed: true })
    assert.equal(response.status, 409)
    assert.deepEqual(f.daemonRestarts, []); assert.equal(peer.disposed, false)
    assert.equal(f.peers.get('remote')!.length, 1)
  })
}

test('active daemon transport reconnection leaves native work running and never dispatches a daemon restart', async t => {
  const f = await fixture({ nativeActive: true }); t.after(() => f.close())
  const bridge = f.bridges.get('remote')!
  await bridge.request('thread/resume', { threadId: 'native-thread' })
  f.peers.get('remote')![0]!.receive({ id: 'question', method: 'item/tool/requestUserInput', params: { threadId: 'native-thread', questions: [{ id: 'q', question: 'Fixture choice?' }] } })
  const information = await (await f.get()).json()
  assert.equal(information.canReconnect, true); assert.equal(information.canRestartDaemon, false)
  const response = await f.post('reconnect')
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.runtime.connected, true); assert.equal(result.runtime.activeThreadCount, 1)
  assert.equal(f.peers.get('remote')!.length, 2)
  assert.deepEqual(f.daemonRestarts, [])
  assert.equal(messages(f).some(message => ['turn/start', 'turn/interrupt', 'thread/archive'].includes(message.method || '')), false)
})

test('daemon host pause is durable, leaves native tasks alone and cannot archive an individual writer', async t => {
  const f = await fixture({ nativeActive: true }); t.after(() => f.close())
  const bridge = f.bridges.get('remote')!
  await bridge.request('thread/resume', { threadId: 'native-thread' })
  assert.equal((await f.post('threads/native-thread/close', { confirmed: true })).status, 409)
  const response = await f.post('close', { confirmed: true })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.runtime.paused, true); assert.equal(result.runtime.connected, false)
  assert.deepEqual([...await readRuntimePausedHosts(f.directory)], ['remote'])
  assert.equal((await f.post('reconnect')).status, 409)
  assert.equal((await f.post('daemon/restart', { confirmed: true })).status, 409)
  assert.equal(f.peers.get('remote')!.length, 1)
  assert.deepEqual(f.daemonRestarts, [])
  assert.equal(messages(f).some(message => ['thread/archive', 'turn/interrupt', 'turn/start'].includes(message.method || '')), false)
})

test('duplicate confirmed restart requests share one lifecycle operation and failure is not automatically retried', { timeout: 10000 }, async t => {
  const f = await fixture({ restartFailure: true }); t.after(() => f.close())
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  f.setRestartHold(() => barrier)
  const first = f.post('daemon/restart', { confirmed: true })
  while (!f.daemonRestarts.length) await tick()
  const second = f.post('daemon/restart', { confirmed: true })
  while (f.received.length < 2) await tick()
  release()
  const responses = await Promise.all([first, second])
  assert.deepEqual(responses.map(response => response.status), [500, 500])
  assert.equal(f.daemonRestarts.length, 1)
  assert.equal(f.peers.get('remote')!.length, 1)
  await f.get(); await tick()
  assert.equal(f.daemonRestarts.length, 1)
})
