import { reactive } from 'vue';

export type PushPreferences = { completed: boolean; approval: boolean; errors: boolean };
export type PushDestination = { hostId: string; threadId: string };
type PushConfig = { enabled: boolean; publicKey: string; reason?: string };
type HttpApi = { requestHttp(path: string, init?: RequestInit, reportError?: boolean): Promise<any>; runtimeIdentity?(): { authenticationGeneration?: number } };
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
const preferenceKey = 'codex.devicePushPreferences';
const retiredEndpointKey = 'codex.retiredPushEndpoint';
const defaultPreferences: PushPreferences = { completed: true, approval: true, errors: true };
const inBrowser = typeof window !== 'undefined' && typeof navigator !== 'undefined';
function readPreferences(fallback: PushPreferences = defaultPreferences): PushPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
    if (value && Object.keys(defaultPreferences).every((key) => typeof value[key] === 'boolean')) return value;
  } catch { /* Storage can be unavailable in private browsing. */ }
  return { ...fallback };
}
function installed() {
  if (!inBrowser) return false;
  return (typeof window.matchMedia === 'function' && (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches)) || !!(navigator as Navigator & { standalone?: boolean }).standalone;
}
const appleMobile = inBrowser && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const pwaState = reactive({
  offline: inBrowser && navigator.onLine === false,
  installed: installed(),
  appleMobile,
  secureContext: inBrowser && window.isSecureContext === true,
  canInstall: false,
  installing: false,
  updateAvailable: false,
  registrationStatus: 'idle' as 'idle' | 'development' | 'registering' | 'ready' | 'unavailable' | 'error',
  error: '',
  pushSupported: inBrowser && window.isSecureContext === true && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  pushPermission: inBrowser && typeof Notification !== 'undefined' ? Notification.permission : 'unsupported' as NotificationPermission | 'unsupported',
  pushReady: false,
  pushSubscribed: false,
  pushPreferences: readPreferences(),
  pushConfig: null as PushConfig | null,
  configError: '',
  pushError: '',
  pushBusy: false,
});
let registration: ServiceWorkerRegistration | null = null;
let installPrompt: InstallPrompt | null = null;
let initialization: Promise<ServiceWorkerRegistration | null> | null = null;
let deviceInitialization: Promise<void> | null = null;
let deviceOperation: Promise<void> | null = null;
let wantsReload = false;
let listenersInstalled = false;
let preferenceWrite: Promise<void> | null = null;
let externalPreferencesPending = false;
let deviceAuthGeneration = 0;
let deviceSignedOut = false;
let signedOutAuthentication: number | undefined;
let retiredEndpoint = '';
try { retiredEndpoint = localStorage.getItem(retiredEndpointKey) || ''; } catch { /* Device storage may be unavailable. */ }

/** Browser APIs can hang without rejecting when Android suspends networking. */
function deadline<T>(promise: Promise<T>, milliseconds = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('通知操作超时，请检查网络后重试')), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, cause => { clearTimeout(timer); reject(cause); });
  });
}
function pushHttp(api: HttpApi, path: string, init: RequestInit = {}, reportError = false) {
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  return deadline(api.requestHttp(path, { ...init, signal }, reportError)).finally(() => controller.abort());
}

function installListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  window.addEventListener('online', () => { pwaState.offline = false; });
  window.addEventListener('offline', () => { pwaState.offline = true; });
  window.addEventListener('storage', (event) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    // A successful local save commits its own choice; a failed save can adopt the other tab's.
    if (preferenceWrite) externalPreferencesPending = true;
    else pwaState.pushPreferences = readPreferences(pwaState.pushPreferences);
  });
  window.addEventListener('focus', () => {
    if ('Notification' in window) pwaState.pushPermission = Notification.permission;
    if (registration && navigator.onLine) void registration.update().catch(() => {});
  });
  const displayMode = matchMedia('(display-mode: standalone)');
  displayMode.addEventListener('change', () => { pwaState.installed = installed(); });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    pwaState.canInstall = true;
  });
  window.addEventListener('appinstalled', () => {
    pwaState.installed = true;
    pwaState.canInstall = false;
    installPrompt = null;
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // An update in another tab must not interrupt this tab's current chat.
      if (wantsReload) { wantsReload = false; location.reload(); }
    });
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'PUSH_NAVIGATE') return;
      const { hostId, threadId } = event.data;
      if (typeof hostId !== 'string' || typeof threadId !== 'string' || (hostId && !/^[a-zA-Z0-9_-]{1,128}$/.test(hostId)) || (threadId && !/^[a-zA-Z0-9_-]{1,128}$/.test(threadId))) return;
      window.dispatchEvent(new CustomEvent('codex:push-navigate', { detail: { hostId, threadId } }));
    });
  }
}

