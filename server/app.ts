import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import multer from 'multer'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { Auth, trustedOrigins } from './auth.js'
import { Storage } from './storage.js'
import { Bridge, RpcFailure, type BridgeOptions } from './bridge.js'
import { registerPreferences } from './preferences.js'
import { registerGit } from './git.js'
import { registerNavigation } from './navigation.js'
import { registerPreview } from './preview.js'
import { registerDevelopmentPreview } from './dev-preview.js'
import { registerPersistentTerminal } from './persistent-terminal.js'
import { registerTmux } from './tmux.js'
import { registerHostConnection } from './host-connection.js'
import { SshKeys, registerSshKeys } from './ssh-keys.js'
import { registerProjectDirectories } from './project-directories.js'
import { PushService, registerPush, type PushOptions } from './push.js'
import type { AuthenticatedRequest } from './types.js'

export type AppOptions = {
  cwd?: string; dataDir?: string; codexHome?: string; password?: string; origins?: string[]; port?: number
  secureCookie?: boolean; trustProxy?: boolean; bridgeOptions?: BridgeOptions; serveStatic?: boolean; staticDir?: string
  pushOptions?: PushOptions
}

const asyncRoute = (handler: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next) }
const absolutePath = z.string().min(1).max(4096).refine(s => s.startsWith('/') && !/[\x00-\x1f]/.test(s), 'An absolute path is required')

