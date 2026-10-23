import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PushObservers, type PushObserverOptions } from './push-observers.js'
import type { Host, RpcMessage } from './types.js'

const local: Host = { id: 'local', name: '本机', kind: 'local' }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-observers-'))
  let now = 1_800_000_000_000, grants = true, available = true
  let hosts: Host[] = [local]
  let connects = 0
  const events: { host: Host; message: RpcMessage; method?: string }[] = []
  const requests: { method: string; params: any }[] = []
  const threads = new Map<string, any>()
  const turns = new Map<string, any[]>()
  const bridge = { connected: false, paused: false,
    async connect() { connects++; if (!available) throw new Error('private SSH detail'); this.connected = true },
    async request(method: string, params?: any) {
      requests.push({ method, params })
      if (!available) throw new Error('private SSH detail')
      if (method === 'thread/loaded/list') return { data: [...threads.keys()], nextCursor: null }
      if (method === 'thread/read') return { thread: threads.get(params.threadId) }
      if (method === 'thread/turns/list') return { data: turns.get(params.threadId) || [], nextCursor: null }
      throw new Error('Unexpected method: ' + method)
    },
  }
  const options: PushObserverOptions = {
    getHosts: () => hosts, getBridge: async () => bridge, hasSubscriptions: () => grants,
    observe: (host, message, method) => { events.push({ host, message, method }) }, flushPush: async () => {},
    now: () => now, intervalMs: 60_000, retryBaseMs: 1000,
  }
  const service = new PushObservers(directory, options)
  await service.init()
  return { directory, service, options, bridge, requests, events, threads, turns,
    get connects() { return connects }, advance: (ms: number) => { now += ms }, setGrants: (value: boolean) => { grants = value },
    setAvailable: (value: boolean) => { available = value }, setHosts: (value: Host[]) => { hosts = value },
    async cleanup() { await service.close(); await fs.rm(directory, { recursive: true, force: true }) },
  }
}

test('background observers reconnect with no browser and back off independently of reopening a page', async () => {
  const f = await fixture()
  try {
    f.setAvailable(false)
    await f.service.poll()
    assert.equal(f.connects, 1)
    assert.equal(f.service.status().hosts[0]!.state, 'retrying')
    assert.ok(!JSON.stringify(f.service.status()).includes('private SSH'))
    await f.service.poll(); assert.equal(f.connects, 1)
    f.advance(1000); await f.service.poll(); assert.equal(f.connects, 2)
    f.setAvailable(true); f.advance(2000); await f.service.poll()
    assert.equal(f.connects, 3); assert.equal(f.bridge.connected, true)
    assert.equal(f.service.status().hosts[0]!.state, 'observing')
    assert.deepEqual(f.requests.map(value => value.method), ['thread/loaded/list'])
  } finally { await f.cleanup() }
})

test('a missed completion is recovered using only a previously observed active turn and summary reads', async () => {
  const f = await fixture()
  try {
    f.threads.set('active', { id: 'active', source: 'cli', status: { type: 'active' } })
    f.turns.set('active', [{ id: 'work', status: 'inProgress' }, { id: 'old', status: 'completed' }])
    await f.service.poll(); await f.service.flush()
    assert.equal(f.events.filter(value => value.message.method === 'turn/completed').length, 0)
    const journal = JSON.parse(await fs.readFile(path.join(f.directory, 'push-observers.json'), 'utf8'))
    assert.deepEqual(journal.threads.map((value: any) => value.turnId), ['work'])
    assert.equal((await fs.stat(path.join(f.directory, 'push-observers.json'))).mode & 0o777, 0o600)
    f.bridge.connected = false
    f.service.observe(local, { method: 'bridge/disconnected', params: {} })
    f.threads.set('active', { id: 'active', source: 'cli', status: { type: 'idle' } })
    f.turns.set('active', [{ id: 'work', status: 'completed', items: [{ text: 'secret output' }] }, { id: 'old', status: 'completed' }])
    f.advance(1000); await f.service.poll(); await f.service.flush()
    const completed = f.events.filter(value => value.message.method === 'turn/completed')
    assert.equal(completed.length, 1)
    assert.deepEqual(completed[0]!.message.params, { threadId: 'active', turn: { id: 'work', status: 'completed' } })
    assert.ok(!JSON.stringify(completed).includes('secret output'))
    f.advance(60_000); await f.service.poll(); assert.equal(f.events.filter(value => value.message.method === 'turn/completed').length, 1)
    assert.ok(f.requests.every(value => ['thread/loaded/list', 'thread/read', 'thread/turns/list'].includes(value.method)))
    assert.ok(f.requests.filter(value => value.method === 'thread/turns/list').every(value => value.params.itemsView === 'summary' && value.params.limit === 20))
  } finally { await f.cleanup() }
})

