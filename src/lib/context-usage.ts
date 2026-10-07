export function contextUsage(usage: any): { used: number; limit: number; percent: number } | null {
  const used = usage?.last?.totalTokens;
  const limit = usage?.modelContextWindow;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 ||
      typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  return { used, limit, percent: Math.min(100, Math.round(100 * used / limit)) };
}
