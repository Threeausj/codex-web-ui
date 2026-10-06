import { execFile } from 'node:child_process'
import { createHash, ECDH, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Host } from './types.js'

const runFile = promisify(execFile)
const maximumOutput = 64 * 1024
const keyTypes = new Set(['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'])

export class SSHHostKeyError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'SSHHostKeyError' }
}

export type SSHKeyFingerprint = { type: string; fingerprint: string }
export type SSHHostKeyPin = { file: string; hostKeyAlias: string }
type PublicKey = SSHKeyFingerprint & { blob: string }
export type ResolvedSSHHost = {
  hostname: string
  port: number
  lookupName: string
  username: string
  externalKnownHostsFiles: string[]
  scanUnsupportedReason?: string
  externalKnownHostsUnavailableReason?: string
}
export type SSHHostKeyInspection = {
  hostname: string
  port: number
  lookupName: string
  status: 'unknown' | 'trusted' | 'changed'
  keys: SSHKeyFingerprint[]
  previousFingerprints: SSHKeyFingerprint[]
  challenge?: string
  expiresAt?: number
}
type Challenge = {
  draft: string
  owner: string
  target: ResolvedSSHHost
  keys: PublicKey[]
  previous: PublicKey[]
  expiresAt: number
  result?: SSHHostKeyInspection
}
export type SSHHostKeyServiceOptions = {
  dataDir: string
  externalKnownHostsFiles?: string[]
  scan?: (target: ResolvedSSHHost) => Promise<string>
  resolve?: (host: Host) => Promise<ResolvedSSHHost>
  now?: () => number
  challengeTtlMs?: number
}

function normalizeHostname(value: string | undefined) {
  const hostname = value?.trim().replace(/^\[([^\]]+)\]$/, '$1').toLowerCase() || ''
  // Apart from option injection, whitespace/commas would change ssh-keyscan's
  // address/alias syntax and the scope of a known_hosts entry.
  if (!hostname || hostname.length > 253 || !(
    isIP(hostname) && !hostname.includes('%')
    || /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_.])?$/.test(hostname)
  )) throw new SSHHostKeyError(400, '请输入有效的 SSH 主机名或 IP 地址。')
  return hostname
}

function normalizeHost(host: Host) {
  const hostname = normalizeHostname(host.hostname)
  const port = host.port ?? 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SSHHostKeyError(400, 'SSH 端口必须在 1 至 65535 之间。')
  const username = host.username?.trim() || ''
  if (username && (!/^[a-zA-Z0-9_.-]+$/.test(username) || username.startsWith('-'))) {
    throw new SSHHostKeyError(400, '请输入有效的 SSH 用户名。')
  }
  return { hostname, port, username }
}

function lookupName(hostname: string, port: number) { return port === 22 ? hostname : `[${hostname}]:${port}` }
function descriptors(keys: PublicKey[]): SSHKeyFingerprint[] { return keys.map(({ type, fingerprint }) => ({ type, fingerprint })) }
function signature(keys: PublicKey[]) { return keys.map(key => `${key.type} ${key.blob}`).sort().join('\n') }
function targetSignature(target: ResolvedSSHHost) { return JSON.stringify(target) }

/** Validate the SSH wire representation before fingerprinting or persisting it. */
function parseKey(type: string, blob: string): PublicKey | undefined {
  if (!keyTypes.has(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob) || blob.length > 16384) return undefined
  const bytes = Buffer.from(blob, 'base64')
  if (bytes.toString('base64').replace(/=+$/, '') !== blob.replace(/=+$/, '')) return undefined
  const fields: Buffer[] = []
  let offset = 0
  while (offset < bytes.length && fields.length < 4) {
    if (offset + 4 > bytes.length) return undefined
    const length = bytes.readUInt32BE(offset); offset += 4
    if (!length || offset + length > bytes.length) return undefined
    fields.push(bytes.subarray(offset, offset + length)); offset += length
  }
  if (offset !== bytes.length || !fields[0]?.equals(Buffer.from(type))) return undefined
  if (type === 'ssh-ed25519') {
    if (fields.length !== 2 || fields[1].length !== 32) return undefined
  } else if (type === 'ssh-rsa') {
    if (fields.length !== 3 || fields[1].length > 8 || fields[2].length < 64 || fields[2].length > 1025) return undefined
    for (const number of fields.slice(1)) {
      if (number[0] & 0x80 || number.every(byte => !byte) || number.length > 1 && number[0] === 0 && !(number[1] & 0x80)) return undefined
    }
  } else {
    const curve = type.slice('ecdsa-sha2-'.length)
    const curves: Record<string, { curve: string; length: number }> = {
      nistp256: { curve: 'prime256v1', length: 65 }, nistp384: { curve: 'secp384r1', length: 97 }, nistp521: { curve: 'secp521r1', length: 133 },
    }
    const expected = curves[curve]
    if (fields.length !== 3 || !fields[1].equals(Buffer.from(curve)) || fields[2].length !== expected.length || fields[2][0] !== 4) return undefined
    try { ECDH.convertKey(fields[2], expected.curve, undefined, undefined, 'uncompressed') } catch { return undefined }
  }
  return { type, blob: bytes.toString('base64'), fingerprint: `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}` }
}

