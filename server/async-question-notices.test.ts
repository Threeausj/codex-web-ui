import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AsyncQuestionNotices } from './async-question-notices.js';
import { createServer } from './app.js';
import { asyncQuestionFingerprint } from '../shared/async-question-reply.js';
import type { AsyncQuestionNotice } from '../shared/async-question-notices.js';

const notice = (hostId = 'local', title = 'Which option?'): AsyncQuestionNotice => ({ hostId, threadId: 'thread', turnId: 'turn', itemId: 'question',
  fingerprint: asyncQuestionFingerprint({ id: 'question', type: 'agentMessage', delivery: 'async', questions: [{ title, options: ['One', 'Two'] }] })! });
const directory = () => fs.mkdtemp(path.join(os.tmpdir(), 'codex-question-notices-'));

test('closed question notices persist privately and concurrent clients retain each other’s changes', async () => {
  const root = await directory();
  try {
    const file = path.join(root, 'async-question-notices.json');
    const journal = new AsyncQuestionNotices(file); await journal.init();
    await Promise.all([journal.dismiss([notice()]), journal.dismiss([notice('remote')])]);
    await journal.dismiss([notice('local', 'A revised question?')]);
    await journal.dismiss([{ ...notice('local'), turnId: 'another-turn' }]);
    const restored = new AsyncQuestionNotices(file); await restored.init();
    assert.deepEqual(restored.list(), [notice('local', 'A revised question?'), notice('remote'), { ...notice('local'), turnId: 'another-turn' }]);
    const copied = restored.list(); copied[0]!.fingerprint = 'changed';
    assert.deepEqual(restored.list(), [notice('local', 'A revised question?'), notice('remote'), { ...notice('local'), turnId: 'another-turn' }]);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('invalid fingerprints and failed writes do not publish dismissed notices', async () => {
  const root = await directory();
  try {
    const file = path.join(root, 'async-question-notices.json');
    const journal = new AsyncQuestionNotices(file); await journal.init();
    assert.throws(() => journal.dismiss([{ ...notice(), itemId: 'another-item' }]));
    assert.throws(() => journal.dismiss([{ ...notice(), fingerprint: 'invalid' }]));
    await fs.mkdir(file);
    await assert.rejects(journal.dismiss([notice()])); assert.deepEqual(journal.list(), []);
    await fs.rm(file, { recursive: true }); await journal.dismiss([notice()]);
    await fs.writeFile(file, '{"version":1,"dismissals":["corrupt"]}');
    await assert.rejects(new AsyncQuestionNotices(file).init());
    assert.equal(await fs.readFile(file, 'utf8'), '{"version":1,"dismissals":["corrupt"]}');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('notice endpoints require auth and CSRF, bind fingerprints to items, and never call native Codex', async () => {
  const root = await directory();
  const app = await createServer({ dataDir: root, cwd: root, codexHome: path.join(root, 'codex'),
    password: 'question-notice-test-password', secureCookie: false, serveStatic: false,
    bridgeOptions: { transportFactory: () => { throw new Error('Dismissing notices must not call Codex'); } },
  });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
  try {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'question-notice-test-password' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = await login.json() as { csrfToken: string };
    const headers = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken };
    const read = (extra = '', supplied = headers) => fetch(base + '/api/async-question-notices' + extra, { headers: supplied });
    const dismiss = (questions: unknown = [notice()], supplied = headers, body?: unknown) => fetch(base + '/api/async-question-notices/dismiss', {
      method: 'POST', headers: supplied, body: JSON.stringify(body || { questions }),
    });
    assert.equal((await read('', {} as any)).status, 401);
    assert.equal((await dismiss(undefined, { 'content-type': 'application/json' } as any)).status, 401);
    assert.equal((await dismiss(undefined, { cookie, 'content-type': 'application/json' } as any)).status, 403);
    assert.equal((await dismiss(undefined, { ...headers, origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await dismiss([notice('missing-host')])).status, 404);
    assert.equal((await dismiss([{ ...notice(), itemId: 'another-item' }])).status, 400);
    assert.equal((await dismiss([{ ...notice(), fingerprint: 'invalid-json' }])).status, 400);
    assert.equal((await dismiss([], headers)).status, 400);
    assert.equal((await dismiss(undefined, headers, { questions: [notice()], answered: true })).status, 400);
    assert.equal((await read('?unexpected=true')).status, 400);
    const written = await dismiss(); assert.equal(written.status, 200);
    assert.deepEqual(await written.json(), { dismissals: [notice()] });
    const response = await read('?_request=nonce');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { dismissals: [notice()] });
    const bootstrap = await (await fetch(base + '/api/bootstrap', { headers })).json() as any;
    assert.deepEqual(bootstrap.asyncQuestionNoticeDismissals, [notice()]);
    assert.deepEqual(await (await dismiss()).json(), { dismissals: [notice()] });
    assert.equal(app.bridges.size, 0);
    const restored = new AsyncQuestionNotices(path.join(root, 'async-question-notices.json')); await restored.init();
    assert.deepEqual(restored.list(), [notice()]);
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});
