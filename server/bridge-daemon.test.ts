import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { Bridge, type BridgeOptions, type Transport } from './bridge.js'
import type { Host, RpcMessage } from './types.js'

const host: Host = { id: 'daemon-fixture', kind: 'local', name: 'Independent daemon fixture', connectionMode: 'daemon' }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const prepared = { status: 'alreadyRunning' as const, cliVersion: '0.165.0', managedCodexVersion: '0.165.0', appServerVersion: '0.165.0', backend: 'fixture' }
const webQuestionConfig = { 'features.default_mode_request_user_input': true }
const active = (id: string) => ({ id, ephemeral: false, status: { type: 'active' }, name: id })
const idle = (id: string) => ({ id, ephemeral: false, status: { type: 'idle' }, name: id })

class Browser extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent: RpcMessage[] = []
  send(value: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(value)); callback?.() }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
  request(message: RpcMessage) { this.emit('message', Buffer.from(JSON.stringify(message))) }
  ws() { return this as unknown as WebSocket }
}
type Peer = { sent: RpcMessage[]; disposed: boolean; receive: (message: RpcMessage) => void; transport: Transport }
function fixture(options: {
  ids?: string[]
  loaded?: string[]
  threads?: Record<string, ReturnType<typeof active>>
  reply?: (message: RpcMessage, peer: Peer, index: number) => unknown
  prepareDaemon?: BridgeOptions['prepareDaemon']
  recoverThreadIds?: BridgeOptions['recoverThreadIds']
  mode?: Host['connectionMode']
  released?: string[]
} = {}) {
  const peers: Peer[] = [], preparations: { host: Host; signal?: AbortSignal }[] = []
  const selectedHost = { ...host, connectionMode: options.mode ?? 'daemon' }
  const bridge = new Bridge(selectedHost, {
    prepareDaemon: async (host, _options, signal) => {
      preparations.push({ host, signal })
      return options.prepareDaemon ? options.prepareDaemon(host, _options, signal) : prepared
    },
    recoverThreadIds: options.recoverThreadIds || (async () => options.ids || []),
    transportFactory: () => {
      const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter()
      let buffer = '', finished!: () => void
      const closed = new Promise<void>(resolve => { finished = resolve })
      const peer: Peer = {
        sent: [], disposed: false,
        receive: message => { if (!peer.disposed) output.write(JSON.stringify(message) + '\n') },
        transport: { input, output, events, closed, dispose: () => { peer.disposed = true; input.destroy(); output.destroy(); finished() } },
      }
      peers.push(peer)
      input.on('data', chunk => {
        buffer += chunk.toString()
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, index)) as RpcMessage
          buffer = buffer.slice(index + 1); peer.sent.push(message)
          if (message.id === undefined || !message.method) continue
          const result = options.reply?.(message, peer, peers.length)
          if (result === false) continue
          const params = message.params as { threadId?: string }
          const value = result ?? (message.method === 'initialize' ? { userAgent: 'isolated-codex/0.165.0', codexHome: '/isolated' }
            : message.method === 'thread/loaded/list' ? { data: options.loaded || [], nextCursor: null }
              : message.method === 'thread/backgroundTerminals/list' ? { data: [], nextCursor: null }
                : message.method === 'thread/queue/list' ? { data: [], nextCursor: null }
                  : ['thread/read', 'thread/resume'].includes(message.method) ? { thread: options.threads?.[params.threadId!] || idle(params.threadId!) }
                    : {})
          queueMicrotask(() => peer.receive({ id: message.id, result: value }))
        }
      })
      return peer.transport
    },
  }, new Map((options.released || []).map(id => [id, { name: id, restoreThreadIds: [] }])))
  return { bridge, peers, preparations }
}
const requests = (peers: Peer[], method: string) => peers.flatMap(peer => peer.sent).filter(message => message.method === method)
const noDaemonMutation = (peers: Peer[]) => assert.deepEqual(peers.flatMap(peer => peer.sent).filter(message =>
  ['turn/start', 'turn/interrupt', 'thread/archive', 'thread/delete', 'command/exec/terminate', 'daemon/stop', 'daemon/restart'].includes(message.method || '')), [])

