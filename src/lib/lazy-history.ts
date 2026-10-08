import type { DisplayItem } from './events';

type Request = (method: 'thread/turns/list' | 'thread/items/list', params: any) => Promise<any>;
type PageParams = { threadId: string; cursor: string | null; limit: number; sortDirection: 'desc' };
export const historyItemPageSize = 40;

function unsupported(error: any, feature: 'summary' | 'items') {
  const code = error?.code ?? error?.rpc?.code;
  const message = String(error?.message || error?.rpc?.message || '');
  if (feature === 'items') return code === -32601 || /(?:does not support|unsupported|not supported).*item pagination|(?:item pagination|thread\/items\/list).*(?:unsupported|not supported)|unsupported.*thread\/items\/list/i.test(message);
  return code === -32602 && /summary|itemsView|items_view/.test(message);
}

/** Capability failures are remembered per runtime; transport failures never downgrade it. */
export class LazyHistoryReader {
  private summaryUnavailable = new Set<string>();
  private itemsUnavailable = new Set<string>();
  clear() { this.summaryUnavailable.clear(); this.itemsUnavailable.clear(); }
  async turns(scope: string, request: Request, params: PageParams, full = false): Promise<any> {
    let page: any;
    if (full || this.summaryUnavailable.has(scope)) page = await request('thread/turns/list', { ...params, itemsView: 'full' });
    else {
      try { page = await request('thread/turns/list', { ...params, itemsView: 'summary' }); }
      catch (error) {
        if (!unsupported(error, 'summary')) throw error;
        this.summaryUnavailable.add(scope);
        page = await request('thread/turns/list', { ...params, itemsView: 'full' });
      }
    }
    if (!Array.isArray(page?.data)) throw new Error('无法读取对话历史，请重新同步。');
    if (full) return page;
    return { ...page, data: page.data.map((turn: any) => ({ ...turn,
      historySummary: turn.itemsView === 'summary' || turn.itemsView === 'notLoaded',
      historySourceCursor: params.cursor, historyPageLimit: params.limit,
      historyItemsStarted: false, historyItemsCursor: null, historyItemIds: [],
    })) };
  }
  async items(scope: string, request: Request, threadId: string, turn: any): Promise<any> {
    const key = JSON.stringify([scope, threadId]);
    if (!this.itemsUnavailable.has(key)) {
      try {
        const page = await request('thread/items/list', { threadId, turnId: turn.id,
          cursor: turn.historyItemsStarted ? turn.historyItemsCursor : null,
          limit: historyItemPageSize, sortDirection: 'asc' });
        if (!Array.isArray(page?.data) || page.data.some((entry: any) => entry.turnId !== turn.id || typeof entry.item?.id !== 'string' || !entry.item.id || typeof entry.item.type !== 'string'))
          throw new Error('过程记录与当前轮次不匹配，请同步对话后重试。');
        if (page.nextCursor != null && typeof page.nextCursor !== 'string') throw new Error('过程记录分页无效，请同步对话后重试。');
        if (page.nextCursor && (page.nextCursor === turn.historyItemsCursor || turn.historyItemCursors?.includes(page.nextCursor))) throw new Error('过程记录分页游标重复，请同步对话后重试。');
        return page;
      } catch (error) {
        if (!unsupported(error, 'items')) throw error;
        this.itemsUnavailable.add(key);
      }
    }
    // Older stores can read turns but cannot page their items. Re-read only the
    // source turn page, never acquire a writer or retry a failed mutation.
    const page = await this.turns(scope, request, { threadId, cursor: turn.historySourceCursor ?? null,
      limit: turn.historyPageLimit || 30, sortDirection: 'desc' }, true);
    const found = page.data.find((entry: any) => entry.id === turn.id);
    if (!found || found.itemsView === 'summary' || found.itemsView === 'notLoaded')
      throw new Error('此轮历史已变化，请同步对话后重新展开。');
    return { data: (found.items || []).map((item: any) => ({ turnId: turn.id, item })), nextCursor: null };
  }
}

/** Reuse fetched details only for the same validated, completed history window. */
export function retainHistoryDetails(turns: any[], previous: any[], items: DisplayItem[]): any[] {
  const metadata = new Map(previous.map(turn => [turn.id, turn]));
  const byTurn = new Map<string, DisplayItem[]>();
  for (const item of items) if (item.turnId) {
    const group = byTurn.get(item.turnId) || [];
    group.push(item); byTurn.set(item.turnId, group);
  }
  return turns.map(turn => {
    const old = metadata.get(turn.id), known = byTurn.get(turn.id) || [];
    if (!turn.historySummary || !old || turn.status === 'inProgress' || old.status !== turn.status ||
        old.historySummary && !old.historyItemsStarted || known.some(item => item.cacheTruncated)) return turn;
    const incoming = new Map<string, any>((turn.items || []).map((item: any) => [item.id, item]));
    const ids = new Set(known.map(item => item.id));
    // Native summaries may keep only the first user and last answer, omitting
    // steering inputs and commentary. Those omissions are not a rollback.
    if ([...incoming.keys()].some(id => !ids.has(id))) return turn;
    return { ...turn, items: known.map(item => incoming.get(item.id) || item),
      historySummary: old.historySummary === true, historyItemsStarted: old.historyItemsStarted === true,
      historyItemsCursor: old.historyItemsCursor ?? null, historyItemIds: old.historyItemIds || [],
      historyItemCursors: old.historyItemCursors || [],
    };
  });
}

/** Native item pages are prefixes. Keep not-yet-paged messages and newer live
 * events after that prefix, and place compaction markers at their native position. */
export function mergeHistoryDetails(items: DisplayItem[], turns: any[], turn: any, page: any, changed: ReadonlySet<string>) {
  const known = items.filter(item => item.turnId === turn.id);
  const merged = new Map(known.map(item => [item.id, item]));
  const prefix: string[] = [...(turn.historyItemIds || [])];
  const ids = new Set(prefix);
  for (const entry of page.data) {
    const item = { ...entry.item, turnId: turn.id };
    if (!changed.has(item.id) || !merged.has(item.id)) merged.set(item.id, item);
    if (!ids.has(item.id)) { ids.add(item.id); prefix.push(item.id); }
  }
  const ordered = [...prefix.map(id => merged.get(id)!).filter(Boolean), ...known.filter(item => !ids.has(item.id))];
  const first = items.findIndex(item => item.turnId === turn.id);
  const position = new Map(turns.map((entry, index) => [entry.id, index]));
  const before = first >= 0 ? first : items.findIndex(item => item.turnId &&
    (position.get(item.turnId) ?? -1) > (position.get(turn.id) ?? -1));
  const remaining = items.filter(item => item.turnId !== turn.id);
  const insertion = before < 0 ? remaining.length : items.slice(0, before).filter(item => item.turnId !== turn.id).length;
  remaining.splice(insertion, 0, ...ordered);
  return { items: remaining, turn: { ...turn, items: ordered, historyItemsStarted: true,
    historySummary: !!page.nextCursor, historyItemsCursor: page.nextCursor ?? null, historyItemIds: prefix,
    historyItemCursors: [...(turn.historyItemCursors || []), ...(turn.historyItemsCursor ? [turn.historyItemsCursor] : [])] } };
}
