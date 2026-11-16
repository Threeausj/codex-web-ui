import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { SshConnectionPool } from './ssh-pool.js'
import { sshAppServerArgs, sshPythonArgs } from './ssh.js'
import { openSshForward } from './ssh-forward.js'
import type { SSHHostKeyPin } from './ssh-host-keys.js'
import type { Host } from './types.js'

const execute = promisify(execFile)
const fixturePath = process.env.CODEX_TEST_PASSWORD_SSH_FIXTURE

type Fixture = { hostname: '127.0.0.1'; port: number; username: 'cwpassword'; password: string; knownHosts: string; targetPort: number }
async function fixture(): Promise<Fixture> {
  const value = JSON.parse(await fs.readFile(fixturePath!, 'utf8')) as Fixture
  // An explicit loopback-only, dedicated-account fixture cannot probe a real host.
  assert.equal(value.hostname, '127.0.0.1')
  assert.equal(value.username, 'cwpassword')
  assert.ok(Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535)
  assert.ok(value.password.length > 0 && value.password.length <= 1024)
  assert.ok(path.isAbsolute(value.knownHosts))
  assert.ok(Number.isInteger(value.targetPort) && value.targetPort >= 1024 && value.targetPort <= 65535)
  return value
}
const run = (args: string[], source?: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  const child = execFile('ssh', args, { timeout: 8000, maxBuffer: 64 * 1024, encoding: 'utf8', env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' } }, (error, stdout, stderr) => {
    if (error) reject(new Error('Synthetic SSH channel failed'))
    else resolve({ stdout, stderr })
  })
  if (source !== undefined) child.stdin!.end(source)
  else child.stdin!.end()
})
async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

/** Run explicitly with an isolated sshd container; never use production credentials. */
test('real SSH password authentication shares strict mux channels without exposing credentials', {
  skip: fixturePath ? false : 'Set CODEX_TEST_PASSWORD_SSH_FIXTURE to an isolated loopback sshd fixture', timeout: 60_000,
}, async t => {
  const config = await fixture()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-password-live-'))
  const host: Host = { id: 'ssh-password-live', name: 'Synthetic password fixture', kind: 'ssh', hostname: config.hostname, port: config.port, username: config.username, authentication: 'password' }
  const pin: SSHHostKeyPin = { file: config.knownHosts, hostKeyAlias: `[${config.hostname}]:${config.port}` }
  let currentPassword = config.password
  const pool = new SshConnectionPool({ directory: root, password: async () => currentPassword })
  try {
    await t.test('a real password opens one master for concurrent command, file and preview channels', async () => {
      const leases = await Promise.all([pool.acquire(host, pin), pool.acquire(host, pin), pool.acquire(host, pin)])
      try {
        assert.equal(new Set(leases.map(lease => lease.control.socketPath)).size, 1)
        assert.equal(pool.status().transports, 1)
        const args = sshAppServerArgs(host, 'spawn', false, pin, leases[0]!.control)
        args[args.length - 1] = 'printf fixture-command-ok'
        assert.ok(!JSON.stringify(args).includes(config.password))
        const command = await run(args)
        assert.equal(command.stdout, 'fixture-command-ok')
        assert.ok(!command.stderr.includes(config.password))
        const file = await run(sshPythonArgs(host, pin, leases[1]!.control), 'print("fixture-file-ok")\n')
        assert.equal(file.stdout.trim(), 'fixture-file-ok')
        const localPort = await freePort()
        const forward = await openSshForward(host, pin, localPort, config.targetPort, { pool })
        try {
          const response = await fetch(`http://127.0.0.1:${localPort}/`, { signal: AbortSignal.timeout(3000) })
          assert.equal(await response.text(), 'fixture-preview-ok')
        } finally { await forward.release() }
        // Passwords must not be in a master's process argv or environment.
        if (process.platform === 'linux') {
          let found = false
          for (const pid of await fs.readdir('/proc')) {
            if (!/^\d+$/.test(pid)) continue
            try {
              const argv = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')
              if (!argv.includes(`ControlPath=${leases[0]!.control.socketPath}`)) continue
              found = true
              assert.ok(!argv.includes(config.password), 'SSH argv must not contain the password')
              assert.ok(!(await fs.readFile(`/proc/${pid}/environ`, 'utf8')).includes(config.password), 'SSH environment must not contain the password')
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error }
          }
          assert.ok(found, 'The shared SSH master must be observable during the check')
        }
      } finally { for (const lease of leases) lease.release() }
    })

    await t.test('a replacement password cannot reuse an authenticated old master', async () => {
      const original = await pool.acquire(host, pin)
      const oldSocket = original.control.socketPath
      currentPassword = config.password + '-incorrect'
      const failure = await pool.acquire(host, pin).then(() => undefined, error => error as Error)
      assert.ok(failure, 'An incorrect replacement credential must fail')
      assert.ok(!failure.message.includes(currentPassword))
      assert.match(failure.message, /认证|密码|身份验证/)
      const originalArgs = sshAppServerArgs(host, 'spawn', false, pin, original.control)
      originalArgs[originalArgs.length - 1] = 'printf original-channel-still-ok'
      assert.equal((await run(originalArgs)).stdout, 'original-channel-still-ok')
      currentPassword = config.password
      const restored = await pool.acquire(host, pin)
      assert.notEqual(restored.control.socketPath, oldSocket)
      original.release(); restored.release()
    })

    await t.test('missing password never falls back to a previous password-authenticated master', async () => {
      const missing = new SshConnectionPool({ directory: root, password: async () => undefined })
      try {
        const failure = await missing.acquire(host, pin).then(() => undefined, error => error as Error)
        assert.ok(failure)
        assert.ok(!failure.message.includes(config.password))
        assert.equal(missing.status().transports, 0)
      } finally { await missing.close() }
    })

    await t.test('an untrusted key is rejected even with the correct password', async () => {
      const wrongKey = path.join(root, 'untrusted-key')
      await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', wrongKey], { timeout: 5000 })
      const publicKey = (await fs.readFile(`${wrongKey}.pub`, 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ')
      const wrongHosts = path.join(root, 'wrong-known-hosts')
      await fs.writeFile(wrongHosts, `${pin.hostKeyAlias} ${publicKey}\n`, { mode: 0o600 })
      const rejected = new SshConnectionPool({ directory: root, password: async () => config.password })
      try {
        const failure = await rejected.acquire(host, { ...pin, file: wrongHosts }).then(() => undefined, error => error as Error)
        assert.ok(failure)
        assert.match(failure.message, /指纹|密钥/)
        assert.ok(!failure.message.includes(config.password))
      } finally { await rejected.close() }
    })
  } finally { await pool.close(); await fs.rm(root, { recursive: true, force: true }) }
})
