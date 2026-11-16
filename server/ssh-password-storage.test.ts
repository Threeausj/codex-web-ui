import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { Storage, hostInput, hostUpdateInput } from './storage.js'
import { createServer } from './app.js'
import type { Host, RpcMessage } from './types.js'
import type { Transport } from './bridge.js'

const secret = "  synthetic 密码 '$() ` echo private value  "
const fields = { name: 'Password host', hostname: 'reader@password.example.test', authentication: 'password', password: secret }
const rejectsPassword = async (work: Promise<unknown>) => assert.rejects(work, /SSH 密码|SSH 连接凭据/)
const publicHost = (value: unknown) => {
  const json = JSON.stringify(value)
  assert.ok(!json.includes(secret), 'Public host data must not contain password bytes')
  assert.ok(!json.includes('encryptedPassword'), 'Public host data must not contain encrypted credentials')
  assert.ok(!json.includes('ciphertext'), 'Public host data must not contain encrypted credentials')
  assert.ok(!json.includes('nonce'), 'Public host data must not contain encryption metadata')
}

test('password credentials persist as authenticated ciphertext, not public host fields, with private key and journal permissions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-password-storage-'))
  try {
    const storage = new Storage(directory)
    await storage.init()
    const host = await storage.addHost({ ...fields, identityFile: '/old/key' })
    assert.equal(host.authentication, 'password')
    assert.equal(host.hasPassword, true)
    assert.equal(host.identityFile, undefined)
    assert.equal(await storage.sshPassword(host), secret)
    publicHost(host); publicHost(storage.hosts)
    const json = await fs.readFile(path.join(directory, 'hosts.json'), 'utf8')
    assert.ok(!json.includes(secret))
    const saved = JSON.parse(json)
    assert.equal(saved[0].password, undefined)
    assert.equal(saved[0].hasPassword, undefined)
    assert.equal(saved[0].encryptedPassword.version, 1)
    const key = await fs.readFile(path.join(directory, 'ssh-password.key'))
    assert.equal(key.length, 32)
    for (const file of ['hosts.json', 'ssh-password.key']) assert.equal((await fs.stat(path.join(directory, file))).mode & 0o777, 0o600)
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
    const restored = new Storage(directory)
    await restored.init()
    assert.deepEqual(restored.host(host.id), host)
    assert.equal(await restored.sshPassword(restored.host(host.id)!), secret)
    publicHost(restored.hosts)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('blank edits retain only the same saved account; credential changes retire stale snapshots without exposing password revisions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-password-edits-'))
  try {
    const storage = new Storage(directory)
    await storage.init()
    await rejectsPassword(storage.addHost({ ...fields, password: undefined }))
    const original = await storage.addHost(fields)
    const before = await fs.readFile(path.join(directory, 'hosts.json'), 'utf8')
    const renamed = await storage.updateHost(original.id, { name: 'Renamed', password: '' })
    assert.equal(renamed.connectionReset, false)
    assert.equal(await storage.sshPassword(renamed.host), secret)
    assert.equal(await storage.sshPassword(original), secret, 'A metadata rename preserves existing bridge credentials')
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'hosts.json'), 'utf8'))[0].encryptedPassword, JSON.parse(before)[0].encryptedPassword)
    for (const changes of [{ hostname: 'elsewhere.example.test' }, { username: 'another' }, { port: 2222 }]) {
      await rejectsPassword(storage.updateHost(original.id, changes))
      assert.equal(await storage.sshPassword(storage.host(original.id)!), secret)
    }
    const updated = await storage.updateHost(original.id, { hostname: 'another@elsewhere.example.test', username: '', password: 'replacement secret' })
    assert.equal(updated.connectionReset, true)
    assert.equal(updated.host.hostname, 'elsewhere.example.test')
    assert.equal(updated.host.username, 'another')
    assert.equal(await storage.sshPassword(updated.host), 'replacement secret')
    await rejectsPassword(storage.sshPassword(original))
    await rejectsPassword(storage.sshPassword({ ...updated.host }))
    const key = await storage.updateHost(original.id, { authentication: 'key', identityFile: '/private/new-key' })
    assert.equal(key.connectionReset, true)
    assert.equal(key.host.hasPassword, undefined)
    assert.equal(await storage.sshPassword(key.host), undefined)
    assert.ok(!await fs.readFile(path.join(directory, 'hosts.json'), 'utf8').then(value => value.includes('encryptedPassword')))
    const restored = new Storage(directory)
    await restored.init()
    assert.deepEqual(restored.host(original.id), key.host)
    await rejectsPassword(storage.updateHost(original.id, { authentication: 'password' }))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('serialized password edits and failed writes preserve committed credentials; removal erases encrypted records', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-password-atomic-'))
  try {
    const storage = new Storage(directory)
    await storage.init()
    const original = await storage.addHost(fields)
    await Promise.all([
      storage.updateHost(original.id, { password: 'second secret' }),
      storage.updateHost(original.id, { name: 'Concurrent name' }),
      storage.updateHost(original.id, { cwd: '/workspace' }),
    ])
    const current = storage.host(original.id)!
    assert.equal(current.name, 'Concurrent name')
    assert.equal(current.cwd, '/workspace')
    assert.equal(await storage.sshPassword(current), 'second secret')
    const journal = path.join(directory, 'hosts.json'), backup = path.join(directory, 'backup')
    await fs.rename(journal, backup); await fs.mkdir(journal)
    await assert.rejects(storage.updateHost(original.id, { password: 'uncommitted secret' }))
    assert.equal(await storage.sshPassword(current), 'second secret')
    assert.equal(storage.host(original.id), current)
    await fs.rmdir(journal); await fs.rename(backup, journal)
    const restored = new Storage(directory)
    await restored.init()
    assert.equal(await restored.sshPassword(restored.host(original.id)!), 'second secret')
    await storage.deleteHost(original.id)
    await rejectsPassword(storage.sshPassword(current))
    assert.deepEqual(JSON.parse(await fs.readFile(journal, 'utf8')), [])
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('tampered, transplanted and missing-key password journals fail closed instead of silently losing saved hosts', async () => {
  for (const mutation of ['ciphertext', 'endpoint', 'missing-key', 'symbolic-key'] as const) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-password-tamper-'))
    try {
      const storage = new Storage(directory)
      await storage.init(); await storage.addHost(fields)
      const journal = path.join(directory, 'hosts.json')
      const hosts = JSON.parse(await fs.readFile(journal, 'utf8'))
      if (mutation === 'ciphertext') hosts[0].encryptedPassword.tag = Buffer.alloc(16).toString('base64url')
      if (mutation === 'endpoint') hosts[0].hostname = 'changed.example.test'
      if (mutation === 'missing-key') await fs.rm(path.join(directory, 'ssh-password.key'))
      if (mutation === 'symbolic-key') {
        await fs.rename(path.join(directory, 'ssh-password.key'), path.join(directory, 'other-key'))
        await fs.symlink(path.join(directory, 'other-key'), path.join(directory, 'ssh-password.key'))
      }
      await fs.writeFile(journal, JSON.stringify(hosts))
      await assert.rejects(new Storage(directory).init(), /SSH 密码/)
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  }
})

test('password input preserves whitespace, rejects multiline secrets and forbids browser-supplied credential metadata', () => {
  assert.equal(hostInput.parse(fields).password, secret)
  assert.equal(hostUpdateInput.parse({ password: '' }).password, undefined)
  for (const password of ['a\nb', 'a\rb', 'a\0b', 'x'.repeat(1025)]) assert.equal(hostInput.safeParse({ ...fields, password }).success, false)
  for (const extras of [{ hasPassword: true }, { encryptedPassword: {} }, { passwordId: 'provided' }]) {
    assert.equal(hostInput.safeParse({ ...fields, ...extras }).success, false)
    assert.equal(hostUpdateInput.safeParse(extras).success, false)
  }
})

function fixtureTransport(host: Host, seen: Host[]): Transport {
  seen.push(host)
  const input = new PassThrough(), output = new PassThrough()
  let buffer = ''
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, end)) as RpcMessage
      buffer = buffer.slice(end + 1)
      if (message.id !== undefined) queueMicrotask(() => output.write(`${JSON.stringify({ id: message.id, result: message.method === 'config/read' ? { config: {} } : {} })}\n`))
    }
  })
  return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } }
}