test('independent daemon preparation is coalesced before transport initialization and reused while connected', async t => {
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const f = fixture({ prepareDaemon: async () => { await barrier; return prepared } })
  t.after(() => f.bridge.close())
  const attempts = [f.bridge.connect(), f.bridge.connect(), f.bridge.connect()]
  await tick()
  assert.equal(f.preparations.length, 1)
  assert.equal(f.peers.length, 0, 'Proxy cannot start before daemon readiness is confirmed')
  release(); await Promise.all(attempts)
  await f.bridge.request('config/read', { includeLayers: false })
  assert.equal(f.peers.length, 1)
  assert.equal(f.preparations.length, 1)
  assert.equal(f.bridge.options.mode, 'proxy')
  assert.equal(f.bridge.runtime.connectionMode, 'daemon')
  assert.equal(f.bridge.runtime.independentDaemon, true)
  assert.equal(f.bridge.runtime.managed, true)
  assert.equal(f.bridge.runtime.daemonLifecycleManaged, true)
  noDaemonMutation(f.peers)
})

for (const metadata of [
  { ...prepared, managedCodexVersion: null, backend: null },
  { ...prepared, managedCodexVersion: '0.165.0', backend: undefined },
]) {
  test(`reusing an external daemon does not claim lifecycle ownership (${metadata.backend === null ? 'no package' : 'no managed backend'})`, async t => {
    const f = fixture({ prepareDaemon: async () => metadata })
    t.after(() => f.bridge.close())
    await f.bridge.connect()
    assert.equal(f.bridge.runtime.connectionMode, 'daemon')
    assert.equal(f.bridge.runtime.independentDaemon, true)
    assert.equal(f.bridge.runtime.connected, true)
    assert.equal(f.bridge.runtime.managed, false)
    assert.equal(f.bridge.runtime.daemonLifecycleManaged, false)
    await f.bridge.reconnect()
    assert.equal(f.peers.length, 2)
    assert.equal(f.bridge.runtime.managed, false)
    noDaemonMutation(f.peers)
  })
}

for (const action of ['pause', 'close'] as const) {
  test(`${action} during daemon preparation aborts it and a late result cannot create a proxy`, async t => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ prepareDaemon: async () => { await barrier; return prepared } })
    t.after(() => f.bridge.close())
    const attempt = f.bridge.connect()
    const rejected = assert.rejects(attempt, /Host connection was closed/)
    await tick()
    assert.equal(f.preparations.length, 1)
    if (action === 'pause') await f.bridge.pause()
    else f.bridge.close()
    assert.equal(f.preparations[0]!.signal?.aborted, true)
    release(); await rejected
    assert.equal(f.peers.length, 0)
    assert.equal(f.bridge.connected, false)
    if (action === 'pause') {
      await f.bridge.resume()
      assert.equal(f.preparations.length, 2)
      assert.equal(f.peers.length, 1)
    }
  })
}

test('daemon startup restores only known loaded active durable threads without overriding their settings', async t => {
  const f = fixture({
    ids: ['active', 'idle', 'ephemeral', 'released', 'unknown-state', 'not-loaded'],
    loaded: ['active', 'idle', 'ephemeral', 'released', 'unknown-state', 'unrelated-desktop'],
    threads: {
      active: active('active'), idle: idle('idle'), ephemeral: { ...active('ephemeral'), ephemeral: true },
      'unknown-state': { ...active('unknown-state'), status: { type: 'future-status' } },
    },
    released: ['released'],
  })
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  assert.deepEqual(requests(f.peers, 'thread/resume').map(message => message.params), [{ threadId: 'active', excludeTurns: true, config: webQuestionConfig }])
  assert.deepEqual(requests(f.peers, 'thread/read').map(message => (message.params as any).threadId).sort(), ['active', 'ephemeral', 'idle', 'unknown-state'])
  assert.equal(f.bridge.runtime.activeThreadCount, 1)
  assert.deepEqual(f.bridge.runtime.recoveryPending, [])
  noDaemonMutation(f.peers)
})

