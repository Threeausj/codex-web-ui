import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import type { Bridge } from './bridge.js'
import type { Storage } from './storage.js'
import type { Project } from './types.js'

export type NativeProjectResolution = { projectId: string | null; supported: boolean }
type Dependencies = {
  storage: Pick<Storage, 'host' | 'projects'>
  getBridge(hostId: string): Promise<Pick<Bridge, 'request'>>
}
const absoluteRoot = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value))
const nativeProject = z.object({ id: z.string().min(1).max(512), name: z.string(), roots: z.array(z.object({ path: absoluteRoot })) })
const projectPage = z.object({ data: z.array(nativeProject), nextCursor: z.string().min(1).max(4096).nullable() })
const normalizeRoot = (root: string) => path.posix.normalize(root).replace(/\/$/, '') || '/'
const normalizeRoots = (roots: string[]) => [...new Set(roots.map(normalizeRoot))].sort()
const rootsKey = (roots: string[]) => JSON.stringify(normalizeRoots(roots))

/** Unknown-method errors are the only safe compatibility fallback. A timeout,
 * bad schema or permission failure must not silently create an unassigned chat. */
export function nativeProjectsUnsupported(cause: unknown, method?: string) {
  const error = cause as { rpc?: { code?: unknown; message?: unknown }; code?: unknown; message?: unknown } | null
  const code = error?.rpc?.code ?? error?.code
  if (code === -32601) return true
  const message = error?.rpc?.message ?? error?.message
  // Older official CLIs deserialize the request enum before dispatch, reporting
  // unknown methods as InvalidRequest. Do not mistake a parameter enum failure
  // or an unrelated request's error for a missing project API.
  if (code === -32600 && typeof method === 'string' && typeof message === 'string' &&
    /^Invalid request: unknown variant `([^`]+)`, expected /.exec(message)?.[1] === method) return true
  return typeof message === 'string' && (
    /\b(?:unsupported|unknown|unrecognized|not implemented)\s+(?:rpc\s+)?method\b/i.test(message) ||
    /\bmethod\b[^\n]{0,120}\b(?:unsupported|not supported|not implemented)\b/i.test(message)
  )
}

/** Web project IDs are UI metadata, not app-server project identities. Resolve
 * against the selected host on every operation so desktop edits stay current. */
export class NativeProjects {
  private pending = new Map<string, Promise<NativeProjectResolution>>()
  private bindingRequests = new Map<string, Promise<{ supported: boolean; bindings: { path: string; projectId: string }[] }>>()
  constructor(private readonly dependencies: Dependencies) {}

  /** Read-only identity discovery for project grouping. Browsing must never
   * create a native project or change a thread's tool working directory. */
  async bindings(hostId: string): Promise<{ supported: boolean; bindings: { path: string; projectId: string }[] }> {
    if (!this.dependencies.storage.host(hostId)) throw Object.assign(new Error('主机不存在'), { status: 404 })
    const saved = (await this.dependencies.storage.projects()).filter(project => project.hostId === hostId)
    const key = JSON.stringify([hostId, saved.map(project => [project.id, project.path, project.name, project.rootPaths])])
    const previous = this.bindingRequests.get(key)
    if (previous) return previous
    const operation = (async () => {
      try {
        const bridge = await this.dependencies.getBridge(hostId)
        const projects = await this.readProjects(bridge)
        const bindings: { path: string; projectId: string }[] = []
        for (const project of saved) {
          const expected = rootsKey([project.path, ...(project.rootPaths || [])])
          const matches = projects.filter(entry => rootsKey(entry.roots.map(root => root.path)) === expected)
          const named = matches.filter(entry => entry.name.trim() === project.name.trim())
          const match = matches.length === 1 ? matches[0] : named.length === 1 ? named[0] : undefined
          if (match) bindings.push({ path: project.path, projectId: match.id })
        }
        return { supported: true, bindings }
      } catch (cause) {
        if (nativeProjectsUnsupported(cause, 'project/list')) return { supported: false, bindings: [] }
        if (cause instanceof z.ZodError) throw new Error('Codex 项目接口返回格式不兼容，请检查目标服务器的 Codex 版本')
        throw cause
      }
    })().finally(() => { if (this.bindingRequests.get(key) === operation) this.bindingRequests.delete(key) })
    this.bindingRequests.set(key, operation)
    return operation
  }

  private async readProjects(bridge: Pick<Bridge, 'request'>): Promise<z.infer<typeof nativeProject>[]> {
    const deadline = Date.now() + 15000
    const projects = new Map<string, z.infer<typeof nativeProject>>()
    const cursors = new Set<string>()
    let cursor: string | null = null
    do {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('读取 Codex 项目超时，请重试')
      const response = projectPage.parse(await bridge.request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) }, Math.min(15000, remaining)))
      for (const entry of response.data) projects.set(entry.id, entry)
      cursor = response.nextCursor
      if (cursor && cursors.has(cursor)) throw new Error('Codex 项目分页游标重复，无法确认项目归属')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return [...projects.values()]
  }

  /** Automation cwd can be a saved secondary root. Prefer an explicit primary
   * project, and never guess when several projects share the secondary root. */
  async resolveForCwd(hostId: string, cwd: string): Promise<NativeProjectResolution | null> {
    if (!this.dependencies.storage.host(hostId)) throw Object.assign(new Error('主机不存在'), { status: 404 })
    absoluteRoot.parse(cwd)
    const projects = (await this.dependencies.storage.projects()).filter(project => project.hostId === hostId)
    const primary = projects.find(project => project.path === cwd)
    if (primary) return this.resolve(hostId, primary.path)
    const secondary = projects.filter(project => (project.rootPaths || []).includes(cwd))
    if (secondary.length > 1) throw Object.assign(new Error('当前目录属于多个项目，请明确选择项目的主目录后重试'), { status: 409 })
    return secondary[0] ? this.resolve(hostId, secondary[0].path) : null
  }

  async resolve(hostId: string, projectPath: string): Promise<NativeProjectResolution> {
    if (!this.dependencies.storage.host(hostId)) throw Object.assign(new Error('主机不存在'), { status: 404 })
    const project = (await this.dependencies.storage.projects()).find(value => value.hostId === hostId && value.path === projectPath)
    if (!project) throw Object.assign(new Error('项目不存在，请刷新项目列表后重试'), { status: 404 })
    const savedRoots = [project.path, ...(project.rootPaths || [])]
    for (const root of savedRoots) absoluteRoot.parse(root)
    const roots = normalizeRoots(savedRoots)
    const key = JSON.stringify([hostId, project.id, roots, project.name])
    const previous = this.pending.get(key)
    if (previous) return previous
    const operation = this.resolveProject(project, roots).finally(() => {
      if (this.pending.get(key) === operation) this.pending.delete(key)
    })
    this.pending.set(key, operation)
    return operation
  }

  private async resolveProject(project: Project, roots: string[]): Promise<NativeProjectResolution> {
    const bridge = await this.dependencies.getBridge(project.hostId)
    const deadline = Date.now() + 15000
    let requestedMethod = ''
    const request = (method: string, params: unknown) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('读取 Codex 项目超时，请重试')
      requestedMethod = method
      return bridge.request(method, params, Math.min(15000, remaining))
    }
    try {
      const projects = new Map<string, z.infer<typeof nativeProject>>()
      const cursors = new Set<string>()
      let cursor: string | null = null
      do {
        const response = projectPage.parse(await request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) }))
        for (const entry of response.data) projects.set(entry.id, entry)
        cursor = response.nextCursor
        if (cursor) {
          if (cursors.has(cursor)) throw new Error('Codex 项目分页游标重复，无法确认项目归属')
          cursors.add(cursor)
        }
      } while (cursor)
      const expected = rootsKey(roots)
      const matches = [...projects.values()].filter(entry => rootsKey(entry.roots.map(root => root.path)) === expected)
      const named = matches.filter(entry => entry.name.trim() === project.name.trim())
      const match = matches.length === 1 ? matches[0] : named.length === 1 ? named[0] : undefined
      if (match) return { projectId: match.id, supported: true }
      if (matches.length) throw Object.assign(new Error('多个 Codex 项目使用相同目录，无法确定归属；请将 Web 项目名称改为对应桌面项目的唯一名称'), { status: 409 })
      const idempotencyKey = `codex-web-project:${createHash('sha256').update(JSON.stringify([project.hostId, project.id, roots])).digest('hex')}`
      // Keep the primary directory first even though matching ignores root order.
      const primary = normalizeRoot(project.path)
      const ordered = [primary, ...roots.filter(root => root !== primary)]
      const created = z.object({ project: nativeProject }).parse(await request('project/create', { name: project.name, roots: ordered.map(root => ({ path: root })), idempotencyKey }))
      if (rootsKey(created.project.roots.map(root => root.path)) !== expected) throw new Error('Codex 返回的项目目录与当前项目不一致，请刷新后重试')
      return { projectId: created.project.id, supported: true }
    } catch (cause) {
      if (nativeProjectsUnsupported(cause, requestedMethod)) return { projectId: null, supported: false }
      if (cause instanceof z.ZodError) throw new Error('Codex 项目接口返回格式不兼容，请检查目标服务器的 Codex 版本')
      throw cause
    }
  }
}
