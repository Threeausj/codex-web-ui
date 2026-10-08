/** Durable private drafts and operation receipts. Never silently evict unsaved work. */
export type PrivateRecord = { key: string; scope: string; value: unknown; bytes: number };
export interface PrivatePersistence {
  read(key: string): Promise<PrivateRecord | undefined>;
  write(record: PrivateRecord): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}
export function indexedPrivatePersistence(): PrivatePersistence | undefined {
  if (typeof indexedDB === 'undefined') return;
  let opening: Promise<IDBDatabase> | undefined;
  const database = () => opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('codex-private-work', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = undefined; reject(request.error); };
    request.onblocked = () => { opening = undefined; reject(new Error('私人草稿存储被其他窗口阻塞')); };
  });
  const transaction = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, set: (value: T) => void) => void) => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('records', mode); let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('私人草稿存储失败'));
      run(tx.objectStore('records'), value => { result = value; });
    });
  };
  return {
    read: key => transaction('readonly', (store, set) => { const req = store.get(key); req.onsuccess = () => set(req.result); }),
    write: record => transaction<void>('readwrite', store => {
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as PrivateRecord[]).filter(row => row.key !== record.key);
        if (rows.length >= 256 || rows.reduce((sum, row) => sum + row.bytes, record.bytes) > 64 * 1024 * 1024) {
          store.transaction.abort(); return;
        }
        store.put(record);
      };
    }),
    remove: key => transaction<void>('readwrite', store => { store.delete(key); }),
    clear: () => transaction<void>('readwrite', store => { store.clear(); }),
  };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export class PrivateState {
  private scope = '';
  private generation = 0;
  private memory = new Map<string, unknown>();
  private memoryBytes = new Map<string, number>();
  private pendingReads = new Map<string, { revision: number; readers: number }>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private persistence = indexedPrivatePersistence()) {}
  activate(scope: string | null) {
    if (this.scope === (scope || '')) return;
    this.generation++; this.scope = scope || ''; this.memory.clear(); this.memoryBytes.clear(); this.pendingReads.clear();
  }
  private key(namespace: string, identity: string) { return JSON.stringify([this.scope, namespace, identity]); }
  async read<T>(namespace: string, identity: string): Promise<T | null> {
    const key = this.key(namespace, identity), generation = this.generation;
    if (this.memory.has(key)) return copy(this.memory.get(key) as T);
    if (!this.scope || !this.persistence) return null;
    const pending = this.pendingReads.get(key) || { revision: 0, readers: 0 };
    this.pendingReads.set(key, pending); pending.readers++;
    const revision = pending.revision;
    try {
      await this.writes;
      const row = await this.persistence.read(key);
      if (generation !== this.generation) return null;
      // A slow read cannot resurrect a removed receipt or replace a newer
      // draft written while storage was reading the previous version.
      if (revision !== pending.revision) return this.memory.has(key) ? copy(this.memory.get(key) as T) : null;
      if (!row || row.scope !== this.scope) return null;
      if (this.memory.size < 256 && [...this.memoryBytes.values()].reduce((sum, bytes) => sum + bytes, row.bytes) <= 64 * 1024 * 1024) {
        this.memory.set(key, row.value); this.memoryBytes.set(key, row.bytes);
      }
      return copy(row.value as T);
    } finally {
      if (--pending.readers === 0 && this.pendingReads.get(key) === pending) this.pendingReads.delete(key);
    }
  }
  async write<T>(namespace: string, identity: string, value: T, durable = false): Promise<void> {
    const key = this.key(namespace, identity), generation = this.generation;
    const record = { key, scope: this.scope, value: copy(value), bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength };
    if (!this.memory.has(key) && this.memory.size >= 256) throw new Error('私人草稿或操作回执已达上限，请先清理已保存的文件标签');
    if ([...this.memoryBytes].reduce((sum, [entry, bytes]) => sum + (entry === key ? 0 : bytes), record.bytes) > 64 * 1024 * 1024)
      throw new Error('私人草稿存储已超过 64 MB，请先保存并关闭部分文件标签');
    const pending = this.pendingReads.get(key); if (pending) pending.revision++;
    this.memory.set(key, record.value);
    this.memoryBytes.set(key, record.bytes);
    const operation = this.writes.then(async () => {
      if (generation !== this.generation) throw new Error('登录已变更，已取消保存');
      if (!record.scope || !this.persistence) {
        if (durable) throw new Error('此浏览器无法保存操作凭据，请使用 HTTPS 并启用网站存储');
        throw new Error('草稿只保留在当前页面；请使用 HTTPS 并启用网站存储');
      }
      await this.persistence.write(record);
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  remove(namespace: string, identity: string) {
    const key = this.key(namespace, identity), generation = this.generation;
    const pending = this.pendingReads.get(key); if (pending) pending.revision++;
    this.memory.delete(key);
    this.memoryBytes.delete(key);
    const operation = this.writes.then(async () => { if (generation === this.generation) await this.persistence?.remove(key); });
    this.writes = operation.catch(() => {}); return operation;
  }
  clear() {
    this.generation++; this.scope = ''; this.memory.clear(); this.memoryBytes.clear(); this.pendingReads.clear();
    this.writes = this.writes.then(() => this.persistence?.clear()).catch(() => {});
    return this.writes;
  }
  flush() { return this.writes; }
}
export const privateState = new PrivateState();
