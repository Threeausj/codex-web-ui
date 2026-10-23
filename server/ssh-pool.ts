import { spawn, execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Host } from './types.js'
import type { SSHHostKeyPin } from './ssh-host-keys.js'
import { sshKnownHostsArgs, type SSHConnectionControl } from './ssh.js'

const execute = promisify(execFile)
type Master = { ready: Promise<void>; closed: Promise<void>; close(): void }
type Entry = {
  key: string; hostId: string; control: SSHConnectionControl; master: Promise<Master>;
  references: number; retired: boolean; stopping: boolean; rawMaster?: Master; lastUsed: number; timer?: ReturnType<typeof setTimeout>
}
export type SSHConnectionLease = { control: SSHConnectionControl; closed?: Promise<void>; release(): void }
export type SshLease = SSHConnectionLease
type PoolOptions = {
  idleMs?: number; maximumConnections?: number; directory?: string;
  /** Isolated test dependencies, never populated from HTTP input. */
  identity?: (host: Host, pin?: SSHHostKeyPin) => Promise<string>;
  start?: (host: Host, pin: SSHHostKeyPin | undefined, control: SSHConnectionControl) => Master;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function destination(host: Host) {
  if (host.kind !== 'ssh' || !host.hostname || !/^[a-zA-Z0-9_.:[\]-]+$/.test(host.hostname) || host.hostname.startsWith('-') ||
      host.username && (!/^[a-zA-Z0-9_.-]+$/.test(host.username) || host.username.startsWith('-')))
    throw new Error('SSH 主机配置无效')
  return `${host.username ? `${host.username}@` : ''}${host.hostname}`
}
function authenticationArgs(host: Host, pin?: SSHHostKeyPin) {
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', '-o', 'TCPKeepAlive=yes', '-o', 'LogLevel=ERROR',
    ...sshKnownHostsArgs(pin), ...(host.port ? ['-p', String(host.port)] : []), ...(host.identityFile ? ['-i', host.identityFile] : [])]
}
async function fileIdentity(file: string, required = false) {
  const expanded = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file
  try {
    const stat = await fs.stat(expanded)
    // Keys and known_hosts normally fit well below this bound. Metadata also
    // invalidates unusually large trusted configuration without reading it all.
    const content = stat.isFile() && stat.size <= 1024 * 1024 ? digest(await fs.readFile(expanded)) : ''
    return [expanded, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, content]
  } catch (error) {
    if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return [expanded, 'missing']
  }
}
/** Resolve ssh_config locally, without contacting or trusting a remote server. */
export async function sshConnectionIdentity(host: Host, pin?: SSHHostKeyPin) {
  const resolved = await execute('ssh', ['-G', ...authenticationArgs(host, pin), '--', destination(host)], {
    timeout: 5000, maxBuffer: 512 * 1024, encoding: 'utf8', windowsHide: true,
  })
  const files = new Set<string>([...(host.identityFile ? [host.identityFile] : []), ...(pin ? [pin.file] : [])])
  for (const line of resolved.stdout.split('\n')) {
    const [key, ...values] = line.split(' ')
    if (key === 'identityfile') files.add(values.join(' '))
    // A confirmed Web pin excludes external files. The unpinned legacy path
    // still fingerprints their contents so editing trust invalidates the pool.
    if (!pin && (key === 'userknownhostsfile' || key === 'globalknownhostsfile'))
      for (const value of values) if (value && value !== 'none') files.add(value)
  }
  const identities = await Promise.all([...files].sort().map(file => fileIdentity(file, file === pin?.file)))
  return digest(JSON.stringify([host.id, host.hostname, host.username, host.port, host.identityFile,
    pin?.hostKeyAlias, resolved.stdout, identities, process.env.SSH_AUTH_SOCK || '']))
}

