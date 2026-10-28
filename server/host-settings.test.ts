import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import express from 'express'
import { z } from 'zod'
import { Auth } from './auth.js'
import { Bridge, type Transport } from './bridge.js'
import { gatewayKeyWriter, gatewayTokenReader, redactSettings, registerHostSettings } from './host-settings.js'
import type { Host, RpcMessage } from './types.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function fixture(options: { proxy?: boolean; automationBusy?: boolean; config?: Record<string, any>; writeFailure?: boolean; override?: Record<string, any>; cliVersion?: string } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-settings-'))
  const origin = 'http://localhost:8787', auth = new Auth('host-settings-fixture', new Set([origin]))
  const hosts: Host[] = [{ id: 'local', kind: 'local', name: 'Local' }, { id: 'remote', kind: 'ssh', name: 'Remote', hostname: 'offline.invalid' }, { id: 'offline', kind: 'local', name: 'Disconnected' }]
  const peers = new Map<string, { sent: RpcMessage[]; disposed: boolean; output: PassThrough }[]>(), bridges = new Map<string, Bridge>()
  const configurations = new Map(hosts.map(host => [host.id, { model: `${host.id}-model`, model_provider: 'openai', model_context_window: 500000, ...(options.config || {}) } as Record<string, any>]))
  const writes: { hostId: string; file: string; key: string }[] = []
  const removed: { hostId: string; file: string }[] = []
  let reserved = 0, automationBusy = !!options.automationBusy, failWrite = !!options.writeFailure
  for (const host of hosts.slice(0, 2)) {
    const collection: { sent: RpcMessage[]; disposed: boolean; output: PassThrough }[] = []; peers.set(host.id, collection)
    const bridge = new Bridge(host, { mode: options.proxy ? 'proxy' : 'spawn', transportFactory: () => {
      const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter(); let buffer = ''
      const peer = { sent: [] as RpcMessage[], disposed: false, output }; collection.push(peer)
      const transport: Transport = { input, output, events, dispose: () => { peer.disposed = true; input.destroy(); output.destroy() } }
      const receive = (message: RpcMessage) => { if (!peer.disposed) output.write(`${JSON.stringify(message)}\n`) }
      input.on('data', chunk => {
        buffer += chunk.toString(); let at: number
        while ((at = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, at)) as RpcMessage; buffer = buffer.slice(at + 1); peer.sent.push(message)
          if (message.id === undefined) continue
          const params = message.params as any, config = configurations.get(host.id)!
          let result: any = {}
          if (message.method === 'initialize') result = { userAgent: options.cliVersion ? `codex_cli_rs/${options.cliVersion}` : `fixture/${host.id}/${collection.length}`, codexHome: `/fixture/${host.id}/.codex` }
          if (message.method === 'thread/loaded/list' || message.method === 'thread/backgroundTerminals/list') result = { data: [], nextCursor: null }
          if (message.method === 'config/read') result = { config: { ...config, ...options.override }, layers: [{ name: { type: 'user', file: `/fixture/${host.id}/.codex/config.toml` }, version: 'fixture-version', config }] }
          if (message.method === 'account/read') result = { account: { type: 'chatgpt', email: `${host.id}@example.invalid`, access_token: 'private-official-token' } }
          if (message.method === 'memory/status') result = { v2ConsolidatedThreads: 21, v2Ready: true }
          if (message.method === 'thread/memory/read') result = { summary: `${host.id} memory for ${params.threadId}` }
          if (message.method === 'account/login/start') result = { type: 'chatgptDeviceCode', loginId: `login-${host.id}`, userCode: 'TEST-CODE', verificationUrl: 'https://auth.openai.com/codex/device' }
          if (message.method === 'config/batchWrite') {
            if (failWrite) { queueMicrotask(() => receive({ id: message.id, error: { code: -32001, message: 'Fixture optimistic version conflict' } })); continue }
            for (const edit of params.edits) {
              if (edit.keyPath.startsWith('model_providers.')) { config.model_providers ||= {}; config.model_providers[edit.keyPath.split('.')[1]] = edit.value }
              else config[edit.keyPath] = edit.value
            }
          }
          queueMicrotask(() => receive({ id: message.id, result }))
        }
      })
      return transport
    } }); bridges.set(host.id, bridge)
    await bridge.connect()
  }
  const app = express(); app.use(express.json()); app.post('/api/auth/login', auth.login); app.use('/api', auth.requireAuth, auth.requireCsrf)
  registerHostSettings(app, { getHost: id => hosts.find(host => host.id === id), getExistingBridge: id => bridges.get(id),
    withRuntimeMaintenance: async (_id, work) => { reserved++; if (automationBusy) throw Object.assign(new Error('Fixture automation running'), { status: 409 }); return work() },
    writeKey: async (host, file, key) => { writes.push({ hostId: host.id, file, key }) }, removeKey: async (host, file) => { removed.push({ hostId: host.id, file }) } })
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof z.ZodError ? 400 : error.status || 500).json({ error: error.message }))
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'host-settings-fixture' }) })
  const { csrfToken } = await login.json(), cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const headers = { origin, 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }
  const request = (endpoint = 'codex-settings', body?: unknown, hostId = 'remote', custom = headers) => fetch(`${base}/api/hosts/${hostId}/${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: custom, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { request, hosts, bridges, peers, configurations, writes, removed, base, headers, get reserved() { return reserved },
    setAutomationBusy(value: boolean) { automationBusy = value }, setWriteFailure(value: boolean) { failWrite = value },
    async close() { for (const bridge of bridges.values()) bridge.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }); await fs.rm(directory, { recursive: true, force: true }) } }
}

test('host Codex settings require authentication and CSRF and cannot forward arbitrary RPC methods or fields', async t => {
  const f = await fixture(); t.after(() => f.close())
  assert.equal((await fetch(`${f.base}/api/hosts/remote/codex-settings`)).status, 401)
  assert.equal((await f.request('codex-settings/provider', { provider: 'official' }, 'remote', { origin: f.headers.origin, 'content-type': 'application/json' } as any)).status, 401)
  assert.equal((await f.request('codex-settings/provider', { provider: 'official' }, 'remote', { ...f.headers, 'x-csrf-token': '' })).status, 403)
  assert.equal((await f.request('codex-settings', undefined, 'missing')).status, 404)
  assert.equal((await f.request('settings/rpc', { method: 'turn/start', params: { threadId: 'private', input: [] } })).status, 400)
  assert.equal((await f.request('settings/rpc', { method: 'account/read', params: { refreshToken: true } })).status, 400)
  assert.equal((await f.request('settings/rpc', { method: 'config/read', params: { includeLayers: true, hiddenSecretMethod: true } })).status, 400)
  assert.equal((await f.request('codex-settings/provider', { provider: 'official', extra: true })).status, 400)
  assert.equal(f.writes.length, 0); assert.equal(f.reserved, 0)
})

test('runtime settings reads target only the chosen host, redact stored keys, and do not start disconnected hosts', async t => {
  const f = await fixture({ config: { model_provider: 'custom', model_providers: { custom: { base_url: 'https://user:private-url-key@api.example.invalid/v1?token=private-query#private-fragment', experimental_bearer_token: 'private-api-key', auth: { command: 'echo', args: ['private-command-key'] }, http_headers: { Authorization: 'Bearer private-header-key' }, env: { OPAQUE: 'private-env-key' } } } } }); t.after(() => f.close())
  const localBefore = f.peers.get('local')![0]!.sent.length
  const setting = await (await f.request()).json()
  assert.equal(setting.provider, 'custom'); assert.equal(setting.baseUrl, 'https://api.example.invalid/v1')
  assert.equal(setting.account.email, 'remote@example.invalid')
  assert.doesNotMatch(JSON.stringify(setting), /private-/)
  const config = await (await f.request('settings/rpc', { method: 'config/read', params: { includeLayers: true } })).json()
  assert.equal(config.config.model_context_window, 500000)
  assert.doesNotMatch(JSON.stringify(config), /private-api-key|private-command-key|private-header-key|private-env-key/)
  assert.equal(f.peers.get('local')![0]!.sent.length, localBefore)
  const offline = await (await f.request('codex-settings', undefined, 'offline')).json()
  assert.equal(offline.connected, false); assert.equal(offline.canChange, false); assert.equal(f.bridges.has('offline'), false)
  assert.equal((await f.request('codex-settings/provider', { provider: 'official' }, 'offline')).status, 409)
})

for (const url of ['invalid url', 'javascript:alert(1)', 'file:///tmp/config', 'https://user:password@api.example.invalid', 'https://api.example.invalid/v1?api_key=secret', 'https://api.example.invalid/v1#secret']) {
  test(`provider rejects unsafe URL ${url.split(':')[0]} before writing credentials or refreshing the runtime`, async t => {
    const f = await fixture(); t.after(() => f.close())
    assert.equal((await f.request('codex-settings/provider', { provider: 'gateway', baseUrl: url, apiKey: 'secret-key' })).status, 400)
    assert.equal(f.writes.length, 0); assert.equal(f.peers.get('remote')!.length, 1); assert.equal(f.reserved, 0)
  })
}

test('gateway settings write a host-specific private key reference, use the user config version and preserve official auth', async t => {
  const f = await fixture(); t.after(() => f.close())
  const localBefore = f.peers.get('local')![0]!.sent.length
  const response = await f.request('codex-settings/provider', { provider: 'gateway', baseUrl: 'https://api.example.invalid/v1/', apiKey: 'private-new-gateway-key', model: 'new-model' })
  assert.equal(response.status, 200)
  const value = await response.json(); assert.equal(value.provider, 'gateway'); assert.equal(value.hasApiKey, true)
  assert.equal(value.applied, true); assert.equal(value.requestedProvider, 'gateway'); assert.equal(value.warning, undefined)
  assert.equal(value.baseUrl, 'https://api.example.invalid/v1'); assert.equal(value.model, 'new-model')
  assert.doesNotMatch(JSON.stringify(value), /private-new-gateway-key|private-official-token/)
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0]!.hostId, 'remote')
  assert.match(f.writes[0]!.file, /^\/fixture\/remote\/\.codex\/\.web-gateway-key-[a-f0-9-]+$/)
  const before = f.peers.get('remote')![0]!, writes = before.sent.filter(message => message.method === 'config/batchWrite')
  assert.equal(writes.length, 1)
  const params = writes[0]!.params as any
  assert.equal(params.filePath, '/fixture/remote/.codex/config.toml'); assert.equal(params.expectedVersion, 'fixture-version'); assert.equal(params.reloadUserConfig, false)
  assert.equal(params.edits.find((edit: any) => edit.keyPath === 'model_provider').value, 'web_gateway')
  const provider = params.edits.find((edit: any) => edit.keyPath === 'model_providers.web_gateway').value
  assert.equal(provider.auth.command, 'python3'); assert.deepEqual(provider.auth.args, ['-c', gatewayTokenReader, f.writes[0]!.file])
  assert.equal(provider.wire_api, 'responses'); assert.equal(before.disposed, true); assert.equal(f.peers.get('remote')!.length, 2)
  assert.equal(before.sent.some(message => ['account/logout', 'account/login/start', 'fs/writeFile', 'thread/archive', 'turn/interrupt'].includes(message.method || '')), false)
  assert.equal(f.peers.get('local')![0]!.sent.length, localBefore)
  assert.doesNotMatch(JSON.stringify(f.peers.get('remote')!.flatMap(peer => peer.sent)), /private-new-gateway-key/)
  const oldReference = f.configurations.get('remote')!.model_providers.web_gateway.auth.args.at(-1)
  assert.equal((await f.request('codex-settings/provider', { provider: 'gateway', baseUrl: 'https://api.example.invalid/v1' })).status, 200)
  assert.equal(f.writes.length, 1); assert.equal(f.configurations.get('remote')!.model_providers.web_gateway.auth.args.at(-1), oldReference)
  assert.equal((await f.request('codex-settings/provider', { provider: 'gateway', baseUrl: 'https://another.example.invalid/v1' })).status, 400)
  assert.equal(f.writes.length, 1)
  assert.equal((await f.request('codex-settings/provider', { provider: 'official' })).status, 200)
  assert.equal(f.configurations.get('remote')!.model_provider, 'openai')
  assert.equal(f.writes.length, 1)
})

for (const [name, override] of [
  ['provider', { model_provider: 'managed-provider' }],
  ['API root', { model_providers: { web_gateway: { base_url: 'https://managed.example.invalid/v1', auth: { command: 'echo', args: ['private-managed-credential'] } } } }],
  ['model', { model: 'managed-model' }],
] as const) {
  test(`provider write reports a higher-priority ${name} override without pretending the saved setting is active`, async t => {
    const f = await fixture({ override }); t.after(() => f.close())
    const response = await f.request('codex-settings/provider', { provider: 'gateway', baseUrl: 'https://requested.example.invalid/v1', apiKey: 'private-requested-credential', model: 'requested-model' })
    assert.equal(response.status, 200)
    const value = await response.json()
    assert.equal(value.applied, false); assert.equal(value.requestedProvider, 'gateway')
    assert.match(value.warning, /配置已保存.*高.*优先级/)
    assert.equal(f.configurations.get('remote')!.model_provider, 'web_gateway')
    assert.equal(f.configurations.get('remote')!.model_providers.web_gateway.base_url, 'https://requested.example.invalid/v1')
    assert.equal(f.writes.length, 1); assert.equal(f.removed.length, 0)
    assert.doesNotMatch(JSON.stringify(value), /private-requested-credential|private-managed-credential/)
    assert.equal(f.peers.get('remote')!.length, 2)
  })
}

for (const busy of ['turn', 'approval', 'automation', 'proxy'] as const) {
  test(`provider change preserves ${busy} without writing keys or restarting a transport`, async t => {
    const f = await fixture({ proxy: busy === 'proxy', automationBusy: busy === 'automation' }); t.after(() => f.close())
    const peer = f.peers.get('remote')![0]!
    if (busy === 'turn') peer.output.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'running-child', status: { type: 'active' } } } })}\n`)
    if (busy === 'approval') peer.output.write(`${JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } })}\n`)
    const response = await f.request('codex-settings/provider', { provider: 'gateway', baseUrl: 'https://api.example.invalid/v1', apiKey: 'secret' })
    assert.equal(response.status, 409); assert.equal(f.writes.length, 0); assert.equal(peer.disposed, false)
    assert.equal(peer.sent.some(message => message.method === 'config/batchWrite'), false)
    assert.equal(f.configurations.get('remote')!.model_provider, 'openai')
  })
}

