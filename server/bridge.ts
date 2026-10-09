import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import type { ThreadTokenUsage } from './context-types.js'
import type { WebSocket } from 'ws'
import type { Host, RpcId, RpcMessage } from './types.js'
import { rpcError } from './types.js'
import { webSocketProxyTransport } from './proxy-transport.js'
import { BrowserChannel } from './browser-channel.js'
import { JsonLineReader } from './json-lines.js'
import { isInteractiveServerRequest } from '../shared/server-requests.js'
import { codexAppServerArgs, sshAppServerArgs } from './ssh.js'
import type { SSHHostKeyPin } from './ssh-host-keys.js'
export { shellQuote } from './ssh.js'

export type Transport = { input: Writable; output: Readable; events: EventEmitter; dispose: () => void; maxFrameBytes?: number; pid?: number; startedAt?: number; closed?: Promise<void> }
export type BridgeOptions = { codexBin?: string; codexHome?: string; clientName?: string; cwd?: string; mode?: 'spawn' | 'proxy'; socketPath?: string; transportFactory?: (host: Host) => Transport; sshHostKeyPin?: SSHHostKeyPin; resolveSshHostKeyPin?: (host: Host) => Promise<SSHHostKeyPin | undefined>; connectionProbe?: boolean; onStderr?: (chunk: string) => void; onProtocolMessage?: (host: Host, message: RpcMessage, responseMethod?: string) => void | Promise<void> }
type Pending = { respond?: (message: RpcMessage) => void; originalId?: RpcId; clientKey?: string; clientSocket?: WebSocket; method: string; params?: unknown; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }
type Approval = { message: RpcMessage; timer?: ReturnType<typeof setTimeout> }
type ActiveProcess = { processId: string; tty: boolean; cwd?: string; startedAt: number; lastOutput: string; requestId: string; decoders: Map<string, StringDecoder> }
export type ReleasedThread = { name: string; restoreThreadIds: string[] }
export class RpcFailure extends Error { constructor(readonly rpc: NonNullable<RpcMessage['error']>) { super(rpc.message) } }

export function normalizeCodexClientName(value?: string): string {
  const name = value?.trim() || 'codex_web'
  if (/[\x00-\x1f\x7f]/.test(value ?? '') || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name))
    throw new Error('CODEX_CLIENT_NAME must be an identifier of 1–64 ASCII letters, digits, dots, underscores or hyphens')
  return name
}

export function spawnTransport(host: Host, options: BridgeOptions): Transport {
  const executable = host.kind === 'ssh' ? 'ssh' : options.codexBin || 'codex'
  let args: string[]
  if (host.kind === 'ssh') {
    args = sshAppServerArgs(host, options.mode, options.connectionProbe, options.sshHostKeyPin)
  } else args = codexAppServerArgs(options.mode, options.socketPath)
  const child: ChildProcessWithoutNullStreams = spawn(executable, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}) },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Protocol lives exclusively on stdout. Drain stderr without leaking account data into web errors.
  child.stderr.on('data', chunk => options.onStderr?.(chunk.toString()))
  const events = new EventEmitter()
  child.on('error', error => {
    const code = (error as NodeJS.ErrnoException).code
    if (host.kind === 'local' && (code === 'ENOENT' || code === 'EACCES')) {
      const message = code === 'ENOENT'
        ? '未找到本机 Codex。Docker 镜像不内置 Codex；请选择已安装 Codex 的 SSH 主机，或只读挂载本机安装目录并设置 CODEX_BIN 为容器内的绝对路径'
        : '无法执行本机 Codex。请检查 CODEX_BIN、安装目录挂载和服务用户的读取/执行权限'
      events.emit('transportError', new Error(message, { cause: error }))
    } else events.emit('transportError', error)
  })
  child.on('close', (code, signal) => events.emit('transportClose', new Error(host.kind === 'ssh' && code === 127 ? '远端未找到 Codex，请确认登录 shell 的 PATH，或在主机设置中指定 Codex 路径' : `Codex app-server exited (${signal || code})`)))
  let forceClose: ReturnType<typeof setTimeout> | undefined
  child.once('close', () => { clearTimeout(forceClose) })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const transport = { input: child.stdin, output: child.stdout, events, pid: child.pid, startedAt: Date.now(), closed, dispose: () => {
    child.stdin.end()
    child.kill('SIGTERM')
    if (!forceClose && child.exitCode === null && child.signalCode === null) { forceClose = setTimeout(() => child.kill('SIGKILL'), 1000); forceClose.unref() }
  } }
  // The proxy learns its frame limit during the asynchronous upgrade. Preserve
  // that object's identity so later advertised limits reach Bridge.send().
  return options.mode === 'proxy' ? Object.assign(webSocketProxyTransport(transport), { pid: transport.pid, startedAt: transport.startedAt, closed }) : transport
}

