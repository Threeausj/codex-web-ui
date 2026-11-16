import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { webSocketProxyTransport } from '../server/proxy-transport.js'
import type { Transport } from '../server/bridge.js'

const execute = promisify(execFile)
type Frame = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }

class DiagnosticProxy {
  readonly events: Frame[] = []
  private readonly child: ChildProcessWithoutNullStreams
  private readonly transport: Transport
  private readonly reader: ReturnType<typeof createInterface>
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private counter = 0
  private closed = false

  constructor(binary: string, socketPath: string, environment: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(binary, ['app-server', 'proxy', '--sock', socketPath], { env: environment, cwd, stdio: 'pipe' })
    const events = new EventEmitter()
    this.child.stderr.resume()
    this.transport = webSocketProxyTransport({
      input: this.child.stdin, output: this.child.stdout, events,
      dispose: () => { this.child.stdin.end(); this.child.kill('SIGTERM') },
    })
    this.reader = createInterface({ input: this.transport.output })
    this.child.on('error', error => events.emit('transportError', error))
    this.child.on('exit', code => events.emit('transportClose', new Error(`Diagnostic proxy exited: ${code}`)))
    this.transport.events.on('transportError', error => this.rejectPending(error))
    this.transport.events.on('transportClose', error => this.rejectPending(error))
    this.reader.on('line', line => {
      const frame = JSON.parse(line) as Frame
      if (frame.method) { this.events.push(frame); return }
      const pending = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(frame.id as number)
      if (frame.error) pending.reject(new Error(`Diagnostic RPC ${frame.error.code}: ${frame.error.message}`))
      else pending.resolve(frame.result)
    })
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }

