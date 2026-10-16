import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { Auth } from './auth.js';
import { registerUploads, remoteUploadSource } from './uploads.js';
import type { Host } from './types.js';

const python = (source: string) => JSON.parse(execFileSync('python3', ['-'], { input: source, encoding: 'utf8', timeout: 15000 }));
const mode = async (filename: string) => (await fs.stat(filename)).mode & 0o777;
const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), 'codex-uploads-'));

test('remote upload helper creates private directories and literal binary files without a Codex command', async t => {
  const cwd = await temporary(); t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const uploadId = randomUUID(), directory = path.join(cwd, '.codex-web-uploads', uploadId);
  assert.deepEqual(python(remoteUploadSource({ action: 'prepare', cwd, uploadId })), { ok: true });
  assert.equal(await mode(path.dirname(directory)), 0o700); assert.equal(await mode(directory), 0o700);
  const filename = "0-中文 'quote' $() `literal`.png", data = Buffer.from([0, 255, 128, 10, 13, 0, 1]);
  assert.deepEqual(python(remoteUploadSource({ action: 'write', cwd, uploadId, filename, dataBase64: data.toString('base64') })), { ok: true });
  assert.deepEqual(await fs.readFile(path.join(directory, filename)), data); assert.equal(await mode(path.join(directory, filename)), 0o600);
  assert.deepEqual(python(remoteUploadSource({ action: 'write', cwd, uploadId, filename: '1-empty.txt', dataBase64: '' })), { ok: true });
  assert.equal((await fs.stat(path.join(directory, '1-empty.txt'))).size, 0);
  assert.deepEqual(python(remoteUploadSource({ action: 'cleanup', cwd, uploadId, filenames: [filename, '1-empty.txt'] })), { ok: true });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' }); assert.equal(await mode(path.dirname(directory)), 0o700);
});

