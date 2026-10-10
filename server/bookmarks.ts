import type { Express } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writePrivateJson } from './storage.js';
import type { BookmarkScope, ConversationBookmark, ConversationBookmarkInput } from '../shared/bookmarks.js';

export const MAX_BOOKMARKS = 1000;
export const MAX_BOOKMARK_BYTES = 8 * 1024 * 1024;
const identifier = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Control characters are not allowed');
const name = z.string().trim().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Control characters are not allowed');
const projectPath = z.string().min(1).max(4096)
  .refine(value => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value), 'An absolute project path is required')
  .transform(value => path.posix.normalize(value).replace(/\/$/, '') || '/');
const scopeSchema = z.object({ hostId: identifier, projectPath }).strict();
const queryScopeSchema = scopeSchema.extend({ _request: z.string().max(256).optional() })
  .transform(({ hostId, projectPath }) => ({ hostId, projectPath }));
export const bookmarkInput = scopeSchema.extend({
  name,
  source: z.object({
    threadId: identifier,
    turnId: identifier,
    itemId: identifier,
    text: z.string().min(1).max(16000).refine(value => !!value.trim() && !value.includes('\0'), 'Select conversation text to bookmark'),
    threadName: z.string().max(1000).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Control characters are not allowed'),
  }).strict(),
}).strict();
const bookmarkId = z.string().uuid();
const bookmarkSchema = bookmarkInput.extend({
  id: bookmarkId,
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
}).strict();
const persistedSchema = z.object({ version: z.literal(1), bookmarks: z.array(bookmarkSchema).max(MAX_BOOKMARKS) }).strict();
const matchingScope = (bookmark: BookmarkScope, scope: BookmarkScope) => bookmark.hostId === scope.hostId && bookmark.projectPath === scope.projectPath;
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });
const missing = () => failure(404, '收藏不存在或已移除');

/** Dedicated, serialized writes keep another browser's bookmark edits intact. */
export class Bookmarks {
  private bookmarks: ConversationBookmark[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}

  async init() {
    try {
      const handle = await fs.open(this.file, 'r');
      try {
        if ((await handle.stat()).size > MAX_BOOKMARK_BYTES) throw failure(413, '收藏文件超过容量上限');
        const document = persistedSchema.parse(JSON.parse(await handle.readFile('utf8')));
        if (new Set(document.bookmarks.map(bookmark => bookmark.id)).size !== document.bookmarks.length)
          throw new Error('Duplicate bookmark ids in saved bookmarks');
        this.bookmarks = document.bookmarks;
      } finally { await handle.close(); }
      await fs.chmod(this.file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  list(input: unknown): ConversationBookmark[] {
    const scope = scopeSchema.parse(input);
    return structuredClone(this.bookmarks.filter(bookmark => matchingScope(bookmark, scope))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)));
  }

  add(input: unknown): Promise<ConversationBookmark> {
    const validated = bookmarkInput.parse(input);
    return this.mutate(async () => {
      const duplicate = this.bookmarks.find(bookmark => matchingScope(bookmark, validated) &&
        bookmark.source.threadId === validated.source.threadId && bookmark.source.turnId === validated.source.turnId &&
        bookmark.source.itemId === validated.source.itemId && bookmark.source.text === validated.source.text);
      if (duplicate) return structuredClone(duplicate);
      if (this.bookmarks.length >= MAX_BOOKMARKS) throw failure(409, '收藏数量已达上限，请先移除不需要的收藏');
      const timestamp = Date.now();
      const bookmark: ConversationBookmark = { ...validated, id: randomUUID(), createdAt: timestamp, updatedAt: timestamp };
      await this.save([...this.bookmarks, bookmark]);
      return structuredClone(bookmark);
    });
  }

  rename(id: unknown, inputScope: unknown, input: unknown): Promise<ConversationBookmark> {
    const validatedId = bookmarkId.parse(id);
    const scope = scopeSchema.parse(inputScope);
    const patch = z.object({ name }).strict().parse(input);
    return this.mutate(async () => {
      const index = this.bookmarks.findIndex(bookmark => bookmark.id === validatedId && matchingScope(bookmark, scope));
      if (index < 0) throw missing();
      const bookmark = { ...this.bookmarks[index]!, name: patch.name, updatedAt: Date.now() };
      const next = [...this.bookmarks];
      next[index] = bookmark;
      await this.save(next);
      return structuredClone(bookmark);
    });
  }

  remove(id: unknown, inputScope: unknown): Promise<void> {
    const validatedId = bookmarkId.parse(id);
    const scope = scopeSchema.parse(inputScope);
    return this.mutate(async () => {
      if (!this.bookmarks.some(bookmark => bookmark.id === validatedId && matchingScope(bookmark, scope))) throw missing();
      await this.save(this.bookmarks.filter(bookmark => bookmark.id !== validatedId));
    });
  }

  private async save(next: ConversationBookmark[]) {
    const document = { version: 1, bookmarks: next };
    if (Buffer.byteLength(JSON.stringify(document, null, 2) + '\n') > MAX_BOOKMARK_BYTES)
      throw failure(413, '收藏内容超过容量上限，请先移除不需要的收藏');
    await writePrivateJson(this.file, document);
    this.bookmarks = next;
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(work);
    this.queue = operation.catch(() => {});
    return operation;
  }
}

/** Register after the application's authentication and CSRF middleware. */
export async function registerBookmarks(app: Express, dataDir: string, hostExists: (id: string) => boolean) {
  const bookmarks = new Bookmarks(path.join(dataDir, 'bookmarks.json'));
  await bookmarks.init();
  const checkedScope = (input: unknown): BookmarkScope => {
    const scope = queryScopeSchema.parse(input);
    if (!hostExists(scope.hostId)) throw failure(404, '主机不存在');
    return scope;
  };
  app.get('/api/bookmarks', (req, res, next) => {
    try { res.json({ bookmarks: bookmarks.list(checkedScope(req.query)) }); }
    catch (error) { next(error); }
  });
  app.post('/api/bookmarks', (req, res, next) => {
    void (async () => {
      const input: ConversationBookmarkInput = bookmarkInput.parse(req.body);
      checkedScope({ hostId: input.hostId, projectPath: input.projectPath });
      res.status(201).json({ bookmark: await bookmarks.add(input) });
    })().catch(next);
  });
  app.patch('/api/bookmarks/:id', (req, res, next) => {
    void (async () => res.json({ bookmark: await bookmarks.rename(req.params.id, checkedScope(req.query), req.body) }))().catch(next);
  });
  app.delete('/api/bookmarks/:id', (req, res, next) => {
    void (async () => { await bookmarks.remove(req.params.id, checkedScope(req.query)); res.json({ ok: true }); })().catch(next);
  });
  return bookmarks;
}
