import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import express from "express";
import webPush from "web-push";
import { test, expect, send } from "./fixtures";
import type { Page } from "@playwright/test";

// Exercise built assets and a real Service Worker, independently of the Vite dev server.
// API/RPC responses stay isolated in the existing wire fixtures; no model or push provider is contacted.
test.describe.configure({ mode: "serial" });
let server: http.Server;
let origin = "";
let workerRevision = "";
const publicKey = webPush.generateVAPIDKeys().publicKey;

test.beforeAll(async () => {
  const dist = path.resolve("dist");
  const worker = await fs.readFile(path.join(dist, "sw.js"), "utf8");
  if (worker.includes("__CODEX_PRECACHE__")) throw new Error("Run npm run build before PWA browser tests");
  const app = express();
  app.get("/sw.js", (_req, res) => res.set({ "Cache-Control": "no-store", "Service-Worker-Allowed": "/" }).type("js").send(worker + workerRevision));
  app.use(express.static(dist));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
test.afterAll(async () => { if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve())); });

async function loginBuilt(page: Page, key = publicKey, authenticated = false) {
  await page.route("**/api/push/config*", (route) => route.fulfill({ json: { enabled: true, publicKey: key } }));
  await page.goto(origin);
  if (!authenticated) {
    await page.getByRole("textbox", { name: "访问密码" }).fill("test-password-123");
    await page.getByRole("button", { name: "进入工作区", exact: true }).click();
  }
  await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL)).toContain('/sw.js?build=');
}

// Keep the browser subscription shared across tabs and reloads, just like PushManager.
// This replaces only consent/subscription APIs; installation and worker lifecycle remain real.
async function installPushFixture(page: Page, initial: { active?: boolean; key?: string; permission?: NotificationPermission } = {}) {
  await page.addInitScript(({ key, active, permission }) => {
    const storageKey = "codex.testPushSubscription";
    const decodeKey = (encoded: string) => Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
    const encodeKey = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const read = () => JSON.parse(localStorage.getItem(storageKey)!);
    const write = (value: any) => localStorage.setItem(storageKey, JSON.stringify(value));
    if (!localStorage.getItem(storageKey)) write({ active, key, permission, generation: 0, endpoint: "https://fcm.googleapis.com/fcm/send/fixture-device-0" });
    const state = { permissionRequests: 0, gestures: [] as boolean[], subscriptions: [] as any[], unsubscriptions: 0, unsubscribeFailure: '' };
    (window as any).pushFixture = state;
    const subscriptionFor = (value: any) => ({
      endpoint: value.endpoint,
      options: { userVisibleOnly: true, applicationServerKey: decodeKey(value.key).buffer },
      toJSON: () => ({ endpoint: value.endpoint, expirationTime: null, keys: { p256dh: "fixture-public-key", auth: "fixture-auth" } }),
      unsubscribe: async () => {
        state.unsubscriptions++;
        if (state.unsubscribeFailure === 'reject') throw new Error('Browser subscription cleanup failed');
        if (state.unsubscribeFailure === 'false') return false;
        const current = read();
        if (current.endpoint === value.endpoint) write({ ...current, active: false });
        return true;
      },
    });
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => read().permission });
    Notification.requestPermission = async () => {
      state.permissionRequests++;
      state.gestures.push(navigator.userActivation.isActive);
      write({ ...read(), permission: "granted" });
      return "granted";
    };
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", { configurable: true, get: () => ({
      getSubscription: async () => { const current = read(); return current.active ? subscriptionFor(current) : null; },
      subscribe: async (options: any) => {
        const bytes = new Uint8Array(options.applicationServerKey);
        state.subscriptions.push({ userVisibleOnly: options.userVisibleOnly, keyLength: bytes.length });
        const current = read();
        const generation = current.generation + 1;
        const value = { ...current, active: true, key: encodeKey(bytes), generation, endpoint: `https://fcm.googleapis.com/fcm/send/fixture-device-${generation}` };
        write(value);
        return subscriptionFor(value);
      },
    }) });
  }, { key: initial.key ?? publicKey, active: initial.active ?? false, permission: initial.permission ?? "default" });
}