test('previous subscriptions survive a lost proxy and recover active work without a disk journal', async t => {
  const f = fixture({ loaded: ['own-thread'], threads: { 'own-thread': active('own-thread') } })
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  await f.bridge.request('thread/resume', { threadId: 'own-thread', excludeTurns: true })
  f.peers[0]!.transport.events.emit('transportClose', new Error('Isolated proxy disconnected'))
  assert.equal(f.bridge.connected, false)
  await f.bridge.connect()
  assert.equal(f.peers.length, 2)
  assert.equal(f.peers[0]!.disposed, true)
  assert.deepEqual(f.peers[1]!.sent.filter(message => message.method === 'thread/resume').map(message => message.params), [{ threadId: 'own-thread', excludeTurns: true, config: webQuestionConfig }])
  assert.equal(f.bridge.runtime.activeThreadCount, 1)
  noDaemonMutation(f.peers)
})

test('proxy replacement replays the original native approval with its identity and complete context, without answering it', async t => {
  const approval: RpcMessage = { id: 'original-approval', method: 'item/commandExecution/requestApproval', params: {
    kind: 'command', threadId: 'working', turnId: 'original-turn', itemId: 'original-item', startedAtMs: 12345,
    command: 'printf isolated', cwd: '/isolated/project', reason: 'Native permission check',
    availableDecisions: ['accept', 'cancel'], commandActions: [{ type: 'unknown', command: 'printf isolated' }],
  } }
  const f = fixture({ loaded: ['working'], threads: { working: active('working') }, reply: (message, peer, index) => {
    if (index > 1 && message.method === 'thread/resume') queueMicrotask(() => peer.receive(approval))
  } })
  t.after(() => f.bridge.close())
  const browser = new Browser()
  f.bridge.attach('user:browser', browser.ws(), 'browser')
  await f.bridge.connect()
  await f.bridge.request('thread/resume', { threadId: 'working', excludeTurns: true })
  f.peers[0]!.receive(approval)
  await tick()
  assert.ok(browser.sent.some(message => message.id === approval.id && message.method === approval.method))
  assert.equal(f.bridge.reconnectStatus.canReconnect, true, 'Only the independent proxy is being replaced')
  await f.bridge.reconnect()
  await tick()
  const replay = browser.sent.filter(message => message.id === approval.id && message.method === approval.method).at(-1)
  assert.deepEqual({ id: replay?.id, method: replay?.method, params: replay?.params }, approval)
  assert.equal(f.bridge.runtime.activeThreadCount, 1)
  assert.equal(browser.readyState, 1)
  const replies = f.peers.flatMap(peer => peer.sent).filter(message => message.id === approval.id && !message.method)
  assert.deepEqual(replies, [], 'A reconnect must not approve or reject pending native work')
  noDaemonMutation(f.peers)
})

test('explicit maintenance still refuses active daemon threads and approvals before applying any preparation', async t => {
  const f = fixture({ loaded: ['working'], threads: { working: active('working') } })
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  await f.bridge.request('thread/resume', { threadId: 'working', excludeTurns: true })
  let preparations = 0
  await assert.rejects(f.bridge.reconnect(async () => { preparations++ }), error => (error as any).status === 409)
  assert.equal(preparations, 0)
  assert.equal(f.peers.length, 1)
  assert.equal(f.peers[0]!.disposed, false)
  noDaemonMutation(f.peers)
})

test('mode migration maintenance refuses native queued input before committing while ordinary maintenance keeps its existing behavior', async t => {
  const f = fixture({ mode: 'spawn', loaded: ['queued-thread'], threads: { 'queued-thread': idle('queued-thread') },
    reply: message => message.method === 'thread/queue/list' ? { data: [{ id: 'accepted-queued-input' }], nextCursor: null } : undefined,
  })
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  let commits = 0
  assert.equal(await f.bridge.withRuntimeMaintenance(async () => ++commits), 1)
  assert.deepEqual(requests(f.peers, 'thread/queue/list'), [], 'Existing maintenance callers do not acquire the new queue migration check')
  await assert.rejects(f.bridge.withRuntimeMaintenance(async () => ++commits, { checkQueuedInputs: true }), error =>
    (error as any).status === 409 && (error as any).code === 'runtime_busy')
  assert.equal(commits, 1, 'A queued native message must block the mode-change settings commit')
  assert.deepEqual(requests(f.peers, 'thread/queue/list').map(message => message.params), [{ threadId: 'queued-thread', limit: 1 }])
  assert.equal(f.bridge.connected, true)
  assert.equal(f.peers.length, 1)
  assert.equal(f.peers[0]!.disposed, false)
  noDaemonMutation(f.peers)
})