export async function createApp(options: AppOptions = {}) {
  const cwd = path.resolve(options.cwd || process.cwd())
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(cwd, '.data'))
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const storage = new Storage(dataDir, codexHome, cwd)
  await storage.init()
  const configuredOrigins = options.origins || (process.env.PUBLIC_ORIGIN || '').split(',').filter(Boolean)
  const origins = trustedOrigins(configuredOrigins, options.port || Number(process.env.PORT) || 8787)
  const httpsOnly = configuredOrigins.length > 0 && configuredOrigins.every(origin => origin.trim().startsWith('https:'))
  const auth = await Auth.create(dataDir, options.password || process.env.CODEX_WEB_PASSWORD, origins, options.secureCookie ?? httpsOnly)
  const push = await PushService.create(dataDir, origins, { ...options.pushOptions, credentialVersion: auth.pushCredentialVersion })
  const stopPushLogoutListener = auth.onLogout(sessionId => push.revokeSession(sessionId))
  const stopPushPasswordListener = auth.onPasswordChanged((sessionId, version) => push.changeCredentialVersion(version, sessionId))
  const mode = options.bridgeOptions?.mode || (process.env.CODEX_CONNECTION_MODE === 'proxy' ? 'proxy' : 'spawn')
  const bridgeOptions: BridgeOptions = { codexBin: process.env.CODEX_BIN || 'codex', codexHome, cwd, mode, socketPath: process.env.CODEX_SOCKET_PATH, ...options.bridgeOptions }
  const externalProtocolObserver = bridgeOptions.onProtocolMessage
  bridgeOptions.onProtocolMessage = (host, message) => {
    push.observe(host, message)
    return externalProtocolObserver?.(host, message)
  }
  const bridges = new Map<string, Bridge>()
  const getBridge = async (hostId = 'local') => {
    const host = storage.host(hostId)
    if (!host) throw Object.assign(new Error('Host not found'), { status: 404 })
    let bridge = bridges.get(hostId)
    if (!bridge) { bridge = new Bridge(host, bridgeOptions); bridges.set(hostId, bridge) }
    return bridge
  }
  const app = express()
  app.disable('x-powered-by')
  if (options.trustProxy ?? process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)
  app.use((_req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' }); next() })
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  app.use(express.json({ limit: '64kb' }))
  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  app.get('/api/auth/session', auth.session)
  app.post('/api/auth/login', auth.login)
  app.post('/api/auth/logout', auth.requireAuth, auth.requireCsrf, auth.logout)
  app.post('/api/auth/password', auth.requireAuth, auth.requireCsrf, auth.changePassword)
  registerPreview(app, { getBridge, getHost: (id: string) => storage.host(id), requireAuth: auth.requireAuth, requireCsrf: auth.requireCsrf, allowedOrigins: origins, isSessionActive: (sessionId: string) => auth.isSessionActive(sessionId) })
  const developmentPreview = registerDevelopmentPreview(app, { getHost: id => storage.host(id), requireAuth: auth.requireAuth, requireCsrf: auth.requireCsrf, isSessionActive: id => auth.isSessionActive(id), onSessionRevoked: listener => auth.onSessionRevoked(listener) })
  registerPersistentTerminal(app, { getBridge, getHost: id => storage.host(id), requireAuth: auth.requireAuth, requireCsrf: auth.requireCsrf })
  app.use('/api', auth.requireAuth, auth.requireCsrf)
  registerPush(app, push)
  registerTmux(app, { getBridge })
  const preferences = await registerPreferences(app, dataDir)
  registerGit(app, { getBridge })
  registerNavigation(app, getBridge)
  registerProjectDirectories(app, { getBridge, storage, cwd })
  app.get('/api/bootstrap', asyncRoute(async (_req, res) => {
    res.json({ hosts: storage.hosts, projects: await storage.projects(), cwd, codexHome, connectionMode: mode, preferences: preferences.get() })
  }))
  app.get('/api/hosts', (_req, res) => res.json({ hosts: storage.hosts }))
  registerHostConnection(app, bridgeOptions)
  const sshKeys = new SshKeys(dataDir, storage)
  registerSshKeys(app, sshKeys)
  app.post('/api/hosts', asyncRoute(async (req, res) => res.status(201).json({ host: await storage.addHost(req.body) })))
  app.patch('/api/hosts/:id', asyncRoute(async (req, res) => {
    const id = String(req.params.id)
    const previousIdentityFile = storage.host(id)?.identityFile
    const result = await storage.updateHost(id, req.body)
    if (result.connectionReset) {
      developmentPreview.deleteHost(id)
      bridges.get(id)?.close('Host settings changed', 4001)
      bridges.delete(id)
    }
    if (previousIdentityFile !== result.host.identityFile) await sshKeys.removeUnused(previousIdentityFile).catch(() => {})
    res.json({ ...result, hosts: storage.hosts })
  }))
  app.delete('/api/hosts/:id', asyncRoute(async (req, res) => {
    const id = String(req.params.id)
    const previousIdentityFile = storage.host(id)?.identityFile
    await storage.deleteHost(id)
    await sshKeys.removeUnused(previousIdentityFile).catch(() => {})
    developmentPreview.deleteHost(id)
    bridges.get(id)?.close(); bridges.delete(id)
    res.json({ ok: true })
  }))
  app.get('/api/projects', asyncRoute(async (_req, res) => res.json({ projects: await storage.projects() })))
  app.post('/api/projects', asyncRoute(async (req, res) => {
    const { path: projectPath, name, hostId, rootPaths } = z.object({ path: absolutePath, rootPaths: z.array(absolutePath).max(12).optional(), name: z.string().min(1).max(256).optional(), hostId: z.string().default('local') }).parse(req.body)
    const bridge = await getBridge(hostId)
    const metadata = await Promise.all([...new Set([projectPath, ...(rootPaths || [])])].map(path => bridge.request('fs/getMetadata', { path }) as Promise<{ isDirectory?: boolean }>))
    if (metadata.some(entry => !entry.isDirectory)) { res.status(400).json({ error: 'Project path must be a directory' }); return }
    res.status(201).json({ project: await storage.addProject(hostId, projectPath, name, rootPaths) })
  }))
  app.patch('/api/projects', asyncRoute(async (req, res) => {
    const { hostId, path: projectPath, ...fields } = z.object({ hostId: z.string().default('local'), path: absolutePath, name: z.string().trim().min(1).max(256).refine(value => !/[\x00-\x1f]/.test(value)).optional(), rootPaths: z.array(absolutePath).max(12).optional() }).strict().refine(value => value.name !== undefined || value.rootPaths !== undefined, 'Provide project edits').parse(req.body)
    if (fields.rootPaths) {
      const bridge = await getBridge(hostId)
      const entries = await Promise.all([...new Set([projectPath, ...fields.rootPaths])].map(path => bridge.request('fs/getMetadata', { path }) as Promise<{ isDirectory?: boolean }>))
      if (entries.some(entry => !entry.isDirectory)) { res.status(400).json({ error: 'Project path must be a directory' }); return }
    }
    res.json({ project: await storage.updateProject(hostId, projectPath, fields), projects: await storage.projects() })
  }))
  app.delete('/api/projects', asyncRoute(async (req, res) => {
    const { hostId, path: projectPath } = z.object({ hostId: z.string().default('local'), path: absolutePath }).strict().parse(req.body)
    await storage.removeProject(hostId, projectPath)
    res.json({ projects: await storage.projects() })
  }))
  const upload = multer({ storage: multer.memoryStorage(), limits: { files: 8, fileSize: 20 * 1024 * 1024, fields: 4, fieldSize: 8192 } })
  app.post('/api/uploads', upload.array('files', 8), asyncRoute(async (req, res) => {
    const files = req.files as Express.Multer.File[] | undefined
    if (!files?.length) { res.status(400).json({ error: 'Select at least one file' }); return }
    const hostId = z.string().default('local').parse(req.body?.hostId)
    const host = storage.host(hostId)
    if (!host) { res.status(404).json({ error: 'Host not found' }); return }
    const bridge = await getBridge(hostId)
    const uploadId = randomUUID()
    const uploadCwd = host.kind === 'local' ? cwd : absolutePath.parse(req.body?.cwd || host.cwd)
    const baseDirectory = host.kind === 'local' ? path.join(dataDir, 'uploads') : path.posix.join(uploadCwd, '.codex-web-uploads')
    const directory = path.posix.join(baseDirectory, uploadId)
    if (host.kind === 'local') { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(baseDirectory, 0o700); await fs.chmod(directory, 0o700) }
    else {
      await bridge.request('fs/createDirectory', { path: directory, recursive: true })
      const result = await bridge.request('command/exec', { command: ['chmod', '700', baseDirectory, directory], cwd: uploadCwd, timeoutMs: 10000, outputBytesCap: 1024, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [uploadCwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } }) as { exitCode: number }
      if (result.exitCode !== 0) throw new Error('Unable to secure the remote upload directory')
    }
    const saved: { name: string; path: string; mime: string; size: number }[] = []
    for (const [index, file] of files.entries()) {
      const name = path.posix.basename(file.originalname.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').slice(0, 180) || 'upload'
      const destination = path.posix.join(directory, `${index}-${name}`)
      await bridge.request('fs/writeFile', { path: destination, dataBase64: file.buffer.toString('base64') })
      if (host.kind === 'local') await fs.chmod(destination, 0o600)
      else {
        const result = await bridge.request('command/exec', { command: ['chmod', '600', destination], cwd: uploadCwd, timeoutMs: 10000, outputBytesCap: 1024, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [uploadCwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } }) as { exitCode: number }
        if (result.exitCode !== 0) throw new Error('Unable to secure the uploaded file')
      }
      saved.push({ name, path: destination, mime: file.mimetype, size: file.size })
    }
    res.status(201).json({ files: saved })
  }))
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }))
  if (options.serveStatic !== false) {
    const dist = path.resolve(options.staticDir || process.env.STATIC_DIR || path.join(cwd, 'dist'))
    app.use(express.static(dist, { index: false, dotfiles: 'deny', setHeaders: (res, file) => {
      const relative = path.relative(dist, file)
      if (relative === 'sw.js') res.setHeader('Cache-Control', 'no-store')
      else if (relative === 'manifest.webmanifest' || relative === 'index.html') res.setHeader('Cache-Control', 'no-cache')
      else if (relative.startsWith(`assets${path.sep}`) && /-[a-zA-Z0-9_-]{8,}\.[^.]+$/.test(path.basename(file))) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      if (relative === 'sw.js') res.setHeader('Service-Worker-Allowed', '/')
    } }))
    app.get('/{*path}', asyncRoute(async (req, res) => {
      if (!req.accepts('html')) { res.status(404).end(); return }
      try { await fs.access(path.join(dist, 'index.html')); res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'index.html')) }
      catch { res.status(503).send('Frontend is not built. Run npm run dev or npm run build.') }
    }))
  }
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return
    if (error?.type === 'entity.parse.failed') { res.status(400).json({ error: '请求格式不正确，请重试。' }); return }
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }); return }
    if (error instanceof multer.MulterError) { res.status(413).json({ error: error.message }); return }
    if (error instanceof RpcFailure) { res.status(502).json({ error: error.message, code: error.rpc.code }); return }
    res.status(error.status || 500).json({ error: error.message || 'Request failed' })
  }
  app.use(errorHandler)
  // Subscription grants survive server restarts. Restore host observers independently
  // of a phone being online; unavailable SSH hosts must not prevent server startup.
  if (push.hasActiveSubscriptions) for (const host of storage.hosts) void getBridge(host.id).then(bridge => bridge.connect()).catch(() => {})
  return { app, auth, storage, bridges, getBridge, dataDir, developmentPreview, push, stopPushLogoutListener, stopPushPasswordListener }
}

