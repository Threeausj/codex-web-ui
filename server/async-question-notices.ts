import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import { writePrivateJson } from './storage.js';
import { asyncQuestionNoticeKey, validAsyncQuestionNoticeFingerprint, type AsyncQuestionNotice } from '../shared/async-question-notices.js';

const MAX_NOTICES = 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const identifier = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const noticeSchema = z.object({
  hostId: identifier, threadId: identifier, turnId: identifier, itemId: identifier,
  fingerprint: z.string().min(1).max(64 * 1024),
}).strict().refine(notice => validAsyncQuestionNoticeFingerprint(notice.itemId, notice.fingerprint), 'Question fingerprint does not match its item');
const documentSchema = z.object({ version: z.literal(1), dismissals: z.array(noticeSchema).max(MAX_NOTICES) }).strict();
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });

/** A separate private journal keeps dismissal independent from answer receipts. */
export class AsyncQuestionNotices {
  private dismissals: AsyncQuestionNotice[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}

  async init() {
    try {
      const handle = await fs.open(this.file, 'r');
      try {
        if ((await handle.stat()).size > MAX_BYTES) throw failure(413, '问题提醒记录超过容量上限');
        this.dismissals = documentSchema.parse(JSON.parse(await handle.readFile('utf8'))).dismissals;
        if (new Set(this.dismissals.map(asyncQuestionNoticeKey)).size !== this.dismissals.length)
          throw new Error('Duplicate dismissed question identities');
      } finally { await handle.close(); }
      await fs.chmod(this.file, 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  list(): AsyncQuestionNotice[] { return structuredClone(this.dismissals); }

  dismiss(input: unknown): Promise<AsyncQuestionNotice[]> {
    const questions = z.array(noticeSchema).min(1).max(32).parse(input);
    const operation = this.queue.then(async () => {
      const next = new Map(this.dismissals.map(notice => [asyncQuestionNoticeKey(notice), notice]));
      for (const notice of questions) next.set(asyncQuestionNoticeKey(notice), notice);
      if (next.size > MAX_NOTICES) throw failure(409, '已关闭的问题提醒数量达到上限');
      const document = { version: 1, dismissals: [...next.values()] };
      if (Buffer.byteLength(JSON.stringify(document, null, 2) + '\n') > MAX_BYTES)
        throw failure(413, '已关闭的问题提醒记录超过容量上限');
      await writePrivateJson(this.file, document);
      this.dismissals = document.dismissals;
      return structuredClone(questions);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

/** Authentication and CSRF middleware must already be registered. No native RPC. */
export async function registerAsyncQuestionNotices(app: Express, dataDir: string, hostExists: (id: string) => boolean) {
  const notices = new AsyncQuestionNotices(path.join(dataDir, 'async-question-notices.json'));
  await notices.init();
  app.get('/api/async-question-notices', (req, res, next) => {
    try {
      z.object({ _request: z.string().max(256).optional() }).strict().parse(req.query);
      res.json({ dismissals: notices.list().filter(notice => hostExists(notice.hostId)) });
    } catch (error) { next(error); }
  });
  app.post('/api/async-question-notices/dismiss', (req, res, next) => {
    void (async () => {
      const { questions } = z.object({ questions: z.array(noticeSchema).min(1).max(32) }).strict().parse(req.body);
      if (questions.some(notice => !hostExists(notice.hostId))) throw failure(404, '主机不存在');
      res.json({ dismissals: await notices.dismiss(questions) });
    })().catch(next);
  });
  return notices;
}
