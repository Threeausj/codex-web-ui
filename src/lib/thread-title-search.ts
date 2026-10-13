/** Match the navigation title only. A first-line preview is a legacy fallback
 * for unnamed sessions, not an invitation to search the whole prompt. */
export function searchableThreadTitle(thread: { name?: string | null; title?: string | null; preview?: string | null }) {
  return thread.name?.trim() || thread.title?.trim() || thread.preview?.trim().split(/[\r\n]/, 1)[0]?.slice(0, 70) || "未命名对话";
}
function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().trim();
}
export function matchesThreadTitle(thread: Parameters<typeof searchableThreadTitle>[0], query: string) {
  return normalize(searchableThreadTitle(thread)).includes(normalize(query));
}

/** Short-lived metadata-only pages, shared by sidebar and command search.
 * In-flight requests survive no invalidation: their callers can finish, but
 * the results of an earlier revision must never refill the cache. */
export class ThreadTitlePageCache<T> {
  private pages = new Map<string, { expiresAt: number; value: T }>();
  private pending = new Map<string, Promise<T>>();
  constructor(private readonly ttlMs = 30_000, private readonly capacity = 128, private readonly now = Date.now) {}
  query(key: string, fetch: () => Promise<T>): Promise<T> {
    const page = this.pages.get(key);
    if (page && page.expiresAt > this.now()) {
      this.pages.delete(key);
      this.pages.set(key, page);
      return Promise.resolve(page.value);
    }
    this.pages.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = fetch().then(value => {
      if (this.pending.get(key) === request) {
        this.pages.set(key, { expiresAt: this.now() + this.ttlMs, value });
        while (this.pages.size > this.capacity) this.pages.delete(this.pages.keys().next().value!);
      }
      return value;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }
  clear() { this.pages.clear(); this.pending.clear(); }
  clearHost(hostId: string) {
    const prefix = JSON.stringify(hostId) + ":";
    for (const records of [this.pages, this.pending])
      for (const key of records.keys()) if (key.startsWith(prefix)) records.delete(key);
  }
}
