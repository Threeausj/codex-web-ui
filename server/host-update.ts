import fs from 'node:fs/promises'
import path from 'node:path'
import type { Express, RequestHandler } from 'express'
import { z } from 'zod'
import type { Bridge, BridgeOptions } from './bridge.js'
import type { Host } from './types.js'
import { runHostPython } from './host-helper.js'
import { writePrivateJson } from './storage.js'
import { nativeRuntimeVersion } from './native-capabilities.js'
import { activeCodexUpdate, type HostCodexUpdateOperation, type HostCodexUpdateStatus } from '../shared/host-update.js'

const semver = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/).max(100)
const operationSchema = z.object({
  id: z.string().uuid(), hostId: z.string().min(1).max(256),
  state: z.enum(['checking', 'updating', 'restarting', 'completed', 'failed']),
  startedAt: z.number().nonnegative(), updatedAt: z.number().nonnegative(), finishedAt: z.number().nonnegative().optional(),
  beforeVersion: semver.optional(), installedVersion: semver.optional(), runtimeVersion: semver.optional(),
  message: z.string().max(512).optional(), error: z.string().max(512).optional(),
}).strict()
const journalSchema = z.object({ version: z.literal(1), operations: z.array(operationSchema).max(512) }).strict()
const busy = (message: string) => Object.assign(new Error(message), { status: 409 })
export const codexVersion = (value: string | undefined) => nativeRuntimeVersion(value)
type Dependencies = {
  getHost(id: string): Host | undefined
  getExistingBridge(id: string): Bridge | undefined
  isHostChanging?(id: string): boolean
  withRuntimeMaintenance<T>(hostId: string, work: () => Promise<T>): Promise<T>
  bridgeOptions?: BridgeOptions
  execute?: (host: Host, phase: 'version' | 'update', home?: string) => Promise<{ version: string }>
  now?: () => number
}

/** A fixed host-owned updater. Raw installer output never reaches the browser
 * or the durable journal; no HTTP input can supply a command or its arguments. */
export function codexUpdateScript(host: Host, options: BridgeOptions, phase: 'version' | 'update', home?: string) {
  const config = Buffer.from(JSON.stringify({ remote: host.kind === 'ssh', command: host.kind === 'ssh' ? host.codexPath?.trim() || 'codex' : options.codexBin || 'codex', home: home || options.codexHome || '', cwd: host.kind === 'ssh' ? host.cwd || '' : options.cwd || '', phase })).toString('base64')
  return `import base64,json,os,pathlib,re,shlex,signal,subprocess,tempfile,time
config=json.loads(base64.b64decode('${config}'))
class UpdateFailure(Exception): pass
def run(arguments,seconds):
    env=os.environ.copy()
    if config['home']: env['CODEX_HOME']=config['home']
    executable=[config['command']]+arguments
    if config['remote']:
        # Match the app-server launcher: login-shell PATH, POSIX command lookup,
        # explicit host Codex home applied after shell startup overrides.
        launch=('cd '+shlex.quote(config['cwd'])+' || exit 126\\n' if config['cwd'] else '')
        launch+='codex_bin='+shlex.quote(config['command'])+'\\ncodex_bin=$(command -v "$codex_bin" 2>/dev/null) || exit 127\\n'
        launch+='exec '+('env '+shlex.quote('CODEX_HOME='+config['home'])+' ' if config['home'] else '')+'"$codex_bin" '+' '.join(shlex.quote(arg) for arg in arguments)
        executable=[env.get('SHELL') or '/bin/sh','-ilc','exec /bin/sh -c '+shlex.quote(launch)]
    if config['cwd'] and not pathlib.Path(config['cwd']).is_dir(): raise UpdateFailure('directory')
    directory=config['cwd'] or None
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        try: process=subprocess.Popen(executable,cwd=directory,env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=errors,start_new_session=True)
        except (OSError,ValueError): raise UpdateFailure('not_executable')
        deadline=time.monotonic()+seconds
        failure=None
        while process.poll() is None:
            if time.monotonic()>=deadline: failure='timeout'; break
            if os.fstat(output.fileno()).st_size+os.fstat(errors.fileno()).st_size>2*1024*1024: failure='output_limit'; break
            time.sleep(0.1)
        if failure:
            try: os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError: pass
            try: process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try: os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                process.wait()
            raise UpdateFailure(failure)
        output.seek(0); errors.seek(0)
        text=output.read(32768).decode('utf-8','replace')+'\\n'+errors.read(32768).decode('utf-8','replace')
        if process.returncode:
            if re.search(r'permission denied|read.only file system|EACCES|EROFS',text,re.I): raise UpdateFailure('permission')
            if re.search(r'unknown (?:command|subcommand)|unrecognized subcommand',text,re.I): raise UpdateFailure('unsupported')
            raise UpdateFailure('command_failed')
        return text
def version():
    value=run(['--version'],15)
    match=re.search(r'^codex-cli\\s+(\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?)\\s*$',value,re.M)
    if not match: raise UpdateFailure('version_unknown')
    return match.group(1)
try:
    if config['phase']=='update': run(['update'],600)
    print(json.dumps({'ok':True,'version':version()}))
except UpdateFailure as error: print(json.dumps({'ok':False,'reason':str(error)}))
`
}
const failureMessages: Record<string, string> = {
  not_executable: '无法执行所配置的 Codex，请检查路径、SSH 登录环境和执行权限。',
  directory: '所配置的工作目录不存在，未执行更新；请先核对主机连接设置。',
  timeout: 'codex update 执行超时，安装结果待核对；原有连接未主动重启，请在主机上确认后再操作。',
  output_limit: 'codex update 输出超出限制，安装结果待核对；请在主机上确认后重试。',
  permission: 'Codex 安装目录不可写或为只读挂载，请在主机上处理安装权限后重试。',
  unsupported: '此安装不支持 codex update，请先在主机上升级 CLI；未尝试其他安装命令。',
  command_failed: 'codex update 未成功退出，请在目标主机检查网络和安装方式后重试。',
  version_unknown: '无法确认更新后的 CLI 版本，原有连接未主动重启；请检查所配置的 Codex 路径。',
}

