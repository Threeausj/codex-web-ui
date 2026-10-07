/* Replaced with this build's public assets by the Vite build plugin. */
const BUILD = "__CODEX_BUILD__";
const PRECACHE = __CODEX_PRECACHE__;
const CACHE_PREFIX = "codex-app-shell-";
const CACHE_NAME = CACHE_PREFIX + BUILD;
const PUBLIC_PATHS = new Set(__CODEX_PUBLIC_ASSETS__);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE.map(async (pathname) => {
      // Never include login cookies or cache an authenticated HTTP response.
      const cacheKey = new Request(new URL(pathname, self.location.origin), { credentials: "omit" });
      const target = new URL(cacheKey.url);
      // Unhashed entry files can be cached by a proxy even when the origin says no-cache.
      if (!pathname.startsWith("/assets/")) target.searchParams.set("codex-build", BUILD);
      const request = new Request(target, { credentials: "omit", cache: "reload" });
      const response = await fetch(request);
      if (!response.ok || response.type !== "basic") throw new Error("App shell unavailable");
      await cache.put(cacheKey, response);
    }));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Keep two previous builds for lazy imports in other open, running chats.
    const builds = (await caches.keys()).filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    await Promise.all(builds.slice(0, Math.max(0, builds.length - 2)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Strict public allowlist: APIs, uploads, HTML previews and project files bypass this worker.
  if (request.mode === "navigate") {
    if (url.pathname !== "/" && url.pathname !== "/index.html") return;
    event.respondWith((async () => {
      try {
        const target = new URL(request.url);
        target.searchParams.set("codex-build", BUILD);
        return await fetch(target, { credentials: request.credentials, headers: request.headers, cache: "no-store" });
      }
      catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match("/index.html")) || (await cache.match("/offline.html")) || Response.error();
      }
    })());
    return;
  }
  if (url.search || (!PUBLIC_PATHS.has(url.pathname) && !url.pathname.startsWith("/assets/"))) return;
  // Large editors, PDF workers and language grammars load on demand. Keep
  // strict build-manifest validation and never send credentials into this cache.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (!PUBLIC_PATHS.has(url.pathname)) return fetch(request);
    const cacheKey = new Request(url, { credentials: "omit" });
    const response = await fetch(cacheKey);
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME); await cache.put(cacheKey, response.clone());
    }
    return response;
  })());
});

function navigationData(value) {
  return {
    hostId: typeof value?.hostId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.hostId) ? value.hostId : "",
    threadId: typeof value?.threadId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.threadId) ? value.threadId : "",
  };
}

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Always show a visible, generic notification. */ }
  const data = navigationData(payload.data);
  const title = typeof payload.title === "string" ? payload.title.slice(0, 100) : "Codex Web";
  const body = typeof payload.body === "string" ? payload.body.slice(0, 240) : "工作区有新的进展，打开应用查看。";
  const tag = typeof payload.tag === "string" ? payload.tag.slice(0, 160) : undefined;
  event.waitUntil(self.registration.showNotification(title || "Codex Web", {
    body,
    icon: "/icons/icon-command-192.png",
    badge: "/icons/icon-command-192.png",
    tag,
    renotify: !!tag,
    data,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = navigationData(event.notification.data);
  // Construct the app URL ourselves; a push payload cannot open another origin or a preview.
  const target = new URL("/", self.location.origin);
  if (data.hostId) target.searchParams.set("host", data.hostId);
  if (data.threadId) target.searchParams.set("thread", data.threadId);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appClient = clients.find((client) => {
      const url = new URL(client.url);
      return client.frameType === "top-level" && url.origin === target.origin && (url.pathname === "/" || url.pathname === "/index.html");
    });
    if (appClient) {
      try { await appClient.focus(); } catch { /* Some platforms focus the app themselves. */ }
      appClient.postMessage({ type: "PUSH_NAVIGATE", ...data });
    } else await self.clients.openWindow(target.href);
  })());
});
