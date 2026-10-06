import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { sshForwardArgs } from './dev-preview.js'
import { sshAppServerArgs } from './ssh.js'
import { resolveSSHHost, SSHHostKeyError, SSHHostKeyService, type SSHHostKeyPin } from './ssh-host-keys.js'
import type { Host } from './types.js'

const execute = promisify(execFile)
const available = process.getuid?.() === 0 && ['/usr/sbin/sshd', '/usr/bin/ssh', '/usr/bin/ssh-keygen', '/usr/bin/ssh-keyscan', '/run/sshd'].every(existsSync)
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

/** Only synthetic keys, loopback ports and a dedicated temporary sshd are used. */
test('real OpenSSH preserves endpoint pins across first trust, rotation, old-key fallback, aliases and forwarding', {
  skip: available ? false : 'Requires root, sshd and an existing privilege-separation directory', timeout: 40_000,
}, async t => {
  const username = os.userInfo().username
  const sshPort = await freePort()
  // StrictModes checks all ancestors of AuthorizedKeysFile; /run/sshd is private
  // to root and avoids a world-writable /tmp ancestor. Only this child is removed.
  const directory = await fs.mkdtemp('/run/sshd/codex-host-key-live-')
  const clientKey = path.join(directory, 'client-key')
  const firstHostKey = path.join(directory, 'host-key-first')
  const rotatedHostKey = path.join(directory, 'host-key-rotated')
  const authorizedKeys = path.join(directory, 'authorized_keys')
  const externalKnownHosts = path.join(directory, 'external_known_hosts')
  const clientConfig = path.join(directory, 'ssh_config')
  const serverConfig = path.join(directory, 'sshd_config')
  const children = new Set<ChildProcess>()
  const states = new Map<ChildProcess, { exit: Promise<void>; error?: Error; closed: boolean; stderr: string }>()
  let sshd: ChildProcess | undefined
  let tunnel: ChildProcess | undefined
  let development: http.Server | undefined

  function start(executable: string, args: string[]) {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'], signal: t.signal })
    children.add(child)
    const state = { exit: undefined as unknown as Promise<void>, error: undefined as Error | undefined, closed: false, stderr: '' }
    state.exit = new Promise<void>(resolve => {
      child.once('error', error => { state.error = error })
      child.once('close', () => { state.closed = true; children.delete(child); resolve() })
    })
    child.stderr!.on('data', chunk => { state.stderr = (state.stderr + chunk.toString()).slice(-16_384) })
    states.set(child, state)
    return child
  }
  async function stop(child: ChildProcess | undefined) {
    if (!child) return
    const state = states.get(child)!
    if (state.closed) return
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 1_000)
    try { await state.exit } finally { clearTimeout(force) }
  }
  async function waitForPort(port: number, child: ChildProcess) {
    const state = states.get(child)!
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !t.signal.aborted) {
      if (state.closed || state.error) throw new Error('Synthetic SSH process exited before accepting loopback connections')
      const listening = await new Promise<boolean>(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port })
        let done = false
        const finish = (ready: boolean) => { if (done) return; done = true; socket.destroy(); resolve(ready) }
        socket.setTimeout(150)
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
        socket.once('timeout', () => finish(false))
      })
      if (listening) return
      await pause(25)
    }
    throw new Error('Synthetic SSH process did not listen before the fixture deadline')
  }
  const run = (executable: string, args: string[]) => execute(executable, args, {
    timeout: 8_000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024, encoding: 'utf8', signal: t.signal,
  })
  async function launchServer(key: string) {
    await fs.writeFile(serverConfig, [
      `Port ${sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${key}`,
      `PidFile ${path.join(directory, 'sshd.pid')}`, `AuthorizedKeysFile ${authorizedKeys}`,
      'PubkeyAuthentication yes', 'PermitRootLogin prohibit-password', 'PasswordAuthentication no',
      'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes yes', `AllowUsers ${username}`,
      'AllowTcpForwarding local', 'GatewayPorts no', 'UseDNS no', 'PrintMotd no', 'LogLevel ERROR',
    ].join('\n') + '\n', { mode: 0o600 })
    await run('/usr/sbin/sshd', ['-t', '-f', serverConfig])
    sshd = start('/usr/sbin/sshd', ['-D', '-e', '-f', serverConfig])
    await waitForPort(sshPort, sshd)
  }
  async function literalCommand(host: Host, pin?: SSHHostKeyPin) {
    const args = sshAppServerArgs(host, 'spawn', false, pin)
    // Verify the actual app-server SSH arguments, replacing only its last remote
    // command with deterministic printf; no Codex process or model is invoked.
    args[args.length - 1] = 'printf fixture-ok'
    return run('/usr/bin/ssh', ['-F', clientConfig, ...args])
  }
  const keyRejected = (error: unknown) => {
    const failure = error as { code?: number; stderr?: string }
    // Never print complete SSH diagnostics, paths, credentials or public keys.
    assert.equal(failure.code, 255)
    assert.ok(/host key|host identification/i.test(failure.stderr || ''), 'Strict SSH must reject the missing or changed host key')
    return true
  }

  try {
    for (const key of [clientKey, firstHostKey, rotatedHostKey]) await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    await fs.copyFile(`${clientKey}.pub`, authorizedKeys)
    await fs.chmod(authorizedKeys, 0o600)
    await fs.writeFile(externalKnownHosts, '', { mode: 0o600 })
    await fs.writeFile(clientConfig, [
      'Host literal-fixture', '  HostName 127.0.0.1', `  Port ${sshPort}`, '  HostKeyAlias fixture-literal-pin',
      'Host *', `  User ${username}`, `  UserKnownHostsFile ${externalKnownHosts}`, '  GlobalKnownHostsFile /dev/null',
      `  IdentityFile ${clientKey}`, '  IdentitiesOnly yes', '  BatchMode yes', '  StrictHostKeyChecking yes',
      '  PasswordAuthentication no', '  PubkeyAuthentication yes', '  ControlMaster auto',
      `  ControlPath ${path.join(directory, 'ssh-master-%C')}`, '  ControlPersist 60',
      '  VerifyHostKeyDNS no', '  UpdateHostKeys no', '  LogLevel ERROR',
    ].join('\n') + '\n', { mode: 0o600 })
    const host: Host = { id: 'loopback-fixture', name: 'Synthetic loopback', kind: 'ssh', hostname: '127.0.0.1', username, port: sshPort, identityFile: clientKey }
    const service = new SSHHostKeyService({
      dataDir: path.join(directory, 'managed data % literal'),
      resolve: requested => resolveSSHHost(requested, clientConfig),
    })
    await launchServer(firstHostKey)
    const initial = await service.inspect(host, 'fixture-owner')
    assert.equal(initial.status, 'unknown')
    assert.equal(initial.lookupName, `[127.0.0.1]:${sshPort}`)
    assert.equal(initial.keys.length, 1)
    assert.equal(await service.connectionKnownHosts(host), undefined)
    await assert.rejects(literalCommand(host), keyRejected)
    await service.trust(host, initial.challenge!, false, 'fixture-owner')
    let pin = (await service.connectionKnownHosts(host))!
    assert.deepEqual(pin, { file: service.knownHostsFile, hostKeyAlias: `[127.0.0.1]:${sshPort}` })
    assert.match(pin.file, /managed data % literal/)
    assert.equal((await literalCommand(host, pin)).stdout, 'fixture-ok')
    assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('ssh-master-')), 'Pinned connections must not create or reuse persistent SSH masters')
    const oldPublicKey = (await fs.readFile(`${firstHostKey}.pub`, 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ')
    const externalContent = `[127.0.0.1]:${sshPort} ${oldPublicKey}\n`
    await fs.writeFile(externalKnownHosts, externalContent)

    await stop(sshd)
    await launchServer(rotatedHostKey)
    const changed = await service.inspect(host, 'fixture-owner')
    assert.equal(changed.status, 'changed')
    assert.deepEqual(changed.previousFingerprints, initial.keys)
    assert.notDeepEqual(changed.keys, initial.keys)
    await assert.rejects(literalCommand(host, pin), keyRejected)
    await assert.rejects(service.trust(host, changed.challenge!, false, 'fixture-owner'), error => error instanceof SSHHostKeyError && error.status === 409)
    await service.trust(host, changed.challenge!, true, 'fixture-owner')
    pin = (await service.connectionKnownHosts(host))!
    assert.equal((await literalCommand(host, pin)).stdout, 'fixture-ok')
    assert.equal(await fs.readFile(externalKnownHosts, 'utf8'), externalContent)

    development = http.createServer((_request, response) => response.end('fixture-http-ok'))
    await new Promise<void>((resolve, reject) => { development!.once('error', reject); development!.listen(0, '127.0.0.1', resolve) })
    const targetPort = (development.address() as net.AddressInfo).port
    const localPort = await freePort()
    const forwardArgs = sshForwardArgs(host, localPort, targetPort, pin)
    assert.ok(forwardArgs.includes(`HostKeyAlias=[127.0.0.1]:${sshPort}`))
    tunnel = start('/usr/bin/ssh', ['-F', clientConfig, ...forwardArgs])
    await waitForPort(localPort, tunnel)
    const forwarded = await fetch(`http://127.0.0.1:${localPort}/`, { signal: AbortSignal.timeout(2_000) })
    assert.equal(forwarded.status, 200)
    assert.equal(await forwarded.text(), 'fixture-http-ok')
    await stop(tunnel)
    tunnel = undefined
    await new Promise<void>(resolve => { development!.closeAllConnections(); development!.close(() => resolve()) })
    development = undefined

    // A key trusted for the default port must not revive a replaced key on this
    // other endpoint. The pin object's exact alias blocks OpenSSH's fallback.
    await fs.appendFile(service.knownHostsFile, `127.0.0.1 ${oldPublicKey}\n`)
    await stop(sshd)
    await launchServer(firstHostKey)
    await assert.rejects(literalCommand(host, pin), keyRejected)
    assert.equal((await service.inspect(host, 'fixture-owner')).status, 'changed')
    assert.equal(await fs.readFile(externalKnownHosts, 'utf8'), externalContent)

    // SSH config aliases preserve their configured non-default port and their
    // literal HostKeyAlias, rather than accidentally pinning another endpoint.
    const aliasHost: Host = { ...host, id: 'alias-fixture', hostname: 'literal-fixture', port: undefined }
    const alias = await service.inspect(aliasHost, 'fixture-owner')
    assert.equal(alias.status, 'unknown')
    assert.equal(alias.port, sshPort)
    assert.equal(alias.lookupName, 'fixture-literal-pin')
    await service.trust(aliasHost, alias.challenge!, false, 'fixture-owner')
    const aliasPin = (await service.connectionKnownHosts(aliasHost))!
    assert.equal(aliasPin.hostKeyAlias, 'fixture-literal-pin')
    assert.equal((await literalCommand(aliasHost, aliasPin)).stdout, 'fixture-ok')
    await assert.rejects(literalCommand(host, (await service.connectionKnownHosts(host))!), keyRejected)
  } finally {
    await Promise.all([...children].map(stop))
    if (development) await new Promise<void>(resolve => { development!.closeAllConnections(); development!.close(() => resolve()) })
    await fs.rm(directory, { recursive: true, force: true })
  }
})
