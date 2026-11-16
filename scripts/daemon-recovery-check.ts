import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { webSocketProxyTransport } from '../server/proxy-transport.js'
import type { Transport } from '../server/bridge.js'

const execute = promisify(execFile)
type Frame = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
type FixtureTool = 'dynamic' | 'approval' | 'question'

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

/** Real native protocol, isolated daemon and deterministic loopback model fixture.
 * No user's config, credentials, daemon, remote host or external model endpoint is used. */
export async function runDaemonRecoveryCheck(binary = process.env.CODEX_BIN || 'codex') {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-web-daemon-recovery-')))
  const environment: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: directory }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ACCESS_TOKEN', 'CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME', 'CODEX_LOG_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete environment[key]
  let fixture: FixtureTool | null = null
  let requests = 0
  let fixtureFailure: unknown
  const provider = createServer(async (request, response) => {
    try {
      for await (const _chunk of request) { /* Drain only local diagnostic requests. */ }
      assert.equal(request.url, '/v1/responses')
      assert.ok(++requests <= 16, 'Unexpected diagnostic inference loop')
      const id = `fixture_${requests}`, tool = fixture
      fixture = null
      const item = tool === 'dynamic'
        ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'probe_wait', arguments: '{}' }
        : tool === 'approval'
          ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf CODEX_DAEMON_APPROVAL_OK', sandbox_permissions: 'require_escalated', justification: 'Isolated daemon reconnect validation' }) }
          : tool === 'question'
            ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'request_user_input', arguments: JSON.stringify({ questions: [{ header: 'Probe', id: 'choice', question: 'Select an isolated diagnostic option', options: [{ label: 'First', description: 'First diagnostic choice' }, { label: 'Second', description: 'Second diagnostic choice' }] }] }) }
            : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Diagnostic complete', annotations: [] }] }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const emit = (type: string, payload: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
      emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } })
      emit('response.output_item.added', { output_index: 0, item })
      emit('response.output_item.done', { output_index: 0, item })
      emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
      response.end()
    } catch (error) { fixtureFailure = error; response.writeHead(500); response.end() }
  })
  const clients: DiagnosticProxy[] = []
  let attemptedStart = false
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    assert.ok(address && typeof address !== 'string')
    await writeFile(path.join(directory, 'config.toml'), [
      'model="gpt-6.1-sol"', 'model_provider="isolated_fixture"',
      '[model_providers.isolated_fixture]', 'name="Loopback diagnostic fixture"',
      `base_url="http://127.0.0.1:${address.port}/v1"`, 'wire_api="responses"',
      'requires_openai_auth=false', 'supports_websockets=false',
      '[features]', 'default_mode_request_user_input=true', '',
    ].join('\n'))
    attemptedStart = true
    const started = JSON.parse((await execute(binary, ['app-server', 'daemon', 'start'], { env: environment, cwd: directory, timeout: 20_000, maxBuffer: 1_000_000 })).stdout)
    assert.ok(typeof started.socketPath === 'string' && started.socketPath.startsWith(directory + path.sep), 'Daemon socket escaped the isolated home')
    const socketPath = started.socketPath as string
    const connect = async () => {
      const client = new DiagnosticProxy(binary, socketPath, environment, directory)
      clients.push(client); await client.initialize(); return client
    }
    const daemonVersion = async () => JSON.parse((await execute(binary, ['app-server', 'daemon', 'version'], { env: environment, cwd: directory, timeout: 10_000 })).stdout)

    // An actual thread turn stays alive even when every proxy has disconnected.
    let client = await connect()
    const shellThread = (await client.request('thread/start', { cwd: directory, sandbox: 'read-only', approvalPolicy: 'on-request' })).thread.id
    await client.request('thread/shellCommand', { threadId: shellThread, command: "printf 'CODEX_DAEMON_START\\n'; sleep 2; printf 'CODEX_DAEMON_DONE\\n'", timeoutMs: 6_000 })
    const shellTurn = await client.wait('turn/started', frame => frame.params.threadId === shellThread)
    await client.close()
    client = await connect()
    const joined = await client.request('thread/resume', { threadId: shellThread, excludeTurns: true })
    assert.equal(joined.thread.id, shellThread)
    await client.wait('turn/completed', frame => frame.params.threadId === shellThread && frame.params.turn.id === shellTurn.params.turn.id)
    const shellHistory = await client.request('thread/turns/list', { threadId: shellThread, limit: 10, itemsView: 'full' })
    assert.ok(shellHistory.data.some((turn: any) => turn.items.some((item: any) => item.type === 'commandExecution' && item.aggregatedOutput?.includes('CODEX_DAEMON_DONE'))))
    await client.close()

    const replayed: Record<FixtureTool, boolean> = { dynamic: false, approval: false, question: false }
    for (const mode of ['dynamic', 'approval', 'question'] as const) {
      fixture = mode
      client = await connect()
      const threadId = (await client.request('thread/start', {
        cwd: directory, approvalPolicy: 'on-request', sandbox: 'workspace-write',
        dynamicTools: mode === 'dynamic' ? [{ type: 'function', name: 'probe_wait', description: 'Isolated diagnostic wait', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] : undefined,
      })).thread.id
      await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'Run the local deterministic diagnostic fixture' }] })
      const method = mode === 'dynamic' ? 'item/tool/call' : mode === 'approval' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput'
      const pending = await client.wait(method, frame => frame.params.threadId === threadId)
      assert.ok(pending.id !== undefined)
      await client.close()
      // This models a restarted Web process: the original proxy and its request map are gone.
      client = await connect()
      const metadata = await client.request('thread/read', { threadId, includeTurns: false })
      assert.equal(metadata.thread.status.type, 'active')
      if (mode !== 'dynamic') assert.ok(metadata.thread.status.activeFlags.includes(mode === 'approval' ? 'waitingOnApproval' : 'waitingOnUserInput'))
      await client.request('thread/resume', { threadId, excludeTurns: true })
      const replay = await client.wait(method, frame => frame.params.threadId === threadId)
      assert.equal(replay.id, pending.id)
      assert.deepEqual(replay.params, pending.params, 'Native pending-request context must survive disconnection')
      replayed[mode] = true
      const result = mode === 'approval' ? { decision: 'accept' }
        : mode === 'question' ? { answers: { choice: { answers: ['First'] } } }
          : { contentItems: [{ type: 'inputText', text: 'Diagnostic tool completed' }], success: true }
      client.respond(replay.id!, result)
      const completed = await client.wait('turn/completed', frame => frame.params.threadId === threadId)
      assert.equal(completed.params.turn.status, 'completed', 'Replayed request response did not finish the turn')
      await client.close()
    }

    // Standalone terminal commands use a connection-scoped process identity;
    // never advertise them as resumable thread turns after a proxy replacement.
    client = await connect()
    const processId = 'isolated-connection-scoped-command', marker = path.join(directory, 'standalone-command-finished')
    const execution = client.request('command/exec', { command: ['sh', '-c', 'sleep 1; printf done > "$1"', 'sh', marker], processId, streamStdoutStderr: true, timeoutMs: 4_000, sandboxPolicy: { type: 'dangerFullAccess' } }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 150))
    await client.close(); await execution
    client = await connect()
    await assert.rejects(client.request('command/exec/terminate', { processId }), /not found|unknown|not running|no active command\/exec/i)
    await new Promise(resolve => setTimeout(resolve, 1_200))
    const standaloneCommandFinished = await access(marker).then(() => true, () => false)
    await client.close()
    assert.equal(fixtureFailure, undefined, 'Loopback provider fixture failed')
    const version = await daemonVersion()
    return {
      daemonVersion: started.appServerVersion,
      daemonStillRunning: version.appServerVersion !== null,
      activeShellTurnSurvivedAllClientsDisconnecting: true,
      samePendingDynamicRequestReplayed: replayed.dynamic,
      samePendingApprovalReplayed: replayed.approval,
      samePendingQuestionReplayed: replayed.question,
      replayedRequestAnswersCompleteTurns: true,
      standaloneProcessIdIsConnectionScoped: true,
      standaloneCommandFinishedAfterDisconnect: standaloneCommandFinished,
      loopbackProviderRequests: requests,
      externalModelRequests: 0,
      userDaemonTouched: false,
    }
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    // The environment and fresh home belong only to this check. Never stop a
    // daemon selected from the user's real home or an arbitrary socket.
    if (attemptedStart) await execute(binary, ['app-server', 'daemon', 'stop'], { env: environment, cwd: directory, timeout: 10_000 }).catch(() => {})
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(JSON.stringify(await runDaemonRecoveryCheck(), null, 2))
