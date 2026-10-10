import { reactive } from 'vue';
import type { ConversationBookmark, BookmarkScope, ConversationBookmarkInput } from '../../shared/bookmarks';

type Api = { requestHttp(path: string, options?: RequestInit, reportError?: boolean): Promise<any>; runtimeIdentity(): { authenticationGeneration: number } };
/** Isolated targets stay before the continuous window until native pagination reaches them. */
export function retainBookmarkTargets(turns: any[], previous: any[], items: { id: string; turnId?: string }[]) {
  const ids = new Set(turns.map(turn => turn.id));
  const detached = previous.filter(turn => turn.historyBookmarkTarget && !ids.has(turn.id));
  const targetIds = new Set(detached.map(turn => turn.id));
  const groups = new Map<string, typeof items>();
  for (const item of items) if (item.turnId && targetIds.has(item.turnId)) {
    const group = groups.get(item.turnId) || []; group.push(item); groups.set(item.turnId, group);
  }
  return [...detached.map(turn => ({ ...turn, items: groups.get(turn.id) || turn.items || [] })), ...turns];
}

/** A native item page is a prefix, while a summary may already contain its last
 * answer. Keep native order and retain events received after the read began. */
export function mergeBookmarkMessages<T extends { id: string }>(known: readonly T[], incoming: readonly T[], changed: ReadonlySet<string> = new Set(), nativeOrder: readonly string[] = incoming.map(item => item.id)): T[] {
  const merged = new Map(known.map(item => [item.id, item]));
  for (const item of incoming) {
    if (!merged.has(item.id) || !changed.has(item.id)) merged.set(item.id, item);
  }
  // Native pages also contain command IDs. Preserve the position of already
  // loaded tools without retaining every newly read command's output.
  const prefix = [...new Set([...nativeOrder, ...incoming.map(item => item.id)])];
  const ids = new Set(prefix);
  return [...prefix.map(id => merged.get(id)).filter((item): item is T => !!item), ...known.filter(item => !ids.has(item.id))];
}
export function useConversationBookmarks(api: Api) {
  const state = reactive({ open: false, scope: null as BookmarkScope | null, projectName: '', entries: [] as ConversationBookmark[], loading: false, error: '', busyId: '' });
  let generation = 0;
  const query = (scope: BookmarkScope) => new URLSearchParams({ hostId: scope.hostId, projectPath: scope.projectPath }).toString();
  const sameScope = (scope: BookmarkScope) => state.scope?.hostId === scope.hostId && state.scope?.projectPath === scope.projectPath;
  async function refresh() {
    const scope = state.scope;
    if (!scope) return;
    const revision = ++generation, authentication = api.runtimeIdentity().authenticationGeneration;
    state.loading = true; state.error = '';
    try {
      const result = await api.requestHttp('/bookmarks?' + query(scope), {}, false);
      if (revision === generation && authentication === api.runtimeIdentity().authenticationGeneration && sameScope(scope)) state.entries = result.bookmarks;
    } catch (error: any) { if (revision === generation && authentication === api.runtimeIdentity().authenticationGeneration) state.error = error?.message || '无法读取收藏，请重试'; }
    finally { if (revision === generation && authentication === api.runtimeIdentity().authenticationGeneration) state.loading = false; }
  }
  function open(scope: BookmarkScope, projectName: string) {
    state.scope = { ...scope }; state.projectName = projectName; state.entries = []; state.open = true; state.busyId = '';
    return refresh();
  }
  function close() { state.open = false; }
  function clear() { ++generation; state.open = false; state.scope = null; state.entries = []; state.error = ''; state.loading = false; state.busyId = ''; }
  async function save(input: ConversationBookmarkInput | ConversationBookmark, name: string) {
    const authentication = api.runtimeIdentity().authenticationGeneration;
    const editing = 'id' in input;
    const result = await api.requestHttp(editing ? `/bookmarks/${encodeURIComponent(input.id)}?${query(input)}` : '/bookmarks', {
      method: editing ? 'PATCH' : 'POST', body: JSON.stringify(editing ? { name } : { ...input, name }),
    }, false);
    if (authentication === api.runtimeIdentity().authenticationGeneration && sameScope(input)) {
      ++generation; state.loading = false;
      const index = state.entries.findIndex(entry => entry.id === result.bookmark.id);
      if (index >= 0) state.entries[index] = result.bookmark;
      else state.entries.unshift(result.bookmark);
    }
    return result.bookmark as ConversationBookmark;
  }
  async function remove(entry: ConversationBookmark) {
    if (state.busyId) return;
    const authentication = api.runtimeIdentity().authenticationGeneration;
    state.busyId = entry.id; state.error = '';
    try {
      await api.requestHttp(`/bookmarks/${encodeURIComponent(entry.id)}?${query(entry)}`, { method: 'DELETE' }, false);
      if (authentication === api.runtimeIdentity().authenticationGeneration && sameScope(entry)) {
        ++generation; state.loading = false; state.entries = state.entries.filter(item => item.id !== entry.id);
      }
    } catch (error: any) { if (authentication === api.runtimeIdentity().authenticationGeneration && sameScope(entry)) state.error = error?.message || '无法移除收藏，请重试'; }
    finally { if (authentication === api.runtimeIdentity().authenticationGeneration && sameScope(entry) && state.busyId === entry.id) state.busyId = ''; }
  }
  return { state, open, close, clear, refresh, save, remove };
}

/** Highlight a saved quotation without changing Markdown DOM or opening selection actions. */
export function bookmarkTextRange(body: HTMLElement, text: string): Range | null {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [], parts: string[] = [];
  let size = 0, node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('button,input,textarea,select,[data-selection-ignore]')) continue;
    const value = node.textContent || '';
    size += value.length;
    if (size > 1024 * 1024) return null;
    nodes.push(node as Text); parts.push(value.replace(/\s/g, ''));
  }
  const needle = text.replace(/\s/g, '');
  const index = needle ? parts.join('').indexOf(needle) : -1;
  if (index < 0) return null;
  let compactOffset = 0, first: { node: Text; offset: number } | undefined, last: { node: Text; offset: number } | undefined;
  for (const textNode of nodes) {
    const value = textNode.textContent || '';
    for (let offset = 0; offset < value.length; offset++) if (!/\s/.test(value[offset])) {
      if (compactOffset === index) first = { node: textNode, offset };
      if (compactOffset === index + needle.length - 1) { last = { node: textNode, offset }; break; }
      compactOffset++;
    }
    if (last) break;
  }
  if (!first || !last) return null;
  const range = document.createRange(); range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset + 1);
  return range;
}
