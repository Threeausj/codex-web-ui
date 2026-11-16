import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, mkdir, realpath, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { createServer } from '../server/app.js'

const execute = promisify(execFile)
type Frame = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
type Application = Awaited<ReturnType<typeof createServer>>
const origin = 'http://127.0.0.1:8787'
const password = 'isolated-daemon-web-check-password'
const nativeParams = (params: any) => {
  const { bridgeApprovalContext: _preview, bridgeUserInputContext: _timer, ...value } = params
  return value
}

class BrowserClient {
  readonly events: Frame[] = []
  private readonly socket: WebSocket
  private counter = 0
  private readonly pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(base: string, cookie: string) {
    this.socket = new WebSocket(base.replace('http:', 'ws:') + '/api/rpc?host=local&clientId=recovery_' + randomUUID().replaceAll('-', ''), { headers: { origin, cookie }, handshakeTimeout: 8_000 })
    this.socket.on('error', () => {})
    this.socket.on('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Diagnostic Web connection closed')) }
      this.pending.clear()
    })
    this.socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as Frame
      if (frame.method) { this.events.push(frame); return }
      const pending = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(frame.id as string)
      frame.error ? pending.reject(new Error(`Diagnostic Web RPC ${frame.error.code}: ${frame.error.message}`)) : pending.resolve(frame.result)
    })
  }
  async ready() {
    await new Promise<void>((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject) })
    await this.wait('bridge/status', frame => frame.params.connected === true)
  }
  request(method: string, params: unknown = {}): Promise<any> {
    const id = 'browser_' + (++this.counter)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Diagnostic Web RPC timeout: ${method}`)) }, 12_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  respond(id: string | number, result: unknown) { this.socket.send(JSON.stringify({ id, result })) }
  async wait(method: string, matches: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = this.events.find(frame => frame.method === method && matches(frame))
      if (frame) return frame
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Diagnostic Web event timeout: ' + method)
  }
  close() { this.socket.terminate() }
}

/** Starts a completely private Web service, daemon and loopback model fixture.
 * Recreates createServer with the SAME data directory while native tasks wait,
 * so this exercises the durable journal and startup supervisor, not merely a
 * browser reconnect to the same in-memory Bridge. */
export async function runDaemonWebRecoveryCheck(binary = process.env.CODEX_BIN || 'codex') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-web-full-recovery-')))
  const home = path.join(root, 'codex'), workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'web-data')
  await Promise.all([mkdir(home), mkdir(workspace)])
  const cleared = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ACCESS_TOKEN', 'CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME', 'CODEX_LOG_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
  const savedEnvironment = new Map(cleared.map(key => [key, process.env[key]]))
  for (const key of cleared) delete process.env[key]
  let application: Application | undefined
  const browsers: BrowserClient[] = []
  let nextTool: 'approval' | 'question' | null = null, fixtureRequests = 0, fixtureFailure: unknown
  const provider = createHttpServer(async (request, response) => {
    try {
      for await (const _chunk of request) { /* Drain only local fixture requests. */ }
      assert.equal(request.url, '/v1/responses')
      assert.ok(++fixtureRequests <= 12, 'Unexpected diagnostic model loop')
      const id = 'web_fixture_' + fixtureRequests, selected = nextTool
      nextTool = null
      const item = selected === 'approval'
        ? { type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf WEB_DAEMON_APPROVAL_OK', sandbox_permissions: 'require_escalated', justification: 'Isolated Web restart check' }) }
        : selected === 'question'
          ? { type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, name: 'request_user_input', arguments: JSON.stringify({ questions: [{ header: 'Probe', id: 'choice', question: 'Choose a diagnostic option', options: [{ label: 'First', description: 'First fixture option' }, { label: 'Second', description: 'Second fixture option' }] }] }) }
          : { type: 'message', id: 'msg_' + id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Web restart diagnostic complete', annotations: [] }] }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const emit = (type: string, payload: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
      emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } })
      emit('response.output_item.added', { output_index: 0, item })
      emit('response.output_item.done', { output_index: 0, item })
      emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
      response.end()
    } catch (error) { fixtureFailure = error; response.writeHead(500); response.end() }
  })
  const startWeb = async () => {
    application = await createServer({
      cwd: workspace, dataDir, codexHome: home, password, origins: [origin], secureCookie: false, serveStatic: false,
      bridgeOptions: { daemonManaged: true, mode: 'spawn', codexBin: binary, codexHome: home, cwd: workspace },
      pushOptions: { sendNotification: async () => { throw new Error('This diagnostic never sends notifications') } },
      pushObserverOptions: { autoStart: false },
    })
    await new Promise<void>(resolve => application!.server.listen(0, '127.0.0.1', resolve))
    return 'http://127.0.0.1:' + (application.server.address() as { port: number }).port
  }
  const browser = async (base: string) => {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(8_000) })
    assert.equal(login.status, 200)
    const client = new BrowserClient(base, login.headers.get('set-cookie')!.split(';')[0]!)
    browsers.push(client); await client.ready(); return client
  }
  const restartWeb = async (threadId: string) => {
    assert.ok(application)
    await application.close(); application = undefined
    const journalFile = path.join(dataDir, 'daemon-sessions.json')
    assert.equal((await stat(journalFile)).mode & 0o777, 0o600)
    const journal = JSON.parse(await readFile(journalFile, 'utf8'))
    assert.ok(journal.sessions.some((entry: any) => entry.hostId === 'local' && entry.threadId === threadId), 'Accepted thread identity was not saved before Web shutdown')
    assert.ok(journal.sessions.every((entry: any) => Object.keys(entry).sort().join(',') === 'fingerprint,hostId,seenAt,threadId'), 'Recovery journal must contain identities, never prompts or approvals')
    const base = await startWeb()
    const until = Date.now() + 10_000
    while (Date.now() < until && !application!.bridges.get('local')?.runtime.threads.some(thread => thread.id === threadId && thread.loaded))
      await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(application!.bridges.get('local')?.runtime.threads.some(thread => thread.id === threadId && thread.loaded), 'Startup supervisor did not restore this active thread before a browser connected')
    assert.deepEqual(application!.bridges.get('local')!.runtime.recoveryPending, [])
    return base
  }
  const createNamedThread = async (client: BrowserClient, name: string) => {
    const threadId = (await client.request('thread/start', { cwd: workspace, sandbox: 'workspace-write', approvalPolicy: 'on-request' })).thread.id
    // Explicit diagnostic names prevent background title inference from racing
    // with the deterministic provider fixture.
    await client.request('thread/name/set', { threadId, name })
    return threadId as string
  }
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const endpoint = provider.address(); assert.ok(endpoint && typeof endpoint !== 'string')
    await writeFile(path.join(home, 'config.toml'), [
      'model="gpt-6.1-sol"', 'model_provider="web_recovery_fixture"',
      '[model_providers.web_recovery_fixture]', 'name="Local Web recovery fixture"',
      `base_url="http://127.0.0.1:${endpoint.port}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false', 'supports_websockets=false',
      // A daemon cold start does not forward the CLI -c feature flag. Web
      // thread config must enable questions while leaving shared config alone.
      '[features]', 'default_mode_request_user_input=false', '',
    ].join('\n'))
    let base = await startWeb(), client = await browser(base)
    assert.equal((await client.request('config/read', { includeLayers: false })).config.features.default_mode_request_user_input, false)
    const shellThread = await createNamedThread(client, 'Isolated active shell')
    await client.request('thread/shellCommand', { threadId: shellThread, command: "printf 'WEB_DAEMON_START\\n'; sleep 4; printf 'WEB_DAEMON_DONE\\n'", timeoutMs: 8_000 })
    const started = await client.wait('turn/started', frame => frame.params.threadId === shellThread)
    const beforeEngine = (await client.request('bridge/ping', { includeState: true })).engineId
    base = await restartWeb(shellThread)
    client = await browser(base)
    const afterShell = await client.request('bridge/ping', { includeState: true })
    assert.notEqual(afterShell.engineId, beforeEngine, 'The check must create a new Web Bridge')
    await client.wait('turn/completed', frame => frame.params.threadId === shellThread && frame.params.turn.id === started.params.turn.id)
    const history = await client.request('thread/turns/list', { threadId: shellThread, limit: 10, itemsView: 'full' })
    assert.ok(history.data.some((turn: any) => turn.items.some((item: any) => item.type === 'commandExecution' && item.aggregatedOutput?.includes('WEB_DAEMON_DONE'))))

    for (const mode of ['approval', 'question'] as const) {
      const threadId = await createNamedThread(client, 'Isolated pending ' + mode)
      nextTool = mode
      await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'Run the local Web restart fixture' }] })
      const method = mode === 'approval' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput'
      const pending = await client.wait(method, frame => frame.params.threadId === threadId)
      assert.ok(pending.id !== undefined)
      const requestsBeforeRestart = fixtureRequests
      base = await restartWeb(threadId)
      client = await browser(base)
      const replay = await client.wait(method, frame => frame.params.threadId === threadId)
      const snapshot = await client.request('bridge/ping', { includeState: true })
      assert.equal(snapshot.stateIncluded, true)
      assert.ok(snapshot.pendingRequests.some((entry: Frame) => entry.id === pending.id && entry.params.threadId === threadId))
      assert.equal(replay.id, pending.id)
      assert.deepEqual(nativeParams(replay.params), nativeParams(pending.params), 'Recreated Web must retain original native approval/question context')
      assert.equal(fixtureRequests, requestsBeforeRestart, 'Web restart must not resubmit or restart model work')
      assert.ok(!application!.bridges.get('local')!.runtime.threads.some(thread => thread.id === shellThread), 'A completed idle thread must not be resumed by startup recovery')
      client.respond(replay.id!, mode === 'approval' ? { decision: 'accept' } : { answers: { choice: { answers: ['First'] } } })
      const done = await client.wait('turn/completed', frame => frame.params.threadId === threadId)
      assert.equal(done.params.turn.status, 'completed')
    }

    // Restore more than one waiting native session at once. Approval identities
    // must not collide or disappear when the other session is answered first.
    const waiting: { mode: 'approval' | 'question'; threadId: string; pending: Frame }[] = []
    for (const mode of ['approval', 'question', 'approval'] as const) {
      const threadId = await createNamedThread(client, 'Isolated simultaneous ' + mode)
      nextTool = mode
      await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'Wait for the local restart fixture answer' }] })
      const method = mode === 'approval' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput'
      waiting.push({ mode, threadId, pending: await client.wait(method, frame => frame.params.threadId === threadId) })
    }
    assert.equal(new Set(waiting.map(entry => entry.pending.id)).size, waiting.length)
    const requestsBeforeConcurrentRestart = fixtureRequests
    base = await restartWeb(waiting[0]!.threadId)
    client = await browser(base)
    const simultaneous = await client.request('bridge/ping', { includeState: true })
    for (const { pending } of waiting) {
      const replay = await client.wait(pending.method!, frame => frame.id === pending.id)
      assert.deepEqual(nativeParams(replay.params), nativeParams(pending.params))
      assert.ok(simultaneous.pendingRequests.some((entry: Frame) => entry.id === pending.id), 'Original request missing from recovered snapshot: ' + JSON.stringify({ requestId: pending.id, pending: simultaneous.pendingRequests }))
    }
    assert.equal(fixtureRequests, requestsBeforeConcurrentRestart, 'Simultaneous pending work must not be resubmitted on restart')
    for (const { mode, threadId, pending } of waiting.reverse()) {
      client.respond(pending.id!, mode === 'approval' ? { decision: 'accept' } : { answers: { choice: { answers: ['First'] } } })
      const done = await client.wait('turn/completed', frame => frame.params.threadId === threadId)
      assert.equal(done.params.turn.status, 'completed')
    }
    assert.equal((await client.request('config/read', { includeLayers: false })).config.features.default_mode_request_user_input, false, 'Web thread capabilities must not rewrite the shared daemon feature setting')
    assert.equal(fixtureFailure, undefined)
    return { realWebRestarts: 4, newBridgeEngines: true, durableJournalRestoresBeforeBrowserConnects: true,
      activeShellTurnSurvivedWebRestart: true, pendingApprovalRecoveredAndAnswered: true, pendingQuestionRecoveredAndAnswered: true,
      simultaneousPendingRequestsRecoveredAndAnswered: waiting.length,
      idleThreadsNotResumed: true, nativeRequestsNotAutomaticallyAnsweredOrModelWorkResubmitted: true,
      journalContainsOnlyPrivateThreadIdentities: true, loopbackProviderRequests: fixtureRequests, externalModelRequests: 0,
      questionsWorkWithSharedDaemonFeatureDisabled: true,
      productionNotifications: 0, userDaemonTouched: false }
  } finally {
    browsers.forEach(client => client.close())
    await application?.close().catch(() => {})
    const environment = { ...process.env, CODEX_HOME: home }
    await execute(binary, ['app-server', 'daemon', 'stop'], { env: environment, cwd: workspace, timeout: 10_000 }).catch(() => {})
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()))
    for (const [key, value] of savedEnvironment) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(JSON.stringify(await runDaemonWebRecoveryCheck(), null, 2))
