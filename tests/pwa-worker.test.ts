import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'))
  .replace('__CODEX_BUILD__', 'test-revision')
  .replace('__CODEX_PRECACHE__', JSON.stringify(['/index.html', '/offline.html', '/assets/public.js']));

function worker() {
  const listeners = new Map<string, (event: any) => void>();
  const notifications: { title: string; options: any }[] = [];
  const opened: string[] = [];
  const networkRequests: any[] = [];
  const cached = new Map<string, Response>();
  let clients: any[] = [];
  let offline = false;
  const self = {
    location: { origin: 'https://codex.example' },
    addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener); },
    registration: { async showNotification(title: string, options: any) { notifications.push({ title, options }); } },
    clients: {
      async matchAll() { return clients; },
      async openWindow(url: string) { opened.push(url); },
      async claim() {},
    },
    async skipWaiting() {},
  };
  vm.runInNewContext(source, {
    self, URL, Response,
    Request: class extends Request { constructor(input: RequestInfo | URL, options?: RequestInit) { super(new URL(String(input), self.location.origin), options); } },
    caches: {
      async match(request: Request) { return cached.get(request.url)?.clone(); },
      async keys() { return []; },
      async delete() { return true; },
      async open() { return { async match(path: string) { return cached.get(new URL(path, self.location.origin).href)?.clone(); }, async put(request: Request, response: Response) { cached.set(request.url, response.clone()); } }; },
    },
    async fetch(request: any, options?: RequestInit) {
      networkRequests.push(request instanceof URL ? new Request(request, options) : request);
      if (offline) throw new TypeError('Network unavailable');
      const response = new Response('network');
      Object.defineProperty(response, 'type', { value: 'basic' });
      return response;
    },
  });
  async function fire(name: string, event: any) {
    const pending: Promise<any>[] = [];
    listeners.get(name)!({ ...event, waitUntil: (promise: Promise<any>) => pending.push(promise) });
    await Promise.all(pending);
  }
  return { fire, listeners, notifications, opened, networkRequests, cached, setClients(value: any[]) { clients = value; }, setOffline(value: boolean) { offline = value; } };
}

test('push displays nested server destinations and generic notifications for malformed payloads', async () => {
  const target = worker();
  await target.fire('push', { data: { json: () => ({ title: '部署项目', body: '运行完成', data: { hostId: 'remote-1', threadId: 'thread_2', url: 'https://malicious.example/' } }) } });
  assert.equal(target.notifications.length, 1);
  assert.equal(target.notifications[0].title, '部署项目');
  assert.equal(target.notifications[0].options.body, '运行完成');
  assert.equal(JSON.stringify(target.notifications[0].options.data), JSON.stringify({ hostId: 'remote-1', threadId: 'thread_2' }));
  await target.fire('push', { data: { json: () => { throw new SyntaxError('Invalid JSON'); } } });
  await target.fire('push', {});
  assert.equal(target.notifications.length, 3);
  assert.match(target.notifications[1].options.body, /工作区/);
});

test('replacing a conversation notification alerts again and missing tags remain valid', async () => {
  const target = worker();
  for (const tag of ['codex-thread-completed', 'codex-thread-completed', '', undefined]) {
    await target.fire('push', { data: { json: () => ({ tag }) } });
  }
  assert.deepEqual(target.notifications.map(entry => entry.options.renotify), [true, true, false, false]);
})

test('notification click focuses an app window and messages it without reloading a running chat', async () => {
  const target = worker();
  let focused = 0;
  let closed = 0;
  const messages: any[] = [];
  target.setClients([{ frameType: 'top-level', url: 'https://codex.example/?host=local', async focus() { focused++; }, postMessage(message: any) { messages.push(message); } }]);
  await target.fire('notificationclick', { notification: { close() { closed++; }, data: { hostId: 'local', threadId: 'thread-1', url: 'https://malicious.example/' } } });
  assert.equal(focused, 1);
  assert.equal(closed, 1);
  assert.equal(JSON.stringify(messages[0]), JSON.stringify({ type: 'PUSH_NAVIGATE', hostId: 'local', threadId: 'thread-1' }));
  assert.deepEqual(target.opened, []);
});

