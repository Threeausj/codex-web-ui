import { reactive } from 'vue';
import { privateState } from './private-state';

export type ChatTabTarget = { hostId: string; threadId: string };
export type ChatTab = ChatTabTarget & { title: string; pinned: boolean; lastOpened: number };
type StoredTabs = { version: 1; entries: ChatTab[] };
type TabPersistence = {
  read<T>(namespace: string, identity: string): Promise<T | null>;
  write<T>(namespace: string, identity: string, value: T): Promise<void>;
};
type Options = {
  ready: () => Promise<void>;
  authentication: () => number;
  persistence?: TabPersistence;
  now?: () => number;
};
const namespace = 'chat-tabs', identity = 'open';
export const maxChatTabs = 24;
// Keep one slot available for a newly selected chat, even with many fixed tabs.
export const maxPinnedChatTabs = maxChatTabs - 1;
export const sameChatTab = (a: ChatTabTarget | null | undefined, b: ChatTabTarget | null | undefined) =>
  !!a && !!b && a.hostId === b.hostId && a.threadId === b.threadId;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const validTarget = (value: ChatTabTarget) => validId(value.hostId) && validId(value.threadId);
const titleText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : '未命名对话';

/** Tabs contain only navigation metadata. Drafts, history and running tasks stay
 * with their existing owners, and closing a tab never sends an interrupt. */
