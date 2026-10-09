import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { WebSocket } from 'ws'
import { Bridge, shellQuote, type BridgeOptions, type Transport } from './bridge.js'
import type { Host, RpcMessage } from './types.js'
import type { SSHHostKeyPin } from './ssh-host-keys.js'

class Browser extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent: RpcMessage[] = []
  send(data: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(data)); callback?.() }
  request(message: RpcMessage) { this.emit('message', Buffer.from(JSON.stringify(message))) }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
  ws() { return this as unknown as WebSocket }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

for (const failure of ['throw', 'callback', 'error'] as const) {
  test(`browser ${failure} failure is isolated from the shared Codex writer and other clients`, async () => {
    const value = fixture()
    const healthy = new Browser()
    const broken = new Browser()
    value.bridge.attach('healthy', healthy.ws(), 'healthy')
    value.bridge.attach('broken', broken.ws(), 'broken')
    try {
      await value.bridge.connect()
      if (failure === 'throw') broken.send = () => { throw new Error('Socket failed') }
      if (failure === 'callback') broken.send = ((_data: string, callback: (error: Error) => void) => callback(new Error('Socket failed'))) as typeof broken.send
      if (failure === 'error') broken.emit('error', new Error('Socket failed'))
      value.receive({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'answer', delta: 'Still running' } })
      assert.equal(broken.readyState, 3)
      assert.equal(value.bridge.connected, true)
      assert.equal(healthy.sent.at(-1)?.method, 'item/agentMessage/delta')
      healthy.request({ id: 'read', method: 'thread/read', params: { threadId: 't' } })
      await tick()
      const request = value.sent.find(message => message.method === 'thread/read')!
      value.receive({ id: request.id, result: { thread: { id: 't' } } })
      await tick()
      assert.deepEqual(healthy.sent.find(message => message.id === 'read')?.result, { thread: { id: 't' } })
    } finally { value.bridge.close() }
  })
}

test('a large valid history response is delivered when the browser has no pending backlog', async () => {
  const value = fixture()
  const browser = new Browser()
  value.bridge.attach('reader', browser.ws(), 'reader')
  try {
    await value.bridge.connect()
    browser.request({ id: 'history', method: 'thread/read', params: { threadId: 't' } })
    await tick()
    const request = value.sent.find(message => message.method === 'thread/read')!
    value.receive({ id: request.id, result: { text: 'x'.repeat(8 * 1024 * 1024 + 1) } })
    await tick()
    assert.equal(browser.readyState, 1)
    assert.equal((browser.sent.find(message => message.id === 'history')?.result as any).text.length, 8 * 1024 * 1024 + 1)
  } finally { value.bridge.close() }
})

test('a history response above 8 MiB followed by live events preserves both browser connections and the shared writer', async () => {
  const value = fixture(), slow = new Browser(), healthy = new Browser()
  value.bridge.attach('slow', slow.ws(), 'slow'); value.bridge.attach('healthy', healthy.ws(), 'healthy')
  try {
    await value.bridge.connect()
    const completions: (() => void)[] = [], send = slow.send.bind(slow)
    slow.send = (data, callback) => {
      send(data); slow.bufferedAmount = Buffer.byteLength(data)
      completions.push(() => { slow.bufferedAmount = 0; callback?.() })
    }
    slow.request({ id: 'history', method: 'thread/turns/list', params: { threadId: 't', limit: 30 } })
    await tick()
    value.receive({ id: value.sent.find(message => message.method === 'thread/turns/list')!.id,
      result: { data: [{ id: 'turn', items: [{ text: 'x'.repeat(16 * 1024 * 1024) }] }], nextCursor: null } })
    for (let i = 0; i < 20; i++) value.receive({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'answer', delta: String(i) } })
    assert.equal(slow.readyState, 1); assert.equal(value.bridge.connected, true)
    assert.equal(slow.sent.filter(message => message.method === 'item/agentMessage/delta').length, 0)
    assert.equal(healthy.sent.filter(message => message.method === 'item/agentMessage/delta').length, 20)
    assert.equal(healthy.sent.some(message => message.id === 'history'), false)
    while (completions.length) completions.shift()!()
    await tick()
    assert.deepEqual(slow.sent.filter(message => message.method === 'item/agentMessage/delta').map(message => (message.params as any).delta), Array.from({ length: 20 }, (_, i) => String(i)))
    assert.equal(value.bridge.diagnostics().browsers.queuedBytes, 0)
  } finally { value.bridge.close() }
})

test('same-engine reconnect replays missed events before status and never replays private RPC responses', async () => {
  const value = fixture();
  const first = new Browser(); value.bridge.attach('session:first', first.ws(), 'first');
  try {
    await value.bridge.connect();
    const engineId = (first.sent.filter(message => message.method === 'bridge/status').at(-1)!.params as any).engineId;
    value.receive({ method: 'thread/name/updated', params: { threadId: 't', name: 'Before' } });
    first.close();
    value.receive({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'answer', delta: 'missed' } });
    value.receive({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'completed' } } });
    const next = new Browser(); value.bridge.attach('session:first', next.ws(), 'first', () => true, { engineId, afterSequence: 1 });
    assert.deepEqual(next.sent.slice(0, 2).map(message => message.bridgeEventSequence), [2, 3]);
    assert.equal((next.sent.find(message => message.method === 'bridge/status')!.params as any).replayComplete, true);
    assert.equal(next.sent.some(message => message.id !== undefined && !message.method), false);
    const wrong = new Browser(); value.bridge.attach('session:wrong', wrong.ws(), 'wrong', () => true, { engineId: 'old-engine', afterSequence: 1 });
    assert.equal(wrong.sent.some(message => message.bridgeEventSequence), false);
    assert.equal((wrong.sent[0]!.params as any).replayComplete, false);
  } finally { value.bridge.close(); }
});

test('event replay has a bounded window and reports unavailable old cursors', async () => {
  const value = fixture();
  try {
    await value.bridge.connect();
    const first = new Browser(); value.bridge.attach('session:first', first.ws(), 'first');
    const engineId = (first.sent[0]!.params as any).engineId;
    first.close();
    for (let i = 0; i < 4100; i++) value.receive({ method: 'thread/name/updated', params: { threadId: 't', name: String(i) } });
    const old = new Browser(); value.bridge.attach('session:old', old.ws(), 'old', () => true, { engineId, afterSequence: 0 });
    assert.equal((old.sent[0]!.params as any).replayComplete, false);
    assert.equal(old.sent.some(message => message.bridgeEventSequence), false);
    const recent = new Browser(); value.bridge.attach('session:recent', recent.ws(), 'recent', () => true, { engineId, afterSequence: 4098 });
    assert.deepEqual(recent.sent.filter(message => message.bridgeEventSequence).map(message => message.bridgeEventSequence), [4099, 4100]);
  } finally { value.bridge.close(); }
});