test('notification click opens only the app root and ignores unsafe identifiers and preview clients', async () => {
  const target = worker();
  target.setClients([{ frameType: 'nested', url: 'https://codex.example/api/preview/private', async focus() { throw new Error('Preview must not be focused'); } }]);
  await target.fire('notificationclick', { notification: { close() {}, data: { hostId: 'local', threadId: 'thread-1', url: 'javascript:alert(1)' } } });
  assert.equal(target.opened[0], 'https://codex.example/?host=local&thread=thread-1');
  await target.fire('notificationclick', { notification: { close() {}, data: { hostId: '../secret', threadId: '<script>', url: 'https://malicious.example/' } } });
  assert.equal(target.opened[1], 'https://codex.example/');
});

test('installation bypasses proxy caches for entry files and preserves stable public offline cache keys', async () => {
  const target = worker();
  await target.fire('install', {});
  const entry = target.networkRequests.find(request => new URL(request.url).pathname === '/index.html');
  assert.equal(new URL(entry.url).searchParams.get('codex-build'), 'test-revision');
  assert.equal(entry.credentials, 'omit');
  assert.equal(entry.cache, 'reload');
  assert.ok(target.cached.has('https://codex.example/index.html'));
  assert.ok(target.cached.has('https://codex.example/assets/public.js'));
  assert.ok([...target.cached.keys()].every(key => !new URL(key).search));
});

test('root navigation bypasses stale proxy HTML while preserving notification destinations and credentials', async () => {
  const target = worker();
  let response!: Promise<Response>;
  target.listeners.get('fetch')!({
    request: { method: 'GET', mode: 'navigate', url: 'https://codex.example/?host=remote&thread=chat', credentials: 'include' },
    respondWith(value: Promise<Response>) { response = value; },
  });
  assert.equal(await (await response).text(), 'network');
  const request = target.networkRequests[0];
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('codex-build'), 'test-revision');
  assert.equal(url.searchParams.get('host'), 'remote');
  assert.equal(url.searchParams.get('thread'), 'chat');
  assert.equal(request.credentials, 'include');
  assert.equal(request.cache, 'no-store');
  assert.equal(target.cached.size, 0);
});

test('worker leaves authenticated APIs, uploads, previews, project files and external requests untouched', () => {
  const target = worker();
  for (const url of ['/api/session', '/api/threads/read', '/api/preview/secret', '/api/files/download', '/uploads/private.png', '/workspace/secrets.txt', '/assets/public.js?private=1', 'https://other.example/assets/public.js']) {
    for (const mode of ['navigate', 'cors']) {
      let intercepted = false;
      target.listeners.get('fetch')!({ request: { method: 'GET', mode, url: new URL(url, 'https://codex.example').href }, respondWith() { intercepted = true; } });
      assert.equal(intercepted, false, url);
    }
  }
  let intercepted = false;
  target.listeners.get('fetch')!({ request: { method: 'POST', url: 'https://codex.example/' }, respondWith() { intercepted = true; } });
  assert.equal(intercepted, false);
});

test('worker serves cached public chunks and falls back to public shell only on root navigation failure', async () => {
  const target = worker();
  target.cached.set('https://codex.example/assets/public.js', new Response('public chunk'));
  let response: Promise<Response> | undefined;
  target.listeners.get('fetch')!({ request: new Request('https://codex.example/assets/public.js'), respondWith(value: Promise<Response>) { response = value; } });
  assert.equal(await (await response!).text(), 'public chunk');
  assert.equal(target.networkRequests.length, 0);
  target.setOffline(true);
  target.cached.set('https://codex.example/index.html', new Response('public application shell'));
  target.listeners.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: 'https://codex.example/?thread=thread-1' }, respondWith(value: Promise<Response>) { response = value; } });
  assert.equal(await (await response!).text(), 'public application shell');
  assert.equal(target.cached.size, 2, 'Navigation must not cache a personalized response or query URL');
});
