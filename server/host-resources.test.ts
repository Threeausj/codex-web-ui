import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import express from 'express'
import { z } from 'zod'
import { Auth } from './auth.js'
import { Bridge, type Transport } from './bridge.js'
import { HOST_RESOURCE_HELPER, collectHostResources, parseRawResources, readRuntimePausedHosts, registerHostResources, resourceRates, resourceSshArgs, type RawHostResources } from './host-resources.js'
import type { Host, RpcMessage } from './types.js'

const host: Host = { id: 'local', name: 'Fixture', kind: 'local' }
const raw = (sampledAt = 1000): RawHostResources => ({ sampledAt, scope: 'host', cpu: { total: 1000, idle: 800, load: [1, 2, 3], cores: 4 }, memory: { usedBytes: 250, totalBytes: 1000 }, network: { rxBytes: 100, txBytes: 200, interfaces: ['eth0'] }, disk: { readBytes: 300, writeBytes: 400 }, gpus: { available: false, devices: [], reason: 'Fixture has no GPU' } })

test('resource rates represent first samples, unavailable counters, resets and CPU/RAM accurately', () => {
  const initial = raw()
  const first = resourceRates('local', initial)
  assert.equal(first.cpu.usagePercent, null)
  assert.equal(first.memory.usagePercent, 25)
  assert.equal(first.network.rxBytesPerSecond, null)
  const next = raw(3000)
  next.cpu.total += 400; next.cpu.idle += 100; next.network.rxBytes! += 200; next.disk.writeBytes! += 1000
  const second = resourceRates('local', next, initial)
  assert.equal(second.cpu.usagePercent, 75)
  assert.equal(second.network.rxBytesPerSecond, 100)
  assert.equal(second.disk.writeBytesPerSecond, 500)
  const reset = raw(5000); reset.memory.totalBytes = null; reset.memory.usedBytes = null
  const afterReset = resourceRates('local', reset, next)
  assert.equal(afterReset.cpu.usagePercent, null)
  assert.equal(afterReset.network.rxBytesPerSecond, null)
  assert.equal(afterReset.memory.usagePercent, null)
  assert.throws(() => parseRawResources({ ...raw(), gpus: { available: true, devices: [{ index: 0, name: 'bad', utilizationPercent: Infinity }] } }))
})

test('resource SSH transport preserves explicit pinned-host policy and never interpolates code into the remote shell', () => {
  const args = resourceSshArgs({ id: 'remote', kind: 'ssh', name: 'Remote', hostname: 'host.test', username: 'user', port: 2222, identityFile: '/fixture/id key' }, { file: '/fixture/trusted key', hostKeyAlias: 'fixed-host' })
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('GlobalKnownHostsFile=/dev/null'))
  assert.ok(args.includes('HostKeyAlias=fixed-host'))
  assert.deepEqual(args.slice(-3), ['--', 'user@host.test', "exec /bin/sh -c 'exec python3 -'"])
  assert.ok(args.includes('/fixture/id key'))
  assert.ok(!args.some(value => value.includes('StrictHostKeyChecking=no')))
})

const python = spawnSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' })
const canRunHelper = process.platform === 'linux' && python.status === 0
test('Linux resource sampling survives unavailable, malformed and timed-out GPU queries', { skip: !canRunHelper, timeout: 10_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resources-gpu-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const binary = path.join(directory, 'nvidia-smi')
  const run = () => {
    const result = spawnSync(python.stdout.trim(), ['-c', HOST_RESOURCE_HELPER], { encoding: 'utf8', timeout: 4000, env: { ...process.env, PATH: `${directory}:/usr/bin:/bin` } })
    assert.equal(result.status, 0, result.stderr)
    return parseRawResources(JSON.parse(result.stdout))
  }
  await fs.writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "0, Fixture NVIDIA, 37, 1024, 8192, 52, [N/A]"\n', { mode: 0o700 })
  const valid = run()
  assert.equal(valid.gpus.devices[0]!.utilizationPercent, 37)
  assert.equal(valid.gpus.devices[0]!.memoryUsedBytes, 1024 * 1048576)
  assert.equal(valid.gpus.devices[0]!.powerWatts, null)
  await fs.writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "invalid-gpu-data"\n')
  const invalid = run()
  assert.equal(invalid.gpus.available, false)
  assert.match(invalid.gpus.reason!, /格式/)
  assert.ok(invalid.memory.totalBytes === null || invalid.memory.totalBytes > 0)
  await fs.writeFile(binary, '#!/bin/sh\nexec sleep 3\n')
  const timeout = run()
  assert.equal(timeout.gpus.available, false)
  assert.match(timeout.gpus.reason!, /超时/)
  const real = await collectHostResources(host)
  assert.ok(Number.isFinite(real.sampledAt))
  assert.ok(['host', 'container'].includes(real.scope))
})

