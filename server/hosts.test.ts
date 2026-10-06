import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { createServer } from './app.js'
import { Storage, hostInput, hostUpdateInput } from './storage.js'
import type { Host, RpcMessage } from './types.js'
import type { Transport } from './bridge.js'

function transport(onDispose?: () => void): Transport {
  const input = new PassThrough()
  const output = new PassThrough()
  let buffer = ''
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n')
      const message = JSON.parse(buffer.slice(0, index)) as RpcMessage
      buffer = buffer.slice(index + 1)
      if (message.id !== undefined) queueMicrotask(() => output.write(`${JSON.stringify({ id: message.id, result: message.method === 'config/read' ? { config: {} } : {} })}\n`))
    }
  })
  return { input, output, events: new EventEmitter(), dispose: () => { onDispose?.(); input.destroy(); output.destroy() } }
}

test('SSH host PATCH requires auth/CSRF, persists edits, clears optional fields and resets only changed connections', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-edit-'))
  const application = await createServer({ dataDir: directory, password: 'host-edit-test-password-123', serveStatic: false, secureCookie: false, bridgeOptions: { transportFactory: () => transport() } })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const port = (application.server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'host-edit-test-password-123' }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const { csrfToken } = await login.json() as { csrfToken: string }
  const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }
  const request = (url: string, method: string, body: unknown) => fetch(base + url, { method, headers, body: JSON.stringify(body) })
  let socket: WebSocket | undefined
  try {
    const added = await request('/api/hosts', 'POST', { name: 'Build host', hostname: 'host.example', port: 22, username: 'developer', identityFile: '/keys/private', codexPath: '/bin/codex', cwd: '/old' })
    const { host } = await added.json() as { host: Host }
    assert.equal(added.status, 201)
    const endpoint = `/api/hosts/${host.id}`
    assert.equal((await fetch(base + endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"name":"Unauthenticated"}' })).status, 401)
    assert.equal((await fetch(base + endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"name":"No CSRF"}' })).status, 403)
    assert.equal((await request(endpoint, 'PATCH', { id: 'local', name: 'Bad' })).status, 400)
    assert.equal((await request(endpoint, 'PATCH', { kind: 'local' })).status, 400)
    assert.equal((await request(endpoint, 'PATCH', { hostname: '-oProxyCommand=bad' })).status, 400)
    assert.equal((await request(endpoint, 'PATCH', { port: 0 })).status, 400)
    assert.equal((await request(endpoint, 'PATCH', {})).status, 400)
    assert.equal((await request('/api/hosts/local', 'PATCH', { name: 'Bad' })).status, 400)
    assert.equal((await request('/api/hosts/missing', 'PATCH', { name: 'Bad' })).status, 404)

    socket = new WebSocket(`ws://127.0.0.1:${port}/api/rpc?host=${host.id}&clientId=host_editor`, { headers: { cookie, origin: 'http://localhost:8787' } })
    await new Promise<void>((resolve, reject) => {
      socket!.on('message', data => { const message = JSON.parse(data.toString()); if (message.method === 'bridge/status' && message.params.connected) resolve() })
      socket!.once('error', reject)
    })
    const originalBridge = application.bridges.get(host.id)!
    const renamed = await request(endpoint, 'PATCH', { name: 'Renamed host' })
    assert.equal(renamed.status, 200)
    assert.equal((await renamed.json() as { connectionReset: boolean }).connectionReset, false)
    assert.equal(application.bridges.get(host.id), originalBridge)
    assert.equal(originalBridge.connected, true)

    const closed = new Promise<{ code: number; reason: string }>(resolve => socket!.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    const edited = await request(endpoint, 'PATCH', { port: 2222, username: '', identityFile: '', codexPath: '', cwd: '' })
    const saved = await edited.json() as { host: Host; hosts: Host[]; connectionReset: boolean }
    assert.equal(edited.status, 200)
    assert.equal(saved.connectionReset, true)
    assert.equal(saved.host.id, host.id)
    assert.equal(saved.host.kind, 'ssh')
    assert.equal(saved.host.name, 'Renamed host')
    assert.equal(saved.host.port, 2222)
    assert.equal(saved.host.username, undefined)
    assert.equal(saved.host.identityFile, undefined)
    assert.equal(saved.host.codexPath, undefined)
    assert.equal(saved.host.cwd, undefined)
    assert.deepEqual(await closed, { code: 4001, reason: 'Host settings changed' })
    assert.equal(originalBridge.connected, false)
    assert.equal(application.bridges.has(host.id), false)
    const replacement = await application.getBridge(host.id)
    assert.notEqual(replacement, originalBridge)
    assert.equal(replacement.host.port, 2222)
    const clearedPort = await request(endpoint, 'PATCH', { port: null })
    assert.equal(clearedPort.status, 200)
    const portClearedHost = (await clearedPort.json() as { host: Host }).host
    assert.equal(portClearedHost.port, undefined)
    const restored = new Storage(directory)
    await restored.init()
    assert.deepEqual(restored.host(host.id), portClearedHost)
    assert.equal((await fs.stat(path.join(directory, 'hosts.json'))).mode & 0o777, 0o600)
  } finally { socket?.terminate(); await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('serialized SSH edits preserve concurrent fields and normalize automatic Codex discovery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-storage-'))
  try {
    const storage = new Storage(directory)
    await storage.init()
    const host = await storage.addHost({ name: 'Remote', hostname: 'host.example', username: '', identityFile: '', codexPath: '', cwd: '' })
    assert.equal(host.codexPath, undefined)
    await Promise.all([storage.updateHost(host.id, { name: 'Updated' }), storage.updateHost(host.id, { port: 2222 }), storage.updateHost(host.id, { cwd: '/workspace' })])
    assert.equal(storage.host(host.id)?.name, 'Updated')
    assert.equal(storage.host(host.id)?.port, 2222)
    assert.equal(storage.host(host.id)?.cwd, '/workspace')
    const restored = new Storage(directory)
    await restored.init()
    assert.deepEqual(restored.host(host.id), storage.host(host.id))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('desktop-style SSH addresses normalize users, aliases and IPv6 without accepting option or shell injection', () => {
  assert.deepEqual(hostInput.parse({ name: 'Build', hostname: ' developer@build-alias ' }), { name: 'Build', hostname: 'build-alias', username: 'developer' })
  assert.deepEqual(hostInput.parse({ name: 'Build', hostname: 'developer@[2001:db8::1]', port: 2222 }), { name: 'Build', hostname: '2001:db8::1', username: 'developer', port: 2222 })
  assert.equal(hostInput.parse({ name: 'Build', hostname: 'host_alias' }).hostname, 'host_alias')
  assert.deepEqual(hostUpdateInput.parse({ hostname: 'other@new.example', username: '' }), { hostname: 'new.example', username: 'other' })
  assert.deepEqual(hostUpdateInput.parse({ port: null }), { port: undefined })
  assert.equal(hostInput.parse({ name: 'Alias', hostname: 'build-alias', port: '' }).port, undefined)
  for (const hostname of ['-oProxyCommand=sh', 'host;touch /tmp/no', 'host:22', 'user@@host', '@host', 'user@-bad', 'host\nother']) assert.equal(hostInput.safeParse({ name: 'Bad', hostname }).success, false, hostname)
  assert.equal(hostInput.safeParse({ name: 'Bad', hostname: 'user@host', username: 'different' }).success, false)
})

test('testing an unsaved SSH draft requires auth/CSRF and disposes only its private connection without persisting hosts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-probe-api-'))
  const connections: { host: Host; disposed: number }[] = []
  const application = await createServer({ dataDir: directory, password: 'host-probe-test-password-123', serveStatic: false, secureCookie: false, bridgeOptions: { transportFactory: host => { const record = { host, disposed: 0 }; connections.push(record); return transport(() => record.disposed++) } } })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  const draft = { name: '', hostname: 'developer@host-alias', port: 2222 }
  try {
    assert.equal((await fetch(base + '/api/hosts/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })).status, 401)
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'host-probe-test-password-123' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const { csrfToken } = await login.json() as { csrfToken: string }
    assert.equal((await fetch(base + '/api/hosts/test', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(draft) })).status, 403)
    const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }
    const shared = await application.getBridge('local')
    await shared.connect()
    const response = await fetch(base + '/api/hosts/test', { method: 'POST', headers, body: JSON.stringify(draft) })
    assert.equal(response.status, 200)
    const result = await response.json() as { ok: boolean; stage: string; elapsedMs: number }
    assert.equal(result.ok, true)
    assert.equal(result.stage, 'ready')
    assert.ok(result.elapsedMs >= 0)
    assert.equal(connections.length, 2)
    assert.equal(connections[1]?.host.hostname, 'host-alias')
    assert.equal(connections[1]?.host.username, 'developer')
    assert.equal(connections[1]?.disposed, 1)
    assert.equal(connections[0]?.disposed, 0)
    assert.equal(shared.connected, true)
    assert.equal(application.bridges.size, 1)
    assert.deepEqual(application.storage.hosts.map(host => host.id), ['local'])
    assert.equal(await fs.access(path.join(directory, 'hosts.json')).then(() => true, () => false), false)
    const invalid = await fetch(base + '/api/hosts/test', { method: 'POST', headers, body: JSON.stringify({ hostname: 'user@@host' }) })
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json() as { error: string }).error, /主机名/)
    assert.equal(connections.length, 2)
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
