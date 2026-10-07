import type { Express } from 'express'
import type { Bridge, BridgeOptions } from './bridge.js'
import { NativeCapabilitiesService, nativeRuntimeVersion } from './native-capabilities.js'
import type { Host } from './types.js'

export type DiagnosticsDependencies = { getHost: (id: string) => Host | undefined; getExistingBridge: (id: string) => Bridge | undefined; bridgeOptions?: BridgeOptions; capabilities?: NativeCapabilitiesService }
export function registerDiagnostics(app: Express, dependencies: DiagnosticsDependencies) {
  const capabilities = dependencies.capabilities || new NativeCapabilitiesService({ bridgeOptions: dependencies.bridgeOptions })
  const host = (id: string) => {
    const value = dependencies.getHost(id)
    if (!value) throw Object.assign(new Error('主机不存在'), { status: 404 })
    return value
  }
  app.get('/api/hosts/:id/diagnostics', (req, res, next) => {
    try {
      const selected = host(String(req.params.id)); const bridge = dependencies.getExistingBridge(selected.id)
      const runtime = bridge?.diagnostics() || null
      const capabilityNotice = dependencies.bridgeOptions?.mode === 'proxy' || runtime?.connectionMode === 'proxy' ? 'proxy_runtime' : runtime && !nativeRuntimeVersion(runtime.userAgent) ? 'runtime_version_unknown' : null
      res.json({ hostId: selected.id, sampledAt: Date.now(), runtime, capabilityNotice })
    } catch (error) { next(error) }
  })
  app.get('/api/hosts/:id/native-capabilities', (req, res, next) => {
    void (async () => {
      const selected = host(String(req.params.id)); const bridge = dependencies.getExistingBridge(selected.id)
      if (!bridge?.connected || bridge.paused) { res.json({ status: 'unknown', checkedAt: Date.now(), methods: {} }); return }
      res.json(await capabilities.read(selected, bridge.diagnostics()))
    })().catch(next)
  })
  return capabilities
}