export function initPwa(): Promise<ServiceWorkerRegistration | null> {
  if (!inBrowser) return Promise.resolve(null);
  installListeners();
  if (initialization && pwaState.registrationStatus !== 'error') return initialization;
  initialization = (async () => {
    if (!import.meta.env.PROD) { pwaState.registrationStatus = 'development'; return null; }
    if (!window.isSecureContext || !('serviceWorker' in navigator)) { pwaState.registrationStatus = 'unavailable'; return null; }
    pwaState.registrationStatus = 'registering';
    try {
      const result = await deadline(navigator.serviceWorker.register(`/sw.js?build=${import.meta.env.VITE_BUILD_ID}`, { scope: '/', updateViaCache: 'none' }));
      if (result.waiting) pwaState.updateAvailable = true;
      result.addEventListener('updatefound', () => {
        const worker = result.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && (navigator.serviceWorker.controller || result.active)) pwaState.updateAvailable = true;
        });
      });
      // Push subscriptions require an active worker, rather than a still-installing one.
      registration = await new Promise<ServiceWorkerRegistration>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('应用资源准备超时，请连接网络后刷新重试。')), 15_000);
        navigator.serviceWorker.ready.then((worker) => { clearTimeout(timeout); resolve(worker); }, (cause) => { clearTimeout(timeout); reject(cause); });
      });
      pwaState.registrationStatus = 'ready';
      return registration;
    } catch (cause: any) {
      pwaState.registrationStatus = 'error';
      pwaState.error = cause.message || '应用离线资源准备失败，请刷新重试。';
      return null;
    }
  })();
  return initialization;
}

export async function installPwa() {
  if (!installPrompt || pwaState.installing) return;
  const prompt = installPrompt;
  pwaState.installing = true;
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === 'accepted') pwaState.installed = true;
  } finally {
    installPrompt = null;
    pwaState.canInstall = false;
    pwaState.installing = false;
  }
}

export function updatePwa() {
  if (!registration?.waiting) return;
  wantsReload = true;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
}

export function onPushNavigate(callback: (destination: PushDestination) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<PushDestination>).detail);
  window.addEventListener('codex:push-navigate', listener);
  return () => window.removeEventListener('codex:push-navigate', listener);
}

function rememberPreferences(preferences: PushPreferences) {
  pwaState.pushPreferences = { ...preferences };
  try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* The current session still retains the preferences. */ }
}
function beginDeviceOperation() {
  let finish: () => void = () => {};
  const operation = new Promise<void>((resolve) => { finish = resolve; });
  deviceOperation = operation;
  return () => {
    if (deviceOperation === operation) deviceOperation = null;
    finish();
  };
}
function postSubscription(api: HttpApi, subscription: PushSubscription, generation = deviceAuthGeneration) {
  if (generation !== deviceAuthGeneration) throw new Error('通知操作所属登录已退出');
  // Refresh right before serializing, so a dormant tab cannot restore old device preferences.
  pwaState.pushPreferences = readPreferences(pwaState.pushPreferences);
  return pushHttp(api, '/push/subscription', {
    method: 'POST',
    body: JSON.stringify({ subscription: subscription.toJSON(), preferences: pwaState.pushPreferences }),
  }, false);
}
function matchesServerKey(subscription: PushSubscription, publicKey: string) {
  const existing = subscription.options?.applicationServerKey;
  if (!existing) return false;
  const actual = new Uint8Array(existing);
  const expected = applicationServerKey(publicKey);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}
