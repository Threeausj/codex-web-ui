import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SshConnectionPool, sshConnectionIdentity } from './ssh-pool.js'
import { sshAppServerArgs, sshKnownHostsArgs, sshPythonArgs } from './ssh.js'
import type { Host } from './types.js'

const host: Host = { id: 'remote-a', name: 'SSH target', kind: 'ssh', hostname: 'example.invalid', username: 'reader' }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(options: { identity?: (value: Host) => Promise<string>; idleMs?: number; maximumConnections?: number } = {}) {
  const masters: { hostId: string; ready: ReturnType<typeof deferred<void>>; closed: ReturnType<typeof deferred<void>>; closes: number }[] = []
  const pool = new SshConnectionPool({ idleMs: options.idleMs ?? 60000, maximumConnections: options.maximumConnections, identity: options.identity || (async value => value.id), start(value) {
    const master = { hostId: value.id, ready: deferred<void>(), closed: deferred<void>(), closes: 0 }
    masters.push(master)
    master.ready.resolve()
    return { ready: master.ready.promise, closed: master.closed.promise, close() { master.closes++; master.closed.resolve() } }
  } })
  return { pool, masters }
}

test('concurrent features share one SSH master and releasing one channel preserves all other channels', async () => {
  const { pool, masters } = fixture()
  try {
    const leases = await Promise.all(Array.from({ length: 20 }, () => pool.acquire(host)))
    assert.equal(masters.length, 1)
    assert.equal(new Set(leases.map(lease => lease.control.socketPath)).size, 1)
    assert.deepEqual(pool.status(), { transports: 1, leasedChannels: 20 })
    const directory = path.dirname(leases[0]!.control.socketPath)
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
    leases[0]!.release(); leases[0]!.release()
    assert.deepEqual(pool.status(), { transports: 1, leasedChannels: 19 })
    assert.equal(masters[0]!.closes, 0)
    for (const lease of leases.slice(1)) lease.release()
    const reuse = await pool.acquire(host)
    assert.equal(masters.length, 1)
    reuse.release()
  } finally { await pool.close() }
  assert.equal(masters[0]!.closes, 1)
});

test('different concurrent hosts reserve SSH pool capacity after asynchronous directory initialization', async () => {
  const { pool, masters } = fixture({ maximumConnections: 1 })
  try {
    const results = await Promise.allSettled([pool.acquire(host), pool.acquire({ ...host, id: 'another' })])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(masters.length, 1)
    for (const result of results) if (result.status === 'fulfilled') result.value.release()
    else assert.equal(result.reason.status, 429)
  } finally { await pool.close() }
});

test('SSH credential or pin changes create a fresh connection without killing an active old channel', async () => {
  let identity = 'trusted-old'
  const { pool, masters } = fixture({ identity: async () => identity })
  try {
    const old = await pool.acquire(host)
    identity = 'trusted-new'
    const current = await pool.acquire(host)
    assert.notEqual(old.control.socketPath, current.control.socketPath)
    assert.equal(masters.length, 2)
    assert.equal(masters[0]!.closes, 0)
    old.release()
    await Promise.resolve()
    assert.equal(masters[0]!.closes, 1)
    assert.equal(masters[1]!.closes, 0)
    current.release()
  } finally { await pool.close() }
});

test('host removal closes only that host and invalidates its queued background probes', async () => {
  const { pool, masters } = fixture()
  const other = { ...host, id: 'remote-b' }
  try {
    const a = await pool.acquire(host), b = await pool.acquire(other)
    const running = deferred<void>()
    const first = pool.runBackground(host, () => running.promise)
    await Promise.resolve()
    let started = false
    const queued = assert.rejects(pool.runBackground(host, async () => { started = true }), /已关闭/)
    pool.closeHost(host.id)
    await Promise.resolve()
    assert.equal(masters[0]!.closes, 1)
    assert.equal(masters[1]!.closes, 0)
    running.resolve()
    await Promise.all([first, queued])
    assert.equal(started, false)
    a.release(); b.release()
  } finally { await pool.close() }
});

test('idle SSH masters expire while leased channels stay connected', async () => {
  const { pool, masters } = fixture({ idleMs: 15 })
  try {
    const idle = await pool.acquire(host), active = await pool.acquire({ ...host, id: 'active' })
    idle.release()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(masters[0]!.closes, 1)
    assert.equal(masters[1]!.closes, 0)
    active.release()
  } finally { await pool.close() }
});

test('failed SSH handshakes are evicted and a later explicit action can reconnect', async () => {
  let attempts = 0
  const pool = new SshConnectionPool({ identity: async value => value.id, start() {
    const closed = deferred<void>(), fail = ++attempts === 1
    return { ready: fail ? Promise.reject(new Error('isolated handshake failure')) : Promise.resolve(), closed: closed.promise, close() { closed.resolve() } }
  } })
  try {
    await assert.rejects(pool.acquire(host), /handshake failure/)
    assert.equal(pool.status().transports, 0)
    const next = await pool.acquire(host)
    assert.equal(attempts, 2)
    next.release()
  } finally { await pool.close() }
});