type PushCall = { method: string; pathname: string; body: any; csrf?: string; tab?: string };
async function capturePushApi(page: Page, calls: PushCall[], options: { tab?: string; testStatus?: number; key?: string } = {}) {
  await page.route("**/api/push/**", (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/config")) return route.fulfill({ json: { enabled: true, publicKey: options.key ?? publicKey } });
    if (pathname.endsWith('/status')) return route.fulfill({ json: { devices: 1, queued: 0, retrying: 0, delivered: 0, failed: 0, expired: 0, nextRetryAt: null, lastDeliveredAt: null, lastFailureAt: null, lastFailure: null } });
    calls.push({ method: request.method(), pathname, body: request.postDataJSON(), csrf: request.headers()["x-csrf-token"], tab: options.tab });
    if (pathname.endsWith("/test") && options.testStatus) return route.fulfill({ status: options.testStatus, json: { error: "Notification subscription has expired" } });
    return route.fulfill({ json: { ok: true, expiresAt: Date.now() + 2_592_000_000 } });
  });
}
async function openPushSettings(page: Page) {
  const existing = page.getByRole("button", { name: "应用与通知", exact: true });
  if (await existing.isVisible()) { await existing.click(); return; }
  const sidebar = page.getByRole("button", { name: "打开侧边栏", exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator(".settings-button").click();
  await page.getByRole("button", { name: "应用与通知", exact: true }).click();
}

test("built PWA installs its real worker, caches public resources only and starts offline without private history", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginBuilt(page);
  const manifest = await (await context.request.get(origin + "/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.launch_handler).toEqual({ client_mode: "focus-existing" });
  expect(manifest.icons.some((icon: any) => icon.sizes === "512x512" && icon.purpose === "maskable")).toBe(true);
  for (const icon of manifest.icons) expect((await context.request.get(origin + icon.src)).status()).toBe(200);
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await page.locator('[data-section="recent"] .thread-row').first().click();
  await expect(page.locator(".agent-message")).toContainText("历史保持可读");
  await openPushSettings(page);
  const enable = page.getByRole("button", { name: "启用通知", exact: true });
  // Headless Chromium may deny notifications by default; the real worker must respect it.
  if (await page.evaluate(() => Notification.permission === "denied")) {
    await expect(enable).toBeDisabled();
    await expect(page.getByText("通知已被阻止。请在系统或浏览器设置中允许此应用发送通知。", { exact: true })).toBeVisible();
  } else await expect(enable).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const cached = await page.evaluate(async () => {
    const result: string[] = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) result.push(new URL(request.url).pathname);
    return result;
  });
  expect(cached).toContain("/index.html");
  expect(cached.some((pathname) => /InteractiveTerminal|CodeEditor|pdf\.worker/.test(pathname))).toBe(false);
  expect(cached.some((pathname) => pathname.startsWith("/api/") || pathname.includes("thread-existing"))).toBe(false);
  // Large feature bundles cache on first use instead of delaying installation.
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) if (request.url.includes("InteractiveTerminal")) return true;
    return false;
  })).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText("目前离线，联网后即可登录工作区。", { exact: true })).toBeVisible();
  await expect(page.locator(".agent-message")).toHaveCount(0);
  await page.getByRole("textbox", { name: "访问密码" }).fill("test-password-123");
  await expect(page.getByRole("button", { name: "进入工作区", exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toBeEnabled();
});

test("notification consent is requested only on click; device preferences, test, disable and logout use authenticated endpoints", async ({ page, mock }) => {
  const calls: PushCall[] = [];
  await installPushFixture(page);
  await capturePushApi(page, calls);
  await loginBuilt(page);
  await openPushSettings(page);
  const enable = page.getByRole("button", { name: "启用通知", exact: true });
  await expect(enable).toBeEnabled();
  expect(await page.evaluate(() => (window as any).pushFixture.permissionRequests)).toBe(0);
  await enable.click();
  await expect(page.getByText("本机已启用", { exact: true })).toBeVisible();
  const consent = await page.evaluate(() => (window as any).pushFixture);
  expect(consent.permissionRequests).toBe(1);
  expect(consent.gestures).toEqual([true]);
  expect(consent.subscriptions).toEqual([{ userVisibleOnly: true, keyLength: 65 }]);
  await page.getByRole("checkbox", { name: "回复已完成", exact: true }).uncheck();
  await expect.poll(() => calls.find((call) => call.method === "PATCH")?.body.preferences.completed).toBe(false);
  await page.getByRole("button", { name: "发送测试通知", exact: true }).click();
  await expect.poll(() => calls.some((call) => call.pathname.endsWith("/test"))).toBe(true);
  await page.getByRole("button", { name: "关闭通知", exact: true }).click();
  await expect(enable).toBeVisible();
  expect(await page.evaluate(() => (window as any).pushFixture.unsubscriptions)).toBe(1);
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  await enable.click();
  await expect(page.getByText("本机已启用", { exact: true })).toBeVisible();
  expect(calls.filter((call) => call.method === "POST" && call.pathname.endsWith("/subscription")).at(-1)?.body.preferences.completed).toBe(false);
  await page.getByRole("button", { name: "账户", exact: true }).click();
  await page.getByRole("button", { name: "退出网页", exact: true }).click();
  await expect(page.getByRole("button", { name: "进入工作区", exact: true })).toBeVisible();
  expect(mock.authenticated).toBe(false);
  expect(await page.evaluate(() => (window as any).pushFixture.unsubscriptions)).toBe(2);
  // The authenticated logout endpoint revokes every grant for this login;
  // browser cleanup does not issue a separate request after signing out.
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  expect(calls.every((call) => call.csrf === "mock-csrf")).toBe(true);
});

for (const failure of ['false', 'reject']) {
  test(`browser unsubscribe ${failure} cannot block server logout or restore the retired device`, async ({ page, mock }) => {
    const calls: PushCall[] = [];
    await installPushFixture(page, { active: true, permission: 'granted' });
    await capturePushApi(page, calls);
    await loginBuilt(page);
    await expect.poll(() => calls.filter(call => call.method === 'POST' && call.pathname.endsWith('/subscription')).length).toBe(1);
    await openPushSettings(page);
    await page.evaluate(value => { (window as any).pushFixture.unsubscribeFailure = value; }, failure);
    await page.getByRole('button', { name: '账户', exact: true }).click();
    await page.getByRole('button', { name: '退出网页', exact: true }).click();
    await expect(page.getByRole('button', { name: '进入工作区', exact: true })).toBeVisible();
    expect(mock.authenticated).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any).pushFixture.unsubscriptions)).toBe(1);
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
    const restoredBefore = calls.filter(call => call.method === 'POST' && call.pathname.endsWith('/subscription')).length;
    await page.getByRole('textbox', { name: '访问密码' }).fill('test-password-123');
    await page.getByRole('button', { name: '进入工作区', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
    await openPushSettings(page);
    await expect(page.getByRole('button', { name: '启用通知', exact: true })).toBeVisible();
    expect(calls.filter(call => call.method === 'POST' && call.pathname.endsWith('/subscription')).length).toBe(restoredBefore);
  });
}