for (const mode of ['spawn', 'proxy'] as const) {
  test(`legacy ${mode} reconnect retains its conservative active-turn guard`, async t => {
    const f = fixture({ mode })
    t.after(() => f.bridge.close())
    await f.bridge.connect()
    f.peers[0]!.receive({ method: 'turn/started', params: { threadId: 'unopened-native', turn: { id: 'running', status: 'inProgress' } } })
    await assert.rejects(f.bridge.reconnect(), error => (error as any).status === 409)
    assert.equal(f.peers.length, 1)
    assert.equal(f.peers[0]!.disposed, false)
    assert.equal(f.preparations.length, 0)
  })
}

for (const standalone of [false, true]) {
  test(`independent daemon reconnect refuses a ${standalone ? 'pending standalone command' : 'live PTY'} whose identity belongs to the connection`, async t => {
    const f = fixture({ reply: message => message.method === 'command/exec' ? false : undefined })
    t.after(() => f.bridge.close())
    await f.bridge.connect()
    const pending = f.bridge.request('command/exec', standalone ? { command: ['sleep', '5'] } : { command: ['bash'], tty: true, processId: 'live-terminal' })
    pending.catch(() => {})
    await tick()
    await assert.rejects(f.bridge.reconnect(), error => (error as any).status === 409)
    assert.equal(f.peers.length, 1)
    assert.equal(f.peers[0]!.disposed, false)
    f.bridge.close(); await pending.catch(() => {})
  })
}

test('closing one browser leaves the daemon proxy and active work available to other browsers', async t => {
  const f = fixture({ loaded: ['working'], threads: { working: active('working') } })
  t.after(() => f.bridge.close())
  const first = new Browser(), second = new Browser()
  f.bridge.attach('user:first', first.ws(), 'first')
  f.bridge.attach('user:second', second.ws(), 'second')
  await f.bridge.connect()
  await f.bridge.request('thread/resume', { threadId: 'working' })
  first.close(); await tick()
  assert.equal(f.bridge.connected, true)
  assert.equal(f.peers[0]!.disposed, false)
  assert.equal(second.readyState, 1)
  assert.equal(f.bridge.runtime.activeThreadCount, 1)
  noDaemonMutation(f.peers)
  f.bridge.close()
  assert.equal(f.peers[0]!.disposed, true)
  noDaemonMutation(f.peers)
})

test('a recovery failure is visible while the daemon stays connected and a later recovery can succeed', async t => {
  const f = fixture({ ids: ['working'], loaded: ['working'], threads: { working: active('working') }, reply: (message, peer, index) => {
    if (index === 1 && message.method === 'thread/resume') {
      queueMicrotask(() => peer.receive({ id: message.id, error: { code: -32000, message: 'Transient native reconnect failure' } }))
      return false
    }
  } })
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  assert.equal(f.bridge.connected, true)
  assert.deepEqual(f.bridge.runtime.recoveryPending, ['working'])
  await f.bridge.reconnect()
  assert.deepEqual(f.bridge.runtime.recoveryPending, [])
  assert.equal(f.bridge.runtime.activeThreadCount, 1)
  noDaemonMutation(f.peers)
})

