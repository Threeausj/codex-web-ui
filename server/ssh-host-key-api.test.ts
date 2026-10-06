import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from './app.js'
import type { SSHHostKeyInspection, SSHHostKeyServiceOptions } from './ssh-host-keys.js'

const origin = 'http://localhost:8787'
const password = 'isolated-fingerprint-api-password'
const publicKey = () => {
  const key = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const type = Buffer.from('ssh-ed25519')
  const size = (n: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(n); return buffer }
  return Buffer.concat([size(type.length), type, size(key.length), key]).toString('base64')
}
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-fingerprint-api-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let blob = publicKey()
  let scans = 0
  let now = Date.now()
  const options: Omit<SSHHostKeyServiceOptions, 'dataDir'> = {
    now: () => now,
    resolve: async host => ({ hostname: host.hostname!, port: host.port ?? 22, username: host.username || '', lookupName: host.port && host.port !== 22 ? `[${host.hostname}]:${host.port}` : host.hostname!, externalKnownHostsFiles: [] }),
    scan: async target => { scans++; return `${target.port === 22 ? target.hostname : `[${target.hostname}]:${target.port}`} ssh-ed25519 ${blob}\n` },
  }
  const appOptions = { cwd: directory, codexHome: path.join(directory, 'codex'), dataDir: path.join(directory, 'data'), password, origins: [origin], secureCookie: false, serveStatic: false, sshHostKeyOptions: options }
  const application = await createServer(appOptions)
  t.after(() => application.close())
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  const login = async () => {
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const { csrfToken } = await response.json() as { csrfToken: string }
    return { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken }
  }
  const headers = await login()
  const post = (endpoint: string, body: unknown, custom = headers) => fetch(base + '/api/hosts/key/' + endpoint, { method: 'POST', headers: custom, body: JSON.stringify(body) })
  const inspect = async () => {
    const response = await post('inspect', { hostname: 'dev@host.example', port: 2222 })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json() as Promise<SSHHostKeyInspection>
  }
  return { application, appOptions, options, headers, login, post, inspect, base, directory, rotate: () => { blob = publicKey() }, expire: () => { now += 120_001 }, scans: () => scans }
}

test('fingerprint API requires authentication, CSRF and trusted origin before scanning, and accepts only a normalized address', async t => {
  const f = await fixture(t)
  const body = { hostname: 'dev@host.example', port: 2222 }
  assert.equal((await fetch(f.base + '/api/hosts/key/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401)
  assert.equal((await f.post('inspect', body, { ...f.headers, 'x-csrf-token': '' })).status, 403)
  assert.equal((await f.post('inspect', body, { ...f.headers, origin: 'https://untrusted.invalid' })).status, 403)
  for (const invalid of [{ hostname: '-oProxyCommand=anything' }, { hostname: 'host.example', port: 0 }, { hostname: 'host.example', identityFile: '/private/key' }, { ...body, keys: ['browser-supplied-key'] }]) {
    assert.equal((await f.post('inspect', invalid)).status, 400)
  }
  assert.equal(f.scans(), 0)
  const result = await f.inspect()
  assert.equal(result.status, 'unknown')
  assert.equal(result.hostname, 'host.example')
  assert.equal(result.port, 2222)
  assert.match(result.keys[0]!.fingerprint, /^SHA256:/)
  assert.ok(!JSON.stringify(result).includes('blob'))
  assert.deepEqual(f.application.storage.hosts.map(host => host.id), ['local'])
  assert.equal(await fs.access(f.application.sshHostKeys.knownHostsFile).then(() => true, () => false), false)
})

test('trust is bound to the browser session and draft, requires explicit rotation, and saved pins survive a fresh application', async t => {
  const f = await fixture(t)
  const result = await f.inspect()
  const body = { hostname: 'dev@host.example', port: 2222, challenge: result.challenge, replace: false }
  const another = await f.login()
  assert.equal((await f.post('trust', body, another)).status, 409)
  assert.equal((await f.post('trust', { ...body, hostname: 'other@host.example' })).status, 409)
  assert.equal((await f.post('trust', { ...body, keys: ['attacker'] })).status, 400)
  const trusted = await f.post('trust', body)
  assert.equal(trusted.status, 200, await trusted.clone().text())
  assert.equal((await trusted.json()).ok, true)
  const managed = f.application.sshHostKeys.knownHostsFile
  assert.equal((await fs.stat(managed)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(path.dirname(managed))).mode & 0o777, 0o700)
  const fresh = await createServer(f.appOptions)
  try {
    assert.equal(await fresh.sshHostKeys.connectionKnownHostsFile({ id: 'saved', kind: 'ssh', name: 'Saved', hostname: 'host.example', username: 'dev', port: 2222 }), managed)
    assert.equal(await fresh.sshHostKeys.connectionKnownHostsFile({ id: 'other', kind: 'ssh', name: 'Other', hostname: 'unrelated.example', port: 2222 }), undefined)
  } finally { await fresh.close() }
  f.rotate()
  const changed = await f.inspect()
  assert.equal(changed.status, 'changed')
  assert.deepEqual(changed.previousFingerprints, result.keys)
  const rotation = { ...body, challenge: changed.challenge }
  assert.equal((await f.post('trust', rotation)).status, 409)
  assert.equal((await f.post('trust', { ...rotation, replace: true })).status, 200)
  assert.equal((await f.inspect()).status, 'trusted')
  // Updating the app-managed pins does not persist or edit a server draft.
  assert.deepEqual(f.application.storage.hosts.map(host => host.id), ['local'])
})

test('expired confirmation and a host key changed after inspection cannot write a pin', async t => {
  const f = await fixture(t)
  const first = await f.inspect()
  f.expire()
  assert.equal((await f.post('trust', { hostname: 'dev@host.example', port: 2222, challenge: first.challenge, replace: false })).status, 409)
  const second = await f.inspect()
  f.rotate()
  assert.equal((await f.post('trust', { hostname: 'dev@host.example', port: 2222, challenge: second.challenge, replace: false })).status, 409)
  assert.equal(await fs.access(f.application.sshHostKeys.knownHostsFile).then(() => true, () => false), false)
})
