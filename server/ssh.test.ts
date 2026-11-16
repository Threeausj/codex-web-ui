import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { remoteCodexCommand, remoteCodexDaemonCommand, codexAppServerArgs, codexDaemonArgs, sshAppServerArgs, sshCodexDaemonArgs, shellQuote } from './ssh.js'
import type { Host } from './types.js'

const execute = promisify(execFile)
const remote: Host = { id: 'ssh-test', kind: 'ssh', name: 'Test', hostname: 'host.example', username: 'developer' }

async function loginFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ssh-shell-'))
  const bin = path.join(directory, "bin's directory")
  const cwd = path.join(directory, "workspace ' ; $(touch injected)")
  await fs.mkdir(bin)
  await fs.mkdir(cwd)
  const shell = path.join(directory, 'login-shell')
  await fs.writeFile(shell, `#!/bin/sh\n[ "$1" = '-ilc' ] || exit 98\nprintf '%s\\n' 'login shell startup banner'\nPATH=${shellQuote(bin)}:$PATH\nexport PATH\nexec /bin/sh -c "$2"\n`, { mode: 0o700 })
  const binary = path.join(bin, 'codex')
  const source = `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\n`
  await fs.writeFile(binary, source, { mode: 0o700 })
  return { directory, bin, cwd, shell, source, binary, env: { ...process.env, SHELL: shell, PATH: '/usr/bin:/bin' } }
}

test('remote Codex discovery inherits interactive login PATH and keeps startup stdout out of protocol', async () => {
  const fixture = await loginFixture()
  try {
    const result = await execute('/bin/sh', ['-c', remoteCodexCommand({ ...remote, cwd: fixture.cwd })], { env: fixture.env })
    assert.deepEqual(JSON.parse(result.stdout), { args: ['-c', 'features.default_mode_request_user_input=true', 'app-server', '--listen', 'stdio://'], cwd: await fs.realpath(fixture.cwd) })
    assert.match(result.stderr, /login shell startup banner/)
    assert.ok(!result.stdout.includes('startup banner'))
    assert.equal(await fs.stat(fixture.binary).then(stat => stat.isFile()), true)
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }) }
})

test('interactive Bash closes extra descriptors at exec but still passes Codex protocol stdout and login PATH', async () => {
  const fixture = await loginFixture()
  try {
    // Do not read the test runner's real login files. Interactive Bash itself
    // marks inherited fd 3 close-on-exec, as the affected NAS login shell does.
    await fs.writeFile(fixture.shell, `#!/bin/sh\n[ "$1" = '-ilc' ] || exit 98\nprintf '%s\\n' 'isolated bash startup banner'\nPATH=${shellQuote(fixture.bin)}:$PATH\nexport PATH\nexec /bin/bash --noprofile --norc -ilc "$2"\n`, { mode: 0o700 })
    const result = await execute('/bin/sh', ['-c', remoteCodexCommand({ ...remote, cwd: fixture.cwd })], { env: fixture.env })
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ['-c', 'features.default_mode_request_user_input=true', 'app-server', '--listen', 'stdio://'],
      cwd: await fs.realpath(fixture.cwd),
    })
    assert.match(result.stderr, /isolated bash startup banner/)
    assert.ok(!result.stdout.includes('startup banner'))
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }) }
})

test('explicit remote Codex paths preserve spaces, quotes and shell metacharacters, including proxy mode', async () => {
  const fixture = await loginFixture()
  const binary = path.join(fixture.bin, "codex's ; $(touch injected)")
  await fs.writeFile(binary, fixture.source, { mode: 0o700 })
  try {
    const result = await execute('/bin/sh', ['-c', remoteCodexCommand({ ...remote, codexPath: binary, cwd: fixture.cwd }, 'proxy')], { env: fixture.env })
    assert.deepEqual(JSON.parse(result.stdout), { args: ['-c', 'features.default_mode_request_user_input=true', 'app-server', 'proxy'], cwd: await fs.realpath(fixture.cwd) })
    assert.equal(await fs.access(path.join(fixture.cwd, 'injected')).then(() => true, () => false), false)
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }) }
})

