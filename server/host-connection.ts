import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import { Bridge, type BridgeOptions } from './bridge.js'
import { hostInput } from './storage.js'
import type { Host } from './types.js'

export type ConnectionTestResult = {
  ok: boolean
  message: string
  elapsedMs: number
  stage: 'identity' | 'ssh' | 'codex' | 'protocol' | 'timeout' | 'ready'
  version?: string
  hostKeyRequired?: boolean
}

/** Classify bounded diagnostics; never expose shell banners, paths or account data. */
export function connectionFailure(error: unknown, diagnostic: string, stage: 'ssh' | 'protocol', timedOut = false): Pick<ConnectionTestResult, 'stage' | 'message' | 'hostKeyRequired'> {
  const message = error instanceof Error ? error.message : ''
  const text = `${diagnostic}\n${message}`.slice(-20_000)
  if (/UNPROTECTED PRIVATE KEY FILE|bad permissions|Load key .*?(?:Permission denied|invalid format)|Identity file .*?not accessible/i.test(text)) return { stage: 'identity', message: '无法使用身份文件，请检查文件路径、格式与权限。' }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .*host key is known|strict checking/i.test(text)) return { stage: 'ssh', hostKeyRequired: true, message: '主机密钥未受信任或已变更。请在此窗口获取服务器指纹，确认并信任后再连接。' }
  if (/Permission denied \(|Authentication failed|Too many authentication failures|sign_and_send_pubkey: signing failed/i.test(text)) return { stage: 'ssh', message: 'SSH 身份验证失败。请检查用户名、身份文件或服务器上的 SSH agent；测试不支持交互输入密码。' }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname provided/i.test(text)) return { stage: 'ssh', message: '无法解析主机名或 SSH 别名，请检查地址和服务器的 SSH 配置。' }
  if (/Connection refused|No route to host|Network is unreachable/i.test(text)) return { stage: 'ssh', message: '无法连接 SSH 端口，请检查主机地址、端口与网络。' }
  if (/Bad file descriptor/i.test(text)) return { stage: 'codex', message: 'SSH 已连接，但远端登录环境无法启动 Codex，请检查登录 Shell 的初始化配置。' }
  if (/Codex was not found|远端未找到 Codex|codex.*?not found/i.test(text)) return { stage: 'codex', message: 'SSH 已连接，但登录 shell 中未找到 Codex。请检查远端 PATH，或在高级设置中指定 Codex 路径。' }
  if (/exit(?:ed)? \(126\)|cd: .*?(?:No such file|can't cd|not found)/i.test(text)) return { stage: 'codex', message: '远端工作目录不可访问，请检查高级设置中的目录。' }
  if (timedOut || /Connection timed out|Operation timed out|request timed out/i.test(text)) return { stage: 'timeout', message: stage === 'ssh' ? '连接超时，请检查网络、SSH 端口及远端 Codex 启动状态。' : 'SSH 已连接，但 Codex app-server 未及时响应，请检查远端版本与启动状态。' }
  if (stage === 'protocol' || /Invalid JSON|WebSocket|app-server|App-server/i.test(text)) return { stage: 'protocol', message: 'Codex app-server 握手或只读检查失败，请检查远端 Codex 版本与启动配置。' }
  return { stage: 'ssh', message: 'SSH 连接失败，请检查地址、身份验证及远端 Codex 安装。' }
}

/** A disposable client probes drafts without creating a host or affecting active chats. */
export async function testHostConnection(host: Host, options: BridgeOptions = {}, timeoutMs = 12_000): Promise<ConnectionTestResult> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  if (host.identityFile) {
    try { await fs.access(host.identityFile, constants.R_OK); if (!(await fs.stat(host.identityFile)).isFile()) throw new Error('Not a file') }
    catch { return { ok: false, stage: 'identity', message: '身份文件不存在或服务器无法读取，请填写运行网页版的服务器上的文件路径。', elapsedMs: elapsed() } }
  }
  let diagnostic = ''
  let stage: 'ssh' | 'protocol' = 'ssh'
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const bridge = new Bridge(host, { ...options, connectionProbe: true, onStderr: chunk => { diagnostic = (diagnostic + chunk).slice(-16_384) } })
  try {
    const work = (async () => {
      await bridge.connect()
      stage = 'protocol'
      const configuration = await bridge.request('config/read', { ...(host.cwd ? { cwd: host.cwd } : {}), includeLayers: false }) as { config?: unknown }
      if (!configuration?.config || typeof configuration.config !== 'object') throw new Error('Invalid app-server config/read response')
    })()
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('Connection probe timed out')) }, timeoutMs) })
    await Promise.race([work, timeout])
    const version = diagnostic.match(/__CODEX_WEB_VERSION__=codex(?:-cli)?\s+([0-9][a-zA-Z0-9.+-]{0,50})(?:\s|$)/)?.[1]
    return { ok: true, stage: 'ready', message: '连接成功，Codex app-server 已通过握手与只读检查。', elapsedMs: elapsed(), ...(version ? { version } : {}) }
  } catch (error) {
    return { ok: false, ...connectionFailure(error, diagnostic, diagnostic.includes('__CODEX_WEB_VERSION__=') ? 'protocol' : stage, timedOut), elapsedMs: elapsed() }
  } finally {
    clearTimeout(timer)
    bridge.close('Connection test finished')
  }
}

export function registerHostConnection(app: Express, options: BridgeOptions) {
  // Registered after the application's auth and CSRF middleware, before host-ID routes.
  app.post('/api/hosts/test', (req, res, next) => {
    const input = { name: '临时 SSH 连接', ...req.body }
    if (input.name === '') input.name = '临时 SSH 连接'
    const parsed = hostInput.safeParse(input)
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map(issue => issue.message).join('；') }); return }
    const host: Host = { ...parsed.data, id: `probe-${randomUUID()}`, kind: 'ssh' }
    void testHostConnection(host, options).then(result => res.json(result)).catch(next)
  })
}
