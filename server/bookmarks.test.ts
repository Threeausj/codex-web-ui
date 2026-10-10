import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Bookmarks, MAX_BOOKMARKS, MAX_BOOKMARK_BYTES, bookmarkInput } from './bookmarks.js';
import { createServer } from './app.js';
import type { BookmarkScope, ConversationBookmark, ConversationBookmarkInput } from '../shared/bookmarks.js';

const scope: BookmarkScope = { hostId: 'local', projectPath: '/project' };
const input = (overrides: Partial<ConversationBookmarkInput> = {}): ConversationBookmarkInput => ({
  ...scope, name: 'Important answer',
  source: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', text: 'A selected paragraph.\nWith another line.', threadName: 'Original conversation' },
  ...overrides,
});
const directory = () => fs.mkdtemp(path.join(os.tmpdir(), 'codex-bookmarks-'));
const savedBookmark = (index: number, text = 'Selected text'): ConversationBookmark => ({
  ...input(), source: { ...input().source, itemId: `item-${index}`, text }, id: randomUUID(), createdAt: index, updatedAt: index,
});

test('bookmarks persist privately across restart and concurrent clients keep independent additions and edits', async () => {
  const root = await directory();
  try {
    const file = path.join(root, 'bookmarks.json');
    const store = new Bookmarks(file);
    await store.init();
    const [first, second] = await Promise.all([
      store.add(input()),
      store.add(input({ source: { ...input().source, itemId: 'other-item' } })),
    ]);
    await Promise.all([store.rename(first.id, scope, { name: '  Custom bookmark name  ' }), store.remove(second.id, scope)]);
    const restored = new Bookmarks(file);
    await restored.init();
    assert.deepEqual(restored.list(scope), [{ ...first, name: 'Custom bookmark name', updatedAt: restored.list(scope)[0]!.updatedAt }]);
    assert.deepEqual(restored.list(scope)[0]!.source, first.source);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    const snapshot = restored.list(scope);
    snapshot[0]!.source.text = 'Mutated by a browser';
    snapshot[0]!.name = 'Changed';
    assert.equal(restored.list(scope)[0]!.name, 'Custom bookmark name');
    assert.equal(restored.list(scope)[0]!.source.text, first.source.text);
    assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('bookmark scope normalizes project paths but isolates different hosts and sibling projects', async () => {
  const root = await directory();
  try {
    const store = new Bookmarks(path.join(root, 'bookmarks.json'));
    await store.init();
    const first = await store.add(input({ projectPath: '/project/child/../' }));
    const remote = await store.add(input({ hostId: 'ssh-remote' }));
    const sibling = await store.add(input({ projectPath: '/project-sibling' }));
    assert.equal(first.projectPath, '/project');
    assert.deepEqual(store.list({ ...scope, projectPath: '//project/./' }).map(value => value.id), [first.id]);
    assert.deepEqual(store.list({ ...scope, hostId: 'ssh-remote' }).map(value => value.id), [remote.id]);
    for (const otherScope of [{ ...scope, hostId: 'ssh-remote' }, { ...scope, projectPath: '/project-sibling' }]) {
      await assert.rejects(store.rename(first.id, otherScope, { name: 'Wrong project' }), { status: 404 });
      await assert.rejects(store.remove(first.id, otherScope), { status: 404 });
    }
    assert.equal(store.list(scope)[0]!.name, first.name);
    assert.equal(store.list({ ...scope, projectPath: '/project-sibling' })[0]!.id, sibling.id);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('identical selections are idempotent across concurrent requests and do not overwrite the saved name', async () => {
  const root = await directory();
  try {
    const store = new Bookmarks(path.join(root, 'bookmarks.json'));
    await store.init();
    const created = await Promise.all(Array.from({ length: 8 }, (_, i) => store.add(input({ name: `Attempt ${i}` }))));
    assert.equal(new Set(created.map(value => value.id)).size, 1);
    assert.equal(store.list(scope).length, 1);
    assert.equal(store.list(scope)[0]!.name, 'Attempt 0');
    await store.rename(created[0]!.id, scope, { name: 'A saved custom name' });
    const repeated = await store.add(input({ name: 'New suggestion' }));
    assert.equal(repeated.name, 'A saved custom name');
    await store.add(input({ source: { ...input().source, text: 'Another selection in the same item' } }));
    assert.equal(store.list(scope).length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('bookmarks require native conversation positions and reject oversized or unexpected input', () => {
  const valid = input();
  const invalid = [
    { ...valid, name: ' '.repeat(10) }, { ...valid, name: 'x'.repeat(161) },
    { ...valid, name: 'Bad\nname' }, { ...valid, hostId: '' }, { ...valid, hostId: 'x'.repeat(257) },
    { ...valid, projectPath: 'relative/project' }, { ...valid, projectPath: '/project\0other' },
    { ...valid, projectPath: '/' + 'a'.repeat(4096) },
    { ...valid, source: { ...valid.source, turnId: '' } },
    { ...valid, source: { ...valid.source, itemId: '' } },
    { ...valid, source: { ...valid.source, threadId: 'thread\n' } },
    { ...valid, source: { ...valid.source, text: 'x'.repeat(16001) } },
    { ...valid, source: { ...valid.source, text: '  \n' } },
    { ...valid, source: { ...valid.source, file: '/etc/passwd' } },
    { ...valid, command: 'unexpected' },
  ];
  for (const value of invalid) assert.equal(bookmarkInput.safeParse(value).success, false);
  assert.equal(bookmarkInput.safeParse({ ...valid, name: 'x'.repeat(160), source: { ...valid.source, text: 'x'.repeat(16000) } }).success, true);
});

test('bookmark capacity limits reject additions without corrupting the store or blocking subsequent writes', async () => {
  const root = await directory();
  try {
    const file = path.join(root, 'bookmarks.json');
    const existing = Array.from({ length: MAX_BOOKMARKS }, (_, i) => savedBookmark(i));
    await fs.writeFile(file, JSON.stringify({ version: 1, bookmarks: existing }));
    const store = new Bookmarks(file);
    await store.init();
    await assert.rejects(store.add(input({ source: { ...input().source, itemId: 'new-selection' } })), { status: 409 });
    assert.equal(store.list(scope).length, MAX_BOOKMARKS);
    await store.remove(existing[0]!.id, scope);
    await store.add(input({ source: { ...input().source, itemId: 'new-selection' } }));
    assert.equal(store.list(scope).length, MAX_BOOKMARKS);
    const restored = new Bookmarks(file);
    await restored.init();
    assert.equal(restored.list(scope).length, MAX_BOOKMARKS);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('UTF-8 storage budget is enforced before a write and startup refuses oversized/corrupted stores', async () => {
  const root = await directory();
  try {
    const file = path.join(root, 'bookmarks.json');
    const existing = Array.from({ length: 520 }, (_, i) => savedBookmark(i, 'x'.repeat(16000)));
    let document = JSON.stringify({ version: 1, bookmarks: existing }, null, 2) + '\n';
    while (Buffer.byteLength(document) > MAX_BOOKMARK_BYTES) {
      existing.pop();
      document = JSON.stringify({ version: 1, bookmarks: existing }, null, 2) + '\n';
    }
    await fs.writeFile(file, document);
    const store = new Bookmarks(file);
    await store.init();
    await assert.rejects(store.add(input({ source: { ...input().source, itemId: 'over-byte-budget', text: '中'.repeat(16000) } })), { status: 413 });
    assert.equal(store.list(scope).length, existing.length);
    assert.equal(await fs.readFile(file, 'utf8'), document);
    await store.rename(existing[0]!.id, scope, { name: 'Short name' });
    await fs.writeFile(file, ' '.repeat(MAX_BOOKMARK_BYTES + 1));
    await assert.rejects(new Bookmarks(file).init(), { status: 413 });
    await fs.writeFile(file, '{"version":1,"bookmarks":["broken"]}');
    await assert.rejects(new Bookmarks(file).init());
    assert.equal(await fs.readFile(file, 'utf8'), '{"version":1,"bookmarks":["broken"]}');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a failed durable write is not published and the next write can succeed', async () => {
  const root = await directory();
  try {
    const file = path.join(root, 'bookmarks.json');
    const store = new Bookmarks(file);
    await store.init();
    await fs.mkdir(file);
    await assert.rejects(store.add(input()));
    assert.deepEqual(store.list(scope), []);
    await fs.rm(file, { recursive: true });
    await store.add(input());
    assert.equal(store.list(scope).length, 1);
    assert.deepEqual((await fs.readdir(root)).filter(file => file.endsWith('.tmp')), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function apiFixture() {
  const root = await directory();
  const application = await createServer({
    dataDir: root, cwd: '/project', codexHome: path.join(root, 'codex'),
    password: 'bookmark-test-password', secureCookie: false, serveStatic: false,
    bridgeOptions: { transportFactory: () => { throw new Error('Bookmark requests must not connect to Codex'); } },
  });
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`;
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'bookmark-test-password' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const { csrfToken } = await login.json() as { csrfToken: string };
  const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken };
  const scoped = (value: BookmarkScope = scope) => new URLSearchParams(value).toString();
  const request = (url: string, method = 'GET', body?: unknown, suppliedHeaders: Record<string, string> = headers) => fetch(base + url, {
    method, headers: suppliedHeaders, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { application, root, headers, cookie, scoped, request, close: async () => { await application.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('bookmark HTTP routes require auth/CSRF, reject foreign origins and preserve strict host/project scopes without Codex calls', async () => {
  const f = await apiFixture();
  try {
    const query = f.scoped();
    for (const [url, method, body] of [
      [`/api/bookmarks?${query}`, 'GET', undefined],
      ['/api/bookmarks', 'POST', input()],
      [`/api/bookmarks/${randomUUID()}?${query}`, 'PATCH', { name: 'Renamed' }],
      [`/api/bookmarks/${randomUUID()}?${query}`, 'DELETE', undefined],
    ] as const) {
      assert.equal((await f.request(url, method, body, { 'content-type': 'application/json' })).status, 401);
      if (method !== 'GET') {
        assert.equal((await f.request(url, method, body, { 'content-type': 'application/json', cookie: f.cookie })).status, 403);
        assert.equal((await f.request(url, method, body, { ...f.headers, origin: 'https://attacker.invalid' })).status, 403);
      }
    }
    const created = await f.request('/api/bookmarks', 'POST', input());
    assert.equal(created.status, 201);
    const { bookmark } = await created.json() as { bookmark: ConversationBookmark };
    assert.equal((await f.request(`/api/bookmarks?${query}&_request=cache-buster`)).status, 200);
    const list = await f.request(`/api/bookmarks?${query}`, 'GET', undefined, { cookie: f.cookie });
    assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await list.json() as { bookmarks: ConversationBookmark[] }).bookmarks, [bookmark]);
    const siblingScope = f.scoped({ ...scope, projectPath: '/project-sibling' });
    assert.deepEqual(await (await f.request(`/api/bookmarks?${siblingScope}`)).json(), { bookmarks: [] });
    assert.equal((await f.request(`/api/bookmarks/${bookmark.id}?${siblingScope}`, 'PATCH', { name: 'Wrong scope' })).status, 404);
    assert.equal((await f.request(`/api/bookmarks/${bookmark.id}?${siblingScope}`, 'DELETE')).status, 404);
    assert.equal((await f.request(`/api/bookmarks/${bookmark.id}?${query}`, 'PATCH', { name: 'Renamed', source: input().source })).status, 400);
    assert.equal((await f.request('/api/bookmarks?hostId=local')).status, 400);
    assert.equal((await f.request(`/api/bookmarks?${query}&unknown=true`)).status, 400);
    assert.equal((await f.request(`/api/bookmarks?${query}&hostId=other`)).status, 400);
    assert.equal((await f.request(`/api/bookmarks?${f.scoped({ ...scope, hostId: 'missing-host' })}`)).status, 404);
    assert.equal((await f.request('/api/bookmarks', 'POST', input({ hostId: 'missing-host' }))).status, 404);
    const renamed = await f.request(`/api/bookmarks/${bookmark.id}?${query}`, 'PATCH', { name: '  A private bookmark name  ' });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json() as { bookmark: ConversationBookmark }).bookmark.name, 'A private bookmark name');
    assert.equal((await f.request(`/api/bookmarks/${bookmark.id}?${query}`, 'DELETE')).status, 200);
    assert.deepEqual(await (await f.request(`/api/bookmarks?${query}`)).json(), { bookmarks: [] });
    assert.equal(f.application.bridges.size, 0);
  } finally { await f.close(); }
});

test('bookmark API keeps identical native IDs on different configured hosts separate', async () => {
  const f = await apiFixture();
  try {
    const host = await f.application.storage.addHost({ name: 'Remote bookmark host', hostname: 'remote.invalid' });
    const localResult = await f.request('/api/bookmarks', 'POST', input());
    const local = (await localResult.json() as { bookmark: ConversationBookmark }).bookmark;
    const remoteResult = await f.request('/api/bookmarks', 'POST', input({ hostId: host.id }));
    const remote = (await remoteResult.json() as { bookmark: ConversationBookmark }).bookmark;
    assert.notEqual(remote.id, local.id);
    const remoteScope = f.scoped({ ...scope, hostId: host.id });
    assert.deepEqual((await (await f.request(`/api/bookmarks?${remoteScope}`)).json() as { bookmarks: ConversationBookmark[] }).bookmarks, [remote]);
    assert.equal((await f.request(`/api/bookmarks/${local.id}?${remoteScope}`, 'DELETE')).status, 404);
    assert.equal((await f.request(`/api/bookmarks/${local.id}?${remoteScope}`, 'PATCH', { name: 'Cross-host edit' })).status, 404);
    assert.equal(f.application.bridges.size, 0);
  } finally { await f.close(); }
});
