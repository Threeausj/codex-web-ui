import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Express } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Bridge } from './bridge.js';

export const fileVersion = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const filePath = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\x00-\x1f\\]/.test(value), '需要绝对文件路径').transform(value => path.posix.normalize(value));
const maximum = 8 * 1024 * 1024;

/** Serialize web saves on a host/path. Codex fs/writeFile has no CAS parameter:
 * this detects existing external edits, but cannot lock an unrelated CLI writer. */
export function registerFiles(app: Express, getBridge: (hostId: string) => Promise<Bridge>) {
  const pending = new Map<string, Promise<void>>();
  async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = pending.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    pending.set(key, current);
    await previous;
    try { return await action(); }
    finally { release(); if (pending.get(key) === current) pending.delete(key); }
  }
  async function read(bridge: Bridge, path: string) {
    const result = await bridge.request('fs/readFile', { path }, 45000) as { dataBase64: string };
    if (result.dataBase64.length > Math.ceil(maximum * 4 / 3)) throw Object.assign(new Error('文件超过 8 MB，请使用终端读取'), { status: 413 });
    const bytes = Buffer.from(result.dataBase64, 'base64');
    if (bytes.length > maximum) throw Object.assign(new Error('文件超过 8 MB，请使用终端读取'), { status: 413 });
    return { dataBase64: result.dataBase64, version: fileVersion(bytes) };
  }
  app.get('/api/hosts/:id/files', (req, res, next) => {
    void (async () => {
      const path = filePath.parse(req.query.path);
      const bridge = await getBridge(String(req.params.id));
      res.set('Cache-Control', 'no-store').json(await read(bridge, path));
    })().catch(next);
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maximum, files: 1, fields: 2, fieldSize: 4096 } }).single('file');
  app.post('/api/hosts/:id/files', upload, (req, res, next) => {
    void (async () => {
      const input = z.object({ path: filePath, expectedVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
      if (!req.file) { res.status(400).json({ error: '缺少文件内容' }); return; }
      const id = String(req.params.id);
      await exclusive(`${id}\0${input.path}`, async () => {
        const bridge = await getBridge(id);
        const original = await read(bridge, input.path);
        if (original.version !== input.expectedVersion) {
          res.status(409).json({ code: 'FILE_CONFLICT', error: '文件已被其他程序修改；你的草稿已保留，请先比较或重新载入。' });
          return;
        }
        const bytes = req.file!.buffer;
        await bridge.request('fs/writeFile', { path: input.path, dataBase64: bytes.toString('base64') }, 45000);
        res.json({ version: fileVersion(bytes) });
      });
    })().catch(next);
  });
}
