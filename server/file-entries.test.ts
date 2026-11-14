import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { execFile } from 'node:child_process';
import { Auth } from './auth.js';
import { registerFileEntries } from './file-entries.js';
import type { Host } from './types.js';
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-actions-'));
  const hosts: Host[] = [{ id: 'local', kind: 'local', name: 'Local' }, { id: 'remote', kind: 'ssh', name: 'Remote', hostname: 'unused.invalid' }];
  const calls: string[] = [], origin = 'http://localhost:8787';
  const auth = new Auth('file-actions-fixture-password', new Set([origin]), false);
  const app = express();app.use(express.json());app.post('/api/auth/login', auth.login);
  app.use('/api', auth.requireAuth, auth.requireCsrf);
  registerFileEntries(app, { getHost: id => hosts.find(host => host.id === id), run: async (host, source) => {
    calls.push(host.id);
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile('python3', ['-'], { timeout: 5000, maxBuffer: 32768 }, (error, stdout) => error ? reject(new Error('Isolated fixture Python failed')) : resolve(stdout));
      child.stdin!.end(source);
    });
    return output;
  } });
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.message }));
  const server = http.createServer(app);await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'file-actions-fixture-password' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!, { csrfToken } = await login.json() as any;
  const headers = { origin, cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken };
  const request = (input: any, hostId = 'local', inspection = false, authHeaders = headers) => fetch(base + `/api/hosts/${hostId}/file-entries${inspection ? '/inspect' : ''}`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ directory: root, ...input }) });
  const inspect = async (name: string) => {
    const response = await request({ name }, 'local', true);assert.equal(response.status, 200);return response.json() as Promise<{ version: string; isDirectory: boolean; isSymlink: boolean }>;
  };
  return { root, request, inspect, calls, headers, close: async () => { await new Promise<void>(resolve => server.close(() => resolve()));await fs.rm(root, { recursive: true, force: true }); } };
}

test('copy and move preserve binary bytes, nested files and links without following them', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'source'));await fs.mkdir(path.join(f.root, 'target'));await fs.mkdir(path.join(f.root, 'source/nested'));
    const bytes = Buffer.from([0,1,2,255,128,13,10]);
    await fs.writeFile(path.join(f.root, 'source/nested/中文 `literal` $x.bin'), bytes);
    await fs.symlink('../../target', path.join(f.root, 'source/nested/link'));
    const before = await f.inspect('source');
    const copied = await f.request({ operation: 'copy', sourceDirectory: f.root, name: 'source', newName: 'copied', directory: path.join(f.root, 'target'), expectedVersion: before.version });
    assert.equal(copied.status, 200);assert.equal((await copied.json() as any).previousPath, undefined);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'target/copied/nested/中文 `literal` $x.bin')), bytes);
    assert.equal(await fs.readlink(path.join(f.root, 'target/copied/nested/link')), '../../target');
    const moved = await f.request({ operation: 'move', sourceDirectory: f.root, name: 'source', newName: 'moved', directory: path.join(f.root, 'target'), expectedVersion: before.version });
    assert.equal(moved.status, 200);assert.equal((await moved.json() as any).previousPath, path.join(f.root, 'source'));
    assert.equal(await fs.access(path.join(f.root, 'source')).then(() => true, () => false), false);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'target/moved/nested/中文 `literal` $x.bin')), bytes);
    assert.equal((await fs.readdir(path.join(f.root, 'target'))).some(name => name.startsWith('.codex-web-')), false);
  } finally { await f.close(); }
});

