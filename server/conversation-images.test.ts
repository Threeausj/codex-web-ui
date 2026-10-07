import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path'; import { PassThrough } from 'node:stream'; import { EventEmitter } from 'node:events';
import { createServer } from './app.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=', 'base64');
test('conversation images require login, validate paths and type, bound file size, and bind reads to the selected host', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-images-')); const reads: any[] = []; const origin = 'http://localhost:8787';
  const context = await createServer({ dataDir: directory, codexHome: directory, password: 'image-test-password', origins: [origin], secureCookie: false, serveStatic: false, bridgeOptions: { transportFactory: host => {
    const input = new PassThrough(), output = new PassThrough(); let buffer = '';
    input.on('data', chunk => { buffer += chunk; let newline: number; while ((newline = buffer.indexOf('\n')) >= 0) { const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); if (!request.method || request.id === undefined) continue;
      const file = request.params?.path; let result: any = {};
      if (request.method === 'fs/readFile') { reads.push({ hostId: host.id, path: file }); result = { dataBase64: file.includes('large') ? 'A'.repeat(Math.ceil(8 * 1024 * 1024 * 4 / 3) + 1) : png.toString('base64') }; }
      queueMicrotask(() => output.write(JSON.stringify(file?.includes('missing') ? { id: request.id, error: { code: -32000, message: 'File not found' } } : { id: request.id, result }) + '\n'));
    } }); return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } };
  } } });
  await new Promise<void>(resolve => context.server.listen(0, '127.0.0.1', resolve)); t.after(async () => { await context.close(); await fs.rm(directory, { recursive: true, force: true }) });
  const base = `http://127.0.0.1:${(context.server.address() as any).port}`; const image = (file: string) => `${base}/api/hosts/local/images?${new URLSearchParams({ path: file })}`;
  assert.equal((await fetch(image('/test/image.png'))).status, 401); assert.equal(reads.length, 0);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'image-test-password' }) }); const cookie = login.headers.get('set-cookie')!.split(';')[0]!; const headers = { cookie };
  for (const file of ['relative.png', '/test/invalid\n.png']) assert.equal((await fetch(image(file), { headers })).status, 400);
  assert.equal((await fetch(image('/test/config.toml'), { headers })).status, 415); assert.equal(reads.length, 0);
  const response = await fetch(image('/.codex-web-uploads/test/image.png'), { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('content-security-policy')?.includes('sandbox')); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.deepEqual(reads, [{ hostId: 'local', path: '/.codex-web-uploads/test/image.png' }]);
  assert.equal((await fetch(image('/test/large.png'), { headers })).status, 413);
  assert.equal((await fetch(image('/test/missing.png'), { headers })).ok, false);
  assert.equal((await fetch(`${base}/api/hosts/not-a-host/images?path=/test/image.png`, { headers })).status, 404);
});
