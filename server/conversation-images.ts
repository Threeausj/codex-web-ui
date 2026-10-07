import path from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import type { Bridge } from './bridge.js';

const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
/** Registered behind the application's session authentication. Reads stay bound
 * to the attachment's host, even when another browser switches workstations. */
export function registerConversationImages(app: Express, getBridge: (hostId: string) => Promise<Bridge>) {
  app.get('/api/hosts/:id/images', (req, res, next) => {
    void (async () => {
      const file = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\x00-\x1f]/.test(value)).parse(req.query.path);
      const type = mime[path.posix.extname(file).toLowerCase()];
      if (!type) { res.status(415).json({ error: '此文件不是支持的图片' }); return; }
      const bridge = await getBridge(String(req.params.id));
      const result = await bridge.request('fs/readFile', { path: file }, 15000) as { dataBase64: string };
      if (result.dataBase64.length > Math.ceil(8 * 1024 * 1024 * 4 / 3)) { res.status(413).json({ error: '图片超过 8 MB' }); return; }
      res.set({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer' });
      res.send(Buffer.from(result.dataBase64, 'base64'));
    })().catch(next);
  });
}
