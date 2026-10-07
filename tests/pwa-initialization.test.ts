import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { transform } from 'esbuild';

test('suspended notification initialization times out, aborts HTTP and can retry without signing out', async t => {
  const names = ['window', 'navigator', 'localStorage', 'Notification', 'matchMedia'];
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let subscriptionHung = true;
  const worker = { waiting: null, active: {}, addEventListener() {}, pushManager: { getSubscription: () => subscriptionHung ? new Promise(() => {}) : Promise.resolve(null) } };
  const media = () => ({ matches: false, addEventListener() {} });
  const globals: Record<string, any> = {
    navigator: { onLine: true, userAgent: 'test', platform: 'Linux', maxTouchPoints: 0, serviceWorker: { addEventListener() {}, register: async () => worker, ready: Promise.resolve(worker) } },
    window: { isSecureContext: true, PushManager: {}, Notification: {}, addEventListener() {}, matchMedia: media },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, Notification: { permission: 'granted' }, matchMedia: media,
  };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: globals[name] });
  const destination = new URL(`../node_modules/.cache/pwa-test-${randomUUID()}.mjs`, import.meta.url);
  await fs.mkdir(new URL('../node_modules/.cache/', import.meta.url), { recursive: true });
  try {
    const source = await fs.readFile(new URL('../src/lib/pwa.ts', import.meta.url), 'utf8');
    const compiled = await transform(source, { loader: 'ts', format: 'esm', define: { 'import.meta.env.PROD': 'true', 'import.meta.env.VITE_BUILD_ID': '"test"' } });
    await fs.writeFile(destination, compiled.code, { mode: 0o600 });
    const pwa = await import(destination.href);
    let configHung = true; const requests: { path: string; signal?: AbortSignal; reportError?: boolean }[] = [];
    const api = { runtimeIdentity: () => ({ authenticationGeneration: 1 }), requestHttp: async (path: string, init: any, reportError: boolean) => {
      requests.push({ path, signal: init?.signal, reportError });
      return configHung ? new Promise(() => {}) : { enabled: true, publicKey: 'test-key' };
    } };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const first = pwa.initializeDevicePush(api); await new Promise(resolve => setImmediate(resolve));
    assert.equal(pwa.initializeDevicePush(api), first, 'Only concurrent initialization shares its promise');
    t.mock.timers.tick(15000); await first;
    assert.match(pwa.pwaState.configError, /超时/); assert.equal(requests[0]!.signal?.aborted, true);
    configHung = false;
    const second = pwa.initializeDevicePush(api); assert.notEqual(second, first); await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(15000); await second; assert.match(pwa.pwaState.configError, /超时/);
    subscriptionHung = false; await pwa.initializeDevicePush(api);
    assert.equal(pwa.pwaState.configError, ''); assert.equal(pwa.pwaState.pushReady, true);
    assert.equal(requests.length, 3); assert.ok(requests.every(request => request.path === '/push/config' && request.reportError === false));
  } finally {
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    await fs.rm(destination, { force: true });
  }
});
