import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Express, RequestHandler } from 'express';
import type { Bridge } from './bridge.js';
import type { Host, AuthenticatedRequest } from './types.js';

type PreviewDependencies = {
  getBridge: (hostId?: string) => Promise<Bridge>;
  getHost: (id: string) => Host | undefined;
  requireAuth: RequestHandler;
  requireCsrf: RequestHandler;
  allowedOrigins: Set<string>;
  isSessionActive: (sessionId: string) => boolean;
};
type Ticket = { sessionId: string; hostId: string; root: string; expiresAt: number };
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
};
export function withinRoot(root: string, target: string) {
  const relative = path.posix.relative(root, target);
  return relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative);
}
export function rewritePreviewAssets(source: string, base: string, extension: string) {
  if (/^\.html?$/.test(extension)) {
    // Root-relative static assets (including Vite build output) must resolve
    // inside this preview, not against the Codex application's own origin.
    return source.replace(/(\b(?:src|href|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${base}/`);
  }
  if (extension === '.css') return source.replace(/(url\(\s*["']?)\/(?!\/)/gi, `$1${base}/`);
  return source;
}

/** A sandboxed, session-bound static preview. Never acts as an HTTP proxy. */
export function registerPreview(app: Express, deps: PreviewDependencies) {
  const tickets = new Map<string, Ticket>();
  app.get('/api/preview', deps.requireAuth, (req: AuthenticatedRequest, res) => {
    const hostId = typeof req.query.host === 'string' ? req.query.host : 'local';
    const file = typeof req.query.path === 'string' ? req.query.path : '';
    if (!deps.getHost(hostId) || !file.startsWith('/') || file.includes('\0')) { res.status(400).send('请选择主机和绝对文件路径'); return; }
    const target = path.posix.normalize(file);
    const requestedRoot = typeof req.query.root === 'string' ? req.query.root : '';
    const root = requestedRoot.startsWith('/') && withinRoot(path.posix.normalize(requestedRoot), target) ? path.posix.normalize(requestedRoot) : path.posix.dirname(target);
    for (const [id, ticket] of tickets) if (ticket.expiresAt < Date.now()) tickets.delete(id);
    if (tickets.size >= 256) tickets.delete(tickets.keys().next().value!);
    const id = randomBytes(24).toString('base64url');
    tickets.set(id, { sessionId: req.session!.id, hostId, root, expiresAt: Date.now() + 60 * 60 * 1000 });
    const relative = path.posix.relative(root, target).split('/').map(encodeURIComponent).join('/');
    res.set('Cache-Control', 'no-store').redirect(`/api/preview-files/${id}/${relative}`);
  });
  // Opaque sandbox origins omit SameSite cookies on subresources. The random
  // ticket is a short-lived capability, invalidated as soon as its session ends.
  app.get('/api/preview-files/:ticket/*asset', async (req: AuthenticatedRequest, res) => {
    const ticket = tickets.get(String(req.params.ticket));
    if (!ticket || !deps.isSessionActive(ticket.sessionId) || ticket.expiresAt < Date.now()) { res.status(403).send('预览已过期，请重新打开'); return; }
    const raw = req.params.asset;
    const relative = Array.isArray(raw) ? raw.join('/') : String(raw);
    const target = path.posix.resolve(ticket.root, relative);
    if (!withinRoot(ticket.root, target) || relative.includes('\0')) { res.status(403).send('文件超出预览目录'); return; }
    const bridge = await deps.getBridge(ticket.hostId);
    // Do not let a preview script follow symlinks out of its selected root.
    let segmentPath = ticket.root;
    for (const segment of path.posix.relative(ticket.root, target).split('/')) {
      segmentPath = path.posix.join(segmentPath, segment);
      const meta = await bridge.request('fs/getMetadata', { path: segmentPath }) as { isSymlink: boolean; isFile: boolean; isDirectory: boolean };
      if (meta.isSymlink) { res.status(403).send('预览不跟随符号链接'); return; }
    }
    const result = await bridge.request('fs/readFile', { path: target }) as { dataBase64: string };
    if (result.dataBase64.length > Math.ceil(16 * 1024 * 1024 * 4 / 3)) { res.status(413).send('预览文件超过 16 MB'); return; }
    res.set({
      'Content-Type': MIME[path.posix.extname(target).toLowerCase()] ?? 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src data: blob: http: https:; font-src data: http: https:; media-src data: blob: http: https:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    });
    const bytes = Buffer.from(result.dataBase64, 'base64');
    const extension = path.posix.extname(target).toLowerCase();
    res.send(['.html', '.htm', '.css'].includes(extension)
      ? rewritePreviewAssets(bytes.toString('utf8'), `/api/preview-files/${req.params.ticket}`, extension)
      : bytes);
  });
}
