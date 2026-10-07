export function serviceTierScope(state: any) {
  return JSON.stringify([state.hostId, state.activeThread?.id || '', state.projectPath, state.model]);
}
export function modelServiceTiers(state: any): { id: string; name: string; description: string }[] {
  const model = state.models?.find((entry: any) => entry.model === state.model);
  return (model?.serviceTiers || []).filter((tier: any) => typeof tier?.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(tier.id))
    .map((tier: any) => ({ id: tier.id, name: typeof tier.name === 'string' ? tier.name : tier.id, description: typeof tier.description === 'string' ? tier.description : '' }));
}
/** An omitted override preserves the native thread's current tier. */
export function serviceTierParams(state: any): { serviceTier?: string | null } {
  if (state.serviceTierScope !== serviceTierScope(state)) return {};
  if (state.serviceTier === null) return { serviceTier: null };
  return modelServiceTiers(state).some(tier => tier.id === state.serviceTier) ? { serviceTier: state.serviceTier } : {};
}
export function rateLimitWindows(response: any) {
  const buckets: any[] = response?.rateLimitsByLimitId ? Object.values(response.rateLimitsByLimitId) : response?.rateLimits ? [response.rateLimits] : [];
  return buckets.flatMap(bucket => ['primary', 'secondary'].flatMap(key => {
    const value = bucket?.[key];
    if (!Number.isFinite(value?.usedPercent)) return [];
    const minutes = value.windowDurationMins;
    const label = Number.isFinite(minutes) && minutes > 0 ? minutes >= 1440 ? `${Math.round(minutes / 1440)} 天` : minutes >= 60 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟` : key === 'primary' ? '主要额度' : '长期额度';
    return [{ key: `${bucket.limitId || bucket.limitName || 'default'}:${key}`, name: bucket.limitName || bucket.normalModelSlug || 'Codex', label,
      used: Math.max(0, Math.min(100, value.usedPercent)), resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt * 1000 : null }];
  }));
}