function endpointRetired(subscription: PushSubscription) {
  try { retiredEndpoint = localStorage.getItem(retiredEndpointKey) || retiredEndpoint; } catch { /* Use this tab's known invalid endpoint. */ }
  return subscription.endpoint === retiredEndpoint;
}
async function retireSubscription(subscription: PushSubscription, message: string) {
  // Keep an invalid endpoint retired even if browser-side cleanup fails or another tab reloads.
  retiredEndpoint = subscription.endpoint;
  try { localStorage.setItem(retiredEndpointKey, retiredEndpoint); } catch { /* The current tab retains the tombstone. */ }
  pwaState.pushSubscribed = false;
  pwaState.pushError = message;
  try { await deadline(subscription.unsubscribe()); }
  catch { throw new Error('本机通知订阅清理失败，请刷新重试后重新启用通知。'); }
}
export function initializeDevicePush(api: HttpApi): Promise<void> {
  if (deviceSignedOut && signedOutAuthentication !== undefined && api.runtimeIdentity?.().authenticationGeneration === signedOutAuthentication) return Promise.resolve();
  // A new authenticated initialization invalidates cleanup from the prior login.
  if (deviceSignedOut) { deviceSignedOut = false; ++deviceAuthGeneration; }
  if (deviceInitialization) return deviceInitialization;
  const generation = deviceAuthGeneration;
  const current = () => generation === deviceAuthGeneration;
  const initialization = (async () => {
    if (!navigator.onLine) return;
    pwaState.configError = '';
    pwaState.pushReady = false;
    try {
      // Restore only after a current test, unsubscribe or preference save has completed.
      if (deviceOperation) await deadline(deviceOperation);
      if (!current()) return;
      const [config, worker] = await Promise.all([pushHttp(api, '/push/config', undefined, false), initPwa()]);
      if (!current()) return;
      pwaState.pushConfig = config;
      pwaState.pushPermission = 'Notification' in window ? Notification.permission : 'unsupported';
      if (!worker || !pwaState.pushSupported) return;
      const subscription = await deadline(worker.pushManager.getSubscription());
      if (!current()) return;
      pwaState.pushSubscribed = !!subscription;
      // Restore only an existing, authorized device. Never subscribe or prompt on page load.
      if (subscription && config.enabled && config.publicKey) {
        if (endpointRetired(subscription) || !matchesServerKey(subscription, config.publicKey)) {
          await retireSubscription(subscription, '设备通知订阅已失效或服务器密钥已更新，请重新启用通知。');
        } else if (Notification.permission === 'granted') {
          await postSubscription(api, subscription, generation);
        }
      }
      // UI actions become available only after restoration reaches the server.
      if (current()) pwaState.pushReady = !!config.enabled && !!config.publicKey;
    } catch (cause: any) { if (current()) pwaState.configError = cause.message || '无法读取通知配置'; }
  })().finally(() => { if (deviceInitialization === initialization) deviceInitialization = null; });
  deviceInitialization = initialization;
  return deviceInitialization;
}

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const value = publicKey.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(value.padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export async function enableDevicePush(api: HttpApi) {
  if (pwaState.pushBusy) throw new Error('请等待当前通知操作完成');
  if (deviceInitialization) throw new Error('通知状态正在同步，请稍后重试');
  if (!registration || !pwaState.pushReady || !pwaState.pushConfig?.publicKey) throw new Error('通知尚未准备好，请检查配置后重试');
  if (!navigator.onLine) throw new Error('连接网络后再启用通知');
  pwaState.pushBusy = true;
  pwaState.pushError = '';
  const finishDeviceOperation = beginDeviceOperation();
  let created: PushSubscription | null = null;
  const generation = deviceAuthGeneration;
  const current = () => generation === deviceAuthGeneration;
  try {
    // Keep permission requesting in the original click gesture, before the first await.
    const permissionPromise = Notification.permission === 'granted' ? Promise.resolve('granted' as NotificationPermission) : Notification.requestPermission();
    const permission = await permissionPromise;
    if (!current()) return;
    pwaState.pushPermission = permission;
    if (permission !== 'granted') throw new Error(permission === 'denied' ? '通知已被拒绝，请在系统或浏览器设置中允许后重试。' : '尚未允许通知，你可以稍后再次启用。');
    let subscription = await deadline(registration.pushManager.getSubscription());
    if (!current()) return;
    if (subscription && (endpointRetired(subscription) || !matchesServerKey(subscription, pwaState.pushConfig.publicKey))) {
      const message = '设备通知订阅已失效或服务器密钥已更新，旧订阅已清理，请重新启用通知。';
      await retireSubscription(subscription, message);
      throw new Error(message);
    }
    if (!subscription) {
      subscription = await deadline(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(pwaState.pushConfig.publicKey) }));
      created = subscription;
    }
    if (!current()) { if (created) void created.unsubscribe().catch(() => {}); return; }
    await postSubscription(api, subscription, generation);
    if (!current()) return;
    if (created && created.endpoint === retiredEndpoint) {
      retiredEndpoint = '';
      try { localStorage.removeItem(retiredEndpointKey); } catch { /* A fresh, registered subscription is valid in this tab. */ }
    }
    pwaState.pushSubscribed = true;
    rememberPreferences(pwaState.pushPreferences);
  } catch (cause: any) {
    if (created) await deadline(created.unsubscribe()).catch(() => {});
    if (!current()) return;
    pwaState.pushError = cause.message || '无法启用通知';
    throw cause;
  } finally { if (current()) pwaState.pushBusy = false; finishDeviceOperation(); }
}

