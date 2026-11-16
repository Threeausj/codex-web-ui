import type { Host } from './types.js'

export type HostConnectionMode = 'spawn' | 'proxy' | 'daemon'

/** An omitted host field keeps existing installations on their configured mode. */
export function hostConnectionMode(host: Host, options: { mode?: 'spawn' | 'proxy'; daemonManaged?: boolean } = {}): HostConnectionMode {
  return host.connectionMode || (options.daemonManaged ? 'daemon' : options.mode || 'spawn')
}

export function hostTransportMode(host: Host, options: { mode?: 'spawn' | 'proxy'; daemonManaged?: boolean } = {}): 'spawn' | 'proxy' {
  return hostConnectionMode(host, options) === 'spawn' ? 'spawn' : 'proxy'
}
