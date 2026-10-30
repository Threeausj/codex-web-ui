import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { WebSocket } from 'ws'
import { Bridge, type Transport } from './bridge.js'
import type { RpcMessage } from './types.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
class Browser extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent: RpcMessage[] = []
  send(value: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(value)); callback?.() }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
  ws() { return this as unknown as WebSocket }
}
function fixture() {
  const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter()
  const sent: RpcMessage[] = [], observed: { message: RpcMessage; method?: string }[] = []
  let buffer = ''
  const transport: Transport = { input, output, events, dispose() { input.destroy(); output.destroy() } }
  const bridge = new Bridge({ id: 'local', name: 'Lifecycle fixture', kind: 'local' }, {
    transportFactory: () => transport,
    onProtocolMessage: (_host, message, method) => { observed.push({ message, method }) },
  })
  const receive = (message: RpcMessage) => output.write(JSON.stringify(message) + '\n')
  input.on('data', chunk => {
    buffer += chunk.toString()
    let position: number
    while ((position = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, position)) as RpcMessage
      buffer = buffer.slice(position + 1); sent.push(message)
      if (message.method === 'initialize') queueMicrotask(() => receive({ id: message.id, result: { userAgent: 'native-lifecycle-fixture/0.166.0' } }))
    }
  })
  const request = async (method: string, params: unknown, result: unknown) => {
    const accepted = bridge.request(method, params); await tick()
    const message = sent.at(-1)!; assert.equal(message.method, method)
    receive({ id: message.id, result }); return accepted
  }
  return { bridge, sent, observed, receive, request }
}
const runtimeThread = (id: string) => ({ thread: { id, status: { type: 'active' }, turns: [], name: id } })

for (const ending of ['thread/closed', 'thread/archived', 'notLoaded'] as const) {
  test(`native ${ending} retires only that runtime and its approvals without disconnecting the App Server`, async t => {
    const f = fixture(); t.after(() => f.bridge.close())
    await f.bridge.connect()
    await f.request('thread/resume', { threadId: 'closing' }, runtimeThread('closing'))
    await f.request('thread/resume', { threadId: 'other' }, runtimeThread('other'))
    const connected = new Browser(); f.bridge.attach('fixture:connected', connected.ws(), 'connected')
    f.receive({ method: 'thread/tokenUsage/updated', params: { threadId: 'closing', tokenUsage: { last: { totalTokens: 218000 }, modelContextWindow: 500000 } } })
    for (const [id, method] of [
      ['command', 'item/commandExecution/requestApproval'],
      ['permission', 'item/permissions/requestApproval'],
      ['question', 'item/tool/requestUserInput'],
      ['mcp', 'mcpServer/elicitation/request'],
    ]) f.receive({ id, method, params: { threadId: 'closing', turnId: 'turn-closing', itemId: id, ...(id === 'mcp' ? { mode: 'form', serverName: 'fixture', message: 'Fixture approval', requestedSchema: {} } : {}) } })
    f.receive({ id: 'keep', method: 'item/commandExecution/requestApproval', params: { threadId: 'other', turnId: 'turn-other', itemId: 'other-command' } })
    if (ending === 'notLoaded') f.receive({ method: 'thread/status/changed', params: { threadId: 'closing', status: { type: 'notLoaded' } } })
    else f.receive({ method: ending, params: { threadId: 'closing' } })
    const browser = new Browser(); f.bridge.attach('fixture:reader', browser.ws(), 'reader')
    const state = browser.sent.find(message => message.method === 'bridge/status')!.params as any
    assert.deepEqual(state.pendingRequests.map((message: RpcMessage) => message.id), ['keep'])
    assert.equal(f.bridge.connected, true)
    assert.deepEqual(f.bridge.runtime.threads.map(thread => thread.id), ['other'])
    assert.equal(f.bridge.runtime.activeThreadCount, 1)
    assert.equal(f.sent.some(message => ['command', 'permission', 'question', 'mcp'].includes(String(message.id))), false, 'Native unload must never grant or answer a request')
    assert.deepEqual(connected.sent.filter(message => message.method === 'serverRequest/resolved').map(message => (message.params as any).requestId).sort(), ['command', 'mcp', 'permission', 'question'])
    if (ending !== 'thread/archived') assert.equal(f.bridge.threadContext('closing').tokenUsage?.modelContextWindow, 500000, 'Runtime unload must retain the last known context until native refresh')
  })
}

for (const ending of ['thread/closed', 'notLoaded'] as const) {
  test(`a resume ACK after newer ${ending} cannot restore loaded/active state or publish stale subscription metadata`, async t => {
    const f = fixture(); t.after(() => f.bridge.close())
    await f.bridge.connect()
    const browser = new Browser(); f.bridge.attach('fixture:reader', browser.ws(), 'reader')
    const pending = f.bridge.request('thread/resume', { threadId: 'closing' }); await tick()
    const request = f.sent.at(-1)!
    if (ending === 'notLoaded') f.receive({ method: 'thread/status/changed', params: { threadId: 'closing', status: { type: 'notLoaded' } } })
    else f.receive({ method: ending, params: { threadId: 'closing' } })
    const result = { ...runtimeThread('closing'), approvalPolicy: 'on-request', activePermissionProfile: { type: 'legacy' } }
    f.receive({ id: request.id, result })
    assert.deepEqual(await pending, result, 'History and inherited permissions still belong to the RPC caller')
    assert.equal(f.bridge.runtime.loadedThreadCount, 0)
    assert.equal(f.bridge.runtime.activeThreadCount, 0)
    assert.equal(browser.sent.some(message => message.method === 'bridge/thread/changed'), false)
    assert.equal(f.observed.find(entry => entry.message.id === request.id && !entry.message.method)!.method, undefined, 'A retired subscription cannot be journaled again as a current resume')
    await f.request('thread/resume', { threadId: 'closing' }, runtimeThread('closing'))
    assert.equal(f.bridge.runtime.loadedThreadCount, 1, 'A deliberate subsequent resume can load the thread again')
    assert.equal(f.bridge.runtime.activeThreadCount, 1)
  })
}

test('a fork result retired before its ACK uses the child identity and leaves the parent runtime unchanged', async t => {
  const f = fixture(); t.after(() => f.bridge.close())
  await f.bridge.connect()
  await f.request('thread/resume', { threadId: 'parent' }, runtimeThread('parent'))
  const pending = f.bridge.request('thread/fork', { threadId: 'parent' }); await tick()
  const request = f.sent.at(-1)!
  f.receive({ method: 'thread/closed', params: { threadId: 'child' } })
  const fork = runtimeThread('child'); f.receive({ id: request.id, result: fork }); assert.deepEqual(await pending, fork)
  assert.deepEqual(f.bridge.runtime.threads.map(thread => thread.id), ['parent'])
  assert.equal(f.bridge.runtime.activeThreadCount, 1)
})

test('closing a parent does not discard a fork response for a still-running child', async t => {
  const f = fixture(); t.after(() => f.bridge.close())
  await f.bridge.connect()
  await f.request('thread/resume', { threadId: 'parent' }, runtimeThread('parent'))
  const pending = f.bridge.request('thread/fork', { threadId: 'parent' }); await tick()
  const request = f.sent.at(-1)!
  f.receive({ method: 'thread/closed', params: { threadId: 'parent' } })
  const fork = runtimeThread('child'); f.receive({ id: request.id, result: fork }); await pending
  assert.deepEqual(f.bridge.runtime.threads.map(thread => thread.id), ['child'])
  assert.equal(f.bridge.runtime.activeThreadCount, 1)
})