test('push tests show pending, acceptance and failure; a separate local test checks display without sending push', async ({ page }) => {
  const calls: PushCall[] = [];
  await installPushFixture(page, { active: true, permission: 'granted' });
  await capturePushApi(page, calls);
  await page.addInitScript(() => {
    (window as any).systemNotifications = [];
    ServiceWorkerRegistration.prototype.showNotification = async (title, options) => {
      (window as any).systemNotifications.push({ title, options });
    };
  });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let testRequests = 0;
  await page.route('**/api/push/test', async route => {
    testRequests++;
    await pending;
    await route.fulfill({ json: { ok: true } });
  });
  await loginBuilt(page);
  await openPushSettings(page);
  await page.getByRole('button', { name: '发送测试通知', exact: true }).click();
  await expect.poll(() => testRequests).toBe(1);
  await expect(page.getByRole('button', { name: '正在发送…', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('正在发送测试通知…');
  release();
  await expect(page.getByRole('status')).toContainText('推送服务已接收测试通知，请查看系统通知。');
  await page.getByRole('button', { name: '检查系统通知', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('系统通知已发出，请查看通知栏。');
  expect(await page.evaluate(() => (window as any).systemNotifications)).toEqual([
    { title: 'Codex 系统通知检查', options: expect.objectContaining({ data: {}, tag: expect.stringContaining('codex-system-test-') }) },
  ]);
  expect(testRequests).toBe(1);
  await page.route('**/api/push/test', route => route.fulfill({ status: 502, json: { error: 'Unable to deliver the notification; check server access to the push provider' } }));
  await page.getByRole('button', { name: '发送测试通知', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to deliver');
  await expect(page.getByRole('button', { name: '发送测试通知', exact: true })).toBeEnabled();
});

test('returning to the foreground renews the existing device without asking for permission or replacing it', async ({ page }) => {
  const calls: PushCall[] = [];
  await installPushFixture(page, { active: true, permission: 'granted' });
  await page.addInitScript(() => localStorage.setItem('codex.devicePushPreferences', JSON.stringify({ completed: false, approval: true, errors: true })));
  await capturePushApi(page, calls);
  await loginBuilt(page);
  await expect.poll(() => calls.filter(call => call.pathname.endsWith('/subscription')).length).toBeGreaterThan(0);
  const before = calls.length;
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect.poll(() => calls.length).toBeGreaterThan(before);
  const restored = calls.at(-1)!;
  expect(restored.method).toBe('POST');
  expect(restored.body.subscription.endpoint).toContain('fixture-device-0');
  expect(restored.body.preferences).toEqual({ completed: false, approval: true, errors: true });
  const fixture = await page.evaluate(() => (window as any).pushFixture);
  expect(fixture.permissionRequests).toBe(0);
  expect(fixture.subscriptions).toEqual([]);
  expect(fixture.unsubscriptions).toBe(0);
});

test('backgrounding a pending push test bypasses a cached anonymous session and reconnects without logging out or replaying actions', async ({ page, mock }) => {
  const calls: PushCall[] = [];
  const sessionRequests: URL[] = [];
  await installPushFixture(page, { active: true, permission: 'granted' });
  await capturePushApi(page, calls);
  await page.route('**/api/auth/session*', route => {
    const url = new URL(route.request().url());
    sessionRequests.push(url);
    // Reproduce the deployed proxy: the plain URL has a cached anonymous response.
    const authenticated = url.searchParams.has('_request') && mock.authenticated;
    return route.fulfill({ json: { authenticated, authRequired: true, ...(authenticated ? { csrfToken: 'mock-csrf' } : {}) } });
  });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let testRequests = 0;
  await page.route('**/api/push/test', async route => {
    testRequests++;
    await pending;
    await route.fulfill({ json: { ok: true } });
  });
  await loginBuilt(page);
  await page.locator('[data-section="recent"] .thread-row').first().click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.fill('测试通知切后台后保留草稿');
  await openPushSettings(page);
  const before = sessionRequests.length;
  await page.getByRole('button', { name: '发送测试通知', exact: true }).click();
  await expect.poll(() => testRequests).toBe(1);
  try {
    await page.evaluate(() => {
      (window as any).testVisibility = 'hidden';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window as any).testVisibility });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => (window as any).testVisibility === 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await mock.sockets[0]!.close({ code: 1001, reason: 'Mobile app backgrounded' });
    mock.turns.get('thread-existing')!.push({
      id: 'push-test-background-turn', status: 'completed',
      items: [{ id: 'push-test-background-answer', type: 'agentMessage', text: '测试通知期间完成的历史已恢复' }],
    });
    await page.evaluate(() => {
      (window as any).testVisibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect.poll(() => mock.sockets.length, { timeout: 12000 }).toBe(2);
    await expect(page.locator('.agent-message').last()).toHaveText('测试通知期间完成的历史已恢复');
    await expect(page.getByRole('textbox', { name: '访问密码' })).toHaveCount(0);
    await expect(input).toHaveValue('测试通知切后台后保留草稿');
    expect(sessionRequests.length).toBeGreaterThan(before);
    expect(sessionRequests.slice(before).every(url => !!url.searchParams.get('_request'))).toBe(true);
    release();
    await expect(page.getByRole('status')).toContainText('推送服务已接收测试通知');
    await expect(page.getByRole('button', { name: '发送测试通知', exact: true })).toBeEnabled();
    expect(testRequests).toBe(1);
    expect(mock.request('turn/start')).toBeUndefined();
    expect(mock.authenticated).toBe(true);
    expect((await page.evaluate(() => (window as any).pushFixture)).permissionRequests).toBe(0);
  } finally { release(); }
});

test("a waiting production worker prompts for update and cannot reload an active turn", async ({ page, mock }) => {
  await loginBuilt(page);
  mock.holdFinalMessage = true;
  await send(page, "更新时保留运行中的任务");
  await expect(page.getByRole("button", { name: "停止生成", exact: true })).toBeVisible();
  workerRevision = "\n// lifecycle-update-fixture\n";
  try {
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    const update = page.getByRole("button", { name: "任务完成后更新", exact: true });
    await expect(update).toBeVisible();
    await expect(update).toBeDisabled();
    expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())!.waiting)).toBe(true);
    mock.finishStream();
    const ready = page.getByRole("button", { name: "更新应用", exact: true });
    await expect(ready).toBeEnabled();
    await Promise.all([page.waitForEvent("domcontentloaded"), ready.click()]);
    await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toBeEnabled();
    await expect(ready).toHaveCount(0);
    expect(mock.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  } finally { workerRevision = ""; }
});

test("rotated VAPID keys retire the old device subscription without automatic consent or resubscription", async ({ page }) => {
  const oldKey = webPush.generateVAPIDKeys().publicKey;
  const calls: PushCall[] = [];
  await installPushFixture(page, { active: true, key: oldKey, permission: "granted" });
  await capturePushApi(page, calls);
  await loginBuilt(page);
  await openPushSettings(page);
  const enable = page.getByRole("button", { name: "启用通知", exact: true });
  await expect(enable).toBeEnabled();
  await expect(page.getByRole("alert")).toContainText("请重新启用通知");
  expect(await page.evaluate(() => (window as any).pushFixture)).toMatchObject({ permissionRequests: 0, subscriptions: [], unsubscriptions: 1 });
  expect(calls.filter((call) => call.pathname.endsWith("/subscription"))).toHaveLength(0);

  await enable.click();
  await expect(page.getByText("本机已启用", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).pushFixture)).toMatchObject({ permissionRequests: 0, subscriptions: [{ userVisibleOnly: true, keyLength: 65 }], unsubscriptions: 1 });
  const registered = calls.find((call) => call.method === "POST" && call.pathname.endsWith("/subscription"));
  expect(registered?.body.subscription.endpoint).toBe("https://fcm.googleapis.com/fcm/send/fixture-device-1");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("codex.testPushSubscription")!).key)).toBe(publicKey);
});

test("an expired push endpoint is removed locally and cannot be silently restored after refresh", async ({ page }) => {
  const calls: PushCall[] = [];
  const expiredEndpoint = "https://fcm.googleapis.com/fcm/send/fixture-device-0";
  await installPushFixture(page, { active: true, permission: "granted" });
  await capturePushApi(page, calls, { testStatus: 410 });
  await loginBuilt(page);
  await openPushSettings(page);
  await expect(page.getByText("本机已启用", { exact: true })).toBeVisible();
  expect(calls.some((call) => call.method === "POST" && call.pathname.endsWith("/subscription"))).toBe(true);
  await page.getByRole("button", { name: "发送测试通知", exact: true }).click();
  const enable = page.getByRole("button", { name: "启用通知", exact: true });
  await expect(enable).toBeEnabled();
  await expect(page.getByRole("alert")).toContainText("通知订阅已失效");
  expect(await page.evaluate(() => (window as any).pushFixture.unsubscriptions)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("codex.testPushSubscription")!).active)).toBe(false);

  await page.getByRole("button", { name: "刷新通知状态", exact: true }).click();
  await expect(enable).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "消息输入框", exact: true })).toBeEnabled();
  await openPushSettings(page);
  await expect(enable).toBeEnabled();
  const testRequestIndex = calls.findIndex((call) => call.pathname.endsWith("/test"));
  expect(testRequestIndex).toBeGreaterThanOrEqual(0);
  expect(calls.slice(testRequestIndex + 1).filter((call) => call.method === "POST" && call.pathname.endsWith("/subscription"))).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).pushFixture)).toMatchObject({ permissionRequests: 0, subscriptions: [] });

  await enable.click();
  await expect(page.getByText("本机已启用", { exact: true })).toBeVisible();
  const freshRegistration = calls.filter((call) => call.method === "POST" && call.pathname.endsWith("/subscription")).at(-1);
  expect(freshRegistration?.body.subscription.endpoint).not.toBe(expiredEndpoint);
  expect(freshRegistration?.body.subscription.endpoint).toBe("https://fcm.googleapis.com/fcm/send/fixture-device-1");
});

