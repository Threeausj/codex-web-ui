import { reactive, type InjectionKey } from 'vue';
import type { ConversationBookmark, BookmarkScope, ConversationBookmarkInput } from '../../shared/bookmarks';

type Api = { requestHttp(path: string, options?: RequestInit, reportError?: boolean): Promise<any>; runtimeIdentity(): { authenticationGeneration: number } };
const bookmarkCatalogAccept = 'application/vnd.codex-web.bookmarks.v2+json';
export type ThreadBookmarkTarget = { id: string; hostId?: string; cwd?: string; name?: string | null; title?: string | null; preview?: string | null; projectId?: string | null };
export const threadBookmarkActionsKey: InjectionKey<{
  saved(hostId: string, threadId: string): boolean;
  busy(): boolean;
  refresh(): Promise<void>;
  toggle(thread: ThreadBookmarkTarget, hostId: string): Promise<void>;
}> = Symbol('thread-bookmark-actions');
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

/** Match saved names, quotations and conversation titles without searching unrelated history. */
export function matchesBookmark(entry: ConversationBookmark, query: string): boolean {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [entry.name, entry.kind === 'thread' ? '' : entry.source.text, entry.source.threadName].join('\n').toLocaleLowerCase();
  return tokens.every(token => text.includes(token));
}

