type ModelEntry = {
  id?: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  [key: string]: any;
};

const modelAliases = [
  { source: 'gpt-6-astra', model: 'gpt-6.2-astra', displayName: 'GPT-6.2-Astra' },
  { source: 'gpt-6-sol', model: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol' },
] as const;
const versionOrder = new Intl.Collator('en', { numeric: true });

/** Keep newly enabled relay models selectable while an older CLI catalog lags. */
export function extendModelCatalog(models: ModelEntry[]): ModelEntry[] {
  const result = [...models];
  const available = new Set(models.map(entry => entry.model).filter((model): model is string => !!model));
  for (const alias of modelAliases) {
    if (!available.has(alias.source) || available.has(alias.model)) continue;
    const source = models.find(entry => entry.model === alias.source && !entry.hidden);
    if (!source) continue;
    result.push({ ...source, id: alias.model, model: alias.model, displayName: alias.displayName, isDefault: false });
  }
  return result
    .map(entry => ({ entry, version: /^gpt-(\d+(?:\.\d+)*)(?:-|$)/i.exec(entry.model ?? '')?.[1] ?? '' }))
    .sort((left, right) => versionOrder.compare(right.version, left.version))
    .map(({ entry }) => entry);
}