export class HostCodexUpdates {
  private readonly file: string
  private readonly now: () => number
  private operations: HostCodexUpdateOperation[] = []
  private active = new Map<string, Promise<void>>()
  private receipts = new Map<string, Promise<void>>()
  private writes: Promise<void> = Promise.resolve()
  private closed = false
  constructor(dataDir: string, private readonly dependencies: Dependencies) {
    this.file = path.join(dataDir, 'codex-updates.json'); this.now = dependencies.now || Date.now
  }
  async init() {
    try {
      const stat = await fs.lstat(this.file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid Codex update journal')
      this.operations = journalSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8'))).operations
      if (new Set(this.operations.map(entry => JSON.stringify([entry.hostId, entry.id]))).size !== this.operations.length) throw new Error('Duplicate Codex update operation')
      for (const operation of this.operations) if (activeCodexUpdate(operation)) Object.assign(operation, {
        state: 'failed', finishedAt: this.now(), updatedAt: this.now(),
        error: 'Web 服务曾在更新期间重启，更新结果待核对；不会自动重发更新命令，请刷新版本后确认。',
      })
      await this.persist()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 Codex 更新记录，请检查私人数据目录', { cause: error }) }
  }
  private persist() {
    const snapshot = structuredClone({ version: 1, operations: this.operations })
    const writing = this.writes.then(() => writePrivateJson(this.file, snapshot))
    this.writes = writing.catch(() => {}); return writing
  }
  isUpdating(hostId: string) { return this.active.has(hostId) }
  private target(hostId: string) {
    const host = this.dependencies.getHost(hostId)
    if (!host) throw Object.assign(new Error('主机不存在或已停用'), { status: 404 })
    return { host, bridge: this.dependencies.getExistingBridge(hostId) }
  }
  status(hostId: string): HostCodexUpdateStatus {
    const { bridge } = this.target(hostId)
    const operation = this.operations.filter(entry => entry.hostId === hostId &&
      !this.receipts.has(JSON.stringify([entry.hostId, entry.id]))).at(-1) || null
    const disabledReason = this.closed ? 'Web 服务正在停止。' : this.active.has(hostId) ? '此主机正在更新 Codex。'
      : this.dependencies.isHostChanging?.(hostId) ? '此主机的连接设置正在变更，请完成后再更新。'
      : !bridge?.connected || bridge.paused ? '请先连接此主机的 Codex。'
      : !bridge.runtime.managed ? '此 Codex 由外部代理管理，请在主机更新并重启对应进程。'
      : !bridge.reconnectStatus.canReconnect ? bridge.reconnectStatus.reconnectDisabledReason || '主机暂时不可重启。' : undefined
    return { command: 'codex update', canUpdate: !disabledReason, ...(disabledReason ? { disabledReason } : {}),
      ...(codexVersion(bridge?.userAgent) ? { runtimeVersion: codexVersion(bridge?.userAgent) } : {}), operation: structuredClone(operation) }
  }
  private async execute(host: Host, phase: 'version' | 'update', home?: string) {
    if (this.dependencies.execute) return this.dependencies.execute(host, phase, home)
    const raw = JSON.parse(await runHostPython(host, codexUpdateScript(host, this.dependencies.bridgeOptions || {}, phase, home), this.dependencies.bridgeOptions,
      { timeoutMs: phase === 'update' ? 630000 : 25000, maxOutputBytes: 4096 }))
    if (raw?.ok !== true) throw new Error(failureMessages[raw?.reason] || '无法确认 Codex 更新结果；原有连接未主动重启，请在主机上核对。')
    return { version: semver.parse(raw.version) }
  }
  async start(hostId: string, requestId: string): Promise<HostCodexUpdateStatus> {
    z.string().uuid().parse(requestId)
    const { host, bridge } = this.target(hostId)
    const key = JSON.stringify([hostId, requestId])
    const repeated = this.operations.find(entry => entry.hostId === hostId && entry.id === requestId)
    if (repeated) {
      // A concurrent duplicate must not acknowledge an in-memory receipt whose
      // first durable write could still fail.
      await this.receipts.get(key)
      return { ...this.status(hostId), operation: structuredClone(repeated) }
    }
    const status = this.status(hostId)
    if (!status.canUpdate) throw busy(status.disabledReason!)
    if (!bridge) throw busy('请先连接此主机的 Codex。')
    // Never evict receipts by age: an old browser can explicitly retry the same
    // ID after being offline. A full journal must fail visibly rather than
    // replaying an operation whose acknowledgement was lost.
    if (this.operations.length >= 512) throw busy('Codex 更新记录已达上限，请稍后重试。')
    const operation: HostCodexUpdateOperation = { id: requestId, hostId, state: 'checking', startedAt: this.now(), updatedAt: this.now(), message: '正在核对活动任务和当前版本…' }
    this.operations.push(operation)
    let release!: () => void
    let authorized = false
    const committed = new Promise<void>(resolve => { release = resolve })
    const task = committed.then(async () => {
      if (!authorized) return
      try {
        await this.dependencies.withRuntimeMaintenance(hostId, () => bridge.reconnect(async () => {
          if (this.dependencies.getHost(hostId) !== host) throw busy('主机配置已改变，请重新确认后更新。')
          const before = await this.execute(host, 'version', bridge.codexHome)
          operation.beforeVersion = semver.parse(before.version)
          await this.update(operation, 'updating', '正在执行 codex update…')
          const installed = await this.execute(host, 'update', bridge.codexHome)
          operation.installedVersion = semver.parse(installed.version)
          if (this.dependencies.getHost(hostId) !== host) throw busy('主机配置已改变，更新结果待核对；未继续重启。')
          await this.update(operation, 'restarting', '安装版本已确认，正在重启 Codex 连接…')
        }, { checkQueuedInputs: true }))
        const runtimeVersion = codexVersion(bridge.userAgent)
        operation.runtimeVersion = runtimeVersion
        if (!runtimeVersion || runtimeVersion !== operation.installedVersion) throw new Error('安装已更新，但运行版本未能与安装版本一致；请核对 Codex 路径并重新连接。')
        operation.finishedAt = this.now()
        await this.update(operation, 'completed', `Codex ${runtimeVersion} 已运行，模型与配置将重新读取。`)
      } catch (error) {
        operation.finishedAt = this.now(); operation.state = 'failed'; operation.updatedAt = this.now()
        operation.error = error instanceof Error && error.message.length <= 512 ? error.message : '更新或重启失败，请刷新主机版本后核对。'
        await this.persist().catch(() => {})
      }
    }).finally(() => { if (this.active.get(hostId) === task) this.active.delete(hostId) })
    this.active.set(hostId, task)
    const receipt = this.persist()
    this.receipts.set(key, receipt)
    try { await receipt; authorized = true }
    catch (error) { this.operations = this.operations.filter(entry => entry !== operation); this.active.delete(hostId); throw error }
    finally { this.receipts.delete(key); release() }
    return this.status(hostId)
  }
  private async update(operation: HostCodexUpdateOperation, state: HostCodexUpdateOperation['state'], message: string) {
    operation.state = state; operation.message = message; operation.updatedAt = this.now(); await this.persist()
  }
  async close() { this.closed = true; await Promise.allSettled([...this.active.values()]); await this.writes }
}
export async function registerHostCodexUpdates(app: Express, dataDir: string, dependencies: Dependencies) {
  const updates = new HostCodexUpdates(dataDir, dependencies); await updates.init()
  const route = (handler: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next) }
  app.get('/api/hosts/:id/codex-update', route((req, res) => { res.json(updates.status(String(req.params.id))) }))
  app.post('/api/hosts/:id/codex-update', route(async (req, res) => {
    const { requestId } = z.object({ requestId: z.string().uuid() }).strict().parse(req.body)
    res.status(202).json(await updates.start(String(req.params.id), requestId))
  }))
  return updates
}
