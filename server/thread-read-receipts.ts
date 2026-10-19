import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import { writePrivateJson } from './storage.js';
import {
  isStoredThreadReadReceipt, isThreadReadReceipt, threadReadReceiptKey,
  MAX_THREAD_READ_RECEIPTS, MAX_THREAD_READ_TURN_IDS, MAX_THREAD_READ_RECEIPT_BATCH,
  type ThreadReadReceipt, type StoredThreadReadReceipt,
} from '../shared/thread-read-receipts.js';

export const MAX_THREAD_READ_RECEIPT_BYTES = 4 * 1024 * 1024;
const receiptSchema = z.custom<ThreadReadReceipt>(isThreadReadReceipt, 'Invalid thread read receipt');
const storedSchema = z.custom<StoredThreadReadReceipt>(isStoredThreadReadReceipt, 'Invalid stored thread read receipt');
const batchSchema = z.array(receiptSchema).min(1).max(MAX_THREAD_READ_RECEIPT_BATCH);
const documentSchema = z.object({ version: z.literal(1), receipts: z.array(storedSchema).max(MAX_THREAD_READ_RECEIPTS) }).strict();
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });
type Listener = (receipts: StoredThreadReadReceipt[]) => void;

/** Shared across authenticated devices. No message body, native RPC, or device clock is stored. */
export class ThreadReadReceipts {
  private receipts: StoredThreadReadReceipt[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<Listener>();
  constructor(readonly file: string, private hostExists: (id: string) => boolean = () => true) {}

  async init() {
    try {
      const handle = await fs.open(this.file, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_THREAD_READ_RECEIPT_BYTES) throw failure(413, '已读记录超过容量上限');
        const document = documentSchema.parse(JSON.parse(await handle.readFile('utf8')));
        if (new Set(document.receipts.map(threadReadReceiptKey)).size !== document.receipts.length)
          throw new Error('Duplicate thread read receipt identities');
        this.receipts = document.receipts;
      } finally { await handle.close(); }
      await fs.chmod(this.file, 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  list(): StoredThreadReadReceipt[] {
    return structuredClone(this.receipts.filter(receipt => this.hostExists(receipt.hostId)));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  acknowledge(input: unknown): Promise<StoredThreadReadReceipt[]> {
    const receipts = structuredClone(batchSchema.parse(input));
    const operation = this.queue.then(async () => {
      if (receipts.some(receipt => !this.hostExists(receipt.hostId))) throw failure(404, '主机不存在');
      const next = new Map(this.receipts.map(receipt => [threadReadReceiptKey(receipt), receipt]));
      const touched = new Set<string>();
      const changed = new Set<string>();
      for (const receipt of receipts) {
        const key = threadReadReceiptKey(receipt);
        touched.add(key);
        const previous = next.get(key);
        const turnIds = previous?.turnIds.includes(receipt.turnId) ? previous.turnIds :
          (previous && receipt.activityAt < previous.activityAt ? [receipt.turnId, ...previous.turnIds] : [...(previous?.turnIds ?? []), receipt.turnId]).slice(-MAX_THREAD_READ_TURN_IDS);
        const activityAt = Math.max(previous?.activityAt ?? 0, receipt.activityAt);
        if (previous && turnIds.length === previous.turnIds.length && turnIds.every((id, index) => id === previous.turnIds[index]) && activityAt === previous.activityAt) continue;
        const merged = { hostId: receipt.hostId, threadId: receipt.threadId, turnIds, activityAt };
        // Move changed records to the end, bounding the journal by recent acknowledgements.
        next.delete(key);
        next.set(key, merged);
        changed.add(key);
      }
      if (!changed.size) return structuredClone([...touched].map(key => next.get(key)!));
      // Account for writePrivateJson's indentation without repeatedly encoding a
      // multi-megabyte journal. Never evict the entries acknowledged by this batch.
      const entryBytes = (receipt: StoredThreadReadReceipt) => Buffer.byteLength(JSON.stringify(receipt, null, 2)) + 4 * (receipt.turnIds.length + 7) + 2;
      let bytes = 64 + [...next.values()].reduce((total, receipt) => total + entryBytes(receipt), 0);
      for (const [key, receipt] of next) {
        if (next.size <= MAX_THREAD_READ_RECEIPTS && bytes <= MAX_THREAD_READ_RECEIPT_BYTES) break;
        if (touched.has(key)) continue;
        bytes -= entryBytes(receipt);
        next.delete(key);
      }
      const document = { version: 1 as const, receipts: [...next.values()] };
      if (Buffer.byteLength(JSON.stringify(document, null, 2) + '\n') > MAX_THREAD_READ_RECEIPT_BYTES)
        throw failure(413, '已读记录超过容量上限');
      await writePrivateJson(this.file, document);
      this.receipts = document.receipts;
      const updates = [...changed].map(key => next.get(key)).filter((receipt): receipt is StoredThreadReadReceipt => !!receipt);
      for (const listener of this.listeners) {
        try { listener(structuredClone(updates)); } catch { /* One notification consumer cannot roll back a persisted acknowledgement. */ }
      }
      return structuredClone([...touched].map(key => next.get(key)).filter((receipt): receipt is StoredThreadReadReceipt => !!receipt));
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

/** Register after the application's authentication and CSRF middleware. */
export async function registerThreadReadReceipts(app: Express, dataDir: string, hostExists: (id: string) => boolean) {
  const receipts = new ThreadReadReceipts(path.join(dataDir, 'thread-read-receipts.json'), hostExists);
  await receipts.init();
  app.get('/api/thread-read-receipts', (req, res, next) => {
    try {
      z.object({ _request: z.string().max(256).optional() }).strict().parse(req.query);
      res.json({ receipts: receipts.list() });
    } catch (error) { next(error); }
  });
  app.post('/api/thread-read-receipts', (req, res, next) => {
    void (async () => {
      const body = z.object({ receipts: batchSchema }).strict().parse(req.body);
      res.json({ receipts: await receipts.acknowledge(body.receipts) });
    })().catch(next);
  });
  return receipts;
}