test('remote connection argv keeps SSH options separate and never forwards a local daemon socket', () => {
  const args = sshAppServerArgs({ ...remote, port: 2222, identityFile: '/keys/private key', codexPath: '/opt/codex' }, 'proxy')
  assert.deepEqual(args.slice(-7, -2), ['-p', '2222', '-i', '/keys/private key', '--'])
  assert.equal(args.at(-2), 'developer@host.example')
  assert.ok(args.at(-1)?.startsWith('exec /bin/sh -c '))
  assert.ok(!args.includes('--sock'))
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
})

test('connection-test launcher reports the actual remote Codex version on stderr before starting its protocol', async () => {
  const fixture = await loginFixture()
  const source = `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('codex-cli 0.200.0'); else console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n`
  await fs.writeFile(fixture.binary, source, { mode: 0o700 })
  try {
    const result = await execute('/bin/sh', ['-c', remoteCodexCommand({ ...remote, cwd: fixture.cwd }, 'spawn', true)], { env: fixture.env })
    assert.deepEqual(JSON.parse(result.stdout).args, ['-c', 'features.default_mode_request_user_input=true', 'app-server', '--listen', 'stdio://'])
    assert.match(result.stderr, /__CODEX_WEB_VERSION__=codex-cli 0\.200\.0/)
    assert.ok(!result.stdout.includes('codex-cli'))
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }) }
})

test('daemon proxy attaches without pretending per-process configuration changes the running daemon', async () => {
  const fixture = await loginFixture()
  try {
    const result = await execute('/bin/sh', ['-c', remoteCodexCommand({ ...remote, cwd: fixture.cwd }, 'proxy', false, true)], { env: fixture.env })
    assert.deepEqual(JSON.parse(result.stdout), { args: ['app-server', 'proxy'], cwd: await fs.realpath(fixture.cwd) })
    assert.deepEqual(codexAppServerArgs('proxy', '/private/socket', true), ['app-server', 'proxy', '--sock', '/private/socket'])
    assert.ok(!result.stdout.includes('startup banner'))
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }) }
})

test('daemon lifecycle uses the same remote login shell and quotes an explicit remote home literally', async () => {
  const fixture = await loginFixture()
  const home = path.join(fixture.directory, "codex home ' ; $(touch injected)")
  await fs.writeFile(fixture.binary, `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd:process.cwd(), home:process.env.CODEX_HOME }))\n`, { mode: 0o700 })
  try {
    const result = await execute('/bin/sh', ['-c', remoteCodexDaemonCommand({ ...remote, cwd: fixture.cwd }, 'start', home)], { env: fixture.env })
    assert.deepEqual(JSON.parse(result.stdout), { args: ['app-server', 'daemon', 'start'], cwd: await fs.realpath(fixture.cwd), home })
    assert.equal(await fs.access(path.join(fixture.cwd, 'injected')).then(() => true, () => false), false)
    assert.match(result.stderr, /login shell startup banner/)
  } finally { await fs.rm(fixture.directory, { recursive: true, force: true }) }
})

test('daemon lifecycle SSH arguments retain strict trust and the leased private socket', () => {
  const pin = { file: '/private/known_hosts', hostKeyAlias: 'trusted-remote' }
  const args = sshCodexDaemonArgs({ ...remote, port: 2222, identityFile: '/private/id key' }, 'version', pin, { socketPath: '/private/control' })
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('HostKeyAlias=trusted-remote'))
  assert.ok(args.includes('ControlPath=/private/control'))
  assert.equal(args.at(-2), 'developer@host.example')
  for (const action of ['start', 'version', 'restart', 'update'] as const) {
    assert.ok(!codexDaemonArgs(action).includes('-c'), 'lifecycle must not mutate shared feature settings')
  }
  assert.deepEqual(codexDaemonArgs('update'), ['app-server', 'daemon', 'update', '--from-cli', '--yes'])
  assert.throws(() => codexDaemonArgs('stop' as any), /Unsupported/)
})