export async function revokeDevicePush(api: HttpApi, options: { logout?: boolean } = {}) {
  if (options.logout) {
    // The authenticated logout endpoint revokes server grants. Browser cleanup
    // must neither block it nor allow a pending operation to restore the device.
    const generation = ++deviceAuthGeneration;
    deviceSignedOut = true;
    signedOutAuthentication = api.runtimeIdentity?.().authenticationGeneration;
    deviceInitialization = null;
    deviceOperation = null;
    preferenceWrite = null;
    externalPreferencesPending = false;
    pwaState.pushBusy = false;
    pwaState.pushReady = false;
    pwaState.pushSubscribed = false;
    pwaState.pushConfig = null;
    pwaState.pushError = '';
    pwaState.configError = '';
    try {
      const worker = registration || await initPwa();
      if (generation !== deviceAuthGeneration) return;
      const subscription = await deadline(worker ? worker.pushManager.getSubscription() : Promise.resolve(null));
      if (!subscription || generation !== deviceAuthGeneration) return;
      retiredEndpoint = subscription.endpoint;
      try { localStorage.setItem(retiredEndpointKey, retiredEndpoint); } catch { /* Server-side revocation remains authoritative. */ }
      // Retaining the tombstone also prevents a failed unsubscribe from silently
      // reauthorizing this endpoint on the next page load.
      if (!await deadline(subscription.unsubscribe()) && generation === deviceAuthGeneration)
        pwaState.pushError = '已退出登录；浏览器通知订阅清理未完成。';
    } catch {
      if (generation === deviceAuthGeneration) pwaState.pushError = '已退出登录；浏览器通知订阅清理未完成。';
    }
    return;
  }
  const generation = deviceAuthGeneration;
  const current = () => generation === deviceAuthGeneration;
  if (deviceInitialization) await deviceInitialization;
  if (!current()) return;
  if (pwaState.pushBusy) throw new Error('请等待当前通知操作完成后再退出');
  pwaState.pushBusy = true;
  pwaState.pushError = '';
  const finishDeviceOperation = beginDeviceOperation();
  try {
    const worker = registration || await initPwa();
    const subscription = await deadline(worker ? worker.pushManager.getSubscription() : Promise.resolve(null));
    if (!current()) return;
    if (subscription) {
      // First revoke the authenticated server registration. A failure keeps the UI enabled.
      await pushHttp(api, '/push/subscription', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) }, false);
      if (!current()) return;
      if (!await deadline(subscription.unsubscribe())) throw new Error('服务器已关闭通知，但本机订阅清理失败，请重试。');
    }
    if (current()) pwaState.pushSubscribed = false;
  } catch (cause: any) {
    if (!current()) return;
    pwaState.pushError = cause.message || '无法关闭本机通知';
    throw cause;
  } finally { if (current()) pwaState.pushBusy = false; finishDeviceOperation(); }
}
export const disableDevicePush = revokeDevicePush;