test('remote staging rejects symbolic upload directories, occupied UUIDs and existing files without modifying their targets', async t => {
  const cwd = await temporary(), outside = await temporary(); t.after(async () => { await fs.rm(cwd, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.chmod(outside, 0o755); await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
  const base = path.join(cwd, '.codex-web-uploads'), uploadId = randomUUID();
  await fs.symlink(outside, base);
  assert.equal(python(remoteUploadSource({ action: 'prepare', cwd, uploadId })).ok, false);
  assert.equal(await mode(outside), 0o755); assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
  await fs.unlink(base); await fs.mkdir(base, { mode: 0o700 });
  const directory = path.join(base, uploadId); await fs.symlink(outside, directory);
  assert.equal(python(remoteUploadSource({ action: 'prepare', cwd, uploadId })).ok, false);
  await fs.unlink(directory); await fs.mkdir(directory, { mode: 0o700 }); await fs.writeFile(path.join(directory, '0-existing.txt'), 'original');
  assert.equal(python(remoteUploadSource({ action: 'prepare', cwd, uploadId })).ok, false);
  assert.equal(python(remoteUploadSource({ action: 'write', cwd, uploadId, filename: '0-existing.txt', dataBase64: Buffer.from('replace').toString('base64') })).ok, false);
  assert.equal(await fs.readFile(path.join(directory, '0-existing.txt'), 'utf8'), 'original');
  await fs.symlink(path.join(outside, 'sentinel'), path.join(directory, '1-link.txt'));
  assert.equal(python(remoteUploadSource({ action: 'write', cwd, uploadId, filename: '1-link.txt', dataBase64: 'eA==' })).ok, false);
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
});

test('cleanup is limited to this upload and cannot recurse through a swapped directory', async t => {
  const cwd = await temporary(); t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const uploadId = randomUUID(), sibling = randomUUID();
  for (const id of [uploadId, sibling]) {
    assert.equal(python(remoteUploadSource({ action: 'prepare', cwd, uploadId: id })).ok, true);
    assert.equal(python(remoteUploadSource({ action: 'write', cwd, uploadId: id, filename: '0-note.txt', dataBase64: 'a2VlcA==' })).ok, true);
  }
  const base = path.join(cwd, '.codex-web-uploads'), directory = path.join(base, uploadId);
  await fs.rename(directory, directory + '-original'); await fs.symlink(path.join(base, sibling), directory);
  assert.equal(python(remoteUploadSource({ action: 'cleanup', cwd, uploadId, filenames: ['0-note.txt'] })).ok, false);
  assert.equal(await fs.readFile(path.join(base, sibling, '0-note.txt'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(directory + '-original/0-note.txt', 'utf8'), 'keep');
});

async function fixture(t: any, runner?: (host: Host, source: string) => Promise<string>) {
  const root = await temporary(), cwd = path.join(root, 'project'), dataDir = path.join(root, 'data');
  await fs.mkdir(cwd); await fs.mkdir(dataDir);
  const remote: Host = { id: 'remote', kind: 'ssh', name: 'GPU', hostname: 'fixture.invalid', cwd };
  const origin = 'http://localhost:8787', auth = new Auth('upload-test-password', new Set([origin]));
  const app = express(); app.use(express.json()); app.post('/api/auth/login', auth.login); app.use('/api', auth.requireAuth, auth.requireCsrf);
  let bridgeRequests = 0, remoteCalls = 0;
  registerUploads(app, { cwd, dataDir, getHost: id => id === 'remote' ? remote : id === 'local' ? { id: 'local', kind: 'local', name: 'Local' } : undefined,
    getBridge: async id => ({ request: async (method: string, params: any) => {
      bridgeRequests++;
      assert.equal(id, 'local', 'remote uploads must not use a Codex RPC'); assert.equal(method, 'fs/writeFile');
      await fs.writeFile(params.path, Buffer.from(params.dataBase64, 'base64')); return {};
    } }) as any,
    runRemote: async (host, source) => { remoteCalls++; return runner ? runner(host, source) : JSON.stringify(python(source)); },
  });
  app.use(((error, _req, res, _next) => { res.status(error.status || (error.code?.startsWith('LIMIT_') ? 413 : 500)).json({ error: error.message }); }) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'upload-test-password' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!, { csrfToken } = await login.json() as { csrfToken: string };
  const body = (hostId = 'remote', files = [{ name: 'notes.txt', bytes: Buffer.from('Upload test') }]) => {
    const form = new FormData(); form.set('hostId', hostId); form.set('cwd', cwd);
    for (const file of files) form.append('files', new Blob([new Uint8Array(file.bytes)]), file.name);
    return form;
  };
  const headers = { origin, cookie, 'x-csrf-token': csrfToken };
  const upload = (form = body(), extra: Record<string, string> = headers) => fetch(base + '/api/uploads', { method: 'POST', headers: extra, body: form });
  return { root, cwd, dataDir, body, upload, headers, counts: () => ({ bridgeRequests, remoteCalls }) };
}

test('remote upload API keeps authentication, origin and CSRF enforcement and needs no native command or writer', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload(f.body(), {})).status, 401);
  assert.equal((await f.upload(f.body(), { cookie: f.headers.cookie, origin: f.headers.origin })).status, 403);
  assert.equal((await f.upload(f.body(), { ...f.headers, origin: 'https://evil.invalid' })).status, 403);
  assert.equal(f.counts().remoteCalls, 0);
  const bytes = Buffer.from([255, 0, 23, 128]);
  const response = await f.upload(f.body('remote', [{ name: "../safe 'file'.png", bytes }]));
  assert.equal(response.status, 201);
  const result = await response.json() as { files: { name: string; path: string; mime: string; size: number }[] };
  assert.equal(result.files.length, 1); assert.equal(result.files[0]!.name, "safe 'file'.png");
  assert.equal(result.files[0]!.size, bytes.length); assert.match(result.files[0]!.path, /\.codex-web-uploads\/[a-f0-9-]+\/0-safe 'file'\.png$/);
  assert.deepEqual(await fs.readFile(result.files[0]!.path), bytes); assert.equal(await mode(result.files[0]!.path), 0o600);
  assert.equal(f.counts().bridgeRequests, 0);
});

test('local upload paths and private modes remain compatible with native filesystem writes', async t => {
  const f = await fixture(t); const response = await f.upload(f.body('local'));
  assert.equal(response.status, 201); const result = await response.json() as { files: { path: string }[] };
  assert.ok(result.files[0]!.path.startsWith(path.join(f.dataDir, 'uploads') + '/'));
  assert.equal(await fs.readFile(result.files[0]!.path, 'utf8'), 'Upload test'); assert.equal(await mode(result.files[0]!.path), 0o600);
  assert.equal(await mode(path.dirname(result.files[0]!.path)), 0o700); assert.equal(await mode(path.join(f.dataDir, 'uploads')), 0o700);
  assert.deepEqual(f.counts(), { bridgeRequests: 1, remoteCalls: 0 });
});

test('a failed remote file write removes only its prepared batch and reports an actionable error', async t => {
  let calls = 0;
  const f = await fixture(t, async (_host, source) => {
    calls++;
    return JSON.stringify(calls === 3 ? { ok: false, code: 'NOT_WRITABLE' } : python(source));
  });
  const response = await f.upload(f.body('remote', [{ name: 'first.txt', bytes: Buffer.from('first') }, { name: 'second.txt', bytes: Buffer.from('second') }]));
  assert.equal(response.status, 403); assert.match((await response.json()).error, /权限|写入/);
  assert.deepEqual(await fs.readdir(path.join(f.cwd, '.codex-web-uploads')), []); assert.equal(calls, 4);
  assert.equal(f.counts().bridgeRequests, 0);
});

test('uploads reject empty requests, unknown hosts and too many files before touching a remote directory', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload(f.body('remote', []))).status, 400);
  assert.equal((await f.upload(f.body('missing'))).status, 404);
  assert.equal((await f.upload(f.body('remote', Array.from({ length: 9 }, (_, index) => ({ name: index + '.txt', bytes: Buffer.from('x') }))))).status, 413);
  assert.equal(f.counts().remoteCalls, 0);
});

test('a colliding remote destination survives failed-batch cleanup while this request’s acknowledged files are removed', async t => {
  let calls = 0, collision = '';
  const f = await fixture(t, async (_host, source) => {
    if (++calls === 3) {
      const encoded = source.match(/p=json\.loads\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\)\)/)![1]!;
      const input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      collision = path.join(input.cwd, '.codex-web-uploads', input.uploadId, input.filename);
      await fs.writeFile(collision, 'existing file must survive', { mode: 0o600 });
    }
    return JSON.stringify(python(source));
  });
  const response = await f.upload(f.body('remote', [{ name: 'first.txt', bytes: Buffer.from('first') }, { name: 'collision.txt', bytes: Buffer.from('replace') }]));
  assert.equal(response.status, 409);
  assert.equal(await fs.readFile(collision, 'utf8'), 'existing file must survive');
  assert.deepEqual(await fs.readdir(path.dirname(collision)), ['1-collision.txt']);
  assert.equal(f.counts().bridgeRequests, 0);
});