function peer(acceptInitialize = true) {
  const input = new PassThrough(); const output = new PassThrough(); const events = new EventEmitter(); const sent: RpcMessage[] = []
  let disposed = false; let buffer = ''
  const transport: Transport = { input, output, events, dispose: () => { disposed = true; input.destroy(); output.destroy() } }
  input.on('data', chunk => {
    buffer += chunk.toString()
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at)) as RpcMessage; buffer = buffer.slice(at + 1); sent.push(message)
      if (message.id === undefined) continue
      const result = message.method === 'initialize' ? { userAgent: 'isolated-fixture' } : message.method === 'thread/resume' ? { thread: { id: 'owned-thread' } } : message.method === 'command/exec' ? { exitCode: 0, stdout: '{}' } : { status: 'unsubscribed' }
      queueMicrotask(() => { if (!disposed) output.write(`${JSON.stringify(message.method === 'initialize' && !acceptInitialize ? { id: message.id, error: { code: -32000, message: 'Fixture startup failure' } } : { id: message.id, result })}\n`) })
    }
  })
  return { transport, sent, get disposed() { return disposed } }
}

test('resources share one cached read while runtime close is authenticated, durable and prevents implicit reconnection', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resource-api-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const origin = 'http://localhost:8787'; const auth = new Auth('resource-fixture-password', new Set([origin]))
  const app = express(); app.use(express.json()); app.post('/api/auth/login', auth.login); app.use('/api', auth.requireAuth, auth.requireCsrf)
  const transports: ReturnType<typeof peer>[] = []
  let failNextInitialize = false
  const bridge = new Bridge(host, { transportFactory: () => { const entry = peer(!failNextInitialize); failNextInitialize = false; transports.push(entry); return entry.transport } })
  t.after(() => bridge.close())
  let created = 0; let samples = 0; let time = 0
  let release: ((value: RawHostResources) => void) | undefined
  const pausedHosts = new Set<string>()
  registerHostResources(app, { dataDir: directory, pausedHosts, getHost: id => id === 'local' ? host : undefined, getBridge: async () => { created++; return bridge }, getExistingBridge: () => bridge, now: () => time, collect: async () => { samples++; if (samples === 1) return new Promise(resolve => { release = resolve }); return raw(4000) } })
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error instanceof z.ZodError ? 400 : error.status || 500).json({ error: error.message }) })
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'resource-fixture-password' }) })
  const { csrfToken } = await login.json(); const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const headers = { origin, 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }
  const get = () => fetch(`${base}/api/hosts/local/resources`, { headers })
  const post = (action: string, body: unknown, custom: Record<string, string> = headers) => fetch(`${base}/api/hosts/local/runtime/${action}`, { method: 'POST', headers: custom, body: JSON.stringify(body) })
  assert.equal((await fetch(`${base}/api/hosts/local/resources`)).status, 401)
  assert.equal((await post('close', { confirmed: true }, { origin, 'content-type': 'application/json' })).status, 401)
  assert.equal((await post('close', { confirmed: true }, { origin, 'content-type': 'application/json', cookie })).status, 403)
  assert.equal((await post('close', { confirmed: false })).status, 400)
  await bridge.request('thread/resume', { threadId: 'owned-thread' })
  const first = get(); const second = get()
  while (!release) await new Promise<void>(resolve => setImmediate(resolve))
  release(raw())
  assert.deepEqual(await (await first).json(), await (await second).json())
  assert.equal(samples, 1)
  assert.equal(created, 0, 'Reading resources must not instantiate an engine')
  assert.equal((await get()).status, 200); assert.equal(samples, 1)
  time = 3001
  const refreshed = await (await get()).json(); assert.equal(samples, 2); assert.equal(refreshed.cpu.usagePercent, null)
  const closed = await (await post('close', { confirmed: true })).json()
  assert.equal(closed.runtime.paused, true); assert.equal(closed.runtime.connected, false)
  assert.equal(transports[0]!.disposed, true)
  assert.deepEqual(transports[0]!.sent.filter(message => message.method === 'thread/unsubscribe').map(message => message.params), [{ threadId: 'owned-thread' }])
  await assert.rejects(bridge.connect(), /已释放/)
  await assert.rejects(bridge.request('thread/list', {}), /已释放/)
  assert.equal(transports.length, 1)
  assert.equal((await (await get()).json()).runtime.paused, true)
  assert.equal(transports.length, 1)
  assert.deepEqual([...await readRuntimePausedHosts(directory)], ['local'])
  assert.equal((await fs.stat(path.join(directory, 'runtime-state.json'))).mode & 0o777, 0o600)
  assert.equal((await post('resume', {})).status, 200)
  assert.equal(transports.length, 2)
  assert.equal(bridge.connected, true); assert.equal(bridge.paused, false)
  assert.equal((await readRuntimePausedHosts(directory)).size, 0)
  assert.equal((await post('close', { confirmed: true })).status, 200)
  failNextInitialize = true
  assert.equal((await post('resume', {})).status, 500)
  assert.equal(bridge.paused, true, 'Failed explicit resume must not allow implicit reconnect to reclaim locks')
  assert.deepEqual([...await readRuntimePausedHosts(directory)], ['local'])
  await assert.rejects(bridge.request('thread/list', {}), /已释放/)
  assert.equal(transports.length, 3)
})

