import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import WebSocket from 'ws'
import { createServer } from './app.js'
import type { Host, RpcMessage } from './types.js'
import type { Transport } from './bridge.js'

function hostTransport(host: Host) {
  const input = new PassThrough()
  const output = new PassThrough()
  const requests: RpcMessage[] = []
  const waiting = new Map<string, () => void>()
  const failures = new Map<string, NonNullable<RpcMessage['error']>>()
  let disposed = false
  let buffer = ''
  const write = (message: RpcMessage) => output.write(`${JSON.stringify(message)}\n`)
  const thread = { id: 'same-thread-id', name: host.name, cwd: `/workspace/${host.id}`, modelProvider: 'openai' }
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n')
      const message = JSON.parse(buffer.slice(0, index)) as RpcMessage
      buffer = buffer.slice(index + 1)
      requests.push(message)
      if (message.id === undefined) continue
      const failure = failures.get(message.method || '')
      if (failure) { queueMicrotask(() => write({ id: message.id, error: failure })); continue }
      if (message.method === 'turn/start') {
        waiting.set(String(message.id), () => write({ id: message.id, result: { turn: { id: 'running-turn' } } }))
        continue
      }
      let result: unknown = {}
      if (message.method === 'initialize') result = { userAgent: `fixture:${host.id}`, codexHome: `/home/${host.id}/.codex` }
      if (message.method === 'thread/list' || message.method === 'thread/search') result = { data: [thread], nextCursor: `${host.id}:next` }
      if (message.method === 'thread/read' || message.method === 'thread/unarchive') result = { thread }
      if (message.method === 'thread/turns/list') result = { data: [{ id: 'same-turn-id', items: [{ type: 'agentMessage', text: host.name }] }], nextCursor: null }
      if (message.method === 'thread/name/set') thread.name = (message.params as { name: string }).name
      queueMicrotask(() => {
        if (message.method === 'thread/archive') write({ method: 'thread/archived', params: { threadId: thread.id, fixtureHostId: host.id } })
        if (message.method === 'thread/delete') write({ method: 'thread/deleted', params: { threadId: thread.id, fixtureHostId: host.id } })
        write({ id: message.id, result })
      })
    }
  })
  const transport: Transport = { input, output, events: new EventEmitter(), dispose: () => { disposed = true; input.destroy(); output.destroy() } }
  return { transport, requests, waiting, failures, get disposed() { return disposed } }
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-navigation-'))
  const connections = new Map<string, ReturnType<typeof hostTransport>>()
  const application = await createServer({
    dataDir: directory, password: 'navigation-test-password-123', secureCookie: false, serveStatic: false,
    bridgeOptions: { transportFactory: host => { const connection = hostTransport(host); connections.set(host.id, connection); return connection.transport } },
  })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const port = (application.server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'navigation-test-password-123' }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const { csrfToken } = await login.json() as { csrfToken: string }
  const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }
  const request = (hostId: string, body: unknown, override = headers) => fetch(`${base}/api/navigation/${encodeURIComponent(hostId)}`, { method: 'POST', headers: override, body: JSON.stringify(body) })
  return { application, connections, port, cookie, request, headers, close: async () => { await application.close(); await fs.rm(directory, { recursive: true, force: true }) } }
}

