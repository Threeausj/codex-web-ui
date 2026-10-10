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
type SnapshotMergeOptions = {
  retainedTurnIds?: ReadonlySet<string>;
  summarizedTurnIds?: ReadonlySet<string>;
};

/** Hydrate history without overwriting newer events or moving omitted live
 * items away from their chronological neighbors. Validated summaries can
 * omit steering input; a removed turn can never authorize retaining it. */
export function mergeSnapshotItems(snapshot: DisplayItem[], live: DisplayItem[], changedIds: ReadonlySet<string>, options: SnapshotMergeOptions = {}): DisplayItem[] {
  type Slot = { item: DisplayItem; snapshotIndex?: number; previous?: number; next?: number; globalPrevious?: number; globalNext?: number };
  const slots: Slot[] = snapshot.map((item, snapshotIndex) => ({ item: { ...item }, snapshotIndex }));
  const ids = new Map(slots.map(slot => [slot.item.id, slot]));
  const clients = new Map(slots.flatMap(slot => slot.item.type === 'userMessage' && slot.item.clientId ? [[slot.item.clientId, slot] as const] : []));
  const additions: Slot[] = [];
  const find = (item: DisplayItem) => ids.get(item.id) ?? (item.type === 'userMessage' && item.clientId ? clients.get(item.clientId) : undefined);
  const alias = (item: DisplayItem) => item.type === 'userMessage' && (item.id === item.clientId || ['sending', 'unconfirmed'].includes(item.status));
  for (let liveIndex = 0; liveIndex < live.length; liveIndex++) {
    const item = live[liveIndex]!;
    const slot = find(item);
    if (slot) {
      // Canonical history replaces accepted as well as unconfirmed aliases.
      if (slot.item.id !== item.id && alias(item) && !alias(slot.item)) continue;
      if (changedIds.has(item.id) || slot.snapshotIndex === undefined) {
        const previous = slot.item;
        slot.item = { ...previous, ...item };
        if (item.type === 'userMessage' && item.id !== previous.id && item.status === undefined) delete slot.item.status;
        ids.set(item.id, slot);
        if (item.type === 'userMessage' && item.clientId) clients.set(item.clientId, slot);
      }
      continue;
    }
    if (item.turnId && options.retainedTurnIds && !options.retainedTurnIds.has(item.turnId)) continue;
    if (!changedIds.has(item.id) && !['sending', 'unconfirmed'].includes(item.status) &&
        !(item.turnId && options.summarizedTurnIds?.has(item.turnId))) continue;
    const addition: Slot = { item: { ...item } };
    additions.push(addition);
    ids.set(item.id, addition);
    if (item.type === 'userMessage' && item.clientId) clients.set(item.clientId, addition);
  }
  // Neighbor discovery is linear in the window size, including large turns.
  const previousByTurn = new Map<string, number>();
  let globalPrevious: number | undefined;
  for (const item of live) {
    const slot = find(item);
    if (!slot) continue;
    if (slot.snapshotIndex !== undefined) {
      globalPrevious = slot.snapshotIndex;
      if (item.turnId) previousByTurn.set(item.turnId, slot.snapshotIndex);
    } else {
      slot.previous ??= item.turnId ? previousByTurn.get(item.turnId) : undefined;
      slot.globalPrevious ??= globalPrevious;
    }
  }
  const nextByTurn = new Map<string, number>();
  let globalNext: number | undefined;
  for (let index = live.length - 1; index >= 0; index--) {
    const item = live[index]!;
    const slot = find(item);
    if (!slot) continue;
    if (slot.snapshotIndex !== undefined) {
      globalNext = slot.snapshotIndex;
      if (item.turnId) nextByTurn.set(item.turnId, slot.snapshotIndex);
    } else {
      slot.next ??= item.turnId ? nextByTurn.get(item.turnId) : undefined;
      slot.globalNext ??= globalNext;
    }
  }
  const before = new Map<number, DisplayItem[]>(), after = new Map<number, DisplayItem[]>();
  const tail: DisplayItem[] = [];
  for (const slot of additions) {
    const next = slot.next ?? (slot.previous === undefined ? slot.globalNext : undefined);
    const previous = slot.previous ?? slot.globalPrevious;
    const bucket = next !== undefined ? before : previous !== undefined ? after : undefined;
    const index = next ?? previous;
    if (!bucket || index === undefined) tail.push(slot.item);
    else { const entries = bucket.get(index) || []; entries.push(slot.item); bucket.set(index, entries); }
  }
  return slots.flatMap((slot, index) => [...(before.get(index) || []), slot.item, ...(after.get(index) || [])]).concat(tail);
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
