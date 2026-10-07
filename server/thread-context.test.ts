import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer } from './app.js'
import { parseRolloutTokenUsage, rolloutContextHelper } from './thread-context.js'
import { runHostPython } from './host-helper.js'
import type { RpcMessage } from './types.js'

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
  let buffer = ''
  input.on('data', data => {
    buffer += data.toString()
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)) as RpcMessage; buffer = buffer.slice(end + 1)
      calls.push(request)
      if (request.id !== undefined) queueMicrotask(() => output.write(JSON.stringify({ id: request.id, result: request.method === 'initialize' ? { userAgent: 'fixture' } : { thread: { id: 'context-thread', path: filename } } }) + '\n'))
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
    assert.equal(calls.some(call => ['thread/resume', 'turn/start', 'command/exec'].includes(call.method || '')), false)
    assert.equal((await fetch(base + '/api/hosts/unknown/threads/context-thread/context', { headers: { cookie } })).status, 404)
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
