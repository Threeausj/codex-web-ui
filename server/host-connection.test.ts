import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { testHostConnection, connectionFailure } from './host-connection.js'
import type { Transport } from './bridge.js'
import type { Host } from './types.js'

const remote: Host = { id: 'probe-test', name: 'Probe', kind: 'ssh', hostname: 'host.example' }
function childTransport(child: ChildProcessWithoutNullStreams): Transport {
  const events = new EventEmitter()
  child.stderr.resume()
  child.on('error', error => events.emit('transportError', error))
  child.on('close', () => events.emit('transportClose', new Error('App-server subprocess closed')))
  return { input: child.stdin, output: child.stdout, events, dispose: () => { child.stdin.end(); child.kill('SIGTERM') } }
}
async function exited(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const force = setTimeout(() => child.kill('SIGKILL'), 1000)
    child.once('exit', () => { clearTimeout(force); resolve() })
  })
}

test('connection failures classify SSH and Codex diagnostics without exposing private banners, keys or RPC errors', () => {
  const cases = [
    ['Load key "/private/token-secret": invalid format', 'identity'],
    ['REMOTE HOST IDENTIFICATION HAS CHANGED', 'ssh'],
    ['Host key verification failed', 'ssh'],
    ['developer@host: Permission denied (publickey).', 'ssh'],
    ['ssh: Could not resolve hostname private-host: Name or service not known', 'ssh'],
    ['Connection refused', 'ssh'],
    ['/bin/sh: line 1: 3: Bad file descriptor', 'codex'],
    ['Codex was not found in the remote login-shell PATH', 'codex'],
    ['Invalid JSON from app-server', 'protocol'],
  ] as const
  for (const [diagnostic, stage] of cases) {
    const result = connectionFailure(new Error('token-secret'), diagnostic + '\nprivate token-secret banner', 'ssh')
    assert.equal(result.stage, stage, diagnostic)
    assert.ok(!result.message.includes('token-secret'))
    assert.ok(!result.message.includes('private-host'))
  }
  assert.equal(connectionFailure(new Error('Timed out'), '', 'protocol', true).stage, 'timeout')
})

test('identity-file preflight rejects unreadable or non-file drafts without opening a transport', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-probe-identity-'))
  let connected = false
  try {
    for (const identityFile of [path.join(directory, 'missing'), directory]) {
      const result = await testHostConnection({ ...remote, identityFile }, { transportFactory: () => { connected = true; throw new Error('Must not run') } })
      assert.equal(result.ok, false)
      assert.equal(result.stage, 'identity')
    }
    assert.equal(connected, false)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('a hung or invalid real subprocess fails its bounded probe and is disposed', { timeout: 5000 }, async () => {
  for (const source of ['setInterval(() => {}, 1000)', 'console.log("private token-secret banner"); setInterval(() => {}, 1000)']) {
    let child: ChildProcessWithoutNullStreams | undefined
    const result = await testHostConnection(remote, { transportFactory: () => childTransport(child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })) }, 300)
    assert.equal(result.ok, false)
    assert.equal(result.stage, source.startsWith('console.log') ? 'protocol' : 'timeout')
    assert.ok(result.elapsedMs < 1500)
    assert.ok(!result.message.includes('token-secret'))
    await exited(child!)
    assert.ok(child!.signalCode || child!.exitCode !== null)
  }
})

const binary = process.env.CODEX_BIN || 'codex'
const hasCodex = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0
test('the connection-test workflow handshakes with a real isolated Codex app-server and cleans up its subprocess', { skip: !hasCodex, timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-real-connection-probe-'))
  const home = path.join(directory, 'codex-home')
  await fs.mkdir(home)
  const env = { ...process.env, CODEX_HOME: home }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ACCESS_TOKEN']) delete env[key as keyof typeof env]
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    const result = await testHostConnection({ ...remote, cwd: directory }, { transportFactory: () => childTransport(child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] })) })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.stage, 'ready')
    await exited(child!)
    assert.ok(child!.signalCode || child!.exitCode !== null)
    // This workflow creates neither inference turns nor conversation files.
    assert.equal(await fs.access(path.join(home, 'sessions')).then(() => true, () => false), false)
  } finally { if (child) { child.kill('SIGTERM'); await exited(child) }; await fs.rm(directory, { recursive: true, force: true }) }
})
