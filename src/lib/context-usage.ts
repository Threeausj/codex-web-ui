export function contextUsage(usage: any): { used: number; limit: number; percent: number } | null {
  const used = usage?.last?.totalTokens;
  const limit = usage?.modelContextWindow;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 ||
      typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  return { used, limit, percent: Math.min(100, Math.round(100 * used / limit)) };
}

/** Native reports may temporarily omit a context window or the last sample.
 * Retain the last usable measurement for this thread, never cumulative totals. */
export function mergeContextUsage(previous: any, incoming: any): any {
  if (!incoming || typeof incoming !== "object") return previous ?? null;
  const last = incoming.last;
  const usableLast = typeof last?.totalTokens === "number" && Number.isFinite(last.totalTokens) && last.totalTokens >= 0;
  const usableWindow = typeof incoming.modelContextWindow === "number" && Number.isFinite(incoming.modelContextWindow) && incoming.modelContextWindow > 0;
  if (!usableLast && !usableWindow) return previous ?? null;
  return {
    ...previous, ...incoming,
    last: usableLast ? last : previous?.last,
    modelContextWindow: usableWindow ? incoming.modelContextWindow : previous?.modelContextWindow ?? null,
  };
}
