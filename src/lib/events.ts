// app-server items are authoritative on completion. Deltas only extend in-flight items.
import { contextUsage } from './context-usage';
export type DisplayItem = { id: string; type: string; turnId?: string; [key: string]: any };
export function upsertItem(items: DisplayItem[], incoming: DisplayItem): void {
  let index = items.findIndex(item => item.id === incoming.id);
  if (index < 0 && incoming.type === 'userMessage' && incoming.clientId) {
    index = items.findIndex(item => item.clientId === incoming.clientId);
  }
  if (index < 0) items.push(incoming);
  else {
    const previous = items[index];
    items[index] = { ...previous, ...incoming };
    if (incoming.type === 'userMessage' && incoming.id !== previous.id && incoming.status === undefined) delete items[index].status;
  }
}
/** Hydrate history without overwriting events delivered after the history read began. */
export function mergeSnapshotItems(snapshot: DisplayItem[], live: DisplayItem[], changedIds: ReadonlySet<string>): DisplayItem[] {
  const result = snapshot.map(item => ({ ...item }));
  for (const item of live) {
    let index = result.findIndex(entry => entry.id === item.id);
    if (index < 0 && item.type === 'userMessage' && item.clientId) index = result.findIndex(entry => entry.type === 'userMessage' && entry.clientId === item.clientId);
    if (index >= 0) {
      // A persisted user message replaces its optimistic alias, never the reverse.
      if (result[index].id !== item.id && ['sending', 'unconfirmed'].includes(item.status)) continue;
      if (changedIds.has(item.id)) result[index] = { ...result[index], ...item };
    } else if (changedIds.has(item.id) || ['sending', 'unconfirmed'].includes(item.status)) result.push(item);
  }
  return result;
}
export function applyItemEvent(items: DisplayItem[], method: string, params: any): void {
  if (method === 'item/started' || method === 'item/completed') {
    upsertItem(items, { ...params.item, turnId: params.turnId,
      ...(params.item?.type === 'contextCompaction' ? { status: method === 'item/started' ? 'inProgress' : 'completed' } : {}) });
    return;
  }
  const kinds: Record<string, string> = {
    'item/agentMessage/delta': 'agentMessage', 'item/plan/delta': 'plan',
    'item/reasoning/summaryTextDelta': 'reasoning', 'item/reasoning/textDelta': 'reasoning',
    'item/commandExecution/outputDelta': 'commandExecution',
  };
  const type = kinds[method];
  if (!type) return;
  let item = items.find(item => item.id === params.itemId);
  if (!item) {
    item = { id: params.itemId, type, turnId: params.turnId };
    items.push(item);
  }
  if (type === 'reasoning') {
    const key = method.includes('summary') ? 'summary' : 'content';
    const index = params.summaryIndex ?? params.contentIndex ?? 0;
    item[key] ??= [];
    item[key][index] = (item[key][index] ?? '') + params.delta;
  } else {
    const key = type === 'commandExecution' ? 'aggregatedOutput' : 'text';
    item[key] = (item[key] ?? '') + params.delta;
  }
}
export function contextPercent(usage: any): number {
  return contextUsage(usage)?.percent ?? 0;
}
