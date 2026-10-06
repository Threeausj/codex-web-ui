import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { WebSocket } from 'ws'
import { Bridge, shellQuote, type Transport } from './bridge.js'
import type { RpcMessage } from './types.js'

class Browser extends EventEmitter {
  readyState = 1
  sent: RpcMessage[] = []
  send(data: string) { this.sent.push(JSON.parse(data)) }
  request(message: RpcMessage) { this.emit('message', Buffer.from(JSON.stringify(message))) }
  close() { this.readyState = 3; this.emit('close') }
  ws() { return this as unknown as WebSocket }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture() {
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
  const bridge = new Bridge({ id: 'local', kind: 'local', name: 'Test' }, { transportFactory: () => transport })
  return { bridge, sent, receive }
}

test('bridge initializes once and routes same browser IDs to their own tab', async () => {
  const f = fixture()
  try {
    const a = new Browser(); const b = new Browser()
    f.bridge.attach('session:browser_a', a.ws(), 'browser_a')
    f.bridge.attach('session:browser_b', b.ws(), 'browser_b')
    await tick()
    assert.equal(f.sent.filter(m => m.method === 'initialize').length, 1)
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
