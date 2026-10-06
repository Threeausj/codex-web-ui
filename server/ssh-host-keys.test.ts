import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveSSHHost, SSHHostKeyError, SSHHostKeyService, type ResolvedSSHHost } from './ssh-host-keys.js'
import type { Host } from './types.js'

const execute = promisify(execFile)
const host: Host = { id: 'draft', name: 'Synthetic SSH', kind: 'ssh', hostname: 'host.example', username: 'developer', port: 2222 }
let keyDirectory: string
let oldKey: string
let newKey: string
let ecdsaKey: string
let rsaKey: string

before(async () => {
  keyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-key-fixtures-'))
  async function key(name: string, type: string) {
    const file = path.join(keyDirectory, name)
    await execute('ssh-keygen', ['-q', '-t', type, ...(type === 'rsa' ? ['-b', '2048'] : []), '-N', '', '-f', file])
    return (await fs.readFile(`${file}.pub`, 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ')
  }
  oldKey = await key('old', 'ed25519')
  newKey = await key('new', 'ed25519')
  ecdsaKey = await key('ecdsa', 'ecdsa')
  rsaKey = await key('rsa', 'rsa')
})
after(async () => { await fs.rm(keyDirectory, { recursive: true, force: true }) })

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-key-service-'))
  const external = path.join(directory, 'external_known_hosts')
  let currentKeys = [oldKey]
  let targetOverride: Partial<ResolvedSSHHost> = {}
  let currentTime = 1_000_000
  let scans = 0
  const service = new SSHHostKeyService({
    dataDir: path.join(directory, 'data'), now: () => currentTime,
    resolve: async requested => ({ hostname: requested.hostname!.toLowerCase(), port: requested.port ?? 22, username: requested.username || 'developer', lookupName: (requested.port ?? 22) === 22 ? requested.hostname!.toLowerCase() : `[${requested.hostname!.toLowerCase()}]:${requested.port}`, externalKnownHostsFiles: [external], ...targetOverride }),
    scan: async target => { scans++; return currentKeys.map(key => `${target.port === 22 ? target.hostname : `[${target.hostname}]:${target.port}`} ${key}`).join('\n') },
  })
  return { directory, external, service, setKeys: (keys: string[]) => { currentKeys = keys }, setTarget: (value: Partial<ResolvedSSHHost>) => { targetOverride = value }, setTime: (time: number) => { currentTime = time }, scans: () => scans, cleanup: () => fs.rm(directory, { recursive: true, force: true }) }
}

test('first use fingerprints match OpenSSH and persist only server-scanned keys with private modes', async () => {
  const setup = await fixture()
  try {
    setup.setKeys([oldKey, ecdsaKey, rsaKey, oldKey])
    const inspection = await setup.service.inspect(host, 'session-a')
    assert.equal(inspection.status, 'unknown')
    assert.deepEqual(inspection.previousFingerprints, [])
    assert.equal(inspection.keys.length, 3)
    for (const key of inspection.keys) {
      const publicFile = path.join(keyDirectory, key.type === 'ssh-rsa' ? 'rsa.pub' : key.type.startsWith('ecdsa-') ? 'ecdsa.pub' : 'old.pub')
      const expected = (await execute('ssh-keygen', ['-l', '-E', 'sha256', '-f', publicFile])).stdout.split(/\s+/)[1]
      assert.equal(key.fingerprint, expected)
      assert.deepEqual(Object.keys(key).sort(), ['fingerprint', 'type'])
    }
    assert.match(inspection.challenge!, /^[A-Za-z0-9_-]{43}$/)
    const result = await setup.service.trust(host, inspection.challenge!, false, 'session-a')
    assert.equal(result.status, 'trusted')
    assert.equal(setup.scans(), 2)
    assert.equal(result.challenge, undefined)
    const content = await fs.readFile(setup.service.knownHostsFile, 'utf8')
    assert.equal(content.trim().split('\n').length, 3)
    assert.ok(content.split('\n').filter(Boolean).every(line => line.startsWith('[host.example]:2222 ')))
    assert.equal((await fs.stat(setup.service.knownHostsFile)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(path.dirname(setup.service.knownHostsFile))).mode & 0o777, 0o700)
    assert.equal((await fs.stat(path.join(setup.directory, 'data'))).mode & 0o777, 0o700)
    assert.equal(await setup.service.connectionKnownHostsFile(host), setup.service.knownHostsFile)
    assert.deepEqual(await setup.service.connectionKnownHosts(host), { file: setup.service.knownHostsFile, hostKeyAlias: '[host.example]:2222' })
    const repeat = await setup.service.trust(host, inspection.challenge!, false, 'session-a')
    assert.deepEqual(repeat, result)
    assert.equal(setup.scans(), 2)
    assert.equal((await setup.service.inspect(host)).status, 'trusted')
  } finally { await setup.cleanup() }
})

test('hashed existing known_hosts entries are recognized and never modified', async () => {
  const setup = await fixture()
  try {
    await fs.writeFile(setup.external, `[host.example]:2222 ${oldKey}\n`)
    await execute('ssh-keygen', ['-H', '-f', setup.external])
    const before = await fs.readFile(setup.external, 'utf8')
    assert.match(before, /^\|1\|/)
    assert.equal(await setup.service.connectionKnownHostsFile(host), undefined)
    const inspection = await setup.service.inspect(host)
    assert.equal(inspection.status, 'trusted')
    assert.deepEqual(inspection.previousFingerprints, inspection.keys)
    await setup.service.trust(host, inspection.challenge!)
    assert.equal(await fs.readFile(setup.external, 'utf8'), before)
  } finally { await setup.cleanup() }
})

test('rotated keys require replacement confirmation, preserve other endpoints, and cannot revive an external old key', async () => {
  const setup = await fixture()
  try {
    await fs.writeFile(setup.external, `[host.example]:2222 ${oldKey}\n`)
    const original = await setup.service.inspect(host)
    await setup.service.trust(host, original.challenge!)
    const otherHost = { ...host, hostname: 'another.example', port: 22 }
    const other = await setup.service.inspect(otherHost)
    await setup.service.trust(otherHost, other.challenge!)
    setup.setKeys([newKey])
    const replacement = await setup.service.inspect(host)
    assert.equal(replacement.status, 'changed')
    assert.notDeepEqual(replacement.previousFingerprints, replacement.keys)
    await assert.rejects(setup.service.trust(host, replacement.challenge!), error => error instanceof SSHHostKeyError && error.status === 409 && /确认替换/.test(error.message))
    assert.ok((await fs.readFile(setup.service.knownHostsFile, 'utf8')).includes(oldKey))
    await setup.service.trust(host, replacement.challenge!, true)
    const content = await fs.readFile(setup.service.knownHostsFile, 'utf8')
    assert.equal(content.split('\n').filter(line => line.startsWith('[host.example]:2222 ')).join('\n'), `[host.example]:2222 ${newKey}`)
    assert.ok(content.includes(`another.example ${oldKey}`))
    assert.equal(await fs.readFile(setup.external, 'utf8'), `[host.example]:2222 ${oldKey}\n`)
    setup.setKeys([oldKey])
    assert.equal((await setup.service.inspect(host)).status, 'changed')
  } finally { await setup.cleanup() }
})

test('changed host key during confirmation rejects the snapshot without creating a trust file', async () => {
  const setup = await fixture()
  try {
    const inspection = await setup.service.inspect(host)
    setup.setKeys([newKey])
    await assert.rejects(setup.service.trust(host, inspection.challenge!, true), /确认期间发生变化/)
    await assert.rejects(fs.stat(setup.service.knownHostsFile), { code: 'ENOENT' })
  } finally { await setup.cleanup() }
})

test('HostKeyAlias case changes cannot retain an old key when the endpoint pin is replaced', async () => {
  const setup = await fixture()
  try {
    setup.setTarget({ lookupName: 'MiXeD-Alias' })
    const first = await setup.service.inspect(host)
    await setup.service.trust(host, first.challenge!)
    await fs.appendFile(setup.service.knownHostsFile, `MIXED-ALIAS ${oldKey}\n`)
    setup.setTarget({ lookupName: 'mixed-alias' })
    setup.setKeys([newKey])
    const replacement = await setup.service.inspect(host)
    assert.equal(replacement.status, 'changed')
    await setup.service.trust(host, replacement.challenge!, true)
    assert.equal(await fs.readFile(setup.service.knownHostsFile, 'utf8'), `mixed-alias ${newKey}\n`)
    setup.setTarget({ lookupName: 'MIXED-ALIAS' })
    setup.setKeys([oldKey])
    assert.equal((await setup.service.inspect(host)).status, 'changed')
  } finally { await setup.cleanup() }
})

test('challenges bind normalized destination, username, session and effective SSH configuration', async () => {
  const setup = await fixture()
  try {
    const inspection = await setup.service.inspect(host, 'owner')
    await assert.rejects(setup.service.trust({ ...host, hostname: 'different.example' }, inspection.challenge!, false, 'owner'), /地址已变更/)
    await assert.rejects(setup.service.trust({ ...host, port: 22 }, inspection.challenge!, false, 'owner'), /地址已变更/)
    await assert.rejects(setup.service.trust({ ...host, username: 'different' }, inspection.challenge!, false, 'owner'), /地址已变更/)
    await assert.rejects(setup.service.trust(host, inspection.challenge!, false, 'another-owner'), /地址已变更/)
    setup.setTarget({ hostname: 'new-alias-destination.example' })
    await assert.rejects(setup.service.trust(host, inspection.challenge!, false, 'owner'), /连接配置已变更/)
    assert.equal(setup.scans(), 1)
    setup.setTarget({})
    await setup.service.trust({ ...host, id: 'saved-id', hostname: ' HOST.EXAMPLE ' }, inspection.challenge!, false, 'owner')
  } finally { await setup.cleanup() }
})

test('expired and invented challenges cannot write trust', async () => {
  const setup = await fixture()
  try {
    const inspection = await setup.service.inspect(host)
    setup.setTime(inspection.expiresAt!)
    await assert.rejects(setup.service.trust(host, inspection.challenge!), /已过期/)
    await assert.rejects(setup.service.trust(host, 'browser-supplied-key-is-not-a-challenge'), /已过期/)
    assert.equal(setup.scans(), 1)
  } finally { await setup.cleanup() }
})

test('a concurrently updated known_hosts record invalidates old replacement consent', async () => {
  const setup = await fixture()
  try {
    const inspection = await setup.service.inspect(host)
    await fs.writeFile(setup.external, `[host.example]:2222 ${newKey}\n`)
    await assert.rejects(setup.service.trust(host, inspection.challenge!, true), /已保存的 SSH 指纹发生变化/)
    await assert.rejects(fs.stat(setup.service.knownHostsFile), { code: 'ENOENT' })
  } finally { await setup.cleanup() }
})

test('concurrent writes serialize and retain both newly trusted hosts', async () => {
  const setup = await fixture()
  try {
    const second = { ...host, hostname: 'second.example' }
    const [one, two] = await Promise.all([setup.service.inspect(host), setup.service.inspect(second)])
    await Promise.all([setup.service.trust(host, one.challenge!), setup.service.trust(second, two.challenge!)])
    const content = await fs.readFile(setup.service.knownHostsFile, 'utf8')
    assert.ok(content.includes(`[host.example]:2222 ${oldKey}`))
    assert.ok(content.includes(`[second.example]:2222 ${oldKey}`))
    assert.deepEqual((await fs.readdir(path.dirname(setup.service.knownHostsFile))).sort(), ['known_hosts'])
  } finally { await setup.cleanup() }
})

test('IPv6 and explicit HostKeyAlias produce exact scoped known_hosts entries', async () => {
  const setup = await fixture()
  try {
    const ipv6 = { ...host, hostname: '2001:db8::25' }
    const inspection = await setup.service.inspect(ipv6)
    await setup.service.trust(ipv6, inspection.challenge!)
    assert.ok((await fs.readFile(setup.service.knownHostsFile, 'utf8')).includes(`[2001:db8::25]:2222 ${oldKey}`))
    setup.setTarget({ hostname: 'actual.example', lookupName: 'literal-host-key-alias' })
    const alias = await setup.service.inspect(host)
    assert.equal(alias.hostname, 'actual.example')
    await setup.service.trust(host, alias.challenge!)
    assert.ok((await fs.readFile(setup.service.knownHostsFile, 'utf8')).includes(`literal-host-key-alias ${oldKey}`))
    assert.equal(await setup.service.connectionKnownHostsFile(host), setup.service.knownHostsFile)
    assert.deepEqual(await setup.service.connectionKnownHosts(host), { file: setup.service.knownHostsFile, hostKeyAlias: 'literal-host-key-alias' })
  } finally { await setup.cleanup() }
})

test('malformed wire keys, unexpected host aliases and oversized output are rejected', async () => {
  const setup = await fixture()
  try {
    const outputs = [
      `[host.example]:2222 ssh-rsa ${oldKey.split(' ')[1]}`,
      '[host.example]:2222 ssh-ed25519 AAAA',
      `another.example ${oldKey}`,
      `[host.example]:2222,another.example ${oldKey}`,
      `[host.example]:2222 ${oldKey} injected-comment`,
      `# ${'x'.repeat(65536)}`,
      '# SSH server greeting is not a public key',
    ]
    for (const output of outputs) {
      const service = new SSHHostKeyService({ dataDir: setup.directory, resolve: async () => ({ hostname: host.hostname!, port: 2222, username: 'developer', lookupName: '[host.example]:2222', externalKnownHostsFiles: [] }), scan: async () => output })
      await assert.rejects(service.inspect(host), error => error instanceof SSHHostKeyError && error.status === 502)
    }
    await assert.rejects(fs.stat(setup.service.knownHostsFile), { code: 'ENOENT' })
  } finally { await setup.cleanup() }
})

test('hostname syntax rejects keyscan aliases and option injection before any subprocess or scan', async () => {
  const setup = await fixture()
  try {
    for (const hostname of ['-f/etc/passwd', 'good.example bad.example', 'good.example,other', 'user@host.example', 'foo\nbar', 'host;touch injected', '../known_hosts', 'fe80::1%eth0']) {
      await assert.rejects(setup.service.inspect({ ...host, hostname }), error => error instanceof SSHHostKeyError && error.status === 400)
    }
    for (const port of [0, -1, 65536, 22.5]) await assert.rejects(setup.service.inspect({ ...host, port }), /端口/)
    assert.equal(setup.scans(), 0)
  } finally { await setup.cleanup() }
})

test('explicit revoked records cannot be overridden through website trust or managed pins', async () => {
  const setup = await fixture()
  try {
    const inspection = await setup.service.inspect(host)
    await setup.service.trust(host, inspection.challenge!)
    await fs.writeFile(setup.external, `@revoked [host.example]:2222 ${oldKey}\n`)
    await assert.rejects(setup.service.inspect(host), /已撤销/)
    await assert.rejects(setup.service.connectionKnownHostsFile(host), /已撤销/)
  } finally { await setup.cleanup() }
})

test('missing managed file keeps existing SSH paths untouched, including proxy aliases', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-key-no-pins-'))
  try {
    const service = new SSHHostKeyService({ dataDir: directory, resolve: async () => { throw new Error('must not resolve existing SSH configuration') } })
    assert.equal(await service.connectionKnownHostsFile(host), undefined)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('bounded concurrent scans reject extra work rather than spawning unlimited keyscan processes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-key-limit-'))
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  let scans = 0
  const service = new SSHHostKeyService({ dataDir: directory, resolve: async () => ({ hostname: host.hostname!, port: 2222, username: 'developer', lookupName: '[host.example]:2222', externalKnownHostsFiles: [] }), scan: async () => { scans++; await waiting; return `[host.example]:2222 ${oldKey}` } })
  try {
    const pending = Array.from({ length: 4 }, () => service.inspect(host))
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(scans, 4)
    await assert.rejects(service.inspect(host), error => error instanceof SSHHostKeyError && error.status === 429)
    release()
    await Promise.all(pending)
  } finally { release(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('ssh -G resolves real host/port/literal HostKeyAlias and detects unsupported jump scans without connecting', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-key-config-'))
  try {
    const config = path.join(directory, 'ssh_config')
    const known = path.join(directory, 'known_hosts')
    await fs.writeFile(config, `Host fixture-alias\n HostName actual.example\n Port 2200\n User remote-user\n HostKeyAlias literal-key-alias\n UserKnownHostsFile ${known}\n GlobalKnownHostsFile /dev/null\nHost fixture-jump\n HostName jump-target.example\n ProxyJump gateway.example\n`)
    const resolved = await resolveSSHHost({ ...host, hostname: 'fixture-alias', port: undefined, username: undefined }, config)
    assert.equal(resolved.hostname, 'actual.example')
    assert.equal(resolved.port, 2200)
    assert.equal(resolved.username, 'remote-user')
    assert.equal(resolved.lookupName, 'literal-key-alias')
    assert.deepEqual(resolved.externalKnownHostsFiles, [known])
    const jump = await resolveSSHHost({ ...host, hostname: 'fixture-jump', port: undefined }, config)
    assert.match(jump.scanUnsupportedReason!, /跳板机/)
    let scans = 0
    const service = new SSHHostKeyService({ dataDir: directory, resolve: requested => resolveSSHHost(requested, config), scan: async () => { scans++; return '' } })
    await assert.rejects(service.inspect({ ...host, hostname: 'fixture-jump', port: undefined }), /跳板机/)
    assert.equal(scans, 0)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('managed symlinks and corrupted matching entries cannot downgrade trust to external defaults', async () => {
  const setup = await fixture()
  try {
    await fs.mkdir(path.dirname(setup.service.knownHostsFile), { recursive: true })
    await fs.writeFile(setup.external, `[host.example]:2222 ${oldKey}\n`)
    await fs.symlink(setup.external, setup.service.knownHostsFile)
    await assert.rejects(setup.service.connectionKnownHostsFile(host), /符号链接/)
    await fs.rm(setup.service.knownHostsFile)
    await fs.writeFile(setup.service.knownHostsFile, '[host.example]:2222 ssh-ed25519 invalid-key\n')
    await assert.rejects(setup.service.connectionKnownHostsFile(host), /记录损坏/)
  } finally { await setup.cleanup() }
})

test('quoted known_hosts paths lost by ssh -G are rejected for scanning without affecting unmanaged connections', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-key-quoted-paths-'))
  try {
    const config = path.join(directory, 'ssh_config')
    const configuredHost = { ...host, hostname: 'fixture-path' }
    let scans = 0
    const service = new SSHHostKeyService({ dataDir: path.join(directory, 'data'), resolve: requested => resolveSSHHost(requested, config), scan: async () => { scans++; return '' } })
    const ambiguousNames = [path.join(directory, 'known hosts'), path.join(directory, 'part /absolute-looking-tail')]
    for (const file of ambiguousNames) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, `[fixture.example]:2222 ${oldKey}\n`)
      await fs.writeFile(config, `Host fixture-path\n HostName fixture.example\n UserKnownHostsFile "${file}" ${path.join(directory, 'other_hosts')}\n GlobalKnownHostsFile /dev/null\n`)
      const resolved = await resolveSSHHost(configuredHost, config)
      assert.match(resolved.scanUnsupportedReason!, /不含空格的绝对路径/)
      assert.deepEqual(resolved.externalKnownHostsFiles, [])
      await assert.rejects(service.inspect(configuredHost), /不含空格的绝对路径/)
      assert.equal(await service.connectionKnownHosts(configuredHost), undefined)
      await fs.mkdir(path.dirname(service.knownHostsFile), { recursive: true })
      await fs.writeFile(service.knownHostsFile, `another.example ${oldKey}\n`)
      assert.equal(await service.connectionKnownHosts(configuredHost), undefined)
      await fs.writeFile(service.knownHostsFile, `[fixture.example]:2222 ${oldKey}\n`)
      await assert.rejects(service.connectionKnownHosts(configuredHost), /不含空格的绝对路径/)
      await fs.rm(service.knownHostsFile)
    }
    assert.equal(scans, 0)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('ssh -G expands environment and percent tokens exactly once, including literal percent filenames', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-key-env-paths-'))
  const previous = process.env.CODEX_HOSTKEY_TEST_DIRECTORY
  try {
    const config = path.join(directory, 'ssh_config')
    const configuredHost = { ...host, hostname: 'fixture-env' }
    process.env.CODEX_HOSTKEY_TEST_DIRECTORY = directory
    const literalPercent = path.join(directory, 'literal%d_known_hosts')
    const environmentFile = path.join(directory, 'environment_known_hosts')
    await fs.writeFile(literalPercent, `[fixture.example]:2222 ${oldKey}\n`)
    await fs.writeFile(environmentFile, `[fixture.example]:2222 ${oldKey}\n`)
    await fs.writeFile(config, `Host fixture-env\n HostName fixture.example\n UserKnownHostsFile \${CODEX_HOSTKEY_TEST_DIRECTORY}/environment_known_hosts ${literalPercent.replace('%', '%%')}\n GlobalKnownHostsFile /dev/null\n`)
    const resolved = await resolveSSHHost(configuredHost, config)
    assert.equal(resolved.scanUnsupportedReason, undefined)
    assert.deepEqual(resolved.externalKnownHostsFiles, [environmentFile, literalPercent])
    const service = new SSHHostKeyService({ dataDir: path.join(directory, 'data'), resolve: requested => resolveSSHHost(requested, config), scan: async () => `[fixture.example]:2222 ${oldKey}` })
    assert.equal((await service.inspect(configuredHost)).status, 'trusted')
    process.env.CODEX_HOSTKEY_TEST_DIRECTORY = path.join(directory, 'environment with spaces')
    const unsupported = await resolveSSHHost(configuredHost, config)
    assert.match(unsupported.scanUnsupportedReason!, /不含空格的绝对路径/)
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOSTKEY_TEST_DIRECTORY
    else process.env.CODEX_HOSTKEY_TEST_DIRECTORY = previous
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('relative known_hosts fragments and excessive file lists fail closed with a clear parsing limitation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-key-path-limits-'))
  try {
    const config = path.join(directory, 'ssh_config')
    for (const value of ['relative_known_hosts', Array.from({ length: 17 }, (_, index) => `/tmp/synthetic_known_hosts_${index}`).join(' ')]) {
      await fs.writeFile(config, `Host fixture-limits\n HostName fixture.example\n UserKnownHostsFile ${value}\n GlobalKnownHostsFile /dev/null\n`)
      const resolved = await resolveSSHHost({ ...host, hostname: 'fixture-limits' }, config)
      assert.match(resolved.scanUnsupportedReason!, /不含空格的绝对路径/)
      assert.deepEqual(resolved.externalKnownHostsFiles, [])
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