test('transfers refuse overwrite, changed sources, recursive targets, FIFO entries and missing hosts', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'source'), 'source');await fs.writeFile(path.join(f.root, 'destination'), 'existing');
    const original = await f.inspect('source');
    const transfer = { operation: 'copy', sourceDirectory: f.root, name: 'source', newName: 'destination', expectedVersion: original.version };
    for (const operation of ['copy', 'move']) assert.equal((await f.request({ ...transfer, operation })).status, 409);
    assert.equal(await fs.readFile(path.join(f.root, 'source'), 'utf8'), 'source');assert.equal(await fs.readFile(path.join(f.root, 'destination'), 'utf8'), 'existing');
    await fs.writeFile(path.join(f.root, 'source'), 'changed externally');
    assert.equal((await f.request({ ...transfer, newName: 'new' })).status, 409);
    await fs.mkdir(path.join(f.root, 'tree'));await fs.mkdir(path.join(f.root, 'tree/child'));
    const tree = await f.inspect('tree');
    for (const operation of ['copy', 'move']) {
      const response = await f.request({ operation, directory: path.join(f.root, 'tree/child'), sourceDirectory: f.root, name: 'tree', newName: 'recursive', expectedVersion: tree.version });
      assert.equal(response.status, 400);assert.equal((await response.json() as any).code, 'RECURSIVE');
    }
    await new Promise<void>((resolve, reject) => execFile('mkfifo', [path.join(f.root, 'pipe')], error => error ? reject(error) : resolve()));
    const pipe = await f.inspect('pipe');
    const response = await f.request({ ...transfer, name: 'pipe', newName: 'copied-pipe', expectedVersion: pipe.version });
    assert.equal(response.status, 400);assert.equal((await response.json() as any).code, 'UNSUPPORTED_ENTRY');
    assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.codex-web-')), false);
    const calls = f.calls.length;
    assert.equal((await f.request(transfer, 'missing')).status, 404);
    assert.equal((await f.request({ ...transfer, sourceDirectory: '../relative' })).status, 400);assert.equal(f.calls.length, calls);
  } finally { await f.close(); }
});

test('a cross-filesystem move keeps the original and requests an explicit copy instead', async t => {
  const f = await fixture();let destination: string | undefined;
  try {
    const other = await fs.stat('/dev/shm').catch(() => null);
    if (!other || other.dev === (await fs.stat(f.root)).dev) { t.skip('No separate temporary filesystem');return; }
    destination = await fs.mkdtemp('/dev/shm/codex-web-move-test-');
    await fs.writeFile(path.join(f.root, 'source.txt'), 'must survive');const metadata = await f.inspect('source.txt');
    const response = await f.request({ operation: 'move', directory: destination, sourceDirectory: f.root, name: 'source.txt', newName: 'target.txt', expectedVersion: metadata.version });
    assert.equal(response.status, 409);assert.equal((await response.json() as any).code, 'CROSS_DEVICE');
    assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), 'must survive');assert.deepEqual(await fs.readdir(destination), []);
  } finally { if (destination) await fs.rm(destination, { recursive: true, force: true });await f.close(); }
});