test('raw config mutations require idle maintenance and may only address the selected host user config', async t => {
  const f = await fixture(); t.after(() => f.close())
  const edit = { keyPath: 'model_context_window', value: 500000, mergeStrategy: 'replace' }
  const peer = f.peers.get('remote')![0]!
  peer.output.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'busy', status: { type: 'active' } } } })}\n`)
  assert.equal((await f.request('settings/rpc', { method: 'config/batchWrite', params: { edits: [edit] } })).status, 409)
  assert.equal(peer.sent.some(message => message.method === 'config/batchWrite'), false)
  peer.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'busy', turn: { id: 'done' } } })}\n`)
  for (const filePath of ['/fixture/local/.codex/config.toml', '/etc/passwd', 'relative/path', ''])
    assert.equal((await f.request('settings/rpc', { method: 'config/batchWrite', params: { edits: [edit], filePath } })).status, 400)
  assert.equal((await f.request('settings/rpc', { method: 'config/batchWrite', params: { edits: [edit], filePath: '/fixture/remote/.codex/config.toml', expectedVersion: 'fixture-version', reloadUserConfig: true } })).status, 200)
  assert.equal(peer.sent.filter(message => message.method === 'config/batchWrite').length, 1)
  assert.equal(peer.disposed, false)
})

test('official device authorization is returned without restarting or canceling the native login', async t => {
  const f = await fixture(); t.after(() => f.close())
  const peer = f.peers.get('remote')![0]!, engine = f.bridges.get('remote')!.runtime.engineId
  const response = await f.request('codex-settings/login', { type: 'deviceAuth' })
  assert.equal(response.status, 200); const result = await response.json()
  assert.equal(result.loginId, 'login-remote'); assert.equal(result.userCode, 'TEST-CODE')
  assert.equal(result.verificationUrl, 'https://auth.openai.com/codex/device')
  assert.equal((peer.sent.find(message => message.method === 'account/login/start')!.params as any).type, 'chatgptDeviceCode')
  assert.equal(f.peers.get('remote')!.length, 1); assert.equal(peer.disposed, false); assert.equal(f.bridges.get('remote')!.runtime.engineId, engine)
  assert.equal(peer.sent.some(message => message.method === 'account/login/cancel'), false)
  assert.equal((await f.request('codex-settings/login/cancel', { loginId: 'login-remote' })).status, 200)
  assert.equal((peer.sent.find(message => message.method === 'account/login/cancel')!.params as any).loginId, 'login-remote')
  assert.equal((await f.request('codex-settings/logout', {})).status, 200)
  assert.equal(peer.sent.filter(message => message.method === 'account/logout').length, 1); assert.equal(peer.disposed, false)
})

