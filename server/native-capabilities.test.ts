import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NativeCapabilitiesService, nativeMethods, parseNativeCapabilities } from './native-capabilities.js'
import type { Host } from './types.js'

const host: Host = { id: 'fixture', name: 'Fixture', kind: 'local' }
const identity = { userAgent: 'codex_web/0.160.1 (Fixture)' }
function known() {
  return { status: 'known', checkedCliVersion: '0.160.1', methods: Object.fromEntries(nativeMethods.map(method => [method, { available: true, params: method === 'config/mcpServer/reload' ? [] : ['threadId'], required: method === 'config/mcpServer/reload' ? [] : ['threadId'] }])) }
}

test('capabilities keep only validated known method fields and reject unknown schemas', () => {
  const raw = { ...known(), credentials: 'private-token', schema: { secret: true } }
  const output = parseNativeCapabilities(raw, 10)
  assert.equal(output.status, 'known'); assert.equal(output.checkedAt, 10)
  assert.ok(!JSON.stringify(output).includes('private-token') && !('schema' in output))
  assert.deepEqual(parseNativeCapabilities({ status: 'known', methods: {} }, 10), { status: 'unknown', checkedAt: 10, methods: {} })
  raw.methods['skills/config/write']!.params = ['private-token\n']
  assert.equal(parseNativeCapabilities(raw, 10).status, 'unknown')
})

test('schema discovery is singleflight and bounded by positive TTL and native engine identity', async () => {
  let clock = 1000; let calls = 0; let release!: (value: unknown) => void
  const service = new NativeCapabilitiesService({ now: () => clock, collect: async () => { calls++; return new Promise(resolve => { release = resolve }) } })
  const one = service.read(host, { engineId: 'one', userAgent: 'codex_web/0.160.1 (one)' })
  const duplicate = service.read(host, { engineId: 'one', userAgent: 'codex_web/0.160.1 (one)' })
  assert.equal(calls, 1); release(known())
  const output = await one; assert.deepEqual(await duplicate, output)
  output.methods['skills/config/write']!.available = false
  assert.equal((await service.read(host, { engineId: 'one', userAgent: 'codex_web/0.160.1 (one)' })).methods['skills/config/write']!.available, true)
  clock += 5 * 60 * 1000
  const expired = service.read(host, { engineId: 'one', userAgent: 'codex_web/0.160.1 (one)' }); assert.equal(calls, 2); release(known()); await expired
  const changed = service.read(host, { engineId: 'two', userAgent: 'codex_web/0.160.1 (two)' }); assert.equal(calls, 3); release(known()); await changed
})

test('a transient or old CLI failure stays unknown and is retried instead of cached as unsupported', async () => {
  let clock = 1000; let calls = 0
  const service = new NativeCapabilitiesService({ now: () => clock, collect: async () => { calls++; if (calls === 1) throw new Error('private binary path failure'); return known() } })
  assert.equal((await service.read(host, identity)).status, 'unknown')
  assert.equal((await service.read(host, identity)).status, 'unknown'); assert.equal(calls, 1)
  clock += 15000
  assert.equal((await service.read(host, identity)).status, 'known'); assert.equal(calls, 2)
})

test('a stale schema collection cannot replace a newer engine snapshot or another host', async () => {
  const resolutions: ((value: unknown) => void)[] = []
  const service = new NativeCapabilitiesService({ collect: async () => new Promise(resolve => { resolutions.push(resolve) }) })
  const old = service.read(host, { ...identity, engineId: 'old' }); const current = service.read(host, { ...identity, engineId: 'new' }); const remote = service.read({ ...host, id: 'remote' }, { ...identity, engineId: 'new' })
  assert.equal(resolutions.length, 3)
  resolutions[1]!(known()); await current
  resolutions[2]!({ status: 'unknown' }); await remote
  resolutions[0]!({ status: 'unknown' }); await old
  assert.equal((await service.read(host, { ...identity, engineId: 'new' })).status, 'known')
  assert.equal((await service.read({ ...host, id: 'remote' }, { ...identity, engineId: 'new' })).status, 'unknown')
})

test('native collection runs code generation only in an isolated temporary home and discards CLI diagnostics', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-capabilities-fixture-'))
  const executable = path.join(directory, 'cli.py'); const marker = path.join(directory, 'calls.json')
  const schema = { definitions: { SkillParams: { type: 'object', properties: { path: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['enabled'] } }, oneOf: [
    { properties: { method: { enum: ['skills/config/write'] }, params: { $ref: '#/definitions/SkillParams' } } },
    { properties: { method: { const: 'config/mcpServer/reload' }, params: { type: 'null' } } },
  ] }
  await fs.writeFile(executable, `#!/usr/bin/env python3\nimport sys,os,json,pathlib\nargs=sys.argv[1:]\nif args==['--version']: print('codex-cli 0.160.1'); sys.exit(0)\nassert args[:2]==['app-server','generate-json-schema']\nassert '--experimental' in args\npathlib.Path(${JSON.stringify(marker)}).write_text(json.dumps({'args':args,'home':os.environ['CODEX_HOME']}))\nroot=pathlib.Path(args[args.index('--out')+1]);root.mkdir()\n(root/'ClientRequest.json').write_text(${JSON.stringify(JSON.stringify(schema))})\nprint('private-secret-cli-output')\nprint('private-secret-cli-error',file=sys.stderr)\n`, { mode: 0o700 })
  try {
    const service = new NativeCapabilitiesService({ bridgeOptions: { codexBin: executable } })
    const value = await service.read(host, identity)
    assert.equal(value.status, 'known'); assert.equal(value.methods['skills/config/write']!.available, true)
    assert.deepEqual(value.methods['skills/config/write']!.params, ['enabled', 'path'])
    assert.deepEqual(value.methods['skills/config/write']!.required, ['enabled'])
    assert.equal(value.methods['config/mcpServer/reload']!.available, true)
    assert.equal(value.methods['mcpServer/oauth/login']!.available, false)
    assert.ok(!JSON.stringify(value).includes('private-secret'))
    const call = JSON.parse(await fs.readFile(marker, 'utf8'))
    assert.ok(call.home.startsWith(os.tmpdir()) && call.home.includes('codex-web-schema-'))
    await assert.rejects(fs.stat(call.home), { code: 'ENOENT' })
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('proxy runtimes and missing native versions never guess capabilities or run a CLI', async () => {
  let calls = 0
  const service = new NativeCapabilitiesService({ collect: async () => { calls++; return known() } })
  assert.equal((await service.read(host, { ...identity, connectionMode: 'proxy' })).reason, 'proxy_runtime')
  assert.equal((await service.read(host, { userAgent: 'fixture-without-version' })).reason, 'runtime_version_unknown')
  const sshProxy = new NativeCapabilitiesService({ bridgeOptions: { mode: 'proxy' }, collect: async () => { calls++; return known() } })
  assert.equal((await sshProxy.read({ ...host, kind: 'ssh' }, { ...identity, connectionMode: 'ssh' })).reason, 'proxy_runtime')
  assert.equal(calls, 0)
})

test('an upgraded installed CLI cannot claim support for an older still-connected runtime', async () => {
  const service = new NativeCapabilitiesService({ collect: async () => known() })
  const value = await service.read(host, { userAgent: 'codex_web/0.159.2 (Fixture)' })
  assert.equal(value.status, 'unknown'); assert.equal(value.reason, 'runtime_version_mismatch'); assert.equal(value.checkedCliVersion, '0.160.1'); assert.deepEqual(value.methods, {})
})
