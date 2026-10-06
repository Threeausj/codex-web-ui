import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { Host, Project } from './types.js'

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
const connectionFields = ['hostname', 'username', 'port', 'identityFile', 'codexPath', 'cwd'] as const

export async function writePrivateJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.chmod(path.dirname(file), 0o700)
  const temporary = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, file)
  await fs.chmod(file, 0o600)
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export class Storage {
  hosts: Host[] = [{ id: 'local', name: '本机', kind: 'local' }]
  private webProjects: (Project & { hidden?: boolean })[] = []
  private hostWrites: Promise<unknown> = Promise.resolve()
  private projectWrites: Promise<unknown> = Promise.resolve()
  constructor(readonly dataDir: string, readonly codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), readonly cwd = process.cwd()) {}

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    await fs.chmod(this.dataDir, 0o700)
    const hosts = await readJson(path.join(this.dataDir, 'hosts.json'))
    if (Array.isArray(hosts)) {
      for (const host of hosts) {
        const validated = hostInput.safeParse(host && typeof host === 'object' ? Object.fromEntries(Object.entries(host).filter(([k]) => k !== 'id' && k !== 'kind')) : null)
        if (validated.success && typeof host.id === 'string' && /^ssh-[a-f0-9-]+$/.test(host.id)) this.hosts.push({ ...validated.data, id: host.id, kind: 'ssh' })
      }
    }
    const projects = await readJson(path.join(this.dataDir, 'projects.json'))
    if (Array.isArray(projects)) this.webProjects = projects.filter(p => p && typeof p.id === 'string' && typeof p.path === 'string' && typeof p.name === 'string' && typeof p.hostId === 'string').map(p => ({ ...p, source: 'web' }))
  }

  host(id: string) { return this.hosts.find(h => h.id === id) }

  async addHost(input: unknown) {
    const fields = hostInput.parse(input)
    return this.mutateHosts(async () => {
      const host: Host = { ...fields, id: `ssh-${randomUUID()}`, kind: 'ssh' }
      const hosts = [...this.hosts, host]
      await this.saveHosts(hosts)
      this.hosts = hosts
      return host
    })
  }

  async updateHost(id: string, input: unknown) {
    const fields = hostUpdateInput.parse(input)
    return this.mutateHosts(async () => {
      const current = this.host(id)
      if (!current) throw Object.assign(new Error('Host not found'), { status: 404 })
      if (current.kind !== 'ssh') throw Object.assign(new Error('Only SSH hosts can be edited'), { status: 400 })
      const host: Host = { ...current, ...fields }
      for (const key of connectionFields) if (host[key] === undefined) delete host[key]
      const connectionReset = connectionFields.some(key => current[key] !== host[key])
      const hosts = this.hosts.map(value => value.id === id ? host : value)
      await this.saveHosts(hosts)
      this.hosts = hosts
      return { host, connectionReset }
    })
  }

  async deleteHost(id: string) {
    return this.mutateHosts(async () => {
      if (id === 'local') throw Object.assign(new Error('The local host cannot be removed'), { status: 400 })
      if (!this.host(id)) throw Object.assign(new Error('Host not found'), { status: 404 })
      const hosts = this.hosts.filter(h => h.id !== id)
      const projects = this.webProjects.filter(p => p.hostId !== id)
      await this.saveHosts(hosts)
      await writePrivateJson(path.join(this.dataDir, 'projects.json'), projects)
      this.hosts = hosts
      this.webProjects = projects
    })
  }

  private saveHosts(hosts = this.hosts) { return writePrivateJson(path.join(this.dataDir, 'hosts.json'), hosts.filter(h => h.kind === 'ssh')) }
  private mutateHosts<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.hostWrites.then(work)
    this.hostWrites = pending.catch(() => {})
    return pending
  }

  async projects(): Promise<Project[]> {
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
    return [...unique.values()].filter(project => !project.hidden)
  }

  async addProject(hostId: string, projectPath: string, name?: string, rootPaths?: string[]) {
    return this.mutateProjects(async () => {
      const project: Project = { id: `web-${randomUUID()}`, name: name || path.posix.basename(projectPath), path: projectPath, rootPaths: [...new Set([projectPath, ...(rootPaths || [])])], hostId, source: 'web' }
      await this.persistProject(project)
      return project
    })
  }

  async updateProject(hostId: string, projectPath: string, fields: { name?: string; rootPaths?: string[] }) {
    return this.mutateProjects(async () => {
      const current = (await this.projects()).find(project => project.hostId === hostId && project.path === projectPath)
      if (!current) throw Object.assign(new Error('Project not found'), { status: 404 })
      const project: Project = { ...current, ...fields, rootPaths: [...new Set([projectPath, ...(fields.rootPaths ?? current.rootPaths ?? [])])], source: 'web' }
      await this.persistProject(project)
      return project
    })
  }

  async removeProject(hostId: string, projectPath: string) {
    return this.mutateProjects(async () => {
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

  private mutateProjects<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.projectWrites.then(work)
    this.projectWrites = pending.catch(() => {})
    return pending
  }
}