test('gateway mode and busy native tasks cannot initiate or logout an official account', async t => {
  const f = await fixture({ config: { model_provider: 'web_gateway' } }); t.after(() => f.close())
  const peer = f.peers.get('remote')![0]!
  assert.equal((await f.request('codex-settings/login', { type: 'deviceAuth' })).status, 409)
  assert.equal(peer.sent.some(message => message.method === 'account/login/start'), false)
  peer.output.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'busy', status: { type: 'active' } } } })}\n`)
  assert.equal((await f.request('codex-settings/logout', {})).status, 409)
  assert.equal(peer.sent.some(message => message.method === 'account/logout'), false)
})

test('failed optimistic provider write does not replace an old credential reference or restart its runtime', async t => {
  const oldAuth = { command: 'python3', args: ['-c', gatewayTokenReader, '/fixture/remote/.codex/.web-gateway-key-old'] }
  const f = await fixture({ writeFailure: true, config: { model_provider: 'web_gateway', model_providers: { web_gateway: { base_url: 'https://old.example.invalid/v1', auth: oldAuth } } } }); t.after(() => f.close())
  const peer = f.peers.get('remote')![0]!
  const response = await f.request('codex-settings/provider', { provider: 'gateway', baseUrl: 'https://new.example.invalid/v1', apiKey: 'new-credential' })
  assert.equal(response.status, 500); assert.equal(peer.disposed, false)
  assert.deepEqual(f.configurations.get('remote')!.model_providers.web_gateway.auth, oldAuth)
  assert.equal(f.writes.length, 1); assert.notEqual(f.writes[0]!.file, oldAuth.args.at(-1))
  assert.deepEqual(f.removed, [{ hostId: 'remote', file: f.writes[0]!.file }])
  assert.equal(f.bridges.get('remote')!.reconnectStatus.canReconnect, true)
})

test('credential redaction includes environment names and command auth while preserving token-window metadata', () => {
  const value = { OPENAI_API_KEY: 'secret-key', BEARER_TOKEN: 'secret-bearer', env: { UNNAMED: 'secret-env' }, auth: { command: 'echo', args: ['secret-command'] }, headers: { Authorization: 'secret-header' }, api_key: 'secret-api', model_auto_compact_token_limit: 480000, model_context_window: 500000 }
  assert.doesNotMatch(JSON.stringify(redactSettings(value)), /secret-/)
  assert.equal(redactSettings(value).model_auto_compact_token_limit, 480000)
})

test('private gateway writer uses atomic replacement, mode 0600 and preserves unrelated official auth files', async t => {
  const python = spawnSync('python3', ['--version'], { stdio: 'ignore' }); if (python.status !== 0) return t.skip('Python is unavailable')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-gateway-writer-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const authFile = path.join(directory, 'auth.json'), file = path.join(directory, '.web-gateway-key-fixture')
  await fs.writeFile(authFile, '{"fixture":"official-preserved"}')
  const result = spawnSync('python3', ['-'], { input: gatewayKeyWriter(file, 'private-fixture-key'), encoding: 'utf8' })
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'ok')
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.equal(await fs.readFile(file, 'utf8'), 'private-fixture-key')
  assert.equal(await fs.readFile(authFile, 'utf8'), '{"fixture":"official-preserved"}')
  assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.web-key-')), false)
})

test('Vertex AI uses the native GCP provider on the selected host and preserves credentials and provider overrides', async t => {
  const originalGcp = { base_url: 'https://vertex.example.invalid/v1', http_headers: { 'x-custom': 'private-header' } }
  const f = await fixture({ cliVersion: '0.165.0', config: { model_providers: { gcp: originalGcp, web_gateway: { base_url: 'https://gateway.example.invalid/v1', auth: { command: 'fixture-key' } } } } }); t.after(() => f.close())
  const localBefore = f.peers.get('local')![0]!.sent.length
  assert.equal((await (await f.request()).json()).supportsGcp, true)
  const response = await f.request('codex-settings/provider', { provider: 'gcp', model: 'gpt-6.1-sol' })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.provider, 'gcp'); assert.equal(result.providerId, 'gcp'); assert.equal(result.applied, true)
  assert.equal(result.baseUrl, originalGcp.base_url); assert.equal(result.model, 'gpt-6.1-sol')
  assert.doesNotMatch(JSON.stringify(result), /private-header|private-official-token/)
  assert.deepEqual(f.configurations.get('remote')!.model_providers.gcp, originalGcp)
  assert.equal(f.writes.length, 0); assert.equal(f.removed.length, 0)
  const edits = f.peers.get('remote')![0]!.sent.find(message => message.method === 'config/batchWrite')!.params as any
  assert.deepEqual(edits.edits, [{ keyPath: 'model', value: 'gpt-6.1-sol', mergeStrategy: 'replace' }, { keyPath: 'model_provider', value: 'gcp', mergeStrategy: 'replace' }])
  assert.equal(f.peers.get('local')![0]!.sent.length, localBefore)
  assert.equal(f.peers.get('remote')!.flatMap(peer => peer.sent).some(message => ['account/login/start', 'account/logout', 'turn/start'].includes(message.method || '')), false)
})

for (const cliVersion of [undefined, '0.164.0', '0.165.0-alpha.1']) {
  test(`Vertex AI rejects an unsupported or unverified CLI (${cliVersion || 'unknown'}) without changing the runtime`, async t => {
    const f = await fixture({ cliVersion }); t.after(() => f.close())
    assert.equal((await (await f.request()).json()).supportsGcp, false)
    const response = await f.request('codex-settings/provider', { provider: 'gcp' })
    assert.equal(response.status, 409); assert.match((await response.json()).error, /0\.165\.0/)
    assert.equal(f.configurations.get('remote')!.model_provider, 'openai')
    assert.equal(f.peers.get('remote')!.length, 1)
    assert.equal(f.peers.get('remote')![0]!.sent.some(message => message.method === 'config/batchWrite'), false)
  })
}

test('GCP rejects unsupported configuration fields and reports higher-priority model overrides', async t => {
  const f = await fixture({ cliVersion: '0.165.0', override: { model: 'managed-model' } }); t.after(() => f.close())
  for (const extra of [{ apiKey: 'private-key' }, { projectId: 'project' }, { location: 'global' }, { credentialFile: '/etc/credentials.json' }, { baseUrl: 'https://example.invalid' }])
    assert.equal((await f.request('codex-settings/provider', { provider: 'gcp', ...extra })).status, 400)
  const response = await f.request('codex-settings/provider', { provider: 'gcp', model: 'requested-model' })
  assert.equal(response.status, 200)
  const value = await response.json()
  assert.equal(value.provider, 'gcp'); assert.equal(value.applied, false); assert.match(value.warning, /高.*优先级/)
  assert.equal(f.writes.length, 0)
})

test('memory settings read only the selected runtime without resuming, enabling or restarting anything', async t => {
  const f = await fixture({ cliVersion: '0.165.0' }); t.after(() => f.close())
  const localBefore = f.peers.get('local')![0]!.sent.length, peer = f.peers.get('remote')![0]!
  peer.output.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'running', status: { type: 'active' } } } })}\n`)
  const status = await f.request('settings/rpc', { method: 'memory/status', params: {} })
  assert.equal(status.status, 200); assert.deepEqual(await status.json(), { v2ConsolidatedThreads: 21, v2Ready: true })
  const summary = await f.request('settings/rpc', { method: 'thread/memory/read', params: { threadId: 'loaded-thread' } })
  assert.equal(summary.status, 200); assert.deepEqual(await summary.json(), { summary: 'remote memory for loaded-thread' })
  assert.equal(f.peers.get('local')![0]!.sent.length, localBefore)
  assert.equal(peer.disposed, false); assert.equal(f.reserved, 0)
  assert.equal(peer.sent.some(message => ['thread/resume', 'config/batchWrite', 'memory/reset', 'turn/start'].includes(message.method || '')), false)
  for (const body of [
    { method: 'thread/memory/read', params: {} }, { method: 'thread/memory/read', params: { threadId: '' } },
    { method: 'thread/memory/read', params: { threadId: 'id', enable: true } },
    { method: 'memory/status', params: { minConsolidatedThreads: 0 } }, { method: 'memory/status', params: { minConsolidatedThreads: 4097 } },
    { method: 'memory/reset', params: {} },
  ]) assert.equal((await f.request('settings/rpc', body)).status, 400)
  assert.equal((await f.request('settings/rpc', { method: 'memory/status', params: {} }, 'offline')).status, 409)
})