function scannedKeys(output: string, target: ResolvedSSHHost) {
  if (Buffer.byteLength(output) > maximumOutput) throw new SSHHostKeyError(502, '服务器返回的 SSH 主机密钥过多。')
  const expected = lookupName(target.hostname, target.port)
  const keys = new Map<string, PublicKey>()
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    if (fields.length !== 3 || fields[0].toLowerCase() !== expected.toLowerCase()) throw new SSHHostKeyError(502, 'SSH 主机密钥扫描结果无效，请重新获取。')
    const key = parseKey(fields[1], fields[2])
    if (!key) throw new SSHHostKeyError(502, 'SSH 主机返回了无效的公钥。')
    keys.set(`${key.type} ${key.blob}`, key)
    if (keys.size > 12) throw new SSHHostKeyError(502, '服务器返回的 SSH 主机密钥过多。')
  }
  if (!keys.size) throw new SSHHostKeyError(502, '未获取到 SSH 主机密钥，请检查地址、端口和网络连接。')
  return [...keys.values()].sort((a, b) => a.type.localeCompare(b.type) || a.blob.localeCompare(b.blob))
}

function compareKeys(keys: PublicKey[], previous: PublicKey[]): SSHHostKeyInspection['status'] {
  if (!previous.length) return 'unknown'
  const matches = keys.some(key => previous.some(old => old.type === key.type && old.blob === key.blob))
  const changedAlgorithm = keys.some(key => previous.some(old => old.type === key.type) && !previous.some(old => old.type === key.type && old.blob === key.blob))
  return matches && !changedAlgorithm ? 'trusted' : 'changed'
}

async function knownHostsPaths(values: string[]) {
  const unavailable = '此 SSH known_hosts 路径无法安全解析，请使用不含空格的绝对路径后再获取指纹。'
  const files: string[] = []
  let totalTokens = 0
  let pathChecks = 0
  for (const value of values) {
    // ssh -G expands tilde, SSH tokens and environment variables, then joins
    // paths without quoting. A relative fragment can be a lost part of a
    // quoted path, so it must never silently become a separate known_hosts.
    const tokens = value.split(/\s+/).filter(Boolean)
    totalTokens += tokens.length
    if (/^\s|\s$/.test(value) || totalTokens > 16 || tokens.some(token => Buffer.byteLength(token) > 4096 || token !== 'none' && !path.isAbsolute(token))) return { files: [], unavailable }
    for (let first = 0; first < tokens.length; first++) {
      for (let last = first + 1; last < tokens.length; last++) {
        const joined = tokens.slice(first, last + 1).join(' ')
        if (++pathChecks > 120 || Buffer.byteLength(joined) > 4096) return { files: [], unavailable }
        // A space-containing absolute path whose later fragments also begin
        // with '/' looks exactly like several ordinary filenames in ssh -G.
        // Existing joined files disambiguate this case without reading them.
        try { await lstat(joined); return { files: [], unavailable } }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return { files: [], unavailable } }
      }
    }
    files.push(...tokens.filter(token => token !== 'none' && token !== '/dev/null'))
  }
  return { files: [...new Set(files)], unavailable: undefined }
}