export async function createServer(options: AppOptions = {}) {
  const context = await createApp(options)
  const server = http.createServer(context.app)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false })
  const sessionSockets = new Map<string, Set<WebSocket>>()
  const stopListeningForRevocation = context.auth.onSessionRevoked(sessionId => {
    for (const ws of sessionSockets.get(sessionId) || []) ws.close(4003, 'Session expired')
  })
  server.on('upgrade', (req, socket, head) => {
    const reject = (code: number, label: string) => { socket.write(`HTTP/1.1 ${code} ${label}\r\nConnection: close\r\n\r\n`); socket.destroy() }
    const url = new URL(req.url || '/', 'http://localhost')
    if (context.developmentPreview.handleUpgrade(req, socket, head)) return
    if (url.pathname !== '/api/rpc') { reject(404, 'Not Found'); return }
    if (!context.auth.isTrustedOrigin(req.headers.origin)) { reject(403, 'Forbidden'); return }
    const session = context.auth.getSession(req.headers.cookie)
    if (!session) { reject(401, 'Unauthorized'); return }
    const hostId = url.searchParams.get('host') || 'local'
    if (!context.storage.host(hostId)) { reject(404, 'Not Found'); return }
    const proposedId = url.searchParams.get('clientId') || ''
    const clientId = /^[a-zA-Z0-9_-]{8,128}$/.test(proposedId) ? proposedId : randomUUID()
    wss.handleUpgrade(req, socket, head, ws => {
      let sockets = sessionSockets.get(session.id)
      if (!sockets) { sockets = new Set(); sessionSockets.set(session.id, sockets) }
      sockets.add(ws)
      const key = `${session.id}:${clientId}`
      void context.getBridge(hostId).then(bridge => bridge.attach(key, ws, clientId, () => context.auth.isSessionActive(session.id))).catch(() => ws.close(1011, 'Cannot connect to host'))
      const validateSession = setInterval(() => { if (!context.auth.getSession(req.headers.cookie)) ws.close(4003, 'Session expired') }, 15000)
      validateSession.unref()
      ws.on('close', () => { clearInterval(validateSession); sockets!.delete(ws); if (!sockets!.size) sessionSockets.delete(session.id) })
      ws.on('pong', () => { (ws as unknown as { isAlive: boolean }).isAlive = true })
      ;(ws as unknown as { isAlive: boolean }).isAlive = true
    })
  })
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = ws as unknown as { isAlive: boolean }
      if (!state.isAlive) { ws.terminate(); continue }
      state.isAlive = false; ws.ping()
    }
  }, 30000)
  heartbeat.unref()
  const close = async () => {
    clearInterval(heartbeat)
    stopListeningForRevocation()
    context.stopPushLogoutListener()
    context.stopPushPasswordListener()
    context.developmentPreview.close()
    for (const bridge of context.bridges.values()) bridge.close()
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    await context.push.close()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  return { ...context, server, wss, close }
}