test('background collection serializes per host and never delays interactive SSH acquisition', async () => {
  const { pool } = fixture(), first = deferred<void>()
  const order: string[] = []
  try {
    const a = pool.runBackground(host, async () => { order.push('first'); await first.promise; order.push('first done') })
    const b = pool.runBackground(host, async () => { order.push('second') })
    await Promise.resolve()
    const interactive = await pool.acquire(host)
    order.push('interactive')
    assert.deepEqual(order, ['first', 'interactive'])
    first.resolve()
    await Promise.all([a, b])
    assert.deepEqual(order, ['first', 'interactive', 'first done', 'second'])
    interactive.release()
  } finally { await pool.close() }
});

test('failed background probes back off without automatically repeating commands or blocking user actions', async () => {
  const { pool } = fixture()
  let calls = 0
  try {
    await assert.rejects(pool.runBackground(host, async () => { ++calls; throw new Error('network down') }), /network down/)
    await assert.rejects(pool.runBackground(host, async () => { ++calls }), error => (error as any).code === 'SSH_BACKGROUND_BACKOFF')
    assert.equal(calls, 1)
    const interactive = await pool.acquire(host)
    interactive.release()
  } finally { await pool.close() }
});

test('shutdown supersedes an acquisition still resolving its identity', async () => {
  const identity = deferred<string>(), { pool, masters } = fixture({ identity: () => identity.promise })
  const acquisition = assert.rejects(pool.acquire(host), /状态已变化/)
  await pool.close()
  identity.resolve('old')
  await acquisition
  assert.equal(masters.length, 0)
  await assert.rejects(pool.acquire(host), /连接池已关闭/)
  await assert.rejects(pool.runBackground(host, async () => {}), /连接池已关闭/)
  await pool.close()
});

test('removing a host supersedes its pending identity lookup without affecting other hosts', async () => {
  const identity = deferred<string>()
  const { pool, masters } = fixture({ identity: value => value.id === host.id ? identity.promise : Promise.resolve(value.id) })
  try {
    const acquisition = assert.rejects(pool.acquire(host), /状态已变化/)
    pool.closeHost(host.id)
    identity.resolve('stale removed host')
    await acquisition
    assert.equal(masters.length, 0)
    const other = await pool.acquire({ ...host, id: 'unaffected' })
    other.release()
    assert.equal(masters.length, 1)
  } finally { await pool.close() }
});

test('returning to an older credential identity still creates a fresh master and shutdown closes retired channels', async () => {
  let identity = 'one'
  const { pool, masters } = fixture({ identity: async () => identity })
  const old = await pool.acquire(host)
  identity = 'two'
  const newer = await pool.acquire(host)
  identity = 'one'
  const restored = await pool.acquire(host)
  assert.equal(masters.length, 3)
  assert.notEqual(restored.control.socketPath, old.control.socketPath)
  await pool.close()
  assert.ok(masters.every(master => master.closes === 1))
  old.release(); newer.release(); restored.release()
});

test('pooled channel argv retains strict pinned trust and overrides external multiplexing settings', () => {
  const pin = { file: '/private/known hosts', hostKeyAlias: 'web-pinned' }, control = { socketPath: '/private/cwssh/master' }
  for (const args of [sshAppServerArgs(host, 'spawn', false, pin, control), sshPythonArgs(host, pin, control)]) {
    assert.ok(args.includes('StrictHostKeyChecking=yes'))
    assert.ok(args.includes('GlobalKnownHostsFile=/dev/null'))
    assert.ok(args.includes('KnownHostsCommand=none'))
    assert.ok(args.includes('ControlPath=' + control.socketPath))
    assert.ok(args.includes('ControlMaster=no'))
    assert.ok(!args.includes('ControlPath=none'))
    assert.ok(args.includes('HostKeyAlias=web-pinned'))
  }
  assert.ok(sshKnownHostsArgs().includes('ControlPath=none'))
});

test('SSH identity includes actual private key and confirmed host-key contents, not cosmetic host labels', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-pool-identity-'))
  const privateKey = path.join(root, 'private'), knownHosts = path.join(root, 'known-hosts')
  try {
    await fs.writeFile(privateKey, 'key one', { mode: 0o600 })
    await fs.writeFile(knownHosts, 'trusted key one', { mode: 0o600 })
    const target = { ...host, identityFile: privateKey }, pin = { file: knownHosts, hostKeyAlias: 'fixed-test' }
    const before = await sshConnectionIdentity(target, pin)
    assert.equal(await sshConnectionIdentity({ ...target, name: 'Renamed', cwd: '/other', codexPath: '/new/codex' }, pin), before)
    await fs.writeFile(privateKey, 'key two')
    const afterKey = await sshConnectionIdentity(target, pin)
    assert.notEqual(afterKey, before)
    await fs.writeFile(knownHosts, 'trusted key two')
    assert.notEqual(await sshConnectionIdentity(target, pin), afterKey)
    await fs.rm(knownHosts)
    await assert.rejects(sshConnectionIdentity(target, pin), /ENOENT/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
});