export async function saveDevicePushPreferences(api: HttpApi, preferences: PushPreferences = pwaState.pushPreferences) {
  const generation = deviceAuthGeneration;
  const current = () => generation === deviceAuthGeneration;
  if (deviceInitialization) await deviceInitialization;
  if (!current()) return;
  if (pwaState.pushBusy) throw new Error('请等待当前通知操作完成');
  pwaState.pushBusy = true;
  pwaState.pushError = '';
  const finishDeviceOperation = beginDeviceOperation();
  let finishPreferenceWrite: () => void = () => {};
  preferenceWrite = new Promise<void>((resolve) => { finishPreferenceWrite = resolve; });
  try {
    const subscription = await deadline(registration ? registration.pushManager.getSubscription() : Promise.resolve(null));
    if (!current()) return;
    if (subscription) await pushHttp(api, '/push/subscription', { method: 'PATCH', body: JSON.stringify({ endpoint: subscription.endpoint, preferences }) }, false);
    if (current()) rememberPreferences(preferences);
  } catch (cause: any) {
    if (!current()) return;
    pwaState.pushError = cause.message || '无法保存通知偏好';
    throw cause;
  } finally {
    if (current()) { preferenceWrite = null; pwaState.pushBusy = false; }
    if (current() && externalPreferencesPending) {
      externalPreferencesPending = false;
      pwaState.pushPreferences = readPreferences(pwaState.pushPreferences);
    }
    finishPreferenceWrite();
    finishDeviceOperation();
  }
}

export async function testDevicePush(api: HttpApi) {
  const generation = deviceAuthGeneration;
  const current = () => generation === deviceAuthGeneration;
  if (deviceInitialization) await deviceInitialization;
  if (!current()) return;
  if (pwaState.pushBusy) throw new Error('请等待当前通知操作完成');
  pwaState.pushBusy = true;
  pwaState.pushError = '';
  const finishDeviceOperation = beginDeviceOperation();
  let subscription: PushSubscription | null | undefined;
  try {
    subscription = await deadline(registration ? registration.pushManager.getSubscription() : Promise.resolve(null));
    if (!current()) return;
    if (!subscription) throw new Error('先在这台设备启用通知');
    return await pushHttp(api, '/push/test', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }), signal: AbortSignal.timeout(20000) }, false);
  } catch (cause: any) {
    if (!current()) return;
    if (cause.status === 410 && subscription) {
      const message = '这台设备的通知订阅已失效，请重新启用通知。';
      await retireSubscription(subscription, message);
      throw Object.assign(new Error(message), { status: 410 });
    }
    pwaState.pushError = cause.message || '无法发送测试通知';
    throw cause;
  } finally { if (current()) pwaState.pushBusy = false; finishDeviceOperation(); }
}

export async function testSystemNotification() {
  const generation = deviceAuthGeneration;
  const current = () => generation === deviceAuthGeneration;
  if (deviceInitialization) await deviceInitialization;
  if (!current()) return;
  if (pwaState.pushBusy) throw new Error('请等待当前通知操作完成');
  pwaState.pushBusy = true;
  pwaState.pushError = '';
  const finishDeviceOperation = beginDeviceOperation();
  try {
    if (Notification.permission !== 'granted') throw new Error('请先允许这台设备发送通知');
    const worker = await initPwa();
    if (!current()) return;
    if (!worker) throw new Error('通知服务尚未就绪，请刷新后重试');
    await worker.showNotification('Codex 系统通知检查', {
      body: '收到这条通知表示应用的系统通知可以正常显示。',
      icon: '/icons/icon-command-192.png',
      badge: '/icons/icon-command-192.png',
      tag: `codex-system-test-${Date.now()}`,
      data: {},
    });
  } catch (cause: any) {
    if (!current()) return;
    pwaState.pushError = cause.message || '无法显示系统通知';
    throw cause;
  } finally { if (current()) pwaState.pushBusy = false; finishDeviceOperation(); }
}