/** One app-server per host. Request IDs are rewritten; responses never fan out to other tabs. */
export class Bridge {
  private transport?: Transport
  private connecting?: Promise<void>
  private pending = new Map<string, Pending>()
  private approvals = new Map<string, Approval>()
  private approvalItems = new Map<string, { context: Record<string, unknown>; bytes: number }>()
  private approvalItemBytes = 0
  private clients = new Map<string, WebSocket>()
  private clientChannels = new Map<string, BrowserChannel>()
  private browserFailures = { send: 0, overflow: 0, timeout: 0 }
  private processes = new Map<string, ActiveProcess>()
  private counter = 0
  private generation = 0
  private engineId?: string
  private eventSequence = 0
  private replayEvents: { event: RpcMessage; bytes: number; at: number }[] = []
  private replayBytes = 0
  private connectionAttempts = 0
  private lastConnectedAt?: number
  private lastDisconnectedAt?: number
  private lastProtocolError?: { at: number; code: number; method: string; category: string }
  private contexts = new Map<string, { tokenUsage: ThreadTokenUsage | null; compacting: boolean }>()
  private compactions = new Map<string, { requests: Set<string>; items: Map<string, string | undefined> }>()
  private disposed = false
  private pausing?: Promise<void>
  private subscribedThreads = new Set<string>()
  private activeThreads = new Set<string>()
  private threadNames = new Map<string, string>()
  private releasing = new Set<string>()
  private hiddenArchiveEvents = new Set<string>()
  private archiveCapture?: ReleasedThread
  readonly releasedThreads: Map<string, ReleasedThread>
  paused = false
  connected = false
  userAgent?: string
  codexHome?: string
  lastError?: string
  private readonly clientName: string
  constructor(readonly host: Host, readonly options: BridgeOptions = {}, releasedThreads = new Map<string, ReleasedThread>()) {
    this.clientName = normalizeCodexClientName(options.clientName)
    this.releasedThreads = releasedThreads
  }
  get mode() { return this.host.kind === 'ssh' ? 'ssh' : this.options.mode || 'spawn' }
  threadContext(threadId: string) { return this.contexts.get(threadId) ?? { tokenUsage: null, compacting: false } }
  private compaction(threadId: string) {
    let state = this.compactions.get(threadId)
    if (!state) { state = { requests: new Set(), items: new Map() }; this.compactions.set(threadId, state) }
    return state
  }
  private updateCompaction(threadId: string) {
    const state = this.compactions.get(threadId)
    const compacting = !!state && (state.requests.size > 0 || state.items.size > 0)
    this.contexts.set(threadId, { ...this.threadContext(threadId), compacting })
    if (!compacting) this.compactions.delete(threadId)
  }
  private removeCompactionRequest(threadId: string | undefined, requestId: string) {
    if (!threadId) return
    this.compactions.get(threadId)?.requests.delete(requestId)
    this.updateCompaction(threadId)
  }
  private observeContext(message: RpcMessage) {
    const p = message.params as any
    if (typeof p?.threadId !== 'string') return
    const previous = this.threadContext(p.threadId)
    if (message.method === 'thread/tokenUsage/updated' && p.tokenUsage) this.contexts.set(p.threadId, { ...previous, tokenUsage: { ...p.tokenUsage, modelContextWindow: p.tokenUsage.modelContextWindow ?? previous.tokenUsage?.modelContextWindow ?? null } })
    if (p.item?.type === 'contextCompaction' && ['item/started', 'item/completed'].includes(message.method || '')) {
      const state = this.compaction(p.threadId)
      state.requests.clear()
      if (message.method === 'item/started') state.items.set(p.item.id, p.turnId)
      else state.items.delete(p.item.id)
      this.updateCompaction(p.threadId)
    }
    if (message.method === 'turn/completed') {
      const state = this.compactions.get(p.threadId)
      if (state && (!state.items.size || [...state.items.values()].some(turnId => !turnId || turnId === p.turn?.id))) {
        state.requests.clear()
        for (const [id, turnId] of state.items) if (!turnId || turnId === p.turn?.id) state.items.delete(id)
        this.updateCompaction(p.threadId)
      }
    }
    if (['thread/compacted', 'thread/closed', 'thread/archived', 'thread/deleted'].includes(message.method || '')) {
      this.compactions.delete(p.threadId)
      this.contexts.set(p.threadId, { ...this.threadContext(p.threadId), compacting: false })
    }
    if (['thread/archived', 'thread/deleted'].includes(message.method || '')) this.contexts.delete(p.threadId)
    if (this.contexts.size > 1000) this.contexts.delete(this.contexts.keys().next().value!)
  }
  get runtime() {
    return { engineId: this.engineId, connected: this.connected, paused: this.paused, managed: this.options.mode !== 'proxy', mode: this.mode,
      ...(this.transport?.pid ? { pid: this.transport.pid, startedAt: this.transport.startedAt } : {}),
      loadedThreadCount: this.subscribedThreads.size, activeThreadCount: this.activeThreads.size,
      threads: [...new Set([...this.subscribedThreads, ...this.releasedThreads.keys()])].map(id => ({ id,
        name: this.threadNames.get(id) || this.releasedThreads.get(id)?.name || '未命名对话',
        loaded: this.subscribedThreads.has(id), active: this.activeThreads.has(id), released: this.releasedThreads.has(id),
        restoring: !!this.releasedThreads.get(id)?.restoreThreadIds.length,
        pid: this.subscribedThreads.has(id) ? this.transport?.pid : undefined,
      })),
      activeProcesses: [...this.processes.values()].map(({ processId, tty, cwd, startedAt }) => ({ processId, tty, cwd, startedAt })),
      processes: this.transport?.pid ? [{ pid: this.transport.pid, role: this.host.kind === 'ssh' || this.options.mode === 'proxy' ? 'transport' : 'app-server', local: true }] : [],
    }
  }

