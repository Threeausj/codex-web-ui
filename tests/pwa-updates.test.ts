import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

async function withPwa(run: (value: any) => Promise<void>) {
  const names = ['window', 'navigator', 'localStorage', 'Notification', 'matchMedia', 'location'];
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const messages: unknown[] = [];
  const waiting = Object.assign(new EventTarget(), { state: 'installed', postMessage(value: unknown) { messages.push(value); } });
  const registration = Object.assign(new EventTarget(), { waiting: waiting as typeof waiting | null, installing: null, active: {}, update: async () => registration });
  const container = Object.assign(new EventTarget(), { controller: {} as unknown, register: async () => registration, ready: Promise.resolve(registration) });
  const media = () => ({ matches: false, addEventListener() {} });
  const navigator = { onLine: true, userAgent: 'test', platform: 'Linux', maxTouchPoints: 0, serviceWorker: container };
  let reloads = 0;
  const globals: Record<string, unknown> = {
    navigator, window: Object.assign(new EventTarget(), { isSecureContext: true, matchMedia: media }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Notification: { permission: 'granted' }, matchMedia: media, location: { reload() { reloads++; } },
  };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: globals[name] });
  const destination = new URL(`../node_modules/.cache/pwa-update-test-${randomUUID()}.mjs`, import.meta.url);
  await fs.mkdir(new URL('../node_modules/.cache/', import.meta.url), { recursive: true });
  try {
    const compiled = await build({ entryPoints: [new URL('../src/lib/pwa.ts', import.meta.url).pathname], bundle: true, packages: 'external', write: false, format: 'esm', define: { 'import.meta.env.PROD': 'true', 'import.meta.env.VITE_BUILD_ID': '"test"' } });
    await fs.writeFile(destination, compiled.outputFiles[0]!.text, { mode: 0o600 });
    const pwa = await import(destination.href);
    await pwa.initPwa();
    await run({ pwa, waiting, registration, container, navigator, messages, reloads: () => reloads, activate() {
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