export async function resolveSSHHost(host: Host, sshConfigFile?: string): Promise<ResolvedSSHHost> {
  const requested = normalizeHost(host)
  const args = ['-G', '-o', 'BatchMode=yes']
  if (sshConfigFile) args.push('-F', sshConfigFile)
  // An omitted port must preserve a configured Host alias's Port.
  if (host.port != null) args.push('-p', String(requested.port))
  args.push('--', `${requested.username ? `${requested.username}@` : ''}${requested.hostname}`)
  let output: string
  try { output = (await runFile('ssh', args, { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, encoding: 'utf8' })).stdout }
  catch { throw new SSHHostKeyError(502, '无法读取 SSH 连接配置，请检查服务器上的 SSH 安装与配置。') }
  const config = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const space = line.indexOf(' ')
    if (space > 0) config.set(line.slice(0, space), line.slice(space + 1))
  }
  let scanUnsupportedReason = ['proxyjump', 'proxycommand'].some(key => config.has(key) && config.get(key) !== 'none')
    ? '此 SSH 配置通过跳板机或代理连接，暂不支持直接扫描指纹。请先在服务器终端确认并信任主机密钥。'
    : config.has('knownhostscommand') && config.get('knownhostscommand') !== 'none'
      ? '此 SSH 配置使用动态 KnownHostsCommand，暂不支持在网页中管理指纹。' : undefined
  const resolved = normalizeHost({ ...host, hostname: config.get('hostname'), port: Number(config.get('port')), username: config.get('user') })
  const alias = config.get('hostkeyalias') || ''
  if (alias && (!/^[A-Za-z0-9_.:[\]-]+$/.test(alias) || alias.startsWith('-'))) throw new SSHHostKeyError(400, 'SSH HostKeyAlias 无效，无法安全保存主机指纹。')
  const fileValues = [config.get('userknownhostsfile'), config.get('globalknownhostsfile')].filter((value): value is string => Boolean(value))
  const knownHosts = await knownHostsPaths(fileValues)
  scanUnsupportedReason ||= knownHosts.unavailable
  return { ...resolved, lookupName: alias || lookupName(resolved.hostname, resolved.port), externalKnownHostsFiles: knownHosts.files, scanUnsupportedReason, externalKnownHostsUnavailableReason: knownHosts.unavailable }
}