test('bridge continuity identifies an engine, sequences notifications and acknowledges a sender without repeating its mutation', async () => {
  const value = fixture()
  const first = new Browser(); const second = new Browser()
  value.bridge.attach('session:first', first.ws(), 'first'); value.bridge.attach('session:second', second.ws(), 'second')
  try {
    await value.bridge.connect()
    const initial = first.sent.filter(message => message.method === 'bridge/status').at(-1)!.params as any
    assert.equal(typeof initial.engineId, 'string'); assert.equal(initial.eventSequence, 0)
    value.receive({ method: 'thread/name/updated', params: { threadId: 'thread-a', name: 'Name' } })
    value.receive({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-a', tokenUsage: { last: { totalTokens: 100 }, modelContextWindow: 1000 } } })
    assert.deepEqual(first.sent.filter(message => message.bridgeEventSequence).map(message => message.bridgeEventSequence), [1, 2])
    first.request({ id: 'rename', method: 'thread/name/set', params: { threadId: 'thread-a', name: 'New name' } })
    await tick()
    const request = value.sent.find(message => message.method === 'thread/name/set')!
    value.receive({ id: request.id, result: {} }); await tick()
    assert.equal(first.sent.find(message => message.method === 'bridge/event/ack')?.bridgeEventSequence, 3)
    assert.ok(first.sent.findIndex(message => message.id === 'rename') < first.sent.findIndex(message => message.method === 'bridge/event/ack'), 'An accepted RPC result must reach its origin before its cursor advances')
    assert.equal(first.sent.some(message => message.method === 'bridge/thread/changed'), false)
    assert.equal(second.sent.find(message => message.method === 'bridge/thread/changed')?.bridgeEventSequence, 3)
    first.request({ id: 'ping', method: 'bridge/ping', params: {} }); await tick()
    const pong = first.sent.find(message => message.id === 'ping')!.result as any
    assert.equal(pong.engineId, initial.engineId); assert.equal(pong.eventSequence, 3)
    assert.equal(value.sent.some(message => message.method === 'bridge/ping'), false, 'Liveness checks must stay on the persistent browser bridge')
    first.close()
    const resumed = new Browser(); value.bridge.attach('session:first', resumed.ws(), 'first')
    const recovered = resumed.sent.find(message => message.method === 'bridge/status')!.params as any
    assert.equal(recovered.engineId, initial.engineId); assert.equal(recovered.eventSequence, 3)
  } finally { value.bridge.close() }
})

test('a client disconnected after its accepted response still gets the missing mutation during replay', async () => {
  const value = fixture();
  const first = new Browser(); value.bridge.attach('session:first', first.ws(), 'first');
  try {
    await value.bridge.connect();
    const engineId = (first.sent.filter(message => message.method === 'bridge/status').at(-1)!.params as any).engineId;
    const send = first.send.bind(first);
    first.send = raw => { send(raw); if (JSON.parse(raw).id === 'rename') first.close(); };
    first.request({ id: 'rename', method: 'thread/name/set', params: { threadId: 't', name: 'Accepted rename' } });
    await tick();
    value.receive({ id: value.sent.find(message => message.method === 'thread/name/set')!.id, result: {} }); await tick();
    assert.equal(first.sent.filter(message => message.id === 'rename').length, 1);
    assert.equal(first.sent.some(message => message.bridgeEventSequence), false);
    const next = new Browser(); value.bridge.attach('session:first', next.ws(), 'first', () => true, { engineId, afterSequence: 0 });
    assert.equal(next.sent[0]!.method, 'bridge/thread/changed');
    assert.equal((next.sent[0]!.params as any).request.name, 'Accepted rename');
    assert.equal((next.sent.find(message => message.method === 'bridge/status')!.params as any).replayComplete, true);
  } finally { value.bridge.close(); }
});

test('replay acknowledges resolved approvals instead of displaying old decisions again', async () => {
  const value = fixture();
  try {
    await value.bridge.connect();
    const first = new Browser(); value.bridge.attach('session:first', first.ws(), 'first');
    const engineId = (first.sent[0]!.params as any).engineId;
    first.close();
    value.receive({ id: 'approval-old', method: 'item/commandExecution/requestApproval', params: { threadId: 't' } });
    value.receive({ method: 'serverRequest/resolved', params: { requestId: 'approval-old' } });
    const next = new Browser(); value.bridge.attach('session:next', next.ws(), 'next', () => true, { engineId, afterSequence: 0 });
    assert.equal(next.sent[0]!.method, 'bridge/event/ack');
    assert.equal(next.sent[0]!.bridgeEventSequence, 1);
    assert.equal(next.sent.some(message => message.id === 'approval-old'), false);
  } finally { value.bridge.close(); }
});

test('a native queue-start accepted turn shares otherwise-unbroadcast input with other browsers', async () => {
  const value = fixture();
  const origin = new Browser(); const other = new Browser();
  value.bridge.attach('session:origin', origin.ws(), 'origin'); value.bridge.attach('session:other', other.ws(), 'other');
  try {
    await value.bridge.connect();
    origin.request({ id: 'queue-start', method: 'thread/queue/start', params: { threadId: 't', queuedSubmissionId: 'q' } });
    await tick();
    const turn = { id: 'queued-turn', status: 'inProgress', items: [{ id: 'queued-user', type: 'userMessage', content: [{ type: 'text', text: 'Queued input' }] }] };
    value.receive({ id: value.sent.find(message => message.method === 'thread/queue/start')!.id, result: { turn, queuedSubmissionId: 'q' } }); await tick();
    const change = other.sent.find(message => message.method === 'bridge/thread/changed')!.params as any;
    assert.equal(change.method, 'turn/start'); assert.deepEqual(change.result.turn, turn);
    assert.equal(origin.sent.filter(message => message.id === 'queue-start').length, 1);
  } finally { value.bridge.close(); }
});

test('accepted next-turn settings sync to other browsers without broadcasting private config or rejected settings', async () => {
  const value = fixture(); const origin = new Browser(), other = new Browser();
  value.bridge.attach('session:origin', origin.ws(), 'origin'); value.bridge.attach('session:other', other.ws(), 'other');
  try {
    await value.bridge.connect();
    const settings = { threadId: 't', cwd: '/project', model: 'new-model', effort: 'high', sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never', config: { private: 'secret' } };
    origin.request({ id: 'settings', method: 'thread/settings/update', params: settings }); await tick();
    assert.equal(other.sent.some(message => message.method === 'bridge/thread/changed'), false);
    value.receive({ id: value.sent.find(message => message.method === 'thread/settings/update')!.id, result: {} }); await tick();
    const change = other.sent.find(message => message.method === 'bridge/thread/changed')!.params as any;
    assert.equal(change.method, 'thread/settings/update');
    assert.equal(change.threadId, 't');
    assert.deepEqual(change.request, { cwd: '/project', model: 'new-model', effort: 'high', sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never' });
    assert.doesNotMatch(JSON.stringify(change), /secret|private/);
    assert.equal(origin.sent.some(message => message.method === 'bridge/thread/changed'), false);
    origin.request({ id: 'rejected', method: 'thread/settings/update', params: { threadId: 't', model: 'bad' } }); await tick();
    value.receive({ id: value.sent.filter(message => message.method === 'thread/settings/update').at(-1)!.id, error: { code: -32000, message: 'Denied' } }); await tick();
    assert.equal(other.sent.filter(message => message.method === 'bridge/thread/changed').length, 1);
  } finally { value.bridge.close(); }
});

test('a second compaction rejection cannot clear running progress; a timed out request cannot leave sticky progress', async () => {
  const value = fixture()
  try {
    await value.bridge.connect()
    const first = value.bridge.request('thread/compact/start', { threadId: 'compacting-thread' })
    await tick()
    const accepted = value.sent.filter(message => message.method === 'thread/compact/start').at(-1)!
    value.receive({ id: accepted.id, result: {} }); await first
    assert.equal(value.bridge.threadContext('compacting-thread').compacting, true, 'Acknowledgement is not completion')
    value.receive({ method: 'item/started', params: { threadId: 'compacting-thread', turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } } })
    const duplicate = value.bridge.request('thread/compact/start', { threadId: 'compacting-thread' })
    const rejected = assert.rejects(duplicate, /already running/)
    await tick()
    const duplicateRequest = value.sent.filter(message => message.method === 'thread/compact/start').at(-1)!
    value.receive({ id: duplicateRequest.id, error: { code: -32000, message: 'already running' } }); await rejected
    assert.equal(value.bridge.threadContext('compacting-thread').compacting, true)
    value.receive({ method: 'turn/completed', params: { threadId: 'compacting-thread', turn: { id: 'unrelated-turn', status: 'completed' } } })
    assert.equal(value.bridge.threadContext('compacting-thread').compacting, true)
    value.receive({ method: 'item/completed', params: { threadId: 'compacting-thread', turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } } })
    assert.equal(value.bridge.threadContext('compacting-thread').compacting, false)
    const timedOut = value.bridge.request('thread/compact/start', { threadId: 'timeout-thread' }, 10)
    const timeoutAssertion = assert.rejects(timedOut, /timed out/)
    await new Promise(resolve => setTimeout(resolve, 20)); await timeoutAssertion
    assert.equal(value.bridge.threadContext('timeout-thread').compacting, false)
    const old = value.sent.filter(message => message.method === 'thread/compact/start').at(-1)!
    value.receive({ id: old.id, error: { code: -32000, message: 'late failure' } })
    assert.equal(value.bridge.threadContext('timeout-thread').compacting, false)
  } finally { value.bridge.close() }
})
function fixture(options: BridgeOptions = {}, host: Host = { id: 'local', kind: 'local', name: 'Test' }) {
  const input = new PassThrough()
  const output = new PassThrough()
  const sent: RpcMessage[] = []
  let buffer = ''
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'); const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      const message = JSON.parse(line) as RpcMessage; sent.push(message)
      if (message.method === 'initialize') queueMicrotask(() => receive({ id: message.id, result: { userAgent: 'test', codexHome: '/codex' } }))
    }
  })
  const receive = (message: RpcMessage) => output.write(`${JSON.stringify(message)}\n`)
  const transport: Transport = { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } }
  const bridge = new Bridge(host, { ...options, transportFactory: () => transport })
  return { bridge, sent, receive }
}

