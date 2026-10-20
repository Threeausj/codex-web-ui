import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { Host, Project } from './types.js'
import { orderHosts } from '../shared/host-order.js'
import { orderProjects, projectOrderKey, type ProjectOrderEntry } from '../shared/project-order.js'

const cleanText = z.string().trim().min(1).max(256).refine(s => !/[\x00-\x1f]/.test(s), 'Control characters are not allowed')
const optionalField = <T extends z.ZodType>(schema: T) => z.preprocess(value => value === null || (typeof value === 'string' && !value.trim()) ? undefined : value, schema.optional())
const validUsername = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/
function sshAddress(value: string) {
  const parts = value.split('@')
  const username = parts.length === 2 ? parts[0] : undefined
  const destination = parts.at(-1) || ''
  const hostname = destination.startsWith('[') && destination.endsWith(']') ? destination.slice(1, -1) : destination
  const valid = parts.length <= 2 && (!username || (username.length <= 64 && validUsername.test(username))) && hostname.length <= 253 && (isIP(hostname) !== 0 || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(hostname)) && (parts.length === 1 || !!username)
  return { username, hostname, valid }
}
const hostFields = z.object({
  name: cleanText,
  hostname: z.string().trim().min(1, '请输入主机名').max(320).refine(value => sshAddress(value).valid, '请输入主机名、SSH 别名或 user@host；端口请填写在 SSH 端口栏'),
  username: optionalField(z.string().trim().min(1).max(64).regex(validUsername, 'SSH 用户名格式不正确')),
  port: optionalField(z.number().int().min(1).max(65535)),
  identityFile: optionalField(cleanText.refine(s => path.isAbsolute(s), 'Identity file must be absolute')),
  codexPath: optionalField(cleanText),
  cwd: optionalField(cleanText.refine(s => s.startsWith('/'), 'Remote directory must be absolute')),
}).strict()
function normalizeAddress<T extends { hostname?: string; username?: string }>(value: T, context: z.RefinementCtx): T {
  if (!value.hostname) return value
  const address = sshAddress(value.hostname)
  if (address.username && value.username && address.username !== value.username) {
    context.addIssue({ code: 'custom', path: ['hostname'], message: '主机名中的用户名与 SSH 用户名不一致' })
    return value
  }
  return { ...value, hostname: address.hostname, ...(address.username ? { username: address.username } : {}) }
}
export const hostInput = hostFields.transform(normalizeAddress)
export const hostUpdateInput = hostFields.partial().refine(value => Object.keys(value).length > 0, 'Provide at least one editable host field').transform(normalizeAddress)
const hostIdentifier = z.string().min(1).max(256).regex(/^(?:local|ssh-[a-f0-9-]+)$/)
const hostOrderDocument = (maximum: number) => z.object({
  hostIds: z.array(hostIdentifier).min(1).max(maximum).refine(ids => new Set(ids).size === ids.length, 'Host IDs must be unique'),
}).strict()
export const hostOrderInput = hostOrderDocument(1000)
// The journal also retains the disabled local host's slot, outside the request's visible-host limit.
const savedHostOrderInput = hostOrderDocument(1001)
const projectOrderEntry = z.object({
  hostId: hostIdentifier,
  path: z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value)),
}).strict()
export const projectOrderInput = z.object({
  projects: z.array(projectOrderEntry).max(2000).refine(entries => new Set(entries.map(projectOrderKey)).size === entries.length, 'Project identities must be unique'),
}).strict()
const connectionFields = ['hostname', 'username', 'port', 'identityFile', 'codexPath', 'cwd'] as const

