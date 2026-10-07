/** Private, session-scoped snapshots. They only paint history; never restore a writer lease. */
export type ConversationSnapshot = {
  hostId: string;
  threadId: string;
  thread: any;
  items: any[];
  turns: any[];
  tokenUsage: any;
  cursor: string | null;
};
type CacheRecord = ConversationSnapshot & { key: string; scope: string; savedAt: number; bytes: number };
export type ConversationPersistence = {
  read(key: string): Promise<CacheRecord | undefined>;
  write(record: CacheRecord, maxEntries: number, maxBytes: number, oldest: number): Promise<void>;
  remove(key: string): Promise<void>;
  removeHost(scope: string, hostId: string): Promise<void>;
  clear(): Promise<void>;
};
const ttl = 24 * 60 * 60 * 1000;
const maxEntries = 12;
const maxBytes = 4 * 1024 * 1024;
const maxEntryBytes = 768 * 1024;
const identity = (scope: string, hostId: string, threadId: string) => JSON.stringify([scope, hostId, threadId]);

export function indexedConversationPersistence(): ConversationPersistence | undefined {
  if (typeof indexedDB === 'undefined') return;
  let opening: Promise<IDBDatabase> | undefined;
  const database = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('codex-private-conversations', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Conversation cache unavailable'));
  });
  const transaction = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, set: (value: T) => void) => void): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('snapshots', mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      run(tx.objectStore('snapshots'), next => { value = next; });
    });
  };
  return {
    read: key => transaction('readonly', (store, set) => {
      const request = store.get(key);
      request.onsuccess = () => set(request.result);
    }),
    write: (record, count, bytes, oldest) => transaction<void>('readwrite', store => {
      store.put(record);
      const request = store.getAll();
      request.onsuccess = () => {
        let retained = 0;
        let used = 0;
        for (const candidate of (request.result as CacheRecord[]).sort((a, b) => b.savedAt - a.savedAt)) {
          if (candidate.scope !== record.scope || candidate.savedAt < oldest || retained >= count || used + candidate.bytes > bytes)
            store.delete(candidate.key);
          else { retained++; used += candidate.bytes; }
        }
      };
    }),
    remove: key => transaction<void>('readwrite', store => { store.delete(key); }),
    removeHost: (scope, hostId) => transaction<void>('readwrite', store => {
      const request = store.getAll();
      request.onsuccess = () => {
        for (const record of request.result as CacheRecord[])
          if (record.scope === scope && record.hostId === hostId) store.delete(record.key);
      };
    }),
    clear: () => transaction<void>('readwrite', store => { store.clear(); }),
  };
}

/** SHA-256 prevents the session's CSRF credential itself being written to disk. */
export async function conversationSessionScope(credential: string): Promise<string | null> {
  if (!credential || !globalThis.crypto?.subtle) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`codex-cache-v1:${credential}`));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class ConversationCache {
  private records = new Map<string, CacheRecord>();
  private scope = '';
  private generation = 0;
  private revisions = new Map<string, number>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private persistence = indexedConversationPersistence(), private now = () => Date.now()) {}
  activate(scope: string | null) {
    if (this.scope === (scope || '')) return;
    this.generation++;
    this.scope = scope || '';
    this.records.clear();
    this.revisions.clear();
  }
  peek(hostId: string, threadId: string): ConversationSnapshot | null {
    const key = identity(this.scope, hostId, threadId);
    const record = this.records.get(key);
    if (!record) return null;
    if (record.savedAt < this.now() - ttl) { this.records.delete(key); return null; }
    this.records.delete(key);
    this.records.set(key, record);
    return this.copy(record);
  }
  async read(hostId: string, threadId: string): Promise<ConversationSnapshot | null> {
    const cached = this.peek(hostId, threadId);
    if (cached) return cached;
    if (!this.scope || !this.persistence) return null;
    const generation = this.generation;
    const key = identity(this.scope, hostId, threadId);
    const revision = this.revisions.get(key) || 0;
    this.revisions.set(key, revision);
    try {
      // A preceding remove/write must commit before a new disk read starts.
      await this.writes;
      if (generation !== this.generation || (this.revisions.get(key) || 0) !== revision) return null;
      const record = await this.persistence.read(key);
      if (generation !== this.generation || (this.revisions.get(key) || 0) !== revision || !record || record.scope !== this.scope ||
          record.hostId !== hostId || record.threadId !== threadId || record.thread?.id !== threadId ||
          !Array.isArray(record.items) || !Array.isArray(record.turns) || record.savedAt < this.now() - ttl)
        return null;
      this.remember(record);
      return this.copy(record);
    } catch { return null; }
  }
  write(snapshot: ConversationSnapshot) {
    try {
      const copy = this.copy(snapshot);
      const bytes = new TextEncoder().encode(JSON.stringify(copy)).byteLength;
      if (bytes > maxEntryBytes) { this.remove(snapshot.hostId, snapshot.threadId); return; }
      const record: CacheRecord = { ...copy, key: identity(this.scope, snapshot.hostId, snapshot.threadId), scope: this.scope, savedAt: this.now(), bytes };
      this.revisions.set(record.key, (this.revisions.get(record.key) || 0) + 1);
      this.remember(record);
      if (!this.scope || !this.persistence) return;
      const generation = this.generation;
      this.writes = this.writes.then(async () => {
        if (generation === this.generation) await this.persistence!.write(record, maxEntries, maxBytes, this.now() - ttl);
      }).catch(() => {});
    } catch { /* A full/unavailable device cache must never block the conversation. */ }
  }
  remove(hostId: string, threadId: string) {
    const key = identity(this.scope, hostId, threadId);
    this.records.delete(key);
    this.revisions.set(key, (this.revisions.get(key) || 0) + 1);
    const generation = this.generation;
    this.writes = this.writes.then(async () => {
      if (generation === this.generation) await this.persistence?.remove(key);
    }).catch(() => {});
  }
  removeHost(hostId: string) {
    for (const [key, record] of this.records) if (record.hostId === hostId) this.records.delete(key);
    for (const [key, revision] of this.revisions) if (JSON.parse(key)[1] === hostId) this.revisions.set(key, revision + 1);
    const generation = this.generation;
    const scope = this.scope;
    this.writes = this.writes.then(async () => {
      if (generation === this.generation) await this.persistence?.removeHost(scope, hostId);
    }).catch(() => {});
  }
  clear() {
    this.generation++;
    this.scope = '';
    this.records.clear();
    this.revisions.clear();
    this.writes = this.writes.then(() => this.persistence?.clear()).catch(() => {});
    return this.writes;
  }
  flush() { return this.writes; }
  private remember(record: CacheRecord) {
    this.records.delete(record.key);
    this.records.set(record.key, record);
    let bytes = [...this.records.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (this.records.size > maxEntries || bytes > maxBytes) {
      const key = this.records.keys().next().value!;
      bytes -= this.records.get(key)!.bytes;
      this.records.delete(key);
    }
  }
  private copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
}