/** An isolated protocol peer allows reconnection without launching SSH or Codex. */
function reconnectableTransport() {
  const input = new PassThrough()
  const output = new PassThrough()
  const events = new EventEmitter()
  const sent: RpcMessage[] = []
  let buffer = ''
  let disposed = false
  input.on('data', chunk => {
    buffer += chunk.toString()
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at)) as RpcMessage
      buffer = buffer.slice(at + 1)
      sent.push(message)
      if (message.method === 'initialize') queueMicrotask(() => {
        if (!disposed) output.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'isolated-test' } })}\n`)
      })
    }
  })
  const transport: Transport = { input, output, events, dispose: () => { disposed = true; input.destroy(); output.destroy() } }
  return { transport, sent }
}

test('pausing releases only this client subscription in proxy mode and keeps every browser paused until explicit resume', async () => {
  const peers: ReturnType<typeof reconnectableTransport>[] = []
  const bridge = new Bridge({ id: 'local', kind: 'local', name: 'Proxy fixture' }, { mode: 'proxy', transportFactory: () => { const value = reconnectableTransport(); peers.push(value); return value.transport } })
  try {
    const first = new Browser(); const second = new Browser()
    bridge.attach('session:first', first.ws(), 'first'); bridge.attach('session:second', second.ws(), 'second')
    await bridge.connect()
    const joining = bridge.request('thread/resume', { threadId: 'web-thread' })
    await tick()
    const resumeRequest = peers[0]!.sent.find(message => message.method === 'thread/resume')!
    peers[0]!.transport.output.emit('data', Buffer.from(`${JSON.stringify({ id: resumeRequest.id, result: { thread: { id: 'web-thread', status: { type: 'active' } } } })}\n`))
    await joining
    peers[0]!.transport.output.emit('data', Buffer.from(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'unrelated-desktop-thread' } } })}\n`))
    assert.equal(bridge.runtime.loadedThreadCount, 1); assert.equal(bridge.runtime.activeThreadCount, 1)
    assert.equal(bridge.runtime.managed, false)
    const paused = bridge.pause()
    await tick()
    const requests = peers[0]!.sent.filter(message => message.method === 'thread/unsubscribe')
    assert.deepEqual(requests.map(message => message.params), [{ threadId: 'web-thread' }])
    peers[0]!.transport.output.emit('data', Buffer.from(`${JSON.stringify({ id: requests[0]!.id, result: { status: 'unsubscribed' } })}\n`))
    await paused
    for (const browser of [first, second]) {
      const status = browser.sent.filter(message => message.method === 'bridge/status').at(-1)!.params as { paused: boolean; connected: boolean }
      assert.equal(status.paused, true); assert.equal(status.connected, false)
      assert.equal(browser.readyState, 1)
    }
    const recovered = new Browser(); bridge.attach('session:recovered', recovered.ws(), 'recovered')
    recovered.request({ id: 123, method: 'thread/list', params: {} })
    await tick()
    assert.equal(peers.length, 1, 'Reconnect and RPC must never rebuild a manually released runtime')
    assert.equal((recovered.sent.find(message => message.id === 123)?.error?.data as { code?: string })?.code, 'runtime_paused')
    await bridge.resume()
    assert.equal(peers.length, 2); assert.equal(bridge.connected, true); assert.equal(bridge.paused, false)
  } finally { bridge.close() }
})

test('pausing during host-key resolution prevents a transport start until explicit resume', async () => {
  let resolvePin: ((value: SSHHostKeyPin) => void) | undefined
  let count = 0
  const bridge = new Bridge({ id: 'ssh-test', kind: 'ssh', name: 'Fixture', hostname: 'fixture.test' }, {
    resolveSshHostKeyPin: () => new Promise(resolve => { resolvePin = resolve }),
    transportFactory: () => { count++; return reconnectableTransport().transport },
  })
  try {
    const connection = bridge.connect()
    const rejected = assert.rejects(connection, /Host connection was closed/)
    await bridge.pause()
    resolvePin!({ file: '/fixture/key', hostKeyAlias: 'fixture.test' })
    await rejected
    assert.equal(count, 0)
    assert.equal(bridge.paused, true)
  } finally { bridge.close() }
})

const sshResolverHost: Host = { id: 'ssh-pinned', kind: 'ssh', name: 'Pinned fixture', hostname: 'host.example.test', username: 'test', port: 2222 }

test('SSH trust is resolved before each fresh transport while tabs and simultaneous connects reuse the running engine', async () => {
  const transports: ReturnType<typeof reconnectableTransport>[] = []
  const resolved: string[] = []
  let currentKnownHostsFile = { file: '/fixture/known_hosts-first', hostKeyAlias: 'host.example.test' }
  const bridge = new Bridge(sshResolverHost, {
    resolveSshHostKeyPin: async host => {
      assert.equal(host, sshResolverHost)
      resolved.push(currentKnownHostsFile.file)
      return currentKnownHostsFile
    },
    transportFactory: () => {
      assert.equal(resolved.length, transports.length + 1, 'Trust must resolve before a new transport starts')
      const peer = reconnectableTransport()
      transports.push(peer)
      return peer.transport
    },
  })
  try {
    const firstTab = new Browser()
    bridge.attach('session:first', firstTab.ws(), 'first')
    await Promise.all([bridge.connect(), bridge.connect()])
    assert.equal(bridge.connected, true)
    assert.equal(transports.length, 1)
    assert.deepEqual(resolved, ['/fixture/known_hosts-first'])
    currentKnownHostsFile = { file: '/fixture/known_hosts-replaced', hostKeyAlias: 'host.example.test' }
    firstTab.close()
    const newTab = new Browser()
    bridge.attach('session:second', newTab.ws(), 'second')
    await bridge.connect()
    assert.equal(transports.length, 1)
    assert.equal(resolved.length, 1, 'Browser reconnection must retain the existing app-server')
    transports[0]!.transport.events.emit('transportClose', new Error('Fixture connection dropped'))
    assert.equal(bridge.connected, false)
    await Promise.all([bridge.connect(), bridge.connect()])
    assert.equal(bridge.connected, true)
    assert.equal(transports.length, 2)
    assert.deepEqual(resolved, ['/fixture/known_hosts-first', '/fixture/known_hosts-replaced'])
    for (const peer of transports) assert.equal(peer.sent.filter(message => message.method === 'initialize').length, 1)
  } finally { bridge.close() }
})

