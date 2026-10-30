import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { BridgeOptions } from './bridge.js'
import type { Host } from './types.js'
import { codexDaemonArgs, sshCodexDaemonArgs, type CodexDaemonAction } from './ssh.js'
import { sharedSshPool } from './ssh-pool.js'

export type CodexDaemonOptions = Pick<BridgeOptions, 'codexBin' | 'codexHome' | 'cwd' | 'sshPool' | 'sshHostKeyPin' | 'resolveSshHostKeyPin'> & {
  /** Explicit remote home discovered from that host, never the Web container's home. */
  daemonHome?: string
}
const version = z.string().max(100).regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
const versions = z.object({
  managedCodexVersion: version.nullable(), cliVersion: version, appServerVersion: version,
  // A socket can belong to Codex Desktop or another independent launcher.
  // Selected package metadata alone does not prove lifecycle ownership.
  backend: z.string().max(64).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/).nullable().optional(),
})
const started = versions.extend({ status: z.enum(['started', 'alreadyRunning']) })
const running = versions.extend({ status: z.literal('running') })
const restarted = z.object({ status: z.literal('restarted') })
const updated = z.object({ status: z.literal('updated'), installedVersion: version, runningVersion: version })

export type CodexDaemonStarted = z.infer<typeof started>
export type CodexDaemonVersion = z.infer<typeof running>
export type CodexDaemonRestarted = z.infer<typeof restarted>
export type CodexDaemonUpdated = z.infer<typeof updated>

function failure(message: string, code: string, uncertain = false) {
  return Object.assign(new Error(message), { code, uncertain })
}
function aborted(action: CodexDaemonAction, dispatched = false) {
  return failure('Codex daemon 操作已取消，请同步主机状态后确认。', 'daemon_cancelled', dispatched && action !== 'version')
}
function commandFailure(action: CodexDaemonAction, diagnostic: string, timedOut: boolean) {
  const uncertain = action !== 'version'
  if (timedOut) return failure('Codex daemon 操作超时，结果待确认；请同步主机状态后检查。', 'daemon_timeout', uncertain)
  if (/host key|identification has changed|strict checking/i.test(diagnostic))
    return failure('请确认并信任 SSH 主机指纹后重试。', 'daemon_host_key')
  if (/Permission denied \(|Authentication failed|Too many authentication failures/i.test(diagnostic))
    return failure('SSH 身份验证失败，请检查主机账户和私钥。', 'daemon_ssh_auth')
  if (/not managed|unmanaged|not a managed|no daemon package is selected/i.test(diagnostic))
    return failure('已有非托管 App Server 占用 daemon 连接；请先核对其启动方式，未自动结束任何进程。', 'daemon_unmanaged')
  if (/unknown (?:command|subcommand)|unrecognized subcommand|unexpected argument/i.test(diagnostic))
    return failure('此 Codex 安装不支持所需 daemon 命令，请先更新主机上的 CLI。', 'daemon_unsupported')
  if (/Codex was not found|codex.*not found|No such file or directory/i.test(diagnostic))
    return failure('无法找到 Codex 或其 daemon，请检查主机的 Codex 路径和运行状态。', 'daemon_unavailable')
  return failure('无法完成 Codex daemon 操作，请检查目标主机的连接、配置与账户权限。', 'daemon_command_failed', uncertain)
}

/** Run only fixed official lifecycle commands. Stopping this short-lived CLI
 * never sends stop/restart to its independent daemon or kills its process group. */
async function command(host: Host, options: CodexDaemonOptions, action: CodexDaemonAction, signal?: AbortSignal) {
  if (signal?.aborted) throw aborted(action)
  const pin = host.kind === 'ssh' ? await options.resolveSshHostKeyPin?.(host) ?? options.sshHostKeyPin : undefined
  if (signal?.aborted) throw aborted(action)
  const lease = host.kind === 'ssh' ? await (options.sshPool || sharedSshPool).acquire(host, pin) : undefined
  try {
    if (signal?.aborted) throw aborted(action)
    const executable = host.kind === 'ssh' ? 'ssh' : options.codexBin || 'codex'
    const args = host.kind === 'ssh' ? sshCodexDaemonArgs(host, action, pin, lease?.control, options.daemonHome) : codexDaemonArgs(action)
    const cwd = host.kind === 'ssh' ? undefined : options.cwd
    const env = { ...process.env, ...(host.kind !== 'ssh' && options.codexHome ? { CODEX_HOME: options.codexHome } : {}) }
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, { env, cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', diagnostic = '', bytes = 0, settled = false, timedOut = false
      let pendingError: Error | undefined
      let forceClose: ReturnType<typeof setTimeout> | undefined
      const stop = () => {
        child.kill('SIGTERM')
        if (!forceClose) {
          forceClose = setTimeout(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy() }, 1000)
          forceClose.unref()
        }
      }
      const finish = (error?: Error) => {
        if (settled) return
        settled = true; clearTimeout(timer); clearTimeout(forceClose)
        signal?.removeEventListener('abort', onAbort)
        error ? reject(error) : resolve(output)
      }
      const onAbort = () => { pendingError = aborted(action, true); stop() }
      const timer = setTimeout(() => { timedOut = true; stop() }, action === 'update' || action === 'restart' ? 7 * 60_000 : action === 'start' ? 45_000 : 20_000)
      timer.unref()
      const append = (chunk: Buffer, stderr: boolean) => {
        if (pendingError) return
        bytes += chunk.length
        if (bytes > 128 * 1024) {
          pendingError = failure('Codex daemon 输出超出限制，结果待确认，请检查主机状态。', 'daemon_output_limit', action !== 'version')
          stop()
          return
        }
        if (stderr) diagnostic = (diagnostic + chunk.toString('utf8')).slice(-16_384)
        else output += chunk.toString('utf8')
      }
      child.stdout.on('data', chunk => append(chunk, false))
      child.stderr.on('data', chunk => append(chunk, true))
      child.once('error', () => finish(failure('无法启动 Codex daemon 命令，请检查 Codex 或 SSH 客户端的路径。', 'daemon_not_executable')))
      child.once('close', code => {
        if (pendingError) finish(pendingError)
        else if (code === 0 && !timedOut) finish()
        else finish(commandFailure(action, diagnostic, timedOut))
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  } finally { lease?.release() }
}

async function parsed<T>(host: Host, options: CodexDaemonOptions, action: CodexDaemonAction, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const output = await command(host, options, action, signal)
  try { return schema.parse(JSON.parse(output)) }
  catch { throw failure('Codex daemon 未返回可确认的状态，请同步主机信息后检查。', 'daemon_invalid_response', action !== 'version') }
}

/** Idempotent attachment preparation. Reconnects never upgrade or restart an
 * already running daemon; version changes require an explicit user action. */
export function ensureCodexDaemon(host: Host, options: CodexDaemonOptions = {}, signal?: AbortSignal) {
  return parsed(host, options, 'start', started, signal)
}
export function readCodexDaemonVersion(host: Host, options: CodexDaemonOptions = {}, signal?: AbortSignal) {
  return parsed(host, options, 'version', running, signal)
}
export function restartCodexDaemon(host: Host, options: CodexDaemonOptions = {}, signal?: AbortSignal) {
  return parsed(host, options, 'restart', restarted, signal)
}
export function updateCodexDaemon(host: Host, options: CodexDaemonOptions = {}, signal?: AbortSignal) {
  return parsed(host, options, 'update', updated, signal)
}