test('password API protects auth/CSRF, never echoes secrets, and reuses saved probe credentials only for the exact account', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-password-api-')), seen: Host[] = []
  const app = await createServer({ dataDir: directory, password: 'password-api-web-password', serveStatic: false, secureCookie: false,
    bridgeOptions: { transportFactory: host => fixtureTransport(host, seen) } })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'password-api-web-password' }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!, { csrfToken } = await login.json() as { csrfToken: string }
  const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }
  const request = async (endpoint: string, method: string, body?: unknown) => fetch(base + endpoint, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  try {
    for (const endpoint of ['/api/hosts', '/api/hosts/test']) {
      assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) })).status, 401)
      assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(fields) })).status, 403)
    }
    const added = await request('/api/hosts', 'POST', fields)
    const data = await added.json() as { host: Host; hosts: Host[] }
    assert.equal(added.status, 201)
    publicHost(data)
    const endpoint = `/api/hosts/${data.host.id}`
    for (const url of ['/api/bootstrap', '/api/hosts']) {
      const response = await request(url, 'GET')
      assert.equal(response.status, 200); publicHost(await response.json())
    }
    const fresh = await request('/api/hosts/test', 'POST', fields)
    assert.equal(fresh.status, 200); publicHost(await fresh.json())
    assert.equal(seen.at(-1)?.authentication, 'password'); publicHost(seen)
    const stored = { name: 'Unsaved', hostname: data.host.hostname, username: data.host.username, authentication: 'password', hostId: data.host.id }
    assert.equal((await request('/api/hosts/test', 'POST', stored)).status, 200)
    const probes = seen.length
    for (const changed of [{ hostname: 'elsewhere.example.test' }, { username: 'other' }, { port: 2222 }, { hostId: 'ssh-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }, { hostId: undefined }]) {
      const response = await request('/api/hosts/test', 'POST', { ...stored, ...changed })
      assert.equal(response.status, 400); publicHost(await response.json())
    }
    assert.equal(seen.length, probes, 'A changed account must never reach the SSH transport with a saved password')
    const replacement = await request('/api/hosts/test', 'POST', { ...stored, hostname: 'other.example.test', password: 'another password' })
    assert.equal(replacement.status, 200)
    assert.equal(app.storage.hosts.length, 2, 'Draft probes never create saved hosts')
    const renamed = await request(endpoint, 'PATCH', { name: 'Still private', password: '' })
    assert.equal(renamed.status, 200); publicHost(await renamed.json())
    assert.equal(await app.storage.sshPassword(app.storage.host(data.host.id)!), secret)
    const key = await request(endpoint, 'PATCH', { authentication: 'key' })
    assert.equal(key.status, 200)
    assert.equal((await request('/api/hosts/test', 'POST', stored)).status, 400)
    assert.equal((await request(endpoint, 'DELETE')).status, 200)
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
