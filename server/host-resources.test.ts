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