const codexBin = process.env.CODEX_BIN || 'codex'
const hasCodex = canRunHelper && spawnSync(codexBin, ['--version'], { stdio: 'ignore' }).status === 0
test('isolated real Web Codex releases native writer locks so another client can resume without killing that client', { skip: !hasCodex, timeout: 30_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-web-release-')); const home = path.join(directory, 'home'); await fs.mkdir(home)
  await fs.writeFile(path.join(home, 'config.toml'), 'model="offline-test"\nmodel_provider="offline-test"\n[model_providers.offline-test]\nname="No model calls"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n')
  const web = new Bridge(host, { codexBin, codexHome: home, cwd: directory })
  const desktop = new Bridge(host, { codexBin, codexHome: home, cwd: directory })
  t.after(async () => { await Promise.all([web.pause(), desktop.pause()]); web.close(); desktop.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const started = await web.request('thread/start', { cwd: directory, sandbox: 'danger-full-access', approvalPolicy: 'never', historyMode: 'paginated' }) as { thread: { id: string } }
  const threadId = started.thread.id
  await web.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Offline release fixture history' }] }] })
  await assert.rejects(desktop.request('thread/resume', { threadId, excludeTurns: true }), /active writer/)
  const webPid = web.runtime.pid; assert.ok(webPid)
  const desktopPid = desktop.runtime.pid; assert.ok(desktopPid)
  await web.pause()
  assert.equal(web.runtime.paused, true)
  assert.equal(web.runtime.connected, false)
  await assert.rejects(fs.stat(`/proc/${webPid}`), /ENOENT/)
  const resumed = await desktop.request('thread/resume', { threadId, excludeTurns: true }) as { thread: { id: string } }
  assert.equal(resumed.thread.id, threadId)
  assert.ok(await fs.stat(`/proc/${desktopPid}`))
  await assert.rejects(web.request('thread/resume', { threadId }), /已释放/)
  assert.equal(web.runtime.pid, undefined)
})

test('isolated session close releases one writer, preserves another writer and PID, and retains history', { skip: !hasCodex, timeout: 30_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-close-')); const home = path.join(directory, 'home'); await fs.mkdir(home)
  await fs.writeFile(path.join(home, 'config.toml'), 'model="offline-test"\nmodel_provider="offline-test"\n[model_providers.offline-test]\nname="No model calls"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n')
  const web = new Bridge(host, { codexBin, codexHome: home, cwd: directory }); const desktop = new Bridge(host, { codexBin, codexHome: home, cwd: directory })
  t.after(async () => { await Promise.all([web.pause(), desktop.pause()]); web.close(); desktop.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const threads: string[] = []
  for (const name of ['关闭测试会话', '保持连接的会话']) {
    const response = await web.request('thread/start', { cwd: directory }) as any
    threads.push(response.thread.id)
    await web.request('thread/inject_items', { threadId: response.thread.id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: name }] }] })
    await web.request('thread/name/set', { threadId: response.thread.id, name })
  }
  const [first, second] = threads as [string, string]; const pid = web.runtime.pid
  const journal: unknown[] = []; const persist = async () => { journal.push(JSON.parse(JSON.stringify([...web.releasedThreads]))) }
  await web.releaseThread(first, persist)
  assert.equal(web.runtime.pid, pid); assert.equal(web.connected, true); assert.equal(web.runtime.loadedThreadCount, 1)
  assert.equal(web.runtime.threads.find(thread => thread.id === first)?.released, true)
  assert.equal(web.runtime.threads.find(thread => thread.id === second)?.name, '保持连接的会话')
  assert.equal(web.releasedThreads.get(first)?.restoreThreadIds.length, 0)
  assert.ok(journal.length >= 2)
  await assert.rejects(web.request('thread/resume', { threadId: first }), /已关闭/)
  await assert.rejects(web.request('turn/start', { threadId: first, input: [] }), /已关闭/)
  const resumed = await desktop.request('thread/resume', { threadId: first, excludeTurns: true }) as any
  assert.equal(resumed.thread.name, '关闭测试会话')
  await assert.rejects(desktop.request('thread/resume', { threadId: second, excludeTurns: true }), /active writer/)
  const history = await desktop.request('thread/read', { threadId: first, includeTurns: true }) as any
  assert.match(JSON.stringify(history.thread), /关闭测试会话/)
  await web.reconnectThread(first, persist)
  await assert.rejects(web.request('thread/resume', { threadId: first }), /active writer/)
})

