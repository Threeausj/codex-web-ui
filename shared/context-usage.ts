export function contextUsage(usage: any): { used: number; limit: number; percent: number } | null {
  const used = usage?.last?.totalTokens;
  const limit = usage?.modelContextWindow;
  if (!hasContextUsageSample(usage) || !Number.isSafeInteger(limit) || limit <= 0) return null;
  return { used, limit, percent: Math.min(100, Math.round(100 * used / limit)) };
}

/** Reasoning and cache counters are parts of the native accounting, not extra
 * context to add to totalTokens. Retain the reported sample as one unit. */
function usableBreakdown(value: any): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Number.isSafeInteger(value.totalTokens) && value.totalTokens >= 0 &&
    ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens']
      .every(key => value[key] === undefined || Number.isSafeInteger(value[key]) && value[key] >= 0);
}

/** A window-only or billing-only report must not authorize automatic
 * compaction using an old cached context sample from a different runtime. */
export function hasContextUsageSample(value: any): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && usableBreakdown(value.last);
}

/** Native reports may temporarily omit a context window or the last sample.
 * Retain the last usable measurement for this thread, never cumulative totals. */
export function mergeContextUsage(previous: any, incoming: any): any {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return previous ?? null;
  const last = incoming.last;
  const usableLast = usableBreakdown(last);
  const usableTotal = usableBreakdown(incoming.total);
  const usableWindow = Number.isSafeInteger(incoming.modelContextWindow) && incoming.modelContextWindow > 0;
  if (!usableLast && !usableWindow && !usableTotal) return previous ?? null;
  return {
    ...previous, ...incoming,
    last: usableLast ? last : previous?.last,
    total: usableTotal ? incoming.total : previous?.total,
    modelContextWindow: usableWindow ? incoming.modelContextWindow : previous?.modelContextWindow ?? null,
  };
}
