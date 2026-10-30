import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { Auth } from './auth.js'
import { registerDiagnostics } from './diagnostics.js'
import { NativeCapabilitiesService, nativeMethods } from './native-capabilities.js'
import type { Bridge } from './bridge.js'
import type { Host } from './types.js'

test('authenticated connection diagnostics do not start a runtime or discover CLI capabilities', async () => {
  const app = express(); const origin = 'http://localhost:8787'; const auth = new Auth('fixture-password', new Set([origin])); let collections = 0
  app.use(express.json()); app.post('/api/auth/login', auth.login)
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() }, auth.requireAuth)
  let connected = false; let paused = false
  const bridge = { get connected() { return connected }, get paused() { return paused }, diagnostics: () => ({ engineId: 'fixture-engine', userAgent: 'codex_web/0.160.1 (Fixture)', connected, paused, connectionMode: 'spawn', reconnectCount: 2, lastConnectedAt: 10, lastDisconnectedAt: 20, lastProtocolError: { at: 20, method: 'unsupported/method', code: -32601, category: 'unsupportedMethod' }, cachedEvents: { count: 1, firstSequence: 10, lastSequence: 10, capacity: 4096, bytes: 20, maxBytes: 4194304, ttlMs: 300000 } }) } as unknown as Bridge
  registerDiagnostics(app, { getHost: id => id === 'missing' ? undefined : { id, name: 'Host', kind: 'local' }, getExistingBridge: id => id === 'not-created' ? undefined : bridge,
    capabilities: new NativeCapabilitiesService({ collect: async () => { collections++; return { status: 'known', checkedCliVersion: '0.160.1', methods: Object.fromEntries(nativeMethods.map(method => [method, { available: true, params: [], required: [] }])) } } }) })
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.message }))
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    assert.equal((await fetch(`${base}/api/hosts/local/diagnostics`)).status, 401)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password' }) })
    assert.equal(login.status, 200)
    const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0]! }
    const diagnostic = await fetch(`${base}/api/hosts/local/diagnostics`, { headers })
    assert.equal(diagnostic.headers.get('cache-control'), 'no-store')
    const state = await diagnostic.json() as any
    assert.equal(state.runtime.reconnectCount, 2); assert.equal(state.runtime.lastProtocolError.category, 'unsupportedMethod'); assert.equal(collections, 0)
    const absent = await fetch(`${base}/api/hosts/not-created/diagnostics`, { headers }); assert.equal((await absent.json() as any).runtime, null)
    const disconnected = await fetch(`${base}/api/hosts/local/native-capabilities`, { headers }); assert.equal((await disconnected.json() as any).status, 'unknown'); assert.equal(collections, 0)
    connected = true; paused = true
    const released = await fetch(`${base}/api/hosts/local/native-capabilities`, { headers }); assert.equal((await released.json() as any).status, 'unknown'); assert.equal(collections, 0)
    paused = false
    const available = await fetch(`${base}/api/hosts/local/native-capabilities`, { headers }); assert.equal((await available.json() as any).status, 'known'); assert.equal(collections, 1)
    await fetch(`${base}/api/hosts/local/native-capabilities`, { headers }); assert.equal(collections, 1)
    assert.equal((await fetch(`${base}/api/hosts/missing/diagnostics`, { headers })).status, 404)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('per-host daemon diagnostics and capabilities remain available with a global proxy default', async () => {
  const app = express(), origin = 'http://localhost:8787'
  const auth = new Auth('daemon-diagnostics-fixture-password', new Set([origin]))
  app.use(express.json()); app.post('/api/auth/login', auth.login)
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() }, auth.requireAuth)
  const entries: { host: Host; runtimeMode: string; expected?: string }[] = [
    { host: { id: 'daemon', name: 'Independent', kind: 'ssh', connectionMode: 'daemon' }, runtimeMode: 'daemon' },
    { host: { id: 'spawn', name: 'Child', kind: 'ssh', connectionMode: 'spawn' }, runtimeMode: 'ssh' },
    { host: { id: 'external', name: 'External', kind: 'ssh', connectionMode: 'proxy' }, runtimeMode: 'proxy', expected: 'proxy_runtime' },
    { host: { id: 'inherited', name: 'Inherited', kind: 'ssh' }, runtimeMode: 'ssh', expected: 'proxy_runtime' },
  ]
  let collections = 0
  registerDiagnostics(app, {
    bridgeOptions: { mode: 'proxy' },
    getHost: id => entries.find(entry => entry.host.id === id)?.host,
    getExistingBridge: id => {
      const entry = entries.find(entry => entry.host.id === id)
      return entry && { connected: true, paused: false, diagnostics: () => ({ engineId: id, userAgent: 'codex_web/0.165.0 (Fixture)', connectionMode: entry.runtimeMode }) } as unknown as Bridge
    },
    capabilities: new NativeCapabilitiesService({ bridgeOptions: { mode: 'proxy' }, collect: async () => {
      collections++
      return { status: 'known', checkedCliVersion: '0.165.0', methods: Object.fromEntries(nativeMethods.map(method => [method, { available: true, params: [], required: [] }])) }
    } }),
  })
  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'daemon-diagnostics-fixture-password' }) })
    assert.equal(login.status, 200)
    const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0]! }
    for (const entry of entries) {
      const response = await fetch(`${base}/api/hosts/${entry.host.id}/diagnostics`, { headers })
      assert.equal(response.status, 200)
      const diagnostic = await response.json() as any
      assert.equal(diagnostic.capabilityNotice, entry.expected || null)
      const capabilities = await (await fetch(`${base}/api/hosts/${entry.host.id}/native-capabilities`, { headers })).json() as any
      assert.equal(capabilities.status, entry.expected ? 'unknown' : 'known')
      if (entry.expected) assert.equal(capabilities.reason, entry.expected)
    }
    assert.equal(collections, 2, 'external daemon proxies must not run local CLI schema discovery')
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
})