test('session close journals and restores descendants, blocks stale writes, and recovers partial restoration failures', async t => {
  const input = new PassThrough(), output = new PassThrough(); const methods: string[] = []; let buffer = ''; let failChild = true
  input.on('data', chunk => { buffer += chunk; let end: number; while ((end = buffer.indexOf('\n')) >= 0) {
    const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); if (request.id === undefined) continue
    const id = request.params?.threadId; methods.push(`${request.method}:${id || ''}`)
    let result: any = {}; let error: any
    if (request.method === 'thread/resume') result = { thread: { id, name: `Name ${id}` } }
    if (request.method === 'thread/list') result = { data: [{ id: 'child' }], nextCursor: null }
    if (request.method === 'thread/archive') for (const threadId of ['parent', 'child', 'late-child']) output.write(JSON.stringify({ method: 'thread/archived', params: { threadId } }) + '\n')
    if (request.method === 'thread/unarchive' && id === 'child' && failChild) error = { code: -32000, message: 'Fixture disk failure' }
    queueMicrotask(() => output.write(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }) + '\n'))
  } })
  const bridge = new Bridge(host, { transportFactory: () => ({ input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } }) }); t.after(() => bridge.close())
  await bridge.request('thread/resume', { threadId: 'parent' }); await bridge.request('thread/resume', { threadId: 'other' })
  const saved: any[] = []; const persist = async () => { saved.push(JSON.parse(JSON.stringify([...bridge.releasedThreads]))) }
  await assert.rejects(bridge.releaseThread('parent', persist), /disk failure/)
  assert.deepEqual(bridge.releasedThreads.get('parent')?.restoreThreadIds, ['child', 'late-child'])
  await assert.rejects(bridge.request('thread/resume', { threadId: 'parent' }), /已关闭/)
  await assert.rejects(bridge.request('turn/start', { threadId: 'child' }), /已关闭/)
  assert.equal(bridge.runtime.threads.find(thread => thread.id === 'other')?.loaded, true)
  assert.ok(saved.some(snapshot => snapshot[0]?.[1].restoreThreadIds.includes('late-child')))
  failChild = false; await bridge.reconnectThread('parent', persist)
  assert.equal(bridge.releasedThreads.size, 0)
  assert.ok(methods.includes('thread/unarchive:late-child'))
  assert.ok(!methods.some(method => method.includes('thread/unarchive:already-archived')))
  const fresh = new Bridge(host, {}, new Map([['parent', { name: 'Persistent released name', restoreThreadIds: [] }]])); t.after(() => fresh.close())
  assert.equal(fresh.runtime.threads[0]!.name, 'Persistent released name')
  await assert.rejects(bridge.releaseThread('unknown', persist), /没有由 Web/)
})

test('persisted session release journals restore history on startup without reacquiring its writer', async t => {
  const { createServer } = await import('./app.js')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-release-recovery-'))
  await fs.writeFile(path.join(directory, 'runtime-state.json'), JSON.stringify({ pausedHostIds: [], releasedThreads: [{ hostId: 'local', threadId: 'parent', name: '已释放会话', restoreThreadIds: ['parent', 'child'] }] }), { mode: 0o600 })
  const sent: any[] = []
  const context = await createServer({ dataDir: directory, codexHome: directory, cwd: directory, password: 'release-recovery-test', secureCookie: false, serveStatic: false, bridgeOptions: { transportFactory: () => {
    const input = new PassThrough(), output = new PassThrough(); let buffer = ''
    input.on('data', chunk => { buffer += chunk; let end: number; while ((end = buffer.indexOf('\n')) >= 0) { const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); sent.push(request); if (request.id !== undefined) queueMicrotask(() => output.write(JSON.stringify({ id: request.id, result: {} }) + '\n')) } })
    return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } }
  } } })
  t.after(async () => { await context.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const bridge = await context.getBridge('local')
  assert.deepEqual(sent.filter(request => request.method === 'thread/unarchive').map(request => request.params.threadId), ['parent', 'child'])
  assert.equal(bridge.runtime.threads[0]!.released, true)
  assert.equal(bridge.runtime.threads[0]!.name, '已释放会话')
  assert.equal(bridge.runtime.threads[0]!.loaded, false)
  await assert.rejects(bridge.request('thread/resume', { threadId: 'parent' }), /已关闭/)
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'runtime-state.json'), 'utf8'))
  assert.deepEqual(saved.releasedThreads[0].restoreThreadIds, [])
  assert.equal((await fs.stat(path.join(directory, 'runtime-state.json'))).mode & 0o777, 0o600)
  assert.ok(!sent.some(request => request.method === 'thread/archive' || request.method === 'thread/resume'))
})