test('navigation endpoint enforces auth/CSRF and limits methods/fields before connecting a host', async () => {
  const f = await fixture()
  const valid = { method: 'thread/list', params: { limit: 20, modelProviders: [] } }
  try {
    assert.equal((await f.request('local', valid, { 'content-type': 'application/json' } as typeof f.headers)).status, 401)
    assert.equal((await f.request('local', valid, { 'content-type': 'application/json', cookie: f.cookie } as typeof f.headers)).status, 403)
    assert.equal((await f.request('local', valid, { ...f.headers, origin: 'https://attacker.invalid' } as typeof f.headers)).status, 403)
    const forbidden = [
      { method: 'thread/start', params: { cwd: '/workspace' } },
      { method: 'thread/resume', params: { threadId: 'same-thread-id' } },
      { method: 'command/exec', params: { command: ['sh'] } },
      { ...valid, hostId: 'local' },
      { method: 'thread/list', params: { limit: 101 } },
      { method: 'thread/list', params: { cwd: ['/workspace'], sandboxPolicy: { type: 'dangerFullAccess' } } },
      { method: 'thread/read', params: { threadId: 'same-thread-id', includeTurns: true } },
      { method: 'thread/read', params: { threadId: 'same-thread-id', includeTurns: false, extra: 'field' } },
      { method: 'thread/archive', params: { threadId: 'same-thread-id', hostId: 'other-host' } },
      { method: 'thread/delete', params: { threadId: 'same-thread-id', hostId: 'other-host' } },
      { method: 'thread/delete', params: { threadId: 'same-thread-id', force: true } },
      { method: 'thread/delete', params: { threadId: '' } },
      { method: 'thread/name/set', params: { threadId: 'same-thread-id', name: '   ' } },
      { method: 'thread/name/set', params: { threadId: 'same-thread-id', name: 'x'.repeat(1001) } },
      { method: 'thread/name/set', params: { threadId: 'same-thread-id', name: 'Name', hostId: 'other-host' } },
      { method: 'thread/turns/list', params: { threadId: 'same-thread-id', sortDirection: 'asc', itemsView: 'full' } },
    ]
    for (const body of forbidden) assert.equal((await f.request('local', body)).status, 400, JSON.stringify(body))
    assert.equal(f.application.bridges.size, 0)
    assert.equal((await f.request('unknown-host', valid)).status, 404)
    assert.equal(f.application.bridges.size, 0)
    const listed = await f.request('local', valid)
    assert.equal(listed.status, 200)
    assert.equal((await listed.json() as { data: { name: string }[] }).data[0]!.name, '本机')
    assert.equal(f.connections.get('local')!.requests.filter(message => message.method === 'thread/list').length, 1)
  } finally { await f.close() }
})

test('navigation isolates matching thread IDs across hosts and keeps the active chat bridge and pending turn', async () => {
  const f = await fixture()
  const remote = await f.application.storage.addHost({ name: 'Remote workstation', hostname: 'host.example' })
  let socket: WebSocket | undefined
  try {
    const browserMessages: RpcMessage[] = []
    socket = new WebSocket(`ws://127.0.0.1:${f.port}/api/rpc?host=local&clientId=active_navigation`, { headers: { cookie: f.cookie, origin: 'http://localhost:8787' } })
    await new Promise<void>((resolve, reject) => {
      socket!.on('message', data => { const message = JSON.parse(data.toString()) as RpcMessage; browserMessages.push(message); if (message.method === 'bridge/status' && (message.params as { connected: boolean }).connected) resolve() })
      socket!.once('error', reject)
    })
    const activeBridge = f.application.bridges.get('local')!
    socket.send(JSON.stringify({ id: 'active-turn', method: 'turn/start', params: { threadId: 'same-thread-id', input: [] } }))
    await new Promise<void>(resolve => {
      const check = () => f.connections.get('local')!.waiting.size ? resolve() : setImmediate(check)
      check()
    })

    const operations = [
      { method: 'thread/list', params: { limit: 60, modelProviders: [], cwd: [`/workspace/${remote.id}`], sortKey: 'updated_at' } },
      { method: 'thread/search', params: { searchTerm: 'matching text', archived: false, cursor: null } },
      { method: 'thread/read', params: { threadId: 'same-thread-id', includeTurns: false } },
      { method: 'thread/turns/list', params: { threadId: 'same-thread-id', limit: 30, cursor: null, sortDirection: 'desc', itemsView: 'full' } },
      { method: 'thread/archive', params: { threadId: 'same-thread-id' } },
      { method: 'thread/unarchive', params: { threadId: 'same-thread-id' } },
      { method: 'thread/name/set', params: { threadId: 'same-thread-id', name: 'Renamed remote session' } },
      { method: 'thread/delete', params: { threadId: 'same-thread-id' } },
    ]
    for (const operation of operations) {
      const response = await f.request(remote.id, operation)
      assert.equal(response.status, 200, operation.method)
      const data = await response.json() as any
      if (operation.method === 'thread/read' || operation.method === 'thread/unarchive') assert.equal(data.thread.name, 'Remote workstation')
      if (operation.method === 'thread/turns/list') assert.equal(data.data[0].items[0].text, 'Remote workstation')
    }
    const localRead = await f.request('local', { method: 'thread/read', params: { threadId: 'same-thread-id', includeTurns: false } })
    assert.equal((await localRead.json() as { thread: { name: string } }).thread.name, '本机')
    assert.equal(f.application.bridges.get('local'), activeBridge)
    assert.equal(activeBridge.connected, true)
    assert.equal(socket.readyState, WebSocket.OPEN)
    assert.equal(f.connections.get('local')!.disposed, false)
    assert.equal(f.connections.get('local')!.requests.filter(message => message.method === 'initialize').length, 1)
    assert.equal(f.connections.get('local')!.requests.some(message => message.method === 'thread/archive'), false)
    assert.equal(f.connections.get('local')!.requests.some(message => ['thread/delete', 'thread/name/set'].includes(message.method || '')), false)
    assert.deepEqual(f.connections.get(remote.id)!.requests.filter(message => message.method !== 'initialize' && message.method !== 'initialized').map(message => ({ method: message.method, params: message.params })), operations)
    assert.equal(browserMessages.some(message => message.method === 'thread/archived'), false)
    assert.equal(browserMessages.some(message => message.method === 'thread/deleted'), false)
    const completed = new Promise<RpcMessage>(resolve => socket!.on('message', data => { const message = JSON.parse(data.toString()) as RpcMessage; if (message.id === 'active-turn') resolve(message) }))
    for (const release of f.connections.get('local')!.waiting.values()) release()
    assert.deepEqual(await completed, { id: 'active-turn', result: { turn: { id: 'running-turn' } } })
  } finally { socket?.terminate(); await f.close() }
})

