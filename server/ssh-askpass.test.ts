import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createSshAskpass } from './ssh-askpass.js'
import { SshConnectionPool, sshPoolAuthenticationArgs } from './ssh-pool.js'
import type { Host } from './types.js'

const run = promisify(execFile)
test('SSH askpass delivers one exact password through a private socket and removes all temporary state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cwpass-'))
  const password = ' 中文 p@ss \' " $(not-a-command) `literal` '
  const askpass = await createSshAskpass(password, directory)
  const authDirectory = path.dirname(askpass.env.SSH_ASKPASS)
  try {
    assert.equal((await fs.stat(authDirectory)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(askpass.env.SSH_ASKPASS)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(askpass.env.CODEX_WEB_SSH_ASKPASS_SOCKET)).mode & 0o777, 0o600)
    assert.ok(!JSON.stringify(askpass.env).includes(password))
    assert.ok(!(await fs.readFile(askpass.env.SSH_ASKPASS, 'utf8')).includes(password))
    for (const prompt of ['Enter passphrase for key:', 'Verification password:', 'OTP:', 'Are you sure you want to continue connecting (yes/no)?']) {
      await assert.rejects(run(askpass.env.SSH_ASKPASS, [prompt], { env: { ...process.env, ...askpass.env }, timeout: 5000 }))
    }
    await assert.rejects(run(askpass.env.SSH_ASKPASS, ['Password:'], {
      env: { ...process.env, ...askpass.env, CODEX_WEB_SSH_ASKPASS_TOKEN: 'wrong' }, timeout: 5000,
    }))
    const result = await run(askpass.env.SSH_ASKPASS, ["dev@example's password: "], { env: { ...process.env, ...askpass.env }, timeout: 5000 })
    assert.equal(result.stdout, password + '\n')
    assert.equal(result.stderr, '')
    await assert.rejects(run(askpass.env.SSH_ASKPASS, ['Password:'], { env: { ...process.env, ...askpass.env }, timeout: 5000 }))
  } finally { await askpass.dispose(); await askpass.dispose(); await fs.rm(directory, { recursive: true, force: true }) }
  assert.equal(await fs.access(authDirectory).then(() => true, () => false), false)
})

test('closing SSH askpass destroys incomplete requests without waiting for a client', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cwpass-'))
  const askpass = await createSshAskpass('synthetic-password', directory)
  const client = net.connect(askpass.env.CODEX_WEB_SSH_ASKPASS_SOCKET)
  try {
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
    client.write('{')
    await askpass.dispose()
  } finally { client.destroy(); await askpass.dispose(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('password mode forces non-public-key authentication and keeps secrets outside SSH argv', () => {
  const host: Host = { id: 'synthetic-password-host', kind: 'ssh', name: 'Fixture', hostname: 'example.invalid', authentication: 'password', identityFile: '/unused/private' }
  const args = sshPoolAuthenticationArgs(host)
  assert.ok(args.includes('BatchMode=no'))
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('PubkeyAuthentication=no'))
  assert.ok(args.includes('PreferredAuthentications=password,keyboard-interactive'))
  assert.ok(args.includes('NumberOfPasswordPrompts=1'))
  assert.ok(!args.includes('/unused/private'))
  assert.ok(sshPoolAuthenticationArgs({ ...host, authentication: 'key' }).includes('BatchMode=yes'))
})

test('SSH password rotation creates a new transport and missing credentials never reuse a cached master', async () => {
  const host: Host = { id: 'synthetic', kind: 'ssh', name: 'Fixture', hostname: 'example.invalid', authentication: 'password' }
  let password: string | undefined = 'first synthetic password'
  const started: string[] = []
  const pool = new SshConnectionPool({ identity: async () => 'same-host', password: async () => password,
    start: (_host, _pin, _control, value) => {
      started.push(value!)
      let close!: () => void
      return { ready: Promise.resolve(), closed: new Promise<void>(resolve => { close = resolve }), close() { close() } }
    } })
  try {
    const first = await pool.acquire(host)
    const reused = await pool.acquire(host)
    assert.equal(first.control.socketPath, reused.control.socketPath)
    password = 'changed synthetic password'
    const changed = await pool.acquire(host)
    assert.notEqual(first.control.socketPath, changed.control.socketPath)
    assert.deepEqual(started, ['first synthetic password', 'changed synthetic password'])
    password = undefined
    await assert.rejects(pool.acquire(host), /填写 SSH 登录密码/)
    first.release(); reused.release(); changed.release()
  } finally { await pool.close() }
})

test('closing a pool during asynchronous password authentication cancels its new master', async () => {
  let finish!: (value: any) => void
  let started!: () => void
  const starting = new Promise<void>(resolve => { started = resolve })
  let closed = false
  const pool = new SshConnectionPool({ identity: async () => 'async-host', password: async () => 'synthetic',
    start: async () => { started(); return new Promise(resolve => { finish = resolve }) } })
  const acquisition = pool.acquire({ id: 'async', kind: 'ssh', name: 'Async', hostname: 'example.invalid', authentication: 'password' })
  await starting
  const rejected = assert.rejects(acquisition, /已变化/)
  const shutdown = pool.close()
  let end!: () => void
  finish({ ready: Promise.resolve(), closed: new Promise<void>(resolve => { end = resolve }), close() { closed = true; end() } })
  await Promise.all([shutdown, rejected])
  assert.equal(closed, true)
})
