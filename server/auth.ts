import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AuthenticatedRequest, Session } from './types.js'

export const COOKIE_NAME = 'codex_web_session'
export const SESSION_TTL = 30 * 24 * 60 * 60 * 1000
type PasswordRecord = { version: 1; algorithm: 'scrypt'; salt: string; hash: string; credentialVersion: string }
const passwordRecordKeys = ['algorithm', 'credentialVersion', 'hash', 'salt', 'version']

function passwordRecord(password: string, credentialVersion = randomBytes(16).toString('hex')): PasswordRecord {
  if (password.length < 12 || password.length > 1024) throw new Error('CODEX_WEB_PASSWORD must contain between 12 and 1024 characters')
  const salt = randomBytes(32)
  return { version: 1, algorithm: 'scrypt', salt: salt.toString('base64url'), hash: scryptSync(password, salt, 64).toString('base64url'), credentialVersion }
}

function validatePasswordRecord(value: unknown): PasswordRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted web password')
  const record = value as PasswordRecord
  const validKey = (key: unknown, length: number) => typeof key === 'string' && /^[a-zA-Z0-9_-]+$/.test(key) && Buffer.from(key, 'base64url').length === length && Buffer.from(key, 'base64url').toString('base64url') === key
  if (Object.keys(record).sort().join(',') !== passwordRecordKeys.join(',') || record.version !== 1 || record.algorithm !== 'scrypt' || !validKey(record.salt, 32) || !validKey(record.hash, 64) || typeof record.credentialVersion !== 'string' || !/^[a-f0-9]{32}$/.test(record.credentialVersion)) throw new Error('Invalid persisted web password')
  return record
}

async function savePasswordRecord(file: string, record: PasswordRecord) {
  const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync() }
    finally { await handle.close() }
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}

export function isLoopback(host: string) { return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) }
export function parseCookies(header?: string): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) { try { cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()) } catch {} }
  }
  return cookies
}

export function trustedOrigins(values: string[], port = 8787) {
  const origins = new Set<string>([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, 'http://localhost:5173', 'http://127.0.0.1:5173'])
  for (const value of values) {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.trim()) throw new Error('PUBLIC_ORIGIN must contain exact HTTP(S) origins without paths')
    origins.add(url.origin)
  }
  return origins
}

export class Auth {
  private salt = randomBytes(32)
  private passwordHash: Buffer
  private sessions = new Map<string, Session>()
  private attempts = new Map<string, { count: number; startedAt: number }>()
  private revokeListeners = new Set<(sessionId: string) => void>()
  private logoutListeners = new Set<(sessionId: string) => void | Promise<void>>()
  private passwordListeners = new Set<(sessionId: string, credentialVersion: string) => void | Promise<void>>()
  private passwordChanges: Promise<void> = Promise.resolve()
  private passwordFile?: string
  private credentialVersion = randomBytes(16).toString('hex')
  constructor(password: string, readonly allowedOrigins: Set<string>, private readonly secureCookie = false) {
    if (password.length < 12 || password.length > 1024) throw new Error('CODEX_WEB_PASSWORD must contain between 12 and 1024 characters')
    this.passwordHash = scryptSync(password, this.salt, 64)
  }

