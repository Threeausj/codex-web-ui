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
  const ids = new Map(result.map((item, index) => [item.id, index]));
  const clients = new Map(result.flatMap((item, index) => item.type === 'userMessage' && item.clientId ? [[item.clientId, index] as const] : []));
  for (const item of live) {
    const index = ids.get(item.id) ?? (item.type === 'userMessage' && item.clientId ? clients.get(item.clientId) : undefined);
    if (index !== undefined) {
      // A persisted user message replaces its optimistic alias, never the reverse.
      if (result[index].id !== item.id && ['sending', 'unconfirmed'].includes(item.status)) continue;
      if (changedIds.has(item.id)) {
        const previous = result[index];
        result[index] = { ...previous, ...item };
        if (item.type === 'userMessage' && item.id !== previous.id && item.status === undefined) delete result[index].status;
        if (previous.id !== item.id) ids.delete(previous.id);
        ids.set(item.id, index);
        if (item.type === 'userMessage' && item.clientId) clients.set(item.clientId, index);
      }
    } else if (changedIds.has(item.id) || ['sending', 'unconfirmed'].includes(item.status)) {
      ids.set(item.id, result.length);
      if (item.type === 'userMessage' && item.clientId) clients.set(item.clientId, result.length);
      result.push(item);
    }
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