test('sidebar rename and delete require authentication/CSRF and validation before native mutations', async () => {
  const f = await fixture()
  try {
    for (const body of [
      { method: 'thread/name/set', params: { threadId: 'same-thread-id', name: 'New title' } },
      { method: 'thread/delete', params: { threadId: 'same-thread-id' } },
    ]) {
      assert.equal((await f.request('local', body, { 'content-type': 'application/json' } as typeof f.headers)).status, 401)
      assert.equal((await f.request('local', body, { 'content-type': 'application/json', cookie: f.cookie } as typeof f.headers)).status, 403)
      assert.equal((await f.request('local', body, { ...f.headers, origin: 'https://attacker.invalid' } as typeof f.headers)).status, 403)
      assert.equal((await f.request('unknown-host', body)).status, 404)
    }
    assert.equal(f.connections.size, 0)
    const renamed = await f.request('local', { method: 'thread/name/set', params: { threadId: 'same-thread-id', name: '  Trimmed session title  ' } })
    assert.equal(renamed.status, 200)
    assert.deepEqual(f.connections.get('local')!.requests.find(message => message.method === 'thread/name/set')?.params,
      { threadId: 'same-thread-id', name: 'Trimmed session title' })
  } finally { await f.close() }
})

test('unsupported or failed permanent deletion reports the native error without archiving or removing the conversation', async () => {
  const f = await fixture()
  try {
    await f.request('local', { method: 'thread/read', params: { threadId: 'same-thread-id', includeTurns: false } })
    const connection = f.connections.get('local')!
    for (const error of [
      { code: -32601, message: 'Method not found' },
      { code: -32000, message: 'cannot delete thread: forked history still references it' },
    ]) {
      connection.failures.set('thread/delete', error)
      const response = await f.request('local', { method: 'thread/delete', params: { threadId: 'same-thread-id' } })
      assert.equal(response.status, 502)
      const body = await response.json() as { error: string; code: number }
      assert.equal(body.code, error.code)
      assert.match(body.error, error.code === -32601 ? /不支持永久删除.*升级.*未被删除/ : /forked history/)
      const read = await f.request('local', { method: 'thread/read', params: { threadId: 'same-thread-id', includeTurns: false } })
      assert.equal((await read.json() as { thread: { name: string } }).thread.name, '本机')
    }
    assert.equal(connection.requests.some(message => ['thread/archive', 'fs/remove', 'command/exec'].includes(message.method || '')), false)
  } finally { await f.close() }
})