  request(method: string, params: unknown = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.counter
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Diagnostic RPC timeout: ${method}`)) }, 12_000)
      this.pending.set(id, { resolve, reject, timer })
      this.transport.input.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  respond(id: string | number, result: unknown) {
    this.transport.input.write(JSON.stringify({ id, result }) + '\n')
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'codex_web_daemon_recovery_check', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.transport.input.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    return result
  }

  async wait(method: string, predicate: (frame: Frame) => boolean, timeoutMs = 8_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = this.events.find(frame => frame.method === method && predicate(frame))
      if (frame) return frame
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`Diagnostic event timeout: ${method}`)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.rejectPending(new Error('Diagnostic proxy closed'))
    this.reader.close(); this.transport.dispose()
    await new Promise<void>(resolve => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) { resolve(); return }
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 1_000)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

/** Native 0.166 session regression check with a private App Server and deterministic
 * loopback Responses fixture. Never reads user credentials or calls a real model. */
export async function runCodex166SessionCheck(binary = process.env.CODEX_BIN || 'codex') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codex166-session-check-')))
  const home = path.join(root, 'codex'), workspace = path.join(root, 'workspace')
  await Promise.all([mkdir(home), mkdir(workspace)])
  const environment: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ACCESS_TOKEN', 'CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME', 'CODEX_LOG_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete environment[key]
  const fixtures: { reasoning: number; input: number; output: number }[] = [
    { reasoning: 17, input: 1000, output: 120 },
    { reasoning: 13, input: 900, output: 70 },
    { reasoning: 19, input: 800, output: 90 },
  ]
  let requests = 0, fixtureFailure: unknown
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(request.url, '/v1/responses')
      const fixture = fixtures[requests++]; assert.ok(fixture, 'Unexpected diagnostic model retry')
      const id = `session_fixture_${requests}`
      const item = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Native session fixture complete', annotations: [] }] }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const emit = (type: string, value: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
      emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } })
      emit('response.output_item.added', { output_index: 0, item })
      emit('response.output_item.done', { output_index: 0, item })
      emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: {
        input_tokens: fixture.input, input_tokens_details: { cached_tokens: 200 },
        output_tokens: fixture.output, output_tokens_details: { reasoning_tokens: fixture.reasoning }, total_tokens: fixture.input + fixture.output,
      } } })
      response.end()
    } catch (error) { fixtureFailure ??= error; console.error('FIXTURE:',error); response.writeHead(500); response.end() }
  })
  const clients: DiagnosticProxy[] = []
  let nativeServer: ReturnType<typeof spawn> | undefined
  const socketPath = path.join(root, 'native.sock')
  const stopNative = async () => {
    const child = nativeServer; nativeServer = undefined
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  const startNative = async () => {
    assert.equal(nativeServer, undefined)
    const child = nativeServer = spawn(binary, ['app-server', '--listen', 'unix://' + socketPath], { env: environment, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.resume(); child.stderr?.resume()
    let startError: Error | undefined; child.once('error', error => { startError = error })
    const until = Date.now() + 15000
    while (Date.now() < until) {
      if (startError) throw startError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Isolated native App Server exited during startup')
      if (await stat(socketPath).then(value => value.isSocket(), () => false)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Isolated native App Server socket timed out')
  }
  try {
    const installed = (await execute(binary, ['--version'], { env: environment, timeout: 5000 })).stdout
    assert.match(installed, /0\.166\.0/)
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address(); assert.ok(address && typeof address !== 'string')
    await writeFile(path.join(home, 'config.toml'), [
      'model="gpt-6.1-sol"', 'model_provider="session_fixture"',
      '[model_providers.session_fixture]', 'name="Native session loopback fixture"',
      `base_url="http://127.0.0.1:${address.port}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false', 'supports_websockets=false',
      '[features]', 'code_mode_host=false', '',
    ].join('\n'))
    await startNative()
    const connect = async () => {
      const client = new DiagnosticProxy(binary, socketPath, environment, workspace)
      clients.push(client); await client.initialize(); return client
    }
    let client = await connect()
    const started = await client.request('thread/start', { cwd: workspace, sandbox: 'workspace-write', approvalPolicy: 'on-request',
      config: { 'sandbox_workspace_write.writable_roots': [workspace], 'sandbox_workspace_write.network_access': true } })
    const source = started.thread.id
    assert.equal(started.sandbox.type, 'workspaceWrite')
    assert.equal(started.sandbox.networkAccess, true)
    await client.request('turn/start', { threadId: source, sandboxPolicy: started.sandbox, approvalPolicy: started.approvalPolicy, input: [{ type: 'text', text: 'Run the isolated permission and token fixture' }] })
    const firstTurn = await client.wait('turn/completed', frame => frame.params.threadId === source)
    assert.equal(firstTurn.params.turn.status, 'completed')
    const originalUsage = [...client.events].reverse().find(frame => frame.method === 'thread/tokenUsage/updated' && frame.params.threadId === source)?.params.tokenUsage
    assert.ok(originalUsage, 'Native did not report source accounting')
    assert.equal(originalUsage.last.reasoningOutputTokens, 17)
    assert.equal(originalUsage.total.reasoningOutputTokens, 17)
    const granted = await client.request('thread/resume', { threadId: source, excludeTurns: true })
    assert.deepEqual(granted.sandbox, started.sandbox, 'Acknowledged custom policy missing from effective policy')
    const forked = await client.request('thread/fork', { threadId: source, excludeTurns: true, deferGoalContinuation: true })
    const child = forked.thread.id
    assert.notEqual(child, source)
    const arbitraryStartOverridesInheritedByFork = JSON.stringify(forked.sandbox) === JSON.stringify(granted.sandbox)
    assert.ok(forked.sandbox?.type, 'Fork must acknowledge its actual effective permissions')
    await client.close()
    // Only this private App Server is restarted, so resume must reconstruct saved
    // native state rather than merely rejoin actors already held in memory.
    await stopNative(); await startNative()
    client = await connect()
    const resumed = await client.request('thread/resume', { threadId: source, excludeTurns: true })
    const resumedChild = await client.request('thread/resume', { threadId: child, excludeTurns: true })
    const sourceStartOverridesRestored = JSON.stringify(resumed.sandbox) === JSON.stringify(granted.sandbox)
    assert.deepEqual(resumedChild.sandbox, forked.sandbox, 'Fork acknowledgement must survive native reconstruction')
    assert.deepEqual(resumedChild.approvalPolicy, forked.approvalPolicy)
    assert.deepEqual(resumedChild.activePermissionProfile, forked.activePermissionProfile)
    const counters: any[] = []
    for (const threadId of [source, child]) {
      const before = client.events.length
      await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'Verify native restored accounting using the loopback fixture' }] })
      const done = await client.wait('turn/completed', frame => frame.params.threadId === threadId)
      assert.equal(done.params.turn.status, 'completed')
      const usage = [...client.events.slice(before)].reverse().find(frame => frame.method === 'thread/tokenUsage/updated' && frame.params.threadId === threadId)?.params.tokenUsage
      assert.ok(usage, 'Native did not report reconstructed thread accounting')
      counters.push(usage)
    }
    assert.equal(counters[0].total.reasoningOutputTokens, 30)
    assert.equal(counters[1].total.reasoningOutputTokens, 36)
    assert.equal(counters[0].last.totalTokens, 970)
    assert.equal(counters[1].last.totalTokens, 890)
    assert.equal(counters[0].last.reasoningOutputTokens, 13)
    assert.equal(counters[1].last.reasoningOutputTokens, 19)
    assert.equal(fixtureFailure, undefined)
    assert.equal(requests, fixtures.length)
    return { nativeVersion: '0.166.0', forkAcknowledgedPolicyRestoredAfterAppServerRestart: true, arbitraryStartOverridesInheritedByFork, sourceStartOverridesRestored,
      nativeReasoningTotalsRestoredForSourceAndFork: true, sessionGrantToolExecutionTested: false, nativeLastContextNotCumulativeBilling: true,
      originalReasoningTokens: originalUsage.total.reasoningOutputTokens, resumedReasoningTokens: counters[0].total.reasoningOutputTokens,
      forkedReasoningTokens: counters[1].total.reasoningOutputTokens, loopbackProviderRequests: requests, externalModelRequests: 0,
      userDaemonTouched: false, productionNotifications: 0 }
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await stopNative()
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(JSON.stringify(await runCodex166SessionCheck(), null, 2))
