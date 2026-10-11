import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

async function withPwa(run: (value: any) => Promise<void>, options: { serviceWorker?: boolean } = {}) {
  const names = ['window', 'navigator', 'localStorage', 'Notification', 'matchMedia', 'location', 'document', 'DOMParser', 'fetch'];
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const messages: unknown[] = [];
  const waiting = Object.assign(new EventTarget(), { state: 'installed', postMessage(value: unknown) { messages.push(value); } });
  const registration = Object.assign(new EventTarget(), { waiting: waiting as typeof waiting | null, installing: null, active: {}, update: async () => registration });
  const container = Object.assign(new EventTarget(), { controller: {} as unknown, register: async () => registration, ready: Promise.resolve(registration) });
  const media = () => ({ matches: false, addEventListener() {} });
  const navigator: any = { onLine: true, userAgent: 'test', platform: 'Linux', maxTouchPoints: 0, ...(options.serviceWorker === false ? {} : { serviceWorker: container }) };
  const sources = { current: ['/assets/index-current.js'], server: ['/assets/index-current.js'] };
  const documentFor = (values: string[]) => ({ querySelectorAll: () => values.map(source => ({ getAttribute: () => source })) });
  const requests: { input: URL; init: RequestInit }[] = [];
  let fetchResponse = async () => new Response('<script type="module" src="/assets/index-current.js"></script>', { headers: { 'content-type': 'text/html' } });
  let reloads = 0;
  const globals: Record<string, unknown> = {
    navigator, window: Object.assign(new EventTarget(), { isSecureContext: true, matchMedia: media }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Notification: { permission: 'granted' }, matchMedia: media, location: { href: 'https://fixture.invalid/?thread=keep-current', origin: 'https://fixture.invalid', reload() { reloads++; } },
    document: { createElement: () => ({}), querySelectorAll: () => documentFor(sources.current).querySelectorAll() },
    DOMParser: class { parseFromString(_html: string, type: string) { assert.equal(type, 'text/html'); return documentFor(sources.server); } },
    fetch: async (input: URL, init: RequestInit) => { requests.push({ input, init }); return fetchResponse(); },
  };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: globals[name] });
  const destination = new URL(`../node_modules/.cache/pwa-update-test-${randomUUID()}.mjs`, import.meta.url);
  await fs.mkdir(new URL('../node_modules/.cache/', import.meta.url), { recursive: true });
  try {
    const compiled = await build({ entryPoints: [new URL('../src/lib/pwa.ts', import.meta.url).pathname], bundle: true, packages: 'external', write: false, format: 'esm', define: { 'import.meta.env.PROD': 'true', 'import.meta.env.VITE_BUILD_ID': '"test"' } });
    await fs.writeFile(destination, compiled.outputFiles[0]!.text, { mode: 0o600 });
    const pwa = await import(destination.href);
    await pwa.initPwa();
    await run({ pwa, waiting, registration, container, navigator, messages, sources, requests,
      fetchResponse(value: typeof fetchResponse) { fetchResponse = value; }, reloads: () => reloads, activate() {
      registration.waiting = null; waiting.state = 'activated'; waiting.dispatchEvent(new Event('statechange'));
      container.controller = {}; container.dispatchEvent(new Event('controllerchange'));
    } });
  } finally {
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    await fs.rm(destination, { force: true });
  }
}

test('another window activating an update leaves an explicit reload action without reloading automatically', async () => {
  await withPwa(async ({ pwa, activate, reloads, messages }) => {
    assert.equal(pwa.pwaState.updateAvailable, true);
    activate();
    assert.equal(reloads(), 0);
    assert.equal(pwa.pwaState.updateAvailable, true);
    await pwa.updatePwa();
    assert.equal(reloads(), 1);
    assert.deepEqual(messages, []);
    assert.equal(pwa.pwaState.updateBusy, false);
  });
});

test('update clicks share activation, show progress and reload once when the worker changes', async () => {
  await withPwa(async ({ pwa, activate, reloads, messages }) => {
    await pwa.updatePwa(); await pwa.updatePwa();
    assert.equal(pwa.pwaState.updateBusy, true);
    assert.deepEqual(messages, [{ type: 'SKIP_WAITING' }]);
    activate();
    assert.equal(reloads(), 1);
    assert.equal(pwa.pwaState.updateBusy, false);
    assert.equal(pwa.pwaState.updateError, '');
  });
});

test('activation timeout enables retry and late activation never reloads a resumed conversation automatically', async t => {
  await withPwa(async ({ pwa, activate, reloads }) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await pwa.updatePwa();
    t.mock.timers.tick(15000);
    assert.equal(pwa.pwaState.updateBusy, false);
    assert.match(pwa.pwaState.updateError, /更新超时/);
    activate();
    assert.equal(reloads(), 0);
    await pwa.updatePwa();
    assert.equal(reloads(), 1);
  });
});