export function useConversationBookmarks(api: Api) {
  const state = reactive({
    open: false, scope: null as BookmarkScope | null, projectName: '', allProjects: false,
    entries: [] as ConversationBookmark[], loading: false, error: '', busyId: '',
    allEntries: [] as ConversationBookmark[], indexLoading: false, indexError: '',
  });
  let generation = 0, lifetime = 0, mutationRevision = 0, indexGeneration = 0;
  let indexAuthentication = api.runtimeIdentity().authenticationGeneration, indexLoaded = false;
  let indexPending: { authentication: number; lifetime: number; promise: Promise<void> } | undefined;
  let hosts: Set<string> | undefined;
  const hostRevisions = new Map<string, number>();
  const knownHost = (hostId: string) => !hosts || hosts.has(hostId);
  const hostRevision = (hostId: string) => hostRevisions.get(hostId) || 0;
  const sameScope = (a: BookmarkScope, b: BookmarkScope) => a.hostId === b.hostId && a.projectPath === b.projectPath;
  const key = (entry: ConversationBookmark) => JSON.stringify([entry.hostId, entry.projectPath, entry.id]);
  const changes = new Map<string, { revision: number; entry: ConversationBookmark | null; scope: BookmarkScope }>();
  const reads = new Set<{ revision: number }>();
  const query = (scope: BookmarkScope) => new URLSearchParams({ hostId: scope.hostId, projectPath: scope.projectPath }).toString();
  const showsScope = (scope: BookmarkScope) => !state.allProjects && !!state.scope && sameScope(state.scope, scope);
  const validSession = (authentication: number, epoch: number) => epoch === lifetime && authentication === api.runtimeIdentity().authenticationGeneration;
  const newestFirst = (a: ConversationBookmark, b: ConversationBookmark) => b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  function synchronizeAllPanel() {
    if (!state.allProjects) return;
    state.entries = [...state.allEntries]; state.loading = state.indexLoading; state.error = state.indexError;
  }
  function releaseRead(read: { revision: number }) {
    reads.delete(read);
    // Keep only mutations that an outstanding snapshot could still overwrite.
    const oldest = reads.size ? Math.min(...[...reads].map(item => item.revision)) : mutationRevision;
    for (const [id, change] of changes) if (change.revision <= oldest) changes.delete(id);
  }
  function mergeChanges(entries: ConversationBookmark[], revision: number, scope?: BookmarkScope) {
    const result = new Map(entries.map(entry => [key(entry), entry]));
    for (const [id, change] of changes) if (change.revision > revision && (!scope || sameScope(change.scope, scope))) {
      if (change.entry) result.set(id, change.entry);
      else result.delete(id);
    }
    return [...result.values()].filter(entry => knownHost(entry.hostId)).sort(newestFirst);
  }
  function applyChange(entry: ConversationBookmark, remove = false) {
    if (!knownHost(entry.hostId)) return;
    const id = key(entry);
    const change = { revision: ++mutationRevision, entry: remove ? null : entry, scope: { hostId: entry.hostId, projectPath: entry.projectPath } };
    if (reads.size) changes.set(id, change);
    state.allEntries = state.allEntries.filter(item => key(item) !== id);
    if (!remove) state.allEntries.push(entry);
    state.allEntries.sort(newestFirst);
    if (state.allProjects) synchronizeAllPanel();
    else if (showsScope(entry)) {
      state.entries = state.entries.filter(item => key(item) !== id);
      if (!remove) state.entries.push(entry);
      state.entries.sort(newestFirst);
    }
  }
  function synchronizeIndexAuthentication(authentication: number) {
    if (indexAuthentication === authentication) return;
    ++indexGeneration; indexAuthentication = authentication; indexLoaded = false; indexPending = undefined;
    state.allEntries = []; state.indexLoading = false; state.indexError = ''; synchronizeAllPanel();
  }
  /** Host changes invalidate snapshots without fetching an index until a view needs it. */
  function setHosts(hostIds: string[]): boolean {
    const next = new Set(hostIds);
    if (hosts && hosts.size === next.size && [...hosts].every(id => next.has(id))) return false;
    if (hosts) for (const hostId of new Set([...hosts, ...next])) if (hosts.has(hostId) !== next.has(hostId)) {
      hostRevisions.set(hostId, hostRevision(hostId) + 1);
    }
    hosts = next;
    ++indexGeneration; indexLoaded = false; indexPending = undefined;
    state.allEntries = state.allEntries.filter(entry => knownHost(entry.hostId));
    state.indexLoading = false; state.indexError = '';
    for (const [id, change] of changes) if (!knownHost(change.scope.hostId)) changes.delete(id);
    if (state.allProjects) synchronizeAllPanel();
    else if (state.scope && !knownHost(state.scope.hostId)) {
      ++generation; state.entries = []; state.loading = false; state.error = ''; state.busyId = '';
    }
    return true;
  }
  /** The cross-project catalog is loaded only when a bookmark view or search needs it. */
  function ensureIndex(options: { force?: boolean } = {}): Promise<void> {
    const authentication = api.runtimeIdentity().authenticationGeneration;
    synchronizeIndexAuthentication(authentication);
    if (indexPending?.authentication === authentication && indexPending.lifetime === lifetime) return indexPending.promise;
    if (indexLoaded && !options.force) return Promise.resolve();
    const revision = ++indexGeneration, epoch = lifetime, read = { revision: mutationRevision };
    reads.add(read);
    state.indexLoading = true; state.indexError = ''; synchronizeAllPanel();
    const current = () => revision === indexGeneration && validSession(authentication, epoch);
    let completed = false;
    const promise = (async () => {
      try {
        const result = await api.requestHttp('/bookmarks?all=true', { headers: { Accept: bookmarkCatalogAccept } }, false);
        if (current()) {
          state.allEntries = mergeChanges(result.bookmarks, read.revision); indexLoaded = true;
          synchronizeAllPanel();
        }
      } catch (error: any) {
        if (current()) { state.indexError = error?.message || '无法读取收藏，请重试'; synchronizeAllPanel(); }
      } finally {
        completed = true;
        if (current()) { state.indexLoading = false; indexPending = undefined; synchronizeAllPanel(); }
        releaseRead(read);
      }
    })();
    if (!completed) indexPending = { authentication, lifetime: epoch, promise };
    return promise;
  }
  async function refresh() {
    if (state.allProjects) return ensureIndex({ force: true });
    const scope = state.scope;
    if (!scope) return;
    if (!knownHost(scope.hostId)) { state.entries = []; state.loading = false; state.error = ''; return; }
    const revision = ++generation, authentication = api.runtimeIdentity().authenticationGeneration, epoch = lifetime;
    const read = { revision: mutationRevision }; reads.add(read);
    const current = () => revision === generation && validSession(authentication, epoch) && showsScope(scope) && knownHost(scope.hostId);
    state.loading = true; state.error = '';
    try {
      const result = await api.requestHttp('/bookmarks?' + query(scope), { headers: { Accept: bookmarkCatalogAccept } }, false);
      if (current()) state.entries = mergeChanges(result.bookmarks, read.revision, scope);
    } catch (error: any) { if (current()) state.error = error?.message || '无法读取收藏，请重试'; }
    finally { if (current()) state.loading = false; releaseRead(read); }
  }
  function open(scope: BookmarkScope, projectName: string) {
    ++generation; state.allProjects = false;
    state.scope = { ...scope }; state.projectName = projectName; state.entries = []; state.open = true; state.busyId = '';
    return refresh();
  }
  function openAll() {
    ++generation; state.scope = null; state.projectName = ''; state.allProjects = true; state.open = true; state.busyId = '';
    synchronizeAllPanel();
    return ensureIndex();
  }
  function close() { state.open = false; }
  function clear() {
    ++generation; ++lifetime; ++indexGeneration; changes.clear(); reads.clear(); indexLoaded = false; indexPending = undefined;
    hosts = undefined; hostRevisions.clear();
    indexAuthentication = api.runtimeIdentity().authenticationGeneration;
    state.open = false; state.scope = null; state.projectName = ''; state.allProjects = false;
    state.entries = []; state.error = ''; state.loading = false; state.busyId = '';
    state.allEntries = []; state.indexError = ''; state.indexLoading = false;
  }
  async function save(input: ConversationBookmarkInput | ConversationBookmark, name: string) {
    const authentication = api.runtimeIdentity().authenticationGeneration, epoch = lifetime, host = hostRevision(input.hostId);
    synchronizeIndexAuthentication(authentication);
    const editing = 'id' in input;
    const result = await api.requestHttp(editing ? `/bookmarks/${encodeURIComponent(input.id)}?${query(input)}` : '/bookmarks', {
      method: editing ? 'PATCH' : 'POST', body: JSON.stringify(editing ? { name } : { ...input, name }),
    }, false);
    if (validSession(authentication, epoch) && knownHost(input.hostId) && host === hostRevision(input.hostId)) applyChange(result.bookmark);
    return result.bookmark as ConversationBookmark;
  }
  async function remove(entry: ConversationBookmark, options?: { throwOnError?: boolean }) {
    if (state.busyId) {
      if (options?.throwOnError) throw new Error('请等待当前收藏操作完成');
      return;
    }
    const authentication = api.runtimeIdentity().authenticationGeneration, epoch = lifetime, panel = generation, host = hostRevision(entry.hostId);
    synchronizeIndexAuthentication(authentication);
    const currentMutation = () => validSession(authentication, epoch) && knownHost(entry.hostId) && host === hostRevision(entry.hostId);
    const currentPanel = () => panel === generation && currentMutation() && (state.allProjects || showsScope(entry));
    state.busyId = entry.id; state.error = '';
    try {
      await api.requestHttp(`/bookmarks/${encodeURIComponent(entry.id)}?${query(entry)}`, { method: 'DELETE' }, false);
      if (currentMutation()) applyChange(entry, true);
    } catch (error: any) {
      if (currentPanel()) state.error = error?.message || '无法移除收藏，请重试';
      if (options?.throwOnError) throw error;
    }
    finally { if (panel === generation && validSession(authentication, epoch) && state.busyId === entry.id) state.busyId = ''; }
  }
  return { state, open, openAll, close, clear, refresh, ensureIndex, setHosts, save, remove };
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