async function scanHost(target: ResolvedSSHHost) {
  try {
    return (await runFile('ssh-keyscan', ['-T', '5', '-p', String(target.port), '-t', 'ed25519,ecdsa,rsa', '--', target.hostname], {
      timeout: 12000, killSignal: 'SIGKILL', maxBuffer: maximumOutput, encoding: 'utf8',
    })).stdout
  } catch (error) {
    const failure = error as { killed?: boolean; code?: string; stdout?: string }
    // Some algorithms can fail even when a usable key was scanned.
    if (failure.stdout?.trim() && !failure.killed && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return failure.stdout
    if (failure.killed) throw new SSHHostKeyError(504, '获取 SSH 主机指纹超时，请检查网络连接后重试。')
    if (failure.code === 'ENOENT') throw new SSHHostKeyError(502, '服务器未安装 ssh-keyscan，无法获取 SSH 主机指纹。')
    throw new SSHHostKeyError(502, '未获取到 SSH 主机密钥，请检查地址、端口和网络连接。')
  }
}

export class SSHHostKeyService {
  readonly knownHostsFile: string
  private readonly challenges = new Map<string, Challenge>()
  private readonly scan: (target: ResolvedSSHHost) => Promise<string>
  private readonly resolve: (host: Host) => Promise<ResolvedSSHHost>
  private readonly now: () => number
  private readonly ttl: number
  private activeScans = 0
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: SSHHostKeyServiceOptions) {
    this.knownHostsFile = path.join(options.dataDir, 'ssh', 'known_hosts')
    this.scan = options.scan ?? scanHost
    this.resolve = options.resolve ?? resolveSSHHost
    this.now = options.now ?? Date.now
    this.ttl = options.challengeTtlMs ?? 120_000
  }

  private async target(host: Host) {
    const requested = normalizeHost(host)
    const target = await this.resolve({ ...host, hostname: requested.hostname, username: host.username?.trim() })
    normalizeHost({ ...host, hostname: target.hostname, port: target.port, username: target.username })
    if (!target.lookupName || /[\s,\x00-\x1f\x7f]/.test(target.lookupName)) throw new SSHHostKeyError(400, 'SSH 主机密钥名称无效。')
    return { ...target, externalKnownHostsFiles: this.options.externalKnownHostsFiles ?? target.externalKnownHostsFiles }
  }

  private async getKeys(target: ResolvedSSHHost) {
    if (target.scanUnsupportedReason) throw new SSHHostKeyError(400, target.scanUnsupportedReason)
    if (this.activeScans >= 4) throw new SSHHostKeyError(429, '当前获取指纹的请求较多，请稍后重试。')
    this.activeScans++
    try { return scannedKeys(await this.scan(target), target) } finally { this.activeScans-- }
  }

  private prune() {
    for (const [token, item] of this.challenges) if (item.expiresAt <= this.now()) this.challenges.delete(token)
    while (this.challenges.size >= 128) this.challenges.delete(this.challenges.keys().next().value!)
  }

  private async keysFromFile(file: string, name: string): Promise<PublicKey[]> {
    let managedContents: string | undefined
    try {
      const stat = await lstat(file)
      if (file === this.knownHostsFile && stat.isSymbolicLink()) throw new SSHHostKeyError(409, 'SSH 指纹文件不能是符号链接。')
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new SSHHostKeyError(502, 'SSH known_hosts 必须是普通文件。')
      if (file === this.knownHostsFile) {
        if (stat.size > 2 * 1024 * 1024) throw new SSHHostKeyError(502, 'SSH 指纹文件过大，无法安全读取。')
        managedContents = await readFile(file, 'utf8')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (managedContents !== undefined) {
      const keys: PublicKey[] = []
      for (const raw of managedContents.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const fields = line.split(/\s+/)
        const key = fields.length === 3 ? parseKey(fields[1], fields[2]) : undefined
        if (!key || !/^[A-Za-z0-9_.:[\]-]+$/.test(fields[0])) throw new SSHHostKeyError(409, '已保存的 SSH 主机密钥记录损坏，请检查指纹文件。')
        if (fields[0].toLowerCase() === name.toLowerCase()) keys.push(key)
      }
      return keys
    }
    let output: string
    try { output = (await runFile('ssh-keygen', ['-F', name, '-f', file], { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: maximumOutput, encoding: 'utf8' })).stdout }
    catch (error) {
      if ((error as { code?: number }).code === 1) return []
      throw new SSHHostKeyError(502, '无法读取已保存的 SSH 主机指纹。')
    }
    const keys: PublicKey[] = []
    for (const raw of output.split(/\r?\n/)) {
      const fields = raw.trim().split(/\s+/)
      if (fields[0]?.startsWith('#') || fields.length < 3) continue
      if (fields[0] === '@revoked') throw new SSHHostKeyError(409, '此 SSH 主机存在已撤销的密钥记录，请先在服务器终端处理撤销记录。')
      if (fields[0]?.startsWith('@')) continue
      const key = parseKey(fields[1], fields[2])
      if (!key && file === this.knownHostsFile) throw new SSHHostKeyError(409, '已保存的 SSH 主机密钥记录损坏，请检查指纹文件。')
      if (key) keys.push(key)
    }
    return keys
  }

  private async priorKeys(target: ResolvedSSHHost) {
    // Once the user pins an endpoint, external trust cannot revive an old key.
    const managed = await this.keysFromFile(this.knownHostsFile, target.lookupName)
    const keys: PublicKey[] = []
    for (const file of target.externalKnownHostsFiles) if (file !== this.knownHostsFile) keys.push(...await this.keysFromFile(file, target.lookupName))
    if (managed.length) return managed
    return [...new Map(keys.map(key => [`${key.type} ${key.blob}`, key])).values()].sort((a, b) => a.type.localeCompare(b.type) || a.blob.localeCompare(b.blob))
  }

  /** Exact aliases also disable OpenSSH's non-default-port hostname fallback. */
  async connectionKnownHosts(host: Host): Promise<SSHHostKeyPin | undefined> {
    try { await lstat(this.knownHostsFile) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const target = await this.target(host)
    const managed = await this.keysFromFile(this.knownHostsFile, target.lookupName)
    if (!managed.length) return undefined
    if (target.externalKnownHostsUnavailableReason) throw new SSHHostKeyError(400, target.externalKnownHostsUnavailableReason)
    // Disabling external trust must not silently bypass an explicit revocation.
    for (const file of target.externalKnownHostsFiles) if (file !== this.knownHostsFile) await this.keysFromFile(file, target.lookupName)
    return { file: this.knownHostsFile, hostKeyAlias: target.lookupName }
  }

  /** Compatibility helper for callers that only need the managed file path. */
  async connectionKnownHostsFile(host: Host) {
    return (await this.connectionKnownHosts(host))?.file
  }

  async inspect(host: Host, owner = ''): Promise<SSHHostKeyInspection> {
    const target = await this.target(host)
    const keys = await this.getKeys(target)
    const previous = await this.priorKeys(target)
    const challenge = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + this.ttl
    this.prune()
    this.challenges.set(challenge, { draft: JSON.stringify(normalizeHost(host)), owner, target, keys, previous, expiresAt })
    return { hostname: target.hostname, port: target.port, lookupName: target.lookupName, status: compareKeys(keys, previous), keys: descriptors(keys), previousFingerprints: descriptors(previous), challenge, expiresAt }
  }

  async trust(host: Host, token: string, replace = false, owner = ''): Promise<SSHHostKeyInspection> {
    const challenge = this.challenges.get(token)
    if (!challenge || challenge.expiresAt <= this.now()) throw new SSHHostKeyError(409, '主机指纹确认已过期，请重新获取。')
    if (challenge.owner !== owner || challenge.draft !== JSON.stringify(normalizeHost(host))) throw new SSHHostKeyError(409, 'SSH 地址已变更，请重新获取指纹。')
    const target = await this.target(host)
    if (targetSignature(target) !== targetSignature(challenge.target)) throw new SSHHostKeyError(409, 'SSH 连接配置已变更，请重新获取指纹。')
    if (challenge.result) return challenge.result
    if (compareKeys(challenge.keys, challenge.previous) === 'changed' && !replace) throw new SSHHostKeyError(409, 'SSH 主机密钥已变更，需要明确确认替换后才能连接。')
    const freshKeys = await this.getKeys(target)
    if (signature(freshKeys) !== signature(challenge.keys)) throw new SSHHostKeyError(409, 'SSH 主机密钥在确认期间发生变化，请重新获取指纹。')
    const write = this.writes.catch(() => undefined).then(async () => {
      if (challenge.result) return challenge.result
      if (challenge.expiresAt <= this.now()) throw new SSHHostKeyError(409, '主机指纹确认已过期，请重新获取。')
      const previous = await this.priorKeys(target)
      if (signature(previous) !== signature(challenge.previous)) throw new SSHHostKeyError(409, '已保存的 SSH 指纹发生变化，请重新获取后确认。')
      await this.persist(target.lookupName, freshKeys)
      const result: SSHHostKeyInspection = { hostname: target.hostname, port: target.port, lookupName: target.lookupName, status: 'trusted', keys: descriptors(freshKeys), previousFingerprints: descriptors(previous) }
      challenge.result = result
      return result
    })
    this.writes = write
    return write
  }

  private async persist(name: string, keys: PublicKey[]) {
    const directory = path.dirname(this.knownHostsFile)
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 })
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const parent of [this.options.dataDir, directory]) {
      if ((await lstat(parent)).isSymbolicLink()) throw new SSHHostKeyError(409, 'SSH 指纹目录不能是符号链接。')
      await chmod(parent, 0o700)
    }
    let content = ''
    try {
      if (!(await lstat(this.knownHostsFile)).isFile()) throw new SSHHostKeyError(409, 'SSH 指纹文件不能是符号链接。')
      content = await readFile(this.knownHostsFile, 'utf8')
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new SSHHostKeyError(502, 'SSH 指纹文件过大，无法安全更新。')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // This file is exclusively managed here: exact endpoint entries only, never
    // wildcard patterns or aliases supplied by an untrusted scan response.
    const kept = content.split(/\r?\n/).filter(line => line.trim() && line.trim().split(/\s+/)[0].toLowerCase() !== name.toLowerCase())
    const next = [...kept, ...keys.map(key => `${name} ${key.type} ${key.blob}`)].join('\n') + '\n'
    const temporary = `${this.knownHostsFile}.${randomBytes(12).toString('hex')}.tmp`
    try {
      await writeFile(temporary, next, { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.knownHostsFile)
      await chmod(this.knownHostsFile, 0o600)
    } finally { await rm(temporary, { force: true }) }
  }
}