test('retrying a transient recovery read restores the original approval without replacing a healthy transport', async t => {
  const approval: RpcMessage = { id: 'retry-original-approval', method: 'item/commandExecution/requestApproval', params: {
    threadId: 'working', turnId: 'original-turn', itemId: 'original-item', startedAtMs: 12345,
    command: 'printf isolated-retry', cwd: '/isolated/project', availableDecisions: ['accept', 'cancel'],
  } }
  let failedRead = false
  const f = fixture({ ids: ['working'], loaded: ['working'], threads: { working: active('working') }, reply: (message, peer) => {
    if (message.method === 'thread/read' && !failedRead) {
      failedRead = true
      queueMicrotask(() => peer.receive({ id: message.id, error: { code: -32000, message: 'Transient metadata read failure' } }))
      return false
    }
    if (message.method === 'thread/resume') queueMicrotask(() => peer.receive(approval))
  } })
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  assert.equal(f.bridge.connected, true)
  assert.deepEqual(f.bridge.runtime.recoveryPending, ['working'])
  const engineId = f.bridge.runtime.engineId, originalPeer = f.peers[0]!
  const browser = new Browser()
  f.bridge.attach('user:retry-browser', browser.ws(), 'retry-browser')
  await f.bridge.retryDaemonSubscriptions()
  await tick()
  assert.equal(f.peers.length, 1)
  assert.equal(f.preparations.length, 1)
  assert.equal(originalPeer.disposed, false)
  assert.equal(f.bridge.runtime.engineId, engineId)
  assert.equal(f.bridge.runtime.activeThreadCount, 1)
  assert.deepEqual(f.bridge.runtime.recoveryPending, [])
  const replay = browser.sent.find(message => message.id === approval.id && message.method === approval.method)
  assert.deepEqual({ id: replay?.id, method: replay?.method, params: replay?.params }, approval)
  assert.deepEqual(originalPeer.sent.filter(message => message.id === approval.id && !message.method), [])
  assert.deepEqual(requests(f.peers, 'thread/resume').map(message => message.params), [{ threadId: 'working', excludeTurns: true, config: webQuestionConfig }])
  noDaemonMutation(f.peers)
})

test('concurrent recovery retries share one operation and a paused bridge cannot resume a late recovery result', async t => {
  let release!: () => void, recovering = false, failedRead = false, journalReads = 0
  const barrier = new Promise<void>(resolve => { release = resolve })
  const f = fixture({ loaded: ['working'], threads: { working: active('working') },
    recoverThreadIds: async () => { journalReads++; return ['working'] },
    reply: (message, peer) => {
      if (message.method === 'thread/loaded/list' && recovering) {
        void barrier.then(() => peer.receive({ id: message.id, result: { data: ['working'], nextCursor: null } }))
        return false
      }
      if (message.method === 'thread/read' && !failedRead) {
        failedRead = true
        queueMicrotask(() => peer.receive({ id: message.id, error: { code: -32000, message: 'Transient metadata read failure' } }))
        return false
      }
    },
  })
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  assert.deepEqual(f.bridge.runtime.recoveryPending, ['working'])
  recovering = true
  const retry = f.bridge.retryDaemonSubscriptions()
  assert.equal(f.bridge.retryDaemonSubscriptions(), retry)
  await tick()
  assert.equal(journalReads, 1, 'Retrying known failed IDs does not reload the whole journal')
  assert.equal(requests(f.peers, 'thread/loaded/list').length, 2)
  await f.bridge.pause()
  release(); await retry
  assert.equal(f.bridge.paused, true)
  assert.equal(f.bridge.connected, false)
  assert.equal(f.peers.length, 1)
  assert.equal(f.peers[0]!.disposed, true)
  assert.deepEqual(requests(f.peers, 'thread/resume'), [])
  noDaemonMutation(f.peers)
})

test('recovery retry only rejoins failed threads and leaves healthy active subscriptions untouched', async t => {
  let failedRead = false
  const f = fixture({ ids: ['healthy', 'working'], loaded: ['healthy', 'working'], threads: { healthy: active('healthy'), working: active('working') },
    reply: (message, peer) => {
      if (message.method === 'thread/read' && (message.params as any)?.threadId === 'working' && !failedRead) {
        failedRead = true
        queueMicrotask(() => peer.receive({ id: message.id, error: { code: -32000, message: 'Transient metadata read failure' } }))
        return false
      }
    },
  })
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  assert.deepEqual(f.bridge.runtime.recoveryPending, ['working'])
  assert.deepEqual(requests(f.peers, 'thread/resume').map(message => (message.params as any).threadId), ['healthy'])
  await f.bridge.retryDaemonSubscriptions()
  assert.deepEqual(f.bridge.runtime.recoveryPending, [])
  assert.deepEqual(requests(f.peers, 'thread/read').map(message => (message.params as any).threadId), ['healthy', 'working', 'working'])
  assert.deepEqual(requests(f.peers, 'thread/resume').map(message => (message.params as any).threadId), ['healthy', 'working'])
  assert.equal(f.bridge.runtime.activeThreadCount, 2)
  assert.equal(f.peers.length, 1)
  assert.equal(f.peers[0]!.disposed, false)
  noDaemonMutation(f.peers)
})

