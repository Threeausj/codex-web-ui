import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from './app.js'
import { Storage } from './storage.js'
import { SSH_KEY_MAX_BYTES, SshKeys } from './ssh-keys.js'

const run = promisify(execFile)
const origin = 'http://localhost:8787'

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ssh-upload-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const privateFile = path.join(directory, 'test-key')
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privateFile])
  const key = await fs.readFile(privateFile)
  const dataDir = path.join(directory, 'data')
  const application = await createServer({ dataDir, codexHome: path.join(directory, 'codex'), cwd: directory, password: 'ssh-upload-test-password', origins: [origin], serveStatic: false, secureCookie: false })
  t.after(() => application.close())
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'ssh-upload-test-password' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const { csrfToken } = await login.json() as { csrfToken: string }
  const headers = { cookie, origin, 'x-csrf-token': csrfToken }
  const request = (url: string, options: RequestInit = {}) => fetch(base + url, { ...options, headers: { ...headers, ...options.headers } })
  const json = (url: string, method: string, body: unknown) => request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const form = (bytes: Buffer = key, filename = '../../unsafe.key') => {
    const body = new FormData()
    body.append('key', new Blob([new Uint8Array(bytes)]), filename)
    return body
  }
  const upload = async () => {
    const response = await request('/api/ssh-keys', { method: 'POST', body: form() })
    assert.equal(response.status, 201, await response.clone().text())
    return response.json() as Promise<{ id: string; identityFile: string }>
  }
  return { directory, dataDir, key, privateFile, base, headers, request, json, form, upload }
}

test('private-key uploads require login, trusted origin and CSRF, use private permissions and never echo key bytes', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(f.base + '/api/ssh-keys', { method: 'POST', body: f.form() })).status, 401)
  assert.equal((await fetch(f.base + '/api/ssh-keys', { method: 'POST', headers: { cookie: f.headers.cookie, origin }, body: f.form() })).status, 403)
  assert.equal((await f.request('/api/ssh-keys', { method: 'POST', headers: { origin: 'https://attacker.example' }, body: f.form() })).status, 403)
  assert.equal(await fs.access(path.join(f.dataDir, 'ssh-keys')).then(() => true, () => false), false)
  const windowsKey = Buffer.from('\uFEFF' + f.key.toString().replace(/\n/g, '\r\n'))
  const response = await f.request('/api/ssh-keys', { method: 'POST', body: f.form(windowsKey) })
  assert.equal(response.status, 201, await response.clone().text())
  const uploaded = await response.json()
  assert.deepEqual(Object.keys(uploaded).sort(), ['id', 'identityFile'])
  assert.equal(uploaded.identityFile, path.join(f.dataDir, 'ssh-keys', `${uploaded.id}.key`))
  assert.match(uploaded.id, /^[a-f0-9-]{36}$/)
  assert.equal((await fs.stat(uploaded.identityFile)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(path.dirname(uploaded.identityFile))).mode & 0o777, 0o700)
  assert.deepEqual(await fs.readFile(uploaded.identityFile), f.key)
  const publicKey = await run('ssh-keygen', ['-y', '-f', uploaded.identityFile])
  assert.equal(publicKey.stdout.trim(), (await fs.readFile(f.privateFile + '.pub', 'utf8')).trim())
  assert.equal((await fetch(f.base + `/api/ssh-keys/${uploaded.id}`, { method: 'DELETE' })).status, 401)
  assert.equal((await f.request('/api/ssh-keys/not-a-key', { method: 'DELETE' })).status, 400)
  assert.equal((await f.request(`/api/ssh-keys/${uploaded.id}`, { method: 'DELETE' })).status, 200)
  assert.equal(await fs.access(uploaded.identityFile).then(() => true, () => false), false)
})

test('uploads reject public, invalid, encrypted, empty and oversized files and clean rejected private files', async t => {
  const f = await fixture(t)
  const encryptedFile = path.join(f.directory, 'encrypted-key')
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'test-passphrase', '-f', encryptedFile])
  const cases: [Buffer, number, RegExp][] = [
    [await fs.readFile(f.privateFile + '.pub'), 400, /私钥/],
    [Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-test-secret\n-----END OPENSSH PRIVATE KEY-----\n'), 400, /无效/],
    [await fs.readFile(encryptedFile), 400, /口令/],
    [Buffer.alloc(0), 400, /1–64 KB/],
    [Buffer.alloc(SSH_KEY_MAX_BYTES + 1, 65), 413, /./],
  ]
  for (const [bytes, status, message] of cases) {
    const response = await f.request('/api/ssh-keys', { method: 'POST', body: f.form(bytes) })
    assert.equal(response.status, status, await response.clone().text())
    const body = await response.json()
    assert.match(body.error, message)
    assert.ok(!JSON.stringify(body).includes('private-test-secret'))
  }
  assert.equal((await f.request('/api/ssh-keys', { method: 'POST', body: new FormData() })).status, 400)
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'ssh-keys')), [])
})

