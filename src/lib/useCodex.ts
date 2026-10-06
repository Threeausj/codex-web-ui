import { reactive, toRaw } from "vue";
import { randomUUID } from "./uuid";
import { editableMessage, editedMessageInput } from "./message-edit";
import { revokeDevicePush } from "./pwa";
import {
  availablePermissionProfiles,
  resolvePermissionProfile,
} from "./configuration";
import {
  exportThreadMarkdown,
  historyActivityAt,
  threadActivityAt,
  turnActivityAt,
  togglePin,
  type Pin,
} from "./navigation";
import type { ClientRequest } from "../../shared/protocol/ClientRequest";
import {
  applyItemEvent,
  contextPercent,
  mergeSnapshotItems,
  upsertItem,
  type DisplayItem,
} from "./events";

type Method = ClientRequest["method"];
type Params<M extends Method> = Extract<ClientRequest, { method: M }>["params"];
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  silentError?: boolean;
};
type HostNavigation = {
  threads: any[];
  cursor: string | null;
  loadedMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string;
  projectPages: Record<string, { cursor: string | null; loaded: boolean }>;
};
const saved = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const state = reactive({
  authenticated: false,
  online: navigator.onLine !== false,
  authRequired: true,
  loading: true,
  error: "",
  connected: false,
  connectionMode: "spawn",
  hosts: [] as any[],
  navigation: {} as Record<string, HostNavigation>,
  hostId: "local",
  projects: [] as any[],
  preferences: {
    pins: [] as Pin[],
    collapsed: {} as Record<string, boolean>,
    permissionProfiles: [] as any[],
    activePermissionProfileId: "",
    defaultPermission: "workspace-write",
  },
  activePermissionProfileId: "",
  requirements: null as any,
  nativePermissionProfiles: [] as any[],
  projectPath: "",
  projectThreadPages: {} as Record<
    string,
    { cursor: string | null; loaded: boolean }
  >,
  threads: [] as any[],
  activeThread: null as any,
  selectingThread: false,
  switchingHost: false,
  runtimePolicy: null as { sandboxPolicy: any; approvalPolicy: any } | null,
  items: [] as DisplayItem[],
  turns: [] as any[],
  moreTurns: false,
  moreThreads: false,
  models: [] as any[],
  model: "",
  effort: "medium",
  permission: "workspace-write",
  tokenUsage: null as any,
  busy: false,
  pendingRequests: [] as any[],
  attachments: [] as any[],
  config: null as any,
  skills: [] as any[],
  apps: [] as any[],
  mcpServers: [] as any[],
  account: null as any,
  rateLimits: null as any,
  searchResults: [] as any[],
  toast: "",
  terminalOutput: "",
  terminalRunning: false,
  terminalProcessId: "",
  terminalSessionName: "",
  autoCompact: saved("codex.autoCompact", true),
  terminalProcesses: [] as any[],
  integrationErrors: [] as { source: string; message: string }[],
  changingContext: false,
  editingMessage: false,
  compactThreshold: saved("codex.compactThreshold", 85),
  diff: "",
  plan: [] as any[],
});
let socket: WebSocket | null = null;
let csrfToken = "";
let authenticationGeneration = 0;
type SessionStatus = { authenticated: boolean; authRequired?: boolean; csrfToken?: string };
let sessionValidation: { generation: number; promise: Promise<SessionStatus | null> } | null = null;
let counter = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let threadCursor: string | null = null;
let turnCursor: string | null = null;
let selectionGeneration = 0;
let hostSelectionGeneration = 0;
let connecting: Promise<void> | null = null;
let connectionRecovery: { generation: number; promise: Promise<void> } | null = null;
let listGeneration = 0;
let configGeneration = 0;
let integrationGeneration = 0;
let threadListScope = "";
let loadedMorePages = false;
let loadedGlobalPages = false;
let threadEventSequence = 0;
let itemEventSequence = 0;
let sendInFlight = false;
let localCwd = "/tmp";
let clientId = sessionStorage.getItem("codex.clientId") ?? randomUUID();
sessionStorage.setItem("codex.clientId", clientId);
const pending = new Map<string | number, Pending>();
const attachmentOriginals = new WeakMap<object, File>();
const terminalSessionNames = new Map<string, string>();
let terminalSelectionGeneration = 0;
const itemCache = new Map<string, DisplayItem[]>();
const activeTurns = new Map<string, string>();
const turnRevisions = new Map<string, number>();
const threadBusy = new Map<string, boolean>();
const itemRevisions = new Map<string, Map<string, number>>();
const threadRevisions = new Map<string, number>();
const removedThreads = new Set<string>();
const compactedSinceInput = new Set<string>();
const permissionSelections = new Map<string, { mode: string; profileId: string }>();
const localReverts = new Set<string>();
const discardedTurns = new Set<string>();
let pendingMessageEdit: { hostId: string; threadId: string; item: DisplayItem; reverted: boolean; blocked: boolean; needsHistory?: boolean; prefixLastTurnId?: string | null } | null = null;
const terminalListeners = new Set<(chunk: string) => void>();
const terminalDecoders = new Map<string, TextDecoder>();
const completedTerminalProcesses = new Set<string>();
const recencySortSupport = new Map<string, boolean>();
const legacyRecency = new Map<
  string,
  { stamp: number | undefined; value: number; pending?: Promise<number> }
>();
const recencyKey = (hostId: string, threadId: string) =>
  JSON.stringify([hostId, threadId]);
