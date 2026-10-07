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
  sent: RpcMessage[] = []
  send(data: string) { this.sent.push(JSON.parse(data)) }
  request(message: RpcMessage) { this.emit('message', Buffer.from(JSON.stringify(message))) }
  close() { this.readyState = 3; this.emit('close') }
  ws() { return this as unknown as WebSocket }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
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
      method: 'bridge/thread/changed', params: {
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
