import type { Request } from 'express'

export type Host = {
  id: string
  name: string
  kind: 'local' | 'ssh'
  hostname?: string
  username?: string
  port?: number
  identityFile?: string
  codexPath?: string
  cwd?: string
}

export type Project = { id: string; name: string; path: string; rootPaths?: string[]; hostId: string; source: 'desktop' | 'web' }
export type Session = { id: string; csrfToken: string; expiresAt: number }
export interface AuthenticatedRequest extends Request { session?: Session }
export type RpcId = string | number
export type RpcMessage = { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export function rpcError(id: RpcId, message: string, code = -32000): RpcMessage {
  return { id, error: { code, message } }
}
