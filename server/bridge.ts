import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { WebSocket } from 'ws'
import type { Host, RpcId, RpcMessage } from './types.js'
import { rpcError } from './types.js'
import { webSocketProxyTransport } from './proxy-transport.js'
import { sshAppServerArgs } from './ssh.js'
export { shellQuote } from './ssh.js'

export type Transport = { input: Writable; output: Readable; events: EventEmitter; dispose: () => void; maxFrameBytes?: number }
export type BridgeOptions = { codexBin?: string; codexHome?: string; clientName?: string; cwd?: string; mode?: 'spawn' | 'proxy'; socketPath?: string; transportFactory?: (host: Host) => Transport; connectionProbe?: boolean; onStderr?: (chunk: string) => void; onProtocolMessage?: (host: Host, message: RpcMessage, responseMethod?: string) => void | Promise<void> }
type Pending = { originalId?: RpcId; clientKey?: string; method: string; params?: unknown; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }
type Approval = { message: RpcMessage }
type ActiveProcess = { processId: string; tty: boolean; cwd?: string; startedAt: number; lastOutput: string; requestId: string; decoders: Map<string, StringDecoder> }
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
    args = sshAppServerArgs(host, options.mode, options.connectionProbe)
  } else if (options.mode === 'proxy') {
    args = ['app-server', 'proxy', ...(options.socketPath ? ['--sock', options.socketPath] : [])]
  } else args = ['app-server', '--listen', 'stdio://']
  const child: ChildProcessWithoutNullStreams = spawn(executable, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}) },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Protocol lives exclusively on stdout. Drain stderr without leaking account data into web errors.
  child.stderr.on('data', chunk => options.onStderr?.(chunk.toString()))
  const events = new EventEmitter()
  child.on('error', error => events.emit('transportError', error))
  child.on('close', (code, signal) => events.emit('transportClose', new Error(host.kind === 'ssh' && code === 127 ? '远端未找到 Codex，请确认登录 shell 的 PATH，或在主机设置中指定 Codex 路径' : `Codex app-server exited (${signal || code})`)))
  let forceClose: ReturnType<typeof setTimeout> | undefined
  child.once('close', () => { clearTimeout(forceClose) })
  const transport = { input: child.stdin, output: child.stdout, events, dispose: () => {
    child.stdin.end()
    child.kill('SIGTERM')
    if (!forceClose && child.exitCode === null && child.signalCode === null) { forceClose = setTimeout(() => child.kill('SIGKILL'), 1000); forceClose.unref() }
  } }
  return options.mode === 'proxy' ? webSocketProxyTransport(transport) : transport
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
  private disposed = false
  connected = false
  userAgent?: string
  codexHome?: string
  lastError?: string
  private readonly clientName: string
  constructor(readonly host: Host, readonly options: BridgeOptions = {}) {
    this.clientName = normalizeCodexClientName(options.clientName)
  }
  get mode() { return this.host.kind === 'ssh' ? 'ssh' : this.options.mode || 'spawn' }

  async connect(): Promise<void> {
    if (this.connected) return
    if (this.connecting) return this.connecting
    if (this.disposed) throw new Error('Host connection was closed')
    this.connecting = this.initialize().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async initialize() {
    const generation = ++this.generation
    this.lastError = undefined
    const transport = this.options.transportFactory ? this.options.transportFactory(this.host) : spawnTransport(this.host, this.options)
    this.transport = transport
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
      if (generation !== this.generation) throw new Error('App-server connection changed')
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

  private rawRequest(method: string, params: unknown, clientKey?: string, originalId?: RpcId, timeout = 120000) {
    const id = `web:${++this.counter}`
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
        reject(Object.assign(new Error(`App-server request timed out: ${method}`), { uncertain: true }))
      }, timeout)
      timer.unref?.()
      this.pending.set(id, { method, params, clientKey, originalId, resolve, reject, timer })
      try { this.send({ id, method, ...(params !== undefined ? { params } : {}) }) } catch (error) { clearTimeout(timer); this.pending.delete(id); this.finishProcess(id, undefined, { code: -32000, message: (error as Error).message }); reject(error) }
    })
  }

  async request(method: string, params?: unknown, timeout = 120000): Promise<unknown> { await this.connect(); return this.rawRequest(method, params, undefined, undefined, timeout) }

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

  private status(key: string, clientId?: string) {
    this.clientSend(key, { method: 'bridge/status', params: { connected: this.connected, hostId: this.host.id, mode: this.mode, userAgent: this.userAgent, codexHome: this.codexHome, error: this.lastError, clientId: clientId || key.slice(key.indexOf(':') + 1), pendingRequests: [...this.approvals.values()].map(a => a.message), activeProcesses: [...this.processes.values()].map(({ requestId: _requestId, decoders: _decoders, ...process }) => process) } })
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
    try {
      await this.connect()
      const params = message.params as Record<string, unknown> | undefined
      let timeout = 30 * 60 * 1000
      if (message.method === 'command/exec') {
        if (params?.disableTimeout === true) timeout = 2 * 60 * 60 * 1000
        else if (typeof params?.timeoutMs === 'number') timeout = Math.min(2 * 60 * 60 * 1000, Math.max(timeout, params.timeoutMs + 30000))
      }
      const result = await this.rawRequest(message.method, message.params, key, message.id, timeout)
      reply({ id: message.id, result })
    } catch (error) {
      reply({ id: message.id, error: error instanceof RpcFailure ? error.rpc : { code: -32000, message: (error as Error).message, ...((error as { uncertain?: boolean }).uncertain ? { data: { uncertain: true } } : {}) } })
    }
  }

  private receive(message: RpcMessage) {
    if (!message || typeof message !== 'object') throw new Error('Invalid protocol frame')
    const pending = message.id !== undefined && !message.method ? this.pending.get(String(message.id)) : undefined
    // Observers must not stall or break RPC, even when a notification provider is offline.
    try { void Promise.resolve(this.options.onProtocolMessage?.(this.host, message, pending?.method)).catch(() => {}) } catch {}
    if (message.id !== undefined && !message.method) {
      if (!pending) return
      this.pending.delete(String(message.id)); clearTimeout(pending.timer)
      if (pending.method === 'command/exec') this.finishProcess(String(message.id), message.result, message.error)
      if (message.error) pending.reject(new RpcFailure(message.error))
      else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.id !== undefined && message.method) {
      // This application has one authenticated user. Their desktop and phone may
      // both review a request; only the first response to a pending server ID wins.
      this.approvals.set(JSON.stringify(message.id), { message })
      for (const client of this.clients.keys()) this.clientSend(client, message)
      return
    }
    if (message.method) {
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
      for (const key of this.clients.keys()) this.clientSend(key, message)
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
    for (const key of this.clients.keys()) this.status(key)
  }

  close(reason = 'Server stopping', code = 1001) {
    this.disposed = true
    this.disconnect(new Error('Host connection closed'))
    for (const client of this.clients.values()) client.close(code, reason)
    this.clients.clear()
  }
}
