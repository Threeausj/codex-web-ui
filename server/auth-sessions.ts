import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import type { Session } from './types.js'

export const MAX_PERSISTED_SESSIONS = 4096
const MAX_SESSION_FILE_BYTES = 2 * 1024 * 1024
export type PersistedSession = Omit<Session, 'id'> & { sessionHash: string }
export type RevokedSession = { sessionHash: string; expiresAt: number }
type SessionPayload = { version: 1; credentialVersion: string; sessions: PersistedSession[]; revokedSessions: RevokedSession[] }

export function sessionHash(id: string) { return createHash('sha256').update(id).digest('base64url') }
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value
function signature(payload: SessionPayload, key: Buffer) { return createHmac('sha256', key).update(JSON.stringify(payload)).digest() }

/** The password generation and MAC bind persisted grants to the current credential. */
export async function readSessions(file: string, credentialVersion: string, key: Buffer, ttl: number): Promise<SessionPayload | undefined> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION_FILE_BYTES) throw new Error('Invalid session file')
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'credentialVersion,revokedSessions,sessions,signature,version' || value.version !== 1 || value.credentialVersion !== credentialVersion || !Array.isArray(value.sessions) || !Array.isArray(value.revokedSessions) || value.sessions.length > MAX_PERSISTED_SESSIONS || value.revokedSessions.length > MAX_PERSISTED_SESSIONS || !validToken(value.signature)) throw new Error('Invalid session file')
    const payload: SessionPayload = { version: 1, credentialVersion, sessions: value.sessions, revokedSessions: value.revokedSessions }
    if (!timingSafeEqual(signature(payload, key), Buffer.from(value.signature, 'base64url'))) throw new Error('Invalid session signature')
    const now = Date.now()
    const seen = new Set<string>()
    for (const session of payload.sessions) {
      if (!session || Object.keys(session).sort().join(',') !== 'csrfToken,expiresAt,sessionHash' || !validToken(session.sessionHash) || !validToken(session.csrfToken) || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= 0 || session.expiresAt > now + ttl || seen.has(session.sessionHash)) throw new Error('Invalid session record')
      seen.add(session.sessionHash)
    }
    seen.clear()
    for (const session of payload.revokedSessions) {
      if (!session || Object.keys(session).sort().join(',') !== 'expiresAt,sessionHash' || !validToken(session.sessionHash) || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= 0 || session.expiresAt > now + ttl || seen.has(session.sessionHash)) throw new Error('Invalid session revocation')
      seen.add(session.sessionHash)
    }
    await fs.chmod(file, 0o600)
    payload.sessions = payload.sessions.filter(session => session.expiresAt > now && !seen.has(session.sessionHash))
    payload.revokedSessions = payload.revokedSessions.filter(session => session.expiresAt > now)
    return payload
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Stored web sessions could not be verified')
  }
}

/** No bearer IDs or passwords are written. A successful response follows the atomic write. */
export async function writeSessions(file: string, credentialVersion: string, key: Buffer, sessions: Map<string, Session>, revoked: Map<string, number>) {
  const now = Date.now()
  const payload: SessionPayload = {
    version: 1, credentialVersion,
    sessions: [...sessions].filter(([, session]) => session.expiresAt > now).map(([hash, session]) => ({ sessionHash: hash, csrfToken: session.csrfToken, expiresAt: session.expiresAt })),
    revokedSessions: [...revoked].filter(([, expiresAt]) => expiresAt > now).map(([hash, expiresAt]) => ({ sessionHash: hash, expiresAt })),
  }
  if (payload.sessions.length > MAX_PERSISTED_SESSIONS || payload.revokedSessions.length > MAX_PERSISTED_SESSIONS) throw new Error('Too many stored web sessions')
  const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify({ ...payload, signature: signature(payload, key).toString('base64url') })}\n`); await handle.sync() }
    finally { await handle.close() }
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}
