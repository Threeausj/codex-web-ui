import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Auth } from './auth.js';
import { registerWorkspaceUploads, writeHostFileUpload } from './workspace-upload.js';
import { fileTransferScript } from './file-transfer.js';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Host } from './types.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-upload-fixture-'));
  const origin = 'http://localhost:8787', host: Host = { id: 'local', kind: 'local', name: 'Local' };
  const app = express(), auth = new Auth('isolated-upload-test', new Set([origin]), false);
  app.use(express.json());app.post('/api/auth/login', auth.login);app.use('/api', auth.requireAuth, auth.requireCsrf);
  registerWorkspaceUploads(app, { getHost: id => id === 'local' ? host : undefined });
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error instanceof multer.MulterError ? 413 : error instanceof z.ZodError ? 400 : error.status || 500).json({ error: error.message }));
  const server = http.createServer(app);await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'isolated-upload-test' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!, { csrfToken } = await login.json() as any;
  const headers = { origin, cookie, 'x-csrf-token': csrfToken };
  const upload = (name: string, bytes = Buffer.from('data'), overrides: { directory?: string; host?: string; headers?: any; second?: boolean } = {}) => {
    const body = new FormData();body.set('directory', overrides.directory ?? root);body.set('name', name);body.set('file', new Blob([new Uint8Array(bytes)]), 'upload.bin');
    if (overrides.second) body.append('file', new Blob(['extra']), 'extra.bin');
    return fetch(base + `/api/hosts/${overrides.host || 'local'}/file-entries/upload`, { method: 'POST', headers: overrides.headers ?? headers, body });
  };
  return { root, upload, headers, base, close: async () => { await new Promise<void>(resolve => server.close(() => resolve()));await fs.rm(root, { recursive: true, force: true }); } };
}
test('workspace uploads stream binary bytes to a literal Unicode filename and refuse replacement', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.alloc(262145);for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const name = '中文 " $(touch escaped) `literal`.nii.gz';
    const response = await f.upload(name, bytes);assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { hostId: 'local', directory: f.root, operation: 'upload', path: path.join(f.root, name), isDirectory: false });
    assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes);
    assert.equal((await fs.stat(path.join(f.root, name))).mode & 0o777, 0o600);
    assert.equal((await f.upload(name, Buffer.from('do not overwrite'))).status, 409);
    assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes);
    assert.equal((await f.upload('empty.txt', Buffer.alloc(0))).status, 201);
    assert.equal((await fs.stat(path.join(f.root, 'empty.txt'))).size, 0);
    assert.deepEqual((await fs.readdir(f.root)).sort(), ['empty.txt', name].sort());
  } finally { await f.close(); }
});
test('upload authorization, filename, directory, multipart and host checks leave no published files', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.upload('bad', undefined, { headers: {} })).status, 401);
    assert.equal((await f.upload('bad', undefined, { headers: { ...f.headers, 'x-csrf-token': '' } })).status, 403);
    assert.equal((await f.upload('bad', undefined, { headers: { ...f.headers, origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await f.upload('bad', undefined, { host: 'missing' })).status, 404);
    for (const name of ['../escape', 'bad\\name', 'bad\nname', '.', '..']) assert.equal((await f.upload(name)).status, 400);
    assert.equal((await f.upload('bad', undefined, { directory: '../relative' })).status, 400);
    assert.equal((await f.upload('bad', undefined, { directory: f.root + '/missing' })).status, 400);
    assert.equal((await f.upload('bad', undefined, { second: true })).status, 413);
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.close(); }
});

test('interrupted or corrupt upload data is not published and staging files are cleaned', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('short source'), source = path.join(f.root, 'source');await fs.writeFile(source, bytes);
    for (const [size, sha256] of [[bytes.length + 1, createHash('sha256').update(bytes).digest('hex')], [bytes.length, '0'.repeat(64)]] as const) {
      const result = JSON.parse(await writeHostFileUpload({ id: 'local', name: 'Local', kind: 'local' }, source, fileTransferScript({ operation: 'upload', directory: f.root, name: 'target', size, sha256 })));
      assert.equal(result.code, 'INCOMPLETE_UPLOAD');assert.deepEqual(await fs.readdir(f.root), ['source']);
    }
    await fs.symlink('source', path.join(f.root, 'link'));
    assert.equal((await f.upload('link')).status, 409);assert.equal(await fs.readFile(source, 'utf8'), 'short source');
  } finally { await f.close(); }
});

test('the server rejects oversized streamed multipart uploads before publishing a file', async () => {
  const f = await fixture();
  try {
    const boundary = 'codex-upload-limit-fixture', chunk = Buffer.alloc(1024 * 1024, 1);
    const stream = Readable.from((async function* () {
      yield `--${boundary}\r\nContent-Disposition: form-data; name="directory"\r\n\r\n${f.root}\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nlarge.bin\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
      for (let i = 0; i < 101; i++) yield chunk;
      yield `\r\n--${boundary}--\r\n`;
    })());
    const response = await fetch(f.base + '/api/hosts/local/file-entries/upload', {
      method: 'POST', headers: { ...f.headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, body: stream, duplex: 'half', signal: AbortSignal.timeout(20000),
    } as any);
    assert.equal(response.status, 413);assert.match((await response.json() as any).error, /100 MB/);assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.close(); }
});