export async function writePrivateJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.chmod(path.dirname(file), 0o700)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await handle.sync()
    } finally { await handle.close() }
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export class Storage {
  private configuredHosts: Host[] = [{ id: 'local', name: '本机', kind: 'local' }]
  private hostOrder: string[] = []
  private hostOrderListeners = new Set<(hostIds: string[]) => void>()
  private projectOrder: ProjectOrderEntry[] = []
  private projectOrderListeners = new Set<(projects: ProjectOrderEntry[]) => void>()
  localEnabled = true
  get hosts() { return orderHosts(this.configuredHosts, this.hostOrder).filter(host => host.kind !== 'local' || this.localEnabled) }
  private webProjects: (Project & { hidden?: boolean })[] = []
  // Host deletion changes both collections, so they must share one write queue.
  private writes: Promise<unknown> = Promise.resolve()
  constructor(readonly dataDir: string, readonly codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), readonly cwd = process.cwd()) {}

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    await fs.chmod(this.dataDir, 0o700)
    const local = await readJson(path.join(this.dataDir, 'local-host.json'))
    if (local !== null) this.localEnabled = z.object({ enabled: z.boolean() }).strict().parse(local).enabled
    const hosts = await readJson(path.join(this.dataDir, 'hosts.json'))
    if (Array.isArray(hosts)) {
      for (const host of hosts) {
        const validated = hostInput.safeParse(host && typeof host === 'object' ? Object.fromEntries(Object.entries(host).filter(([k]) => k !== 'id' && k !== 'kind')) : null)
        if (validated.success && typeof host.id === 'string' && /^ssh-[a-f0-9-]+$/.test(host.id)) this.configuredHosts.push({ ...validated.data, id: host.id, kind: 'ssh' })
      }
    }
    let storedOrder: string | undefined
    try { storedOrder = await fs.readFile(path.join(this.dataDir, 'host-order.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (storedOrder !== undefined) this.hostOrder = savedHostOrderInput.parse(JSON.parse(storedOrder)).hostIds.filter(id => this.configuredHosts.some(host => host.id === id))
    const projects = await readJson(path.join(this.dataDir, 'projects.json'))
    if (Array.isArray(projects)) this.webProjects = projects.filter(p => p && typeof p.id === 'string' && typeof p.path === 'string' && typeof p.name === 'string' && typeof p.hostId === 'string' && this.configuredHosts.some(host => host.id === p.hostId)).map(p => ({ ...p, source: 'web' }))
    let projectOrder: string | undefined
    try { projectOrder = await fs.readFile(path.join(this.dataDir, 'project-order.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (projectOrder !== undefined) this.projectOrder = projectOrderInput.parse(JSON.parse(projectOrder)).projects
  }

  host(id: string) { return this.hosts.find(h => h.id === id) }

  subscribeHostOrder(listener: (hostIds: string[]) => void) {
    this.hostOrderListeners.add(listener)
    return () => { this.hostOrderListeners.delete(listener) }
  }

  subscribeProjectOrder(listener: (projects: ProjectOrderEntry[]) => void) {
    this.projectOrderListeners.add(listener)
    return () => { this.projectOrderListeners.delete(listener) }
  }

  /** Reorder presentation only. Validate the entire visible inventory inside
   * the same queue as project additions/removals and preserve hidden slots. */
  async reorderProjects(input: unknown) {
    const { projects: requested } = projectOrderInput.parse(input)
    return this.mutate(async () => {
      const inventory = orderProjects(await this.readProjects(), this.projectOrder)
      const visible = inventory.filter(project => !project.hidden && this.host(project.hostId))
      const keys = new Set(visible.map(projectOrderKey))
      if (requested.length !== keys.size || requested.some(project => !keys.has(projectOrderKey(project))))
        throw Object.assign(new Error('项目列表已变化，请刷新后重新排序'), { status: 409 })
      let next = 0
      const order = inventory.map(project => keys.has(projectOrderKey(project)) ? requested[next++]! : { hostId: project.hostId, path: project.path })
      // The same parser protects both wire input and the restart journal.
      projectOrderInput.parse({ projects: order })
      await writePrivateJson(path.join(this.dataDir, 'project-order.json'), { projects: order })
      this.projectOrder = order
      const projects = await this.projects()
      const identities = projects.map(({ hostId, path }) => ({ hostId, path }))
      for (const listener of this.projectOrderListeners) {
        try { listener(structuredClone(identities)) } catch { /* A consumer cannot undo a durable order. */ }
      }
      return projects
    })
  }

  /** Persist only presentation order; host configuration and runtimes stay intact. */
  async reorderHosts(input: unknown) {
    const { hostIds } = hostOrderInput.parse(input)
    return this.mutate(async () => {
      const enabled = new Set(this.hosts.map(host => host.id))
      if (hostIds.length !== enabled.size || hostIds.some(id => !enabled.has(id)))
        throw Object.assign(new Error('主机列表已变化，请刷新后重新排序'), { status: 409 })
      let next = 0
      // Disabled hosts retain their slot, so re-enabling local is predictable.
      const order = orderHosts(this.configuredHosts, this.hostOrder).map(host => enabled.has(host.id) ? hostIds[next++]! : host.id)
      await writePrivateJson(path.join(this.dataDir, 'host-order.json'), { hostIds: order })
      this.hostOrder = order
      for (const listener of this.hostOrderListeners) {
        try { listener(this.hosts.map(host => host.id)) } catch { /* One consumer must not undo a durable sort. */ }
      }
      return this.hosts
    })
  }

  /** Disconnecting the deployment machine is reversible; its project metadata
   * and Codex home remain intact while only executable hosts are exposed. */
  async setLocalEnabled(enabled: boolean) {
    return this.mutate(async () => {
      if (enabled === this.localEnabled) return
      await writePrivateJson(path.join(this.dataDir, 'local-host.json'), { enabled })
      this.localEnabled = enabled
    })
  }

  async addHost(input: unknown) {
    const fields = hostInput.parse(input)
    return this.mutate(async () => {
      const host: Host = { ...fields, id: `ssh-${randomUUID()}`, kind: 'ssh' }
      const hosts = [...this.configuredHosts, host]
      await this.saveHosts(hosts)
      this.configuredHosts = hosts
      return host
    })
  }

  async updateHost(id: string, input: unknown) {
    const fields = hostUpdateInput.parse(input)
    return this.mutate(async () => {
      const current = this.host(id)
      if (!current) throw Object.assign(new Error('Host not found'), { status: 404 })
      if (current.kind !== 'ssh') throw Object.assign(new Error('Only SSH hosts can be edited'), { status: 400 })
      const host: Host = { ...current, ...fields }
      for (const key of connectionFields) if (host[key] === undefined) delete host[key]
      const connectionReset = connectionFields.some(key => current[key] !== host[key])
      const hosts = this.configuredHosts.map(value => value.id === id ? host : value)
      await this.saveHosts(hosts)
      this.configuredHosts = hosts
      return { host, connectionReset }
    })
  }

  async deleteHost(id: string) {
    return this.mutate(async () => {
      if (id === 'local') throw Object.assign(new Error('The local host cannot be removed'), { status: 400 })
      if (!this.host(id)) throw Object.assign(new Error('Host not found'), { status: 404 })
      const hosts = this.configuredHosts.filter(h => h.id !== id)
      const projects = this.webProjects.filter(p => p.hostId !== id)
      await writePrivateJson(path.join(this.dataDir, 'projects.json'), projects)
      try { await this.saveHosts(hosts) } catch (error) {
        await writePrivateJson(path.join(this.dataDir, 'projects.json'), this.webProjects)
        throw error
      }
      this.configuredHosts = hosts
      this.webProjects = projects
    })
  }

  private saveHosts(hosts = this.configuredHosts) { return writePrivateJson(path.join(this.dataDir, 'hosts.json'), hosts.filter(h => h.kind === 'ssh')) }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(work)
    this.writes = pending.catch(() => {})
    return pending
  }

  async projects(): Promise<Project[]> {
    return orderProjects(await this.readProjects(), this.projectOrder).filter(project => !project.hidden && this.host(project.hostId))
  }

  private async readProjects(): Promise<(Project & { hidden?: boolean })[]> {
    const projects: Project[] = []
    // Read only project metadata. Desktop prompt history, auth and other persisted atoms never enter the web API.
    try {
      const state = await readJson(path.join(this.codexHome, '.codex-global-state.json')) as Record<string, unknown> | null
      const local = state?.['local-projects']
      const entries = Array.isArray(local) ? local : local && typeof local === 'object' ? Object.values(local) : []
      for (const item of entries) {
        if (!item || typeof item !== 'object') continue
        const p = item as Record<string, unknown>
        const roots = Array.isArray(p.rootPaths) ? p.rootPaths : []
        const validRoots = roots.filter((root): root is string => typeof root === 'string' && path.isAbsolute(root))
        if (validRoots.length) projects.push({ id: typeof p.id === 'string' ? p.id : `desktop:${validRoots[0]}`, name: typeof p.name === 'string' ? p.name : path.basename(validRoots[0]), path: validRoots[0], rootPaths: validRoots, hostId: 'local', source: 'desktop' })
      }
      const atoms = state?.['electron-persisted-atom-state'] as Record<string, unknown> | undefined
      for (const key of ['electron-saved-workspace-roots', 'saved-workspace-roots']) {
        const roots = atoms?.[key] ?? state?.[key]
        if (Array.isArray(roots)) for (const root of roots) if (typeof root === 'string' && path.isAbsolute(root)) projects.push({ id: `desktop:${root}`, name: path.basename(root), path: root, hostId: 'local', source: 'desktop' })
      }
    } catch { /* Missing/incompatible desktop metadata should not prevent web access. */ }
    if (!projects.some(p => p.path === this.cwd && p.hostId === 'local')) projects.push({ id: 'web:cwd', name: path.basename(this.cwd), path: this.cwd, hostId: 'local', source: 'web' })
    const unique = new Map<string, Project & { hidden?: boolean }>()
    for (const p of [...projects, ...this.webProjects]) unique.set(`${p.hostId}:${p.path}`, p)
    return [...unique.values()]
  }

  async addProject(hostId: string, projectPath: string, name?: string, rootPaths?: string[]) {
    return this.mutate(async () => {
      if (!this.host(hostId)) throw Object.assign(new Error('Host not found'), { status: 404 })
      const project: Project = { id: `web-${randomUUID()}`, name: name || path.posix.basename(projectPath), path: projectPath, rootPaths: [...new Set([projectPath, ...(rootPaths || [])])], hostId, source: 'web' }
      await this.persistProject(project)
      return project
    })
  }

  async updateProject(hostId: string, projectPath: string, fields: { name?: string; rootPaths?: string[] }) {
    return this.mutate(async () => {
      const current = (await this.projects()).find(project => project.hostId === hostId && project.path === projectPath)
      if (!current) throw Object.assign(new Error('Project not found'), { status: 404 })
      const project: Project = { ...current, ...fields, rootPaths: [...new Set([projectPath, ...(fields.rootPaths ?? current.rootPaths ?? [])])], source: 'web' }
      await this.persistProject(project)
      return project
    })
  }

  async removeProject(hostId: string, projectPath: string) {
    return this.mutate(async () => {
      const current = (await this.projects()).find(project => project.hostId === hostId && project.path === projectPath)
      if (!current) throw Object.assign(new Error('Project not found'), { status: 404 })
      // A Web-only tombstone also hides imported desktop projects on refresh.
      await this.persistProject({ ...current, source: 'web', hidden: true })
    })
  }

  private async persistProject(project: Project & { hidden?: boolean }) {
    const projects = [...this.webProjects.filter(value => value.hostId !== project.hostId || value.path !== project.path), project]
    await writePrivateJson(path.join(this.dataDir, 'projects.json'), projects)
    this.webProjects = projects
  }

}