test('invalid loaded recovery metadata never resumes threads from an untrusted inventory', async t => {
  const f = fixture({ ids: ['working'], reply: message => message.method === 'thread/loaded/list' ? { data: ['working', 123], nextCursor: null } : undefined })
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  assert.equal(f.bridge.connected, true)
  assert.deepEqual(f.bridge.runtime.recoveryPending, ['working'])
  assert.deepEqual(requests(f.peers, 'thread/read'), [])
  assert.deepEqual(requests(f.peers, 'thread/resume'), [])
})

test('daemon threads enable the Web question capability without mutating shared configuration or caller params', async t => {
  const f = fixture()
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
    const params = { threadId: 'working', config: { model_reasoning_effort: 'high', features: { web_search: true } } }
    const original = structuredClone(params)
    await f.bridge.request(method, params)
    assert.deepEqual(requests(f.peers, method).at(-1)?.params, { ...original, config: { ...original.config, ...webQuestionConfig } })
    assert.deepEqual(params, original)
  }
  assert.deepEqual(requests(f.peers, 'config/batchWrite'), [])
  noDaemonMutation(f.peers)
})

test('daemon question compatibility preserves explicit feature choices and prediction mode', async t => {
  const f = fixture()
  t.after(() => f.bridge.close())
  await f.bridge.connect()
  for (const params of [
    { threadId: 'working', config: { 'features.default_mode_request_user_input': false, model_reasoning_effort: 'high' } },
    { threadId: 'working', config: { features: { default_mode_request_user_input: false, web_search: true } } },
    { threadId: 'working', experimentalPredictionMode: true, config: { model_reasoning_effort: 'high' } },
  ]) {
    await f.bridge.request('thread/resume', params)
    assert.deepEqual(requests(f.peers, 'thread/resume').at(-1)?.params, params)
  }
  noDaemonMutation(f.peers)
})

test('connected status and a full ping wait for every pending approval recovery rather than exposing a partial snapshot', async t => {
  let finishRecovery: (() => void) | undefined
  const approval = (threadId: string): RpcMessage => ({ id: 'approval-' + threadId, method: 'item/commandExecution/requestApproval', params: {
    threadId, turnId: 'turn-' + threadId, itemId: 'item-' + threadId, command: 'printf isolated', availableDecisions: ['accept', 'cancel'],
  } })
  const f = fixture({ ids: ['first', 'last'], loaded: ['first', 'last'], threads: { first: active('first'), last: active('last') },
    reply: (message, peer) => {
      if (message.method !== 'thread/resume') return
      const threadId = (message.params as any).threadId
      if (threadId === 'first') queueMicrotask(() => peer.receive(approval(threadId)))
      else {
        finishRecovery = () => { peer.receive(approval(threadId)); peer.receive({ id: message.id, result: { thread: active(threadId) } }) }
        return false
      }
    },
  })
  t.after(() => f.bridge.close())
  const browser = new Browser()
  f.bridge.attach('user:early-ping', browser.ws(), 'early-ping')
  const connecting = f.bridge.connect()
  for (let attempt = 0; attempt < 20 && !finishRecovery; ++attempt) await tick()
  assert.ok(finishRecovery)
  assert.equal(browser.sent.some(message => message.method === 'bridge/status' && (message.params as any)?.connected === true), false)
  browser.request({ id: 'early-full-ping', method: 'bridge/ping', params: { includeState: true } })
  await tick()
  assert.equal(browser.sent.some(message => message.id === 'early-full-ping'), false)
  finishRecovery()
  await connecting; await tick()
  const reply = browser.sent.find(message => message.id === 'early-full-ping')?.result as any
  assert.equal(reply.connected, true)
  assert.deepEqual(reply.pendingRequests.map((message: RpcMessage) => message.id).sort(), ['approval-first', 'approval-last'])
  assert.equal(browser.sent.some(message => message.method === 'bridge/status' && (message.params as any)?.connected === true), true)
  noDaemonMutation(f.peers)
})
