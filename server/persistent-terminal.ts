import { createHash } from 'node:crypto'
import type { Express, RequestHandler } from 'express'
import { z } from 'zod'
import type { Bridge } from './bridge.js'
import type { Host } from './types.js'
import { tmuxSandbox } from './tmux.js'

type Dependencies = { getBridge: (hostId: string) => Promise<Bridge>; getHost: (id: string) => Host | undefined; requireAuth: RequestHandler; requireCsrf: RequestHandler }
const input = z.object({ hostId: z.string().default('local'), cwd: z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\x00-\x1f]/.test(value), 'An absolute working directory is required'), permission: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('read-only') }).strict()
const blocked = (message: string) => /permission denied|operation not permitted|access denied|sandbox|namespace|bwrap|denied by/i.test(message)
const blockedReason = '当前权限或容器隔离策略阻止检测 tmux；请检查权限与 namespace 支持，或明确选择完全访问后重试。'
export function persistentSessionName(hostId: string, cwd: string) { return `codex-web-${createHash('sha256').update(`${hostId}\0${cwd}`).digest('hex').slice(0, 24)}` }

/** tmux owns the persistent shell. App-server owns only the attaching PTY. */
export function registerPersistentTerminal(app: Express, deps: Dependencies) {
  app.post('/api/terminal-sessions/prepare', deps.requireAuth, deps.requireCsrf, async (req, res) => {
    const { hostId, cwd, permission } = input.parse(req.body)
    if (!deps.getHost(hostId)) { res.status(404).json({ error: 'Host not found' }); return }
    const bridge = await deps.getBridge(hostId)
    const metadata = await bridge.request('fs/getMetadata', { path: cwd }) as { isDirectory: boolean }
    if (!metadata.isDirectory) { res.status(400).json({ error: 'Working directory must be a directory' }); return }
    const sandboxPolicy = tmuxSandbox(permission, cwd)
    let result: { exitCode: number; stdout: string; stderr: string }
    try {
      result = await bridge.request('command/exec', { command: ['/bin/sh', '-c', 'command -v tmux'], cwd, timeoutMs: 10000, outputBytesCap: 4096, sandboxPolicy }) as typeof result
    } catch (cause) {
      if (blocked(cause instanceof Error ? cause.message : String(cause))) { res.json({ available: false, reason: blockedReason }); return }
      throw cause
    }
    if (blocked(result.stderr || '')) { res.json({ available: false, reason: blockedReason }); return }
    const executable = result.stdout?.trim()
    if (result.exitCode !== 0 || !executable?.startsWith('/') || /[\x00-\x1f]/.test(executable)) { res.json({ available: false, reason: '所选主机未检测到 tmux；普通 PTY 可恢复网络断线，但不会跨服务重启保留。' }); return }
    const sessionName = persistentSessionName(hostId, cwd)
    res.json({ available: true, sessionName, command: [executable, 'new-session', '-A', '-s', sessionName, '-c', cwd], persistence: 'tmux', note: '同一主机和项目复用 tmux 会话；结束网页终端只断开连接。输入 exit 将结束 Shell。' })
  })
}
