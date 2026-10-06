import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AuthenticatedRequest, Session } from './types.js'

export const COOKIE_NAME = 'codex_web_session'
const SESSION_TTL = 8 * 60 * 60 * 1000

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
  constructor(password: string, readonly allowedOrigins: Set<string>, private readonly secureCookie = false) {
    if (password.length < 12) throw new Error('CODEX_WEB_PASSWORD must contain at least 12 characters')
    this.passwordHash = scryptSync(password, this.salt, 64)
  }

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

  login: RequestHandler = (req: Request, res: Response) => {
    if (req.headers.origin && !this.isTrustedOrigin(req.headers.origin)) { res.status(403).json({ error: 'Untrusted origin' }); return }
    const address = req.ip || req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    let attempt = this.attempts.get(address)
    if (!attempt || now - attempt.startedAt > 15 * 60 * 1000) { attempt = { count: 0, startedAt: now }; this.attempts.set(address, attempt) }
    if (++attempt.count > 10) { res.set('Retry-After', '900').status(429).json({ error: 'Too many login attempts. Try again later.' }); return }
    // Keep rate-limit memory bounded even when clients rotate addresses.
    if (this.attempts.size > 10000) for (const [key, value] of this.attempts) if (now - value.startedAt > 15 * 60 * 1000) this.attempts.delete(key)
    const password = req.body?.password
    if (typeof password !== 'string' || password.length > 1024 || !timingSafeEqual(scryptSync(password, this.salt, 64), this.passwordHash)) { res.status(401).json({ error: 'Incorrect password' }); return }
    const old = this.getSession(req.headers.cookie)
    if (old) this.revoke(old.id)
    const session: Session = { id: randomBytes(32).toString('base64url'), csrfToken: randomBytes(32).toString('base64url'), expiresAt: now + SESSION_TTL }
    this.sessions.set(session.id, session)
    res.cookie(COOKIE_NAME, session.id, { httpOnly: true, sameSite: 'strict', secure: this.secureCookie || req.secure, maxAge: SESSION_TTL, path: '/' })
    res.set('Cache-Control', 'no-store').json({ authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt })
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
