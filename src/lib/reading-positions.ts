import { privateState } from './private-state';

export type ReadingPosition = { top: number; bottom: boolean; anchor?: { historyId: string; offset: number } };
type Entry = ReadingPosition & { key: string };
const namespace = 'reading-positions';
const identity = 'recent';
export const isReadingPosition = (value: any): value is ReadingPosition =>
  Number.isFinite(value?.top) && value.top >= 0 && typeof value.bottom === 'boolean' &&
  (value.anchor === undefined || typeof value.anchor?.historyId === 'string' && value.anchor.historyId.length <= 512 &&
    Number.isFinite(value.anchor.offset));
const valid = (value: any): value is Entry => typeof value?.key === 'string' && isReadingPosition(value);
const copyPosition = (position: ReadingPosition): ReadingPosition => ({
  top: position.top,
  bottom: position.bottom,
  ...(position.anchor ? { anchor: { ...position.anchor } } : {}),
});

/** Small, bounded, session-scoped reading positions survive a discarded PWA window. */
export class ReadingPositions {
  private pending = new Map<string, Entry & { authentication: number }>();
  private memory = new Map<string, ReadingPosition>();
  private memoryAuthentication: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  constructor(private ready: () => Promise<void>, private authentication: () => number) {}
  private key(hostId: string, threadId: string) { return JSON.stringify([hostId, threadId]); }
  private currentAuthentication() {
    const authentication = this.authentication();
    if (authentication !== this.memoryAuthentication) {
      this.memoryAuthentication = authentication;
      this.memory.clear();
      this.pending.clear();
      clearTimeout(this.timer); this.timer = undefined;
    }
    return authentication;
  }
  private retain(key: string, position: ReadingPosition) {
    this.memory.delete(key);
    this.memory.set(key, copyPosition(position));
    while (this.memory.size > 32) this.memory.delete(this.memory.keys().next().value!);
  }
  /** Available before IndexedDB or login-scoped storage finishes its reads. */
  peek(hostId: string, threadId: string): ReadingPosition | null {
    this.currentAuthentication();
    const key = this.key(hostId, threadId), position = this.memory.get(key);
    if (!position) return null;
    this.memory.delete(key); this.memory.set(key, position);
    return copyPosition(position);
  }
  remember(hostId: string, threadId: string, position: ReadingPosition) {
    const authentication = this.currentAuthentication();
    if (!isReadingPosition(position)) return;
    const key = this.key(hostId, threadId);
    this.retain(key, position);
    this.pending.set(key, { key, ...copyPosition(position), authentication });
    // Throttle instead of resetting on every scroll: long gestures should
    // still commit progress before Android discards the page.
    this.timer ??= setTimeout(() => { void this.flush(); }, 150);
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const authentication = this.currentAuthentication();
    const batch = [...this.pending.values()].filter(entry => entry.authentication === authentication); this.pending.clear();
    if (!batch.length) return this.writing;
    this.writing = this.writing.then(async () => {
      await this.ready();
      if (authentication !== this.authentication()) return;
      const saved = await privateState.read<Entry[]>(namespace, identity);
      if (authentication !== this.authentication()) return;
      const entries = new Map((Array.isArray(saved) ? saved.filter(valid) : []).map(entry => [entry.key, entry]));
      for (const { authentication: owner, ...entry } of batch) {
        if (owner !== authentication || !valid(entry)) continue;
        entries.delete(entry.key); entries.set(entry.key, entry);
      }
      await privateState.write(namespace, identity, [...entries.values()].slice(-32));
    }).catch(() => { /* The window's sessionStorage remains a fallback. */ });
    return this.writing;
  }
  async read(hostId: string, threadId: string): Promise<ReadingPosition | null> {
    const authentication = this.currentAuthentication();
    const key = this.key(hostId, threadId), previous = this.memory.get(key);
    await this.flush();
    await this.ready();
    if (authentication !== this.authentication()) return null;
    const saved = await privateState.read<Entry[]>(namespace, identity).catch(() => null);
    if (authentication !== this.authentication() || !Array.isArray(saved)) return null;
    // A scroll remembered while storage was reading must stay ahead of that
    // older answer, both for this read and the next synchronous navigation.
    const current = this.memory.get(key);
    if (current && current !== previous) return copyPosition(current);
    const position = saved.find(entry => valid(entry) && entry.key === key);
    if (!position) return null;
    this.retain(key, position);
    return copyPosition(position);
  }
}