test('closing a bridge while SSH trust resolution is pending prevents any transport from starting', async () => {
  let release: ((pin: SSHHostKeyPin) => void) | undefined
  let transportsCreated = 0
  const bridge = new Bridge(sshResolverHost, {
    resolveSshHostKeyPin: () => new Promise(resolve => { release = resolve }),
    transportFactory: () => { transportsCreated++; throw new Error('Unexpected transport creation') },
  })
  const connecting = bridge.connect()
  const rejected = assert.rejects(connecting, /Host connection was closed/)
  assert.equal(typeof release, 'function')
  assert.equal(transportsCreated, 0)
  bridge.close()
  release!({ file: '/fixture/known_hosts', hostKeyAlias: 'host.example.test' })
  await rejected
  assert.equal(transportsCreated, 0)
  assert.equal(bridge.connected, false)
  assert.equal(bridge.lastError, 'Host connection closed')
})

test('SSH trust resolution failures start no transport and reach the connected browser as an error status', async () => {
  let transportsCreated = 0
  const failure = new Error('SSH fingerprint records could not be verified')
  const bridge = new Bridge(sshResolverHost, {
    resolveSshHostKeyPin: async () => { throw failure },
    transportFactory: () => { transportsCreated++; throw new Error('Unexpected transport creation') },
  })
  try {
    const browser = new Browser()
    bridge.attach('session:test', browser.ws(), 'test')
    await assert.rejects(bridge.connect(), error => error === failure)
    assert.equal(transportsCreated, 0)
    assert.equal(bridge.connected, false)
    assert.equal(bridge.lastError, failure.message)
    const status = browser.sent.filter(message => message.method === 'bridge/status').at(-1)!.params as { connected: boolean; error?: string }
    assert.deepEqual({ connected: status.connected, error: status.error }, { connected: false, error: failure.message })
  } finally { bridge.close() }
})

test('local engines do not inspect SSH trust even when the service provides a resolver', async () => {
  let resolutions = 0
  const peer = reconnectableTransport()
  const bridge = new Bridge({ id: 'local', kind: 'local', name: 'Local fixture' }, {
    resolveSshHostKeyPin: async () => { resolutions++; throw new Error('Unexpected SSH lookup') },
    transportFactory: () => peer.transport,
  })
  try {
    await bridge.connect()
    assert.equal(bridge.connected, true)
    assert.equal(resolutions, 0)
    assert.equal(peer.sent.filter(message => message.method === 'initialize').length, 1)
  } finally { bridge.close() }
})

test('bridge initializes once and routes same browser IDs to their own tab', async () => {
  const f = fixture()
  try {
    const a = new Browser(); const b = new Browser()
    f.bridge.attach('session:browser_a', a.ws(), 'browser_a')
    f.bridge.attach('session:browser_b', b.ws(), 'browser_b')
    await tick()
    assert.equal(f.sent.filter(m => m.method === 'initialize').length, 1)
    assert.deepEqual((f.sent.find(m => m.method === 'initialize')!.params as { clientInfo: unknown }).clientInfo,
      { name: 'codex_web', title: 'Codex Web', version: '0.1.0' })
    assert.ok(f.sent.some(m => m.method === 'initialized'))
    a.request({ id: 1, method: 'model/list', params: { includeHidden: true } })
    b.request({ id: 1, method: 'thread/list', params: { limit: 7 } })
    await tick()
    const ra = f.sent.find(m => m.method === 'model/list')!
    const rb = f.sent.find(m => m.method === 'thread/list')!
    assert.notEqual(ra.id, rb.id)
    assert.deepEqual(ra.params, { includeHidden: true })
    f.receive({ id: rb.id, result: { threads: ['b'] } })
    f.receive({ id: ra.id, result: { models: ['a'] } })
    await tick()
    assert.deepEqual(a.sent.filter(m => m.id === 1), [{ id: 1, result: { models: ['a'] } }])
    assert.deepEqual(b.sent.filter(m => m.id === 1), [{ id: 1, result: { threads: ['b'] } }])
  } finally { f.bridge.close() }
})

test('accepted conversation responses sync across browser sessions while response IDs stay private', async () => {
  const f = fixture()
  try {
    const desktop = new Browser(); const phone = new Browser()
    f.bridge.attach('desktop-session:desktop', desktop.ws(), 'desktop')
    f.bridge.attach('phone-session:phone', phone.ws(), 'phone')
    await tick()
    const input = [{ type: 'text', text: '另一个页面发送的消息', text_elements: [] }]
    desktop.request({ id: 1, method: 'turn/start', params: {
      threadId: 'shared-thread', input, clientUserMessageId: 'client-message',
      config: { private_setting: 'must-not-broadcast' },
    } })
    await tick()
    const accepted = f.sent.find(message => message.method === 'turn/start')!
    const turn = { id: 'shared-turn', status: 'inProgress', items: [
      { id: 'canonical-message', type: 'userMessage', clientId: 'client-message', content: input },
    ] }
    f.receive({ id: accepted.id, result: { turn } })
    await tick()
    assert.deepEqual(desktop.sent.filter(message => message.id === 1), [{ id: 1, result: { turn } }])
    assert.equal(phone.sent.some(message => message.id === 1), false)
    assert.equal(desktop.sent.some(message => message.method === 'bridge/thread/changed'), false)
    assert.deepEqual(phone.sent.filter(message => message.method === 'bridge/thread/changed'), [{
      method: 'bridge/thread/changed', bridgeEventSequence: 1, params: {
        threadId: 'shared-thread', method: 'turn/start', result: { turn },
        request: { input, clientUserMessageId: 'client-message' },
        changeId: accepted.id, originClientId: 'desktop',
      },
    }])
    assert.doesNotMatch(JSON.stringify(phone.sent), /desktop-session|private_setting|must-not-broadcast/)
    f.receive({ method: 'item/agentMessage/delta', params: { threadId: 'shared-thread', itemId: 'answer', turnId: turn.id, delta: '实时输出' } })
    assert.ok(desktop.sent.some(message => message.method === 'item/agentMessage/delta'))
    assert.ok(phone.sent.some(message => message.method === 'item/agentMessage/delta'))
  } finally { f.bridge.close() }
})

