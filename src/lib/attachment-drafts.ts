import { indexedPrivatePersistence, type PrivatePersistence } from './private-state';

export type DraftAttachment = {
  id: string; hostId: string; name: string; path: string; mime: string; size: number;
  original?: Blob; lastModified?: number; previewUrl?: string;
};
type Document = { version: 1; hostId: string; files: DraftAttachment[] };
const namespace = 'composer-attachments';
const limit = 64 * 1024 * 1024;
const metadata = (file: DraftAttachment): DraftAttachment => ({
  id: file.id, hostId: file.hostId, name: file.name, path: file.path, mime: file.mime,
  size: file.size, ...(file.original instanceof Blob ? { original: file.original } : {}),
  ...(typeof file.lastModified === 'number' ? { lastModified: file.lastModified } : {}),
});
function valid(value: unknown, hostId: string): value is Document {
  const doc = value as Document;
  return doc?.version === 1 && doc.hostId === hostId && Array.isArray(doc.files) && doc.files.length <= 256 &&
    doc.files.every(file => file && typeof file.id === 'string' && file.hostId === hostId &&
      typeof file.path === 'string' && file.path.startsWith('/') && file.path.length <= 8192 &&
      typeof file.name === 'string' && file.name.length <= 512 && typeof file.mime === 'string' &&
      Number.isFinite(file.size) && file.size >= 0 && (!file.original || file.original instanceof Blob));
}

/** Upload paths, original bytes and previews belong to one authenticated draft.
 * IndexedDB stores Blobs directly; previews are page-local and never persisted.
 * Uses the shared private records store so all unsaved work shares its budget. */
export class AttachmentDraftStore {
  private scope = '';
  private generation = 0;
  private entries = new Map<string, DraftAttachment[]>();
  private revisions = new Map<string, number>();
  private reads = new Map<string, Promise<DraftAttachment[]>>();
  private failures = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private persistence = indexedPrivatePersistence(), private preview = {
    create: (blob: Blob) => URL.createObjectURL(blob), revoke: (url: string) => URL.revokeObjectURL(url),
  }) {}
  activate(scope: string | null) {
    if (this.scope === (scope || '')) return;
    for (const files of this.entries.values()) this.release(files);
    this.scope = scope || ''; this.generation++;
    this.entries.clear(); this.revisions.clear(); this.reads.clear(); this.failures.clear();
  }
  private key(identity: string) { return JSON.stringify([this.scope, namespace, identity]); }
  peek(identity: string) { return this.entries.get(identity); }
  warning(identity: string) { return this.failures.get(identity) || ''; }
  async read(identity: string, hostId: string): Promise<DraftAttachment[]> {
    const cached = this.entries.get(identity);
    if (cached) {
      if (cached.some(file => file.hostId !== hostId)) throw new Error('附件草稿属于另一台主机');
      return cached;
    }
    const pending = this.reads.get(identity); if (pending) return pending;
    const generation = this.generation, revision = this.revisions.get(identity) || 0;
    const key = this.key(identity), scope = this.scope;
    const operation = (async () => {
      await this.writes;
      const row = scope ? await this.persistence?.read(key) : undefined;
      if (generation !== this.generation) return [];
      if ((this.revisions.get(identity) || 0) !== revision) return this.entries.get(identity) || [];
      const files = row?.scope === scope && row.bytes <= limit && valid(row.value, hostId)
        ? row.value.files.map(file => ({ ...metadata(file),
          ...(file.mime.startsWith('image/') && file.original ? { previewUrl: this.preview.create(file.original) } : {}),
        })) : [];
      this.entries.set(identity, files);
      // Empty visits contain no unsaved work and can be read again. Do not let
      // temporary host/path transitions fill the unsaved-draft quota.
      if (this.entries.size > 256) for (const [id, values] of this.entries) {
        if (!values.length && id !== identity) this.entries.delete(id);
        if (this.entries.size <= 256) break;
      }
      return files;
    })().finally(() => { if (this.reads.get(identity) === operation) this.reads.delete(identity); });
    this.reads.set(identity, operation); return operation;
  }
  save(identity: string, hostId: string, files: DraftAttachment[]) {
    if (files.some(file => file.hostId !== hostId)) throw new Error('附件属于另一台主机，未加入当前草稿');
    this.entries.set(identity, files);
    this.revisions.set(identity, (this.revisions.get(identity) || 0) + 1);
    const key = this.key(identity), generation = this.generation, scope = this.scope;
    const value: Document = { version: 1, hostId, files: files.map(metadata) };
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength + value.files.reduce((size, file) => size + (file.original?.size || 0), 0);
    const operation = this.writes.then(async () => {
      if (generation !== this.generation) return;
      if (!scope || !this.persistence) throw new Error('浏览器无法持久保存附件，附件仅保留在当前页面');
      if (bytes > limit || value.files.length > 256 || [...this.entries.values()].filter(values => values.length).length > 256)
        throw new Error('附件草稿存储已达上限，附件仅保留在当前页面');
      if (!value.files.length) await this.persistence.remove(key);
      else await this.persistence.write({ key, scope, value, bytes });
    });
    const result = operation.then(() => { if (generation === this.generation) this.failures.delete(identity); }, cause => {
      if (generation === this.generation) this.failures.set(identity, cause.message || '附件草稿保存失败');
      throw cause;
    });
    this.writes = result.catch(() => {}); return result;
  }
  append(identity: string, hostId: string, additions: DraftAttachment[]) {
    const generation = this.generation;
    return this.read(identity, hostId).then(() => {
      if (generation !== this.generation) return;
      return this.save(identity, hostId, [...(this.entries.get(identity) || []), ...additions]);
    });
  }
  consume(identity: string, hostId: string, files: DraftAttachment[]) {
    const ids = new Set(files.map(file => file.id));
    const current = this.entries.get(identity) || [];
    const removed = current.filter(file => ids.has(file.id));
    this.release(removed);
    return this.save(identity, hostId, current.filter(file => !ids.has(file.id)));
  }
  forget(identity: string, hostId: string) {
    this.release(this.entries.get(identity) || []);
    return this.save(identity, hostId, []);
  }
  forgetHost(hostId: string) {
    return Promise.all([...this.entries.keys()].filter(identity => {
      try { return JSON.parse(identity)[0] === hostId; } catch { return false; }
    }).map(identity => this.forget(identity, hostId)));
  }
  release(files: DraftAttachment[]) {
    for (const file of files) if (file.previewUrl) this.preview.revoke(file.previewUrl);
  }
  flush() { return this.writes; }
}

export function attachmentDraftIdentity(hostId: string, threadId: string | undefined, projectPath: string, noProject: boolean) {
  return JSON.stringify([hostId, threadId ? ['thread', threadId] : ['new', noProject ? null : projectPath || 'new']]);
}
