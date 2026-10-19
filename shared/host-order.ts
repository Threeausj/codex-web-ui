/** Apply saved host IDs without dropping new hosts or mutating either input. */
export function orderHosts<T extends { id: string }>(hosts: T[], ids: readonly string[]): T[] {
  const byId = new Map(hosts.map(host => [host.id, host]))
  const ordered: T[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const host = byId.get(id)
    if (host && !seen.has(id)) { ordered.push(host); seen.add(id) }
  }
  for (const host of hosts) if (!seen.has(host.id)) { ordered.push(host); seen.add(host.id) }
  return ordered
}
