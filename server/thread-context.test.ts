import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import http from 'node:http'
import express from 'express'
import { createServer } from './app.js'
import { parseRolloutTokenUsage, rolloutContextHelper, registerThreadContext } from './thread-context.js'
import { runHostPython } from './host-helper.js'
import type { Host, RpcMessage } from './types.js'

const info = (tokens: number) => ({ last_token_usage: { total_tokens: tokens, input_tokens: tokens - 10, output_tokens: 10, cache_write_input_tokens: 4 }, total_token_usage: { total_tokens: tokens * 3 }, model_context_window: 200000 })
const event = (tokens: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: info(tokens), unrelated: 'private message text' } }) + '\n'
const local = { id: 'local', kind: 'local' as const, name: 'Fixture' }

test('rollout token counters support legacy fields, cache write tokens and reject invalid usage', () => {
  const parsed = parseRolloutTokenUsage(info(8000))!
  assert.equal(parsed.last.totalTokens, 8000)
  assert.equal(parsed.last.cacheWriteInputTokens, 4)
  assert.equal(parsed.total.totalTokens, 24000)
  assert.equal(parsed.modelContextWindow, 200000)
  assert.equal(parseRolloutTokenUsage({ ...info(10), last_token_usage: { total_tokens: -1 } }), null)
  assert.equal(parseRolloutTokenUsage({ ...info(10), model_context_window: Infinity }), null)
  assert.equal(parseRolloutTokenUsage(null), null)
  const resumed = parseRolloutTokenUsage({ ...info(42000), last_token_usage: { ...info(42000).last_token_usage, reasoning_output_tokens: 9000 }, total_token_usage: { total_tokens: 1900000, reasoning_output_tokens: 500000 } })!
  assert.equal(resumed.last.totalTokens, 42000)
  assert.equal(resumed.last.reasoningOutputTokens, 9000)
  assert.equal(resumed.total.reasoningOutputTokens, 500000)
})

async function contextFixture() {
  let host: Host = { ...local }
  let engineId = 'engine-a'
  let sample = 89000
  let holdMetadata: ((id: string) => Promise<unknown>) | undefined
  let holdRollout: (() => Promise<ReturnType<typeof parseRolloutTokenUsage>>) | undefined
  const reads: string[] = [], rollouts: string[] = []
  const makeBridge = () => ({
    get runtime() { return { engineId } },
    threadContext: () => ({ tokenUsage: null, compacting: false }),
    request: async (_method: string, params: any) => {
      const current = engineId
      reads.push(current + ':' + params.threadId)
      return holdMetadata ? holdMetadata(params.threadId) : { thread: { id: params.threadId, path: '/fixture/' + current + '.jsonl' } }
    },
  })
  let bridge = makeBridge()
  const app = express()
  registerThreadContext(app, {
    getHost: () => host,
    getBridge: async () => bridge,
    readRollout: async (_host, filename) => {
      rollouts.push(filename)
      if (holdRollout) return holdRollout()
      return parseRolloutTokenUsage({ ...info(sample), last_token_usage: { ...info(sample).last_token_usage, reasoning_output_tokens: 9000 }, total_token_usage: { total_tokens: 1900000 } })
    },
  })
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 500).json({ error: error.message }))
  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    reads, rollouts,
    get: (threadId = 'thread-context') => fetch(base + '/api/hosts/local/threads/' + threadId + '/context'),
    changeEngine() { engineId = 'engine-b'; sample = 13000 },
    replaceBridge() { bridge = makeBridge(); sample = 17000 },
    replaceHost() { host = { ...host, cwd: '/new-workspace' }; sample = 21000 },
    metadata(value?: typeof holdMetadata) { holdMetadata = value },
    rollout(value?: typeof holdRollout) { holdRollout = value },
    async close() { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) },
  }
}

test('context fallback is scoped to the current runtime and independent fork identity', async t => {
  const fixture = await contextFixture(); t.after(() => fixture.close())
  const original = await (await fixture.get()).json()
  assert.equal(original.tokenUsage.last.totalTokens, 89000)
  assert.equal(original.tokenUsage.last.reasoningOutputTokens, 9000)
  assert.equal(original.engineId, 'engine-a')
  fixture.changeEngine()
  const resumed = await (await fixture.get()).json()
  assert.equal(resumed.engineId, 'engine-b')
  assert.equal(resumed.tokenUsage.last.totalTokens, 13000)
  assert.equal(resumed.tokenUsage.total.totalTokens, 1900000)
  assert.equal(fixture.reads.length, 2, 'Reconnect must revalidate rollout counters within the old cache TTL')
  const forked = await (await fixture.get('thread-fork')).json()
  assert.equal(forked.tokenUsage.last.totalTokens, 13000)
  assert.equal(fixture.reads.length, 3, 'Forks must hydrate their own native accounting')
})

