import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import WebSocket from 'ws'
import { createServer } from './app.js'
import type { RpcMessage } from './types.js'

test('the application generates and persists a title through its shared native bridge without exposing metadata work', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-title-app-'))
  const input = new PassThrough(), output = new PassThrough(), calls: RpcMessage[] = []
  let name: string | null = null, buffer = ''
  let saved!: () => void
  const titleSaved = new Promise<void>(resolve => { saved = resolve })
  const thread = (id: string, ephemeral = false) => ({ id, name: ephemeral ? null : name, preview: '', cwd: '/fixture', source: 'appServer', ephemeral, threadSource: ephemeral ? 'thread_title' : null, turns: [], status: { type: 'idle' } })
  const notify = (message: RpcMessage) => output.write(JSON.stringify(message) + '\n')
  input.on('data', data => {
    buffer += data.toString()
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), message: RpcMessage = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      if (!message.method || message.id === undefined) continue
      calls.push(message)
      const params = message.params as any
      let result: unknown = {}
      if (message.method === 'initialize') result = { userAgent: 'title-fixture', codexHome: '/fixture-home' }
      if (message.method === 'config/read') result = { config: { model: 'fixture-model', model_provider: 'fixture-gateway', mcp_servers: {} } }
      if (message.method === 'model/list') result = { data: [{ model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }], defaultReasoningEffort: 'low' }], nextCursor: null }
      if (message.method === 'thread/start') {
        const id = params.ephemeral ? 'hidden-title' : 'conversation'
        result = { thread: thread(id, !!params.ephemeral), model: 'fixture-model', modelProvider: 'fixture-gateway', cwd: '/fixture', activePermissionProfile: { id: ':read_only' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never' }
        notify({ method: 'thread/started', params: { thread: thread(id, !!params.ephemeral) } })
      }
      if (message.method === 'turn/start') {
        const turn = { id: params.threadId === 'hidden-title' ? 'metadata-turn' : 'main-turn', status: 'inProgress', items: [] }
        result = { turn }
        if (params.threadId === 'hidden-title') {
          const item = { id: 'title-answer', type: 'agentMessage', text: '{"title":"修复邮件图片加载"}', phase: 'final_answer' }
          // Completion is deliberately delivered before the native ACK.
          notify({ method: 'item/completed', params: { threadId: params.threadId, turnId: turn.id, item } })
          notify({ method: 'turn/completed', params: { threadId: params.threadId, turn: { ...turn, status: 'completed', items: [item] } } })
        }
      }
      if (message.method === 'thread/read') result = { thread: thread(params.threadId) }
      if (message.method === 'thread/name/set') {
        assert.equal(params.threadId, 'conversation')
        name = params.name
        notify({ method: 'thread/name/updated', params: { threadId: 'conversation', threadName: name } })
      }
      notify({ id: message.id, result })
      if (message.method === 'thread/name/set') saved()
    }
  })
  const app = await createServer({ cwd: directory, dataDir: path.join(directory, 'data'), codexHome: path.join(directory, 'codex'), password: 'fixture-title-password', serveStatic: false, secureCookie: false, origins: ['http://localhost:8787'], bridgeOptions: { transportFactory: () => ({ input, output, events: new EventEmitter(), dispose() { input.destroy(); output.destroy() } }) } })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  let ws: WebSocket | undefined
  try {
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin: 'http://localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'fixture-title-password' }) })
    assert.equal(login.status, 200)
    ws = new WebSocket(base.replace('http:', 'ws:') + '/api/rpc?host=local&clientId=title_application_fixture', { headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]!, origin: 'http://localhost:8787' } })
    const browserEvents: RpcMessage[] = []
    let receivedTitle!: () => void
    const browserTitle = new Promise<void>(resolve => { receivedTitle = resolve })
    ws.on('message', data => {
      const message: RpcMessage = JSON.parse(data.toString())
      browserEvents.push(message)
      if (message.method === 'thread/name/updated') receivedTitle()
    })
    await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject) })
    const bridge = await app.getBridge('local')
    await bridge.request('thread/start', { cwd: '/fixture' })
    await bridge.request('turn/start', { threadId: 'conversation', input: [{ type: 'text', text: '请检查邮件正文中的图片为什么没有自动显示，修复手机端和桌面端的加载问题。' }] })
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.all([titleSaved, browserTitle]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Application did not generate and broadcast a title')), 5000) })]) }
    finally { clearTimeout(timer) }
    await app.threadTitles.close()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(name, '修复邮件图片加载')
    assert.equal(calls.filter(message => message.method === 'thread/start' && (message.params as any)?.ephemeral).length, 1)
    assert.equal(calls.filter(message => message.method === 'thread/name/set').length, 1)
    assert.ok(calls.some(message => message.method === 'thread/unsubscribe' && (message.params as any).threadId === 'hidden-title'))
    assert.ok(browserEvents.some(message => message.method === 'thread/name/updated' && (message.params as any).threadName === name))
    assert.equal(browserEvents.some(message => JSON.stringify(message).includes('hidden-title')), false)
    assert.equal(bridge.runtime.threads.some(entry => entry.id === 'hidden-title'), false)
    assert.equal(((await bridge.request('thread/read', { threadId: 'conversation', includeTurns: false })) as any).thread.name, name)
  } finally { ws?.terminate(); await app.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