function appendTerminal(chunk: string) {
  state.terminalOutput = (state.terminalOutput + chunk).slice(-500000);
  for (const listener of terminalListeners) listener(chunk);
}
function subscribeTerminal(listener: (chunk: string) => void) {
  terminalListeners.add(listener);
  return () => terminalListeners.delete(listener);
}
function terminalIds(): Record<string, string> {
  try {
    const value = JSON.parse(
      sessionStorage.getItem("codex.terminalProcessIds") || "{}",
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
function rememberTerminal(processId: string) {
  ++terminalSelectionGeneration;
  state.terminalProcessId = processId;
  const ids = terminalIds();
  ids[state.hostId] = processId;
  sessionStorage.setItem("codex.terminalProcessIds", JSON.stringify(ids));
}
function restoreTerminalOutput(output: string) {
  state.terminalOutput = output;
  for (const listener of terminalListeners) listener(`\x1bc${output}`);
}
function attachTerminal(processId: string) {
  const process = state.terminalProcesses.find(
    (process) => process.processId === processId,
  );
  if (!process) throw fail(new Error("该终端已经结束"));
  rememberTerminal(processId);
  state.terminalSessionName =
    terminalSessionNames.get(`${state.hostId}:${processId}`) || "";
  state.terminalRunning = true;
  terminalDecoders.clear();
  restoreTerminalOutput(process.lastOutput || "");
}

function toast(message: string) {
  state.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (state.toast = ""), 4500);
}
function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  state.error = message;
  return error instanceof Error ? error : new Error(message);
}
function releaseAttachments(files = state.attachments) {
  for (const file of files)
    if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
}
function clearAttachments() {
  releaseAttachments();
  state.attachments = [];
}
async function http(
  path: string,
  options: RequestInit = {},
  reportError = true,
) {
  if (!state.online) {
    const error = new Error("目前离线，请联网后重试。操作不会在后台自动提交。");
    throw reportError ? fail(error) : error;
  }
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && options.body)
    headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("x-csrf-token", csrfToken);
  const generation = authenticationGeneration;
  const requestToken = csrfToken;
  const method = (options.method || "GET").toUpperCase();
  // Some proxies cache private GETs despite the origin's no-store header.
  // A per-request nonce prevents stale session/CSRF and private API responses.
  const url = `/api${path}${method === "GET" || method === "HEAD"
    ? `${path.includes("?") ? "&" : "?"}_request=${randomUUID()}` : ""}`;
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.authenticated &&
      generation === authenticationGeneration && requestToken === csrfToken &&
      path !== "/auth/session" && path !== "/auth/login") {
      // A delayed push request or a connection from an old session cannot
      // decide whether the browser's current cookie is still authenticated.
      try { await validateSession(); } catch { /* A network failure is not a logout. */ }
    }
    const error = Object.assign(new Error(
      result.error?.message ?? result.error ?? `请求失败 (${response.status})`,
    ), { status: response.status });
    throw reportError && generation === authenticationGeneration ? fail(error) : error;
  }
  return result;
}
function validateSession(): Promise<SessionStatus | null> {
  const generation = authenticationGeneration;
  if (sessionValidation?.generation === generation) return sessionValidation.promise;
  const apply = (session: SessionStatus) => {
    if (generation !== authenticationGeneration) return null;
    if (typeof session.authenticated !== "boolean")
      throw new Error("登录状态查询返回无效结果，请联网后重试");
    state.authRequired = session.authRequired ?? state.authRequired;
    if (session.authenticated) {
      if (csrfToken && session.csrfToken && csrfToken !== session.csrfToken)
        authenticationGeneration++;
      csrfToken = session.csrfToken ?? csrfToken;
      state.authenticated = true;
    } else {
      const wasAuthenticated = state.authenticated;
      authenticationGeneration++;
      csrfToken = "";
      state.authenticated = false;
      closeConnection();
      if (wasAuthenticated) state.error = "登录已过期，请重新登录";
    }
    return session;
  };
  const checking = (async () => {
    try {
      return apply(await http("/auth/session", { signal: AbortSignal.timeout(10000) }, false));
    } catch (error: any) {
      if (error.status === 401) return apply({ authenticated: false });
      throw error;
    }
  })();
  const promise = checking.finally(() => {
    if (sessionValidation?.promise === promise) sessionValidation = null;
  });
  sessionValidation = { generation, promise };
  return promise;
}
const navigationRequests = new Map<string, Promise<void>>();
const navigationRevisions = new Map<string, number>();
function hostNavigation(hostId: string): HostNavigation {
  return (state.navigation[hostId] ??= {
    threads: [],
    cursor: null,
    loadedMore: false,
    loading: false,
    loaded: false,
    error: "",
    projectPages: {},
  });
}
function navigationThreads(): any[] {
  return state.hosts.flatMap((host) =>
    (host.id === state.hostId
      ? state.threads
      : (state.navigation[host.id]?.threads ?? [])
    ).map((thread) => ({ ...thread, hostId: host.id })),
  );
}
function navigationMore() {
  return (
    state.moreThreads ||
    state.hosts.some(
      (host) => host.id !== state.hostId && !!state.navigation[host.id]?.cursor,
    )
  );
}
async function navigationRpc(hostId: string, method: string, params: any) {
  return http(
    `/navigation/${encodeURIComponent(hostId)}`,
    {
      method: "POST",
      body: JSON.stringify({ method, params }),
    },
    false,
  );
}
async function scopedRpc(hostId: string, method: Method, params: any) {
  return hostId === state.hostId
    ? rpc(method, params, 45000, { silentError: true })
    : navigationRpc(hostId, method, params);
}
async function normalizeThreadRecency(hostId: string, thread: any) {
  if (typeof thread.recencyAt === "number" && Number.isFinite(thread.recencyAt))
    return thread;
  const key = recencyKey(hostId, thread.id);
  const previous = legacyRecency.get(key);
  if (previous && previous.stamp === thread.updatedAt)
    return { ...thread, recencyAt: await (previous.pending ?? previous.value) };
  const known = (
    hostId === state.hostId
      ? state.threads
      : (state.navigation[hostId]?.threads ?? [])
  ).find((item) => item.id === thread.id);
  const entry = {
    stamp: thread.updatedAt,
    value: previous?.value ?? known?.recencyAt ?? threadActivityAt(thread),
    pending: undefined as Promise<number> | undefined,
  };
  entry.pending = (async () => {
    try {
      const page = await scopedRpc(hostId, "thread/turns/list", {
        threadId: thread.id,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      entry.value = historyActivityAt(thread, page.data ?? [], entry.value);
    } catch {
      // A failed history read must not turn a resume/configuration timestamp
      // into activity. Preserve the known content time or creation time.
    }
    entry.pending = undefined;
    return entry.value;
  })();
  legacyRecency.set(key, entry);
  if (legacyRecency.size > 2000)
    legacyRecency.delete(legacyRecency.keys().next().value!);
  return { ...thread, recencyAt: await entry.pending };
}
async function normalizeThreadPage(hostId: string, result: any) {
  const data = [...(result.data ?? [])];
  let next = 0;
  // Missing recency is a compatibility path, bounded to four lightweight
  // metadata reads rather than fetching every chat's messages at once.
  await Promise.all(
    Array.from({ length: Math.min(4, data.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= data.length) return;
        data[index] = await normalizeThreadRecency(hostId, data[index]);
      }
    }),
  );
  return { ...result, data };
}
async function threadPage(
  hostId: string,
  method: "thread/list" | "thread/search",
  params: any,
) {
  const supportKey = `${hostId}:${method}`;
  const supported = recencySortSupport.get(supportKey) !== false;
  let result;
  try {
    result = await scopedRpc(hostId, method, {
      ...params,
      sortKey: supported ? "recency_at" : "updated_at",
    });
    if (supported) recencySortSupport.set(supportKey, true);
  } catch (error: any) {
    if (
      !supported ||
      !/recency_?at/i.test(error.message) ||
      !/unknown|invalid|unsupported|variant|expected|sort/i.test(error.message)
    )
      throw error;
    recencySortSupport.set(supportKey, false);
    result = await scopedRpc(hostId, method, {
      ...params,
      sortKey: "updated_at",
    });
  }
  return normalizeThreadPage(hostId, result);
}
function mergeNavigation(hostId: string, threads: any[], replace = false) {
  const nav = hostNavigation(hostId);
  const records = new Map(
    (replace ? [] : nav.threads).map((thread) => [thread.id, thread]),
  );
  for (const thread of threads)
    records.set(thread.id, { ...records.get(thread.id), ...thread });
  nav.threads = [...records.values()];
}
function refreshHostNavigation(hostId: string): Promise<void> {
  const existing = navigationRequests.get(hostId);
  if (existing) return existing;
  const nav = hostNavigation(hostId);
  nav.loading = true;
  const revision = navigationRevisions.get(hostId) ?? 0;
  const task = (async () => {
    try {
      const result = await threadPage(hostId, "thread/list", {
        limit: 60,
        modelProviders: [],
      });
      if (
        !state.authenticated ||
        !state.hosts.some((host) => host.id === hostId) ||
        revision !== (navigationRevisions.get(hostId) ?? 0)
      )
        return;
      mergeNavigation(hostId, result.data, !nav.loadedMore);
      if (!nav.loaded || !nav.loadedMore) nav.cursor = result.nextCursor;
      nav.error = "";
      nav.loaded = true;
      const missing = state.preferences.pins.filter(
        (pin) =>
          pin.hostId === hostId &&
          pin.kind === "thread" &&
          !nav.threads.some((thread) => thread.id === pin.id),
      );
      await Promise.allSettled(
        missing.map(async (pin) => {
          const result = await navigationRpc(hostId, "thread/read", {
            threadId: pin.id,
            includeTurns: false,
          });
          const thread = await normalizeThreadRecency(hostId, result.thread);
          if (
            revision === (navigationRevisions.get(hostId) ?? 0) &&
            state.authenticated
          )
            mergeNavigation(hostId, [thread]);
        }),
      );
    } catch (error: any) {
      if (revision === (navigationRevisions.get(hostId) ?? 0))
        nav.error = error.message;
    } finally {
      nav.loading = false;
    }
  })();
  navigationRequests.set(hostId, task);
  void task.finally(() => {
    if (navigationRequests.get(hostId) === task)
      navigationRequests.delete(hostId);
  });
  return task;
}
async function refreshNavigation(force = false) {
  if (force) {
    loadedMorePages = false;
    loadedGlobalPages = false;
    state.projectThreadPages = {};
    state.threads = [];
    for (const host of state.hosts) {
      navigationRevisions.set(
        host.id,
        (navigationRevisions.get(host.id) ?? 0) + 1,
      );
      navigationRequests.delete(host.id);
      delete state.navigation[host.id];
    }
  }
  await Promise.allSettled([
    state.connected ? refreshThreads() : Promise.resolve(),
    ...state.hosts
      .filter((host) => host.id !== state.hostId)
      .map((host) => refreshHostNavigation(host.id)),
  ]);
}
async function retryNavigationHost(hostId: string) {
  if (hostId !== state.hostId) return refreshHostNavigation(hostId);
  try {
    if (!state.connected) await setHost(hostId);
    else await refreshThreads();
  } catch (error: any) {
    hostNavigation(hostId).error = error.message;
    toast(
      `${state.hosts.find((host) => host.id === hostId)?.name || "主机"} 暂时无法连接`,
    );
  }
}
async function loadMoreNavigation() {
  await Promise.allSettled([
    loadMoreThreads(),
    ...state.hosts
      .filter(
        (host) => host.id !== state.hostId && state.navigation[host.id]?.cursor,
      )
      .map(async (host) => {
        const nav = hostNavigation(host.id);
        const cursor = nav.cursor;
        const revision = navigationRevisions.get(host.id) ?? 0;
        try {
          const result = await threadPage(host.id, "thread/list", {
            cursor,
            limit: 60,
            modelProviders: [],
          });
          if (
            revision !== (navigationRevisions.get(host.id) ?? 0) ||
            !state.hosts.some((item) => item.id === host.id)
          )
            return;
          mergeNavigation(host.id, result.data);
          nav.cursor = result.nextCursor;
          nav.loadedMore = true;
          nav.error = "";
        } catch (error: any) {
          nav.error = error.message;
        }
      }),
  ]);
}
async function loadNavigationProject(
  hostId: string,
  projectPath: string,
  more = false,
) {
  if (hostId === state.hostId) return loadProjectThreads(projectPath, more);
  const nav = hostNavigation(hostId);
  const current = nav.projectPages[projectPath];
  if ((!more && current?.loaded) || (more && !current?.cursor)) return;
  const revision = navigationRevisions.get(hostId) ?? 0;
  const result = await threadPage(hostId, "thread/list", {
    limit: 60,
    cursor: more ? current?.cursor : undefined,
    cwd: projectRoots(projectPath, hostId),
    modelProviders: [],
  });
  if (
    revision !== (navigationRevisions.get(hostId) ?? 0) ||
    !state.hosts.some((host) => host.id === hostId)
  )
    return;
  mergeNavigation(hostId, result.data);
  nav.loadedMore = true;
  nav.projectPages[projectPath] = { loaded: true, cursor: result.nextCursor };
}
function navigationProjectPage(hostId: string, projectPath: string) {
  return hostId === state.hostId
    ? state.projectThreadPages[projectPath]
    : state.navigation[hostId]?.projectPages[projectPath];
}
function closeConnection() {
  localReverts.clear();
  clearTimeout(reconnectTimer);
  clearInterval(refreshTimer);
  const old = socket;
  socket = null;
  old?.close();
  connecting = null;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(
      Object.assign(new Error("连接已断开，服务端可能已接收"), {
        uncertain: true,
      }),
    );
  }
  pending.clear();
  state.connected = false;
}
function rpc<M extends Method>(
  method: M,
  params: Params<M>,
  timeoutMs = 45000,
  options: { silentError?: boolean } = {},
): Promise<any> {
  const report = (error: unknown) =>
    options.silentError
      ? error instanceof Error
        ? error
        : new Error(String(error))
      : fail(error);
  if (!socket || socket.readyState !== WebSocket.OPEN || !state.connected)
    return Promise.reject(report(new Error("app-server 尚未连接")));
  const id = ++counter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        report(
          Object.assign(
            new Error(`${method} 请求超时，服务端可能已接收；请同步对话后确认`),
            { uncertain: true },
          ),
        ),
      );
    }, timeoutMs);
    pending.set(id, {
      resolve,
      reject,
      timer,
      silentError: options.silentError,
    });
    try {
      socket!.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(report(error));
    }
  });
}
function scope() {
  return `${state.hostId}\0${state.projectPath}`;
}
function noteRuntime(threadId: string, busy: boolean, turnId?: string) {
  turnRevisions.set(threadId, (turnRevisions.get(threadId) ?? 0) + 1);
  threadBusy.set(threadId, busy);
  if (turnId) activeTurns.set(threadId, turnId);
  else if (!busy) activeTurns.delete(threadId);
  if (state.activeThread?.id === threadId) state.busy = busy;
}
function noteItem(threadId: string, itemId: string) {
  let revisions = itemRevisions.get(threadId);
  if (!revisions) {
    revisions = new Map();
    itemRevisions.set(threadId, revisions);
  }
  revisions.set(itemId, ++itemEventSequence);
}
function currentItems(threadId: string): DisplayItem[] {
  if (state.activeThread?.id === threadId) return state.items;
  let items = itemCache.get(threadId);
  if (!items) {
    items = [];
    itemCache.set(threadId, items);
  }
  return items;
}
function updateThread(thread: any) {
  if (!thread?.id) return;
  const previous = state.threads.find((item) => item.id === thread.id);
  thread = {
    ...thread,
    recencyAt:
      typeof thread.recencyAt === "number" && Number.isFinite(thread.recencyAt)
        ? Math.max(
            threadActivityAt(thread),
            previous ? threadActivityAt(previous) : 0,
          )
        : (previous?.recencyAt ?? threadActivityAt(thread)),
  };
  threadRevisions.set(thread.id, ++threadEventSequence);
  removedThreads.delete(thread.id);
  if (state.activeThread?.id === thread.id)
    state.activeThread = { ...state.activeThread, ...thread };
  const index = state.threads.findIndex((t) => t.id === thread.id);
  if (index < 0) state.threads.unshift(thread);
  else state.threads[index] = { ...state.threads[index], ...thread };
}
function updateTurn(threadId: string, turn: any) {
  if (state.activeThread?.id !== threadId || !turn?.id) return;
  const index = state.turns.findIndex((item) => item.id === turn.id);
  const previous = index >= 0 ? state.turns[index] : null;
  const next = {
    ...previous,
    ...turn,
    items: turn.items?.length ? turn.items : (previous?.items ?? []),
  };
  if (index >= 0) state.turns[index] = next;
  else state.turns.push(next);
}
function noteContentActivity(threadId: string, turn: any) {
  const timestamp = turnActivityAt(turn ?? {});
  legacyRecency.delete(recencyKey(state.hostId, threadId));
  const thread = state.threads.find((item) => item.id === threadId);
  if (thread && timestamp)
    updateThread({
      ...thread,
      recencyAt: Math.max(threadActivityAt(thread), timestamp),
    });
}
function receive(message: any) {
  if (message.id !== undefined && !message.method) {
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) {
      const error = Object.assign(new Error(message.error.message), {
        uncertain: !!message.error.data?.uncertain,
      });
      entry.reject(entry.silentError ? error : fail(error));
    } else entry.resolve(message.result);
    return;
  }
  if (message.method && message.id !== undefined) {
    if (!state.pendingRequests.some((p) => p.id === message.id))
      state.pendingRequests.push(message);
    return;
  }
  const { method, params: p = {} } = message;
  if (method === "bridge/status") {
    const reconnecting = !state.connected && p.connected;
    state.connected = p.connected;
    state.connectionMode = p.mode ?? state.connectionMode;
    if (p.error) state.error = p.error;
    if (p.connected) {
      state.error = "";
      if (p.pendingRequests) state.pendingRequests = p.pendingRequests;
    }
    if (p.connected && Array.isArray(p.activeProcesses)) {
      state.terminalProcesses = p.activeProcesses;
      const process = p.activeProcesses.find(
        (process: any) => process.processId === state.terminalProcessId,
      );
      state.terminalRunning = !!process;
      if (process && (reconnecting || !state.terminalOutput)) {
        terminalDecoders.clear();
        restoreTerminalOutput(process.lastOutput || "");
      }
    }
    return;
  }
  if (method === "bridge/terminal/completed") {
    terminalSessionNames.delete(`${state.hostId}:${p.processId}`);
    state.terminalProcesses = state.terminalProcesses.filter(
      (process) => process.processId !== p.processId,
    );
    if (p.processId === state.terminalProcessId) {
      state.terminalRunning = false;
      state.terminalSessionName = "";
      if (!completedTerminalProcesses.has(p.processId))
        appendTerminal(
          p.error
            ? `\r\n[终端结束：${p.error.message}]\r\n`
            : `\r\n[进程退出 ${p.result?.exitCode ?? "?"}]\r\n${p.result?.stdout ?? ""}${p.result?.stderr ?? ""}`,
        );
      completedTerminalProcesses.add(p.processId);
      const ids = terminalIds();
      if (ids[state.hostId] === p.processId) delete ids[state.hostId];
      sessionStorage.setItem("codex.terminalProcessIds", JSON.stringify(ids));
    }
    return;
  }
  if (method === "bridge/error") {
    state.error = p.message ?? "协议请求失败";
    return;
  }
  if (method === "serverRequest/resolved") {
    state.pendingRequests = state.pendingRequests.filter(
      (request) => request.id !== p.requestId,
    );
    return;
  }
  if (method === "thread/started") updateThread(p.thread);
  if (method === "thread/reverted") {
    const key = recencyKey(state.hostId, p.threadId);
    if (localReverts.delete(key)) return;
    if (pendingMessageEdit && pendingMessageEdit.threadId === p.threadId) pendingMessageEdit.blocked = true;
    resetEditedHistory(p.threadId);
    if (state.activeThread?.id === p.threadId) void selectThread(p.threadId);
    return;
  }
  if (discardedTurns.has(p.turnId || p.turn?.id)) return;
  if (method === "thread/name/updated") {
    const thread = state.threads.find((t) => t.id === p.threadId);
    if (thread) updateThread({ ...thread, name: p.threadName ?? p.name });
  }
  if (method === "thread/status/changed") {
    const thread = state.threads.find((t) => t.id === p.threadId);
    if (thread) updateThread({ ...thread, status: p.status });
    noteRuntime(p.threadId, p.status?.type === "active");
  }
  if (method === "thread/archived") {
    if (
      state.preferences.pins.some(
        (pin) =>
          pin.hostId === state.hostId &&
          pin.kind === "thread" &&
          pin.id === p.threadId,
      )
    )
      void updatePreferences({
        pins: state.preferences.pins.filter(
          (pin) =>
            pin.hostId !== state.hostId ||
            pin.kind !== "thread" ||
            pin.id !== p.threadId,
        ),
      }).catch(() => {});
    cleanupArchivedThread(p.threadId);
  }
  if (method?.startsWith("item/") && p.threadId) {
    const items = currentItems(p.threadId);
    const itemId = p.item?.id ?? p.itemId;
    if (itemId) noteItem(p.threadId, itemId);
    applyItemEvent(items, method, p);
    if (p.item?.type === "contextCompaction" && method === "item/completed") {
      compactedSinceInput.add(p.threadId);
      if (state.activeThread?.id === p.threadId) toast("上下文已压缩");
    }
  }
  if (method === "turn/started") {
    updateTurn(p.threadId, p.turn);
    noteContentActivity(p.threadId, p.turn);
    noteRuntime(p.threadId, true, p.turn.id);
    if (state.activeThread?.id === p.threadId) {
      state.busy = true;
      state.diff = "";
      state.plan = [];
    }
  }
  if (method === "turn/completed") {
    updateTurn(p.threadId, p.turn);
    noteContentActivity(p.threadId, p.turn);
    if (
      !activeTurns.has(p.threadId) ||
      activeTurns.get(p.threadId) === p.turn?.id
    )
      noteRuntime(p.threadId, false);
    if (state.activeThread?.id === p.threadId) {
      if (p.turn?.error?.message) state.error = p.turn.error.message;
      const hostId = state.hostId;
      setTimeout(() => {
        if (hostId === state.hostId && state.activeThread?.id === p.threadId)
          void maybeCompact();
      }, 100);
    }
    void refreshThreads().catch(() => {});
  }
  if (p.threadId === state.activeThread?.id) {
    if (method === "thread/tokenUsage/updated") state.tokenUsage = p.tokenUsage;
    if (method === "turn/diff/updated") state.diff = p.diff;
    if (method === "turn/plan/updated") state.plan = p.plan;
    if (method === "error") state.error = p.error?.message ?? "app-server 错误";
  }
  if (
    method === "command/exec/outputDelta" &&
    p.processId === state.terminalProcessId
  ) {
    const key = `${p.processId}:${p.stream}`;
    let decoder = terminalDecoders.get(key);
    if (!decoder) {
      decoder = new TextDecoder();
      terminalDecoders.set(key, decoder);
    }
    appendTerminal(
      decoder.decode(
        Uint8Array.from(atob(p.deltaBase64), (c) => c.charCodeAt(0)),
        { stream: true },
      ),
    );
    if (p.capReached) appendTerminal("\r\n[输出已截断]\r\n");
  }
}
function connect(): Promise<void> {
  if (!state.online) return Promise.reject(new Error("目前离线，请联网后重试。"));
  if (state.connected && socket?.readyState === WebSocket.OPEN)
    return Promise.resolve();
  if (connecting) return connecting;
  clearTimeout(reconnectTimer);
  const host = state.hostId;
  const attempt = new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/rpc?host=${encodeURIComponent(host)}&clientId=${clientId}`,
    );
    socket = ws;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("app-server 连接超时"));
    }, 30000);
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      try {
        const message = JSON.parse(event.data);
        receive(message);
        if (message.method === "bridge/status" && message.params?.connected) {
          clearTimeout(timer);
          resolve();
        }
        if (message.method === "bridge/status" && message.params?.error) {
          clearTimeout(timer);
          reject(new Error(message.params.error));
          ws.close();
        }
      } catch (error) {
        fail(error);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("无法连接工作站"));
    };
    ws.onclose = (event) => {
      clearTimeout(timer);
      if (socket !== ws) {
        reject(new Error("主机选择已变更"));
        return;
      }
      localReverts.clear();
      state.connected = false;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          Object.assign(
            new Error("连接已断开，服务端可能已接收；重连后请确认对话"),
            { uncertain: true },
          ),
        );
      }
      pending.clear();
      reject(new Error("连接已断开"));
      if (event.code === 4003) {
        void validateSession().then(session => {
          if (session?.authenticated && socket === ws) scheduleReconnect();
        }).catch(error => {
          if (socket !== ws || !state.authenticated) return;
          fail(error);
          scheduleReconnect();
        });
        return;
      }
      if (event.code === 4001) {
        clientId = randomUUID();
        sessionStorage.setItem("codex.clientId", clientId);
      }
      if (state.authenticated) scheduleReconnect();
    };
  });
  const connection = attempt.finally(() => {
    if (connecting === connection) connecting = null;
  });
  connecting = connection;
  return connection;
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (state.authenticated && state.online)
    reconnectTimer = setTimeout(() => { void resumeConnection(); }, 2500);
}
function resumeConnection(): Promise<void> {
  if (!state.online || !state.authenticated || state.loading || state.switchingHost)
    return Promise.resolve();
  const generation = hostSelectionGeneration;
  const hostId = state.hostId;
  if (connectionRecovery?.generation === generation) return connectionRecovery.promise;
  const current = () => state.online && state.authenticated && !state.loading &&
    !state.switchingHost && hostId === state.hostId && generation === hostSelectionGeneration;
  clearTimeout(reconnectTimer);
  const recovery = (async () => {
    try {
      const session = await validateSession();
      if (!session?.authenticated || !current()) return;
      const previous = socket;
      if (state.connected && previous?.readyState === WebSocket.OPEN) {
        // Android can resume a socket that still reports OPEN but no longer carries data.
        // Probe with a bounded, read-only request; never replay user commands.
        try { await rpc("thread/loaded/list", { limit: 1 }, 5000, { silentError: true }); }
        catch {
          if (!current() || socket !== previous) return;
          closeConnection();
        }
        if (!current() || (socket && socket !== previous)) return;
      } else if (!connecting) closeConnection();
      if (!current()) return;
      await connect();
      if (!current()) return;
      startNavigationRefresh();
      await sync();
    } catch (error) {
      if (current()) fail(error);
    } finally {
      if (current() && !state.connected) scheduleReconnect();
    }
  })();
  const promise = recovery.finally(() => {
    if (connectionRecovery?.promise === promise) connectionRecovery = null;
  });
  connectionRecovery = { generation, promise };
  return promise;
}
async function bootstrap() {
  const data = await http("/bootstrap");
  localCwd = data.cwd;
  state.hosts = data.hosts;
  state.projects = data.projects;
  state.connectionMode = data.connectionMode;
  if (data.preferences)
    state.preferences = { ...state.preferences, ...data.preferences };
  else {
    try {
      const stored = await http("/preferences");
      if (stored.preferences)
        state.preferences = { ...state.preferences, ...stored.preferences };
    } catch {
      state.error = "";
    }
  }
  const preferredHost = saved("codex.hostId", "local");
  state.hostId = state.hosts.some((h) => h.id === preferredHost)
    ? preferredHost
    : "local";
  state.terminalProcessId = terminalIds()[state.hostId] || "";
  const preferred = saved<Record<string, string>>("codex.projectPaths", {})[
    state.hostId
  ];
  const selectedHost = state.hosts.find((h) => h.id === state.hostId);
  state.projectPath =
    preferred ??
    selectedHost?.cwd ??
    (selectedHost?.kind === "ssh" ? "/tmp" : localCwd);
  startNavigationRefresh();
  for (const host of state.hosts)
    if (host.id !== state.hostId) void refreshHostNavigation(host.id);
  await connect();
  await sync();
  const preferredThread = saved<Record<string, string>>(
    "codex.selectedThreadIds",
    {},
  )[state.hostId];
  if (preferredThread) await selectThread(preferredThread);
}
function startNavigationRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (state.authenticated && !document.hidden) void refreshNavigation();
  }, 15000);
}
async function initialize() {
  state.loading = true;
  state.error = "";
  try {
    const session = await validateSession();
    if (session?.authenticated) await bootstrap();
  } catch (error) {
    fail(error);
  } finally {
    state.loading = false;
  }
}
async function login(password: string) {
  authenticationGeneration++;
  closeConnection();
  permissionSelections.clear();
  localReverts.clear();
  discardedTurns.clear();
  pendingMessageEdit = null;
  state.loading = true;
  state.error = "";
  try {
    const session = await http("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    authenticationGeneration++;
    csrfToken = session.csrfToken;
    state.authenticated = true;
    await bootstrap();
  } finally {
    state.loading = false;
  }
}
async function logout() {
  authenticationGeneration++;
  if (typeof window !== "undefined" && "serviceWorker" in navigator) {
    await revokeDevicePush({ requestHttp: http });
  }
  await http("/auth/logout", { method: "POST" });
  authenticationGeneration++;
  csrfToken = "";
  state.authenticated = false;
  closeConnection();
  permissionSelections.clear();
  localReverts.clear();
  discardedTurns.clear();
  pendingMessageEdit = null;
  clearAttachments();
  state.items = [];
  state.threads = [];
  state.navigation = {};
  for (const host of state.hosts)
    navigationRevisions.set(
      host.id,
      (navigationRevisions.get(host.id) ?? 0) + 1,
    );
  state.activeThread = null;
  state.pendingRequests = [];
  state.terminalRunning = false;
  state.terminalProcessId = "";
  state.terminalOutput = "";
  state.terminalProcesses = [];
  sessionStorage.setItem("codex.terminalProcessIds", "{}");
}
function setOnline(online: boolean) {
  state.online = online;
  if (!online) closeConnection();
}
async function sync() {
  const hostId = state.hostId;
  const generation = selectionGeneration;
  const selectedId = state.activeThread?.id;
  await Promise.allSettled([refreshThreads(), readConfig()]);
  if (
    hostId === state.hostId &&
    generation === selectionGeneration &&
    selectedId === state.activeThread?.id &&
    selectedId
  )
    await selectThread(selectedId);
}
async function refreshThreads() {
  const generation = ++listGeneration;
  const requestScope = state.hostId;
  const revision = threadEventSequence;
  const result = await threadPage(requestScope, "thread/list", {
    limit: 60,
    modelProviders: [],
  });
  if (generation !== listGeneration || requestScope !== state.hostId) return;
  const preservePagination =
    (!threadListScope || threadListScope === requestScope) && loadedMorePages;
  const fresh = result.data
    .filter(
      (thread: any) =>
        !removedThreads.has(thread.id) ||
        (threadRevisions.get(thread.id) ?? 0) <= revision,
    )
    .map((thread: any) => {
      removedThreads.delete(thread.id);
      const live = state.threads.find((current) => current.id === thread.id);
      return live && (threadRevisions.get(thread.id) ?? 0) > revision
        ? { ...thread, ...live }
        : thread;
    });
  const seen = new Set(fresh.map((thread: any) => thread.id));
  const changed = state.threads.filter(
    (thread) =>
      !seen.has(thread.id) &&
      !removedThreads.has(thread.id) &&
      (threadRevisions.get(thread.id) ?? 0) > revision,
  );
  for (const thread of changed) seen.add(thread.id);
  state.threads = [
    ...changed,
    ...fresh,
    ...(preservePagination
      ? state.threads.filter(
          (thread) => !seen.has(thread.id) && !removedThreads.has(thread.id),
        )
      : []),
  ];
  if (threadListScope !== requestScope || !loadedGlobalPages) {
    threadCursor = result.nextCursor;
    state.moreThreads = !!threadCursor;
  }
  threadListScope = requestScope;
  const missingPins = state.preferences.pins.filter(
    (pin) =>
      pin.hostId === requestScope &&
      pin.kind === "thread" &&
      !removedThreads.has(pin.id) &&
      !state.threads.some((thread) => thread.id === pin.id),
  );
  await Promise.allSettled(
    missingPins.map(async (pin) => {
      const result = await rpc(
        "thread/read",
        { threadId: pin.id, includeTurns: false },
        45000,
        { silentError: true },
      );
      const thread = result.thread
        ? await normalizeThreadRecency(requestScope, result.thread)
        : null;
      if (
        state.hostId === requestScope &&
        generation === listGeneration &&
        thread
      )
        updateThread(thread);
    }),
  );
}
async function loadMoreThreads() {
  if (!threadCursor) return;
  const cursor = threadCursor;
  const requestScope = state.hostId;
  const generation = listGeneration;
  const result = await threadPage(requestScope, "thread/list", {
    limit: 60,
    cursor,
    modelProviders: [],
  });
  if (
    requestScope !== state.hostId ||
    generation !== listGeneration ||
    threadCursor !== cursor
  )
    return;
  const known = new Set(state.threads.map((t) => t.id));
  state.threads.push(
    ...result.data.filter(
      (t: any) => !known.has(t.id) && !removedThreads.has(t.id),
    ),
  );
  loadedMorePages = true;
  loadedGlobalPages = true;
  threadCursor = result.nextCursor;
  state.moreThreads = !!threadCursor;
}
async function loadProjectThreads(projectPath: string, more = false) {
  const hostId = state.hostId;
  const current = state.projectThreadPages[projectPath];
  if (!more && current?.loaded) return;
  const cursor = more ? current?.cursor : undefined;
  if (more && !cursor) return;
  const roots = projectRoots(projectPath);
  const result = await threadPage(hostId, "thread/list", {
    limit: 60,
    cursor,
    cwd: roots,
    modelProviders: [],
  });
  if (hostId !== state.hostId) return;
  const known = new Set(state.threads.map((thread) => thread.id));
  state.threads.push(
    ...result.data.filter(
      (thread: any) => !known.has(thread.id) && !removedThreads.has(thread.id),
    ),
  );
  loadedMorePages = true;
  state.projectThreadPages[projectPath] = {
    loaded: true,
    cursor: result.nextCursor,
  };
}
async function history(
  threadId: string,
  cursor: string | null = null,
  hostId = state.hostId,
) {
  return scopedRpc(hostId, "thread/turns/list", {
    threadId,
    cursor,
    limit: 30,
    sortDirection: "desc",
    itemsView: "full",
  });
}
function rememberThread(id: string) {
  const selections = saved<Record<string, string>>(
    "codex.selectedThreadIds",
    {},
  );
  selections[state.hostId] = id;
  localStorage.setItem("codex.selectedThreadIds", JSON.stringify(selections));
}
async function selectThread(id: string) {
  const generation = ++selectionGeneration;
  const hostId = state.hostId;
  const previousId = state.activeThread?.id;
  if (previousId !== id) pendingMessageEdit = null;
  const previousProfileId = state.activePermissionProfileId;
  const previousPolicy = state.runtimePolicy;
  state.selectingThread = true;
  state.runtimePolicy = null;
  const runtimeRevision = turnRevisions.get(id) ?? 0;
  const itemRevision = itemEventSequence;
  if (state.activeThread) itemCache.set(state.activeThread.id, state.items);
  state.activeThread = state.threads.find((t) => t.id === id) ?? { id };
  state.items = itemCache.get(id) ?? [];
  state.turns = [];
  if (previousId !== id) clearAttachments();
  state.tokenUsage = null;
  state.diff = "";
  state.plan = [];
  state.busy = activeTurns.has(id);
  state.moreTurns = false;
  try {
    const result = await rpc("thread/resume", {
      threadId: id,
      excludeTurns: true,
    });
    if (generation !== selectionGeneration || hostId !== state.hostId) return;
    let page = await history(id, null, hostId);
    const requestedDepth = Math.min(
      10,
      Math.max(
        1,
        Number(
          sessionStorage.getItem(`codex.historyDepth.${state.hostId}.${id}`),
        ) || 1,
      ),
    );
    for (let depth = 1; depth < requestedDepth && page.nextCursor; depth++) {
      const olderPage = await history(id, page.nextCursor, hostId);
      page = {
        data: [...page.data, ...olderPage.data],
        nextCursor: olderPage.nextCursor,
      };
      if (generation !== selectionGeneration) return;
    }
    if (generation !== selectionGeneration) return;
    const runtimeChanged = (turnRevisions.get(id) ?? 0) !== runtimeRevision;
    const latestStatus = state.activeThread?.status;
    const previousProject = state.projectPath;
    state.activePermissionProfileId =
      previousId === id ? previousProfileId : "";
    const knownRecency = state.threads.find(
      (thread) => thread.id === id,
    )?.recencyAt;
    const resumedRecency = historyActivityAt(
      result.thread,
      page.data,
      knownRecency,
    );
    state.activeThread = {
      ...result.thread,
      // A canonical response is authoritative for its snapshot, but new live
      // content may have arrived while resume/history hydration was in flight.
      recencyAt: runtimeChanged
        ? Math.max(resumedRecency, knownRecency ?? 0)
        : resumedRecency,
      ...(runtimeChanged && latestStatus ? { status: latestStatus } : {}),
    };
    if (result.thread.recencyAt == null)
      legacyRecency.set(recencyKey(hostId, id), {
        stamp: result.thread.updatedAt,
        value: state.activeThread.recencyAt,
      });
    updateThread(state.activeThread);
    state.projectPath = result.thread.cwd ?? state.projectPath;
    state.model = result.model ?? result.thread.model ?? state.model;
    state.effort =
      result.reasoningEffort ?? result.thread.reasoningEffort ?? state.effort;
    if (result.sandbox?.type) {
      state.permission = sandboxName(result.sandbox.type);
      state.runtimePolicy = {
        sandboxPolicy: { ...sandboxPolicy(), ...result.sandbox },
        approvalPolicy:
          result.approvalPolicy ??
          (previousId === id ? previousPolicy?.approvalPolicy : null) ??
          "on-request",
      };
    }
    applyPermissionDefault();
    const live = [...currentItems(id)];
    const liveTurns = runtimeChanged ? [...state.turns] : [];
    state.turns = [...page.data].reverse();
    for (const turn of liveTurns) updateTurn(id, turn);
    const running = state.turns.find((turn) => turn.status === "inProgress");
    if (!runtimeChanged) {
      if (running) activeTurns.set(id, running.id);
      else activeTurns.delete(id);
      threadBusy.set(id, !!running || result.thread.status?.type === "active");
    }
    state.busy = threadBusy.get(id) ?? activeTurns.has(id);
    const loaded = state.turns.flatMap((turn) =>
      turn.items.map((item: any) => ({ ...item, turnId: turn.id })),
    );
    const changedIds = new Set(
      [...(itemRevisions.get(id)?.entries() ?? [])]
        .filter(([, revision]) => revision > itemRevision)
        .map(([itemId]) => itemId),
    );
    state.items = mergeSnapshotItems(loaded, live, changedIds);
    itemCache.set(id, state.items);
    turnCursor = page.nextCursor;
    state.moreTurns = !!turnCursor;
    rememberThread(id);
    if (state.projectPath !== previousProject) {
      rememberProject();
      void readConfig();
    }
  } catch (error) {
    if (generation === selectionGeneration) {
      newThread();
      fail(error);
    }
  } finally {
    if (generation === selectionGeneration) state.selectingThread = false;
  }
}
async function loadOlderTurns() {
  const id = state.activeThread?.id;
  const cursor = turnCursor;
  const generation = selectionGeneration;
  if (!id || !cursor) return;
  const page = await history(id, cursor);
  if (
    state.activeThread?.id !== id ||
    generation !== selectionGeneration ||
    cursor !== turnCursor
  )
    return;
  const older = [...page.data].reverse();
  const known = new Set(state.items.map((item) => item.id));
  state.items.unshift(
    ...older
      .flatMap((turn: any) =>
        turn.items.map((item: any) => ({ ...item, turnId: turn.id })),
      )
      .filter((item: any) => !known.has(item.id)),
  );
  state.turns.unshift(...older);
  turnCursor = page.nextCursor;
  state.moreTurns = !!turnCursor;
  const depthKey = `codex.historyDepth.${state.hostId}.${id}`;
  sessionStorage.setItem(
    depthKey,
    String(Math.min(10, (Number(sessionStorage.getItem(depthKey)) || 1) + 1)),
  );
}
function newThread(remember = true) {
  if (remember) rememberThread("");
  state.selectingThread = false;
  state.runtimePolicy = null;
  ++selectionGeneration;
  if (state.activeThread) itemCache.set(state.activeThread.id, state.items);
  state.activeThread = null;
  state.items = [];
  state.turns = [];
  state.busy = false;
  clearAttachments();
  state.tokenUsage = null;
  state.diff = "";
  state.plan = [];
  state.error = "";
  state.moreTurns = false;
  turnCursor = null;
  pendingMessageEdit = null;
  state.activePermissionProfileId = "";
  state.permission = state.preferences.defaultPermission || "workspace-write";
  const defaultProfile = availablePermissionProfiles(
    state.preferences.permissionProfiles,
  ).find(
    (profile) => profile.id === state.preferences.activePermissionProfileId,
  );
  if (defaultProfile) {
    try {
      const result = resolvePermissionProfile(defaultProfile, {
        cwd: state.projectPath,
        requirements: state.requirements,
      });
      state.permission = result.sandbox;
      state.activePermissionProfileId = defaultProfile.id;
    } catch {
      state.activePermissionProfileId = "";
    }
  }
}
function applyPermissionDefault() {
  const key = state.activeThread && recencyKey(state.hostId, state.activeThread.id);
  const selected = key ? permissionSelections.get(key) : undefined;
  const profileId = selected?.profileId ?? state.preferences.activePermissionProfileId;
  const profile = availablePermissionProfiles(state.preferences.permissionProfiles).find(profile => profile.id === profileId);
  state.activePermissionProfileId = profile?.id || "";
  state.permission = profile?.sandboxMode ?? selected?.mode ?? state.preferences.defaultPermission ?? "workspace-write";
  state.runtimePolicy = null;
}
function sandboxName(type: string) {
  return (
    (
      {
        readOnly: "read-only",
        workspaceWrite: "workspace-write",
        dangerFullAccess: "danger-full-access",
      } as Record<string, string>
    )[type] ?? type
  );
}
function sandboxPolicy(
  permission = state.permission,
  projectPath = state.projectPath,
): any {
  const profile = availablePermissionProfiles(
    state.preferences.permissionProfiles,
  ).find(
    (profile) =>
      profile.id === state.activePermissionProfileId &&
      profile.sandboxMode === permission,
  );
  if (profile) {
    const policy = resolvePermissionProfile(profile, {
      cwd: projectPath,
      requirements: state.requirements,
    }).sandboxPolicy;
    if (policy.type === "workspaceWrite")
      policy.writableRoots = projectRoots(projectPath);
    return policy;
  }
  if (
    state.runtimePolicy &&
    state.activeThread &&
    sandboxName(state.runtimePolicy.sandboxPolicy.type) === permission
  )
    return { ...state.runtimePolicy.sandboxPolicy };
  if (permission === "read-only")
    return { type: "readOnly", networkAccess: false };
  if (permission === "danger-full-access") return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    writableRoots: projectRoots(projectPath),
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
function approvalPolicy(permission = state.permission): any {
  return permission === "danger-full-access" ? "never" : "on-request";
}
async function send(text: string, editedInput?: any[]) {
  if (!text.trim() && !state.attachments.length && !editedInput?.length) return;
  if (state.editingMessage && !editedInput) throw fail(new Error("正在重新发送编辑后的消息，请稍候"));
  if (state.selectingThread || state.switchingHost || state.changingContext)
    throw fail(new Error("正在加载会话或主机配置，请稍后发送"));
  if (sendInFlight) throw fail(new Error("上一条消息正在发送，请稍候"));
  const hostId = state.hostId;
  const generation = selectionGeneration;
  const cwd = state.projectPath;
  const model = state.model;
  const effort = state.effort;
  const permission = state.permission;
  const profile = availablePermissionProfiles(
    state.preferences.permissionProfiles,
  ).find((profile) => profile.id === state.activePermissionProfileId);
  const resolvedProfile = profile
    ? resolvePermissionProfile(profile, {
        cwd,
        requirements: state.requirements,
      })
    : null;
  const resumed =
    state.activeThread &&
    state.runtimePolicy &&
    sandboxName(state.runtimePolicy.sandboxPolicy.type) === permission
      ? JSON.parse(JSON.stringify(state.runtimePolicy))
      : null;
  const policy =
    resolvedProfile?.sandboxPolicy ??
    resumed?.sandboxPolicy ??
    resolvePermissionProfile(
      {
        id: "base",
        name: "基础权限",
        sandboxMode: permission as any,
        approvalPolicy: approvalPolicy(permission),
        networkAccess: permission === "danger-full-access",
      },
      { cwd, requirements: state.requirements },
    ).sandboxPolicy;
  const approval =
    resolvedProfile?.approvalPolicy ??
    resumed?.approvalPolicy ??
    approvalPolicy(permission);
  const workspaceRoots = projectRoots(cwd);
  if (policy.type === "workspaceWrite" && (!resumed || resolvedProfile))
    policy.writableRoots = workspaceRoots;
  const attachments = editedInput ? [] : [...state.attachments];
  const selectedModel = state.models.find((entry) => entry.model === model);
  if (
    selectedModel?.inputModalities?.length &&
    !selectedModel.inputModalities.includes("image") &&
    (attachments.some((file) => file.mime?.startsWith("image/")) || editedInput?.some(input => ['image', 'localImage'].includes(input.type)))
  )
    throw fail(
      new Error("当前模型只支持文本输入，请选择支持图片的模型或移除图片附件"),
    );
  const inputs: any[] = editedInput ?? [{ type: "text", text, text_elements: [] }];
  for (const file of attachments) {
    if (file.mime?.startsWith("image/"))
      inputs.push({ type: "localImage", path: file.path });
    else inputs[0].text += `\n\n附件文件：${file.path}（${file.name}）`;
  }
  // Explicit skill/app selections are persisted as structured protocol inputs.
  for (const skill of state.skills)
    if (inputs[0].text.includes(`$${skill.name}`) && !inputs.some(input => input.type === 'skill' && input.path === skill.path))
      inputs.push({ type: "skill", name: skill.name, path: skill.path });
  for (const app of state.apps)
    if (app.slug && inputs[0].text.includes(`$${app.slug}`) && !inputs.some(input => input.type === 'mention' && input.path === `app://${app.id}`))
      inputs.push({ type: "mention", name: app.name, path: `app://${app.id}` });
  state.error = "";
  if (!editedInput) pendingMessageEdit = null;
  sendInFlight = true;
  let id = state.activeThread?.id as string | undefined;
  const messageId = randomUUID();
  try {
    if (!id) {
      const result = await rpc("thread/start", {
        cwd,
        runtimeWorkspaceRoots: workspaceRoots,
        model: model || undefined,
        sandbox: permission as any,
        approvalPolicy: approval,
        historyMode: "paginated",
      });
      id = result.thread.id;
      if (hostId !== state.hostId)
        throw new Error("工作站已切换，请在原工作站确认消息状态");
      updateThread(result.thread);
      permissionSelections.set(recencyKey(hostId, id!), { mode: permission, profileId: state.activePermissionProfileId });
      if (generation === selectionGeneration && hostId === state.hostId) {
        state.activeThread = result.thread;
        state.items = itemCache.get(id!) ?? [];
        rememberThread(id!);
      }
    }
    if (hostId !== state.hostId)
      throw new Error("工作站已切换，请在原工作站确认消息状态");
    compactedSinceInput.delete(id!);
    upsertItem(currentItems(id!), {
      id: messageId,
      clientId: messageId,
      type: "userMessage",
      content: inputs,
      status: "sending",
    });
    noteItem(id!, messageId);
    const busy =
      activeTurns.has(id!) ||
      threadBusy.get(id!) ||
      (state.activeThread?.id === id && state.busy);
    if (busy && editedInput)
      throw new Error("会话已开始新的任务，请取消编辑并确认最新历史");
    if (busy && !activeTurns.has(id!))
      throw new Error("当前任务状态正在同步，请稍后发送");
    if (busy) {
      await rpc("turn/steer", {
        threadId: id!,
        expectedTurnId: activeTurns.get(id!)!,
        clientUserMessageId: messageId,
        input: inputs,
      });
    } else {
      const revision = turnRevisions.get(id!) ?? 0;
      const itemRevision = itemEventSequence;
      threadBusy.set(id!, true);
      if (state.activeThread?.id === id) state.busy = true;
      const result = await rpc("turn/start", {
        threadId: id!,
        clientUserMessageId: messageId,
        input: inputs,
        cwd,
        runtimeWorkspaceRoots: workspaceRoots,
        model: model || undefined,
        effort: effort as any,
        approvalPolicy: approval,
        sandboxPolicy: policy,
      });
      if ((turnRevisions.get(id!) ?? 0) === revision) {
        const running =
          !result.turn.status || result.turn.status === "inProgress";
        noteRuntime(id!, running, running ? result.turn.id : undefined);
        updateTurn(id!, result.turn);
        noteContentActivity(id!, result.turn);
      }
      for (const item of result.turn.items ?? [])
        if ((itemRevisions.get(id!)?.get(item.id) ?? 0) <= itemRevision) {
          upsertItem(currentItems(id!), { ...item, turnId: result.turn.id });
          noteItem(id!, item.id);
        }
    }
    releaseAttachments(attachments);
    if (generation === selectionGeneration && hostId === state.hostId)
      state.attachments = state.attachments.filter(
        (file) => !attachments.includes(file),
      );
  } catch (error) {
    if (id && hostId === state.hostId) {
      const items = currentItems(id);
      const index = items.findIndex((item) => item.id === messageId);
      if ((error as { uncertain?: boolean }).uncertain) {
        if (index >= 0)
          items[index] = { ...items[index], status: "unconfirmed" };
        if (
          state.activeThread?.id === id &&
          state.connected &&
          generation === selectionGeneration
        )
          void selectThread(id);
      } else if (index >= 0) items.splice(index, 1);
      threadBusy.set(id, activeTurns.has(id));
      if (state.activeThread?.id === id) state.busy = activeTurns.has(id);
    }
    throw fail(error);
  } finally {
    sendInFlight = false;
  }
}
function canEditMessage(itemId: string) {
  const blocked = !state.connected || !state.online || state.busy || state.editingMessage || sendInFlight || state.selectingThread || state.switchingHost || state.changingContext;
  if (blocked) return false;
  if (pendingMessageEdit?.item.id === itemId && pendingMessageEdit.hostId === state.hostId && pendingMessageEdit.threadId === state.activeThread?.id) {
    if (pendingMessageEdit.blocked) return false;
    if (pendingMessageEdit.reverted)
      return !!pendingMessageEdit.needsHistory || (state.turns.at(-1)?.id ?? null) === pendingMessageEdit.prefixLastTurnId;
  }
  return editableMessage(state.items, state.turns, state.activeThread)?.id === itemId;
}
function cancelMessageEdit(itemId: string) {
  if (!state.editingMessage && pendingMessageEdit?.item.id === itemId) pendingMessageEdit = null;
}
function resetEditedHistory(threadId: string, removed: string[] = []) {
  for (const turnId of removed) discardedTurns.add(turnId);
  itemCache.delete(threadId);
  itemRevisions.delete(threadId);
  compactedSinceInput.delete(threadId);
  noteRuntime(threadId, false);
  state.pendingRequests = state.pendingRequests.filter(request => (request.params?.threadId || request.params?.conversationId) !== threadId);
  if (state.activeThread?.id === threadId) {
    state.items = [];
    state.turns = [];
    state.diff = "";
    state.plan = [];
    state.tokenUsage = null;
    state.moreTurns = false;
    turnCursor = null;
  }
}
async function resendEditedMessage(itemId: string, text: string) {
  if (!canEditMessage(itemId)) throw fail(new Error("当前消息不能编辑，请等待任务结束并确认会话状态"));
  const hostId = state.hostId;
  const threadId = state.activeThread.id;
  const generation = selectionGeneration;
  const original = pendingMessageEdit?.reverted && pendingMessageEdit.item.id === itemId
    ? pendingMessageEdit.item : state.items.find(item => item.id === itemId)!;
  const input = editedMessageInput(original, text);
  const profile = availablePermissionProfiles(state.preferences.permissionProfiles).find(profile => profile.id === state.activePermissionProfileId);
  resolvePermissionProfile(profile || { id: 'edit', name: '消息权限', sandboxMode: state.permission as any, approvalPolicy: approvalPolicy(), networkAccess: state.permission === 'danger-full-access' }, { cwd: state.projectPath, requirements: state.requirements });
  const selectedModel = state.models.find(model => model.model === state.model);
  if (selectedModel?.inputModalities?.length && !selectedModel.inputModalities.includes('image') && input.some(entry => ['image', 'localImage'].includes(entry.type)))
    throw fail(new Error('当前模型不支持图片，请选择支持图片的模型后重新发送'));
  if (!pendingMessageEdit?.reverted || pendingMessageEdit.item.id !== itemId)
    pendingMessageEdit = { hostId, threadId, item: JSON.parse(JSON.stringify(original)), reverted: false, blocked: false, prefixLastTurnId: state.turns.at(-2)?.id ?? null };
  const edit = pendingMessageEdit;
  state.editingMessage = true;
  const key = recencyKey(hostId, threadId);
  const stillSelected = () => hostId === state.hostId && threadId === state.activeThread?.id && generation === selectionGeneration;
  try {
    if (!edit.reverted) {
      const revision = turnRevisions.get(threadId) ?? 0;
      const latest = await scopedRpc(hostId, 'thread/turns/list', {
        threadId, limit: 1, cursor: null, sortDirection: 'desc', itemsView: 'full',
      });
      const turn = latest.data[0];
      const messages = turn?.items?.filter((item: any) => item.type === 'userMessage') ?? [];
      if (!stillSelected() || state.busy || (turnRevisions.get(threadId) ?? 0) !== revision ||
          turn?.id !== original.turnId || !['completed', 'failed', 'interrupted'].includes(turn.status) ||
          messages.length !== 1 || messages[0].id !== original.id) {
        edit.blocked = true;
        if (stillSelected()) void selectThread(threadId);
        throw new Error('会话已被其他客户端更新，请取消编辑并确认最新历史');
      }
      localReverts.add(key);
      const result = await rpc('thread/revert', { threadId, beforeTurnId: original.turnId! });
      edit.reverted = true;
      edit.needsHistory = true;
      if (!stillSelected()) throw new Error('会话已切换，原会话已回退；请返回原会话查看');
      const removed = state.turns.slice(state.turns.findIndex(turn => turn.id === original.turnId)).map(turn => turn.id);
      resetEditedHistory(threadId, removed);
      updateThread(result.thread);
    }
    if (edit.reverted) {
      const revision = turnRevisions.get(threadId) ?? 0;
      // Read the current head on retries, so a newer turn from another client
      // cannot be hidden by the cursor returned from the original revert.
      const page = await history(threadId, null, hostId);
      if (!stillSelected()) throw new Error('会话已切换，请返回原会话重新发送');
      if ((page.data[0]?.id ?? null) !== edit.prefixLastTurnId || (turnRevisions.get(threadId) ?? 0) !== revision) {
        edit.blocked = true;
        void selectThread(threadId);
        throw new Error('会话已被其他客户端更新，请取消编辑并确认最新历史');
      }
      state.turns = [...page.data].reverse();
      state.items = state.turns.flatMap(turn => turn.items.map((item: any) => ({ ...item, turnId: turn.id })));
      itemCache.set(threadId, state.items);
      turnCursor = page.nextCursor;
      state.moreTurns = !!turnCursor;
      edit.needsHistory = false;
    }
    if (!stillSelected() || edit.blocked || state.busy) throw new Error('会话状态已变化，请重新打开后确认');
    await send(text, input);
    pendingMessageEdit = null;
    toast('消息已编辑并重新发送');
  } catch (error) {
    if (!edit.reverted) localReverts.delete(key);
    if ((error as { uncertain?: boolean }).uncertain) {
      edit.blocked = true;
      if (stillSelected() && state.connected) void selectThread(threadId);
    }
    throw fail(error);
  } finally { state.editingMessage = false; }
}
async function interrupt() {
  const id = state.activeThread?.id;
  const turnId = id && activeTurns.get(id);
  if (turnId) await rpc("turn/interrupt", { threadId: id, turnId });
}
async function fork(lastTurnId?: string) {
  if (!state.activeThread) return;
  const result = await rpc("thread/fork", {
    threadId: state.activeThread.id,
    lastTurnId,
    excludeTurns: true,
  });
  updateThread(result.thread);
  await selectThread(result.thread.id);
  toast("已创建对话分支");
}
async function compact() {
  const id = state.activeThread?.id;
  if (!id) return;
  if (state.busy) throw fail(new Error("请等待当前任务完成后压缩上下文"));
  state.busy = true;
  try {
    await rpc("thread/compact/start", { threadId: id });
    compactedSinceInput.add(id);
  } catch (error) {
    state.busy = false;
    throw error;
  }
}
async function maybeCompact() {
  if (
    state.autoCompact &&
    !state.busy &&
    state.activeThread &&
    !compactedSinceInput.has(state.activeThread.id) &&
    contextPercent(state.tokenUsage) >= state.compactThreshold
  ) {
    await compact().catch(() => {});
  }
}
function setAutoCompact(enabled: boolean, threshold = 85) {
  state.autoCompact = enabled;
  state.compactThreshold = Math.min(95, Math.max(50, threshold));
  localStorage.setItem("codex.autoCompact", JSON.stringify(enabled));
  localStorage.setItem(
    "codex.compactThreshold",
    JSON.stringify(state.compactThreshold),
  );
}
async function renameThread(name: string) {
  if (!state.activeThread || !name.trim()) return;
  await rpc("thread/name/set", {
    threadId: state.activeThread.id,
    name: name.trim(),
  });
  updateThread({ ...state.activeThread, name: name.trim() });
}
function cleanupArchivedThread(id: string) {
  removedThreads.add(id);
  threadRevisions.set(id, ++threadEventSequence);
  state.threads = state.threads.filter((thread) => thread.id !== id);
  if (state.activeThread?.id === id) newThread();
}
async function archiveThread(id: string, hostId = state.hostId) {
  await scopedRpc(hostId, "thread/archive", { threadId: id });
  if (hostId === state.hostId) cleanupArchivedThread(id);
  const nav = state.navigation[hostId];
  if (nav) nav.threads = nav.threads.filter((thread) => thread.id !== id);
  navigationRevisions.set(hostId, (navigationRevisions.get(hostId) ?? 0) + 1);
  if (
    state.preferences.pins.some(
      (pin) => pin.hostId === hostId && pin.kind === "thread" && pin.id === id,
    )
  ) {
    try {
      await updatePreferences({
        pins: state.preferences.pins.filter(
          (pin) =>
            pin.hostId !== hostId || pin.kind !== "thread" || pin.id !== id,
        ),
      });
    } catch {
      toast("对话已归档；置顶偏好未保存，请刷新确认");
    }
  }
}
async function setProject(path: string) {
  state.projectPath = path;
  newThread();
  rememberProject();
  await Promise.allSettled([refreshThreads(), readConfig()]);
}
function rememberProject() {
  const paths = saved<Record<string, string>>("codex.projectPaths", {});
  paths[state.hostId] = state.projectPath;
  localStorage.setItem("codex.projectPaths", JSON.stringify(paths));
}
async function addProject(
  path: string,
  name?: string,
  rootPaths?: string[],
  hostId = state.hostId,
) {
  const generation = selectionGeneration;
  if (!state.hosts.some((host) => host.id === hostId))
    throw new Error("主机不存在");
  const result = await http("/projects", {
    method: "POST",
    body: JSON.stringify({ path, name, rootPaths, hostId }),
  });
  if (result.projects) state.projects = result.projects;
  else {
    const project = result.project ?? result;
    state.projects = [
      ...state.projects.filter(
        (item) => item.path !== path || item.hostId !== hostId,
      ),
      project,
    ];
  }
  if (hostId === state.hostId && generation === selectionGeneration)
    await setProject(path);
}
async function browseDirectory(hostId: string, path?: string) {
  const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  return http(`/hosts/${encodeURIComponent(hostId)}/directories${query}`, {}, false);
}
/** Choosing the destination of an unsent chat must never reuse file paths from
 * another machine. Keep local project attachments, and upload original files
 * again when the selected host changes. */