test('steering, rename and revert sync only after success, and private reads never broadcast', async () => {
  const f = fixture()
  try {
    const a = new Browser(); const b = new Browser()
    f.bridge.attach('session:a', a.ws(), 'a')
    f.bridge.attach('session:b', b.ws(), 'b')
    await tick()
    const input = [{ type: 'text', text: '追加消息' }]
    const mutations = [
      { method: 'turn/steer', params: { threadId: 'same', input, clientUserMessageId: 'steered' }, result: { turnId: 'running' } },
      { method: 'thread/name/set', params: { threadId: 'same', name: '同步标题' }, result: {} },
      { method: 'thread/revert', params: { threadId: 'same', beforeTurnId: 'running' }, result: { thread: { id: 'same', turns: [] } } },
    ]
    for (const [index, mutation] of mutations.entries()) {
      a.request({ id: index, method: mutation.method, params: mutation.params })
      await tick()
      const request = f.sent.findLast(message => message.method === mutation.method)!
      const before = b.sent.filter(message => message.method === 'bridge/thread/changed').length
      assert.equal(before, index)
      f.receive({ id: request.id, result: mutation.result })
      await tick()
      const change = b.sent.filter(message => message.method === 'bridge/thread/changed').at(-1)!
      assert.equal((change.params as any).method, mutation.method)
      assert.equal((change.params as any).threadId, 'same')
    }
    const before = b.sent.length
    a.request({ id: 'failure', method: 'turn/start', params: { threadId: 'same', input } })
    a.request({ id: 'private', method: 'config/read', params: {} })
    await tick()
    const failed = f.sent.findLast(message => message.method === 'turn/start')!
    const read = f.sent.findLast(message => message.method === 'config/read')!
    f.receive({ id: failed.id, error: { code: -32600, message: 'another writer rejected input' } })
    f.receive({ id: read.id, result: { config: { secret: 'not-conversation-data' } } })
    await tick()
    assert.equal(b.sent.length, before)
    assert.ok(a.sent.some(message => message.id === 'failure' && message.error))
    assert.ok(a.sent.some(message => message.id === 'private' && message.result))
  } finally { f.bridge.close() }
})

test('accepted input reaches other web clients when its initiating socket disconnects', async () => {
  const f = fixture()
  try {
    const writer = new Browser(); const observer = new Browser()
    f.bridge.attach('session:writer', writer.ws(), 'writer')
    f.bridge.attach('session:observer', observer.ws(), 'observer')
    await tick()
    writer.request({ id: 7, method: 'turn/steer', params: {
      threadId: 'shared', input: [{ type: 'text', text: '已接受的补充' }], clientUserMessageId: 'client-id',
    } })
    await tick()
    writer.close()
    const recovered = new Browser()
    f.bridge.attach('session:writer', recovered.ws(), 'writer')
    const request = f.sent.find(message => message.method === 'turn/steer')!
    f.receive({ id: request.id, result: { turnId: 'turn' } })
    await tick()
    assert.equal(observer.sent.filter(message => message.method === 'bridge/thread/changed').length, 1)
    assert.equal(recovered.sent.filter(message => message.method === 'bridge/thread/changed').length, 1)
    assert.equal(recovered.sent.some(message => message.id === 7), false)
    assert.equal(observer.sent.some(message => message.id === 7), false)
  } finally { f.bridge.close() }
})

test('accepted input reaches a replacement socket when the sender reconnects during engine initialization', async () => {
  const f = fixture()
  try {
    const writer = new Browser()
    f.bridge.attach('session:writer', writer.ws(), 'writer')
    writer.request({ id: 7, method: 'turn/steer', params: {
      threadId: 'thread-shared', expectedTurnId: 'turn-shared',
      input: [{ type: 'text', text: 'Accepted during initialization' }], clientUserMessageId: 'input-shared',
    } })
    assert.equal(f.sent.some(message => message.method === 'turn/steer'), false)
    writer.close()
    const recovered = new Browser()
    f.bridge.attach('session:writer', recovered.ws(), 'writer')
    await tick()
    const accepted = f.sent.find(message => message.method === 'turn/steer')!
    assert.ok(accepted)
    f.receive({ id: accepted.id, result: { turnId: 'turn-shared' } })
    await tick()
    const changes = recovered.sent.filter(message => message.method === 'bridge/thread/changed')
    assert.equal(changes.length, 1)
    assert.equal((changes[0].params as any).request.clientUserMessageId, 'input-shared')
    assert.equal(recovered.sent.some(message => message.id === 7), false)
  } finally { f.bridge.close() }
})

test('a configured client name initializes local and SSH engines without rewriting new or resumed thread requests', async t => {
  const hosts: Host[] = [
    { id: 'local', kind: 'local', name: 'Local' },
    { id: 'remote', kind: 'ssh', name: 'Remote', hostname: 'remote.test', username: 'test', port: 2222 },
  ]
  for (const host of hosts) await t.test(host.kind, async () => {
    const f = fixture({ clientName: host.kind === 'ssh' ? '  codex_cli_rs  ' : 'codex_cli_rs' }, host)
    try {
      await f.bridge.connect()
      const initialize = f.sent.filter(message => message.method === 'initialize')
      assert.equal(initialize.length, 1)
      assert.deepEqual(initialize[0].params, {
        clientInfo: { name: 'codex_cli_rs', title: 'Codex Web', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
      const startParams = {
        cwd: '/workspace/project', runtimeWorkspaceRoots: ['/workspace/project'],
        model: 'test-model', modelProvider: 'test-provider',
        sandbox: 'workspace-write', approvalPolicy: 'on-request',
      }
      const started = f.bridge.request('thread/start', startParams)
      await tick()
      const start = f.sent.find(message => message.method === 'thread/start')!
      assert.deepEqual(start.params, startParams)
      f.receive({ id: start.id, result: { thread: { id: 'test-thread' } } })
      await started
      const resumeParams = { threadId: 'test-thread', excludeTurns: true }
      const resumed = f.bridge.request('thread/resume', resumeParams)
      await tick()
      const resume = f.sent.find(message => message.method === 'thread/resume')!
      assert.deepEqual(resume.params, resumeParams)
      f.receive({ id: resume.id, result: { thread: { id: 'test-thread' } } })
      await resumed
      assert.equal(f.sent.filter(message => message.method === 'initialize').length, 1)
      assert.ok(!f.sent.some(message => typeof message.params === 'object' && message.params !== null && Object.hasOwn(message.params, 'overrideClientName')))
    } finally { f.bridge.close() }
  })
})

test('invalid client names are rejected before creating an app-server transport', () => {
  let transportsCreated = 0
  const invalid = ['codex/cli', 'codex web', 'codex\nweb', '\ncodex_web', 'codex_web\t', 'codex\u0000web', '客户端', '.codex', '-codex', '_codex', 'a'.repeat(65)]
  for (const clientName of invalid) {
    assert.throws(() => new Bridge({ id: 'local', kind: 'local', name: 'Test' }, {
      clientName,
      transportFactory: () => { transportsCreated++; throw new Error('Unexpected transport creation') },
    }), undefined, JSON.stringify(clientName))
  }
  assert.equal(transportsCreated, 0)
})

test('all authenticated tabs see approvals, first response wins and pending requests survive reconnect', async () => {
  const f = fixture()
  try {
    const a = new Browser(); const b = new Browser()
    f.bridge.attach('session:browser_a', a.ws(), 'browser_a')
    f.bridge.attach('session:browser_b', b.ws(), 'browser_b')
    await tick()
    a.request({ id: 'turn', method: 'turn/start', params: { threadId: 'thread-a', input: [] } })
    await tick()
    const turn = f.sent.find(m => m.method === 'turn/start')!
    f.receive({ id: turn.id, result: { turn: { id: 'turn-a' } } })
    const approval = { id: 55, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', itemId: 'item-a' } }
    f.receive(approval)
    await tick()
    assert.ok(a.sent.some(m => m.method === approval.method))
    assert.ok(b.sent.some(m => m.method === approval.method))
    b.request({ id: 999, result: { decision: 'accept' } })
    await tick()
    assert.ok(b.sent.some(m => m.method === 'bridge/error'))
    assert.ok(!f.sent.some(m => m.id === 999))
    b.request({ id: 55, result: { decision: 'decline' } })
    a.request({ id: 55, result: { decision: 'accept' } })
    await tick()
    assert.deepEqual(f.sent.filter(m => m.id === 55), [{ id: 55, result: { decision: 'decline' } }])
    assert.ok(a.sent.some(m => m.method === 'bridge/error'))
    const nextApproval = { ...approval, id: 56 }
    f.receive(nextApproval)
    a.close()
    b.close()
    const recovered = new Browser()
    f.bridge.attach('session:browser_b', recovered.ws(), 'browser_b')
    const welcome = recovered.sent.find(m => m.method === 'bridge/status')!
    assert.deepEqual((welcome.params as { pendingRequests: RpcMessage[] }).pendingRequests, [nextApproval])
    recovered.request({ id: 56, result: { decision: 'accept' } })
    await tick()
    assert.deepEqual(f.sent.find(m => m.id === 56), { id: 56, result: { decision: 'accept' } })
  } finally { f.bridge.close() }
})

test('timed questions skip with an empty answer once even without a browser', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791550000000 })
  const observed: RpcMessage[] = []
  const f = fixture({ onProtocolMessage: (_host, message) => { observed.push(message) } })
  try {
    await f.bridge.connect()
    f.receive({ id: 'timed', method: 'item/tool/requestUserInput', params: {
      threadId: 't', turnId: 'turn', isBlocking: false, autoResolutionMs: 1000,
      questions: [{ id: 'choice', options: [{ label: 'Recommended' }] }],
    } })
    const prompt = observed.find(message => message.id === 'timed')!
    assert.deepEqual((prompt.params as any).bridgeUserInputContext, { requestedAt: 1791550000000, autoResolveAt: 1791550001000 })
    t.mock.timers.tick(999)
    assert.equal(f.sent.some(message => message.id === 'timed'), false)
    t.mock.timers.tick(1)
    assert.deepEqual(f.sent.filter(message => message.id === 'timed'), [{ id: 'timed', result: { answers: {} } }])
    assert.ok(observed.some(message => message.method === 'serverRequest/resolved' && (message.params as any).requestId === 'timed'))
    const browser = new Browser(); f.bridge.attach('reader', browser.ws(), 'reader')
    assert.equal((browser.sent.find(message => message.method === 'bridge/status')!.params as any).pendingRequests.length, 0)
    t.mock.timers.tick(100000)
    assert.equal(f.sent.filter(message => message.id === 'timed').length, 1)
  } finally { f.bridge.close() }
})

test('a question retains its deadline through duplicate delivery and browser reconnect and an explicit answer wins once', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791550000000 })
  const f = fixture(); const first = new Browser(); const second = new Browser()
  try {
    await f.bridge.connect()
    f.bridge.attach('first', first.ws(), 'first'); f.bridge.attach('second', second.ws(), 'second')
    const prompt = { id: 44, method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'turn', isBlocking: true, autoResolutionMs: 10000, questions: [] } }
    f.receive(prompt)
    first.close(); second.close(); t.mock.timers.tick(5000)
    f.receive(prompt)
    const recovered = new Browser(); f.bridge.attach('first', recovered.ws(), 'first')
    const pending = (recovered.sent.find(message => message.method === 'bridge/status')!.params as any).pendingRequests[0]
    assert.equal(pending.params.bridgeUserInputContext.autoResolveAt, 1791550010000)
    const result = { answers: { choice: { answers: ['My explicit answer'] } } }
    recovered.request({ id: 44, result }); await tick()
    t.mock.timers.tick(10000)
    recovered.request({ id: 44, result: { answers: {} } }); await tick()
    assert.deepEqual(f.sent.filter(message => message.id === 44), [{ id: 44, result }])
  } finally { f.bridge.close() }
})