test('offline and postMessage failures show an error and permit a later successful update', async () => {
  await withPwa(async ({ pwa, waiting, navigator, activate, messages }) => {
    navigator.onLine = false;
    await pwa.updatePwa();
    assert.match(pwa.pwaState.updateError, /连接网络/);
    assert.equal(pwa.pwaState.updateBusy, false);
    assert.deepEqual(messages, []);
    navigator.onLine = true;
    const send = waiting.postMessage;
    waiting.postMessage = () => { throw new Error('Worker unavailable'); };
    await pwa.updatePwa();
    assert.equal(pwa.pwaState.updateError, 'Worker unavailable');
    assert.equal(pwa.pwaState.updateBusy, false);
    waiting.postMessage = send;
    await pwa.updatePwa();
    activate();
    assert.equal(pwa.pwaState.updateError, '');
  });
});

test('a discarded waiting worker clears its stale update prompt', async () => {
  await withPwa(async ({ pwa, waiting, registration, reloads }) => {
    registration.waiting = null;
    waiting.state = 'redundant'; waiting.dispatchEvent(new Event('statechange'));
    assert.equal(pwa.pwaState.updateAvailable, false);
    await pwa.updatePwa();
    assert.equal(pwa.pwaState.updateBusy, false);
    assert.equal(reloads(), 0);
  });
});

test('manual checks share one request, ignore third-party scripts and report the deployed version as current', async () => {
  await withPwa(async ({ pwa, registration, requests, sources, messages, reloads }) => {
    registration.waiting = null;
    sources.current.push('https://analytics.invalid/current.js');
    sources.server.push('https://analytics.invalid/changed.js');
    let updates = 0;
    registration.update = async () => { updates++; return registration; };
    const first = pwa.checkPwaUpdate();
    assert.equal(pwa.checkPwaUpdate(), first);
    assert.equal(pwa.pwaState.updateCheckStatus, 'checking');
    assert.equal(await first, false);
    assert.equal(pwa.pwaState.updateCheckStatus, 'latest');
    assert.equal(requests.length, 1);
    assert.equal(updates, 1);
    assert.equal(requests[0].input.pathname, '/index.html');
    assert.ok(requests[0].input.searchParams.has('codex-update'));
    assert.equal(requests[0].init.cache, 'no-store');
    assert.equal(requests[0].init.credentials, 'omit');
    assert.equal(requests[0].init.redirect, 'error');
    assert.equal(requests[0].init.signal.aborted, true);
    assert.equal(reloads(), 0);
    assert.deepEqual(messages, []);
  });
});

test('a deployed build without a waiting worker is actionable instead of silently ignoring an update click', async () => {
  await withPwa(async ({ pwa, registration, sources, messages, reloads }) => {
    registration.waiting = null;
    sources.server = ['/assets/index-new-build.js'];
    assert.equal(await pwa.checkPwaUpdate(), true);
    assert.equal(pwa.pwaState.updateCheckStatus, 'available');
    assert.equal(pwa.pwaState.updateAvailable, true);
    await pwa.updatePwa();
    assert.equal(reloads(), 1);
    assert.deepEqual(messages, []);
  });
});

test('stylesheets added after startup by lazy workspace panels do not masquerade as a deployed update', async () => {
  await withPwa(async ({ pwa, registration, sources }) => {
    registration.waiting = null;
    sources.current.push('/assets/CodeEditor-lazy.css', '/assets/InteractiveTerminal-lazy.css', '/assets/GitPanel-lazy.css');
    assert.equal(await pwa.checkPwaUpdate(), false);
    assert.equal(pwa.pwaState.updateCheckStatus, 'latest');
    assert.equal(pwa.pwaState.updateAvailable, false);
    sources.server = ['/assets/index-real-deployment.js'];
    assert.equal(await pwa.checkPwaUpdate(), true);
    assert.equal(pwa.pwaState.updateCheckStatus, 'available');
  });
});

test('a confirmed latest version clears an obsolete activation error, while a failed check preserves it', async () => {
  await withPwa(async ({ pwa, registration, fetchResponse }) => {
    registration.waiting = null;
    pwa.pwaState.updateError = '应用更新超时';
    fetchResponse(async () => new Response('Unavailable', { status: 503 }));
    await pwa.checkPwaUpdate();
    assert.equal(pwa.pwaState.updateError, '应用更新超时');
    fetchResponse(async () => new Response('<html>fixture</html>', { headers: { 'content-type': 'text/html' } }));
    await pwa.checkPwaUpdate();
    assert.equal(pwa.pwaState.updateCheckStatus, 'latest');
    assert.equal(pwa.pwaState.updateError, '');
  });
});