async function chooseNewContext(hostId: string, projectPath?: string) {
  if (state.activeThread || state.busy || state.selectingThread ||
      state.switchingHost || state.changingContext || sendInFlight)
    throw new Error("请等待当前操作完成后选择新对话位置");
  if (!state.hosts.some((host) => host.id === hostId))
    throw new Error("主机不存在");
  if (projectPath !== undefined && !state.projects.some((project) =>
      (project.hostId || "local") === hostId &&
      [project.path, ...(project.rootPaths || [])].includes(projectPath)) &&
      !(hostId === state.hostId && projectPath === state.projectPath))
    throw new Error("所选项目不属于这台主机");
  if (hostId === state.hostId &&
      (projectPath === undefined || projectPath === state.projectPath)) return true;
  const previousHost = state.hostId;
  const attachments = state.attachments;
  const originals = attachments.map((file) => attachmentOriginals.get(toRaw(file)));
  state.changingContext = true;
  state.attachments = [];
  let restored = false;
  let expectedSelection = selectionGeneration;
  let expectedHost = hostSelectionGeneration;
  const current = () => state.authenticated && state.hostId === hostId &&
    !state.activeThread && !state.selectingThread &&
    expectedSelection === selectionGeneration &&
    expectedHost === hostSelectionGeneration;
  try {
    if (hostId !== state.hostId || !state.connected) {
      const changingHost = setHost(hostId);
      expectedSelection = selectionGeneration;
      expectedHost = hostSelectionGeneration;
      await changingHost;
      if (!current()) return false;
    }
    // A new host without a remembered path starts at its first known project.
    const preferredPath = projectPath ?? state.projects.find((project) =>
      (project.hostId || "local") === hostId &&
      [project.path, ...(project.rootPaths || [])].includes(state.projectPath))?.path ??
      state.projects.find((project) => (project.hostId || "local") === hostId)?.path;
    if (preferredPath && preferredPath !== state.projectPath) {
      const changingProject = setProject(preferredPath);
      expectedSelection = selectionGeneration;
      await changingProject;
      if (!current()) return false;
    }
    if (!current()) return false;
    if (previousHost === hostId) {
      state.attachments = attachments;
      restored = true;
    } else if (attachments.length) {
      if (originals.some((file) => !file))
        throw new Error("已切换主机，请在这台主机重新上传附件");
      try {
        await uploadFiles(originals as File[], false);
      } catch {
        if (!current()) return false;
        throw new Error("已切换主机，附件上传失败，请重新上传附件");
      }
      if (!current()) return false;
    }
    return true;
  } finally {
    if (!restored) releaseAttachments(attachments);
    state.changingContext = false;
  }
}
async function updateProject(
  project: any,
  fields: { name: string; rootPaths?: string[] },
) {
  const result = await http("/projects", {
    method: "PATCH",
    body: JSON.stringify({
      hostId: project.hostId || "local",
      path: project.path,
      ...fields,
    }),
  });
  state.projects = result.projects;
  toast("项目已更新");
}
async function removeProject(project: any) {
  const hostId = project.hostId || "local";
  const result = await http("/projects", {
    method: "DELETE",
    body: JSON.stringify({ hostId, path: project.path }),
  });
  state.projects = result.projects;
  await updatePreferences({
    pins: state.preferences.pins.filter(
      (pin) =>
        pin.hostId !== hostId ||
        pin.kind !== "project" ||
        pin.id !== project.path,
    ),
  });
  toast("项目已从侧栏移除");
}
async function archiveProject(project: any) {
  const hostId = project.hostId || "local";
  const ids = new Set<string>();
  for (const cwd of [
    ...new Set<string>([project.path, ...(project.rootPaths || [])]),
  ]) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await threadPage(hostId, "thread/list", {
        cwd,
        archived: false,
        limit: 100,
        cursor,
      });
      for (const thread of page.data) ids.add(thread.id);
      cursor = page.nextCursor || undefined;
      if (cursor && seen.has(cursor))
        throw new Error("项目历史分页重复，请刷新后重试");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  let archived = 0;
  try {
    for (const id of ids) {
      await archiveThread(id, hostId);
      archived++;
    }
  } catch (error: any) {
    throw new Error(`已归档 ${archived} 个对话，其余未完成：${error.message}`);
  }
  toast(`已归档 ${archived} 个对话，可在已归档对话中恢复`);
}
async function setHost(id: string) {
  if (!state.hosts.some((host) => host.id === id))
    throw fail(new Error("主机不存在"));
  if (id === state.hostId && state.connected) return;
  const hostGeneration = ++hostSelectionGeneration;
  state.switchingHost = true;
  const previous = hostNavigation(state.hostId);
  previous.threads = [...state.threads];
  previous.cursor = threadCursor;
  previous.loadedMore = loadedMorePages;
  previous.loaded = state.connected || previous.loaded;
  previous.projectPages = { ...state.projectThreadPages };
  closeConnection();
  itemCache.clear();
  discardedTurns.clear();
  localReverts.clear();
  pendingMessageEdit = null;
  activeTurns.clear();
  compactedSinceInput.clear();
  turnRevisions.clear();
  threadBusy.clear();
  itemRevisions.clear();
  threadRevisions.clear();
  removedThreads.clear();
  threadListScope = "";
  loadedMorePages = false;
  loadedGlobalPages = false;
  ++listGeneration;
  ++configGeneration;
  ++integrationGeneration;
  ++searchGeneration;
  newThread(false);
  state.threads = [...(state.navigation[id]?.threads ?? [])];
  state.projectThreadPages = {};
  state.pendingRequests = [];
  state.hostId = id;
  state.model = "";
  state.models = [];
  state.config = null;
  state.requirements = null;
  state.nativePermissionProfiles = [];
  state.skills = [];
  state.apps = [];
  state.mcpServers = [];
  state.integrationErrors = [];
  state.rateLimits = null;
  state.searchResults = [];
  state.permission = "workspace-write";
  state.activePermissionProfileId = "";
  state.account = null;
  state.terminalOutput = "";
  state.terminalRunning = false;
  state.terminalProcessId = terminalIds()[id] || "";
  state.terminalSessionName =
    terminalSessionNames.get(`${id}:${state.terminalProcessId}`) || "";
  state.terminalProcesses = [];
  localStorage.setItem("codex.hostId", JSON.stringify(id));
  state.projectPath =
    saved<Record<string, string>>("codex.projectPaths", {})[id] ??
    state.hosts.find((host) => host.id === id)?.cwd ??
    (id === "local" ? localCwd : "/tmp");
  startNavigationRefresh();
  try {
    await connect();
    if (id !== state.hostId || hostGeneration !== hostSelectionGeneration)
      return;
    await sync();
  } finally {
    if (hostGeneration === hostSelectionGeneration) state.switchingHost = false;
  }
}
async function testHost(host: any) {
  return http(
    "/hosts/test",
    { method: "POST", body: JSON.stringify(host) },
    false,
  );
}
async function uploadSshKey(file: File) {
  const body = new FormData();
  body.append("key", file);
  return http("/ssh-keys", { method: "POST", body }, false);
}
async function removeSshKey(id: string) {
  return http(`/ssh-keys/${encodeURIComponent(id)}`, { method: "DELETE" }, false);
}
async function addHost(host: any) {
  const result = await http("/hosts", {
    method: "POST",
    body: JSON.stringify(host),
  });
  state.hosts = result.hosts ?? [...state.hosts, result.host ?? result];
  const added =
    result.host ??
    state.hosts.find(
      (item) => item.id !== "local" && !state.navigation[item.id],
    );
  if (added) void refreshHostNavigation(added.id);
  toast("SSH 主机已添加");
}
async function updateHost(id: string, host: any) {
  const result = await http(`/hosts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(host),
  });
  state.hosts =
    result.hosts ??
    state.hosts.map((item) => (item.id === id ? result.host : item));
  if (result.connectionReset) {
    navigationRevisions.set(id, (navigationRevisions.get(id) ?? 0) + 1);
    navigationRequests.delete(id);
    delete state.navigation[id];
    if (state.hostId === id) {
      // The configuration is already saved; a failed reconnect must not imply
      // that saving failed, or replace an unrelated active chat's connection.
      closeConnection();
      await setHost(id).catch(() => toast("配置已保存；主机暂时无法连接"));
    } else void refreshHostNavigation(id);
  }
  toast("主机配置已更新");
  return result;
}
async function removeHost(id: string) {
  const result = await http(`/hosts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  state.hosts = result.hosts ?? state.hosts.filter((host) => host.id !== id);
  navigationRevisions.set(id, (navigationRevisions.get(id) ?? 0) + 1);
  navigationRequests.delete(id);
  delete state.navigation[id];
  state.projects = state.projects.filter((project) => project.hostId !== id);
  if (state.hostId === id) await setHost("local");
}
async function uploadFiles(files: FileList | File[], reportError = true) {
  const generation = selectionGeneration;
  const requestScope = scope();
  const originals = Array.from(files);
  const form = new FormData();
  form.set("hostId", state.hostId);
  form.set("cwd", state.projectPath);
  for (const file of originals) form.append("files", file);
  const result = await http("/uploads", { method: "POST", body: form }, reportError);
  if (generation !== selectionGeneration || requestScope !== scope()) return;
  state.attachments.push(
    ...result.files.map((file: any, index: number) => {
      const attachment = { ...file, previewUrl:
        file.mime?.startsWith("image/") && originals[index]
          ? URL.createObjectURL(originals[index])
          : undefined };
      if (originals[index]) attachmentOriginals.set(attachment, originals[index]);
      return attachment;
    }),
  );
}
function removeAttachment(index: number) {
  releaseAttachments(state.attachments.slice(index, index + 1));
  state.attachments.splice(index, 1);
}
let searchGeneration = 0;
async function searchFiles(query: string) {
  const generation = ++searchGeneration;
  const requestScope = scope();
  const result = await rpc("fuzzyFileSearch", {
    query,
    roots: [state.projectPath],
    cancellationToken: String(generation),
  });
  const files = result.files.map((file: any) => ({
    ...file,
    name: file.file_name,
    absolutePath: `${file.root.replace(/\/$/, "")}/${file.path}`,
  }));
  if (generation === searchGeneration && requestScope === scope())
    state.searchResults = files;
  return files;
}
async function readDirectory(path: string) {
  const result = await rpc("fs/readDirectory", { path });
  return result.entries
    .map((entry: any) => ({
      ...entry,
      name: entry.fileName,
      path: `${path.replace(/\/$/, "")}/${entry.fileName}`,
    }))
    .sort(
      (a: any, b: any) =>
        Number(b.isDirectory) - Number(a.isDirectory) ||
        a.name.localeCompare(b.name),
    );
}
async function readFile(path: string) {
  const result = await rpc("fs/readFile", { path });
  if (result.dataBase64.length > Math.ceil((8 * 1024 * 1024 * 4) / 3))
    throw fail(new Error("文件超过 8 MB，请使用终端读取"));
  const extensions: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  const mime =
    extensions[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text/plain";
  let content = "";
  let binary = false;
  if (!mime.startsWith("image/")) {
    const bytes = Uint8Array.from(atob(result.dataBase64), (character) =>
      character.charCodeAt(0),
    );
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      binary =
        bytes.includes(0) ||
        /\.(?:pdf|zip|gz|7z|tar|docx?|xlsx?|pptx?|sqlite|db|exe|woff2?|ttf|mp[34]|wav|mov)$/i.test(
          path,
        );
    } catch {
      binary = true;
    }
    if (binary) content = "";
  }
  return {
    path,
    mime,
    content,
    binary,
    dataUrl: mime.startsWith("image/")
      ? `data:${mime};base64,${result.dataBase64}`
      : undefined,
  };
}
async function downloadFile(path: string) {
  const result = await rpc("fs/readFile", { path });
  if (result.dataBase64.length > Math.ceil((8 * 1024 * 1024 * 4) / 3))
    throw new Error("单文件下载目前支持最多 8 MB，请使用终端传输更大的文件");
  const bytes = Uint8Array.from(atob(result.dataBase64), (character) =>
    character.charCodeAt(0),
  );
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = path.split("/").pop() || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function writeFile(path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  await rpc("fs/writeFile", { path, dataBase64: btoa(binary) });
  toast("文件已保存");
}
async function runTerminal(command: string) {
  if (state.terminalRunning) throw fail(new Error("已有终端命令正在运行"));
  const processId = `web-${randomUUID()}`;
  rememberTerminal(processId);
  state.terminalRunning = true;
  state.terminalSessionName = "";
  terminalDecoders.clear();
  appendTerminal(`$ ${command}\r\n`);
  let uncertain = false;
  try {
    const result = await rpc(
      "command/exec",
      {
        command: ["/bin/sh", "-lc", command],
        cwd: state.projectPath,
        processId,
        streamStdin: true,
        streamStdoutStderr: true,
        timeoutMs: 3600000,
        sandboxPolicy: sandboxPolicy(),
      },
      3610000,
    );
    if (
      state.terminalProcessId === processId &&
      !completedTerminalProcesses.has(processId)
    )
      appendTerminal(
        `\r\n[进程退出 ${result.exitCode}]\r\n${result.stdout ?? ""}${result.stderr ?? ""}`,
      );
    return result;
  } catch (error) {
    uncertain = !!(error as { uncertain?: boolean }).uncertain;
    throw error;
  } finally {
    if (state.terminalProcessId === processId && !uncertain)
      state.terminalRunning = false;
  }
}
async function startTerminal(
  cols = 80,
  rows = 24,
  options: {
    command?: string[];
    persistent?: boolean;
    sessionName?: string;
    sessionId?: string;
    env?: Record<string, string | null>;
    newConnection?: boolean;
  } = {},
) {
  if (state.terminalRunning && !options.newConnection) return;
  if (state.permission === "read-only")
    throw fail(new Error("切换到工作区写入权限后启动终端"));
  const processId = `web-pty-${randomUUID()}`;
  rememberTerminal(processId);
  state.terminalRunning = true;
  state.terminalOutput = "";
  state.terminalSessionName = options.persistent
    ? options.sessionName || "tmux"
    : "";
  if (state.terminalSessionName)
    terminalSessionNames.set(
      `${state.hostId}:${processId}`,
      state.terminalSessionName,
    );
  terminalDecoders.clear();
  let uncertain = false;
  try {
    const result = await rpc(
      "command/exec",
      {
        command: options.command || ["/bin/sh"],
        processId,
        tty: true,
        cwd: state.projectPath,
        env: { TERM: "xterm-256color", ...options.env },
        size: { cols, rows },
        disableTimeout: true,
        sandboxPolicy: sandboxPolicy(),
      },
      7200000,
    );
    if (
      state.terminalProcessId === processId &&
      !completedTerminalProcesses.has(processId)
    )
      appendTerminal(`\r\n[终端退出 ${result.exitCode}]\r\n`);
  } catch (error) {
    uncertain = !!(error as { uncertain?: boolean }).uncertain;
    throw error;
  } finally {
    if (state.terminalProcessId === processId && !uncertain)
      state.terminalRunning = false;
  }
}
async function switchTmuxTerminal(prepared: any) {
  if (
    state.switchingHost ||
    state.selectingThread ||
    prepared.hostId !== state.hostId ||
    prepared.cwd !== state.projectPath ||
    prepared.permission !== state.permission
  )
    throw new Error("工作区已切换，请重新选择 tmux 会话");
  if (state.permission === "read-only")
    throw new Error("当前只读权限，切换权限后可连接 tmux");
  if (!Array.isArray(prepared.command) || !prepared.command.length)
    throw new Error("无效的 tmux 连接");
  const hostId = state.hostId;
  const cwd = state.projectPath;
  // Terminating a tmux client detaches it. Ordinary terminals stay available
  // through the existing process selector while the new client is launched.
  const hostVersion = hostSelectionGeneration;
  const selectionVersion = selectionGeneration;
  const terminalVersion = terminalSelectionGeneration;
  const permission = state.permission;
  const policy = JSON.stringify(sandboxPolicy());
  if (state.terminalRunning && state.terminalSessionName) await stopTerminal();
  if (
    hostId !== state.hostId ||
    cwd !== state.projectPath ||
    hostVersion !== hostSelectionGeneration ||
    selectionVersion !== selectionGeneration ||
    terminalVersion !== terminalSelectionGeneration ||
    permission !== state.permission ||
    policy !== JSON.stringify(sandboxPolicy()) ||
    state.switchingHost ||
    state.selectingThread
  )
    throw new Error("工作区已切换，请重新选择 tmux 会话");
  void startTerminal(80, 24, {
    ...prepared,
    persistent: true,
    newConnection: true,
  }).catch((error) => fail(error));
}
async function resizeTerminal(cols: number, rows: number) {
  if (state.terminalRunning && state.terminalProcessId)
    await rpc("command/exec/resize", {
      processId: state.terminalProcessId,
      size: { cols, rows },
    });
}
async function writeTerminal(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  await rpc("command/exec/write", {
    processId: state.terminalProcessId,
    deltaBase64: btoa(binary),
  });
}
async function stopTerminal() {
  if (state.terminalProcessId)
    await rpc("command/exec/terminate", { processId: state.terminalProcessId });
}
function respond(id: string | number, result: any) {
  if (!socket || !state.connected)
    throw fail(new Error("连接断开，请等待重新连接后审批"));
  socket.send(JSON.stringify({ id, result }));
  state.pendingRequests = state.pendingRequests.filter(
    (request) => request.id !== id,
  );
}
async function readConfig() {
  const generation = ++configGeneration;
  const requestScope = scope();
  const results = await Promise.allSettled([
    rpc("config/read", {
      includeLayers: true,
      cwd: state.projectPath || undefined,
    }),
    rpc("model/list", { limit: 100, includeHidden: false }),
    rpc("account/read", { refreshToken: false }, 45000, { silentError: true }),
    rpc("account/rateLimits/read", {}, 45000, { silentError: true }),
    rpc("configRequirements/read", undefined, 45000, { silentError: true }),
    rpc(
      "permissionProfile/list",
      { cwd: state.projectPath || undefined },
      45000,
      { silentError: true },
    ),
  ]);
  if (generation !== configGeneration || requestScope !== scope()) return;
  const config = results[0];
  const models = results[1];
  const account = results[2];
  const limits = results[3];
  state.requirements =
    results[4].status === "fulfilled" ? results[4].value.requirements : null;
  state.nativePermissionProfiles =
    results[5].status === "fulfilled" ? results[5].value.data || [] : [];
  if (config.status === "fulfilled") {
    state.config = config.value;
    const settings = config.value.config;
    if (!state.model && settings.model) state.model = settings.model;
    if (settings.model_reasoning_effort)
      state.effort = settings.model_reasoning_effort;
  }
  if (!state.activeThread) {
    state.permission = state.preferences.defaultPermission || "workspace-write";
    state.activePermissionProfileId = "";
    const profile = availablePermissionProfiles(
      state.preferences.permissionProfiles,
    ).find(
      (profile) => profile.id === state.preferences.activePermissionProfileId,
    );
    if (profile) {
      try {
        const resolved = resolvePermissionProfile(profile, {
          cwd: state.projectPath,
          requirements: state.requirements,
        });
        state.activePermissionProfileId = profile.id;
        state.permission = resolved.sandbox;
      } catch {
        state.activePermissionProfileId = "";
      }
    }
  }
  if (models.status === "fulfilled") {
    state.models = models.value.data;
    if (!state.model)
      state.model =
        (state.models.find((model) => model.isDefault) ?? state.models[0])
          ?.model ?? "";
    if (
      !state.models.some((model) => model.model === state.model) &&
      state.model
    )
      state.models.unshift({
        id: state.model,
        model: state.model,
        displayName: `${state.model} · 当前配置`,
        supportedReasoningEfforts: [],
      });
  }
  if (account.status === "fulfilled") state.account = account.value.account;
  if (limits.status === "fulfilled") state.rateLimits = limits.value;
}
async function saveConfig(edits: any[]) {
  await rpc("config/batchWrite", { edits });
  await readConfig();
  toast("已保存到 Codex 配置");
}
async function loadIntegrations() {
  const generation = ++integrationGeneration;
  const requestScope = scope();
  const results = await Promise.allSettled([
    rpc("skills/list", { cwds: [state.projectPath] }, 45000, {
      silentError: true,
    }),
    rpc("app/list", { limit: 100 }, 45000, { silentError: true }),
    rpc(
      "mcpServerStatus/list",
      { limit: 100, detail: "toolsAndAuthOnly" },
      45000,
      { silentError: true },
    ),
  ]);
  if (generation !== integrationGeneration || requestScope !== scope()) return;
  state.integrationErrors = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            source: ["skills", "apps", "mcp"][index],
            message: result.reason?.message ?? String(result.reason),
          },
        ]
      : [],
  );
  if (results[0].status === "fulfilled")
    state.skills = results[0].value.data.flatMap(
      (entry: any) => entry.skills ?? [],
    );
  if (results[1].status === "fulfilled") state.apps = results[1].value.data;
  if (results[2].status === "fulfilled")
    state.mcpServers = results[2].value.data;
}