test('only a finite question timeout creates a timer, independently of blocking status', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791550000000 })
  const f = fixture(); const browser = new Browser()
  try {
    await f.bridge.connect(); f.bridge.attach('reader', browser.ws(), 'reader')
    for (const [index, value] of [undefined, null, -1, 1.5, '1000', Number.MAX_SAFE_INTEGER].entries()) {
      f.receive({ id: 'untimed-' + index, method: 'item/tool/requestUserInput', params: { threadId: 't', isBlocking: false, autoResolutionMs: value } })
    }
    f.receive({ id: 'command', method: 'item/commandExecution/requestApproval', params: { threadId: 't', autoResolutionMs: 0, bridgeUserInputContext: { autoResolveAt: 0 } } })
    t.mock.timers.tick(120000)
    assert.equal(f.sent.some(message => String(message.id).startsWith('untimed-') || message.id === 'command'), false)
    f.receive({ id: 'immediate', method: 'tool/requestUserInput', params: { threadId: 't', isBlocking: true, autoResolutionMs: 0 } })
    t.mock.timers.tick(1)
    assert.deepEqual(f.sent.find(message => message.id === 'immediate')?.result, { answers: {} })
  } finally { f.bridge.close() }
})

test('resolved questions, completed turns and a closed bridge never receive a late automatic answer', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791550000000 })
  const f = fixture()
  try {
    await f.bridge.connect()
    const ask = (id: string, turnId: string) => f.receive({ id, method: 'item/tool/requestUserInput', params: { threadId: 't', turnId, autoResolutionMs: 1000 } })
    ask('resolved', 'old')
    f.receive({ method: 'serverRequest/resolved', params: { requestId: 'resolved', threadId: 't' } })
    ask('completed', 'old')
    f.receive({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'old', status: 'completed' } } })
    ask('current', 'new')
    f.receive({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'old', status: 'completed' } } })
    t.mock.timers.tick(1000)
    assert.equal(f.sent.some(message => ['resolved', 'completed'].includes(String(message.id))), false)
    assert.deepEqual(f.sent.find(message => message.id === 'current')?.result, { answers: {} })
    ask('closed', 'latest'); f.bridge.close(); t.mock.timers.tick(1000)
    assert.equal(f.sent.some(message => message.id === 'closed'), false)
  } finally { f.bridge.close() }
})

test('nonblocking questions survive turn changes until native resolution or their own deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791550000000 })
  const f = fixture()
  try {
    await f.bridge.connect()
    for (const id of ['native', 'deadline']) f.receive({ id, method: 'item/tool/requestUserInput', params: {
      threadId: 't', turnId: 'old', isBlocking: false, autoResolutionMs: 1000,
    } })
    f.receive({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'old', status: 'completed' } } })
    f.receive({ method: 'turn/started', params: { threadId: 't', turn: { id: 'new', status: 'inProgress' } } })
    const recovered = new Browser(); f.bridge.attach('reader', recovered.ws(), 'reader')
    assert.deepEqual((recovered.sent[0].params as any).pendingRequests.map((request: any) => request.id).sort(), ['deadline', 'native'])
    f.receive({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 'native' } })
    t.mock.timers.tick(1000)
    assert.deepEqual(f.sent.filter(message => message.id === 'deadline'), [{ id: 'deadline', result: { answers: {} } }])
    assert.equal(f.sent.some(message => message.id === 'native'), false)
    f.receive({ id: 'closed', method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'new', isBlocking: false, autoResolutionMs: 1000 } })
    f.receive({ method: 'thread/closed', params: { threadId: 't' } })
    t.mock.timers.tick(1000)
    assert.equal(f.sent.some(message => message.id === 'closed'), false)
  } finally { f.bridge.close() }
})

test('a delayed event loop rejects answers after the original question deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791550000000 })
  const f = fixture(); const browser = new Browser()
  try {
    await f.bridge.connect(); f.bridge.attach('reader', browser.ws(), 'reader')
    f.receive({ id: 'late', method: 'item/tool/requestUserInput', params: { threadId: 't', autoResolutionMs: 1000 } })
    t.mock.timers.setTime(1791550002000)
    browser.request({ id: 'late', result: { answers: { choice: { answers: ['Late answer'] } } } }); await tick()
    assert.deepEqual(f.sent.filter(message => message.id === 'late'), [{ id: 'late', result: { answers: {} } }])
    assert.ok(browser.sent.some(message => message.method === 'bridge/error' && (message.params as any).requestId === 'late'))
  } finally { f.bridge.close() }
})