test('an ordinary HTTP browser without service workers can check the server and reload the deployed update', async () => {
  await withPwa(async ({ pwa, sources, reloads, messages }) => {
    assert.equal(pwa.pwaState.registrationStatus, 'unavailable');
    sources.server = ['/assets/index-http-update.js'];
    assert.equal(await pwa.checkPwaUpdate(), true);
    await pwa.updatePwa();
    assert.equal(reloads(), 1);
    assert.deepEqual(messages, []);
    assert.equal(pwa.pwaState.updateError, '');
  }, { serviceWorker: false });
});

test('manual checks wait for an installing worker and do not claim the latest version while resources download', async () => {
  await withPwa(async ({ pwa, registration }) => {
    registration.waiting = null;
    const installing = Object.assign(new EventTarget(), { state: 'installing' });
    registration.update = async () => { registration.installing = installing; return registration; };
    const checked = pwa.checkPwaUpdate();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pwa.pwaState.updateCheckStatus, 'checking');
    registration.waiting = installing;
    installing.state = 'installed'; installing.dispatchEvent(new Event('statechange'));
    assert.equal(await checked, true);
    assert.equal(pwa.pwaState.updateCheckStatus, 'available');
  });
});

test('failed manual checks show an error and a fresh request can succeed without clearing login or storage', async () => {
  await withPwa(async ({ pwa, registration, fetchResponse, requests }) => {
    registration.waiting = null;
    fetchResponse(async () => new Response('Unavailable', { status: 503 }));
    assert.equal(await pwa.checkPwaUpdate(), false);
    assert.equal(pwa.pwaState.updateCheckStatus, 'error');
    assert.match(pwa.pwaState.updateCheckError, /无法检查服务器版本/);
    fetchResponse(async () => new Response('<html>fixture</html>', { headers: { 'content-type': 'text/html' } }));
    assert.equal(await pwa.checkPwaUpdate(), false);
    assert.equal(pwa.pwaState.updateCheckStatus, 'latest');
    assert.equal(pwa.pwaState.updateCheckError, '');
    assert.equal(requests.length, 2);
  });
});

test('a suspended server check times out and aborts its request so a later check can recover', async t => {
  await withPwa(async ({ pwa, registration, fetchResponse, requests }) => {
    registration.waiting = null;
    fetchResponse(() => new Promise<Response>(() => {}));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const checked = pwa.checkPwaUpdate();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(15000);
    assert.equal(await checked, false);
    assert.equal(pwa.pwaState.updateCheckStatus, 'error');
    assert.match(pwa.pwaState.updateCheckError, /检查更新超时/);
    assert.equal(requests[0].init.signal.aborted, true);
    fetchResponse(async () => new Response('<html>fixture</html>', { headers: { 'content-type': 'text/html' } }));
    await pwa.checkPwaUpdate();
    assert.equal(pwa.pwaState.updateCheckStatus, 'latest');
  });
});

test('queued updates wait for idle and recheck the guard if work starts before controller activation', async () => {
  await withPwa(async ({ pwa, messages, activate, reloads }) => {
    let safe = false;
    pwa.setPwaUpdateGuard(() => safe);
    await pwa.updatePwa();
    assert.equal(pwa.pwaState.updateDeferred, true);
    assert.equal(pwa.pwaState.updateBusy, false);
    assert.deepEqual(messages, []);
    await pwa.resumeDeferredPwaUpdate();
    assert.deepEqual(messages, []);
    safe = true;
    await pwa.resumeDeferredPwaUpdate();
    assert.deepEqual(messages, [{ type: 'SKIP_WAITING' }]);
    safe = false;
    activate();
    assert.equal(reloads(), 0);
    assert.equal(pwa.pwaState.updateDeferred, true);
    assert.equal(pwa.pwaState.updateBusy, false);
    safe = true;
    await pwa.resumeDeferredPwaUpdate();
    assert.equal(reloads(), 1);
    assert.equal(pwa.pwaState.updateDeferred, false);
  });
});

test('an explicitly canceled deferred update does not reload after work finishes', async () => {
  await withPwa(async ({ pwa, messages, reloads }) => {
    let safe = false;
    pwa.setPwaUpdateGuard(() => safe);
    await pwa.updatePwa();
    pwa.cancelDeferredPwaUpdate();
    safe = true;
    await pwa.resumeDeferredPwaUpdate();
    assert.equal(reloads(), 0);
    assert.deepEqual(messages, []);
  });
});