function startMaster(host: Host, pin: SSHHostKeyPin | undefined, control: SSHConnectionControl): Master {
  // Command-line options are first-wins. Override the no-multiplexing fallback
  // before the common strict trust arguments, never through an external socket.
  const args = ['-M', '-N', '-T', '-o', `ControlPath=${control.socketPath}`, '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no',
    ...authenticationArgs(host, pin), '--', destination(host)]
  const child = spawn('ssh', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = '', exited = false, failure: Error | undefined
  const closed = new Promise<void>(resolve => {
    child.once('error', error => { failure = error; exited = true; resolve() })
    child.once('close', () => { exited = true; resolve() })
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096) })
  let forceClose: ReturnType<typeof setTimeout> | undefined
  void closed.then(() => clearTimeout(forceClose))
  const close = () => {
    child.kill('SIGTERM')
    if (!forceClose && !exited) { forceClose = setTimeout(() => child.kill('SIGKILL'), 1000); forceClose.unref() }
  }
  const ready = (async () => {
    const deadline = Date.now() + 16000
    while (!exited && Date.now() < deadline) {
      try {
        const stat = await fs.lstat(control.socketPath)
        if (stat.isSocket() && !stat.isSymbolicLink()) return
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    close()
    throw new Error(/host key|identification has changed/i.test(stderr) ? 'SSH 主机指纹校验失败，请确认服务器指纹后重试' :
      /permission denied|authentication failed/i.test(stderr) ? 'SSH 认证失败，请检查账户和私钥' :
      failure && (failure as NodeJS.ErrnoException).code === 'ENOENT' ? '服务端未安装 OpenSSH 客户端' : 'SSH 连接失败或超时，请检查主机网络和认证配置')
  })()
  return { ready, closed, close }
}

/** One strictly authenticated OpenSSH transport, with independent feature channels. */
export class SshConnectionPool {
  private entries = new Map<string, Entry>()
  private allEntries = new Set<Entry>()
  private hostEpochs = new Map<string, number>()
  private root?: Promise<string>
  private epoch = 0
  private closed = false
  private closing?: Promise<void>
  private background = new Map<string, { tail: Promise<unknown>; queued: number; failures: number; retryAt: number; cancelled: boolean }>()
  constructor(private readonly options: PoolOptions = {}) {}
  private directory() {
    return this.root ||= (async () => {
      const parent = this.options.directory || (os.tmpdir().length < 55 ? os.tmpdir() : '/tmp')
      const directory = await fs.mkdtemp(path.join(parent, 'cwssh-'))
      await fs.chmod(directory, 0o700)
      return directory
    })()
  }
  async acquire(host: Host, pin?: SSHHostKeyPin): Promise<SSHConnectionLease> {
    if (this.closed) throw new Error('SSH 连接池已关闭')
    const epoch = this.epoch
    const hostEpoch = this.hostEpochs.get(host.id) || 0
    const current = () => !this.closed && epoch === this.epoch && hostEpoch === (this.hostEpochs.get(host.id) || 0)
    const key = await (this.options.identity || sshConnectionIdentity)(host, pin)
    if (!current()) throw new Error('SSH 连接状态已变化，请重试')
    let entry = this.entries.get(key)
    if (entry?.retired) { this.entries.delete(key); entry = undefined }
    if (!entry) {
      // Configuration, credentials and trust changes get a new transport.
      // Existing channels may finish; new work can never attach to the old key.
      for (const previous of this.entries.values()) if (previous.hostId === host.id && previous.key !== key) {
        previous.retired = true
        if (!previous.references) this.retire(previous)
      }
      const control = { socketPath: path.join(await this.directory(), `${key.slice(0, 24)}-${randomBytes(4).toString('hex')}`) }
      if (!current()) throw new Error('SSH 连接状态已变化，请重试')
      // Another acquire may have awaited the same directory concurrently.
      entry = this.entries.get(key)
      if (!entry) {
        // Reserve capacity after the awaited directory creation. Distinct
        // simultaneous hosts must not all pass a pre-await size check.
        const available = [...this.allEntries.values()].filter(value => !value.stopping)
        if (available.length >= (this.options.maximumConnections ?? 32)) {
          const idle = available.filter(value => !value.references).sort((a, b) => a.lastUsed - b.lastUsed)[0]
          if (idle) this.retire(idle)
          else throw Object.assign(new Error('SSH 连接繁忙，请稍后重试'), { status: 429 })
        }
        entry = { key, hostId: host.id, control, references: 0, retired: false, stopping: false, lastUsed: Date.now(), master: Promise.resolve(null as never) }
        this.entries.set(key, entry)
        this.allEntries.add(entry)
        const created = entry
        created.master = Promise.resolve().then(() => {
          if (created.stopping || !current()) throw new Error('SSH 连接状态已变化，请重试')
          const master = (this.options.start || startMaster)(host, pin, control)
          created.rawMaster = master
          void master.closed.then(() => { if (this.entries.get(key) === created) this.entries.delete(key); this.allEntries.delete(created); clearTimeout(created.timer); created.retired = true; void fs.rm(control.socketPath, { force: true }).catch(() => {}) })
          return master.ready.then(() => master, error => { master.close(); if (this.entries.get(key) === created) this.entries.delete(key); throw error })
        }).catch(error => { if (this.entries.get(key) === created) this.entries.delete(key); if (!created.rawMaster) this.allEntries.delete(created); throw error })
      }
    }
    clearTimeout(entry.timer)
    ++entry.references
    let master: Master
    try { master = await entry.master } catch (error) { --entry.references; throw error }
    if (!current() || entry.retired) {
      --entry.references
      if (!entry.references) this.retire(entry)
      throw new Error('SSH 连接状态已变化，请重试')
    }
    entry.lastUsed = Date.now()
    let released = false
    return { control: entry.control, closed: master.closed, release: () => {
      if (released) return
      released = true
      entry!.references = Math.max(0, entry!.references - 1)
      entry!.lastUsed = Date.now()
      if (!entry!.references) {
        if (entry!.retired) this.retire(entry!)
        else { entry!.timer = setTimeout(() => this.retire(entry!), this.options.idleMs ?? 60000); entry!.timer.unref() }
      }
    } }
  }
  /** Background probes serialize per host; interactive channels bypass this queue. */
  async runBackground<T>(host: Host, operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('SSH 连接池已关闭')
    let queue = this.background.get(host.id)
    if (!queue) { queue = { tail: Promise.resolve(), queued: 0, failures: 0, retryAt: 0, cancelled: false }; this.background.set(host.id, queue) }
    if (queue.queued >= 8) throw Object.assign(new Error('主机后台采集繁忙，请稍后重试'), { status: 429 })
    const current = queue
    ++current.queued
    const pending = current.tail.then(async () => {
      if (current.cancelled) throw new Error('SSH 主机连接已关闭，后台采集已取消')
      if (Date.now() < current.retryAt) throw Object.assign(new Error('主机后台采集正在重试退避，请稍后刷新'), { status: 503, code: 'SSH_BACKGROUND_BACKOFF', retryAfterMs: current.retryAt - Date.now() })
      try { const value = await operation(); current.failures = 0; current.retryAt = 0; return value }
      catch (error) { current.failures++; current.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(current.failures, 5)); throw error }
    }).finally(() => { --current.queued })
    current.tail = pending.catch(() => {})
    return pending
  }
  private retire(entry: Entry) {
    entry.retired = true
    clearTimeout(entry.timer)
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    if (!entry.stopping) { entry.stopping = true; entry.rawMaster?.close() }
  }
  closeHost(hostId: string) {
    this.hostEpochs.set(hostId, (this.hostEpochs.get(hostId) || 0) + 1)
    for (const entry of this.allEntries) if (entry.hostId === hostId) this.retire(entry)
    const queue = this.background.get(hostId)
    if (queue) queue.cancelled = true
    this.background.delete(hostId)
  }
  close() {
    if (this.closing) return this.closing
    this.closed = true
    return this.closing = (async () => {
      ++this.epoch
      const entries = [...this.allEntries.values()]
      for (const entry of entries) this.retire(entry)
      for (const queue of this.background.values()) queue.cancelled = true
      this.background.clear()
      const directory = this.root; this.root = undefined
      await Promise.all(entries.map(entry => entry.master.then(master => master.closed).catch(() => {})))
      if (directory) await fs.rm(await directory, { recursive: true, force: true })
    })()
  }
  /** Counts only; never expose target addresses, keys, paths or credentials. */
  status() { return { transports: this.allEntries.size, leasedChannels: [...this.allEntries.values()].reduce((sum, entry) => sum + entry.references, 0) } }
}

export const sharedSshPool = new SshConnectionPool()