export class ChatTabs {
  readonly state = reactive({ entries: [] as ChatTab[], hydrated: false });
  private readonly persistence: TabPersistence;
  private readonly now: () => number;
  private authentication: number;
  private generation = 0;
  private loading: Promise<void> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: ((entries: ChatTab[]) => ChatTab[])[] = [];
  private revision = 0;
  private savedRevision = 0;
  constructor(private options: Options) {
    this.persistence = options.persistence || privateState;
    this.now = options.now || Date.now;
    this.authentication = options.authentication();
  }
  private owned() {
    if (this.authentication !== this.options.authentication()) this.clear();
  }
  private current(generation: number, authentication: number) {
    return generation === this.generation && authentication === this.options.authentication();
  }
  private normalize(value: unknown): ChatTab[] {
    const rows = Array.isArray(value) ? value : [];
    const entries: ChatTab[] = [];
    for (const row of rows) {
      if (!row || !validTarget(row)) continue;
      const entry: ChatTab = { hostId: row.hostId, threadId: row.threadId, title: titleText(row.title),
        pinned: row.pinned === true, lastOpened: Number.isFinite(row.lastOpened) && row.lastOpened >= 0 ? row.lastOpened : 0 };
      const previous = entries.find(item => sameChatTab(item, entry));
      if (previous) {
        if (entry.lastOpened > previous.lastOpened) { previous.title = entry.title; previous.lastOpened = entry.lastOpened; }
        previous.pinned ||= entry.pinned;
      } else entries.push(entry);
    }
    let pins = 0;
    for (const entry of entries) if (entry.pinned && ++pins > maxPinnedChatTabs) entry.pinned = false;
    while (entries.length > maxChatTabs) {
      const oldest = entries.reduce((index, entry, i) => !entry.pinned &&
        (index < 0 || entry.lastOpened < entries[index]!.lastOpened) ? i : index, -1);
      if (oldest < 0) break;
      entries.splice(oldest, 1);
    }
    return entries.sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }
  private change(update: (entries: ChatTab[]) => ChatTab[]) {
    this.owned();
    this.state.entries = update(this.state.entries);
    if (!this.state.hydrated) this.pending.push(update);
    this.revision++;
    this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush(); }, 100);
  }
  /** Safe to call repeatedly. Navigation while storage loads is replayed over
   * the stored catalog, so the first selected chat cannot erase fixed tabs. */
  load(): Promise<void> {
    this.owned();
    if (this.state.hydrated) return Promise.resolve();
    if (this.loading) return this.loading;
    const generation = this.generation, authentication = this.authentication;
    const loading = (async () => {
      await this.options.ready();
      if (!this.current(generation, authentication)) return;
      const stored = await this.persistence.read<StoredTabs>(namespace, identity).catch(() => null);
      if (!this.current(generation, authentication)) return;
      let entries = this.normalize(stored?.version === 1 ? stored.entries : []);
      for (const update of this.pending) entries = update(entries);
      this.pending = [];
      this.state.entries = entries;
      this.state.hydrated = true;
    })().catch(() => {
      // If IndexedDB is unavailable the current window remains usable.
      if (this.current(generation, authentication)) { this.pending = []; this.state.hydrated = true; }
    }).finally(() => { if (this.loading === loading) this.loading = undefined; });
    this.loading = loading;
    return loading;
  }
  open(target: ChatTabTarget & { title?: string }) {
    if (!validTarget(target)) return;
    const owner = { hostId: target.hostId, threadId: target.threadId };
    const title = target.title?.trim() ? titleText(target.title) : undefined;
    const timestamp = this.now();
    this.change(entries => {
      const existing = entries.find(entry => sameChatTab(entry, owner));
      // Monotonic recency also works with fixed clocks and rapid selections.
      const lastOpened = Math.max(timestamp, ...entries.map(entry => entry.lastOpened + 1), 0);
      const updated = existing ? entries.map(entry => sameChatTab(entry, owner)
        ? { ...entry, title: title ?? entry.title, lastOpened } : entry)
        : [...entries, { ...owner, title: title ?? '未命名对话', pinned: false, lastOpened }];
      return this.normalize(updated);
    });
  }
  close(target: ChatTabTarget, active?: ChatTabTarget | null): ChatTab | null {
    this.owned();
    const index = this.state.entries.findIndex(entry => sameChatTab(entry, target));
    if (index < 0) return null;
    const wasActive = sameChatTab(target, active);
    this.remove(target);
    return wasActive ? this.state.entries[Math.min(index, this.state.entries.length - 1)] || null : null;
  }
  /** Explicit native deletion/archive notifications can remove one tab. Never
   * infer deletion from a paginated or temporarily disconnected thread list. */
  remove(target: ChatTabTarget) {
    if (!validTarget(target)) return;
    this.owned();
    if (this.state.hydrated && !this.state.entries.some(entry => sameChatTab(entry, target))) return;
    const owner = { ...target };
    this.change(entries => entries.filter(entry => !sameChatTab(entry, owner)));
  }
  removeHost(hostId: string) {
    if (!validId(hostId)) return;
    this.owned();
    if (this.state.hydrated && !this.state.entries.some(entry => entry.hostId === hostId)) return;
    this.change(entries => entries.filter(entry => entry.hostId !== hostId));
  }
  rename(target: ChatTabTarget, title: string) {
    if (!validTarget(target) || !title.trim()) return;
    this.owned();
    const owner = { ...target }, name = titleText(title);
    const existing = this.state.entries.find(entry => sameChatTab(entry, owner));
    if (existing?.title === name || this.state.hydrated && !existing) return;
    this.change(entries => entries.map(entry => sameChatTab(entry, owner) ? { ...entry, title: name } : entry));
  }
  togglePinned(target: ChatTabTarget): boolean {
    this.owned();
    const tab = this.state.entries.find(entry => sameChatTab(entry, target));
    if (!tab || !tab.pinned && this.state.entries.filter(entry => entry.pinned).length >= maxPinnedChatTabs) return false;
    const owner = { ...target }, pinned = !tab.pinned;
    this.change(entries => {
      if (pinned && entries.filter(entry => entry.pinned && !sameChatTab(entry, owner)).length >= maxPinnedChatTabs) return entries;
      return this.normalize(entries.map(entry => sameChatTab(entry, owner) ? { ...entry, pinned } : entry));
    });
    return true;
  }
  flush(): Promise<void> {
    this.owned();
    clearTimeout(this.timer); this.timer = undefined;
    const generation = this.generation, authentication = this.authentication;
    this.writing = this.writing.then(async () => {
      if (!this.current(generation, authentication)) return;
      await this.load();
      if (!this.current(generation, authentication) || this.savedRevision === this.revision) return;
      const revision = this.revision;
      const entries = this.state.entries.map(entry => ({ ...entry }));
      await this.persistence.write(namespace, identity, { version: 1, entries });
      if (this.current(generation, authentication)) this.savedRevision = revision;
    }).catch(() => { /* Tabs stay usable in memory when site storage is denied. */ });
    return this.writing;
  }
  /** Logout cancels late reads and queued writes. Clearing the shared private
   * store belongs to the existing authentication lifecycle. */
  clear() {
    this.generation++;
    this.authentication = this.options.authentication();
    clearTimeout(this.timer); this.timer = undefined;
    this.loading = undefined;
    this.pending = [];
    this.revision = this.savedRevision = 0;
    this.state.entries = [];
    this.state.hydrated = false;
  }
}
export const createChatTabs = (options: Options) => new ChatTabs(options);
