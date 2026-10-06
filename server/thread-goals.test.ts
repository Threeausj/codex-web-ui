import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer } from './app.js'
import type { Transport } from './bridge.js'
import type { Host, RpcMessage } from './types.js'

const origin = 'http://localhost:8787'
const password = 'isolated-native-goal-api-password'
type Goal = { threadId: string; objective: string; status: 'active' | 'paused'; tokenBudget: number | null; tokensUsed: number }
type Sent = { hostId: string; method: string; params: any }

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-goal-api-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const sent: Sent[] = []
  const goals = new Map<string, Goal>()
  let pending: { method: string; hostId: string; release: () => void } | undefined
  let hold: { hostId: string; method: string } | undefined
  const transportFactory = (host: Host): Transport => {
    const input = new PassThrough(), output = new PassThrough()
    let buffer = ''
    const respond = (message: RpcMessage) => {
      if (message.id === undefined) return
      if (message.method === 'initialize') { output.write(JSON.stringify({ id: message.id, result: { userAgent: 'isolated-goal-test' } }) + '\n'); return }
      const method = message.method!, params = message.params as any
      sent.push({ hostId: host.id, method, params })
      const reply = () => {
        if (params.threadId === 'unsupported' || params.threadId === 'disabled') {
          const error = params.threadId === 'unsupported' ? { code: -32601, message: 'Unsupported method: thread/goal/get' } : { code: -32600, message: 'goals feature is disabled' }
          output.write(JSON.stringify({ id: message.id, error }) + '\n'); return
        }
        const key = `${host.id}:${params.threadId}`
        let result: unknown
        if (method === 'thread/goal/get') result = { goal: goals.get(key) ?? null }
        else if (method === 'thread/goal/clear') result = { cleared: goals.delete(key) }
        else if (method === 'thread/goal/set') {
          const previous = goals.get(key)
          const goal: Goal = {
            threadId: params.threadId, objective: params.objective ?? previous?.objective ?? '',
            status: params.status ?? previous?.status ?? 'active',
            tokenBudget: params.tokenBudget !== undefined ? params.tokenBudget : previous?.tokenBudget ?? null,
            tokensUsed: previous?.tokensUsed ?? 0,
          }
          goals.set(key, goal); result = { goal }
        } else throw new Error('Goal fixture received a non-goal RPC')
        output.write(JSON.stringify({ id: message.id, result }) + '\n')
      }
      if (hold?.hostId === host.id && hold.method === method) { pending = { hostId: host.id, method, release: reply }; hold = undefined }
      else reply()
    }
    input.on('data', chunk => {
      buffer += chunk.toString()
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, at)) as RpcMessage
        buffer = buffer.slice(at + 1); respond(message)
      }
    })
    return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } }
  }
  const application = await createServer({
    cwd: directory, codexHome: path.join(directory, 'codex'), dataDir: path.join(directory, 'data'),
    password, origins: [origin], secureCookie: false, serveStatic: false,
    bridgeOptions: { transportFactory, resolveSshHostKeyPin: async () => undefined },
  })
  t.after(() => application.close())
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!
  const { csrfToken } = await response.json() as { csrfToken: string }
  const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken }
  const post = (body: unknown, hostId = 'local', custom = headers) => fetch(base + `/api/goals/${encodeURIComponent(hostId)}`, { method: 'POST', headers: custom, body: JSON.stringify(body) })
  return { application, base, headers, post, sent, goals,
    hold: (hostId: string, method: string) => { hold = { hostId, method } },
    pending: () => pending,
  }
}