test("notification preferences stay synchronized across tabs and restoring a device preserves the latest choice", async ({ page, context, mock }) => {
  const calls: PushCall[] = [];
  await installPushFixture(page, { active: true, permission: "granted" });
  await capturePushApi(page, calls, { tab: "first" });
  await loginBuilt(page);
  await openPushSettings(page);

  const other = await context.newPage();
  try {
    await mock.install(other);
    await installPushFixture(other, { active: true, permission: "granted" });
    await capturePushApi(other, calls, { tab: "second" });
    await loginBuilt(other, publicKey, true);
    await openPushSettings(other);
    const otherErrors = other.getByRole("checkbox", { name: "运行出错", exact: true });
    await expect(otherErrors).toBeChecked();

    await page.getByRole("checkbox", { name: "运行出错", exact: true }).uncheck();
    await expect.poll(() => calls.find((call) => call.method === "PATCH")?.body.preferences.errors).toBe(false);
    await expect(otherErrors).not.toBeChecked();
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);

    const previousCalls = calls.length;
    await other.getByRole("button", { name: "刷新通知状态", exact: true }).click();
    await expect.poll(() => calls.slice(previousCalls).find((call) => call.tab === "second" && call.method === "POST" && call.pathname.endsWith("/subscription"))?.body.preferences.errors).toBe(false);
    await expect(otherErrors).not.toBeChecked();
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    expect(calls.every((call) => call.csrf === "mock-csrf")).toBe(true);
  } finally { await other.close(); }
});