test('app-server errors retain the original browser ID and protocol error', async () => {
  const f = fixture()
  try {
    const browser = new Browser(); f.bridge.attach('session:browser_a', browser.ws(), 'browser_a')
    await tick()
    browser.request({ id: 'read', method: 'thread/read', params: { threadId: 'missing' } })
    await tick()
    const request = f.sent.find(m => m.method === 'thread/read')!
    f.receive({ id: request.id, error: { code: -32602, message: 'missing thread', data: { why: 'missing' } } })
    await tick()
    assert.deepEqual(browser.sent.find(m => m.id === 'read'), { id: 'read', error: { code: -32602, message: 'missing thread', data: { why: 'missing' } } })
  } finally { f.bridge.close() }
})

test('remote executable quoting preserves shell metacharacters as literal text', () => {
  assert.equal(shellQuote("/opt/it's codex;$(whoami)"), "'/opt/it'\"'\"'s codex;$(whoami)'")
})

test('running terminal survives browser disconnect and completion reaches reconnected tabs', async () => {
  const f = fixture()
  try {
    const owner = new Browser(); f.bridge.attach('session:owner_tab', owner.ws(), 'owner_tab')
    await tick()
    owner.request({ id: 7, method: 'command/exec', params: { command: ['/bin/sh'], processId: 'test-pty', tty: true, cwd: '/workspace', disableTimeout: true } })
    await tick()
    const command = f.sent.find(message => message.method === 'command/exec')!
    // Preserve UTF-8 characters even when an output chunk splits a codepoint.
    const character = Buffer.from('你好')
    f.receive({ method: 'command/exec/outputDelta', params: { processId: 'test-pty', stream: 'stdout', deltaBase64: character.subarray(0, 2).toString('base64') } })
    f.receive({ method: 'command/exec/outputDelta', params: { processId: 'test-pty', stream: 'stdout', deltaBase64: character.subarray(2).toString('base64') } })
    owner.close()
    const recovered = new Browser(); f.bridge.attach('session:owner_tab', recovered.ws(), 'owner_tab')
    const status = recovered.sent.find(message => message.method === 'bridge/status')!.params as { activeProcesses: { processId: string; tty: boolean; lastOutput: string }[] }
    assert.equal(status.activeProcesses.length, 1)
    assert.equal(status.activeProcesses[0].processId, 'test-pty')
    assert.equal(status.activeProcesses[0].tty, true)
    assert.equal(status.activeProcesses[0].lastOutput, '你好')
    const phone = new Browser(); f.bridge.attach('other-session:phone_tab', phone.ws(), 'phone_tab')
    f.receive({ id: command.id, result: { exitCode: 0, stdout: '', stderr: '' } })
    await tick()
    assert.ok(recovered.sent.some(message => message.method === 'bridge/terminal/completed' && (message.params as { processId?: string }).processId === 'test-pty'))
    assert.ok(phone.sent.some(message => message.method === 'bridge/terminal/completed'))
    const latest = recovered.sent.filter(message => message.method === 'bridge/status').at(-1)!.params as { activeProcesses: unknown[] }
    assert.deepEqual(latest.activeProcesses, [])
    assert.ok(!recovered.sent.some(message => message.id === 7))
    assert.ok(!phone.sent.some(message => message.id === 7))
  } finally { f.bridge.close() }
})

test('current-time callbacks are answered once without a browser, approval or replayed prompt', async () => {
  const value = fixture();
  try {
    await value.bridge.connect();
    const before = Math.floor(Date.now() / 1000);
    value.receive({ id: 'clock-request', method: 'currentTime/read', params: { threadId: 't' } });
    await tick();
    const answers = value.sent.filter(message => message.id === 'clock-request');
    assert.equal(answers.length, 1);
    const time = (answers[0].result as any).currentTimeAt;
    assert.ok(Number.isInteger(time) && time >= before && time <= Math.floor(Date.now() / 1000));
    const browser = new Browser(); value.bridge.attach('clock-reader', browser.ws(), 'clock-reader');
    assert.deepEqual((browser.sent.find(message => message.method === 'bridge/status')!.params as any).pendingRequests, []);
    assert.equal(browser.sent.some(message => message.method === 'currentTime/read'), false);
  } finally { value.bridge.close(); }
});

test('unsupported client tools and service callbacks fail in their native schema without becoming approvals', async () => {
  const value = fixture(); const browser = new Browser(); value.bridge.attach('reader', browser.ws(), 'reader');
  try {
    await value.bridge.connect();
    value.receive({ id: 321, method: 'item/tool/call', params: { threadId: 't', tool: 'desktop_only_tool', arguments: { token: 'private-argument' } } });
    value.receive({ id: 'attestation', method: 'attestation/generate', params: {} });
    value.receive({ id: 'future', method: 'future/clientCallback', params: { threadId: 't' } });
    await tick();
    const tool = value.sent.find(message => message.id === 321)!.result as any;
    assert.equal(tool.success, false); assert.equal(tool.contentItems[0].type, 'inputText');
    assert.equal(JSON.stringify(tool).includes('private-argument'), false);
    assert.equal(value.sent.find(message => message.id === 'attestation')!.error?.code, -32601);
    assert.equal(value.sent.find(message => message.id === 'future')!.error?.code, -32601);
    assert.equal(browser.sent.some(message => message.id === 321 || message.id === 'attestation' || message.id === 'future'), false);
    const again = new Browser(); value.bridge.attach('reconnected', again.ws(), 'reconnected');
    assert.deepEqual((again.sent[0].params as any).pendingRequests, []);
  } finally { value.bridge.close(); }
});

test('approval previews survive reconnects, match the exact item scope and never contain outputs or diffs', async () => {
  const value = fixture(); const browser = new Browser(); value.bridge.attach('reader', browser.ws(), 'reader');
  try {
    await value.bridge.connect();
    value.receive({ method: 'item/started', params: { threadId: 't', turnId: 'turn', item: { id: 'command', type: 'commandExecution', command: 'printf review-me', cwd: '/workspace', aggregatedOutput: 'private-output' } } });
    value.receive({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'turn', itemId: 'command', command: null, reason: null } });
    value.receive({ id: 'wrong-turn', method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'other-turn', itemId: 'command' } });
    value.receive({ method: 'item/started', params: { threadId: 't', turnId: 'turn', item: { id: 'file', type: 'fileChange', changes: [{ path: 'src/app.ts', diff: 'private-diff' }] } } });
    value.receive({ id: 'files', method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'turn', itemId: 'file' } });
    const again = new Browser(); value.bridge.attach('reconnected', again.ws(), 'reconnected');
    const requests = (again.sent[0].params as any).pendingRequests;
    assert.deepEqual(requests.find((r: any) => r.id === 'approval').params.bridgeApprovalContext, { command: 'printf review-me', cwd: '/workspace' });
    assert.equal(requests.find((r: any) => r.id === 'wrong-turn').params.bridgeApprovalContext, undefined);
    assert.deepEqual(requests.find((r: any) => r.id === 'files').params.bridgeApprovalContext, { filePaths: ['src/app.ts'] });
    assert.equal(JSON.stringify(requests).includes('private-output'), false);
    assert.equal(JSON.stringify(requests).includes('private-diff'), false);
    assert.equal(value.sent.some(message => message.id === 'approval'), false, 'A real approval still requires a decision');
    value.receive({ method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'command', type: 'commandExecution', command: 'x'.repeat(65 * 1024) } } });
    value.receive({ id: 'oversized', method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'turn', itemId: 'command' } });
    assert.equal((browser.sent.find(message => message.id === 'oversized')!.params as any).bridgeApprovalContext, undefined, 'An omitted oversized preview must not retain an older command');
    browser.request({ id: 'approval', result: { decision: 'accept' } }); await tick();
    assert.deepEqual(value.sent.find(message => message.id === 'approval')?.result, { decision: 'accept' });
  } finally { value.bridge.close(); }
});