for (const change of ['engine', 'bridge', 'host'] as const) {
  test(`a delayed context read from an old ${change} cannot hydrate or poison its replacement`, async t => {
    const fixture = await contextFixture(); t.after(() => fixture.close())
    let release!: (value: unknown) => void
    fixture.metadata(() => new Promise(resolve => { release = resolve }))
    const first = fixture.get()
    for (let attempt = 0; attempt < 100 && !release; ++attempt) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(release)
    fixture.metadata()
    if (change === 'engine') fixture.changeEngine()
    if (change === 'bridge') fixture.replaceBridge()
    if (change === 'host') fixture.replaceHost()
    const next = await fixture.get()
    assert.equal(next.status, 200)
    const nextSample = (await next.json()).tokenUsage.last.totalTokens
    release({ thread: { id: 'thread-context', path: '/fixture/stale-private-path.jsonl' } })
    assert.equal((await first).status, 409)
    assert.equal(fixture.rollouts.includes('/fixture/stale-private-path.jsonl'), false, 'Do not read a stale path using a changed host or transport')
    const retained = await (await fixture.get()).json()
    assert.equal(retained.tokenUsage.last.totalTokens, nextSample)
    assert.equal(fixture.reads.length, 2)
  })
}

test('a rollout read already in progress cannot replace the new engine accounting when it finishes late', async t => {
  const fixture = await contextFixture(); t.after(() => fixture.close())
  let release!: (value: ReturnType<typeof parseRolloutTokenUsage>) => void
  fixture.rollout(() => new Promise(resolve => { release = resolve }))
  const first = fixture.get()
  for (let attempt = 0; attempt < 100 && !release; ++attempt) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(release)
  fixture.changeEngine(); fixture.rollout()
  const current = await (await fixture.get()).json()
  assert.equal(current.tokenUsage.last.totalTokens, 13000)
  release(parseRolloutTokenUsage(info(99000)))
  assert.equal((await first).status, 409)
  const retained = await (await fixture.get()).json()
  assert.equal(retained.tokenUsage.last.totalTokens, 13000)
  assert.equal(retained.engineId, 'engine-b')
  assert.equal(fixture.reads.length, 2)
})