test('goal controls require authentication, CSRF and trusted origin before connecting to a host', async t => {
  const f = await fixture(t)
  const body = { method: 'thread/goal/get', params: { threadId: 'synthetic-thread' } }
  assert.equal((await fetch(f.base + '/api/goals/local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401)
  assert.equal((await f.post(body, 'local', { ...f.headers, 'x-csrf-token': '' })).status, 403)
  assert.equal((await f.post(body, 'local', { ...f.headers, origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal(f.sent.length, 0)
  const response = await f.post(body)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { goal: null })
  assert.deepEqual(f.sent, [{ hostId: 'local', ...body }])
  await fetch(f.base + '/api/auth/logout', { method: 'POST', headers: f.headers })
  assert.equal((await f.post(body)).status, 401)
  assert.equal(f.sent.length, 1)
})

test('goal controls accept only bounded native user goal actions and preserve native results', async t => {
  const f = await fixture(t)
  const threadId = 'synthetic-thread'
  const invalid = [
    { method: 'turn/start', params: { threadId } },
    { method: 'thread/goal/get', params: { threadId, objective: 'injected' } },
    { method: 'thread/goal/clear', params: { threadId }, input: [{ type: 'text', text: 'injected' }] },
    { method: 'thread/goal/get', params: { threadId: '' } },
    { method: 'thread/goal/get', params: { threadId: 'a'.repeat(257) } },
    ...[{}, { objective: null }, { objective: '' }, { objective: '  ' }, { objective: 'a'.repeat(4001) },
      { status: 'complete' }, { status: 'budgetLimited' }, { status: null },
      { tokenBudget: 0 }, { tokenBudget: -1 }, { tokenBudget: 1.1 }, { tokenBudget: Number.MAX_SAFE_INTEGER + 1 },
      { objective: 'safe', tools: ['injected'] }].map(params => ({ method: 'thread/goal/set', params: { threadId, ...params } })),
  ]
  for (const body of invalid) {
    const response = await f.post(body)
    assert.equal(response.status, 400, JSON.stringify(body))
  }
  assert.equal(f.sent.length, 0)
  const create = await f.post({ method: 'thread/goal/set', params: { threadId, objective: '  Finish the synthetic goal  ', status: 'paused', tokenBudget: 1000 } })
  assert.equal(create.status, 200)
  assert.deepEqual((await create.json()).goal, { threadId, objective: 'Finish the synthetic goal', status: 'paused', tokenBudget: 1000, tokensUsed: 0 })
  assert.deepEqual(f.sent[0], { hostId: 'local', method: 'thread/goal/set', params: { threadId, objective: 'Finish the synthetic goal', status: 'paused', tokenBudget: 1000 } })
  const active = await f.post({ method: 'thread/goal/set', params: { threadId, status: 'active', tokenBudget: null } })
  assert.equal(active.status, 200)
  assert.deepEqual((await active.json()).goal, { threadId, objective: 'Finish the synthetic goal', status: 'active', tokenBudget: null, tokensUsed: 0 })
  const read = await f.post({ method: 'thread/goal/get', params: { threadId } })
  assert.equal((await read.json()).goal.status, 'active')
  assert.deepEqual(await (await f.post({ method: 'thread/goal/clear', params: { threadId } })).json(), { cleared: true })
  assert.deepEqual(await (await f.post({ method: 'thread/goal/get', params: { threadId } })).json(), { goal: null })
})

test('in-flight goal updates remain bound to the original host when another host receives controls', async t => {
  const f = await fixture(t)
  const remote = await f.application.storage.addHost({ name: 'Synthetic remote', hostname: 'remote.example.test' })
  const threadId = 'same-synthetic-thread-id'
  f.hold(remote.id, 'thread/goal/set')
  const held = f.post({ method: 'thread/goal/set', params: { threadId, objective: 'Remote objective', status: 'paused' } }, remote.id)
  const deadline = Date.now() + 2000
  while (!f.pending() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  assert.ok(f.pending(), 'remote goal update reached its own bridge')
  const local = await f.post({ method: 'thread/goal/set', params: { threadId, objective: 'Local objective', status: 'paused' } })
  assert.equal(local.status, 200)
  assert.equal((await local.json()).goal.objective, 'Local objective')
  f.pending()!.release()
  assert.equal((await (await held).json()).goal.objective, 'Remote objective')
  assert.equal((await (await f.post({ method: 'thread/goal/get', params: { threadId } }, remote.id)).json()).goal.objective, 'Remote objective')
  assert.equal((await (await f.post({ method: 'thread/goal/get', params: { threadId } })).json()).goal.objective, 'Local objective')
  assert.equal((await f.post({ method: 'thread/goal/get', params: { threadId } }, 'missing-host')).status, 404)
  assert.deepEqual([...new Set(f.sent.map(request => request.hostId))].sort(), ['local', remote.id].sort())
})

test('goal protocol failures retain their RPC code for disabled and older hosts', async t => {
  const f = await fixture(t)
  for (const [threadId, code, message] of [['unsupported', -32601, 'Unsupported method: thread/goal/get'], ['disabled', -32600, 'goals feature is disabled']] as const) {
    const response = await f.post({ method: 'thread/goal/get', params: { threadId } })
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error: message, code })
  }
})
