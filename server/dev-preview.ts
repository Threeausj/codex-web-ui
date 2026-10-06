import http from 'node:http'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { Express, RequestHandler } from 'express'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import { hostInput } from './storage.js'
import type { AuthenticatedRequest, Host } from './types.js'

type Dependencies = {
  getHost: (id: string) => Host | undefined
  requireAuth: RequestHandler
  requireCsrf: RequestHandler
  isSessionActive: (id: string) => boolean
  onSessionRevoked: (listener: (id: string) => void) => () => void
}
type Ticket = {
  id: string; sessionId: string; hostId: string; port: number; localPort: number
  origin: string; expiresAt: number; tunnel?: ChildProcess; sockets: Set<WebSocket>; requests: Set<http.ClientRequest>
}
const input = z.object({
  hostId: z.string().default('local'), port: z.number().int().min(1024).max(65535),
  path: z.string().max(4096).default('/').refine(value => value.startsWith('/') && !value.startsWith('//') && !/[\x00-\x1f\\]/.test(value), 'Use a relative server path'),
}).strict()
const PREFIX = '/api/dev-preview/'
const TTL = 60 * 60 * 1000

export function sshForwardArgs(host: Host, localPort: number, targetPort: number) {
  const fields = hostInput.parse(Object.fromEntries(Object.entries(host).filter(([key]) => key !== 'id' && key !== 'kind')))
  for (const port of [localPort, targetPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid forward port')
  const args = ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR', '-L', `127.0.0.1:${localPort}:127.0.0.1:${targetPort}`]
  if (fields.port) args.push('-p', String(fields.port))
  if (fields.identityFile) args.push('-i', fields.identityFile)
  args.push('--', `${fields.username ? `${fields.username}@` : ''}${fields.hostname}`)
  return args
}

function bootstrap(base: string, port: number) {
  // Runs in an opaque iframe origin. Every relative network request stays under
  // the ticket; credentials from the Codex app are never forwarded upstream.
  return `<script>(()=>{const base=${JSON.stringify(base)},port=${port},origin=new URL(location.href).origin;const map=value=>{try{const u=new URL(value,location.href);if(u.origin===origin){if(u.pathname.startsWith(base+'/'))return u.href;return origin+base+u.pathname+u.search+u.hash}if(['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&Number(u.port)===port)return origin+base+u.pathname+u.search+u.hash;return value}catch{return value}};const fetchOriginal=window.fetch;window.fetch=(value,init)=>fetchOriginal(typeof value==='string'||value instanceof URL?map(String(value)):new Request(map(value.url),value),{...init,credentials:'omit'});const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){return open.call(this,method,map(String(url)),...rest)};const OriginalSocket=window.WebSocket;window.WebSocket=class extends OriginalSocket{constructor(value,protocols){const u=new URL(String(value),location.href);const mapped=map(u.href.replace(/^ws:/,'http:').replace(/^wss:/,'https:'));super(String(mapped).replace(/^http:/,'ws:').replace(/^https:/,'wss:'),protocols)}};const OriginalEvents=window.EventSource;if(OriginalEvents)window.EventSource=class extends OriginalEvents{constructor(value,options){super(map(String(value)),{...options,withCredentials:false})}}})()</script>`
}

export function rewriteDevelopmentResponse(source: string, contentType: string, base: string, port: number) {
  // HTML attributes, CSS URL references, and Vite/ES-module root imports.
  let output = source.replace(/(["'`])\/(?!\/)([^"'`\s<>]*)/g, (_all, quote: string, target: string) => `${quote}${base}/${target}`)
  output = output.replace(/(url\(\s*)\/(?!\/)/gi, `$1${base}/`)
  if (/text\/html/i.test(contentType)) {
    const script = bootstrap(base, port)
    output = /<head(?:\s[^>]*)?>/i.test(output) ? output.replace(/(<head(?:\s[^>]*)?>)/i, `$1${script}`) : `${script}${output}`
  }
  return output
}

async function freePort() {
  const probe = net.createServer()
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const port = (probe.address() as net.AddressInfo).port
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}
async function waitForTunnel(child: ChildProcess, port: number) {
  let failure: Error | undefined
  child.once('error', error => { failure = error })
  child.once('exit', () => { failure = new Error('SSH port forwarding failed; verify the host and existing SSH authentication') })
  const deadline = Date.now() + 16000
  while (Date.now() < deadline) {
    if (failure) throw failure
    const connected = await new Promise<boolean>(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.setTimeout(200)
      const finish = (value: boolean) => { socket.destroy(); resolve(value) }
      socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false))
    })
    if (connected) return
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error('SSH port forwarding timed out')
}

export function registerDevelopmentPreview(app: Express, deps: Dependencies) {
  const tickets = new Map<string, Ticket>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false })
  const dispose = (id: string) => {
    const ticket = tickets.get(id)
    if (!ticket) return
    tickets.delete(id); ticket.tunnel?.kill('SIGTERM')
    for (const socket of ticket.sockets) socket.close(4003, 'Preview closed')
    for (const request of ticket.requests) request.destroy(new Error('Preview closed'))
  }
  const get = (id: string) => {
    const ticket = tickets.get(id)
    if (!ticket || ticket.expiresAt <= Date.now() || !deps.isSessionActive(ticket.sessionId) || !deps.getHost(ticket.hostId)) { dispose(id); return }
    return ticket
  }
  const unsubscribe = deps.onSessionRevoked(session => { for (const ticket of tickets.values()) if (ticket.sessionId === session) dispose(ticket.id) })
  const cleanup = setInterval(() => { for (const id of tickets.keys()) get(id) }, 30000)
  cleanup.unref()
  app.post('/api/dev-previews', deps.requireAuth, deps.requireCsrf, async (req: AuthenticatedRequest, res) => {
    const parsed = input.parse(req.body)
    const host = deps.getHost(parsed.hostId)
    if (!host) { res.status(404).json({ error: 'Host not found' }); return }
    if (host.kind === 'local' && parsed.port === req.socket.localPort) { res.status(400).json({ error: 'Cannot preview the Codex API server itself' }); return }
    if (tickets.size >= 64) { res.status(429).json({ error: 'Close an existing development preview first' }); return }
    const id = randomBytes(24).toString('base64url')
    const origin = req.get('origin') && req.get('origin') !== 'null' ? req.get('origin')! : `${req.protocol}://${req.get('host')}`
    const ticket: Ticket = { id, sessionId: req.session!.id, hostId: host.id, port: parsed.port, localPort: parsed.port, origin, expiresAt: Date.now() + TTL, sockets: new Set(), requests: new Set() }
    if (host.kind === 'ssh') {
      ticket.localPort = await freePort()
      ticket.tunnel = spawn('ssh', sshForwardArgs(host, ticket.localPort, parsed.port), { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
      ticket.tunnel.stderr?.on('data', () => {})
      try { await waitForTunnel(ticket.tunnel, ticket.localPort) }
      catch (error) { ticket.tunnel.kill('SIGTERM'); throw error }
      ticket.tunnel.once('exit', () => dispose(id))
    }
    if (!deps.isSessionActive(ticket.sessionId)) { ticket.tunnel?.kill('SIGTERM'); res.status(401).json({ error: 'Session expired' }); return }
    tickets.set(id, ticket)
    res.status(201).json({ id, hostId: ticket.hostId, port: ticket.port, expiresAt: ticket.expiresAt, url: `${PREFIX}${id}${parsed.path}` })
  })
  app.delete('/api/dev-previews/:id', deps.requireAuth, deps.requireCsrf, (req: AuthenticatedRequest, res) => {
    const ticket = tickets.get(String(req.params.id))
    if (ticket && ticket.sessionId !== req.session!.id) { res.status(403).json({ error: 'Preview belongs to another session' }); return }
    dispose(String(req.params.id)); res.json({ ok: true })
  })
  app.use(PREFIX, async (req, res) => {
    const url = new URL(req.originalUrl, 'http://localhost')
    const match = url.pathname.match(/^\/api\/dev-preview\/([a-zA-Z0-9_-]{32})(\/.*)?$/)
    const ticket = match && get(match[1]!)
    if (!ticket) { res.status(403).send('开发预览已关闭或登录已过期'); return }
    if (req.headers.origin && req.headers.origin !== 'null' && req.headers.origin !== ticket.origin) { res.status(403).send('开发预览来源不匹配'); return }
    if (req.method === 'OPTIONS') {
      res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }).status(204).end()
      return
    }
    const target = `${match![2] || '/'}${url.search}`
    if (target.startsWith('//') || /[\x00-\x1f\\]/.test(target)) { res.status(400).end(); return }
    const base = `${PREFIX}${ticket.id}`
    const headers: http.OutgoingHttpHeaders = { host: `127.0.0.1:${ticket.port}`, 'accept-encoding': 'identity' }
    for (const header of ['accept', 'accept-language', 'content-type', 'range', 'if-none-match', 'if-modified-since']) if (req.headers[header]) headers[header] = req.headers[header]
    headers.origin = `http://127.0.0.1:${ticket.port}`
    const upstream = http.request({ host: '127.0.0.1', port: ticket.localPort, method: req.method, path: target, headers }, response => {
      if (!get(ticket.id)) { response.destroy(); res.status(403).end(); return }
      const type = String(response.headers['content-type'] || 'application/octet-stream')
      const text = /text\/html|text\/css|(?:javascript|ecmascript)/i.test(type)
      if (text && response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); res.status(502).send('开发服务必须支持不压缩的文本资源'); return }
      res.status(response.statusCode || 502)
      res.set({
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${ticket.origin}; style-src 'unsafe-inline' ${ticket.origin}; img-src data: blob: ${ticket.origin}; font-src data: ${ticket.origin}; media-src data: blob: ${ticket.origin}; connect-src ${ticket.origin} ${ticket.origin.replace(/^http/, 'ws')}; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`,
      })
      const location = response.headers.location
      if (location) {
        const redirect = new URL(location, `http://127.0.0.1:${ticket.port}${target}`)
        if (redirect.hostname !== '127.0.0.1' || Number(redirect.port) !== ticket.port || redirect.protocol !== 'http:') { response.destroy(); res.status(502).send('开发服务重定向超出目标端口'); return }
        res.set('Location', `${base}${redirect.pathname}${redirect.search}${redirect.hash}`)
      }
      if (req.method === 'HEAD') { response.resume(); res.end(); return }
      if (text) {
        let length = 0; const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 16 * 1024 * 1024) { response.destroy(); if (!res.headersSent) res.status(413).end('开发资源超过 16 MB'); } else chunks.push(chunk) })
        response.on('end', () => { if (!res.writableEnded) res.send(rewriteDevelopmentResponse(Buffer.concat(chunks).toString('utf8'), type, base, ticket.port)) })
        response.on('error', () => { if (!res.headersSent) res.status(502).end('开发资源读取失败'); else res.destroy() })
      } else {
        if (response.headers['content-encoding']) res.set('Content-Encoding', response.headers['content-encoding'])
        response.pipe(res)
      }
    })
    upstream.setTimeout(30000, () => upstream.destroy(new Error('Development server timed out')))
    ticket.requests.add(upstream)
    upstream.on('close', () => ticket.requests.delete(upstream))
    upstream.on('error', () => { if (!res.headersSent) res.status(502).send('无法连接开发服务，请先在所选主机启动该端口'); else res.destroy() })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
    if (req.body !== undefined) upstream.end(JSON.stringify(req.body))
    else req.pipe(upstream)
  })
  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (!url.pathname.startsWith(PREFIX)) return false
    const match = url.pathname.match(/^\/api\/dev-preview\/([a-zA-Z0-9_-]{32})(\/.*)?$/)
    const ticket = match && get(match[1]!)
    const reject = () => { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy() }
    if (!ticket || (req.headers.origin !== 'null' && req.headers.origin !== ticket.origin)) { reject(); return true }
    const target = `${match![2] || '/'}${url.search}`
    if (target.startsWith('//') || /[\x00-\x1f\\]/.test(target)) { reject(); return true }
    wss.handleUpgrade(req, socket, head, client => {
      ticket.sockets.add(client)
      const protocols = req.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()).filter(Boolean)
      const upstream = new WebSocket(`ws://127.0.0.1:${ticket.localPort}${target}`, protocols, { origin: `http://127.0.0.1:${ticket.port}`, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 15000 })
      let ready = false; const queued: { data: Buffer; binary: boolean }[] = []; let queuedBytes = 0
      client.on('message', (data, binary) => {
        const bytes = Buffer.from(data as Buffer)
        if (!get(ticket.id)) { client.close(4003, 'Preview expired'); return }
        if (ready) upstream.send(bytes, { binary })
        else if ((queuedBytes += bytes.length) <= 1024 * 1024) queued.push({ data: bytes, binary })
        else client.close(1009, 'Too much pending preview data')
      })
      upstream.on('open', () => { ready = true; for (const message of queued) upstream.send(message.data, { binary: message.binary }); queued.length = 0 })
      upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN && get(ticket.id)) client.send(data, { binary }) })
      upstream.on('error', () => { client.close(1011, 'Development WebSocket unavailable') })
      upstream.on('close', () => { if (client.readyState === WebSocket.OPEN) client.close(1000, 'Development WebSocket closed') })
      client.on('error', () => upstream.terminate())
      client.on('close', () => { ticket.sockets.delete(client); upstream.terminate() })
    })
    return true
  }
  return {
    handleUpgrade,
    deleteHost: (hostId: string) => { for (const ticket of tickets.values()) if (ticket.hostId === hostId) dispose(ticket.id) },
    close: () => { clearInterval(cleanup); unsubscribe(); for (const id of [...tickets.keys()]) dispose(id); wss.close() },
  }
}