test('context reader scans a bounded rollout tail, ignores partial writes and never executes filename text', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-context-tail-'))
  const filename = path.join(directory, "rollout'; $(touch injected).jsonl")
  try {
    await fs.writeFile(filename, event(99999) + 'x'.repeat(9 * 1024 * 1024) + '\n' + event(9000) + '{"partial":')
    const output = await runHostPython(local, rolloutContextHelper(filename))
    assert.equal(parseRolloutTokenUsage(JSON.parse(output))!.last.totalTokens, 9000)
    assert.ok(!output.includes('private message text'))
    assert.equal(await fs.access(path.join(directory, 'injected')).then(() => true, () => false), false)
    const missingWindow = { ...info(1200), model_context_window: null }
    await fs.appendFile(filename, '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: missingWindow } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: -1 } } } }) + '\n')
    const restored = parseRolloutTokenUsage(JSON.parse(await runHostPython(local, rolloutContextHelper(filename))))!
    assert.equal(restored.last.totalTokens, 1200)
    assert.equal(restored.modelContextWindow, 200000)
    const link = path.join(directory, 'symlink.jsonl'); await fs.symlink(filename, link)
    assert.equal(JSON.parse(await runHostPython(local, rolloutContextHelper(link))), null)
    assert.throws(() => rolloutContextHelper('relative.jsonl'))
    assert.throws(() => rolloutContextHelper('/tmp/not-rollout.txt'))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('context endpoint authenticates, hydrates persisted usage without a writer and prefers newer live events', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-context-http-'))
  const filename = path.join(directory, 'rollout-context-thread.jsonl')
  await fs.writeFile(filename, event(7000))
  const input = new PassThrough(); const output = new PassThrough(); const calls: RpcMessage[] = []
  let threadStatus: { type: string } | undefined
  let heldReads: RpcMessage[] | undefined
  let rejectRead = false
  let buffer = ''
  input.on('data', data => {
    buffer += data.toString()
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)) as RpcMessage; buffer = buffer.slice(end + 1)
      calls.push(request)
      if (request.method === 'thread/read' && heldReads) { heldReads.push(request); continue }
      if (request.method === 'thread/read' && rejectRead) { queueMicrotask(() => output.write(JSON.stringify({ id: request.id, error: { code: -32000, message: 'Read unavailable' } }) + '\n')); continue }
      if (request.id !== undefined) queueMicrotask(() => output.write(JSON.stringify({ id: request.id, result: request.method === 'initialize' ? { userAgent: 'fixture' } : { thread: { id: 'context-thread', path: filename, status: threadStatus } } }) + '\n'))
    }
  })
  const application = await createServer({ dataDir: path.join(directory, 'data'), password: 'context-fixture-password', serveStatic: false, bridgeOptions: { transportFactory: () => ({ input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } }) } })
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  const route = '/api/hosts/local/threads/context-thread/context'
  try {
    assert.equal((await fetch(base + route)).status, 401)
    assert.equal(calls.length, 0)
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'context-fixture-password' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const responses = await Promise.all([fetch(base + route, { headers: { cookie } }), fetch(base + route, { headers: { cookie } })])
    for (const response of responses) {
      assert.equal(response.status, 200)
      const context = await response.json()
      assert.equal(context.tokenUsage.last.totalTokens, 7000)
      assert.equal(context.compacting, false)
      assert.ok(!JSON.stringify(context).includes(filename))
      assert.match(response.headers.get('cache-control')!, /no-store/)
    }
    assert.equal(calls.filter(call => call.method === 'thread/read').length, 1)
    output.write(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'context-thread', tokenUsage: parseRolloutTokenUsage(info(3000)) } }) + '\n')
    output.write(JSON.stringify({ method: 'item/started', params: { threadId: 'context-thread', item: { type: 'contextCompaction', id: 'compact' } } }) + '\n')
    const current = await (await fetch(base + route, { headers: { cookie } })).json()
    assert.equal(current.tokenUsage.last.totalTokens, 3000)
    assert.equal(current.compacting, true)
    output.write(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'context-thread', tokenUsage: { ...parseRolloutTokenUsage(info(1000)), modelContextWindow: null } } }) + '\n')
    const partial = await (await fetch(base + route, { headers: { cookie } })).json()
    assert.equal(partial.tokenUsage.last.totalTokens, 1000)
    assert.equal(partial.tokenUsage.modelContextWindow, 200000)
    output.write(JSON.stringify({ method: 'item/completed', params: { threadId: 'context-thread', item: { type: 'contextCompaction', id: 'compact' } } }) + '\n')
    assert.equal((await (await fetch(base + route, { headers: { cookie } })).json()).compacting, false)
    // Recover an omitted completion event using metadata even when usage is
    // already cached. Parallel browser checks share one read and no writer.
    output.write(JSON.stringify({ method: 'item/started', params: { threadId: 'context-thread', turnId: 'lost-completion-turn', item: { type: 'contextCompaction', id: 'lost-completion' } } }) + '\n')
    threadStatus = { type: 'idle' }
    const readsBefore = calls.filter(call => call.method === 'thread/read').length
    heldReads = []
    const recoveredResponses = Promise.all([fetch(base + route, { headers: { cookie } }), fetch(base + route, { headers: { cookie } })])
    for (let attempt = 0; attempt < 100 && !heldReads.length; ++attempt) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(heldReads.length, 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls.filter(call => call.method === 'thread/read').length, readsBefore + 1)
    output.write(JSON.stringify({ id: heldReads[0]!.id, result: { thread: { id: 'context-thread', path: filename, status: threadStatus } } }) + '\n')
    heldReads = undefined
    for (const response of await recoveredResponses) {
      const recovered = await response.json()
      assert.equal(recovered.compacting, false)
      assert.equal(recovered.runtimeStatus, 'idle')
      assert.equal(recovered.tokenUsage.last.totalTokens, 1000)
      assert.equal(recovered.tokenUsage.modelContextWindow, 200000)
    }
    const ordinary = await (await fetch(base + route, { headers: { cookie } })).json()
    assert.equal('runtimeStatus' in ordinary, false, 'Normal cached usage reads need no metadata probe')
    const restored = await (await fetch(base + route + '?recoverCompaction=1', { headers: { cookie } })).json()
    assert.equal(restored.runtimeStatus, 'idle', 'A browser which missed completion can verify runtime even after the bridge recovered')
    assert.equal(restored.compacting, false)
    assert.equal(calls.filter(call => call.method === 'thread/read').length, readsBefore + 2)
    output.write(JSON.stringify({ method: 'item/started', params: { threadId: 'context-thread', turnId: 'still-running-turn', item: { type: 'contextCompaction', id: 'still-running' } } }) + '\n')
    rejectRead = true
    const unavailable = await fetch(base + route + '?recoverCompaction=1', { headers: { cookie } })
    assert.equal(unavailable.status, 200)
    const retained = await unavailable.json()
    assert.equal(retained.compacting, true, 'A failed native probe cannot manufacture completion')
    assert.equal(retained.tokenUsage.last.totalTokens, 1000)
    assert.equal('runtimeStatus' in retained, false)
    rejectRead = false
    assert.equal(calls.some(call => ['thread/resume', 'turn/start', 'command/exec'].includes(call.method || '')), false)
    assert.equal((await fetch(base + '/api/hosts/unknown/threads/context-thread/context', { headers: { cookie } })).status, 404)
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