test('uploaded PEM keys are accepted without using client filenames', async t => {
  const f = await fixture(t)
  const pemFile = path.join(f.directory, 'pem-key')
  await run('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', '', '-f', pemFile])
  const response = await f.request('/api/ssh-keys', { method: 'POST', body: f.form(await fs.readFile(pemFile), 'id_rsa') })
  assert.equal(response.status, 201, await response.clone().text())
  const uploaded = await response.json()
  assert.notEqual(path.basename(uploaded.identityFile), 'id_rsa')
  assert.match((await run('ssh-keygen', ['-y', '-f', uploaded.identityFile])).stdout, /^ssh-rsa /)
})

test('editing and deleting hosts remove only unreferenced uploaded keys, preserve manual keys and persist saved uploads', async t => {
  const f = await fixture(t)
  const first = await f.upload()
  const second = await f.upload()
  const third = await f.upload()
  const add = async (name: string) => {
    const response = await f.json('/api/hosts', 'POST', { name, hostname: 'dev@example.test', identityFile: first.identityFile })
    assert.equal(response.status, 201)
    return (await response.json()).host
  }
  const a = await add('First')
  const b = await add('Shared')
  assert.equal((await f.request(`/api/ssh-keys/${first.id}`, { method: 'DELETE' })).status, 409)
  assert.equal((await f.json(`/api/hosts/${a.id}`, 'PATCH', { identityFile: second.identityFile })).status, 200)
  await fs.access(first.identityFile)
  assert.equal((await f.request(`/api/hosts/${b.id}`, { method: 'DELETE' })).status, 200)
  assert.equal(await fs.access(first.identityFile).then(() => true, () => false), false)
  const reloaded = new Storage(f.dataDir, path.join(f.directory, 'codex'), f.directory)
  await reloaded.init()
  assert.equal(reloaded.host(a.id)?.identityFile, second.identityFile)
  await fs.access(second.identityFile)
  assert.equal((await f.json(`/api/hosts/${a.id}`, 'PATCH', { identityFile: third.identityFile })).status, 200)
  assert.equal(await fs.access(second.identityFile).then(() => true, () => false), false)
  assert.equal((await f.json(`/api/hosts/${a.id}`, 'PATCH', { identityFile: 'relative-path' })).status, 400)
  await fs.access(third.identityFile)
  assert.equal((await f.json(`/api/hosts/${a.id}`, 'PATCH', { identityFile: f.privateFile })).status, 200)
  assert.equal(await fs.access(third.identityFile).then(() => true, () => false), false)
  assert.equal((await f.request(`/api/hosts/${a.id}`, { method: 'DELETE' })).status, 200)
  await fs.access(f.privateFile)
})

test('concurrent host changes serialize persistence and cleanup, including a pending save that uses an uploaded key', async t => {
  const f = await fixture(t)
  const first = await f.upload()
  const second = await f.upload()
  const third = await f.upload()
  const response = await f.json('/api/hosts', 'POST', { name: 'Concurrent', hostname: 'host.example.test', identityFile: first.identityFile })
  assert.equal(response.status, 201)
  const { host } = await response.json()
  const responses = await Promise.all([
    f.json(`/api/hosts/${host.id}`, 'PATCH', { identityFile: second.identityFile }),
    f.json(`/api/hosts/${host.id}`, 'PATCH', { identityFile: third.identityFile }),
  ])
  assert.deepEqual(responses.map(r => r.status), [200, 200])
  const hosts = (await (await f.request('/api/hosts')).json()).hosts
  const saved = hosts.find((entry: { id: string }) => entry.id === host.id)
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'ssh-keys')), [path.basename(saved.identityFile)])

  // Hold persistence before hosts becomes visible, reproducing the reference-check race deterministically.
  const storage = new Storage(path.join(f.directory, 'queued-data'))
  await storage.init()
  const keys = new SshKeys(storage.dataDir, storage)
  const key = await keys.upload(f.key)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const save = keys.withHostMutation(async () => {
    await held
    return storage.addHost({ name: 'Pending', hostname: 'host.example.test', identityFile: key.identityFile })
  })
  const remove = keys.withHostMutation(() => keys.remove(key.id))
  const protectedRemoval = assert.rejects(remove, { status: 409 })
  release()
  await save
  await protectedRemoval
  await fs.access(key.identityFile)
})