test('observer restart recovers a tracked completion without notifying old idle threads', async () => {
  const f = await fixture()
  let restored: PushObservers | undefined
  try {
    f.service.observe(local, { method: 'turn/started', params: { threadId: 'tracked', turn: { id: 'last-running', status: 'inProgress' } } })
    await f.service.close()
    f.threads.set('tracked', { id: 'tracked', source: 'cli', status: { type: 'idle' } })
    f.turns.set('tracked', [{ id: 'last-running', status: 'failed', error: { message: 'private error with command' } }])
    f.threads.set('old', { id: 'old', source: 'cli', status: { type: 'idle' } })
    f.turns.set('old', [{ id: 'ancient-completed', status: 'completed' }])
    restored = new PushObservers(f.directory, f.options); await restored.init(); await restored.poll(); await restored.flush()
    const notices = f.events.filter(value => value.message.method === 'turn/completed')
    assert.equal(notices.length, 1)
    assert.deepEqual(notices[0]!.message.params, { threadId: 'tracked', turn: { id: 'last-running', status: 'failed', error: { message: '运行失败' } } })
    assert.ok(!JSON.stringify(notices).includes('private error'))
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'push-observers.json'), 'utf8')).threads.length, 0)
  } finally { await restored?.close(); await f.cleanup() }
})

test('completion recovery keeps the durable marker until push enqueue/acknowledgement finishes', async () => {
  const f = await fixture()
  let release!: () => void
  try {
    f.service.observe(local, { method: 'turn/started', params: { threadId: 'tracked', turn: { id: 'a', status: 'inProgress' } } })
    await f.service.flush()
    f.options.observe = (_host, message) => message.method === 'turn/completed' ? new Promise<void>(resolve => { release = resolve }) : undefined
    f.service.observe(local, { method: 'turn/completed', params: { threadId: 'tracked', turn: { id: 'a', status: 'completed' } } })
    await tick()
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'push-observers.json'), 'utf8')).threads[0].turnId, 'a')
    // A new accepted turn racing the previous acknowledgement remains tracked.
    f.service.observe(local, { method: 'bridge/thread/changed', params: { threadId: 'tracked', method: 'turn/start', result: { turn: { id: 'b' } } } })
    release(); await f.service.flush()
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'push-observers.json'), 'utf8')).threads[0].turnId, 'b')
  } finally { release?.(); await f.cleanup() }
})

test('paused hosts, revoked grants, removed hosts and auxiliary work cannot create background notifications', async () => {
  const f = await fixture()
  try {
    f.bridge.paused = true; await f.service.poll(); assert.equal(f.connects, 0)
    f.bridge.paused = false; f.setGrants(false); await f.service.poll(); assert.equal(f.connects, 0)
    f.setGrants(true)
    f.service.observe(local, { method: 'thread/started', params: { thread: { id: 'child', source: { subAgent: 'review' }, status: { type: 'active' } } } })
    f.service.observe(local, { method: 'turn/started', params: { threadId: 'child', turn: { id: 'a', status: 'inProgress' } } })
    f.service.observe(local, { method: 'thread/started', params: { thread: { id: 'side', source: 'cli', ephemeral: true, status: { type: 'active' } } } })
    f.service.observe(local, { method: 'turn/started', params: { threadId: 'side', turn: { id: 'b', status: 'inProgress' } } })
    f.service.observe(local, { method: 'turn/started', params: { threadId: 'main', turn: { id: 'c', status: 'inProgress' } } })
    await f.service.flush()
    assert.equal(f.service.status().hosts[0]!.watchedThreads, 1)
    f.setHosts([]); await f.service.poll(); await f.service.flush()
    assert.equal(f.service.status().hosts.length, 0)
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'push-observers.json'), 'utf8')).threads.length, 0)
  } finally { await f.cleanup() }
})