test("slow subscription restoration cannot overwrite a preference change or re-register an expired device", async ({ page }) => {
  const calls: PushCall[] = [];
  let releaseRestore: (() => Promise<void>) | undefined;
  await installPushFixture(page, { active: true, permission: "granted" });
  await capturePushApi(page, calls, { testStatus: 410 });
  await page.route("**/api/push/subscription", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    calls.push({ method: "POST", pathname: "/api/push/subscription", body: route.request().postDataJSON() });
    releaseRestore = async () => { await route.fulfill({ json: { ok: true } }); };
  });
  await loginBuilt(page);
  await openPushSettings(page);
  await expect(page.getByText("本机已启用", { exact: true })).toBeVisible();
  await expect.poll(() => !!releaseRestore).toBe(true);
  const testNotification = page.getByRole("button", { name: "发送测试通知", exact: true });
  await expect(testNotification).toBeDisabled();
  await page.getByRole("checkbox", { name: "运行出错", exact: true }).uncheck();
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  await page.unroute("**/api/push/subscription");
  await releaseRestore!();
  await expect.poll(() => calls.find((call) => call.method === "PATCH")?.body.preferences.errors).toBe(false);
  await expect(testNotification).toBeEnabled();
  await testNotification.click();
  await expect(page.getByRole("button", { name: "启用通知", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "刷新通知状态", exact: true }).click();
  await expect(page.getByRole("button", { name: "启用通知", exact: true })).toBeEnabled();
  const expired = calls.findIndex((call) => call.pathname.endsWith("/test"));
  expect(calls.slice(expired + 1).filter((call) => call.method === "POST" && call.pathname.endsWith("/subscription"))).toHaveLength(0);
});

