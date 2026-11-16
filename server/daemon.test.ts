import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Host } from './types.js'
import type { SshConnectionPool } from './ssh-pool.js'
import { ensureCodexDaemon, readCodexDaemonVersion, restartCodexDaemon, updateCodexDaemon } from './daemon.js'

const host: Host = { id: 'local-daemon-fixture', kind: 'local', name: 'Isolated test' }
const version = { managedCodexVersion: '0.165.0', cliVersion: '0.165.0', appServerVersion: '0.165.0' }

async function fixture(source?: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-daemon-test-'))
  const binary = path.join(directory, 'codex')
  const log = path.join(directory, 'commands.jsonl')
  await fs.writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,home:process.env.CODEX_HOME,cwd:process.cwd()})+'\\n');\n${source || `console.log(JSON.stringify({ status: args.includes('version') ? 'running' : args.includes('update') ? 'updated' : args.includes('restart') ? 'restarted' : 'alreadyRunning', ...${JSON.stringify(version)}, installedVersion:'0.165.0',runningVersion:'0.165.0' }));`}`, { mode: 0o700 })
  return { directory, binary, log, options: { codexBin: binary, codexHome: path.join(directory, 'home'), cwd: directory },
    commands: async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}

test('daemon connection preparation only uses idempotent start and preserves the configured local home', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  assert.deepEqual(await ensureCodexDaemon(host, f.options), { status: 'alreadyRunning', ...version })
  assert.deepEqual(await ensureCodexDaemon(host, f.options), { status: 'alreadyRunning', ...version })
  const commands = await f.commands()
  assert.equal(commands.length, 2)
  for (const command of commands) {
    assert.deepEqual(command.args, ['app-server', 'daemon', 'start'])
    assert.equal(command.home, f.options.codexHome)
    assert.equal(command.cwd, f.directory)
    assert.ok(!command.args.some((arg: string) => ['update', 'restart', 'stop', 'bootstrap'].includes(arg)))
  }
})

test('read-only daemon version returns only validated version metadata', async t => {
  const f = await fixture(`console.log(JSON.stringify({status:'running',...${JSON.stringify(version)},managedCodexPath:'/private/account/bin/codex',credential:'not-for-browser'}));`)
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  assert.deepEqual(await readCodexDaemonVersion(host, f.options), { status: 'running', ...version })
  assert.deepEqual((await f.commands())[0].args, ['app-server', 'daemon', 'version'])
})

test('an existing independently launched socket is reused without claiming daemon lifecycle ownership', async t => {
  const f = await fixture(`console.log(JSON.stringify({status:args.includes('version')?'running':'alreadyRunning',...${JSON.stringify(version)},managedCodexVersion:null,...(args.includes('version')?{backend:null}:{})}));`)
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  assert.deepEqual(await ensureCodexDaemon(host, f.options), { status: 'alreadyRunning', ...version, managedCodexVersion: null })
  assert.deepEqual(await readCodexDaemonVersion(host, f.options), { status: 'running', ...version, managedCodexVersion: null, backend: null })
  assert.deepEqual((await f.commands()).map(command => command.args.at(-1)), ['start', 'version'])
})

test('daemon ownership follows the running backend rather than only a selected managed package', async t => {
  const f = await fixture(`console.log(JSON.stringify({status:'running',...${JSON.stringify(version)},backend:null}));`)
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  const result = await readCodexDaemonVersion(host, f.options)
  assert.equal(result.managedCodexVersion, '0.165.0')
  assert.equal(result.backend, null)
})

test('only explicit lifecycle helpers perform restart and offline package update', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  assert.deepEqual(await restartCodexDaemon(host, f.options), { status: 'restarted' })
  assert.deepEqual(await updateCodexDaemon(host, f.options), { status: 'updated', installedVersion: '0.165.0', runningVersion: '0.165.0' })
  assert.deepEqual((await f.commands()).map(command => command.args), [
    ['app-server', 'daemon', 'restart'], ['app-server', 'daemon', 'update', '--from-cli', '--yes'],
  ])
})

test('an unmanaged daemon error is actionable and never triggers a repair or leaks remote stderr', async t => {
  const f = await fixture(`console.error('app server is running but is not managed: /private/secret key=example-secret');process.exitCode=1;`)
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await assert.rejects(ensureCodexDaemon(host, f.options), (error: any) => {
    assert.equal(error.code, 'daemon_unmanaged')
    assert.ok(!/private|example-secret/.test(error.message))
    return true
  })
  assert.equal((await f.commands()).length, 1)
})

test('updating an independently launched server without a selected daemon package fails before repair', async t => {
  const f = await fixture(`console.error('Error: no daemon package is selected; run codex app-server daemon start first');process.exitCode=1;`)
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await assert.rejects(updateCodexDaemon(host, f.options), (error: any) => error.code === 'daemon_unmanaged' && error.uncertain === false)
  assert.deepEqual((await f.commands()).map(command => command.args), [['app-server', 'daemon', 'update', '--from-cli', '--yes']])
})

test('invalid daemon JSON or versions remain uncertain after start and never become a false success', async t => {
  for (const output of ['not json', JSON.stringify({ status: 'started', ...version, appServerVersion: 'unknown' }), JSON.stringify({ status: 'stopped', ...version })]) {
    const f = await fixture(`console.log(${JSON.stringify(output)});`)
    t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
    await assert.rejects(ensureCodexDaemon(host, f.options), (error: any) => error.code === 'daemon_invalid_response' && error.uncertain === true)
    assert.equal((await f.commands()).length, 1)
  }
})

test('a cancelled lifecycle kills only its command and is not retried', async t => {
  const f = await fixture()
  // Replace the fixture body to record its own PID inside this fixture's private directory.
  await fs.writeFile(f.binary, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(f.log)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`, { mode: 0o700 })
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  const controller = new AbortController()
  const work = ensureCodexDaemon(host, f.options, controller.signal)
  let pid = 0
  for (let count = 0; count < 100 && !pid; count++) {
    pid = await fs.readFile(f.log, 'utf8').then(Number, () => 0)
    if (!pid) await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(pid > 0)
  controller.abort()
  await assert.rejects(work, (error: any) => error.code === 'daemon_cancelled' && error.uncertain === true)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('a pre-cancelled request never launches a daemon command', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(ensureCodexDaemon(host, f.options, controller.signal), (error: any) => error.code === 'daemon_cancelled' && error.uncertain === false)
  await assert.rejects(fs.access(f.log), { code: 'ENOENT' })
})