test('loaded discovery can recover active work from another client but never notifies unobserved history', async () => {
  const f = await fixture()
  try {
    f.threads.set('desktop', { id: 'desktop', source: 'cli', status: { type: 'active' } })
    f.turns.set('desktop', [{ id: 'external-turn', status: 'inProgress' }])
    f.threads.set('historic', { id: 'historic', source: 'cli', status: { type: 'idle' } })
    f.turns.set('historic', [{ id: 'old', status: 'completed' }])
    await f.service.poll(); await f.service.flush()
    assert.equal(f.service.status().hosts[0]!.watchedThreads, 1)
    f.threads.set('desktop', { id: 'desktop', source: 'cli', status: { type: 'idle' } })
    f.turns.set('desktop', [{ id: 'external-turn', status: 'completed' }])
    f.advance(60_000); await f.service.poll(); await f.service.flush()
    assert.equal(f.events.filter(value => value.message.method === 'turn/completed').length, 1)
  } finally { await f.cleanup() }
})

test('one native error/deletion never prevents other watched threads from completing', async () => {
  const f = await fixture()
  try {
    for (const [threadId, turnId] of [['deleted', 'a'], ['good', 'b'], ['interrupted', 'c']]) f.service.observe(local, { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } })
    f.threads.set('good', { id: 'good', source: 'cli', status: { type: 'idle' } }); f.turns.set('good', [{ id: 'b', status: 'completed' }])
    f.threads.set('interrupted', { id: 'interrupted', source: 'cli', status: { type: 'idle' } }); f.turns.set('interrupted', [{ id: 'c', status: 'interrupted' }])
    await f.service.poll(); await f.service.flush()
    assert.equal(f.events.filter(value => value.message.method === 'turn/completed').length, 1)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'push-observers.json'), 'utf8')).threads.map((value: any) => value.threadId), ['deleted'])
    f.service.observe(local, { method: 'thread/deleted', params: { threadId: 'deleted' } }); await f.service.flush()
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'push-observers.json'), 'utf8')).threads.length, 0)
  } finally { await f.cleanup() }
})

test('corrupt and duplicate observer journals fail closed instead of silently losing active work', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-push-observers-invalid-'))
  const file = path.join(directory, 'push-observers.json')
  const options: PushObserverOptions = { getHosts: () => [], getBridge: async () => { throw new Error('No host') }, hasSubscriptions: () => false, observe: () => {}, flushPush: async () => {} }
  try {
    for (const text of ['broken json', JSON.stringify({ version: 1, threads: Array(2).fill({ hostId: 'local', threadId: 'a', observedAt: Date.now() }) })]) {
      await fs.writeFile(file, text)
      const service = new PushObservers(directory, options)
      await assert.rejects(service.init(), /Unable to read push-observers/)
      assert.equal(await fs.readFile(file, 'utf8'), text)
      await service.close()
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('deferred startup does not connect or schedule observation until application initialization succeeds', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-observer-deferred-'))
  let connects = 0
  const service = new PushObservers(directory, { autoStart: false, getHosts: () => [local], hasSubscriptions: () => true,
    getBridge: async () => ({ connected: true, paused: false, async connect() { connects++ }, async request() { return { data: [], nextCursor: null } } }),
    observe: () => {}, flushPush: async () => {} })
  try {
    await service.init(); service.wake(); await service.poll(); await tick()
    assert.equal(connects, 0)
    service.start(); await service.poll(); await service.flush()
    assert.equal(connects, 1)
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
