import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { registerFiles, fileVersion } from './files.js';
import type { Bridge } from './bridge.js';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-file-conflict-'));
  const file = path.join(directory, 'document.md');
  await fs.writeFile(file, '# Original\n');
  let writes = 0;
  const app = express();
  registerFiles(app, async () => ({ request: async (method: string, input: any) => {
    if (method === 'fs/readFile') return { dataBase64: (await fs.readFile(input.path)).toString('base64') };
    assert.equal(method, 'fs/writeFile');
    writes++;
    await fs.writeFile(input.path, Buffer.from(input.dataBase64, 'base64'));
    return {};
  } } as unknown as Bridge));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 400).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/hosts/local/files`;
  const read = async () => (await fetch(`${base}?path=${encodeURIComponent(file)}`)).json() as Promise<{ version: string; dataBase64: string }>;
  const save = (version: string, content: string) => {
    const body = new FormData(); body.set('path', file); body.set('expectedVersion', version); body.set('file', new Blob([content]), 'document.md');
    return fetch(base, { method: 'POST', body });
  };
  return { file, read, save, writes: () => writes, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  } };
}
test('external edits cause a conflict without overwriting the file', async () => {
  const f = await fixture();
  try {
    const original = await f.read();
    assert.equal(original.version, fileVersion(Buffer.from('# Original\n')));
    await fs.writeFile(f.file, '# CLI changed\n');
    const result = await f.save(original.version, '# Browser draft\n');
    assert.equal(result.status, 409);
    assert.equal((await result.json() as any).code, 'FILE_CONFLICT');
    assert.equal(f.writes(), 0);
    assert.equal(await fs.readFile(f.file, 'utf8'), '# CLI changed\n');
    const current = await f.read();
    const saved = await f.save(current.version, '# Explicit merge\n');
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as any).version, fileVersion(Buffer.from('# Explicit merge\n')));
  } finally { await f.close(); }
});
test('concurrent browser saves with the same base serialize and exactly one succeeds', async () => {
  const f = await fixture();
  try {
    const original = await f.read();
    const results = await Promise.all([f.save(original.version, 'first'), f.save(original.version, 'second')]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});
test('a missing version is rejected rather than silently performing an unconditional write', async () => {
  const f = await fixture();
  try { assert.equal((await f.save('', 'unsafe')).status, 400); assert.equal(f.writes(), 0); }
  finally { await f.close(); }
});