test('remote lifecycle leases the trusted SSH transport and never substitutes the container Codex home', async t => {
  const f = await fixture(`console.log(JSON.stringify({status:'alreadyRunning',...${JSON.stringify(version)}}));`)
  t.after(() => fs.rm(f.directory, { recursive: true, force: true }))
  await fs.copyFile(f.binary, path.join(f.directory, 'ssh'))
  await fs.chmod(path.join(f.directory, 'ssh'), 0o700)
  const previousPath = process.env.PATH
  process.env.PATH = f.directory + path.delimiter + previousPath
  t.after(() => { process.env.PATH = previousPath })
  const remote: Host = { id: 'ssh-daemon-fixture', kind: 'ssh', name: 'Remote test', hostname: 'fixture.invalid', username: 'user', port: 2222 }
  const pin = { file: '/private/trusted-hosts', hostKeyAlias: 'fixture-pin' }
  let acquisitions = 0, releases = 0
  const pool = { async acquire(actual: Host, actualPin: unknown) {
    assert.equal(actual, remote); assert.equal(actualPin, pin); acquisitions++
    return { control: { socketPath: '/private/ssh-control' }, release: () => { releases++ } }
  } } as unknown as SshConnectionPool
  assert.equal((await ensureCodexDaemon(remote, { ...f.options, sshPool: pool, resolveSshHostKeyPin: async () => pin })).status, 'alreadyRunning')
  assert.equal(acquisitions, 1); assert.equal(releases, 1)
  const args = (await f.commands())[0].args
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('HostKeyAlias=fixture-pin'))
  assert.ok(args.includes('ControlPath=/private/ssh-control'))
  assert.equal(args.at(-2), 'user@fixture.invalid')
  assert.ok(!args.at(-1).includes('CODEX_HOME='))
})