let preferencesQueue: Promise<unknown> = Promise.resolve();
let preferencesRevision = 0;
function updatePreferences(patch: Partial<typeof state.preferences>) {
  const revision = ++preferencesRevision;
  const before = structuredClone(JSON.parse(JSON.stringify(state.preferences)));
  state.preferences = {
    ...state.preferences,
    ...patch,
    collapsed: { ...state.preferences.collapsed, ...patch.collapsed },
  };
  const update = preferencesQueue.then(async () => {
    try {
      const result = await http("/preferences", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (result.preferences && revision === preferencesRevision)
        state.preferences = { ...state.preferences, ...result.preferences };
      return result.preferences;
    } catch (error) {
      if (revision === preferencesRevision) state.preferences = before;
      throw error;
    }
  });
  preferencesQueue = update.catch(() => {});
  return update;
}
async function pin(
  kind: Pin["kind"],
  id: string,
  label?: string,
  hostId = state.hostId,
) {
  await updatePreferences({
    pins: togglePin(state.preferences.pins, {
      kind,
      id,
      hostId,
      label,
    }),
  });
}
function setCollapsed(key: string, collapsed: boolean) {
  return updatePreferences({ collapsed: { [key]: collapsed } });
}
function projectRoots(cwd = state.projectPath, hostId = state.hostId) {
  const project = state.projects.find(
    (project) =>
      (project.hostId || "local") === hostId &&
      [project.path, ...(project.rootPaths || [])].includes(cwd),
  );
  return [
    ...new Set(project ? [project.path, ...(project.rootPaths || [])] : [cwd]),
  ];
}
async function selectPermissionProfile(id: string) {
  const profile = availablePermissionProfiles(
    state.preferences.permissionProfiles,
  ).find((profile) => profile.id === id);
  if (!profile) throw fail(new Error("权限配置不存在"));
  const result = resolvePermissionProfile(profile, {
    cwd: state.projectPath,
    requirements: state.requirements,
  });
  state.permission = result.sandbox;
  state.activePermissionProfileId = id;
  state.runtimePolicy = null;
  if (state.activeThread) permissionSelections.set(recencyKey(state.hostId, state.activeThread.id), { mode: state.permission, profileId: id });
  await updatePreferences({ activePermissionProfileId: id });
}
function setPermission(mode: string) {
  try {
    resolvePermissionProfile(
      {
        id: "base",
        name: "基础权限",
        sandboxMode: mode as any,
        approvalPolicy: approvalPolicy(mode),
        networkAccess: mode === "danger-full-access",
      },
      { cwd: state.projectPath, requirements: state.requirements },
    );
  } catch (error) {
    throw fail(error);
  }
  state.permission = mode;
  state.activePermissionProfileId = "";
  state.runtimePolicy = null;
  if (state.activeThread) permissionSelections.set(recencyKey(state.hostId, state.activeThread.id), { mode, profileId: "" });
  if (state.preferences.activePermissionProfileId)
    return updatePreferences({ activePermissionProfileId: "" });
}
async function selectDefaultPermission(mode: string) {
  try {
    resolvePermissionProfile({ id: 'global', name: '全局默认权限', sandboxMode: mode as any, approvalPolicy: approvalPolicy(mode), networkAccess: mode === 'danger-full-access' }, { cwd: state.projectPath, requirements: state.requirements });
    await updatePreferences({ defaultPermission: mode, activePermissionProfileId: "" });
    permissionSelections.clear();
    applyPermissionDefault();
  } catch (error) { throw fail(error); }
}
async function queryThreads(
  search = "",
  archived = false,
  cursor: string | null = null,
  hostId = state.hostId,
) {
  let result;
  if (search.trim()) {
    try {
      result = await threadPage(hostId, "thread/search", {
        searchTerm: search.trim(),
        archived,
        cursor,
        limit: 60,
      });
    } catch {
      result = await threadPage(hostId, "thread/list", {
        searchTerm: search.trim(),
        archived,
        cursor,
        limit: 60,
        modelProviders: [],
      });
    }
  } else
    result = await threadPage(hostId, "thread/list", {
      archived,
      cursor,
      limit: 60,
      modelProviders: [],
    });
  return result;
}
async function queryNavigationThreads(
  search = "",
  archived = false,
  cursors?: Record<string, string>,
) {
  const nextCursors: Record<string, string> = {};
  const data: any[] = [];
  const hosts = state.hosts
    .filter((host) => !cursors || cursors[host.id])
    .map((host) => ({
      ...host,
      revision: navigationRevisions.get(host.id) ?? 0,
    }));
  const outcomes = await Promise.allSettled(
    hosts.map(async (host) => {
      const result = await queryThreads(
        search,
        archived,
        cursors?.[host.id] ?? null,
        host.id,
      );
      if (
        !state.hosts.some((item) => item.id === host.id) ||
        host.revision !== (navigationRevisions.get(host.id) ?? 0)
      )
        return;
      data.push(
        ...result.data.map((thread: any) => ({ ...thread, hostId: host.id })),
      );
      if (result.nextCursor) nextCursors[host.id] = result.nextCursor;
      hostNavigation(host.id).error = "";
    }),
  );
  outcomes.forEach((result, index) => {
    if (result.status === "rejected") {
      const host = hosts[index];
      if (
        host &&
        state.hosts.some((item) => item.id === host.id) &&
        host.revision === (navigationRevisions.get(host.id) ?? 0)
      )
        hostNavigation(host.id).error = result.reason.message;
    }
  });
  return { data, nextCursors };
}
async function unarchiveThread(id: string, hostId = state.hostId) {
  const result = await scopedRpc(hostId, "thread/unarchive", { threadId: id });
  if (hostId === state.hostId) {
    removedThreads.delete(id);
    if (result.thread) updateThread(result.thread);
    await refreshThreads();
  } else {
    navigationRevisions.set(hostId, (navigationRevisions.get(hostId) ?? 0) + 1);
    if (result.thread) mergeNavigation(hostId, [result.thread]);
  }
  toast("对话已恢复");
}
async function exportThread(
  id: string,
  format: "markdown" | "json" = "markdown",
  hostId = state.hostId,
) {
  const metadata = await scopedRpc(hostId, "thread/read", {
    threadId: id,
    includeTurns: false,
  });
  const pages: any[][] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let count = 0;
  do {
    const page = await history(id, cursor, hostId);
    count += page.data.length;
    if (count > 5000) throw new Error("对话过长，请通过终端导出原始 rollout");
    pages.unshift([...page.data].reverse());
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor))
      throw new Error("历史分页游标重复，导出已取消");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const turns = pages.flat();
  const content =
    format === "json"
      ? JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            hostId,
            thread: metadata.thread,
            turns,
          },
          null,
          2,
        )
      : exportThreadMarkdown(metadata.thread, turns);
  const blob = new Blob([content], {
    type:
      format === "json" ? "application/json" : "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(metadata.thread.name || id).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100)}.${format === "json" ? "json" : "md"}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useCodex() {
  return {
    state,
    initialize,
    resumeConnection,
    login,
    logout,
    setOnline,
    rpc,
    refreshThreads,
    loadMoreThreads,
    loadProjectThreads,
    selectThread,
    loadOlderTurns,
    newThread,
    send,
    canEditMessage,
    resendEditedMessage,
    cancelMessageEdit,
    interrupt,
    fork,
    compact,
    setAutoCompact,
    renameThread,
    archiveThread,
    setProject,
    addProject,
    browseDirectory,
    chooseNewContext,
    updateProject,
    removeProject,
    archiveProject,
    setHost,
    addHost,
    testHost,
    uploadSshKey,
    removeSshKey,
    updateHost,
    removeHost,
    uploadFiles,
    removeAttachment,
    searchFiles,
    readDirectory,
    readFile,
    downloadFile,
    writeFile,
    http,
    requestHttp: http,
    updatePreferences,
    pin,
    setCollapsed,
    queryThreads,
    queryNavigationThreads,
    navigationThreads,
    navigationMore,
    navigationProjectPage,
    loadNavigationProject,
    loadMoreNavigation,
    refreshNavigation,
    refreshHostNavigation,
    retryNavigationHost,
    unarchiveThread,
    exportThread,
    projectRoots,
    selectPermissionProfile,
    setPermission,
    selectDefaultPermission,
    runTerminal,
    startTerminal,
    switchTmuxTerminal,
    resizeTerminal,
    subscribeTerminal,
    attachTerminal,
    writeTerminal,
    stopTerminal,
    respond,
    readConfig,
    saveConfig,
    loadIntegrations,
    toast,
  };
}