test('successful permanent deletion synchronizes other clients and clears only that thread runtime and pending questions', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791550000000 })
  const observed: RpcMessage[] = []
  const f = fixture({ onProtocolMessage: (_host, message) => { observed.push(message) } })
  const owner = new Browser(), observer = new Browser()
  f.bridge.attach('session:owner', owner.ws(), 'owner'); f.bridge.attach('session:observer', observer.ws(), 'observer')
  try {
    await f.bridge.connect()
    for (const id of ['parent', 'child', 'unrelated']) {
      const resumed = f.bridge.request('thread/resume', { threadId: id }); await tick()
      f.receive({ id: f.sent.findLast(message => message.method === 'thread/resume')!.id, result: { thread: { id, name: `Name ${id}` } } })
      await resumed
      f.receive({ method: 'thread/tokenUsage/updated', params: { threadId: id, tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 } } })
    }
    f.receive({ method: 'item/started', params: { threadId: 'parent', turnId: 'old', item: { id: 'command', type: 'commandExecution', command: 'private old command' } } })
    f.receive({ id: 'parent-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'parent', turnId: 'old', itemId: 'command' } })
    f.receive({ id: 'parent-question', method: 'item/tool/requestUserInput', params: { threadId: 'parent', turnId: 'old', autoResolutionMs: 1000 } })
    f.receive({ id: 'unrelated-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'unrelated', turnId: 'other', itemId: 'other' } })
    owner.request({ id: 'delete', method: 'thread/delete', params: { threadId: 'parent' } }); await tick()
    const request = f.sent.findLast(message => message.method === 'thread/delete')!
    assert.ok(f.bridge.runtime.threads.some(thread => thread.id === 'parent'))
    f.receive({ id: request.id, result: {} }); await tick()
    const change = observer.sent.find(message => message.method === 'bridge/thread/changed' && (message.params as any).method === 'thread/delete')!
    assert.equal((change.params as any).threadId, 'parent')
    assert.equal(owner.sent.some(message => message.method === 'bridge/thread/changed' && (message.params as any).method === 'thread/delete'), false)
    const responseIndex = owner.sent.findIndex(message => message.id === 'delete')
    assert.ok(responseIndex >= 0 && responseIndex < owner.sent.findIndex(message => message.method === 'serverRequest/resolved'))
    assert.deepEqual(f.bridge.runtime.threads.map(thread => thread.id).sort(), ['child', 'unrelated'])
    assert.deepEqual(f.bridge.threadContext('parent'), { tokenUsage: null, compacting: false })
    assert.ok(f.bridge.threadContext('unrelated').tokenUsage)
    assert.deepEqual(observed.filter(message => message.method === 'serverRequest/resolved').map(message => (message.params as any).requestId).sort(), ['parent-approval', 'parent-question'])
    f.receive({ method: 'thread/deleted', params: { threadId: 'parent' } })
    f.receive({ method: 'thread/deleted', params: { threadId: 'child' } })
    assert.deepEqual(f.bridge.runtime.threads.map(thread => thread.id), ['unrelated'])
    assert.deepEqual(observer.sent.filter(message => message.method === 'thread/deleted').map(message => (message.params as any).threadId), ['parent', 'child'])
    assert.equal(observed.filter(message => message.method === 'serverRequest/resolved').length, 2, 'Response plus native event must clear each pending request only once')
    t.mock.timers.tick(1000)
    assert.equal(f.sent.some(message => message.id === 'parent-question'), false)
    const recovered = new Browser(); f.bridge.attach('recovered', recovered.ws(), 'recovered')
    assert.deepEqual((recovered.sent[0]!.params as any).pendingRequests.map((request: any) => request.id), ['unrelated-approval'])
    f.receive({ id: 'late-parent-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'parent', turnId: 'old', itemId: 'command' } })
    assert.equal((observer.sent.find(message => message.id === 'late-parent-approval')!.params as any).bridgeApprovalContext, undefined, 'Deletion must discard cached operation previews')
  } finally { f.bridge.close() }
})

test('active or failed native deletion preserves conversation state and never broadcasts accepted deletion', async () => {
  const f = fixture(), browser = new Browser(), observer = new Browser()
  f.bridge.attach('owner', browser.ws(), 'owner'); f.bridge.attach('observer', observer.ws(), 'observer')
  try {
    await f.bridge.connect()
    const resumed = f.bridge.request('thread/resume', { threadId: 'running' }); await tick()
    f.receive({ id: f.sent.findLast(message => message.method === 'thread/resume')!.id, result: { thread: { id: 'running', name: 'Keep this thread', status: { type: 'active' } } } }); await resumed
    f.receive({ method: 'thread/tokenUsage/updated', params: { threadId: 'running', tokenUsage: { last: { totalTokens: 10 } } } })
    browser.request({ id: 'active-delete', method: 'thread/delete', params: { threadId: 'running' } }); await tick()
    assert.match(browser.sent.find(message => message.id === 'active-delete')!.error!.message, /正在运行.*暂停/)
    assert.equal(f.sent.some(message => message.method === 'thread/delete'), false)
    f.receive({ method: 'turn/completed', params: { threadId: 'running', turn: { id: 'turn', status: 'completed' } } })
    browser.request({ id: 'unsupported-delete', method: 'thread/delete', params: { threadId: 'running' } }); await tick()
    const error = { code: -32601, message: 'Method not found' }
    f.receive({ id: f.sent.findLast(message => message.method === 'thread/delete')!.id, error }); await tick()
    assert.deepEqual(browser.sent.find(message => message.id === 'unsupported-delete')!.error, error)
    assert.equal(f.bridge.runtime.threads[0]!.name, 'Keep this thread')
    assert.ok(f.bridge.threadContext('running').tokenUsage)
    assert.equal(observer.sent.some(message => message.method === 'bridge/thread/changed' && (message.params as any).method === 'thread/delete'), false)
    assert.equal(f.sent.some(message => ['thread/archive', 'turn/interrupt', 'fs/remove'].includes(message.method || '')), false)
  } finally { f.bridge.close() }
})

test('permanent deletion cannot race the temporary archive and restore used to release a Web writer', async () => {
  const f = fixture()
  try {
    await f.bridge.connect()
    const resumed = f.bridge.request('thread/resume', { threadId: 'closing' }); await tick()
    f.receive({ id: f.sent.findLast(message => message.method === 'thread/resume')!.id, result: { thread: { id: 'closing', name: 'Closing thread' } } }); await resumed
    const closing = f.bridge.releaseThread('closing', async () => {}); void closing.catch(() => {})
    await tick()
    await assert.rejects(f.bridge.request('thread/delete', { threadId: 'unrelated-root' }), /正在关闭/)
    assert.equal(f.sent.some(message => message.method === 'thread/delete'), false)
    f.receive({ id: f.sent.findLast(message => message.method === 'thread/list')!.id, result: { data: [], nextCursor: null } }); await tick()
    f.receive({ id: f.sent.findLast(message => message.method === 'thread/archive')!.id, result: {} }); await tick()
    f.receive({ id: f.sent.findLast(message => message.method === 'thread/unarchive')!.id, result: { thread: { id: 'closing' } } }); await closing
    await assert.rejects(f.bridge.request('thread/delete', { threadId: 'closing' }), /资源管理中重新连接.*重试/)
    assert.equal(f.bridge.releasedThreads.has('closing'), true)
  } finally { f.bridge.close() }
})