test('a late push test from a signed-out login cannot change a fresh login or its current notification operation', async ({ page, mock }) => {
  const calls: PushCall[] = [];
  await installPushFixture(page, { active: true, permission: 'granted' });
  await capturePushApi(page, calls);
  const pending: import('@playwright/test').Route[] = [];
  await page.route('**/api/push/test', route => { pending.push(route); });
  await loginBuilt(page);
  await openPushSettings(page);
  await page.getByRole('button', { name: '发送测试通知', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '退出网页', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入工作区', exact: true })).toBeVisible();
  expect(mock.authenticated).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).pushFixture.unsubscriptions)).toBe(1);
  await page.getByRole('textbox', { name: '访问密码' }).fill('test-password-123');
  await page.getByRole('button', { name: '进入工作区', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toBeEnabled();
  await openPushSettings(page);
  await page.getByRole('button', { name: '启用通知', exact: true }).click();
  await expect(page.getByText('本机已启用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发送测试通知', exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  await pending[0]!.fulfill({ status: 410, json: { error: 'Old device endpoint expired' } });
  await expect(page.getByRole('button', { name: '正在发送…', exact: true })).toBeDisabled();
  expect(mock.authenticated).toBe(true);
  expect(await page.evaluate(() => (window as any).pushFixture.unsubscriptions)).toBe(1);
  await pending[1]!.fulfill({ json: { ok: true } });
  await expect(page.getByRole('button', { name: '发送测试通知', exact: true })).toBeEnabled();
  await expect(page.getByText('本机已启用', { exact: true })).toBeVisible();
  await expect(page.getByText('Old device endpoint expired', { exact: true })).toHaveCount(0);
});

test('queued test notifications show retry acceptance instead of claiming provider delivery and recover the status', async ({ page }) => {
  await installPushFixture(page, { active: true, permission: 'granted' });
  const calls: PushCall[] = [];
  await capturePushApi(page, calls);
  let queued = false;
  await page.route('**/api/push/status*', route => route.fulfill({ json: {
    devices: 1, queued: queued ? 1 : 0, retrying: queued ? 1 : 0, delivered: queued ? 0 : 1, failed: 0, expired: 0,
    nextRetryAt: queued ? Date.now() + 30000 : null, lastDeliveredAt: queued ? null : Date.now(),
    lastFailureAt: queued ? Date.now() : null, lastFailure: queued ? 'rate_limited' : null,
  } }));
  await page.route('**/api/push/test', route => {
    queued = true;
    return route.fulfill({ status: 202, json: { ok: true, queued: true, retryAt: Date.now() + 30000 } });
  });
  await loginBuilt(page);
  await openPushSettings(page);
  await page.getByRole('button', { name: '发送测试通知', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('测试通知已保存，服务器会自动重试');
  await expect(page.getByRole('status')).not.toContainText('推送服务已接收测试通知');
  const health = page.getByLabel('推送投递状态');
  await expect(health).toContainText('待发送 1 条');
  await expect(health).toContainText('自动重试 1 条');
  await expect(health).toContainText('推送服务限流');
  await expect(page.getByRole('textbox', { name: '访问密码' })).toHaveCount(0);
  queued = false;
  await page.getByRole('button', { name: '刷新通知状态', exact: true }).click();
  await expect(health).toContainText('推送服务已接收 1 条');
  await expect(health).not.toContainText('待发送');
  await expect(health).not.toContainText('推送服务限流');
});

test('notification diagnostics show bounded failure and expiration without exposing provider credentials', async ({ page }) => {
  await installPushFixture(page, { active: true, permission: 'granted' });
  await capturePushApi(page, []);
  await page.route('**/api/push/status*', route => route.fulfill({ json: {
    devices: 1, queued: 0, retrying: 0, delivered: 2, failed: 1, expired: 3, nextRetryAt: null,
    lastDeliveredAt: Date.now() - 2000, lastFailureAt: Date.now(), lastFailure: 'expired',
  } }));
  await loginBuilt(page);
  await openPushSettings(page);
  const health = page.getByLabel('推送投递状态');
  await expect(health).toContainText('推送服务已接收 2 条');
  await expect(health).toContainText('发送失败 1 条 · 已过期 3 条');
  await expect(health).toContainText('通知已超过有效期');
  await expect(health).not.toContainText('fcm.googleapis.com');
  await expect(health).not.toContainText('fixture-auth');
  await expect(page.getByText('网络或推送服务暂时出错时，服务器会保存通知并自动重试；最多尝试 8 次，有效期 1 小时。服务接收成功不代表手机已显示通知。', { exact: true })).toBeVisible();
});