  async connect(): Promise<void> {
    if (this.paused) throw Object.assign(new Error('此主机的 Web Codex 已释放，点击“连接 Web Codex”后恢复'), { status: 409, code: 'runtime_paused' })
    if (this.connected) return
    if (this.connecting) return this.connecting
    if (this.disposed) throw new Error('Host connection was closed')
    this.connecting = this.initialize().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async initialize() {
    const generation = ++this.generation
    this.lastError = undefined
    let transport: Transport
    try {
      const knownHostsFile = this.host.kind === 'ssh' && this.options.resolveSshHostKeyPin
        ? await this.options.resolveSshHostKeyPin(this.host) : this.options.sshHostKeyPin
      if (generation !== this.generation || this.disposed || this.paused) throw new Error('Host connection was closed')
      transport = this.options.transportFactory ? this.options.transportFactory(this.host)
        : spawnTransport(this.host, { ...this.options, sshHostKeyPin: knownHostsFile })
    } catch (error) {
      if (generation === this.generation) this.disconnect(error as Error)
      throw error
    }
    this.transport = transport
    ++this.connectionAttempts
    this.engineId = randomUUID()
    this.eventSequence = 0
    this.replayEvents = []
    this.replayBytes = 0
    const reader = new JsonLineReader(line => {
      if (generation !== this.generation) return false
      this.receive(JSON.parse(line))
      return generation === this.generation
    })
    transport.output.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return
      try { reader.write(chunk) }
      catch (error) { this.disconnect(error instanceof RangeError ? error : new Error('Invalid JSON from app-server')) }
    })
    transport.input.on('error', error => { if (generation === this.generation) this.disconnect(error) })
    transport.events.on('transportError', error => { if (generation === this.generation) this.disconnect(error) })
    transport.events.on('transportClose', error => { if (generation === this.generation) this.disconnect(error) })
    try {
      const result = await this.rawRequest('initialize', { clientInfo: { name: this.clientName, title: 'Codex Web', version: '0.1.0' }, capabilities: { experimentalApi: true } }, undefined, undefined, 30000) as { userAgent?: string; codexHome?: string }
      if (generation !== this.generation || this.paused) throw new Error('App-server connection changed')
      this.send({ method: 'initialized' })
      this.userAgent = result.userAgent
      this.codexHome = result.codexHome
      this.connected = true
      this.lastConnectedAt = Date.now()
      for (const key of this.clients.keys()) this.status(key)
    } catch (error) {
      if (generation === this.generation) this.disconnect(error as Error)
      throw error
    }
  }

  private send(message: RpcMessage) {
    if (!this.transport || this.transport.input.destroyed) throw new Error('App-server is disconnected')
    const frame = `${JSON.stringify(message)}\n`
    if (this.transport.maxFrameBytes && Buffer.byteLength(frame) > this.transport.maxFrameBytes) throw new Error(`App-server proxy message exceeds its ${this.transport.maxFrameBytes} byte frame limit`)
    this.transport.input.write(frame)
  }

  private rawRequest(method: string, params: unknown, clientKey?: string, originalId?: RpcId, timeout = 120000, clientSocket?: WebSocket, respond?: (message: RpcMessage) => void) {
    const id = `web:${++this.counter}`
    const compactThread = method === 'thread/compact/start' ? (params as { threadId?: string })?.threadId : undefined
    if (typeof compactThread === 'string') { this.compaction(compactThread).requests.add(id); this.updateCompaction(compactThread) }
    const command = params as { processId?: string; tty?: boolean; cwd?: string } | undefined
    const processId = method === 'command/exec' && typeof command?.processId === 'string' ? command.processId : undefined
    if (processId && !this.processes.has(processId)) {
      this.processes.set(processId, { processId, tty: !!command?.tty, cwd: command?.cwd, startedAt: Date.now(), lastOutput: '', requestId: id, decoders: new Map() })
      for (const client of this.clients.keys()) this.status(client)
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A client timeout cannot establish that a long-lived process stopped.
        // Retain its response mapping so completion can still reach reconnected tabs.
        if (!processId || this.processes.get(processId)?.requestId !== id) this.pending.delete(id)
        this.removeCompactionRequest(compactThread, id)
        reject(Object.assign(new Error(`App-server request timed out: ${method}`), { uncertain: true }))
      }, timeout)
      timer.unref?.()
      this.pending.set(id, { method, params, clientKey, clientSocket, originalId, respond, resolve, reject, timer })
      try { this.send({ id, method, ...(params !== undefined ? { params } : {}) }) } catch (error) { this.removeCompactionRequest(compactThread, id); clearTimeout(timer); this.pending.delete(id); this.finishProcess(id, undefined, { code: -32000, message: (error as Error).message }); reject(error) }
    })
  }

  private checkThreadRequest(method: string, params: unknown) {
    if (this.releasing.size && ['thread/archive', 'thread/unarchive', 'thread/delete'].includes(method))
      throw Object.assign(new Error('会话正在关闭，请稍后再归档、恢复或删除'), { status: 409 })
    const id = (params as { threadId?: string } | undefined)?.threadId
    if (id && method === 'thread/delete' && this.activeThreads.has(id))
      throw Object.assign(new Error('此会话正在运行，请先暂停或等待完成后再删除'), { status: 409 })
    if (id && !['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/goal/get'].includes(method) &&
      (this.releasing.has(id) || this.releasedThreads.has(id) || [...this.releasedThreads.values()].some(entry => entry.restoreThreadIds.includes(id))))
      throw Object.assign(new Error('此会话的 Web 连接已关闭，请在资源管理中重新连接会话后重试'), { code: 'thread_released', status: 409 })
  }
  async request(method: string, params?: unknown, timeout = 120000): Promise<unknown> { await this.connect(); this.checkThreadRequest(method, params); return this.rawRequest(method, params, undefined, undefined, timeout) }

  attach(key: string, socket: WebSocket, clientId: string, isAuthenticated = () => true, cursor?: { engineId: string; afterSequence: number }) {
    const previous = this.clients.get(key)
    if (previous && previous !== socket) previous.close(4001, 'Client reconnected')
    this.clientChannels.get(key)?.close()
    this.clients.set(key, socket)
    this.clientChannels.set(key, new BrowserChannel(socket, reason => {
      ++this.browserFailures[reason]
      this.dropClient(key, socket)
    }))
    // A failed browser connection must never tear down the shared app-server.
    socket.on('error', () => this.dropClient(key, socket))
    socket.on('close', () => {
      if (this.clients.get(key) === socket) {
        this.clientChannels.get(key)?.close(); this.clientChannels.delete(key)
        this.clients.delete(key)
      }
    })
    let replayComplete = false
    if (cursor && cursor.engineId === this.engineId && Number.isSafeInteger(cursor.afterSequence) && cursor.afterSequence >= 0 && cursor.afterSequence <= this.eventSequence) {
      this.pruneReplay()
      const next = this.replayEvents.find(entry => Number(entry.event.bridgeEventSequence) > cursor.afterSequence)
      replayComplete = cursor.afterSequence === this.eventSequence || Number(next?.event.bridgeEventSequence) === cursor.afterSequence + 1
      if (replayComplete) for (const entry of this.replayEvents) {
        if (Number(entry.event.bridgeEventSequence) > cursor.afterSequence) {
          const approval = entry.event.id !== undefined && entry.event.method ? this.approvals.get(JSON.stringify(entry.event.id)) : undefined
          const staleRequest = entry.event.id !== undefined && entry.event.method && (!approval || approval.message.params !== entry.event.params)
          this.clientSend(key, staleRequest ? { method: 'bridge/event/ack', bridgeEventSequence: entry.event.bridgeEventSequence } : entry.event)
        }
      }
    }
    this.status(key, clientId, replayComplete)
    for (const approval of this.approvals.values()) this.clientSend(key, approval.message)
    socket.on('message', data => {
      if (this.clients.get(key) !== socket) return
      if (!isAuthenticated()) { socket.close(4003, 'Session expired'); return }
      try { void this.fromClient(key, JSON.parse(data.toString())).catch(error => this.clientSend(key, { method: 'bridge/error', params: { message: (error as Error).message } })) }
      catch { this.clientSend(key, { method: 'bridge/error', params: { message: 'Invalid JSON message' } }) }
    })
    void this.connect().catch(() => {})
  }

  private dropClient(key: string, socket: WebSocket) {
    if (this.clients.get(key) === socket) {
      this.clientChannels.get(key)?.close(); this.clientChannels.delete(key)
      this.clients.delete(key)
    }
    socket.terminate()
  }

  private clientSend(key: string, message: RpcMessage) {
    const client = this.clients.get(key)
    if (client?.readyState !== 1) return
    this.clientChannels.get(key)?.send(message)
  }

  private observeProtocol(message: RpcMessage, responseMethod?: string) {
    // Push providers and other observers cannot stall the native protocol.
    try { void Promise.resolve(this.options.onProtocolMessage?.(this.host, message, responseMethod)).catch(() => {}) } catch {}
  }

  private removeApproval(key: string) {
    const approval = this.approvals.get(key)
    clearTimeout(approval?.timer)
    this.approvals.delete(key)
    return approval
  }

  private announceResolution(approval: Approval) {
    const params = approval.message.params as { threadId?: string; conversationId?: string } | undefined
    const resolved = { method: 'serverRequest/resolved', params: { requestId: approval.message.id, threadId: params?.threadId || params?.conversationId } }
    this.observeProtocol(resolved)
    this.broadcast(resolved)
  }

  private questionDeadline(approval: Approval) {
    if (!['item/tool/requestUserInput', 'tool/requestUserInput'].includes(approval.message.method || '')) return null
    const params = approval.message.params as { bridgeUserInputContext?: { autoResolveAt?: number | null } } | undefined
    return params?.bridgeUserInputContext?.autoResolveAt ?? null
  }

  private scheduleQuestionResolution(key: string, approval: Approval) {
    const deadline = this.questionDeadline(approval)
    if (deadline === null) return
    clearTimeout(approval.timer)
    approval.timer = setTimeout(() => {
      if (this.approvals.get(key) !== approval) return
      if (deadline > Date.now()) { this.scheduleQuestionResolution(key, approval); return }
      this.resolveUnansweredQuestion(key, approval)
    }, Math.min(0x7fffffff, Math.max(0, deadline - Date.now())))
    approval.timer.unref?.()
  }

  private resolveUnansweredQuestion(key: string, approval: Approval) {
    if (this.approvals.get(key) !== approval || !this.connected) return
    try {
      // A timer never grants permission, chooses an option or sends drafts.
      this.send({ id: approval.message.id, result: { answers: {} } })
    } catch (error) { this.disconnect(error as Error); return }
    this.removeApproval(key)
    this.announceResolution(approval)
    for (const client of this.clients.keys()) this.status(client)
  }

  diagnostics() {
    this.pruneReplay()
    return { engineId: this.engineId || null, userAgent: this.userAgent || null, connected: this.connected, paused: this.paused,
      connectionMode: this.mode, reconnectCount: Math.max(0, this.connectionAttempts - 1),
      lastConnectedAt: this.lastConnectedAt || null, lastDisconnectedAt: this.lastDisconnectedAt || null,
      lastProtocolError: this.lastProtocolError || null,
      browsers: { connected: this.clients.size, failures: { ...this.browserFailures },
        queuedBytes: [...this.clientChannels.values()].reduce((bytes, channel) => bytes + channel.diagnostics.queuedBytes, 0),
        sending: [...this.clientChannels.values()].filter(channel => channel.diagnostics.sending).length },
      cachedEvents: { count: this.replayEvents.length, firstSequence: this.replayEvents[0]?.event.bridgeEventSequence || this.eventSequence,
        lastSequence: this.eventSequence, capacity: 4096, bytes: this.replayBytes, maxBytes: 4 * 1024 * 1024, ttlMs: 5 * 60 * 1000 } }
  }
  private pruneReplay() {
    const oldest = Date.now() - 5 * 60 * 1000
    while (this.replayEvents.length && (this.replayEvents.length > 4096 || this.replayBytes > 4 * 1024 * 1024 || this.replayEvents[0]!.at < oldest)) {
      this.replayBytes -= this.replayEvents.shift()!.bytes
    }
  }
  private rememberEvent(event: RpcMessage) {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.replayEvents.push({ event, bytes, at: Date.now() })
    this.replayBytes += bytes
    this.pruneReplay()
  }
  private broadcast(message: RpcMessage) {
    const event = { ...message, bridgeEventSequence: ++this.eventSequence }
    this.rememberEvent(event)
    for (const key of this.clients.keys()) this.clientSend(key, event)
    return event
  }

  private status(key: string, clientId?: string, replayComplete?: boolean) {
    this.clientSend(key, { method: 'bridge/status', params: { connected: this.connected, paused: this.paused, engineId: this.engineId, eventSequence: this.eventSequence, ...(replayComplete !== undefined ? { replayComplete } : {}), hostId: this.host.id, releasedThreadIds: [...this.releasedThreads.keys()], mode: this.mode, userAgent: this.userAgent, codexHome: this.codexHome, error: this.lastError, clientId: clientId || key.slice(key.indexOf(':') + 1), pendingRequests: [...this.approvals.values()].map(a => a.message), activeProcesses: [...this.processes.values()].map(({ requestId: _requestId, decoders: _decoders, ...process }) => process) } })
  }

  private finishProcess(requestId: string, result?: unknown, error?: RpcMessage['error']) {
    const process = [...this.processes.values()].find(process => process.requestId === requestId)
    if (!process) return
    this.processes.delete(process.processId)
    for (const key of this.clients.keys()) {
      this.clientSend(key, { method: 'bridge/terminal/completed', params: { processId: process.processId, result, error } })
      this.status(key)
    }
  }

  /** Mutation responses can contain items which Codex never emits as events.
   * Share only accepted conversation data; RPC responses and configuration
   * reads remain private to the requesting socket. */
  private broadcastThreadChange(pending: Pending, result: unknown, changeId: string) {
    const params = pending.params as Record<string, unknown> | undefined
    const response = result as { thread?: { id?: unknown }; turn?: unknown; turnId?: unknown } | null
    let threadId = params?.threadId
    let changed: Record<string, unknown>
    const request: Record<string, unknown> = {}
    switch (pending.method) {
      case 'thread/start':
      case 'thread/fork':
        threadId = response?.thread?.id
        if (!response?.thread) return
        changed = { thread: response.thread }
        break
      case 'thread/revert':
      case 'thread/rollback':
      case 'thread/unarchive':
        if (!response?.thread) return
        changed = { thread: response.thread }
        if (typeof params?.beforeTurnId === 'string') request.beforeTurnId = params.beforeTurnId
        break
      case 'turn/start':
      case 'thread/queue/start':
        if (!response?.turn) return
        changed = { turn: response.turn }
        break
      case 'turn/steer':
        if (typeof response?.turnId !== 'string') return
        changed = { turnId: response.turnId }
        break
      case 'thread/name/set':
        if (typeof params?.name !== 'string') return
        request.name = params.name
        changed = {}
        break
      case 'thread/settings/update':
        for (const field of ['model', 'effort', 'cwd', 'sandboxPolicy', 'approvalPolicy', 'collaborationMode', 'serviceTier'])
          if (params && Object.prototype.hasOwnProperty.call(params, field)) request[field] = params[field]
        changed = {}
        break
      case 'thread/archive':
      case 'thread/delete':
      case 'turn/interrupt':
        changed = {}
        break
      default: return
    }
    if (typeof threadId !== 'string' || !threadId) return
    if (['turn/start', 'turn/steer'].includes(pending.method)) {
      if (Array.isArray(params?.input)) request.input = params.input
      if (typeof params?.clientUserMessageId === 'string') request.clientUserMessageId = params.clientUserMessageId
    }
    const originClientId = pending.clientKey?.slice(pending.clientKey.indexOf(':') + 1)
    const message = { method: 'bridge/thread/changed', params: {
      threadId, method: pending.method === 'thread/queue/start' ? 'turn/start' : pending.method, result: changed, request, changeId,
      ...(originClientId ? { originClientId } : {}),
    } }
    const sequence = ++this.eventSequence
    this.rememberEvent({ ...message, bridgeEventSequence: sequence })
    for (const [key, socket] of this.clients)
      this.clientSend(key, key !== pending.clientKey || socket !== pending.clientSocket
        ? { ...message, bridgeEventSequence: sequence }
        : { method: 'bridge/event/ack', bridgeEventSequence: sequence })
  }

  private async fromClient(key: string, message: RpcMessage) {
    const recipient = this.clients.get(key)
    let replied = false
    const reply = (response: RpcMessage) => {
      if (replied) return
      replied = true
      if (recipient && this.clients.get(key) === recipient) this.clientSend(key, response)
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('RPC message must be an object')
    const validId = (typeof message.id === 'string' && message.id.length <= 256) || (typeof message.id === 'number' && Number.isSafeInteger(message.id))
    if (!message.method && validId && ('result' in message || 'error' in message)) {
      const approvalKey = JSON.stringify(message.id)
      const approval = this.approvals.get(approvalKey)
      if (!approval) { this.clientSend(key, { method: 'bridge/error', params: { requestId: message.id, message: 'This request is unknown or was already answered' } }); return }
      const deadline = this.questionDeadline(approval)
      if (deadline !== null && deadline <= Date.now()) {
        this.resolveUnansweredQuestion(approvalKey, approval)
        this.clientSend(key, { method: 'bridge/error', params: { requestId: message.id, message: '此问题已按时限跳过，请同步对话后查看最新状态' } })
        return
      }
      this.send({ id: message.id, ...('error' in message ? { error: message.error } : { result: message.result }) })
      this.removeApproval(approvalKey)
      this.announceResolution(approval)
      for (const client of this.clients.keys()) this.status(client)
      return
    }
    if (!validId || typeof message.method !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_/.]*$/.test(message.method)) throw new Error('A request requires a valid id and method')
    if (['initialize', 'initialized'].includes(message.method)) { reply(rpcError(message.id!, 'The bridge owns initialization', -32600)); return }
    if (message.method === 'bridge/ping') {
      reply({ id: message.id, result: { connected: this.connected, paused: this.paused, engineId: this.engineId, eventSequence: this.eventSequence, loadedThreadIds: [...this.subscribedThreads] } })
      return
    }
    try {
      await this.connect()
      const params = message.params as Record<string, unknown> | undefined
      let timeout = 30 * 60 * 1000
      if (message.method === 'command/exec') {
        if (params?.disableTimeout === true) timeout = 2 * 60 * 60 * 1000
        else if (typeof params?.timeoutMs === 'number') timeout = Math.min(2 * 60 * 60 * 1000, Math.max(timeout, params.timeoutMs + 30000))
      }
      this.checkThreadRequest(message.method, message.params)
      // Keep the socket which submitted the request, even if it reconnects
      // while initialization is pending. Its replacement needs the broadcast.
      const result = await this.rawRequest(message.method, message.params, key, message.id, timeout, recipient, reply)
      reply({ id: message.id, result })
    } catch (error) {
      reply({ id: message.id, error: error instanceof RpcFailure ? error.rpc : { code: -32000, message: (error as Error).message, ...((error as { uncertain?: boolean; code?: string }).uncertain ? { data: { uncertain: true } } : ['runtime_paused', 'thread_released'].includes((error as { code?: string }).code || '') ? { data: { code: (error as { code?: string }).code } } : {}) } })
    }
  }

  private rememberApprovalItem(message: RpcMessage) {
    if (!['item/started', 'item/completed'].includes(message.method || '')) return
    const p = message.params as any, item = p?.item
    if (typeof p?.threadId !== 'string' || typeof p.turnId !== 'string' || typeof item?.id !== 'string') return
    const context: Record<string, unknown> = {}
    if (item.type === 'commandExecution' && typeof item.command === 'string') context.command = item.command
    else if (item.type === 'fileChange' && Array.isArray(item.changes))
      context.filePaths = item.changes.flatMap((change: any) => typeof change?.path === 'string' ? [change.path] : [])
    else return
    if (typeof item.cwd === 'string') context.cwd = item.cwd
    // Retain previews, never command output or diffs. Oversized previews are
    // omitted rather than showing a truncated command as the entire operation.
    const bytes = Buffer.byteLength(JSON.stringify(context))
    const key = JSON.stringify([p.threadId, p.turnId, item.id])
    this.approvalItemBytes -= this.approvalItems.get(key)?.bytes || 0
    this.approvalItems.delete(key)
    if (bytes > 64 * 1024) return
    this.approvalItems.set(key, { context, bytes }); this.approvalItemBytes += bytes
    while (this.approvalItems.size > 256 || this.approvalItemBytes > 1024 * 1024) {
      const first = this.approvalItems.keys().next().value!
      this.approvalItemBytes -= this.approvalItems.get(first)!.bytes
      this.approvalItems.delete(first)
    }
  }

  private forgetDeletedThread(threadId: string) {
    this.subscribedThreads.delete(threadId)
    this.activeThreads.delete(threadId)
    this.threadNames.delete(threadId)
    this.contexts.delete(threadId)
    this.compactions.delete(threadId)
    for (const [key, approval] of this.approvals) {
      const params = approval.message.params as { threadId?: string; conversationId?: string } | undefined
      if ((params?.threadId || params?.conversationId) !== threadId) continue
      this.removeApproval(key); this.announceResolution(approval)
    }
    for (const [key, item] of this.approvalItems) {
      if (JSON.parse(key)[0] !== threadId) continue
      this.approvalItems.delete(key); this.approvalItemBytes -= item.bytes
    }
  }

  private receive(message: RpcMessage) {
    if (!message || typeof message !== 'object') throw new Error('Invalid protocol frame')
    if (message.id !== undefined && ['item/tool/requestUserInput', 'tool/requestUserInput'].includes(message.method || '')) {
      const p = message.params as Record<string, unknown> | undefined
      const previous = this.approvals.get(JSON.stringify(message.id))?.message.params as { bridgeUserInputContext?: unknown } | undefined
      const requestedAt = Date.now(), ms = p?.autoResolutionMs
      const finiteTimeout = typeof ms === 'number' && Number.isSafeInteger(ms) && ms >= 0 && Number.isSafeInteger(requestedAt + ms)
      message = { ...message, params: { ...p, bridgeUserInputContext: previous?.bridgeUserInputContext || {
        requestedAt, autoResolveAt: finiteTimeout ? requestedAt + ms : null,
      } } }
    }
    this.observeContext(message)
    this.rememberApprovalItem(message)
    if (message.method === 'thread/archived' && this.archiveCapture) {
      const id = (message.params as { threadId?: string })?.threadId
      if (id && !this.archiveCapture.restoreThreadIds.includes(id)) this.archiveCapture.restoreThreadIds.push(id)
      if (id) this.hiddenArchiveEvents.add(id)
    }
    const pending = message.id !== undefined && !message.method ? this.pending.get(String(message.id)) : undefined
    this.observeProtocol(message, pending?.method)
    if (message.id !== undefined && !message.method) {
      if (!pending) return
      this.pending.delete(String(message.id)); clearTimeout(pending.timer)
      if (pending.method === 'command/exec') this.finishProcess(String(message.id), message.result, message.error)
      if (message.error) {
        this.lastProtocolError = { at: Date.now(), code: message.error.code, method: pending.method,
          category: message.error.code === -32601 ? 'unsupportedMethod' : message.error.code === -32602 ? 'invalidParameters' : 'runtimeError' }
        const threadId = pending.method === 'thread/compact/start' ? (pending.params as { threadId?: string })?.threadId : undefined
        this.removeCompactionRequest(threadId, String(message.id))
        pending.reject(new RpcFailure(message.error))
      }
      else {
        const params = pending.params as { threadId?: string } | undefined
        const result = message.result as { thread?: { id?: string; name?: string; preview?: string; status?: { type?: string } } } | undefined
        if (result?.thread?.id && (result.thread.name || result.thread.preview)) this.threadNames.set(result.thread.id, (result.thread.name || result.thread.preview || '').slice(0, 160))
        if (pending.method === 'thread/name/set' && params?.threadId && (pending.params as any)?.name) this.threadNames.set(params.threadId, (pending.params as any).name.slice(0, 160))
        if (['thread/start', 'thread/resume', 'thread/fork'].includes(pending.method) && result?.thread?.id) {
          this.subscribedThreads.add(result.thread.id)
          if (result.thread.status?.type === 'active') this.activeThreads.add(result.thread.id)
        }
        if (pending.method === 'thread/unsubscribe' && params?.threadId) { this.subscribedThreads.delete(params.threadId); this.activeThreads.delete(params.threadId) }
        // Send the origin's accepted result before advancing its event cursor.
        // Otherwise an ACK followed by a disconnect could hide a lost result.
        if (pending.originalId !== undefined) pending.respond?.({ id: pending.originalId, result: message.result })
        if (pending.method === 'thread/delete' && params?.threadId) this.forgetDeletedThread(params.threadId)
        if (!this.hiddenArchiveEvents.has(params?.threadId || '') || !['thread/archive', 'thread/unarchive'].includes(pending.method)) this.broadcastThreadChange(pending, message.result, String(message.id))
        pending.resolve(message.result)
      }
      return
    }
    if (message.id !== undefined && message.method) {
      // Service callbacks must work even with every browser asleep. They are
      // not approval prompts, and no shell/tool is executed by accepting them.
      if (message.method === 'currentTime/read') {
        this.send({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } })
        return
      }
      if (!isInteractiveServerRequest(message)) {
        this.lastProtocolError = { at: Date.now(), code: -32601, method: message.method, category: 'unsupportedClientRequest' }
        if (message.method === 'item/tool/call') {
          this.send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'This Web client does not implement this client-side tool. Use an available tool or a client that provides it.' }] } })
        } else this.send(rpcError(message.id, 'This Web client does not implement the requested client capability', -32601))
        return
      }
      const p = message.params as any
      const details = this.approvalItems.get(JSON.stringify([p?.threadId, p?.turnId, p?.itemId]))
      const prompt = details && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)
        ? { ...message, params: { ...p, bridgeApprovalContext: details.context } } : message
      // This application has one authenticated user. Their desktop and phone may
      // both review a request; only the first response to a pending server ID wins.
      const key = JSON.stringify(message.id)
      this.removeApproval(key)
      const approval = { message: prompt }
      this.approvals.set(key, approval)
      this.scheduleQuestionResolution(key, approval)
      this.broadcast(prompt)
      return
    }
    if (message.method) {
      const p = message.params as any
      if (message.method === 'thread/deleted' && typeof p?.threadId === 'string') this.forgetDeletedThread(p.threadId)
      if (message.method === 'thread/name/updated' && p?.threadId) this.threadNames.set(p.threadId, String(p.threadName || p.name || '').slice(0, 160))
      if (['thread/archived', 'thread/unarchived'].includes(message.method) && this.hiddenArchiveEvents.has(p?.threadId)) return
      const event = message.params as { threadId?: string; turn?: { status?: string }; status?: { type?: string } } | undefined
      if (event?.threadId && this.subscribedThreads.has(event.threadId)) {
        if (message.method === 'turn/started' && event.turn?.status === 'inProgress') this.activeThreads.add(event.threadId)
        if (message.method === 'turn/completed') this.activeThreads.delete(event.threadId)
        if (message.method === 'thread/status/changed') {
          if (event.status?.type === 'active') this.activeThreads.add(event.threadId)
          else this.activeThreads.delete(event.threadId)
        }
        if (message.method === 'thread/closed') { this.subscribedThreads.delete(event.threadId); this.activeThreads.delete(event.threadId) }
      }
      if (message.method === 'command/exec/outputDelta') {
        const params = message.params as { processId?: string; stream?: string; deltaBase64?: string } | undefined
        const process = params?.processId ? this.processes.get(params.processId) : undefined
        if (process && params?.deltaBase64) {
          const stream = params.stream || 'stdout'
          let decoder = process.decoders.get(stream)
          if (!decoder) { decoder = new StringDecoder('utf8'); process.decoders.set(stream, decoder) }
          process.lastOutput = (process.lastOutput + decoder.write(Buffer.from(params.deltaBase64, 'base64'))).slice(-200000)
        }
      }
      if (message.method === 'serverRequest/resolved') {
        const params = message.params as { requestId?: RpcId } | undefined
        if (params?.requestId !== undefined) this.removeApproval(JSON.stringify(params.requestId))
      }
      // Native versions normally emit serverRequest/resolved themselves. Only
      // blocking questions belong to a turn's lifetime; asynchronous questions
      // can survive turn changes until native resolution or their own deadline.
      if (['turn/started', 'turn/completed', 'thread/closed', 'thread/archived', 'thread/deleted'].includes(message.method)) {
        for (const [key, approval] of this.approvals) {
          if (!['item/tool/requestUserInput', 'tool/requestUserInput'].includes(approval.message.method || '')) continue
          const question = approval.message.params as { threadId?: string; turnId?: string; isBlocking?: boolean } | undefined
          if (!p?.threadId || !question || question.threadId !== p.threadId) continue
          if (['turn/started', 'turn/completed'].includes(message.method) && question.isBlocking === false) continue
          if (message.method === 'turn/started' && (!p.turn?.id || question.turnId === p.turn.id)) continue
          if (message.method === 'turn/completed' && question.turnId !== p.turn?.id) continue
          this.removeApproval(key); this.announceResolution(approval)
        }
      }
      this.broadcast(message)
    }
  }

  private disconnect(error: Error) {
    this.lastDisconnectedAt = Date.now()
    ++this.generation
    this.connected = false
    this.lastError = error.message
    const transport = this.transport
    this.transport = undefined
    transport?.dispose()
    for (const process of [...this.processes.values()]) this.finishProcess(process.requestId, undefined, { code: -32000, message: error.message })
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear()
    for (const key of this.approvals.keys()) {
      const approval = this.removeApproval(key)
      if (approval) this.announceResolution(approval)
    }
    this.approvalItems.clear(); this.approvalItemBytes = 0
    this.subscribedThreads.clear()
    this.activeThreads.clear()
    this.contexts.clear()
    this.compactions.clear()
    for (const key of this.clients.keys()) this.status(key)
  }

  /** Unsubscribe retains a native writer for 30 minutes. Archive shuts down
   * just this thread family, then unarchive restores its durable history without
   * reacquiring writers. Journal the restoration set before moving any logs. */
  async releaseThread(threadId: string, persist: () => Promise<void>) {
    if (!this.subscribedThreads.has(threadId) && !this.releasedThreads.has(threadId))
      throw Object.assign(new Error('此会话没有由 Web 持有的连接'), { status: 404 })
    if (this.options.mode === 'proxy') throw Object.assign(new Error('共享桌面进程模式请使用“关闭 Web Codex”释放网页连接'), { status: 409 })
    await this.connect()
    if (this.releasing.size) throw Object.assign(new Error('会话正在关闭'), { status: 409 })
    this.releasing.add(threadId)
    try {
      await this.restoreReleasedThread(threadId, persist)
      const ids = new Set([threadId])
      let cursor: string | null = null
      const cursors = new Set<string>()
      do {
        const page = await this.rawRequest('thread/list', { ancestorThreadId: threadId, archived: false, limit: 100, cursor }, undefined, undefined, 10000) as { data: { id: string }[]; nextCursor?: string | null }
        for (const thread of page.data) ids.add(thread.id)
        cursor = page.nextCursor || null
        if (ids.size > 10000 || cursor && cursors.has(cursor)) throw new Error('子会话列表无法完整读取，请稍后重试')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      for (const id of ids) this.releasing.add(id)
      // A resume already in flight must settle before shutting down the writer.
      const deadline = Date.now() + 5000
      while ([...this.pending.values()].some(p => ids.has((p.params as { threadId?: string })?.threadId || '') && !['thread/read', 'thread/turns/list', 'thread/items/list'].includes(p.method))) {
        if (Date.now() > deadline) throw new Error('此会话仍有请求未完成，请稍后重试关闭')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const entry: ReleasedThread = { name: this.threadNames.get(threadId) || this.releasedThreads.get(threadId)?.name || '未命名对话', restoreThreadIds: [...ids] }
      const previous = this.releasedThreads.get(threadId)
      this.releasedThreads.set(threadId, entry)
      try { await persist() }
      catch (error) { if (previous) this.releasedThreads.set(threadId, previous); else this.releasedThreads.delete(threadId); throw error }
      for (const id of ids) this.hiddenArchiveEvents.add(id)
      for (const key of this.clients.keys()) this.status(key)
      try {
        this.archiveCapture = entry
        await this.rawRequest('thread/archive', { threadId }, undefined, undefined, 30000)
        for (const id of entry.restoreThreadIds) { this.subscribedThreads.delete(id); this.activeThreads.delete(id) }
      } finally {
        this.archiveCapture = undefined
        // Native archive events also identify descendants which were created
        // while listing the family. Restore exactly the logs actually moved.
        try { await persist() } finally { await this.restoreReleasedThread(threadId, persist) }
      }
    } finally {
      this.releasing.clear()
      this.hiddenArchiveEvents.clear()
      for (const key of this.clients.keys()) this.status(key)
    }
  }

  async restoreReleasedThread(threadId: string, persist: () => Promise<void>) {
    const entry = this.releasedThreads.get(threadId)
    if (!entry?.restoreThreadIds.length) return
    await this.connect()
    for (const id of [...entry.restoreThreadIds]) {
      const alreadyHidden = this.hiddenArchiveEvents.has(id)
      this.hiddenArchiveEvents.add(id)
      try { await this.rawRequest('thread/unarchive', { threadId: id }, undefined, undefined, 10000) }
      catch (error) { if (!(error instanceof RpcFailure && /^no archived rollout found for thread id /.test(error.message))) throw error }
      finally { if (!alreadyHidden) this.hiddenArchiveEvents.delete(id) }
      entry.restoreThreadIds = entry.restoreThreadIds.filter(value => value !== id)
      await persist()
    }
  }

  async reconnectThread(threadId: string, persist: () => Promise<void>) {
    const entry = this.releasedThreads.get(threadId)
    if (!entry) return
    try {
      await this.restoreReleasedThread(threadId, persist)
      this.releasedThreads.delete(threadId)
      try { await persist() } catch (error) { this.releasedThreads.set(threadId, entry); throw error }
    } finally {
      this.hiddenArchiveEvents.clear()
      for (const key of this.clients.keys()) this.status(key)
    }
  }

  /** Release only this bridge's subscriptions and child transport. Keep sockets
   * attached so an automatic browser reconnect cannot reclaim desktop locks. */
  pause(): Promise<void> {
    this.paused = true
    if (this.pausing) return this.pausing
    for (const key of this.clients.keys()) this.status(key)
    const transport = this.transport
    this.pausing = (async () => {
      if (this.connected) await Promise.allSettled([...this.subscribedThreads].map(threadId => this.rawRequest('thread/unsubscribe', { threadId }, undefined, undefined, 2000)))
      this.disconnect(new Error('Web Codex 已释放，可切换到桌面端或 CLI'))
      if (transport?.closed) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([transport.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); timer.unref?.() })]) }
        finally { clearTimeout(timer) }
      }
    })().finally(() => { this.pausing = undefined })
    return this.pausing
  }

  async resume(): Promise<void> {
    await this.pausing
    await this.connecting?.catch(() => {})
    if (this.disposed) throw new Error('Host connection was closed')
    this.paused = false
    await this.connect()
  }

  close(reason = 'Server stopping', code = 1001) {
    this.disposed = true
    this.disconnect(new Error('Host connection closed'))
    for (const client of this.clients.values()) client.close(code, reason)
    for (const channel of this.clientChannels.values()) channel.close()
    this.clientChannels.clear()
    this.clients.clear()
  }
}
