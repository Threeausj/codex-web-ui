import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Express, RequestHandler } from 'express'
import { z } from 'zod'
import { RpcFailure, type Bridge, type BridgeOptions } from './bridge.js'
import { runHostPython } from './host-helper.js'
import type { Host } from './types.js'

const providerId = 'web_gateway'
const secretFile = '.web-gateway-key'
// Keys stay in a private file on the selected host, separately from official
// auth.json. Codex's documented command-backed bearer authentication reads it.
export const gatewayTokenReader = 'import pathlib,sys; sys.stdout.write(pathlib.Path(sys.argv[1]).read_text())'
export function gatewayKeyWriter(file: string, key: string): string {
  const payload = Buffer.from(JSON.stringify({ file, key })).toString('base64')
  return `import base64,json,os,pathlib,tempfile\np=json.loads(base64.b64decode('${payload}'))\nf=pathlib.Path(p['file'])\nif not f.parent.is_dir(): raise RuntimeError('Codex home is missing')\nfd,tmp=tempfile.mkstemp(prefix='.web-key-',dir=str(f.parent))\ntry:\n    os.fchmod(fd,0o600)\n    with os.fdopen(fd,'w') as out: out.write(p['key']); out.flush(); os.fsync(out.fileno())\n    os.replace(tmp,str(f))\nfinally:\n    if os.path.exists(tmp): os.unlink(tmp)\nprint('ok')\n`
}
function safeUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw Object.assign(new Error('请输入有效的 HTTP(S) API 根地址'), { status: 400 }) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Object.assign(new Error('请输入不含密码、查询参数或片段的 HTTP(S) API 根地址'), { status: 400 })
  return url.href.replace(/\/$/, '')
}
/** Config views must never return stored bearer credentials to the browser. */
export function redactSettings(value: unknown): any {
  if (Array.isArray(value)) return value.map(redactSettings)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/api_?key|bearer|authorization|password|secret|credentials|private_?key|^(auth|env|http_headers|headers)$|(?:^|_)(?:access|refresh|id|client|auth)_?token$|(?:^|_)token$/i.test(key))
      return [key, entry ? '[已保存]' : entry]
    if (/^base_?url$/i.test(key) && typeof entry === 'string') {
      try { const url = new URL(entry); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return [key, url.href.replace(/\/$/, '')] }
      catch { return [key, ''] }
    }
    return [key, redactSettings(entry)]
  }))
}
const text = z.string().max(4096)
const configPath = text.min(1).refine(value => path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value), '配置路径必须为绝对路径')
const empty = z.object({}).strict().optional()
const paging = z.object({ cursor: z.string().max(8192).nullable().optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
const rpcInput = z.discriminatedUnion('method', [
  z.object({ method: z.literal('config/read'), params: z.object({ includeLayers: z.boolean().optional(), cwd: text.optional() }).strict().optional() }).strict(),
  z.object({ method: z.literal('configRequirements/read'), params: empty }).strict(),
  z.object({ method: z.literal('account/read'), params: z.object({ refreshToken: z.literal(false).optional() }).strict().optional() }).strict(),
  z.object({ method: z.literal('permissionProfile/list'), params: z.object({ cwd: text.optional() }).strict().optional() }).strict(),
  z.object({ method: z.literal('modelProvider/capabilities/read'), params: empty }).strict(),
  z.object({ method: z.literal('model/list'), params: paging.extend({ includeHidden: z.boolean().optional() }).optional() }).strict(),
  z.object({ method: z.literal('skills/list'), params: z.object({ cwds: z.array(text).max(20).optional(), forceReload: z.boolean().optional() }).strict().optional() }).strict(),
  z.object({ method: z.literal('app/list'), params: paging.optional() }).strict(),
  z.object({ method: z.literal('mcpServerStatus/list'), params: paging.extend({ detail: z.enum(['toolsAndAuthOnly', 'full']).optional() }).optional() }).strict(),
  z.object({ method: z.literal('skills/config/write'), params: z.object({ name: text.optional(), path: text.optional(), enabled: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal('config/mcpServer/reload'), params: empty }).strict(),
  z.object({ method: z.literal('mcpServer/oauth/login'), params: z.object({ name: text.min(1), threadId: z.string().max(256).optional() }).strict() }).strict(),
  z.object({ method: z.literal('config/batchWrite'), params: z.object({
    edits: z.array(z.object({ keyPath: text.min(1), value: z.unknown(), mergeStrategy: z.enum(['replace', 'upsert']) }).strict()).min(1).max(64),
    filePath: configPath.nullable().optional(), expectedVersion: z.string().max(512).nullable().optional(), reloadUserConfig: z.boolean().optional(),
  }).strict() }).strict(),
])
const providerInput = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('official') }).strict(),
  z.object({ provider: z.literal('gateway'), baseUrl: text.min(1), apiKey: z.string().min(1).max(16384).optional(), model: z.string().max(256).optional() }).strict(),
])
type Dependencies = {
  getHost(id: string): Host | undefined
  getExistingBridge(id: string): Bridge | undefined
  bridgeOptions?: BridgeOptions
  withRuntimeMaintenance<T>(hostId: string, work: () => Promise<T>): Promise<T>
  writeKey?: (host: Host, file: string, key: string) => Promise<void>
  removeKey?: (host: Host, file: string) => Promise<void>
}
const route = (fn: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next) }
const busy = (message: string) => Object.assign(new Error(message), { status: 409 })
export function registerHostSettings(app: Express, dependencies: Dependencies) {
  const resolve = (id: string) => {
    const host = dependencies.getHost(id)
    if (!host) throw Object.assign(new Error('主机不存在'), { status: 404 })
    return { host, bridge: dependencies.getExistingBridge(id) }
  }
  const connected = (id: string) => {
    const result = resolve(id)
    if (!result.bridge?.connected || result.bridge.paused) throw busy('请先在性能设置中连接此主机的 Codex')
    return { host: result.host, bridge: result.bridge }
  }
  const read = async (id: string) => {
    const { bridge } = resolve(id)
    if (!bridge?.connected || bridge.paused) return { provider: 'unknown', connected: false, canChange: false,
      disabledReason: '请先在性能设置中连接此主机的 Codex', hasApiKey: false }
    const engineId = bridge.runtime.engineId
    const [configuration, account] = await Promise.all([
      bridge.request('config/read', { includeLayers: true }),
      bridge.request('account/read', { refreshToken: false }).catch(() => null),
    ]) as any[]
    if (!bridge.connected || bridge.runtime.engineId !== engineId) throw busy('Codex 连接已改变，请重新读取设置')
    const config = configuration.config || {}
    const currentProvider = config.model_provider || 'openai'
    const gateway = config.model_providers?.[providerId]
    const proxy = !bridge.runtime.managed
    let baseUrl = gateway?.base_url || (currentProvider !== 'openai' ? config.model_providers?.[currentProvider]?.base_url : '') || ''
    try { const url = new URL(baseUrl); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; baseUrl = ['http:', 'https:'].includes(url.protocol) ? url.href.replace(/\/$/, '') : '' } catch { baseUrl = '' }
    return { provider: currentProvider === 'openai' ? 'official' : currentProvider === providerId ? 'gateway' : 'custom',
      providerId: currentProvider, baseUrl,
      hasApiKey: !!gateway?.auth || !!gateway?.experimental_bearer_token || !!gateway?.env_key,
      model: config.model || '', account: redactSettings(account?.account || null), userAgent: bridge.userAgent,
      connected: true, canChange: !proxy && bridge.reconnectStatus.canReconnect,
      disabledReason: proxy ? '共享代理进程的配置需要在服务端修改；直接连接后可切换提供方' : bridge.reconnectStatus.reconnectDisabledReason,
    }
  }
  app.get('/api/hosts/:id/codex-settings', route(async (req, res) => { res.json(await read(String(req.params.id))) }))
  app.post('/api/hosts/:id/settings/rpc', route(async (req, res) => {
    const input = rpcInput.parse(req.body)
    const { host, bridge } = connected(String(req.params.id))
    const write = ['config/batchWrite', 'skills/config/write', 'config/mcpServer/reload', 'mcpServer/oauth/login'].includes(input.method)
    if (write && !bridge.runtime.managed) throw busy('共享代理进程的配置需要在服务端修改，请使用直接连接')
    const request = async (rpc: (method: string, params?: unknown, timeout?: number) => Promise<unknown>) => {
      if (input.method === 'config/batchWrite' && input.params.filePath) {
        const config = await rpc('config/read', { includeLayers: true }) as any
        const user = [...(config.layers || [])].reverse().find((layer: any) => layer.name?.type === 'user' && !layer.name.profile)
        if (input.params.filePath !== user?.name?.file) throw Object.assign(new Error('只能修改所选主机的用户配置'), { status: 400 })
      }
      return rpc(input.method, input.params, 45000)
    }
    res.json(redactSettings(await (write ? dependencies.withRuntimeMaintenance(host.id, () => bridge.withRuntimeMaintenance(request)) : request((...args) => bridge.request(...args)))))
  }))
  app.post('/api/hosts/:id/codex-settings/provider', route(async (req, res) => {
    const input = providerInput.parse(req.body)
    const baseUrl = input.provider === 'gateway' ? safeUrl(input.baseUrl.trim()) : undefined
    const { host, bridge } = connected(String(req.params.id))
    if (!bridge.runtime.managed) throw busy('共享代理进程不能在网页中切换提供方，请使用直接连接')
    await dependencies.withRuntimeMaintenance(host.id, () => bridge.reconnect(async request => {
      const before = await request('config/read', { includeLayers: true }) as any
      const user = [...(before.layers || [])].reverse().find((layer: any) => layer.name?.type === 'user' && !layer.name.profile)
      const file = user?.name?.file
      const home = bridge.codexHome || (typeof file === 'string' ? path.dirname(file) : '')
      if (!home || !path.isAbsolute(home)) throw busy('Codex 未报告配置目录，请更新 Codex 后重试')
      const edits: any[] = []
      let stagedKey: string | undefined
      if (input.provider === 'gateway') {
        const previous = before.config?.model_providers?.[providerId]
        if (!input.apiKey && (!previous?.auth || previous.base_url !== baseUrl))
          throw Object.assign(new Error('首次使用或更换中转站地址时，请输入 API Key'), { status: 400 })
        // Rotating a credential must not overwrite the old provider's key if
        // an optimistic config write subsequently fails.
        const keyFile = input.apiKey ? path.join(home, `${secretFile}-${randomUUID()}`) : undefined
        if (input.apiKey) {
          if (/\s/.test(input.apiKey)) throw Object.assign(new Error('API Key 不能包含空白字符'), { status: 400 })
          if (dependencies.writeKey) await dependencies.writeKey(host, keyFile!, input.apiKey)
          else await runHostPython(host, gatewayKeyWriter(keyFile!, input.apiKey), dependencies.bridgeOptions)
          stagedKey = keyFile
        }
        edits.push({ keyPath: `model_providers.${providerId}`, mergeStrategy: 'replace', value: {
          name: 'Web Gateway', base_url: baseUrl, wire_api: 'responses',
          auth: keyFile ? { command: 'python3', args: ['-c', gatewayTokenReader, keyFile] } : previous.auth,
        } })
        if (input.model?.trim()) edits.push({ keyPath: 'model', value: input.model.trim(), mergeStrategy: 'replace' })
      }
      edits.push({ keyPath: 'model_provider', value: input.provider === 'official' ? 'openai' : providerId, mergeStrategy: 'replace' })
      try {
        await request('config/batchWrite', { edits, ...(file ? { filePath: file } : {}), ...(user?.version ? { expectedVersion: user.version } : {}), reloadUserConfig: false })
      } catch (error) {
        // A timeout or dropped acknowledgement may follow a committed write.
        // Only remove this newly generated file after an explicit native error;
        // older credentials and potentially accepted writes remain untouched.
        if (stagedKey && error instanceof RpcFailure) {
          if (dependencies.removeKey) await dependencies.removeKey(host, stagedKey).catch(() => {})
          else if (!dependencies.writeKey) {
            const encoded = Buffer.from(stagedKey).toString('base64')
            await runHostPython(host, `import base64,pathlib\nf=pathlib.Path(base64.b64decode('${encoded}').decode())\nf.unlink(missing_ok=True)\n`, dependencies.bridgeOptions).catch(() => {})
          }
        }
        throw error
      }
    }))
    const settings = await read(host.id)
    const applied = settings.provider === input.provider && (input.provider !== 'gateway' ||
      settings.baseUrl === baseUrl && (!input.model?.trim() || settings.model === input.model.trim()))
    res.json({ ...settings, applied, requestedProvider: input.provider,
      ...(applied ? {} : { warning: '用户配置已保存，但当前生效的提供方、API 地址或模型仍被较高优先级的配置覆盖。请检查项目配置、配置档或启动参数后重新读取设置。' }) })
  }))
  app.post('/api/hosts/:id/codex-settings/login', route(async (req, res) => {
    z.object({ type: z.literal('deviceAuth') }).strict().parse(req.body)
    const { host, bridge } = connected(String(req.params.id))
    if (!bridge.runtime.managed) throw busy('共享代理进程的账户需要在服务端管理，请使用直接连接')
    const result = await dependencies.withRuntimeMaintenance(host.id, () => bridge.withRuntimeMaintenance(async request => {
      const config = await request('config/read', {}) as any
      if (config.config?.model_provider && config.config.model_provider !== 'openai') throw busy('请先切换到官方账号，再开始登录')
      return request('account/login/start', { type: 'chatgptDeviceCode' }, 45000)
    }))
    res.json(result)
  }))
  app.post('/api/hosts/:id/codex-settings/login/cancel', route(async (req, res) => {
    const input = z.object({ loginId: z.string().min(1).max(256) }).strict().parse(req.body)
    const { bridge } = connected(String(req.params.id))
    res.json(await bridge.request('account/login/cancel', input))
  }))
  app.post('/api/hosts/:id/codex-settings/logout', route(async (req, res) => {
    z.object({}).strict().parse(req.body)
    const { host, bridge } = connected(String(req.params.id))
    if (!bridge.runtime.managed) throw busy('共享代理进程的账户需要在服务端管理，请使用直接连接')
    await dependencies.withRuntimeMaintenance(host.id, () => bridge.withRuntimeMaintenance(request => request('account/logout', {})))
    res.json({ ok: true })
  }))
}
