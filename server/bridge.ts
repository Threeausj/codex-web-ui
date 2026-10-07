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
import { codexAppServerArgs, sshAppServerArgs } from './ssh.js'
import type { SSHHostKeyPin } from './ssh-host-keys.js'
export { shellQuote } from './ssh.js'

export type Transport = { input: Writable; output: Readable; events: EventEmitter; dispose: () => void; maxFrameBytes?: number; pid?: number; startedAt?: number; closed?: Promise<void> }
export type BridgeOptions = { codexBin?: string; codexHome?: string; clientName?: string; cwd?: string; mode?: 'spawn' | 'proxy'; socketPath?: string; transportFactory?: (host: Host) => Transport; sshHostKeyPin?: SSHHostKeyPin; resolveSshHostKeyPin?: (host: Host) => Promise<SSHHostKeyPin | undefined>; connectionProbe?: boolean; onStderr?: (chunk: string) => void; onProtocolMessage?: (host: Host, message: RpcMessage, responseMethod?: string) => void | Promise<void> }
type Pending = { originalId?: RpcId; clientKey?: string; clientSocket?: WebSocket; method: string; params?: unknown; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }
type Approval = { message: RpcMessage }
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
  private clients = new Map<string, WebSocket>()
  private processes = new Map<string, ActiveProcess>()
  private counter = 0
  private generation = 0
  private engineId?: string
  private eventSequence = 0
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
    return { connected: this.connected, paused: this.paused, managed: this.options.mode !== 'proxy', mode: this.mode,
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
    this.engineId = randomUUID()
    this.eventSequence = 0
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    transport.output.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) { this.disconnect(new Error('App-server frame exceeds the 64 MiB limit')); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try { this.receive(JSON.parse(line)) } catch { this.disconnect(new Error('Invalid JSON from app-server')); return }
      }
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

  private rawRequest(method: string, params: unknown, clientKey?: string, originalId?: RpcId, timeout = 120000, clientSocket?: WebSocket) {
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
      this.pending.set(id, { method, params, clientKey, clientSocket, originalId, resolve, reject, timer })
      try { this.send({ id, method, ...(params !== undefined ? { params } : {}) }) } catch (error) { this.removeCompactionRequest(compactThread, id); clearTimeout(timer); this.pending.delete(id); this.finishProcess(id, undefined, { code: -32000, message: (error as Error).message }); reject(error) }
    })
  }

  private checkThreadRequest(method: string, params: unknown) {
    if (this.releasing.size && ['thread/archive', 'thread/unarchive'].includes(method))
      throw Object.assign(new Error('会话正在关闭，请稍后再归档或恢复'), { status: 409 })
    const id = (params as { threadId?: string } | undefined)?.threadId
    if (id && !['thread/read', 'thread/turns/list', 'thread/goal/get'].includes(method) &&
      (this.releasing.has(id) || this.releasedThreads.has(id) || [...this.releasedThreads.values()].some(entry => entry.restoreThreadIds.includes(id))))
      throw Object.assign(new Error('此会话的 Web 连接已关闭，请在资源管理中重新连接会话'), { code: 'thread_released', status: 409 })
  }
  async request(method: string, params?: unknown, timeout = 120000): Promise<unknown> { await this.connect(); this.checkThreadRequest(method, params); return this.rawRequest(method, params, undefined, undefined, timeout) }

  attach(key: string, socket: WebSocket, clientId: string, isAuthenticated = () => true) {
    const previous = this.clients.get(key)
    if (previous && previous !== socket) previous.close(4001, 'Client reconnected')
    this.clients.set(key, socket)
    this.status(key, clientId)
    for (const approval of this.approvals.values()) this.clientSend(key, approval.message)
    socket.on('message', data => {
      if (this.clients.get(key) !== socket) return
      if (!isAuthenticated()) { socket.close(4003, 'Session expired'); return }
      try { void this.fromClient(key, JSON.parse(data.toString())).catch(error => this.clientSend(key, { method: 'bridge/error', params: { message: (error as Error).message } })) }
      catch { this.clientSend(key, { method: 'bridge/error', params: { message: 'Invalid JSON message' } }) }
    })
    socket.on('close', () => {
      if (this.clients.get(key) !== socket) return
      this.clients.delete(key)
    })
    void this.connect().catch(() => {})
  }

  private clientSend(key: string, message: RpcMessage) {
    const client = this.clients.get(key)
    if (client?.readyState === 1) client.send(JSON.stringify(message))
  }

  private broadcast(message: RpcMessage) {
    const event = { ...message, bridgeEventSequence: ++this.eventSequence }
    for (const key of this.clients.keys()) this.clientSend(key, event)
    return event
  }

  private status(key: string, clientId?: string) {
    this.clientSend(key, { method: 'bridge/status', params: { connected: this.connected, paused: this.paused, engineId: this.engineId, eventSequence: this.eventSequence, hostId: this.host.id, releasedThreadIds: [...this.releasedThreads.keys()], mode: this.mode, userAgent: this.userAgent, codexHome: this.codexHome, error: this.lastError, clientId: clientId || key.slice(key.indexOf(':') + 1), pendingRequests: [...this.approvals.values()].map(a => a.message), activeProcesses: [...this.processes.values()].map(({ requestId: _requestId, decoders: _decoders, ...process }) => process) } })
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
      case 'thread/archive':
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
      threadId, method: pending.method, result: changed, request, changeId,
      ...(originClientId ? { originClientId } : {}),
    } }
    const sequence = ++this.eventSequence
    for (const [key, socket] of this.clients)
      this.clientSend(key, key !== pending.clientKey || socket !== pending.clientSocket
        ? { ...message, bridgeEventSequence: sequence }
        : { method: 'bridge/event/ack', bridgeEventSequence: sequence })
  }

  private async fromClient(key: string, message: RpcMessage) {
    const recipient = this.clients.get(key)
    const reply = (response: RpcMessage) => { if (recipient && this.clients.get(key) === recipient) this.clientSend(key, response) }
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('RPC message must be an object')
    const validId = (typeof message.id === 'string' && message.id.length <= 256) || (typeof message.id === 'number' && Number.isSafeInteger(message.id))
    if (!message.method && validId && ('result' in message || 'error' in message)) {
      const approvalKey = JSON.stringify(message.id)
      const approval = this.approvals.get(approvalKey)
      if (!approval) { this.clientSend(key, { method: 'bridge/error', params: { requestId: message.id, message: 'This request is unknown or was already answered' } }); return }
      this.send({ id: message.id, ...('error' in message ? { error: message.error } : { result: message.result }) })
      this.approvals.delete(approvalKey)
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
      const result = await this.rawRequest(message.method, message.params, key, message.id, timeout, recipient)
      reply({ id: message.id, result })
    } catch (error) {
      reply({ id: message.id, error: error instanceof RpcFailure ? error.rpc : { code: -32000, message: (error as Error).message, ...((error as { uncertain?: boolean; code?: string }).uncertain ? { data: { uncertain: true } } : ['runtime_paused', 'thread_released'].includes((error as { code?: string }).code || '') ? { data: { code: (error as { code?: string }).code } } : {}) } })
    }
  }

  private receive(message: RpcMessage) {
    if (!message || typeof message !== 'object') throw new Error('Invalid protocol frame')
    this.observeContext(message)
    if (message.method === 'thread/archived' && this.archiveCapture) {
      const id = (message.params as { threadId?: string })?.threadId
      if (id && !this.archiveCapture.restoreThreadIds.includes(id)) this.archiveCapture.restoreThreadIds.push(id)
      if (id) this.hiddenArchiveEvents.add(id)
    }
    const pending = message.id !== undefined && !message.method ? this.pending.get(String(message.id)) : undefined
    // Observers must not stall or break RPC, even when a notification provider is offline.
    try { void Promise.resolve(this.options.onProtocolMessage?.(this.host, message, pending?.method)).catch(() => {}) } catch {}
    if (message.id !== undefined && !message.method) {
      if (!pending) return
      this.pending.delete(String(message.id)); clearTimeout(pending.timer)
      if (pending.method === 'command/exec') this.finishProcess(String(message.id), message.result, message.error)
      if (message.error) {
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
        if (!this.hiddenArchiveEvents.has(params?.threadId || '') || !['thread/archive', 'thread/unarchive'].includes(pending.method)) this.broadcastThreadChange(pending, message.result, String(message.id))
        pending.resolve(message.result)
      }
      return
    }
    if (message.id !== undefined && message.method) {
      // This application has one authenticated user. Their desktop and phone may
      // both review a request; only the first response to a pending server ID wins.
      this.approvals.set(JSON.stringify(message.id), { message })
      this.broadcast(message)
      return
    }
    if (message.method) {
      const p = message.params as any
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
        if (params?.requestId !== undefined) this.approvals.delete(JSON.stringify(params.requestId))
      }
      this.broadcast(message)
    }
  }

  private disconnect(error: Error) {
    ++this.generation
    this.connected = false
    this.lastError = error.message
    const transport = this.transport
    this.transport = undefined
    transport?.dispose()
    for (const process of [...this.processes.values()]) this.finishProcess(process.requestId, undefined, { code: -32000, message: error.message })
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear()
    this.approvals.clear()
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
      while ([...this.pending.values()].some(p => ids.has((p.params as { threadId?: string })?.threadId || '') && !['thread/read', 'thread/turns/list'].includes(p.method))) {
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
    this.clients.clear()
  }
}
