import { privateState } from './private-state';

export type ReadingPosition = { top: number; bottom: boolean };
type Entry = ReadingPosition & { key: string };
const namespace = 'reading-positions';
const identity = 'recent';
const valid = (value: any): value is Entry => typeof value?.key === 'string' &&
  Number.isFinite(value.top) && value.top >= 0 && typeof value.bottom === 'boolean';

/** Small, bounded, session-scoped reading positions survive a discarded PWA window. */
export class ReadingPositions {
  private pending = new Map<string, Entry & { authentication: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  constructor(private ready: () => Promise<void>, private authentication: () => number) {}
  private key(hostId: string, threadId: string) { return JSON.stringify([hostId, threadId]); }
  remember(hostId: string, threadId: string, position: ReadingPosition) {
    const key = this.key(hostId, threadId);
    this.pending.set(key, { key, ...position, authentication: this.authentication() });
    // Throttle instead of resetting on every scroll: long gestures should
    // still commit progress before Android discards the page.
    this.timer ??= setTimeout(() => { void this.flush(); }, 150);
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const authentication = this.authentication();
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
    const authentication = this.authentication();
    await this.flush();
    await this.ready();
    if (authentication !== this.authentication()) return null;
    const saved = await privateState.read<Entry[]>(namespace, identity).catch(() => null);
    if (authentication !== this.authentication() || !Array.isArray(saved)) return null;
    return saved.find(entry => valid(entry) && entry.key === this.key(hostId, threadId)) || null;
  }
}
