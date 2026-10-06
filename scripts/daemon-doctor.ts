import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { webSocketProxyTransport } from '../server/proxy-transport.js'
import { Bridge, type Transport } from '../server/bridge.js'

const execute = promisify(execFile)

class ProxyClient {
  readonly notifications: any[] = []
  private child: ChildProcessWithoutNullStreams
  private transport: Transport
  private reader: ReturnType<typeof createInterface>
  private nextId = 0
  private diagnosticOutput = ''
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
  constructor(binary: string, socketPath: string, environment: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(binary, ['app-server', 'proxy', '--sock', socketPath], { env: environment, cwd, stdio: 'pipe' })
    const events = new EventEmitter()
    this.transport = webSocketProxyTransport({ input: this.child.stdin, output: this.child.stdout, events, dispose: () => { this.child.kill('SIGTERM') } })
    this.reader = createInterface({ input: this.transport.output })
    this.child.stderr.on('data', chunk => { this.diagnosticOutput = (this.diagnosticOutput + chunk.toString()).slice(-4000) })
    this.child.on('error', error => events.emit('transportError', error))
    this.child.on('exit', code => events.emit('transportClose', new Error(`proxy exited: ${code}`)))
    this.transport.events.on('transportError', error => this.rejectAll(error))
    this.transport.events.on('transportClose', error => this.rejectAll(error))
    this.reader.on('line', line => {
      this.diagnosticOutput = (this.diagnosticOutput + line).slice(-4000)
      let message: any
      try { message = JSON.parse(line) } catch { this.diagnosticOutput = (this.diagnosticOutput + line).slice(-4000); return }
      if (message.method) {
        this.notifications.push(message)
        if (message.id !== undefined) this.transport.input.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Diagnostic client does not run tools or inference' } })}\n`)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timeout); this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else pending.resolve(message.result)
    })
  }
  private rejectAll(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(error) }
    this.pending.clear()
  }
  request(method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`proxy RPC timeout: ${method}${this.diagnosticOutput ? `; ${this.diagnosticOutput}` : ''}`)) }, 12_000)
      this.pending.set(id, { resolve, reject, timeout })
      this.transport.input.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }
  async initialize(name: string) {
    const response = await this.request('initialize', { clientInfo: { name, title: 'Isolated Codex Web daemon doctor', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    assert.equal(typeof response.userAgent, 'string')
    this.transport.input.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
  }
  async waitNotification(method: string, matches: (params: any) => boolean) {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const event = this.notifications.find(event => event.method === method && matches(event.params))
      if (event) return event
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Shared daemon notification not received: ${method}`)
  }
  async close() {
    this.rejectAll(new Error('Diagnostic proxy closed'))
    this.reader.close(); this.transport.dispose()
    await new Promise<void>(resolve => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve()
      const timeout = setTimeout(() => this.child.kill('SIGKILL'), 1_000)
      this.child.once('exit', () => { clearTimeout(timeout); resolve() })
    })
  }
}

/** Entirely isolated: does not inspect or manage the user's desktop daemon; no turn/start or model inference. */
export async function runDaemonDoctor(binary = process.env.CODEX_BIN || 'codex') {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-web-daemon-')))
  const environment = { ...process.env, CODEX_HOME: directory }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ACCESS_TOKEN', 'CODEX_ACCESS_TOKEN']) delete (environment as NodeJS.ProcessEnv)[key]
  const clients: ProxyClient[] = []
  let daemonStarted = false
  let replacement: Bridge | undefined
  try {
    // CODEX_HOME controls both installation and socket. Do not use daemon bootstrap: that installs OS management.
    const started = await execute(binary, ['app-server', 'daemon', 'start'], { env: environment, cwd: directory, timeout: 20_000, maxBuffer: 1_000_000 })
    daemonStarted = true
    const daemon = JSON.parse(started.stdout.trim())
    assert.ok(daemon.socketPath.startsWith(`${directory}${path.sep}`), 'daemon control socket must remain inside the isolated home')
    const first = new ProxyClient(binary, daemon.socketPath, environment, directory)
    const second = new ProxyClient(binary, daemon.socketPath, environment, directory)
    clients.push(first, second)
    await first.initialize('codex_web_daemon_doctor_a')
    await second.initialize('codex_web_daemon_doctor_b')
    const created = await first.request('thread/start', { cwd: directory, sandbox: 'read-only', approvalPolicy: 'on-request' })
    const threadId = created.thread.id
    // Empty threads do not yet have a rollout. A fixed manual shell turn creates
    // real history and live events without making any model request.
    await first.request('thread/shellCommand', { threadId, command: "printf 'CODEX_WEB_DAEMON_OK\\n'; sleep 2", timeoutMs: 5_000 })
    await first.waitNotification('turn/started', params => params.threadId === threadId)
    const joined = await second.request('thread/resume', { threadId, excludeTurns: true })
    assert.equal(joined.thread.id, threadId)
    await Promise.all([first.waitNotification('turn/completed', params => params.threadId === threadId), second.waitNotification('turn/completed', params => params.threadId === threadId)])
    await first.request('thread/name/set', { threadId, name: 'daemon doctor A' })
    await second.waitNotification('thread/name/updated', params => params.threadId === threadId && params.threadName === 'daemon doctor A')
    await second.request('thread/name/set', { threadId, name: 'daemon doctor B' })
    await first.waitNotification('thread/name/updated', params => params.threadId === threadId && params.threadName === 'daemon doctor B')
    await first.close()
    replacement = new Bridge({ id: 'daemon-doctor', kind: 'local', name: 'Isolated daemon doctor' }, { codexBin: binary, codexHome: directory, cwd: directory, mode: 'proxy', socketPath: daemon.socketPath })
    await replacement.connect()
    const resumed = await replacement.request('thread/resume', { threadId, excludeTurns: true }) as any
    assert.equal(resumed.thread.id, threadId)
    assert.equal(resumed.thread.name, 'daemon doctor B')
    const history = await replacement.request('thread/turns/list', { threadId, limit: 10, itemsView: 'full' }) as any
    assert.ok(history.data.length > 0)
    assert.ok(history.data.some((turn: any) => turn.items.some((item: any) => item.type === 'commandExecution' && item.aggregatedOutput?.includes('CODEX_WEB_DAEMON_OK'))))
    const configuration = await replacement.request('config/read', { cwd: directory, includeLayers: true }) as any
    const managed = await replacement.request('configRequirements/read') as any
    const nativeProfiles = await replacement.request('permissionProfile/list', { cwd: directory }) as any
    const provider = await replacement.request('modelProvider/capabilities/read', {}) as any
    assert.ok(Array.isArray(configuration.layers))
    assert.ok(managed.requirements === null || typeof managed.requirements === 'object')
    assert.ok(Array.isArray(nativeProfiles.data))
    assert.equal(typeof provider.webSearch, 'boolean')
    // Writes only the isolated home. Check the UI's optimistic version guard
    // against real app-server behavior rather than just a generated type.
    await replacement.request('config/batchWrite', { edits: [{ keyPath: 'model_reasoning_effort', value: 'medium', mergeStrategy: 'replace' }] })
    const snapshot = await replacement.request('config/read', { cwd: directory, includeLayers: true }) as any
    const userLayer = snapshot.layers.find((layer: any) => layer.name.type === 'user' && !layer.name.profile)
    assert.ok(userLayer?.version)
    await replacement.request('config/batchWrite', { edits: [{ keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'replace' }] })
    await assert.rejects(replacement.request('config/batchWrite', { edits: [{ keyPath: 'model_reasoning_effort', value: 'high', mergeStrategy: 'replace' }], filePath: userLayer.name.file, expectedVersion: userLayer.version, reloadUserConfig: true }), /version|conflict|changed|modified/i)
    const afterConflict = await replacement.request('config/read', { cwd: directory }) as any
    assert.equal(afterConflict.config.model_reasoning_effort, 'low')
    // Oversized proxy frames should fail locally and leave the daemon connected.
    await assert.rejects(replacement.request('fs/writeFile', { path: path.join(directory, 'oversized-unused'), dataBase64: 'A'.repeat(16 * 1024 * 1024) }), /frame limit/)
    const stillConnected = await replacement.request('thread/turns/list', { threadId, limit: 1, itemsView: 'full' }) as any
    assert.ok(stillConnected.data.length)
    return { daemonVersion: daemon.appServerVersion, initializedClients: 3, sharedThread: true, twoWayRenameEvents: true, reconnectPreservesThread: true, bridgeProxyVerified: true, sharedManualShellHistory: true, activeShellTurnJoined: true, configurationMetadata: true, managedRequirements: true, nativeProfiles: nativeProfiles.data.length, providerCapabilities: true, optimisticConfigWrites: true, oversizedFrameKeepsConnection: true, inferencePerformed: false, activeModelTurnAndApprovalsVerified: false, desktopDaemonTouched: false }
  } finally {
    replacement?.close()
    await Promise.allSettled(clients.map(client => client.close()))
    if (daemonStarted) await execute(binary, ['app-server', 'daemon', 'stop'], { env: environment, cwd: directory, timeout: 10_000 }).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runDaemonDoctor(), null, 2))
}