  /** Stored credentials take precedence over the one-time environment/bootstrap password. */
  static async create(dataDir: string, explicit: string | undefined, allowedOrigins: Set<string>, secureCookie = false) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
    await fs.chmod(dataDir, 0o700)
    const file = path.join(dataDir, 'web-password.json')
    let saved: PasswordRecord
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid persisted web password')
      saved = validatePasswordRecord(JSON.parse(await fs.readFile(file, 'utf8')))
      await fs.chmod(file, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read persisted web password; restore or reset web-password.json')
      saved = passwordRecord(await Auth.password(dataDir, explicit))
      await savePasswordRecord(file, saved)
    }
    // The constructor keeps the in-memory-only Auth API used by protocol tests.
    const auth = new Auth(randomBytes(24).toString('base64url'), allowedOrigins, secureCookie)
    auth.salt = Buffer.from(saved.salt, 'base64url')
    auth.passwordHash = Buffer.from(saved.hash, 'base64url')
    auth.credentialVersion = saved.credentialVersion
    auth.passwordFile = file
    return auth
  }

  get pushCredentialVersion() { return this.credentialVersion }

  static async password(dataDir: string, explicit?: string) {
    if (explicit) return explicit
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
    await fs.chmod(dataDir, 0o700)
    const file = path.join(dataDir, 'bootstrap-password.txt')
    try {
      const password = (await fs.readFile(file, 'utf8')).trim()
      await fs.chmod(file, 0o600)
      console.log(`Local bootstrap password: ${file}`)
      return password
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const password = randomBytes(24).toString('base64url')
      await fs.writeFile(file, `${password}\n`, { mode: 0o600, flag: 'wx' })
      console.log(`Local bootstrap password: ${password}\nSaved privately to ${file}`)
      return password
    }
  }

  getSession(cookieHeader?: string): Session | undefined {
    const session = this.sessions.get(parseCookies(cookieHeader)[COOKIE_NAME] || '')
    if (session && session.expiresAt > Date.now()) return session
    if (session) this.revoke(session.id)
    return undefined
  }

  isSessionActive(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (session && session.expiresAt > Date.now()) return true
    if (session) this.revoke(sessionId)
    return false
  }

  onSessionRevoked(listener: (sessionId: string) => void) {
    this.revokeListeners.add(listener)
    return () => this.revokeListeners.delete(listener)
  }

  /** Device grants survive natural session expiry, but an explicit sign-out revokes them. */
  onLogout(listener: (sessionId: string) => void | Promise<void>) {
    this.logoutListeners.add(listener)
    return () => this.logoutListeners.delete(listener)
  }

  onPasswordChanged(listener: (sessionId: string, credentialVersion: string) => void | Promise<void>) {
    this.passwordListeners.add(listener)
    return () => this.passwordListeners.delete(listener)
  }

  private revoke(sessionId: string) {
    if (!this.sessions.delete(sessionId)) return
    for (const listener of this.revokeListeners) listener(sessionId)
  }

  isTrustedOrigin(origin?: string) { return Boolean(origin && this.allowedOrigins.has(origin)) }

  requireAuth: RequestHandler = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const session = this.getSession(req.headers.cookie)
    if (!session) { res.status(401).json({ error: 'Authentication required' }); return }
    req.session = session
    next()
  }

  requireCsrf: RequestHandler = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return }
    if (req.headers.origin && !this.isTrustedOrigin(req.headers.origin)) { res.status(403).json({ error: 'Untrusted origin' }); return }
    const session = req.session || this.getSession(req.headers.cookie)
    if (!session || req.get('x-csrf-token') !== session.csrfToken) { res.status(403).json({ error: 'Invalid CSRF token' }); return }
    next()
  }

  session: RequestHandler = (req: Request, res: Response) => {
    const session = this.getSession(req.headers.cookie)
    res.set('Cache-Control', 'no-store').json({ authenticated: !!session, authRequired: true, ...(session ? { csrfToken: session.csrfToken, expiresAt: session.expiresAt } : {}) })
  }

  private allowPasswordAttempt(req: Request, res: Response) {
    const address = req.ip || req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    let attempt = this.attempts.get(address)
    if (!attempt || now - attempt.startedAt > 15 * 60 * 1000) { attempt = { count: 0, startedAt: now }; this.attempts.set(address, attempt) }
    if (++attempt.count > 10) { res.set('Retry-After', '900').status(429).json({ error: '尝试次数过多，请 15 分钟后重试。' }); return false }
    // Keep rate-limit memory bounded even when clients rotate addresses.
    if (this.attempts.size > 10000) for (const [key, value] of this.attempts) if (now - value.startedAt > 15 * 60 * 1000) this.attempts.delete(key)
    return true
  }

  private matchesPassword(password: string) { return timingSafeEqual(scryptSync(password, this.salt, 64), this.passwordHash) }

  private sessionCookie(req: Request, res: Response, session: Session) {
    res.cookie(COOKIE_NAME, session.id, { httpOnly: true, sameSite: 'strict', secure: this.secureCookie || req.secure, maxAge: SESSION_TTL, path: '/' })
  }

  login: RequestHandler = (req: Request, res: Response) => {
    if (req.headers.origin && !this.isTrustedOrigin(req.headers.origin)) { res.status(403).json({ error: 'Untrusted origin' }); return }
    const now = Date.now()
    if (!this.allowPasswordAttempt(req, res)) return
    const password = req.body?.password
    if (typeof password !== 'string' || password.length > 1024 || !this.matchesPassword(password)) { res.status(401).json({ error: 'Incorrect password' }); return }
    const old = this.getSession(req.headers.cookie)
    if (old) this.revoke(old.id)
    const session: Session = { id: randomBytes(32).toString('base64url'), csrfToken: randomBytes(32).toString('base64url'), expiresAt: now + SESSION_TTL }
    this.sessions.set(session.id, session)
    this.sessionCookie(req, res, session)
    res.set('Cache-Control', 'no-store').json({ authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt })
  }

  changePassword: RequestHandler = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const operation = this.passwordChanges.then(async () => {
      const session = req.session || this.getSession(req.headers.cookie)
      if (!session || !this.isSessionActive(session.id)) { res.status(401).json({ error: '请重新登录后修改密码。' }); return }
      const body = req.body
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'currentPassword,newPassword' || typeof body.currentPassword !== 'string' || body.currentPassword.length > 1024 || typeof body.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 1024) {
        res.status(400).json({ error: '请填写当前密码，并使用 12 至 1024 个字符的新密码。' }); return
      }
      if (!this.allowPasswordAttempt(req, res)) return
      if (!this.matchesPassword(body.currentPassword)) { res.status(403).json({ error: '当前访问密码不正确。' }); return }
      if (body.newPassword === body.currentPassword) { res.status(400).json({ error: '新密码必须与当前密码不同。' }); return }
      const saved = passwordRecord(body.newPassword, randomBytes(16).toString('hex'))
      try { if (this.passwordFile) await savePasswordRecord(this.passwordFile, saved) }
      catch { res.status(503).json({ error: '无法保存新密码，请稍后重试。' }); return }
      // Only commit in memory and revoke other sessions after the atomic write succeeds.
      this.salt = Buffer.from(saved.salt, 'base64url')
      this.passwordHash = Buffer.from(saved.hash, 'base64url')
      this.credentialVersion = saved.credentialVersion
      session.expiresAt = Date.now() + SESSION_TTL
      for (const id of this.sessions.keys()) if (id !== session.id) this.revoke(id)
      // The persisted credential generation also invalidates old push grants on restart.
      for (const listener of this.passwordListeners) {
        try { await listener(session.id, saved.credentialVersion) }
        catch { console.error('Unable to persist device revocation after web password change') }
      }
      this.sessionCookie(req, res, session)
      res.set('Cache-Control', 'no-store').json({ ok: true, expiresAt: session.expiresAt })
    })
    this.passwordChanges = operation.catch(() => {})
    void operation.catch(next)
  }

  logout: RequestHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const session = req.session || this.getSession(req.headers.cookie)
    if (session) this.revoke(session.id)
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: this.secureCookie || req.secure, path: '/' })
    try { if (session) await Promise.all([...this.logoutListeners].map(listener => listener(session.id))) }
    catch (error) { next(error); return }
    res.json({ authenticated: false })
  }
}