test('file entry API requires login and CSRF, rejects escaped names and never connects unknown hosts', async () => {
  const f = await fixture();
  try {
    const input = { operation: 'createFile', name: 'safe.txt' };
    assert.equal((await f.request(input, 'local', false, { 'content-type': 'application/json' } as any)).status, 401);
    assert.equal((await f.request(input, 'local', false, { ...f.headers, 'x-csrf-token': '' })).status, 403);
    assert.equal((await f.request(input, 'local', false, { ...f.headers, origin: 'https://evil.invalid' })).status, 403);
    for (const name of ['.', '..', '../escape', '/absolute', 'one/two', 'a\\b', 'bad\0name', 'bad\nname']) assert.equal((await f.request({ ...input, name })).status, 400);
    assert.equal((await f.request({ ...input, directory: 'relative' })).status, 400);
    assert.equal((await f.request(input, 'missing')).status, 404);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('local and remote entry creation preserves shell characters literally and never overwrites a collision', async () => {
  const f = await fixture();
  try {
    const name = "中文 ' \" $(touch escaped) `literal` .txt";
    const created = await f.request({ operation: 'createFile', name }, 'remote');assert.equal(created.status, 200);
    assert.equal((await created.json() as any).path, path.join(f.root, name));assert.equal(await fs.readFile(path.join(f.root, name), 'utf8'), '');
    await fs.writeFile(path.join(f.root, name), 'keep original');
    assert.equal((await f.request({ operation: 'createFile', name })).status, 409);
    assert.equal(await fs.readFile(path.join(f.root, name), 'utf8'), 'keep original');
    assert.equal((await f.request({ operation: 'createDirectory', name: '子文件夹' })).status, 200);
    assert.equal((await fs.stat(path.join(f.root, '子文件夹'))).isDirectory(), true);
    assert.equal(await fs.access(path.join(f.root, 'escaped')).then(() => true, () => false), false);
    assert.equal(f.calls[0], 'remote');
    const results = await Promise.all([f.request({ operation: 'createFile', name: 'concurrent.txt' }), f.request({ operation: 'createFile', name: 'concurrent.txt' })]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  } finally { await f.close(); }
});

test('file and directory rename is atomic, keeps contents, refuses collisions and checks inspected identity', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'before'));await fs.writeFile(path.join(f.root, 'before', 'data.txt'), 'preserved');
    const directory = await f.inspect('before');assert.equal(directory.isDirectory, true);
    const moved = await f.request({ operation: 'rename', name: 'before', newName: 'after', expectedVersion: directory.version });assert.equal(moved.status, 200);
    assert.equal(await fs.readFile(path.join(f.root, 'after/data.txt'), 'utf8'), 'preserved');
    await fs.writeFile(path.join(f.root, 'one.txt'), 'one');await fs.writeFile(path.join(f.root, 'two.txt'), 'two');
    const before = await f.inspect('one.txt');
    assert.equal((await f.request({ operation: 'rename', name: 'one.txt', newName: 'two.txt', expectedVersion: before.version })).status, 409);
    assert.equal(await fs.readFile(path.join(f.root, 'two.txt'), 'utf8'), 'two');
    await fs.writeFile(path.join(f.root, 'one.txt'), 'changed externally');
    assert.equal((await f.request({ operation: 'rename', name: 'one.txt', newName: 'renamed.txt', expectedVersion: before.version })).status, 409);
    const current = await f.inspect('one.txt');
    assert.equal((await f.request({ operation: 'rename', name: 'one.txt', newName: 'renamed.txt', expectedVersion: current.version })).status, 200);
    assert.equal(await fs.readFile(path.join(f.root, 'renamed.txt'), 'utf8'), 'changed externally');
  } finally { await f.close(); }
});

test('delete requires explicit confirmation and an unchanged identity, recurses safely and unlinks symlinks only', async () => {
  const f = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'file-actions-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'keep.txt'), 'outside must survive');
    await fs.mkdir(path.join(f.root, 'tree'));await fs.mkdir(path.join(f.root, 'tree/nested'));await fs.writeFile(path.join(f.root, 'tree/nested/a'), 'a');
    await fs.symlink(outside, path.join(f.root, 'tree/link'));
    const original = await f.inspect('tree');
    assert.equal((await f.request({ operation: 'delete', name: 'tree', expectedVersion: original.version })).status, 400);
    await fs.writeFile(path.join(f.root, 'tree/new.txt'), 'new external file');
    assert.equal((await f.request({ operation: 'delete', name: 'tree', expectedVersion: original.version, confirmed: true })).status, 409);
    const current = await f.inspect('tree');
    assert.equal((await f.request({ operation: 'delete', name: 'tree', expectedVersion: current.version, confirmed: true })).status, 200);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside must survive');
    await fs.symlink(outside, path.join(f.root, 'link'));
    const link = await f.inspect('link');assert.equal(link.isSymlink, true);assert.equal(link.isDirectory, false);
    assert.equal((await f.request({ operation: 'delete', name: 'link', expectedVersion: link.version, confirmed: true })).status, 200);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside must survive');
    assert.equal((await f.request({ name: 'missing' }, 'local', true)).status, 404);
  } finally { await f.close();await fs.rm(outside, { recursive: true, force: true }); }
});
