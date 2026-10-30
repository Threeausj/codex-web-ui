import { methodAccepts } from "./integration-capabilities";
import { officeMime } from './file-preview';
import { copyText } from './copy-text';
import { useHostSettings } from './host-settings';
import { usePromptPresets } from './prompt-presets';
import { interactiveShellCommand } from '../../shared/terminal-shell';
import { orderHosts } from '../../shared/host-order';
import { orderProjects, projectOrderKey, type ProjectOrderEntry } from '../../shared/project-order';
import { isProjectlessThread, PROJECTLESS_THREAD_SOURCE } from '../../shared/project-context';
import { waitForCompaction } from './compaction-send';
import { modelServiceTiers, serviceTierParams, serviceTierScope } from "./service-tiers";
import { reactive, ref, shallowReactive, toRaw, watch } from "vue";
import { randomUUID } from "./uuid";
import { browserStorage } from "./browser-storage";
import { projectBindingKey, retainProjectBindings } from './project-membership';
import { matchesThreadTitle, searchableThreadTitle, ThreadTitlePageCache, threadTitleQueryKey } from "./thread-title-search";
import { formatConversationQuote, normalizeConversationSelection, type ConversationSelectionSource } from "./conversation-selection";
import { nativeCollaborationMode, goalMethodSupported, skillInventory, skillMention } from "./conversation-modes";
import type { ThreadGoal } from "../../shared/protocol/v2/ThreadGoal";
import type { ReviewTarget } from "../../shared/protocol/v2/ReviewTarget";
import { subagentStatus } from "./subagents";
import { mergeContextUsage } from "./context-usage";
import { editableMessage, editedMessageInput, type MessageEditAttachment } from "./message-edit";
import { mergeAcceptedTurnItems, mergeTurnSnapshot, settleInterruptedTurnItems, writerConflict } from "./thread-sync";
import { interruptConflictCandidate } from './turn-interrupt';
import { steerWithConfirmedTurn } from './turn-steer';
import { explicitWebPermissionSelection, resolveResumePermissionOverrides, restoreRuntimePermissionPolicy } from './resume-permissions';
import { ConversationCache, ConversationMemoryCache, conversationSessionScope, type ConversationSnapshot } from "./conversation-cache";
import { revokeDevicePush } from "./pwa";
import { useMessageQueue } from "./message-queue";
import { clearConversationMarkdownCache } from "./conversation-markdown";
import { privateState } from "./private-state";
import { AttachmentDraftStore, attachmentDraftIdentity, type DraftAttachment } from './attachment-drafts';
import { LazyHistoryReader, mergeHistoryDetails, retainHistoryDetails } from './lazy-history';
import { boundConversationOutputs, COMMAND_OUTPUT_WINDOW, retainConversationHistory } from './conversation-retention';
import { isInteractiveServerRequest } from '../../shared/server-requests';
import { asyncUserInputQuestions } from '../../shared/async-user-input';
import { asyncQuestionAnswered, asyncQuestionAnswerDisplayText, asyncQuestionFingerprint, asyncQuestionReplyText } from '../../shared/async-question-reply';
import type { AsyncQuestionNotice } from '../../shared/async-question-notices';
import { AsyncQuestionCheckQueue, useAsyncQuestionNoticeDismissals } from './async-question-notices';
import type { ConversationBookmarkSource } from '../../shared/bookmarks';
import { mergeBookmarkMessages, retainBookmarkTargets } from './conversation-bookmarks';
import {
  availablePermissionProfiles,
  resolvePermissionProfile,
  resolveWebPermissionSelection,
} from "./configuration";
import {
  exportThreadMarkdown,
  matchesProject,
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

type Method = ClientRequest["method"] | "bridge/ping";
type Params<M extends Method> = M extends "bridge/ping" ? { includeState?: boolean } : Extract<ClientRequest, { method: M }>["params"];
type Pending = {
  method: Method;
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
  projectPages: Record<string, ProjectThreadPage>;
};
type ProjectThreadPage = { cursor: string | null; loaded: boolean; nativeCursor?: string | null; legacyCursor?: string | null; nativeProjectId?: string };
type AsyncQuestionStatus = 'pending' | 'sending' | 'answered' | 'uncertain';
type AsyncQuestionRecord = { hostId: string; threadId: string; item: DisplayItem };
type AsyncQuestionOperation = { fingerprint: string; status: AsyncQuestionStatus; receiptReadFailed?: boolean };
const saved = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(browserStorage.local.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const state = reactive({
  authenticated: false,
  authenticationGeneration: 0,
  online: navigator.onLine !== false,
  authRequired: true,
  loading: true,
  error: "",
  threadConflict: null as { hostId: string; threadId: string; generation: number; message: string } | null,
  takingOverThread: false,
  connected: false,
  connectionMode: "spawn",
  hosts: [] as any[],
  localEnabled: true,
  navigation: {} as Record<string, HostNavigation>,
  hostId: "local",
  projects: [] as any[],
  preferences: {
    pins: [] as Pin[],
    collapsed: {} as Record<string, boolean>,
    permissionProfiles: [] as any[],
    activePermissionProfileId: "",
    defaultPermission: "workspace-write",
    defaultPermissionExplicit: undefined as boolean | undefined,
  },
  activePermissionProfileId: "",
  requirements: null as any,
  nativePermissionProfiles: [] as any[],
  projectPath: "",
  noProject: false,
  projectThreadPages: {} as Record<string, ProjectThreadPage>,
  threads: [] as any[],
  activeThread: null as any,
  selectingThread: false,
  threadReady: true,
  runtimePaused: false,
  threadReleased: false,
  switchingHost: false,
  runtimePolicy: null as { sandboxPolicy: any; approvalPolicy: any; source?: 'native' | 'web' } | null,
  items: [] as DisplayItem[],
  turns: [] as any[],
  moreTurns: false,
  moreThreads: false,
  models: [] as any[],
  model: "",
  effort: "medium",
  permission: "workspace-write",
  permissionChangePending: false,
  tokenUsage: null as any,
  compacting: false,
  busy: false,
  pendingRequests: [] as any[],
  asyncQuestions: {} as Record<string, AsyncQuestionRecord>,
  asyncQuestionOperations: {} as Record<string, AsyncQuestionOperation>,
  agentActivity: {} as Record<string, { text?: string; status?: string; startedAt?: number; updatedAt?: number; turnId?: string; turnStatus?: string }>,
  attachments: [] as any[],
  attachmentsLoading: false,
  attachmentDraftWarning: '',
  config: null as any,
  runtimeInformation: {} as Record<string, any>,
  runtimeReconnectingHostId: '',
  skills: [] as any[],
  skillsLoading: false,
  skillsError: "",
  selectedSkills: [] as any[],
  collaborationMode: "default" as "default" | "plan",
  goalMode: false,
  goal: null as ThreadGoal | null,
  goalTokenBudget: null as number | null,
  modeCapabilities: { plan: false, goal: false, loaded: false },
  modeBusy: false,
  modelSettingsBusy: false,
  modelSettingsNotice: "",
  modeError: "",
  goalReadError: "",
  apps: [] as any[],
  mcpServers: [] as any[],
  account: null as any,
  rateLimits: null as any,
  serviceTier: undefined as string | null | undefined,
  serviceTierScope: "",
  nativeServiceTier: null as string | null,
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
type HostConnection = {
  hostId: string; authentication: number; socket: WebSocket;
  ready: Promise<void>; status: any | null; usedAt: number;
  engineId: string | null; sequence: number | null; gap: boolean;
};
// Keep a bounded set of visited hosts connected. Inactive output is never
// buffered: returning to a host refreshes its writer/history after an event gap.
const hostConnections = new Map<string, HostConnection>();
const MAX_HOST_CONNECTIONS = 8;
function retireHostConnection(hostId: string) {
  const connection = hostConnections.get(hostId);
  if (!connection) return;
  hostConnections.delete(hostId);
  connection.socket.close();
}
function retireHostConnections() {
  for (const hostId of [...hostConnections.keys()]) retireHostConnection(hostId);
}
function pruneHostConnections() {
  for (const hostId of [...hostConnections.keys()])
    if (!state.hosts.some(host => host.id === hostId)) retireHostConnection(hostId);
}

let csrfToken = "";
let authenticationGeneration = 0;
function advanceAuthentication() {
  resetAttachmentDrafts();
  state.authenticationGeneration = ++authenticationGeneration;
  retireHostConnections();
  hostAvailabilityRequest = null;
  settingsApi.resetHostSettings();
  nativeProjectBindingTimes.clear();
  nativeProjectBindingValues.clear();
  nativeProjectBindingRequests.clear();
  threadProjectChanges.clear();
}
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
let replayedConnection: { socket: WebSocket; engineId: string } | null = null;
let disconnectedWithMutation = false;
let selectionOperation: { hostId: string; threadId: string; generation: number; socket: WebSocket | null; authentication: number; promise: Promise<void> } | null = null;
let engineId: string | null = null;
let eventSequence: number | null = null;
let socketHasEventGap = false;
let eventGapRevision = 0;
let writerAttachment: { hostId: string; threadId: string; engineId: string | null } | null = null;
let listGeneration = 0;
let configGeneration = 0;
let configurationRequest: { scope: string; socket: WebSocket | null; promise: Promise<void> } | null = null;
let verifiedConfiguration: { scope: string; socket: WebSocket | null } | null = null;
let integrationGeneration = 0;
let skillsGeneration = 0;
let skillsRequest: { scope: string; promise: Promise<any> } | null = null;
let skillsLoadedScope = "";
let capabilityGeneration = 0;
let capabilityRequest: { hostId: string; promise: Promise<void> } | null = null;
let capabilityRetryTimer: ReturnType<typeof setTimeout> | undefined;
let capabilityRetryAttempts = 0;
let modeOperation = 0;
const goals = new Map<string, ThreadGoal | null>();
const goalRevisions = new Map<string, number>();
const conversationModes = new Map<string, 'default' | 'plan' | 'goal'>();
let threadListScope = "";
let loadedMorePages = false;
let loadedGlobalPages = false;
let threadEventSequence = 0;
let itemEventSequence = 0;
let sendInFlight = false;
let interruptOperation: { scope: string; socket: WebSocket | null; promise: Promise<void> } | null = null;
let localCwd = "/tmp";
let clientId = browserStorage.session.getItem("codex.clientId") ?? randomUUID();
browserStorage.session.setItem("codex.clientId", clientId);
const pending = new Map<string | number, Pending>();
const attachmentOriginals = new WeakMap<object, File>();
const terminalSessionNames = new Map<string, string>();
let terminalSelectionGeneration = 0;
const itemCache = new ConversationMemoryCache(() => [
  ...(state.activeThread?.id ? [state.activeThread.id] : []),
  ...activeTurns.keys(), ...[...threadBusy].filter(([, busy]) => busy).map(([id]) => id),
]);
const conversationCache = new ConversationCache();
let historyWindowTruncated = false;
let historyRestoration: { threadId: string; generation: number; promise: Promise<void> } | null = null;
const tokenUsages = new Map<string, any>();
const tokenUsageRevisions = new Map<string, number>();
const compactionRevisions = new Map<string, number>();
// A deferred send can precede turn/started. Its watcher must observe the later
// dedicated turn binding before item/completed removes this record.
const compactions = shallowReactive(new Map<string, { turnId?: string; itemId?: string; requested?: boolean; acknowledged?: boolean; requestId?: string }>());
const compactionResults = new Map<string, boolean>();
const pausedHosts = new Set<string>();
const releasedThreads = new Map<string, Set<string>>();
function updateReleasedThreads(hostId: string, ids: string[]) {
  releasedThreads.set(hostId, new Set(ids));
  if (hostId !== state.hostId) return;
  const released = !!state.activeThread?.id && ids.includes(state.activeThread.id);
  if (released && !state.threadReleased) {
    cancelGoalRefresh();
    if (writerAttachment?.hostId === hostId && writerAttachment.threadId === state.activeThread?.id) writerAttachment = null;
    saveConversationSnapshot(); ++selectionGeneration; state.selectingThread = false;
    state.threadReady = false; state.busy = false; state.threadConflict = null;
    state.pendingRequests = state.pendingRequests.filter(request => request.params?.threadId !== state.activeThread?.id);
  }
  state.threadReleased = released;
}
async function resumeThreadConnection(hostId: string, threadId: string) {
  const authentication = authenticationGeneration;
  await http(`/hosts/${encodeURIComponent(hostId)}/runtime/threads/${encodeURIComponent(threadId)}/resume`, { method: "POST", body: "{}" });
  if (authentication !== authenticationGeneration) return;
  const ids = [...(releasedThreads.get(hostId) || [])].filter(id => id !== threadId);
  updateReleasedThreads(hostId, ids);
  if (state.hostId === hostId && state.activeThread?.id === threadId) await selectThread(threadId);
}
let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
let cacheActivation: Promise<void> = Promise.resolve();
const activeTurns = new Map<string, string>();
const turnRevisions = new Map<string, number>();
const threadBusy = new Map<string, boolean>();
const itemRevisions = new Map<string, Map<string, number>>();
const historyReader = new LazyHistoryReader();
const historyDetailRequests = new Map<string, Promise<void>>();
const retainedHistoryTurns = new Map<string, Set<string>>();
const retentionProbes = new Map<string, number>();
const threadRevisions = new Map<string, number>();
// Both an explicit name and a confirmed preview can change the displayed title.
const threadNameRevisions = new Map<string, number>();
const removedThreads = new Set<string>();
const deletedThreads = new Set<string>();
const compactedSinceInput = new Set<string>();
const permissionSelections = new Map<string, { mode: string; profileId: string }>();
const localReverts = new Set<string>();
const discardedTurns = new Set<string>();
const completedTurns = new Set<string>();
const seenThreadChanges = new Set<string>();
const revertedTurnCandidates = new Map<string, { ids: Set<string>; awaitingAcknowledgement: boolean }>();
let takeoverOperation = 0;
let pendingMessageEdit: { hostId: string; threadId: string; item: DisplayItem; reverted: boolean; blocked: boolean; needsHistory?: boolean; prefixLastTurnId?: string | null } | null = null;
const terminalListeners = new Set<(chunk: string) => void>();
const protocolListeners = new Set<(hostId: string, message: any) => boolean | void>();
let hostOrderRevision = 0;
let projectOrderRevision = 0;
let latestProjectOrder: ProjectOrderEntry[] = [];
function validProjectOrder(value: unknown): value is ProjectOrderEntry[] {
  return Array.isArray(value) && value.length <= 2000 && value.every(entry => entry &&
    typeof entry.hostId === 'string' && entry.hostId.length > 0 && entry.hostId.length <= 256 &&
    typeof entry.path === 'string' && entry.path.startsWith('/') && entry.path.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(entry.hostId + entry.path)) &&
    new Set(value.map(projectOrderKey)).size === value.length;
}
function receiveProjectOrder(projects: unknown) {
  if (!state.authenticated || !validProjectOrder(projects)) return;
  ++projectOrderRevision;
  latestProjectOrder = projects.map(({ hostId, path }) => ({ hostId, path }));
  // Shared order events may reorder known records, never inject new projects.
  state.projects = orderProjects(state.projects, latestProjectOrder);
}
function validHostOrder(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1000 && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x20\x7f]/.test(id))
    && new Set(value).size === value.length;
}
function receiveHostOrder(hostIds: unknown) {
  if (!state.authenticated || !validHostOrder(hostIds)) return;
  ++hostOrderRevision;
  // Only the order is trusted: an event cannot create or replace a connection.
  state.hosts = orderHosts(state.hosts, hostIds);
}
function subscribeProtocol(listener: (hostId: string, message: any) => boolean | void) {
  protocolListeners.add(listener);
  return () => protocolListeners.delete(listener);
}
function notifyProtocol(message: any, hostId = state.hostId) {
  let consumed = false;
  for (const listener of protocolListeners) {
    try { consumed = listener(hostId, message) === true || consumed; }
    catch { /* One view must not interrupt the shared protocol transport. */ }
  }
  return consumed;
}
/** Auxiliary conversations share this socket without changing its selected thread. */
function sideChatRpc(hostId: string, method: Method, params: any) {
  if (!state.authenticated || state.hostId !== hostId)
    return Promise.reject(new Error("对话所在的主机或登录状态已变化，请重新选择文本"));
  return rpc(method, params, 45000, { silentError: true });
}
function runtimeIdentity() { return { authenticationGeneration, engineId }; }
let metadataReconnectChoices: { authentication: number; hostId: string; hostGeneration: number; threadId: string | null; observedEngine?: string } | null = null;
function preserveMetadataChoices() {
  const selection = metadataReconnectChoices;
  return !!selection && selection.authentication === authenticationGeneration && selection.hostId === state.hostId &&
    selection.hostGeneration === hostSelectionGeneration && selection.threadId === (state.activeThread?.id || null);
}
const settingsApi = useHostSettings(state, http, runtimeIdentity, hostId => {
  if (hostId !== state.hostId) return;
  ++configGeneration;
  verifiedConfiguration = null;
  configurationRequest = null;
  invalidateRuntimeCapabilities();
});
const promptPresets = usePromptPresets((path, options) => http(path, options, false),
  () => state.authenticated ? authenticationGeneration : null);
watch(() => [state.authenticated, state.authenticationGeneration], () => promptPresets.reset(), { flush: 'sync' });
async function refreshCurrentRuntimeMetadata() {
  const authentication = authenticationGeneration, hostId = state.hostId, selectedEngine = engineId;
  const hostGeneration = hostSelectionGeneration;
  const choices = metadataReconnectChoices;
  const current = () => authentication === authenticationGeneration && state.authenticated && hostId === state.hostId &&
    hostGeneration === hostSelectionGeneration && selectedEngine === engineId && state.connected && !state.runtimePaused;
  if (!state.authenticated || !state.connected || state.runtimePaused) return;
  try {
    // A focus/probe recovery can run alongside this metadata refresh. Protect
    // acknowledged composer choices through its sync/readConfig and resume.
    await resumeConnection();
    if (!current()) return;
    const information = await settingsApi.refreshRuntimeInformation(hostId);
    if (!current() || information.runtime?.engineId !== selectedEngine) return;
    await readConfig(true, true);
    if (!current()) return;
    if (Array.isArray(information.models)) state.models = information.models.filter((entry: any) => !entry.hidden);
  } catch { /* A later reconnect/read retries metadata; never replay mutations. */ }
  finally {
    if (choices?.observedEngine === selectedEngine && metadataReconnectChoices === choices)
      metadataReconnectChoices = null;
  }
}
async function reconnectRuntime(hostId = state.hostId, restartDaemon = false) {
  if (!hostId || !state.hosts.some(host => host.id === hostId)) throw new Error('请先添加或启用一个执行主机');
  if (state.runtimeReconnectingHostId) throw new Error('正在重新连接主机，请稍候');
  const authentication = authenticationGeneration;
  const selectedHostGeneration = hostSelectionGeneration;
  const choices = hostId === state.hostId ? { authentication, hostId, hostGeneration: selectedHostGeneration, threadId: state.activeThread?.id || null } : null;
  if (choices) metadataReconnectChoices = choices;
  const authenticated = () => authentication === authenticationGeneration && state.authenticated;
  const currentHost = () => authenticated() && hostId === state.hostId && selectedHostGeneration === hostSelectionGeneration;
  const assertAuthenticated = () => { if (!authenticated()) throw new Error('登录状态已变化，请重新核对主机连接'); };
  state.runtimeReconnectingHostId = hostId;
  settingsApi.invalidateHostSettings(hostId);
  if (currentHost()) { ++configGeneration; verifiedConfiguration = null; configurationRequest = null; }
  try {
    const response = await http(`/hosts/${encodeURIComponent(hostId)}/runtime/${restartDaemon ? 'daemon/restart' : 'reconnect'}`, { method: 'POST', body: restartDaemon ? '{"confirmed":true}' : '{}' }, false);
    assertAuthenticated();
    const reconnectedEngine = response.runtime?.engineId;
    const information = await settingsApi.refreshRuntimeInformation(hostId);
    assertAuthenticated();
    if (!information.runtime?.connected || information.runtime?.paused || !reconnectedEngine || information.runtime.engineId !== reconnectedEngine)
      throw new Error('Codex 连接已变化或未恢复，请重新读取运行信息');
    if (currentHost()) {
      verifiedConfiguration = null;
      configurationRequest = null;
      invalidateRuntimeCapabilities();
      // Re-handshake notifications retain all browser drafts and synchronise
      // the selected writer. Wait for the new transport before reading config.
      await resumeConnection();
      assertAuthenticated();
      if (currentHost()) {
        if (!state.connected || state.runtimePaused || engineId !== reconnectedEngine ||
          state.activeThread && !state.threadReleased && !state.threadReady)
          throw new Error(state.threadConflict?.message || state.error || '主机已重启，但当前对话尚未恢复，请同步对话后重试');
        await readConfig(true, true);
        assertAuthenticated();
        if (!currentHost()) return information;
        if (!state.connected || state.runtimePaused || engineId !== reconnectedEngine)
          throw new Error('Codex 连接已变化，请重新读取运行信息');
        if (Array.isArray(information.models)) state.models = information.models.filter((entry: any) => !entry.hidden);
        await Promise.allSettled([loadModeCapabilities(), loadSkills({ forceReload: true })]);
        assertAuthenticated();
        if (!currentHost()) return information;
        if (!state.connected || state.runtimePaused || engineId !== reconnectedEngine)
          throw new Error('Codex 连接已变化，请重新读取运行信息');
        if (state.activeThread?.id) await refreshContextUsage(hostId, state.activeThread.id);
        assertAuthenticated();
        if (currentHost() && (!state.connected || state.runtimePaused || engineId !== reconnectedEngine))
          throw new Error('Codex 连接已变化，请重新读取运行信息');
      }
    }
    return information;
  } catch (error) {
    // Refresh read-only availability after a rejected or uncertain restart.
    // The user's explicit retry remains the only source of another POST.
    if (authenticated()) await settingsApi.refreshRuntimeInformation(hostId).catch(() => {});
    throw error;
  } finally {
    if (metadataReconnectChoices === choices) metadataReconnectChoices = null;
    if (authentication === authenticationGeneration && state.runtimeReconnectingHostId === hostId) state.runtimeReconnectingHostId = '';
  }
}
const terminalDecoders = new Map<string, TextDecoder>();
const completedTerminalProcesses = new Set<string>();
const recencySortSupport = new Map<string, boolean>();
const legacyRecency = new Map<
  string,
  { stamp: number | undefined; value: number; pending?: Promise<number> }
>();
const recencyKey = (hostId: string, threadId: string) =>
  JSON.stringify([hostId, threadId]);
const asyncQuestionKey = (hostId: string, threadId: string, itemId: string) => JSON.stringify([hostId, threadId, itemId]);
const asyncQuestionReceiptReads = new Map<string, Promise<void>>();
const asyncQuestionChecks = new AsyncQuestionCheckQueue();
const asyncQuestionNotices = useAsyncQuestionNoticeDismissals({ requestHttp: http, runtimeIdentity });
function questionNotice(record: AsyncQuestionRecord): AsyncQuestionNotice | null {
  const fingerprint = asyncQuestionFingerprint(record.item);
  const turnId = record.item.turnId || (record.hostId === state.hostId && record.threadId === state.activeThread?.id
    ? state.turns.find(turn => turn.items?.some((item: DisplayItem) => item.id === record.item.id))?.id : undefined);
  return fingerprint && turnId ? { hostId: record.hostId, threadId: record.threadId,
    turnId, itemId: record.item.id, fingerprint } : null;
}
function clearAsyncQuestionReads(key: string) {
  for (const readKey of asyncQuestionReceiptReads.keys()) if (JSON.parse(readKey)[0] === key) asyncQuestionReceiptReads.delete(readKey);
}
function checkAsyncQuestionAnswers(threadId: string) {
  const hostId = state.hostId, authentication = authenticationGeneration, generation = selectionGeneration;
  const current = () => authentication === authenticationGeneration && generation === selectionGeneration &&
    state.authenticated && state.hostId === hostId && state.activeThread?.id === threadId &&
    state.connected && state.threadReady && !state.selectingThread;
  if (!current()) return;
  for (const record of Object.values(state.asyncQuestions)) {
    if (record.hostId !== hostId || record.threadId !== threadId || !record.item.turnId) continue;
    const status = asyncQuestionStatus(record.item, threadId, hostId);
    if (status === 'answered' || status === 'sending') continue;
    const key = asyncQuestionKey(hostId, threadId, record.item.id);
    const fingerprint = asyncQuestionFingerprint(record.item)!;
    const checkKey = JSON.stringify([authentication, key, fingerprint]);
    void asyncQuestionChecks.check(checkKey, async () => {
      if (!current() || asyncQuestionFingerprint(state.asyncQuestions[key]?.item) !== fingerprint ||
          ['answered', 'sending'].includes(asyncQuestionStatus(record.item, threadId, hostId))) return false;
      try {
        const result = await http(`/threads/${encodeURIComponent(hostId)}/${encodeURIComponent(threadId)}/async-questions/${encodeURIComponent(record.item.id)}/status?turnId=${encodeURIComponent(record.item.turnId!)}`, { signal: AbortSignal.timeout(45000) }, false);
        if (current() && result.answered === true && asyncQuestionFingerprint(state.asyncQuestions[key]?.item) === fingerprint) {
          state.asyncQuestionOperations[key] = { fingerprint, status: 'answered' };
          void privateState.remove('async-question-answer', key).catch(() => {});
        }
        return current();
      } catch (error: any) {
        // A known historical limit/missing item does not change on every delta.
        // Cool it down while leaving network failures retryable on reconnect.
        return current() && error?.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429;
      }
    });
  }
}
function questionItems(threadId: string, hostId: string) {
  return hostId === state.hostId ? (state.activeThread?.id === threadId ? state.items : itemCache.get(threadId) || []) : [];
}
function asyncQuestionStatus(item: DisplayItem, threadId = state.activeThread?.id, hostId = state.hostId): AsyncQuestionStatus {
  const fingerprint = asyncQuestionFingerprint(item);
  if (!threadId || !fingerprint) return 'answered';
  if (asyncQuestionAnswered(item, questionItems(threadId, hostId))) return 'answered';
  const operation = state.asyncQuestionOperations[asyncQuestionKey(hostId, threadId, item.id)];
  return operation?.fingerprint === fingerprint ? operation.status : 'pending';
}
function restoreAsyncQuestionReceipt(record: AsyncQuestionRecord) {
  const { hostId, threadId, item } = record;
  const key = asyncQuestionKey(hostId, threadId, item.id);
  const fingerprint = asyncQuestionFingerprint(item)!;
  const readKey = JSON.stringify([key, fingerprint]);
  const existing = asyncQuestionReceiptReads.get(readKey);
  if (existing) return existing;
  const authentication = authenticationGeneration;
  const operation = (async () => {
    await cacheActivation;
    if (authentication !== authenticationGeneration || !state.authenticated) return;
    const receipt = await privateState.read<{ fingerprint: string }>('async-question-answer', key);
    if (authentication !== authenticationGeneration || !state.authenticated ||
        asyncQuestionFingerprint(state.asyncQuestions[key]?.item) !== fingerprint) return;
    if (receipt?.fingerprint === fingerprint && asyncQuestionStatus(item, threadId, hostId) === 'pending')
      state.asyncQuestionOperations[key] = { fingerprint, status: 'uncertain' };
    // Storage failures happen before dispatch. Once a successful read proves
    // no receipt exists, this case can recover without weakening lost-ACK guards.
    const previous = state.asyncQuestionOperations[key];
    if (!receipt && previous?.fingerprint === fingerprint && previous.receiptReadFailed)
      state.asyncQuestionOperations[key] = { fingerprint, status: 'pending' };
    if (hostId === state.hostId) checkAsyncQuestionAnswers(threadId);
  })().catch(error => {
    if (authentication === authenticationGeneration && state.asyncQuestions[key] &&
        asyncQuestionStatus(item, threadId, hostId) === 'pending')
      state.asyncQuestionOperations[key] = { fingerprint, status: 'uncertain', receiptReadFailed: true };
    throw new Error('无法读取回答记录，请检查网站存储并同步对话后重试', { cause: error });
  });
  asyncQuestionReceiptReads.set(readKey, operation);
  void operation.catch(() => { if (asyncQuestionReceiptReads.get(readKey) === operation) asyncQuestionReceiptReads.delete(readKey); });
  return operation;
}
function rememberAsyncQuestions(threadId: string, items: DisplayItem[], hostId = state.hostId) {
  if (hostId === state.hostId && state.activeThread?.id === threadId) {
    const turns = new Set(state.turns.map(turn => turn.id));
    for (const record of Object.values(state.asyncQuestions)) if (record.hostId === hostId && record.threadId === threadId &&
        turns.has(record.item.turnId) && !items.some(item => item.id === record.item.id) &&
        asyncQuestionStatus(record.item, threadId, hostId) !== 'answered') upsertItem(items, record.item);
  }
  for (const item of items) if (asyncUserInputQuestions(item).length) {
    const key = asyncQuestionKey(hostId, threadId, item.id);
    state.asyncQuestions[key] = { hostId, threadId, item };
    void restoreAsyncQuestionReceipt(state.asyncQuestions[key]).catch(() => {});
  }
  const records = Object.entries(state.asyncQuestions);
  for (const [key, record] of records) if (record.hostId === hostId && record.threadId === threadId && asyncQuestionAnswered(record.item, items)) {
    const fingerprint = asyncQuestionFingerprint(record.item)!;
    const previous = state.asyncQuestionOperations[key];
    if (previous?.fingerprint !== fingerprint || previous.status !== 'answered') {
      state.asyncQuestionOperations[key] = { fingerprint, status: 'answered' };
      void privateState.remove('async-question-answer', key).catch(() => {});
    }
  }
  // Retain waiting forms, while bounding receipts for old completed questions.
  let excess = records.length - 256;
  for (const [key, record] of records) if (excess > 0 && asyncQuestionStatus(record.item, record.threadId, record.hostId) === 'answered') {
    clearAsyncQuestionReads(key);
    delete state.asyncQuestions[key]; delete state.asyncQuestionOperations[key]; excess--;
  }
  if (state.authenticated) void asyncQuestionNotices.refresh().catch(() => {});
  if (hostId === state.hostId) checkAsyncQuestionAnswers(threadId);
}
function pendingAsyncQuestions() {
  return Object.values(state.asyncQuestions).filter(record =>
    state.hosts.some(host => host.id === record.hostId) &&
    asyncQuestionStatus(record.item, record.threadId, record.hostId) !== 'answered');
}
function pendingAsyncQuestionNotices() {
  return pendingAsyncQuestions().filter(record => {
    const notice = questionNotice(record);
    return !notice || !asyncQuestionNotices.dismissed(notice);
  });
}
async function dismissAsyncQuestionNotices(records = pendingAsyncQuestionNotices()) {
  const notices = records.map(questionNotice);
  if (notices.some(notice => !notice)) throw new Error('无法定位此问题所属轮次，请同步对话后再关闭提醒');
  await asyncQuestionNotices.dismiss(notices as AsyncQuestionNotice[]);
}
function forgetAsyncQuestions(threadId: string, hostId = state.hostId) {
  for (const [key, record] of Object.entries(state.asyncQuestions)) if (record.hostId === hostId && record.threadId === threadId) {
    clearAsyncQuestionReads(key);
    delete state.asyncQuestions[key]; delete state.asyncQuestionOperations[key];
    void privateState.remove('async-question-answer', key).catch(() => {});
  }
}
async function answerAsyncQuestion(item: DisplayItem, answers: string[], threadId = state.activeThread?.id, hostId = state.hostId) {
  const authentication = authenticationGeneration;
  const generation = selectionGeneration;
  const current = () => authentication === authenticationGeneration && generation === selectionGeneration &&
    state.authenticated && state.hostId === hostId && state.activeThread?.id === threadId;
  const available = () => current() && state.connected && state.online && state.threadReady &&
    !state.runtimePaused && !state.threadReleased && !state.threadConflict && !state.selectingThread &&
    !state.switchingHost && !state.changingContext && !state.compacting && !state.modeBusy && !state.editingMessage;
  if (!threadId || !available() || sendInFlight) throw new Error('请等待连接和同步完成后回答此问题');
  const nativeItem = state.items.find(entry => entry.id === item.id);
  const fingerprint = asyncQuestionFingerprint(item);
  if (!nativeItem?.turnId || !fingerprint || fingerprint !== asyncQuestionFingerprint(nativeItem))
    throw new Error('问题内容已变化，请同步对话后重新选择');
  asyncQuestionReplyText(nativeItem, answers);
  const key = asyncQuestionKey(hostId, threadId, item.id);
  rememberAsyncQuestions(threadId, state.items, hostId);
  await restoreAsyncQuestionReceipt(state.asyncQuestions[key]);
  if (!available() || sendInFlight) throw new Error('对话或连接状态已变化，请同步后再回答');
  const questionCurrent = () => asyncQuestionFingerprint(state.items.find(entry => entry.id === item.id)) === fingerprint;
  if (!questionCurrent()) throw new Error('问题内容已变化，请重新选择');
  const status = asyncQuestionStatus(nativeItem, threadId, hostId);
  if (status === 'answered') return;
  if (status !== 'pending') throw Object.assign(new Error('回答可能已被接收，请同步对话确认，勿重复提交'), { uncertain: status === 'uncertain' });
  state.asyncQuestionOperations[key] = { fingerprint, status: 'sending' };
  sendInFlight = true;
  const runtimeRevision = turnRevisions.get(threadId) || 0;
  let dispatched = false;
  try {
    await privateState.write('async-question-answer', key, { fingerprint }, true);
    if (!available() || !questionCurrent()) throw new Error('对话、连接或问题内容已变化，回答未发送，请重新选择');
    dispatched = true;
    const result = await http(`/threads/${encodeURIComponent(hostId)}/${encodeURIComponent(threadId)}/async-questions/${encodeURIComponent(item.id)}/answer`, {
      method: 'POST', body: JSON.stringify({ turnId: nativeItem.turnId, answers }), signal: AbortSignal.timeout(45000),
    }, false);
    if (result.accepted !== true) throw new Error('无法确认回答是否已接收，请同步对话');
    if (authentication !== authenticationGeneration || !state.authenticated) return;
    state.asyncQuestionOperations[key] = { fingerprint, status: 'answered' };
    void privateState.remove('async-question-answer', key).catch(() => {});
    if (hostId === state.hostId && result.input && (result.turn?.id || result.turnId)) {
      const turn = result.turn || { id: result.turnId };
      hydrateTurnItems(threadId, turn, { input: result.input, clientUserMessageId: result.clientUserMessageId, placement: result.turn ? 'start' : 'steer' });
      if (result.turn) {
        updateTurn(threadId, result.turn);
        if ((turnRevisions.get(threadId) || 0) === runtimeRevision && !completedTurns.has(result.turn.id))
          noteRuntime(threadId, result.turn.status === 'inProgress', result.turn.id);
      }
      scheduleConversationSnapshot(threadId);
    }
  } catch (error: any) {
    const definite = !dispatched || (error?.status >= 400 && error?.status < 500 && error.code !== 'async_answer_uncertain') ||
      (error?.status === 502 && typeof error.code === 'number');
    if (authentication === authenticationGeneration && state.authenticated) {
      // A confirmed native message can arrive before the lost HTTP response.
      const answered = asyncQuestionStatus(nativeItem, threadId, hostId) === 'answered';
      state.asyncQuestionOperations[key] = { fingerprint, status: answered ? 'answered' : definite ? 'pending' : 'uncertain' };
      if (definite || answered) void privateState.remove('async-question-answer', key).catch(() => {});
      if (answered) return;
    }
    if (!definite) throw Object.assign(new Error('回答发送结果尚未确认，请同步对话后检查，勿重复提交'), { uncertain: true });
    throw error;
  } finally { sendInFlight = false; }
}
function activateConversationCache() {
  const authentication = authenticationGeneration;
  const credential = csrfToken;
  cacheActivation = conversationSessionScope(credential).then(scope => {
    if (authentication === authenticationGeneration && state.authenticated && csrfToken === credential) {
      conversationCache.activate(scope);
      privateState.activate(scope);
      attachmentDrafts.activate(scope);
      activateAttachmentDraft(true);
    }
  }).catch(() => {});
  return cacheActivation;
}
function clearConversationCaches() {
  resetAttachmentDrafts();
  titleSearchPages.clear();
  titleSearchSupport.clear();
  ++titleSearchRevision.value;
  clearConversationMarkdownCache();
  clearTimeout(snapshotTimer);
  itemCache.clear();
  state.asyncQuestions = {};
  state.asyncQuestionOperations = {};
  asyncQuestionReceiptReads.clear();
  asyncQuestionChecks.clear();
  asyncQuestionNotices.clear();
  historyRestoration = null;
  historyWindowTruncated = false;
  tokenUsages.clear();
  tokenUsageRevisions.clear();
  compactionRevisions.clear();
  compactions.clear();
  writerAttachment = null;
  state.items = [];
  state.turns = [];
  state.tokenUsage = null;
  state.compacting = false;
  state.activeThread = null;
  state.threadReady = true;
  state.threadConflict = null;
  state.busy = false;
  state.threads = [];
  state.navigation = {};
  state.projects = [];
  state.pendingRequests = [];
  state.agentActivity = {};
  state.diff = '';
  state.plan = [];
  activeTurns.clear();
  threadBusy.clear();
  turnRevisions.clear();
  itemRevisions.clear();
  historyReader.clear();
  historyDetailRequests.clear();
  retainedHistoryTurns.clear(); retentionProbes.clear();
  threadRevisions.clear();
  threadNameRevisions.clear();
  removedThreads.clear();
  deletedThreads.clear();
  threadListScope = '';
  loadedMorePages = false;
  loadedGlobalPages = false;
  threadCursor = null;
  turnCursor = null;
  state.moreThreads = false;
  state.moreTurns = false;
  state.projectThreadPages = {};
  ++listGeneration;
  ++configGeneration;
  ++integrationGeneration;
  for (const host of state.hosts) advanceNavigationRevision(host.id);
  navigationRequests.clear();
  void conversationCache.clear();
  void privateState.clear();
}
function saveConversationSnapshot() {
  const thread = state.activeThread;
  if (!state.authenticated || !thread?.id || !state.threadReady || state.threadConflict || revertedTurnCandidates.has(thread.id)) return;
  const historyScope = JSON.stringify([authenticationGeneration, state.hostId, engineId]);
  if (!thread.ephemeral && historyReader.canReloadItems(historyScope, thread.id)) {
    const bounded = boundConversationOutputs(state.items);
    if (bounded !== state.items) {
      state.items = bounded;
      const byId = new Map(bounded.map(item => [item.id, item]));
      state.turns = state.turns.map(turn => ({ ...turn, items: (turn.items || []).map((item: DisplayItem) => byId.get(item.id) || item) }));
    }
    const retained = retainConversationHistory(state.items, state.turns, retainedHistoryTurns.get(recencyKey(state.hostId, thread.id)));
    if (retained.evicted.size) { state.items = retained.items; state.turns = retained.turns; }
  } else if (!thread.ephemeral && (state.items.some(item => item.type === 'commandExecution' && item.aggregatedOutput?.length > COMMAND_OUTPUT_WINDOW) ||
      state.turns.length > 3 && state.items.some(item => !['userMessage', 'agentMessage', 'contextCompaction'].includes(item.type)))) {
    const key = JSON.stringify([historyScope, thread.id]);
    if (Date.now() - (retentionProbes.get(key) || 0) > 30000) {
      retentionProbes.set(key, Date.now());
      const hostId = state.hostId, threadId = thread.id, nativeEngine = engineId, authentication = authenticationGeneration;
      const turnId = state.turns.find(turn => turn.status !== 'inProgress')?.id || state.turns.at(-1)?.id;
      if (turnId) void historyReader.probeItems(historyScope,
        (method, params) => rpc(method, params, 15000, { silentError: true }), threadId, turnId).then(supported => {
        if (supported && authentication === authenticationGeneration && hostId === state.hostId && nativeEngine === engineId && threadId === state.activeThread?.id)
          scheduleConversationSnapshot(threadId);
      });
    }
  }
  itemCache.set(thread.id, state.items);
  itemCache.rememberHistory(thread.id, { turns: state.turns, cursor: turnCursor, engineId,
    eventGapRevision, historyTruncated: historyWindowTruncated });
  conversationCache.write({
    hostId: state.hostId, threadId: thread.id, thread,
    items: state.items.filter(item => item.status !== 'sending'),
    turns: state.turns.map(turn => ({ ...turn, items: [] })),
    tokenUsage: state.tokenUsage, cursor: turnCursor,
    ...(historyWindowTruncated ? { historyTruncated: true } : {}),
  });
}
function retainHistoryTurns(threadId: string | undefined, turnIds: string[], hostId = state.hostId) {
  if (!threadId) return;
  const key = recencyKey(hostId, threadId);
  if (turnIds.length) retainedHistoryTurns.set(key, new Set(turnIds)); else retainedHistoryTurns.delete(key);
  if (hostId === state.hostId && threadId === state.activeThread?.id) scheduleConversationSnapshot(threadId);
}
async function loadToolOutput(item: DisplayItem) {
  const hostId = state.hostId, threadId = state.activeThread?.id, turnId = item.turnId, generation = selectionGeneration, auth = authenticationGeneration;
  const targetEngine = engineId;
  if (!threadId || !turnId || !state.connected || !state.threadReady) throw new Error('请先恢复连接并同步对话');
  const current = () => auth === authenticationGeneration && generation === selectionGeneration && hostId === state.hostId && threadId === state.activeThread?.id && targetEngine === engineId;
  const result = await historyReader.readItem((method, params) => rpc(method, params, 45000, { silentError: true }), threadId, turnId, item.id, item.outputPreviousItemId);
  if (!current()) throw new Error('对话已切换，已取消读取输出');
  if (typeof result.aggregatedOutput !== 'string') throw new Error('此工具尚无可读取的原始输出');
  if (result.aggregatedOutput.length > 8 * 1024 * 1024) throw new Error('完整输出超过 8 MiB，请在目标主机的终端或日志文件中查看');
  return result.aggregatedOutput;
}
function scheduleConversationSnapshot(threadId?: string) {
  if (!threadId) return;
  if (threadId !== state.activeThread?.id) {
    conversationCache.remove(state.hostId, threadId);
    return;
  }
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(saveConversationSnapshot, 250);
}
function flushConversationCache() {
  clearTimeout(snapshotTimer);
  saveConversationSnapshot();
  return conversationCache.flush();
}
function applyConversationSnapshot(snapshot: ConversationSnapshot, id: string) {
  const metadata = state.threads.find(thread => thread.id === id);
  state.activeThread = { ...snapshot.thread, ...metadata, id };
  state.noProject = isProjectlessThread(state.activeThread);
  state.items = itemCache.get(id) ?? snapshot.items;
  state.turns = snapshot.turns;
  settleLoadedToolItems(state.items, state.turns);
  rememberAsyncQuestions(id, state.items);
  historyWindowTruncated = snapshot.historyTruncated === true;
  const key = recencyKey(state.hostId, id);
  if (!tokenUsages.has(key)) tokenUsages.set(key, snapshot.tokenUsage);
  state.tokenUsage = tokenUsages.get(key) ?? null;
  turnCursor = snapshot.cursor;
  state.moreTurns = !!turnCursor;
}
function beginCompactionUsage(threadId: string) {
  const key = recencyKey(state.hostId, threadId);
  compactionRevisions.set(key, (compactionRevisions.get(key) || 0) + 1);
  if (!compactions.has(key)) compactions.set(key, {});
  compactionResults.delete(key);
  if (state.activeThread?.id === threadId) state.compacting = true;
}
function finishCompaction(threadId: string, turnId?: string, completed = true, outcome?: string) {
  const key = recencyKey(state.hostId, threadId);
  const current = compactions.get(key);
  if (current?.turnId && turnId && current.turnId !== turnId) return;
  const targetTurn = turnId || current?.turnId;
  for (const item of currentItems(threadId)) {
    if (item.type !== 'contextCompaction' || (item.status !== 'inProgress' && !(current && item.status == null)) ||
        (targetTurn && item.turnId !== targetTurn) || (current?.itemId && item.id !== current.itemId)) continue;
    item.status = completed ? 'completed' : outcome === 'interrupted' ? 'interrupted' : 'failed';
    noteItem(threadId, item.id);
  }
  if (current) compactionResults.set(key, completed);
  compactions.delete(key);
  compactionRevisions.set(key, (compactionRevisions.get(key) || 0) + 1);
  if (current?.requested && !activeTurns.has(threadId)) noteRuntime(threadId, false);
  if (completed) compactedSinceInput.add(threadId);
  if (state.activeThread?.id === threadId) state.compacting = false;
}
function settleCompactionRuntime(threadId: string, status: string | undefined) {
  if (!['idle', 'notLoaded', 'systemError'].includes(status || '')) return;
  const compaction = compactions.get(recencyKey(state.hostId, threadId));
  // A read/idle notification can precede acceptance of a newly submitted
  // compaction. Only native progress or its acknowledgement makes it recoverable.
  if (!compaction || compaction.acknowledged === false) return;
  const turn = state.activeThread?.id === threadId
    ? state.turns.find(turn => turn.id === compaction.turnId) : undefined;
  const completed = status !== 'systemError' && !['failed', 'interrupted'].includes(turn?.status);
  if (turn?.status === 'inProgress') {
    turn.status = completed ? 'completed' : 'failed';
    completedTurns.add(turn.id);
  }
  noteRuntime(threadId, false);
  finishCompaction(threadId, compaction.turnId, completed, turn?.status);
}
function reconcileCompactionHistory(threadId: string, revision: number, runtimeStatus?: string) {
  const key = recencyKey(state.hostId, threadId);
  if ((compactionRevisions.get(key) || 0) !== revision) return;
  settleCompactionRuntime(threadId, runtimeStatus);
  const compaction = compactions.get(key);
  if (!compaction || compaction.acknowledged === false) return;
  const turn = state.turns.find(turn => turn.id === compaction.turnId);
  if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
    finishCompaction(threadId, turn.id, turn.status === 'completed', turn.status);
    return;
  }
  const items = currentItems(threadId);
  const index = items.findIndex(item => item.type === 'contextCompaction' &&
    (compaction.itemId ? item.id === compaction.itemId : item.turnId === compaction.turnId));
  // Compaction items have no status in the native history schema. A later
  // assistant/reasoning item in that same turn proves execution has resumed.
  if (index >= 0 && (items[index].status === 'completed' || items.slice(index + 1).some(item =>
    item.turnId === items[index].turnId && ['agentMessage', 'reasoning'].includes(item.type))))
    finishCompaction(threadId, compaction.turnId);
}
function compactionTurnId(threadId: string, explicit?: string) {
  return explicit || compactions.get(recencyKey(state.hostId, threadId))?.turnId || activeTurns.get(threadId)
    || (state.activeThread?.id === threadId ? state.turns.at(-1)?.id : undefined)
    || [...currentItems(threadId)].reverse().find(item => !!item.turnId)?.turnId;
}
function applyTokenUsage(threadId: string, usage: any) {
  const key = recencyKey(state.hostId, threadId);
  const merged = mergeContextUsage(tokenUsages.get(key), usage);
  if (merged == null) return;
  tokenUsages.set(key, merged);
  tokenUsageRevisions.set(key, (tokenUsageRevisions.get(key) || 0) + 1);
  if (state.activeThread?.id === threadId) state.tokenUsage = merged;
}
async function refreshContextUsage(hostId: string, threadId: string) {
  const authentication = authenticationGeneration;
  const key = recencyKey(hostId, threadId);
  const revision = tokenUsageRevisions.get(key) || 0;
  const compaction = compactions.get(key);
  const compactionRevision = compactionRevisions.get(key) || 0;
  const runtimeRevision = turnRevisions.get(threadId) || 0;
  const selectedEngine = engineId;
  try {
    const recovery = compaction && compaction.acknowledged !== false ? '?recoverCompaction=1' : '';
    const context = await http(`/hosts/${encodeURIComponent(hostId)}/threads/${encodeURIComponent(threadId)}/context${recovery}`, {}, false);
    if (authentication !== authenticationGeneration || hostId !== state.hostId || selectedEngine !== engineId) return;
    if ((tokenUsageRevisions.get(key) || 0) === revision && context.tokenUsage) applyTokenUsage(threadId, context.tokenUsage);
    // A slow history/context read cannot clear a compression started meanwhile.
    if ((compactionRevisions.get(key) || 0) === compactionRevision && compactions.get(key) === compaction && typeof context.compacting === 'boolean') {
      if (context.compacting && !compaction) beginCompactionUsage(threadId);
      else if (!context.compacting && compaction && compaction.acknowledged !== false) {
        if ((turnRevisions.get(threadId) || 0) === runtimeRevision)
          settleCompactionRuntime(threadId, context.runtimeStatus);
        if (compactions.has(key)) finishCompaction(threadId);
      }
    }
    if (state.activeThread?.id === threadId) scheduleConversationSnapshot(threadId);
  } catch { /* Older servers and transient reads retain the last measurement. */ }
}
// Completion events can be lost while Android is suspended, even if the
// connection later stays healthy. Only read native state while compression is
// pending; do not reload large history, reacquire writers or replay submissions.
watch(() => [state.compacting, state.activeThread?.id, state.hostId, state.connected,
  state.online, state.authenticated, state.runtimePaused] as const, ([compacting, threadId, hostId], _, onCleanup) => {
  if (!compacting || !threadId || !state.connected || !state.online || !state.authenticated || state.runtimePaused) return;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const check = async () => {
    if (cancelled) return;
    await refreshContextUsage(hostId, threadId);
    if (!cancelled) timer = setTimeout(check, 2000);
  };
  timer = setTimeout(check, 2000);
  onCleanup(() => { cancelled = true; clearTimeout(timer); });
}, { flush: 'sync' });
// Android may discard the renderer rather than emit a normal unload event.
// Commit small private snapshots while hidden; the server retains the runtime.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => { void flushConversationCache(); });
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushConversationCache();
  });
  document.addEventListener('freeze', () => { void flushConversationCache(); });
}
function appendTerminal(chunk: string, processId = state.terminalProcessId) {
  const process = state.terminalProcesses.find(process => process.processId === processId);
  if (process) process.lastOutput = ((process.lastOutput || "") + chunk).slice(-200000);
  if (processId !== state.terminalProcessId) return;
  state.terminalOutput = (state.terminalOutput + chunk).slice(-500000);
  for (const listener of terminalListeners) listener(chunk);
}
function subscribeTerminal(listener: (chunk: string) => void) {
  terminalListeners.add(listener);
  return () => terminalListeners.delete(listener);
}
function clearTerminalDecoders(processId: string) {
  const prefix = `${state.hostId}:${processId}:`;
  for (const key of terminalDecoders.keys()) if (key.startsWith(prefix)) terminalDecoders.delete(key);
}
function restoreTerminalDecoders(process: any) {
  clearTerminalDecoders(process.processId);
  for (const stream of ['stdout', 'stderr']) {
    const pending = process.pendingOutputBase64?.[stream];
    if (typeof pending !== 'string' || pending.length > 8) continue;
    try {
      const decoder = new TextDecoder();
      decoder.decode(Uint8Array.from(atob(pending), character => character.charCodeAt(0)), { stream: true });
      terminalDecoders.set(`${state.hostId}:${process.processId}:${stream}`, decoder);
    } catch { /* Older/invalid optional snapshots must not break reconnection. */ }
  }
}
function terminalIds(): Record<string, string> {
  try {
    const value = JSON.parse(
      browserStorage.session.getItem("codex.terminalProcessIds") || "{}",
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
  browserStorage.session.setItem("codex.terminalProcessIds", JSON.stringify(ids));
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
const attachmentDrafts = new AttachmentDraftStore();
let attachmentDraftScope = '';
let attachmentDraftHost = '';
let attachmentSelectionToken = 0;
let restoringAttachments = false;
function resetAttachmentDrafts() {
  attachmentDrafts.activate(null);
  attachmentDraftScope = attachmentDraftHost = '';
  ++attachmentSelectionToken;
  restoringAttachments = true;
  state.attachments = []; state.attachmentsLoading = false; state.attachmentDraftWarning = '';
  restoringAttachments = false;
}
function attachmentIdentity() {
  return attachmentDraftIdentity(state.hostId, state.activeThread?.id, state.projectPath, state.noProject);
}
function attachmentWarning(identity: string) {
  const warning = attachmentDrafts.warning(identity);
  return warning ? `附件已保留在当前页面，刷新后可能丢失：${warning}` : '';
}
function attachmentSave(identity: string, hostId: string, files: DraftAttachment[]) {
  const authentication = authenticationGeneration;
  return attachmentDrafts.save(identity, hostId, files).then(() => {
    if (authentication === authenticationGeneration && identity === attachmentDraftScope) state.attachmentDraftWarning = '';
  }).catch(cause => {
    if (authentication === authenticationGeneration && identity === attachmentDraftScope)
      state.attachmentDraftWarning = `附件已保留在当前页面，刷新后可能丢失：${cause.message}`;
  });
}
function activateAttachmentDraft(force = false) {
  if (!state.authenticated || !state.hostId) return;
  const identity = attachmentIdentity(), hostId = state.hostId;
  if (!force && identity === attachmentDraftScope) return;
  attachmentDraftScope = identity; attachmentDraftHost = hostId;
  const token = ++attachmentSelectionToken, authentication = authenticationGeneration;
  const cached = attachmentDrafts.peek(identity);
  restoringAttachments = true;
  state.attachments = cached || [];
  state.attachmentsLoading = !cached;
  state.attachmentDraftWarning = attachmentWarning(identity);
  restoringAttachments = false;
  void cacheActivation.then(() => attachmentDrafts.read(identity, hostId)).then(files => {
    if (token !== attachmentSelectionToken || authentication !== authenticationGeneration || !state.authenticated) return;
    restoringAttachments = true; state.attachments = files; restoringAttachments = false;
    state.attachmentDraftWarning = attachmentWarning(identity);
  }).catch(cause => {
    if (token === attachmentSelectionToken && authentication === authenticationGeneration)
      state.attachmentDraftWarning = `无法恢复附件草稿：${cause.message}`;
  }).finally(() => { if (token === attachmentSelectionToken) state.attachmentsLoading = false; });
}
watch(() => [state.authenticated, state.hostId, state.activeThread?.id || '', state.activeThread ? '' : state.projectPath, state.activeThread ? false : state.noProject], () => activateAttachmentDraft(), { flush: 'sync' });
watch(() => state.attachments, files => {
  if (!restoringAttachments && state.authenticated && attachmentDraftScope)
    void attachmentSave(attachmentDraftScope, attachmentDraftHost, files.map(file => toRaw(file)));
}, { deep: true, flush: 'sync' });
function consumeAttachmentDraft(identity: string, hostId: string, files: DraftAttachment[], authentication = authenticationGeneration) {
  if (authentication !== authenticationGeneration || !state.authenticated) return;
  const persisted = attachmentDrafts.consume(identity, hostId, files).catch(cause => {
    if (authentication === authenticationGeneration && state.authenticated && identity === attachmentDraftScope)
      state.attachmentDraftWarning = `附件草稿清理失败：${cause.message}`;
  });
  if (attachmentDraftScope === identity) {
    restoringAttachments = true; state.attachments = attachmentDrafts.peek(identity) || []; restoringAttachments = false;
  }
  return persisted;
}
function moveAttachmentDraft(from: string, to: string, hostId: string) {
  const files = attachmentDrafts.peek(from) || [];
  if (!files.length || from === to) return;
  const destination = attachmentDrafts.peek(to) || [];
  void attachmentSave(to, hostId, [...destination, ...files.filter(file => !destination.some(existing => existing.id === file.id))]);
  void attachmentSave(from, hostId, []);
}
function originalAttachment(file: any): File | undefined {
  return attachmentOriginals.get(toRaw(file)) || (file.original instanceof Blob
    ? new File([file.original], file.name, { type: file.mime, lastModified: file.lastModified }) : undefined);
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
    ), { status: response.status, code: result.code });
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
      if (csrfToken && session.csrfToken && csrfToken !== session.csrfToken) {
        advanceAuthentication();
        clearConversationCaches();
      }
      csrfToken = session.csrfToken ?? csrfToken;
      state.authenticated = true;
      void activateConversationCache();
    } else {
      const wasAuthenticated = state.authenticated;
      advanceAuthentication();
      csrfToken = "";
      state.authenticated = false;
      clearConversationCaches();
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
// Renames change labels, not project membership or its pagination cursors.
const projectPageRevisions = new Map<string, number>();
function advanceNavigationRevision(hostId: string, projectPages = true) {
  navigationRevisions.set(hostId, (navigationRevisions.get(hostId) ?? 0) + 1);
  if (projectPages) projectPageRevisions.set(hostId, (projectPageRevisions.get(hostId) ?? 0) + 1);
}
const nativeProjectBindingRequests = new Map<string, Promise<void>>();
const nativeProjectBindingTimes = new Map<string, number>();
const nativeProjectBindingValues = new Map<string, { path: string; projectId: string }[]>();
const threadProjectChanges = new Map<string, { revision: number; projectId: string | null }>();
let projectChangeSequence = 0;
function replaceProjects(projects: any[]) {
  const location = (project: any) => JSON.stringify([project.hostId || 'local', project.path]);
  const previous = new Map(state.projects.map(project => [location(project), project]));
  const next = new Map(projects.map(project => [location(project), project]));
  // An older project edit/add response can arrive after a shared sort event.
  // Refresh metadata independently while retaining that newer display order.
  state.projects = orderProjects(retainProjectBindings(state.projects, projects), latestProjectOrder);
  const changedHosts = new Set<string>();
  for (const key of new Set([...previous.keys(), ...next.keys()])) {
    const before = previous.get(key), after = next.get(key);
    if (before && after && projectBindingKey(before) === projectBindingKey(after)) continue;
    const project = after || before;
    const hostId = project.hostId || 'local';
    changedHosts.add(hostId);
    // A changed project needs new identity/pagination discovery; unrelated
    // projects retain both their native membership and loaded conversations.
    if (hostId === state.hostId) delete state.projectThreadPages[project.path];
    if (state.navigation[hostId]) delete state.navigation[hostId].projectPages[project.path];
  }
  for (const hostId of changedHosts) {
    advanceNavigationRevision(hostId);
    navigationRequests.delete(hostId);
    invalidateThreadTitleSearch(hostId);
  }
}
async function loadNativeProjectBindings(hostId = state.hostId, force = false): Promise<void> {
  if (!hostId || !state.hosts.some(host => host.id === hostId)) return;
  const scopeKey = () => JSON.stringify([authenticationGeneration, hostId, state.projects.filter(project => (project.hostId || 'local') === hostId)
    .map(project => [project.path, project.name, project.rootPaths])]);
  const key = scopeKey();
  const previous = nativeProjectBindingRequests.get(key);
  if (previous) return previous;
  const apply = (bindings: { path: string; projectId: string }[]) => {
    for (const project of state.projects.filter(project => (project.hostId || 'local') === hostId)) {
      const binding = bindings.find(entry => entry.path === project.path);
      if (binding) project.nativeProjectId = binding.projectId;
      else delete project.nativeProjectId;
    }
  };
  if (!force && Date.now() - (nativeProjectBindingTimes.get(key) || 0) < 30000) {
    apply(nativeProjectBindingValues.get(key) || []);
    return;
  }
  const authentication = authenticationGeneration;
  const operation = (async () => {
    const result = await http(`/projects/native-bindings?hostId=${encodeURIComponent(hostId)}`, {}, false);
    if (authentication !== authenticationGeneration || !state.authenticated || !state.hosts.some(host => host.id === hostId) || key !== scopeKey()) return;
    if (typeof result.supported !== 'boolean' || !Array.isArray(result.bindings) ||
        result.bindings.some((entry: any) => typeof entry?.path !== 'string' || typeof entry?.projectId !== 'string' || !entry.projectId))
      throw new Error('Codex 项目接口返回格式不兼容，请检查目标服务器的 Codex 版本');
    apply(result.bindings);
    nativeProjectBindingValues.set(key, result.bindings);
    nativeProjectBindingTimes.set(key, Date.now());
  })().finally(() => { if (nativeProjectBindingRequests.get(key) === operation) nativeProjectBindingRequests.delete(key); });
  nativeProjectBindingRequests.set(key, operation);
  return operation;
}
function threadMatchesProject(thread: any, project: any) { return matchesProject(thread, project); }
const titleSearchPages = new ThreadTitlePageCache<any>();
const titleSearchSupport = new Map<string, boolean>();
const titleSearchRevision = ref(0);
function invalidateThreadTitleSearch(hostId: string) {
  titleSearchPages.clearHost(hostId);
  ++titleSearchRevision.value;
}
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
function navigationMore(hostId?: string) {
  if (hostId)
    return hostId === state.hostId ? state.moreThreads : !!state.navigation[hostId]?.cursor;
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
  const data = (result.data ?? []).filter((thread: any) => !deletedThreads.has(recencyKey(hostId, thread.id)));
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
  metadataOnly = false,
) {
  const projectRevision = projectChangeSequence;
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
  result.data = (result.data || []).map((thread: any) => {
    const change = threadProjectChanges.get(recencyKey(hostId, thread.id));
    return change && change.revision > projectRevision ? { ...thread, projectId: change.projectId } : thread;
  });
  // Title search needs metadata, not a history read per match on old servers.
  if (metadataOnly) return {
    ...result,
    data: (result.data ?? []).filter((thread: any) => !deletedThreads.has(recencyKey(hostId, thread.id))),
  };
  return normalizeThreadPage(hostId, result);
}
function mergeNavigation(hostId: string, threads: any[], replace = false) {
  const nav = hostNavigation(hostId);
  const previousTitles = new Map(nav.threads.map(thread => [thread.id, searchableThreadTitle(thread)]));
  const records = new Map(
    (replace ? [] : nav.threads).map((thread) => [thread.id, thread]),
  );
  for (const thread of threads)
    if (!deletedThreads.has(recencyKey(hostId, thread.id))) records.set(thread.id, { ...records.get(thread.id), ...thread });
  nav.threads = [...records.values()];
  if (nav.threads.length !== previousTitles.size || nav.threads.some(thread => previousTitles.get(thread.id) !== searchableThreadTitle(thread)))
    invalidateThreadTitleSearch(hostId);
}
function refreshHostNavigation(hostId: string): Promise<void> {
  if (!state.hosts.some(host => host.id === hostId) || pausedHosts.has(hostId)) return Promise.resolve();
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
    titleSearchPages.clear();
    ++titleSearchRevision.value;
    loadedMorePages = false;
    loadedGlobalPages = false;
    state.projectThreadPages = {};
    state.threads = [];
    for (const host of state.hosts) {
      advanceNavigationRevision(host.id);
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
async function loadMoreNavigation(hostId?: string) {
  await Promise.allSettled([
    !hostId || hostId === state.hostId ? loadMoreThreads() : Promise.resolve(),
    ...state.hosts
      .filter(
        (host) => host.id !== state.hostId && (!hostId || host.id === hostId) && state.navigation[host.id]?.cursor,
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
  const revision = projectPageRevisions.get(hostId) ?? 0;
  const nameRevisions = new Map(threadNameRevisions);
  const result = await projectThreadPage(hostId, projectPath, more ? current : undefined);
  if (
    revision !== (projectPageRevisions.get(hostId) ?? 0) ||
    !state.hosts.some((host) => host.id === hostId)
  )
    return;
  mergeNavigation(hostId, result.data.map((thread: any) => ({ ...thread, ...listedThreadLabels(thread, hostId, nameRevisions) })));
  nav.loadedMore = true;
  nav.projectPages[projectPath] = result.page;
}
async function projectThreadPage(hostId: string, projectPath: string, current?: ProjectThreadPage) {
  await loadNativeProjectBindings(hostId);
  const projectId = state.projects.find(project => (project.hostId || 'local') === hostId && project.path === projectPath)?.nativeProjectId;
  const roots = projectRoots(projectPath, hostId);
  if (!projectId) {
    const result = await threadPage(hostId, 'thread/list', { limit: 60, cursor: current?.cursor, cwd: roots, modelProviders: [] });
    return { data: result.data, page: { loaded: true, cursor: result.nextCursor } as ProjectThreadPage };
  }
  // A moved thread retains its old cwd. Page native membership separately from
  // unassigned legacy conversations, preserving both pagination cursors.
  const sameProject = current?.nativeProjectId === projectId;
  const nativeCursor = sameProject ? current?.nativeCursor : undefined;
  const legacyCursor = sameProject ? current?.legacyCursor : undefined;
  const [native, legacy] = await Promise.all([
    nativeCursor === null ? { data: [], nextCursor: null } : threadPage(hostId, 'thread/list', { limit: 60, cursor: nativeCursor, projectId, modelProviders: [] }),
    legacyCursor === null ? { data: [], nextCursor: null } : threadPage(hostId, 'thread/list', { limit: 60, cursor: legacyCursor, cwd: roots, projectId: null, modelProviders: [] }),
  ]);
  return { data: [...new Map([...legacy.data, ...native.data].map((thread: any) => [thread.id, thread])).values()],
    page: { loaded: true, cursor: native.nextCursor || legacy.nextCursor ? 'more' : null,
      nativeCursor: native.nextCursor, legacyCursor: legacy.nextCursor, nativeProjectId: projectId } as ProjectThreadPage };
}
function navigationProjectPage(hostId: string, projectPath: string) {
  return hostId === state.hostId
    ? state.projectThreadPages[projectPath]
    : state.navigation[hostId]?.projectPages[projectPath];
}
function closeConnection(options: { retainHost?: boolean } = {}) {
  cancelGoalRefresh();
  notifyProtocol({ method: 'bridge/disconnecting', params: { permanent: state.switchingHost || !state.authenticated } });
  saveConversationSnapshot();
  localReverts.clear();
  clearTimeout(reconnectTimer);
  clearInterval(refreshTimer);
  const old = socket;
  socket = null;
  if (old) {
    const retained = hostConnections.get(state.hostId);
    if (options.retainHost && retained?.socket === old && retained.authentication === authenticationGeneration &&
        (old.readyState === WebSocket.CONNECTING || old.readyState === WebSocket.OPEN)) {
      retained.engineId = engineId;
      retained.sequence = eventSequence;
      retained.gap = socketHasEventGap;
      retained.usedAt = Date.now();
    } else {
      if (retained?.socket === old) hostConnections.delete(state.hostId);
      old.close();
    }
  }
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
  replayedConnection = null;
  state.connected = false;
  if (state.activeThread) state.threadReady = false;
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
      method,
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
  if (!busy) itemCache.refresh(threadId);
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
function updateThread(thread: any, options: { authoritativePreview?: boolean } = {}) {
  if (!thread?.id || thread.ephemeral || deletedThreads.has(recencyKey(state.hostId, thread.id))) return;
  const previous = state.threads.find((item) => item.id === thread.id)
    ?? (state.activeThread?.id === thread.id ? state.activeThread : undefined);
  const authoritativePreview = options.authoritativePreview && typeof thread.preview === 'string';
  thread = {
    ...thread,
    // Native metadata can lag the accepted first message. Keep its confirmed
    // display preview until the server supplies a nonempty canonical preview.
    ...(!authoritativePreview && !thread.preview && previous?.preview ? { preview: previous.preview } : {}),
    ...(authoritativePreview && !thread.name && previous?.name ? { name: previous.name } : {}),
    recencyAt:
      typeof thread.recencyAt === "number" && Number.isFinite(thread.recencyAt)
        ? Math.max(
            threadActivityAt(thread),
            previous ? threadActivityAt(previous) : 0,
          )
        : (previous?.recencyAt ?? threadActivityAt(thread)),
  };
  if (previous && (('name' in thread && thread.name !== previous.name)
      || ('preview' in thread && thread.preview !== previous.preview))) {
    const key = recencyKey(state.hostId, thread.id);
    threadNameRevisions.set(key, (threadNameRevisions.get(key) ?? 0) + 1);
  }
  if (!previous || searchableThreadTitle({ ...previous, ...thread }) !== searchableThreadTitle(previous))
    invalidateThreadTitleSearch(state.hostId);
  threadRevisions.set(thread.id, ++threadEventSequence);
  removedThreads.delete(thread.id);
  if (state.activeThread?.id === thread.id) {
    state.activeThread = { ...state.activeThread, ...thread };
    state.noProject = isProjectlessThread(state.activeThread);
  }
  const index = state.threads.findIndex((t) => t.id === thread.id);
  if (index < 0) state.threads.unshift(thread);
  else state.threads[index] = { ...state.threads[index], ...thread };
}
function projectAcceptedThreadPreview(threadId: string, items: any[]) {
  const thread = state.threads.find(thread => thread.id === threadId)
    ?? (state.activeThread?.id === threadId ? state.activeThread : undefined);
  if (!thread || thread.name || thread.preview) return;
  // Only native events or accepted RPC inputs reach this helper. Optimistic
  // messages and paginated history cannot establish the first message's title.
  const message = items.find(item => item?.type === 'userMessage'
    && !['sending', 'unconfirmed'].includes(item.status));
  const text = message?.content?.find((input: any) => input.type === 'text'
    && typeof input.text === 'string' && input.text.trim()
    && asyncQuestionAnswerDisplayText(input.text) === null)?.text;
  const preview = text?.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 160);
  if (!preview) return;
  updateThread({ ...thread, preview });
  scheduleConversationSnapshot(threadId);
}
function listedThreadLabels(thread: any, hostId: string, nameRevisions: Map<string, number>) {
  const live = hostId === state.hostId
    ? state.threads.find(current => current.id === thread.id) ?? (state.activeThread?.id === thread.id ? state.activeThread : undefined)
    : state.navigation[hostId]?.threads.find(current => current.id === thread.id);
  const key = recencyKey(hostId, thread.id);
  const renamed = (threadNameRevisions.get(key) ?? 0) !== (nameRevisions.get(key) ?? 0);
  const name = renamed ? live?.name : thread.name ?? live?.name;
  const preview = renamed && typeof live?.preview === 'string' ? live.preview : thread.preview || live?.preview;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(preview !== undefined ? { preview } : {}),
  };
}
function updateTurn(threadId: string, turn: any) {
  if (state.activeThread?.id !== threadId || !turn?.id) return;
  const index = state.turns.findIndex((item) => item.id === turn.id);
  const previous = index >= 0 ? state.turns[index] : null;
  const next = mergeTurnSnapshot(previous, turn);
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
function hydrateTurnItems(threadId: string, turn: any, accepted?: any, preserveLive = true) {
  if (!turn?.id || discardedTurns.has(turn.id)) return;
  for (const itemId of mergeAcceptedTurnItems(currentItems(threadId), turn, accepted, preserveLive))
    noteItem(threadId, itemId);
  for (const itemId of settleInterruptedTurnItems(currentItems(threadId), turn))
    noteItem(threadId, itemId);
  projectAcceptedThreadPreview(threadId, [
    ...(turn.items || []),
    ...(Array.isArray(accepted?.input) ? [{ type: 'userMessage', content: accepted.input }] : []),
  ]);
  rememberAsyncQuestions(threadId, currentItems(threadId));
}
function settleLoadedToolItems(items: DisplayItem[], turns: any[]) {
  for (const turn of turns)
    if (turn.status === 'interrupted' || turn.status === 'failed') settleInterruptedTurnItems(items, turn);
}
function receiveThreadChange(change: any) {
  const { threadId, method, result = {}, request = {}, changeId } = change;
  if (!threadId || typeof method !== 'string') return;
  if (typeof changeId === 'string') {
    if (seenThreadChanges.has(changeId)) return;
    seenThreadChanges.add(changeId);
    if (seenThreadChanges.size > 512) seenThreadChanges.delete(seenThreadChanges.values().next().value!);
  }
  if (method === 'thread/start' || method === 'thread/fork' || method === 'thread/unarchive') {
    updateThread(result.thread);
    return;
  }
  if (method === 'thread/archive') { cleanupArchivedThread(threadId); return; }
  if (method === 'thread/delete') { cleanupDeletedThread(threadId); return; }
  if (method === 'thread/name/set') {
    if (typeof request.name === 'string') applyThreadRename(threadId, request.name);
    return;
  }
  if (method === 'thread/metadata/update' && result.thread?.id === threadId &&
      (result.thread.projectId === null || typeof result.thread.projectId === 'string')) {
    applyThreadProject(state.hostId, threadId, result.thread.projectId);
    return;
  }
  if (method === 'thread/revert' || method === 'thread/rollback') {
    if (pendingMessageEdit && pendingMessageEdit.threadId === threadId) pendingMessageEdit.blocked = true;
    rememberRevertedHistory(threadId, false);
    const before = state.activeThread?.id === threadId
      ? state.turns.findIndex(turn => turn.id === request.beforeTurnId) : -1;
    const removed = state.activeThread?.id === threadId
      ? (before >= 0 ? state.turns.slice(before) : []).map(turn => turn.id) : [];
    resetEditedHistory(threadId, removed);
    updateThread(result.thread, { authoritativePreview: true });
    refreshRevertedThread(threadId);
    return;
  }
  if (method === 'thread/settings/update' && state.activeThread?.id === threadId) {
    if (request.model) state.model = request.model;
    if (request.effort) state.effort = request.effort;
    if (request.sandboxPolicy) {
      state.permission = sandboxName(request.sandboxPolicy.type);
      state.runtimePolicy = { sandboxPolicy: request.sandboxPolicy, approvalPolicy: request.approvalPolicy ?? approvalPolicy(state.permission), source: 'web' };
      state.activePermissionProfileId = '';
      permissionSelections.set(recencyKey(state.hostId, threadId), { mode: state.permission, profileId: '' });
    }
    if (request.collaborationMode?.mode) state.collaborationMode = request.collaborationMode.mode;
    if ('serviceTier' in request) {
      state.nativeServiceTier = request.serviceTier ?? null;
      state.serviceTier = state.nativeServiceTier;
      state.serviceTierScope = serviceTierScope(state);
    }
    if (request.sandboxPolicy || request.approvalPolicy !== undefined) state.permissionChangePending = state.busy;
    return;
  }
  if (method === 'turn/start') {
    const turn = result.turn;
    if (!turn?.id || discardedTurns.has(turn.id)) return;
    hydrateTurnItems(threadId, turn, { ...request, placement: 'start' });
    updateTurn(threadId, turn);
    noteContentActivity(threadId, turn);
    if (!completedTurns.has(turn.id) && (!turn.status || turn.status === 'inProgress')) {
      if (!activeTurns.has(threadId) || activeTurns.get(threadId) === turn.id)
        noteRuntime(threadId, true, turn.id);
    }
    return;
  }
  if (method === 'turn/steer' && typeof result.turnId === 'string') {
    hydrateTurnItems(threadId, { id: result.turnId }, request);
  }
}
function receive(message: any) {
  if (message.method === 'bridge/prompt-presets/changed') {
    promptPresets.hydrate(message.params);
    return;
  }
  if (message.method === 'bridge/project-order/changed') {
    receiveProjectOrder(message.params?.projects);
    return;
  }
  if (message.method === 'bridge/host-order/changed') {
    receiveHostOrder(message.params?.hostIds);
    return;
  }
  if (typeof message.bridgeEventSequence === 'number') {
    if (eventSequence !== null && message.bridgeEventSequence <= eventSequence) return;
    if (eventSequence !== null && message.bridgeEventSequence > eventSequence + 1) { socketHasEventGap = true; ++eventGapRevision; }
    eventSequence = Math.max(eventSequence ?? 0, message.bridgeEventSequence);
  }
  if (message.id !== undefined && !message.method) {
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) {
      const error = Object.assign(new Error(message.error.message), {
        uncertain: !!message.error.data?.uncertain,
        code: message.error.code,
        data: message.error.data,
      });
      entry.reject(entry.silentError ? error : fail(error));
    } else entry.resolve(message.result);
    return;
  }
  const consumed = notifyProtocol(message);
  if (message.method && message.id !== undefined) {
    if (isInteractiveServerRequest(message) && !state.pendingRequests.some((p) => p.id === message.id))
      state.pendingRequests.push(message);
    return;
  }
  if (consumed && !['bridge/status', 'bridge/host-disabled', 'serverRequest/resolved', 'thread/deleted'].includes(message.method)) return;
  const { method, params: p = {} } = message;
  if (method === 'bridge/host-disabled') {
    void refreshHostAvailability().catch(error => { if (state.authenticated) fail(error); });
    return;
  }
  if (method === 'thread/deleted') { cleanupDeletedThread(p.threadId); return; }
  if (p.threadId && deletedThreads.has(recencyKey(state.hostId, p.threadId))) return;
  if (p.threadId || method === 'bridge/thread/changed') scheduleConversationSnapshot(p.threadId);
  if (method === 'bridge/thread/changed') { receiveThreadChange(p); return; }
  if (method === "bridge/status") {
    const changedEngine = !!engineId && typeof p.engineId === 'string' && engineId !== p.engineId;
    if (typeof p.engineId === 'string') {
      if (engineId !== p.engineId) {
        if (changedEngine) {
          // A newer observed engine owns this protection even when an older
          // engine's delayed refresh has not started or settled yet. Explicit
          // reconnects keep their own marker until their full recovery ends.
          if (!preserveMetadataChoices() || metadataReconnectChoices?.observedEngine) metadataReconnectChoices = {
            authentication: authenticationGeneration, hostId: state.hostId, hostGeneration: hostSelectionGeneration,
            threadId: state.activeThread?.id || null, observedEngine: p.engineId,
          };
          invalidateRuntimeCapabilities();
          verifiedConfiguration = null;
          configurationRequest = null;
          settingsApi.invalidateHostSettings(state.hostId);
        }
        if (changedEngine && state.activeThread) {
          state.threadReady = false;
          ++selectionGeneration;
          state.selectingThread = false;
        }
        writerAttachment = null;
        eventSequence = null;
        socketHasEventGap = true;
        ++eventGapRevision;
      }
      engineId = p.engineId;
      if (typeof p.eventSequence === 'number') {
        if (eventSequence !== null && p.eventSequence > eventSequence) { socketHasEventGap = true; ++eventGapRevision; }
        eventSequence = p.eventSequence;
      }
    } else {
      engineId = null;
      writerAttachment = null;
    }
    const reconnecting = !state.connected && p.connected;
    if (reconnecting) seenThreadChanges.clear();
    state.connected = p.connected;
    if (reconnecting) startNavigationRefresh();
    if (typeof p.paused === 'boolean') {
      state.runtimePaused = p.paused;
      if (p.paused) {
        cancelGoalRefresh();
        writerAttachment = null;
        saveConversationSnapshot();
        pausedHosts.add(state.hostId);
        state.connected = false;
        state.threadReady = false;
        state.busy = false;
        state.pendingRequests = [];
        if (state.threadConflict && state.error === state.threadConflict.message) state.error = '';
        state.threadConflict = null;
        state.takingOverThread = false;
        ++takeoverOperation;
        state.terminalRunning = false;
        state.terminalProcesses = [];
        state.terminalSessionName = '';
        clearTimeout(reconnectTimer);
      } else pausedHosts.delete(state.hostId);
    }
    if (Array.isArray(p.releasedThreadIds)) updateReleasedThreads(state.hostId, p.releasedThreadIds);
    state.connectionMode = p.mode ?? state.connectionMode;
    if (p.error) state.error = p.error;
    if (p.connected && !state.runtimePaused) {
      state.error = state.threadConflict?.message || "";
      if (p.pendingRequests) state.pendingRequests = p.pendingRequests.filter(isInteractiveServerRequest);
      if (changedEngine) {
        void Promise.allSettled([loadModeCapabilities(), loadSkills({ forceReload: true })]);
        // initialize broadcasts before releasing its maintenance lock. Read
        // fresh metadata on all observing browsers once it has settled.
        const refreshedEngine = engineId, hostId = state.hostId, auth = authenticationGeneration;
        setTimeout(() => {
          if (auth === authenticationGeneration && hostId === state.hostId && refreshedEngine === engineId && state.runtimeReconnectingHostId !== hostId)
            void refreshCurrentRuntimeMetadata();
        }, 250);
      }
      if (state.goalReadError) void refreshCurrentGoal();
    }
    if (p.connected && !state.runtimePaused && Array.isArray(p.activeProcesses)) {
      const previousIds = new Set(state.terminalProcesses.map(process => process.processId));
      for (const snapshot of p.activeProcesses)
        if (reconnecting || changedEngine || !previousIds.has(snapshot.processId)) restoreTerminalDecoders(snapshot);
      state.terminalProcesses = p.activeProcesses;
      const process = p.activeProcesses.find(
        (process: any) => process.processId === state.terminalProcessId,
      );
      state.terminalRunning = !!process;
      if (process && (reconnecting || !state.terminalOutput)) {
        restoreTerminalOutput(process.lastOutput || "");
      }
      // With no selected conversation there is no writer/history to hydrate.
      // The complete process snapshot establishes a terminal replay cursor;
      // eventGapRevision still invalidates cached conversations selected later.
      if (!state.activeThread && typeof p.engineId === 'string' && typeof p.eventSequence === 'number')
        socketHasEventGap = false;
    }
    if (p.connected) clearTimeout(reconnectTimer);
    if (!state.runtimePaused && state.authenticated) {
      if (!p.connected) scheduleReconnect();
      else if (changedEngine && state.activeThread && !state.threadReleased) scheduleReconnect(100);
    }
    return;
  }
  if (method === "bridge/terminal/completed") {
    const firstCompletion = !completedTerminalProcesses.has(p.processId);
    if (firstCompletion) {
      let tail = typeof p.outputTail === 'string' ? p.outputTail : '';
      // New bridges flush their decoder into outputTail. Older bridges leave
      // that job to the live browser; never flush both copies of the same tail.
      if (p.outputTail === undefined) {
        const prefix = `${state.hostId}:${p.processId}:`;
        for (const [key, decoder] of terminalDecoders) if (key.startsWith(prefix)) tail += decoder.decode();
      }
      if (tail) appendTerminal(tail, p.processId);
    }
    clearTerminalDecoders(p.processId);
    terminalSessionNames.delete(`${state.hostId}:${p.processId}`);
    state.terminalProcesses = state.terminalProcesses.filter(
      (process) => process.processId !== p.processId,
    );
    if (p.processId === state.terminalProcessId) {
      state.terminalRunning = false;
      state.terminalSessionName = "";
      if (firstCompletion)
        appendTerminal(
          p.error
            ? `\r\n[终端结束：${p.error.message}]\r\n`
            : `\r\n[进程退出 ${p.result?.exitCode ?? "?"}]\r\n${p.result?.stdout ?? ""}${p.result?.stderr ?? ""}`,
        );
      const ids = terminalIds();
      if (ids[state.hostId] === p.processId) delete ids[state.hostId];
      browserStorage.session.setItem("codex.terminalProcessIds", JSON.stringify(ids));
    }
    completedTerminalProcesses.add(p.processId);
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
  if (method === "skills/changed") { void loadSkills({ forceReload: true }).catch(() => {}); return; }
  if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
    applyGoal(state.hostId, p.threadId, method === "thread/goal/cleared" ? null : p.goal);
    return;
  }
  if (method === "thread/started") updateThread(p.thread);
  if (method === "thread/project/updated" &&
      (p.projectId === null || typeof p.projectId === 'string')) {
    applyThreadProject(state.hostId, p.threadId, p.projectId);
    void loadNativeProjectBindings(state.hostId, true).catch(() => {});
    return;
  }
  if (method === "thread/reverted") {
    const key = recencyKey(state.hostId, p.threadId);
    if (localReverts.delete(key)) return;
    if (pendingMessageEdit && pendingMessageEdit.threadId === p.threadId) pendingMessageEdit.blocked = true;
    rememberRevertedHistory(p.threadId, true);
    resetEditedHistory(p.threadId);
    refreshRevertedThread(p.threadId);
    return;
  }
  if (discardedTurns.has(p.turnId || p.turn?.id)) return;
  if (method === "thread/name/updated") {
    const name = p.threadName ?? p.name;
    if (typeof name === 'string') applyThreadRename(p.threadId, name);
  }
  if (method === "thread/status/changed") {
    const thread = state.threads.find((t) => t.id === p.threadId);
    if (thread) updateThread({ ...thread, status: p.status });
    const previous = state.agentActivity[p.threadId];
    const status = p.status?.type === 'idle' ? 'idle' : subagentStatus(p.status);
    // Idle/unloaded describes the runtime, not whether the last turn succeeded.
    const retainFailure = ['idle', 'unknown'].includes(status)
      && ['errored', 'interrupted', 'shutdown'].includes(previous?.status || '');
    state.agentActivity[p.threadId] = { ...previous, status: retainFailure ? previous!.status : status, updatedAt: Date.now() };
    noteRuntime(p.threadId, p.status?.type === "active");
    settleCompactionRuntime(p.threadId, p.status?.type);
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
    if (p.item?.type === 'contextCompaction') {
      const previous = currentItems(p.threadId).find(item => item.id === p.item.id);
      if (method === 'item/started' && previous &&
          (['completed', 'failed', 'interrupted'].includes(previous.status) ||
            !!previous.turnId && completedTurns.has(previous.turnId))) return;
      // Legacy runtimes omit turnId on item events. Anchor the divider now;
      // subsequent replies must never make it a permanent conversation footer.
      p.turnId = compactionTurnId(p.threadId, p.turnId);
      const synthetic = currentItems(p.threadId).find(item => item.type === 'contextCompaction' && item.legacyCompaction && item.turnId === p.turnId);
      if (synthetic && synthetic.id !== p.item.id) {
        const index = currentItems(p.threadId).indexOf(synthetic);
        currentItems(p.threadId).splice(index, 1);
      }
    }
    const items = currentItems(p.threadId);
    const itemId = p.item?.id ?? p.itemId;
    const previousItem = items.find(item => item.id === itemId);
    const newItem = itemId && !previousItem;
    if (itemId) noteItem(p.threadId, itemId);
    applyItemEvent(items, method, p);
    if (p.threadId === state.activeThread?.id) {
      const turn = state.turns.find(turn => turn.id === p.turnId);
      if (turn) for (const touched of settleInterruptedTurnItems(items, turn)) noteItem(p.threadId, touched);
    }
    const item = items.find(item => item.id === itemId);
    if ((method === 'item/started' || method === 'item/completed') && p.item?.type === 'userMessage')
      projectAcceptedThreadPreview(p.threadId, [p.item]);
    if ((method === 'item/started' || method === 'item/completed') &&
        (item?.type === 'userMessage' || asyncUserInputQuestions(item).length)) rememberAsyncQuestions(p.threadId, items);
    state.agentActivity[p.threadId] = { ...state.agentActivity[p.threadId], updatedAt: Date.now(),
      ...(item?.type === 'agentMessage' ? { text: item.text } : {}) };
    if (p.item?.type === "contextCompaction" && method === "item/started") {
      beginCompactionUsage(p.threadId);
      const key = recencyKey(state.hostId, p.threadId);
      compactions.set(key, { ...compactions.get(key), turnId: p.turnId, itemId: p.item.id, acknowledged: true });
    }
    if (p.item?.type === "contextCompaction" && method === "item/completed") {
      const current = compactions.get(recencyKey(state.hostId, p.threadId));
      const olderCompletion = current?.requested && !current.itemId &&
        (previousItem?.status === 'completed' || !!p.turnId && completedTurns.has(p.turnId));
      if (!olderCompletion && (!current?.itemId || current.itemId === p.item.id)) {
        finishCompaction(p.threadId, p.turnId);
        if (state.activeThread?.id === p.threadId) toast("上下文已压缩");
      }
      void refreshContextUsage(state.hostId, p.threadId);
    }
    const compaction = compactions.get(recencyKey(state.hostId, p.threadId));
    if (compaction?.turnId === p.turnId && newItem && ['agentMessage', 'reasoning'].includes(item?.type || '') &&
        (method === 'item/started' || method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta'))
      finishCompaction(p.threadId, p.turnId);
  }
  if (method === 'thread/compacted' && p.threadId) {
    const items = currentItems(p.threadId);
    const turnId = compactionTurnId(p.threadId, p.turnId);
    if (!items.some(item => item.type === 'contextCompaction' && item.turnId === turnId)) {
      const item = { id: `legacy-compaction:${turnId || randomUUID()}`, type: 'contextCompaction', turnId, status: 'completed', legacyCompaction: true };
      upsertItem(items, item); noteItem(p.threadId, item.id);
    }
    const current = compactions.get(recencyKey(state.hostId, p.threadId));
    const olderCompletion = current?.requested && !current.turnId && p.turnId && completedTurns.has(p.turnId);
    if (!olderCompletion) finishCompaction(p.threadId, turnId);
    void refreshContextUsage(state.hostId, p.threadId);
  }
  if (method === "turn/started") {
    if (state.activeThread?.id === p.threadId) state.permissionChangePending = false;
    const compaction = compactions.get(recencyKey(state.hostId, p.threadId));
    if (compaction?.requested && !compaction.turnId)
      compactions.set(recencyKey(state.hostId, p.threadId), { ...compaction, turnId: p.turn.id });
    hydrateTurnItems(p.threadId, p.turn);
    if (completedTurns.has(p.turn.id)) return;
    state.agentActivity[p.threadId] = { status: 'running', startedAt: Date.now(), updatedAt: Date.now(), turnId: p.turn.id, turnStatus: p.turn.status || 'inProgress' };
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
    if (state.activeThread?.id === p.threadId) state.permissionChangePending = false;
    const compaction = compactions.get(recencyKey(state.hostId, p.threadId));
    const completesUnboundCompaction = !compaction?.turnId && (!compaction?.requested ||
      p.turn?.items?.some((item: DisplayItem) => item.type === 'contextCompaction' &&
        !currentItems(p.threadId).some(previous => previous.id === item.id && previous.status === 'completed')));
    if (compaction && (compaction.turnId === p.turn?.id || completesUnboundCompaction)) {
      finishCompaction(p.threadId, p.turn?.id, p.turn?.status === 'completed', p.turn?.status);
      if (p.turn?.status !== 'completed') for (const item of currentItems(p.threadId)) {
        if (item.type === 'contextCompaction' && item.turnId === p.turn?.id && item.status === 'inProgress') item.status = p.turn?.status || 'failed';
      }
    }
    completedTurns.add(p.turn.id);
    hydrateTurnItems(p.threadId, p.turn, undefined, false);
    state.agentActivity[p.threadId] = { ...state.agentActivity[p.threadId], status: p.turn.status === 'failed' ? 'errored' : p.turn.status, updatedAt: Date.now(), turnId: p.turn.id, turnStatus: p.turn.status };
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
  if (method === "thread/tokenUsage/updated" && p.threadId) {
    applyTokenUsage(p.threadId, p.tokenUsage);
  }
  if (p.threadId === state.activeThread?.id) {
    if (method === "turn/diff/updated") state.diff = p.diff;
    if (method === "turn/plan/updated") state.plan = p.plan;
    if (method === "error") state.error = p.error?.message ?? "app-server 错误";
  }
  if (method === "command/exec/outputDelta" &&
    (p.processId === state.terminalProcessId || state.terminalProcesses.some(process => process.processId === p.processId))) {
    const key = `${state.hostId}:${p.processId}:${p.stream}`;
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
      p.processId,
    );
    if (p.capReached) appendTerminal("\r\n[输出已截断]\r\n", p.processId);
  }
}
function connect(): Promise<void> {
  if (!state.hostId || !state.hosts.some(host => host.id === state.hostId))
    return Promise.reject(new Error('请先添加或启用一个执行主机'));
  if (!state.online) return Promise.reject(new Error("目前离线，请联网后重试。"));
  if (state.connected && socket?.readyState === WebSocket.OPEN)
    return Promise.resolve();
  if (connecting) return connecting;
  clearTimeout(reconnectTimer);
  const host = state.hostId;
  const authentication = authenticationGeneration;
  const retained = hostConnections.get(host);
  if (retained && retained.authentication === authentication &&
      (retained.socket.readyState === WebSocket.CONNECTING || retained.socket.readyState === WebSocket.OPEN) &&
      (!retained.status || retained.status.connected || retained.status.paused)) {
    retained.usedAt = Date.now();
    socket = retained.socket;
    replayedConnection = null;
    if (retained.status) {
      receive({ method: 'bridge/status', params: { ...retained.status,
        // These can change without a status broadcast; the full return probe
        // supplies authoritative values before any actions are enabled.
        pendingRequests: undefined, activeProcesses: undefined,
        eventSequence: retained.sequence ?? retained.status.eventSequence } });
      // Notifications belonging to an inactive host never mutate the active
      // view. A fresh history read must reconcile them before sending again.
      if (retained.gap) { socketHasEventGap = true; ++eventGapRevision; }
    }
    const connection = retained.ready.finally(() => { if (connecting === connection) connecting = null; });
    connecting = connection;
    return connection;
  }
  if (retained) retireHostConnection(host);
  while (hostConnections.size >= MAX_HOST_CONNECTIONS) {
    const oldest = [...hostConnections.values()].sort((a, b) => a.usedAt - b.usedAt)[0];
    if (!oldest) break;
    retireHostConnection(oldest.hostId);
  }
  seenThreadChanges.clear();
  let context!: HostConnection;
  const attempt = new Promise<void>((resolve, reject) => {
    const resumeEvents = engineId && eventSequence !== null && !socketHasEventGap
      ? `&engineId=${encodeURIComponent(engineId)}&afterSequence=${eventSequence}` : '';
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/rpc?host=${encodeURIComponent(host)}&clientId=${clientId}${resumeEvents}`,
    );
    context = { hostId: host, authentication, socket: ws, ready: Promise.resolve(), status: null,
      usedAt: Date.now(), engineId, sequence: eventSequence, gap: socketHasEventGap };
    hostConnections.set(host, context);
    socket = ws;
    replayedConnection = null;
    const active = () => socket === ws && state.hostId === host && authenticationGeneration === authentication;
    const owned = () => hostConnections.get(host) === context && authenticationGeneration === authentication;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("app-server 连接超时"));
    }, 30000);
    ws.onmessage = (event) => {
      if (!owned()) return;
      try {
        const message = JSON.parse(event.data);
        if (message.method === 'bridge/status') {
          context.status = message.params;
          if (typeof message.params?.engineId === 'string' && context.engineId !== message.params.engineId) {
            context.engineId = message.params.engineId;
            context.sequence = null;
            context.gap = true;
          }
          if (typeof message.params?.eventSequence === 'number') context.sequence = message.params.eventSequence;
        }
        if (active()) {
          receive(message);
          context.engineId = engineId;
          context.sequence = eventSequence;
          context.gap = socketHasEventGap;
          if (message.method === 'bridge/status' && message.params?.replayComplete === true &&
              message.params?.engineId === engineId && !socketHasEventGap) {
            replayedConnection = { socket: ws, engineId: engineId! };
          }
        } else {
          if (typeof message.bridgeEventSequence === 'number') {
            context.sequence = Math.max(context.sequence ?? 0, message.bridgeEventSequence);
            context.gap = true;
          } else if (message.method && message.method !== 'bridge/status') context.gap = true;
          // These journals are global to the authenticated browser. Other
          // host/thread notifications remain isolated until that host returns.
          if (['bridge/host-order/changed', 'bridge/project-order/changed', 'bridge/prompt-presets/changed'].includes(message.method)) receive(message);
          if (message.method === 'bridge/host-disabled') void refreshHostAvailability().catch(() => {});
        }
        if (message.method === "bridge/status" && (message.params?.connected || message.params?.paused)) {
          clearTimeout(timer); resolve();
        }
        if (message.method === "bridge/status" && message.params?.error) {
          clearTimeout(timer); reject(new Error(message.params.error)); ws.close();
        }
      } catch (error) { if (active()) fail(error); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("无法连接工作站")); };
    ws.onclose = (event) => {
      clearTimeout(timer);
      if (hostConnections.get(host) === context) hostConnections.delete(host);
      if (!active()) {
        reject(new Error("后台主机连接已断开"));
        if (authentication === authenticationGeneration && state.authenticated) {
          if (event.code === 4003) void validateSession().catch(() => {});
          if (event.code === 4004) void refreshHostAvailability().catch(() => {});
        }
        return;
      }
      localReverts.clear();
      saveConversationSnapshot();
      state.connected = false;
      if (state.activeThread) state.threadReady = false;
      ++selectionGeneration;
      state.selectingThread = false;
      disconnectedWithMutation ||= [...pending.values()].some(entry =>
        !['bridge/ping', 'thread/read', 'thread/turns/list', 'thread/goal/get'].includes(entry.method) &&
        !entry.method.endsWith('/read') && !entry.method.endsWith('/list'));
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(Object.assign(new Error("连接已断开，服务端可能已接收；重连后请确认对话"), { uncertain: true }));
      }
      pending.clear();
      reject(new Error("连接已断开"));
      if (event.code === 4004) {
        if (state.authenticated) void refreshHostAvailability().catch(error => fail(error));
        return;
      }
      if (event.code === 4003) {
        void validateSession().then(session => {
          if (session?.authenticated && socket === ws) scheduleReconnect();
        }).catch(error => {
          if (socket !== ws || !state.authenticated) return;
          fail(error); scheduleReconnect();
        });
        return;
      }
      if (event.code === 4001) {
        clientId = randomUUID();
        browserStorage.session.setItem("codex.clientId", clientId);
      }
      if (state.authenticated) scheduleReconnect();
    };
  });
  const connection = attempt.finally(() => { if (connecting === connection) connecting = null; });
  context.ready = connection;
  connecting = connection;
  return connection;
}
function scheduleReconnect(delay = 2500) {
  clearTimeout(reconnectTimer);
  if (state.authenticated && state.online && !state.runtimePaused && state.hosts.some(host => host.id === state.hostId))
    reconnectTimer = setTimeout(() => { void resumeConnection(); }, delay);
}
async function probeConnection(options: { includeState?: boolean } = {}) {
  const selectedSocket = socket, selectedHost = state.hostId, authentication = authenticationGeneration, hostGeneration = hostSelectionGeneration;
  const current = () => socket === selectedSocket && state.hostId === selectedHost && authentication === authenticationGeneration && hostGeneration === hostSelectionGeneration;
  let status: any;
  try { status = await rpc('bridge/ping', options, 5000, { silentError: true }); }
  catch (error) {
    if ((error as any)?.code !== -32601) throw error;
  }
  if (!current()) return;
  if (options.includeState && status?.stateIncluded !== true) throw new Error('需要重新读取主机状态快照');
  if (typeof status?.connected !== 'boolean' || typeof status.engineId !== 'string') {
    // Compatibility with versions predating the lightweight bridge probe.
    await rpc('thread/loaded/list', { limit: 1 }, 5000, { silentError: true });
    return;
  }
  if (!current()) return;
  const context = hostConnections.get(selectedHost);
  if (context?.socket === selectedSocket) context.status = { ...context.status, ...status };
  receive({ method: 'bridge/status', params: status });
  if (state.activeThread?.id && Array.isArray(status.loadedThreadIds) &&
      !status.loadedThreadIds.includes(state.activeThread.id)) {
    writerAttachment = null;
    state.threadReady = false;
  }
  if (!status.connected || status.paused) throw new Error('工作站尚未连接');
  return status;
}
function resumeConnection(options: { explicit?: boolean } = {}): Promise<void> {
  if (!state.hostId || !state.hosts.some(host => host.id === state.hostId)) return Promise.resolve();
  if (state.runtimePaused && !options.explicit) return Promise.resolve();
  if (options.explicit) { state.runtimePaused = false; pausedHosts.delete(state.hostId); }
  if (!state.online || !state.authenticated || state.loading || state.switchingHost)
    return Promise.resolve();
  const generation = hostSelectionGeneration;
  const selection = selectionGeneration;
  const hostId = state.hostId;
  if (connectionRecovery?.generation === generation) return connectionRecovery.promise;
  const current = () => state.online && state.authenticated && !state.loading &&
    !state.switchingHost && hostId === state.hostId && generation === hostSelectionGeneration &&
    selection === selectionGeneration;
  clearTimeout(reconnectTimer);
  const recovery = (async () => {
    try {
      const previous = socket;
      let retainedWriterConfirmed = false;
      if (state.connected && previous?.readyState === WebSocket.OPEN) {
        // Android can resume a socket that still reports OPEN but no longer carries data.
        // Probe with a bounded, read-only request; never replay user commands.
        try { await probeConnection(); }
        catch {
          if (!current() || socket !== previous) return;
          closeConnection();
        }
        if (!current() || (socket && socket !== previous)) return;
        if (state.connected && socket === previous && !socketHasEventGap && engineId &&
            (!state.activeThread || (state.threadReady && writerAttachment?.threadId === state.activeThread.id))) {
          // The native stream is continuous. A foreground/focus event does
          // not reacquire a writer or reload unchanged history/configuration.
          if (state.goalReadError) void refreshCurrentGoal();
          return;
        }
      } else if (!connecting) closeConnection();
      if (!current()) return;
      // Authenticate when opening a replacement transport. A healthy socket is
      // already authenticated, so routine foreground probes need no HTTP login.
      if (!state.connected || (state.activeThread && !state.threadReady)) {
        const session = await validateSession();
        if (!session?.authenticated || !current()) return;
      }
      await connect();
      if (!current()) return;
      if (state.runtimePaused || !state.connected) return;
      if (previous !== socket && writerAttachment?.engineId === engineId && engineId) {
        // The engine can retain other threads while this particular writer was
        // released. Confirm this attachment before keeping send enabled.
        const status = await probeConnection();
        retainedWriterConfirmed = Array.isArray(status?.loadedThreadIds) &&
          status.loadedThreadIds.includes(state.activeThread?.id);
        if (!current()) return;
      }
      startNavigationRefresh();
      if (previous !== socket && replayedConnection?.socket === socket && replayedConnection.engineId === engineId &&
          !socketHasEventGap && !disconnectedWithMutation && retainedWriterConfirmed && state.activeThread?.id &&
          writerAttachment?.hostId === hostId && writerAttachment.threadId === state.activeThread.id &&
          writerAttachment.engineId === engineId && !state.threadConflict && !state.threadReleased &&
          !state.selectingThread && !revertedTurnCandidates.has(state.activeThread.id)) {
        // Only a complete replay plus the bridge's loaded-writer probe can
        // certify the retained view. Disk cache and a bare OPEN socket cannot.
        state.threadReady = true;
        void refreshContextUsage(hostId, state.activeThread.id);
        if (state.goalReadError) void refreshCurrentGoal();
        return;
      }
      if (state.activeThread?.id && writerAttachment?.hostId === hostId &&
          writerAttachment.threadId === state.activeThread.id && writerAttachment.engineId &&
          writerAttachment.engineId === engineId) {
        await selectThread(state.activeThread.id, { preserveWriter: true });
      } else if (previous === socket && state.connected && state.threadReady) {
        // Compatibility with old servers: read missed history without forcing
        // an unchanged native writer through thread/resume on every focus.
        if (state.activeThread?.id) await selectThread(state.activeThread.id, { preserveWriter: true });
        else await refreshThreads();
      } else await sync();
    } catch (error) {
      if (current()) fail(error);
    } finally {
      if (current() && !state.connected && !state.runtimePaused) scheduleReconnect();
    }
  })();
  const promise = recovery.finally(() => {
    if (connectionRecovery?.promise === promise) connectionRecovery = null;
  });
  connectionRecovery = { generation, promise };
  return promise;
}
async function bootstrap() {
  // A fresh bootstrap owns its server's order; never carry another login's
  // presentation journal into it. Events received during the fetch still win.
  latestProjectOrder = [];
  ++projectOrderRevision;
  const data = await http("/bootstrap");
  promptPresets.hydrate(data.promptPresets);
  localCwd = data.cwd;
  state.hosts = data.hosts;
  state.localEnabled = data.localEnabled ?? state.hosts.some(host => host.id === 'local');
  replaceProjects(data.projects);
  state.connectionMode = data.connectionMode;
  // Bootstrap carries this small journal to avoid an extra navigation round trip.
  if (Array.isArray(data.asyncQuestionNoticeDismissals)) asyncQuestionNotices.hydrate(data.asyncQuestionNoticeDismissals);
  else void asyncQuestionNotices.refresh(true).catch(() => {});
  pausedHosts.clear();
  releasedThreads.clear();
  for (const entry of data.runtimeReleasedThreads || []) {
    if (!releasedThreads.has(entry.hostId)) releasedThreads.set(entry.hostId, new Set());
    releasedThreads.get(entry.hostId)!.add(entry.threadId);
  }
  for (const id of data.runtimePausedHostIds || []) if (typeof id === 'string') pausedHosts.add(id);
  if (data.preferences)
    state.preferences = { ...state.preferences, ...data.preferences,
      defaultPermissionExplicit: data.preferences.defaultPermissionExplicit ??
        (Object.hasOwn(data.preferences, 'defaultPermission') ? undefined : false) };
  else {
    try {
      const stored = await http("/preferences");
      if (stored.preferences)
        state.preferences = { ...state.preferences, ...stored.preferences,
          defaultPermissionExplicit: stored.preferences.defaultPermissionExplicit ??
            (Object.hasOwn(stored.preferences, 'defaultPermission') ? undefined : false) };
    } catch {
      state.error = "";
    }
  }
  const preferredHost = saved("codex.hostId", "local");
  state.hostId = state.hosts.some((h) => h.id === preferredHost)
    ? preferredHost
    : state.hosts[0]?.id || "";
  state.runtimePaused = pausedHosts.has(state.hostId);
  state.terminalProcessId = terminalIds()[state.hostId] || "";
  const preferred = saved<Record<string, string>>("codex.projectPaths", {})[
    state.hostId
  ];
  const selectedHost = state.hosts.find((h) => h.id === state.hostId);
  if (!selectedHost) {
    await setHost("");
    return;
  }
  state.projectPath =
    preferred ??
    selectedHost?.cwd ??
    (selectedHost?.kind === "ssh" ? "/tmp" : localCwd);
  state.noProject = saved<Record<string, boolean>>('codex.projectlessHosts', {})[state.hostId] === true;
  const preferredThread = saved<Record<string, string>>(
    "codex.selectedThreadIds",
    {},
  )[state.hostId];
  // Restore the target before connecting or loading optional host integrations.
  // A slow/offline SSH host must not turn a saved conversation into a new chat.
  const generation = selectionGeneration;
  const hostId = state.hostId;
  if (preferredThread) {
    state.activeThread = state.threads.find(thread => thread.id === preferredThread) || { id: preferredThread };
    state.noProject = isProjectlessThread(state.activeThread);
    state.threadReleased = releasedThreads.get(hostId)?.has(preferredThread) || false;
    state.threadReady = false;
    state.selectingThread = true;
    await cacheActivation;
    const snapshot = await conversationCache.read(hostId, preferredThread);
    if (snapshot && generation === selectionGeneration && hostId === state.hostId)
      applyConversationSnapshot(snapshot, preferredThread);
  }
  startNavigationRefresh();
  for (const host of state.hosts)
    if (host.id !== state.hostId && !pausedHosts.has(host.id)) void refreshHostNavigation(host.id);
  try {
    await connect();
    if (generation !== selectionGeneration || hostId !== state.hostId || state.runtimePaused) return;
    await Promise.all([
      sync(false),
      preferredThread ? selectThread(preferredThread) : Promise.resolve(),
    ]);
  } finally {
    if (generation === selectionGeneration && hostId === state.hostId) state.selectingThread = false;
  }
}
function startNavigationRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (state.authenticated && !document.hidden) void refreshNavigation();
  }, state.connected ? 60000 : 15000);
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
  advanceAuthentication();
  clearConversationCaches();
  state.selectingThread = false;
  state.threadConflict = null;
  state.takingOverThread = false;
  ++takeoverOperation;
  closeConnection();
  resetModeContext(true);
  permissionSelections.clear();
  localReverts.clear();
  discardedTurns.clear();
  completedTurns.clear();
  seenThreadChanges.clear();
  revertedTurnCandidates.clear();
  pendingMessageEdit = null;
  state.loading = true;
  state.error = "";
  try {
    const session = await http("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    advanceAuthentication();
    csrfToken = session.csrfToken;
    state.authenticated = true;
    await activateConversationCache();
    await bootstrap();
  } finally {
    state.loading = false;
  }
}
async function logout() {
  advanceAuthentication();
  if (typeof window !== "undefined" && "serviceWorker" in navigator) {
    // Server logout is authoritative; an unavailable browser unsubscribe cannot block it.
    void revokeDevicePush({ requestHttp: http, runtimeIdentity }, { logout: true });
  }
  await http("/auth/logout", { method: "POST" });
  advanceAuthentication();
  csrfToken = "";
  state.authenticated = false;
  clearConversationCaches();
  state.selectingThread = false;
  state.threadConflict = null;
  state.takingOverThread = false;
  ++takeoverOperation;
  closeConnection();
  resetModeContext(true);
  permissionSelections.clear();
  localReverts.clear();
  discardedTurns.clear();
  completedTurns.clear();
  seenThreadChanges.clear();
  revertedTurnCandidates.clear();
  pendingMessageEdit = null;
  clearAttachments();
  state.items = [];
  state.threads = [];
  state.navigation = {};
  for (const host of state.hosts)
    advanceNavigationRevision(host.id);
  state.activeThread = null;
  state.pendingRequests = [];
  state.agentActivity = {};
  state.terminalRunning = false;
  state.terminalProcessId = "";
  state.terminalOutput = "";
  state.terminalProcesses = [];
  browserStorage.session.setItem("codex.terminalProcessIds", "{}");
  terminalDecoders.clear();
  terminalSessionNames.clear();
  completedTerminalProcesses.clear();
  compactionResults.clear();
}
function setOnline(online: boolean) {
  state.online = online;
  if (!online) { closeConnection(); retireHostConnections(); }
}
async function sync(refreshActive = true) {
  if (state.runtimePaused || !state.connected) return;
  const hostId = state.hostId;
  const selectedId = state.activeThread?.id;
  const historyRefresh = refreshActive && selectedId ? selectThread(selectedId, { preserveWriter: true }) : Promise.resolve();
  await Promise.allSettled([refreshThreads(), readConfig(), loadModeCapabilities(), loadSkills(), historyRefresh]);
  if (
    hostId === state.hostId &&
    selectedId === state.activeThread?.id &&
    selectedId
  )
    void refreshGoal(hostId, selectedId);
}
async function refreshThreads() {
  if (state.runtimePaused) return;
  const generation = ++listGeneration;
  const requestScope = state.hostId;
  const revision = threadEventSequence;
  const nameRevisions = new Map(threadNameRevisions);
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
      const live = state.threads.find((current) => current.id === thread.id)
        ?? (state.activeThread?.id === thread.id ? state.activeThread : undefined);
      return {
        ...thread,
        ...(live && (threadRevisions.get(thread.id) ?? 0) > revision ? live : {}),
        ...listedThreadLabels(thread, requestScope, nameRevisions),
      };
    });
  const seen = new Set(fresh.map((thread: any) => thread.id));
  const changed = state.threads.filter(
    (thread) =>
      !seen.has(thread.id) &&
      !removedThreads.has(thread.id) &&
      (threadRevisions.get(thread.id) ?? 0) > revision,
  );
  for (const thread of changed) seen.add(thread.id);
  const previousTitles = new Map(state.threads.map(thread => [thread.id, searchableThreadTitle(thread)]));
  state.threads = [
    ...changed,
    ...fresh,
    ...(preservePagination
      ? state.threads.filter(
          (thread) => !seen.has(thread.id) && !removedThreads.has(thread.id),
        )
      : []),
  ];
  if (state.threads.length !== previousTitles.size || state.threads.some(thread => previousTitles.get(thread.id) !== searchableThreadTitle(thread)))
    invalidateThreadTitleSearch(requestScope);
  const active = state.activeThread;
  const listed = active && fresh.find((thread: any) => thread.id === active.id);
  if (listed && (listed.name !== active.name || listed.preview !== active.preview)) {
    // A list refresh updates labels, never the writer's live turn/status state.
    const key = recencyKey(requestScope, active.id);
    threadNameRevisions.set(key, (threadNameRevisions.get(key) ?? 0) + 1);
    state.activeThread = { ...active, name: listed.name, preview: listed.preview };
    saveConversationSnapshot();
  }
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
  const nameRevisions = new Map(threadNameRevisions);
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
    ).map((thread: any) => ({ ...thread, ...listedThreadLabels(thread, requestScope, nameRevisions) })),
  );
  loadedMorePages = true;
  loadedGlobalPages = true;
  threadCursor = result.nextCursor;
  state.moreThreads = !!threadCursor;
}
async function loadProjectThreads(projectPath: string, more = false) {
  const hostId = state.hostId;
  const authentication = authenticationGeneration;
  const revision = projectPageRevisions.get(hostId) ?? 0;
  const current = state.projectThreadPages[projectPath];
  if (!more && current?.loaded) return;
  const cursor = more ? current?.cursor : undefined;
  if (more && !cursor) return;
  const nameRevisions = new Map(threadNameRevisions);
  const result = await projectThreadPage(hostId, projectPath, more ? current : undefined);
  if (hostId !== state.hostId || authentication !== authenticationGeneration ||
      !state.authenticated || revision !== (projectPageRevisions.get(hostId) ?? 0)) return;
  const known = new Set(state.threads.map((thread) => thread.id));
  state.threads.push(
    ...result.data.filter(
      (thread: any) => !known.has(thread.id) && !removedThreads.has(thread.id),
    ).map((thread: any) => ({ ...thread, ...listedThreadLabels(thread, hostId, nameRevisions) })),
  );
  loadedMorePages = true;
  state.projectThreadPages[projectPath] = result.page;
}
async function history(
  threadId: string,
  cursor: string | null = null,
  hostId = state.hostId,
  full = false,
) {
  const page = await historyReader.turns(JSON.stringify([authenticationGeneration, hostId, engineId]),
    (method, params) => scopedRpc(hostId, method, params), {
    threadId,
    cursor,
    limit: 30,
    sortDirection: "desc",
  }, full);
  for (const turn of page.data) {
    if (turn.status !== 'interrupted' && turn.status !== 'failed') continue;
    const items = (turn.items || []).map((item: DisplayItem) => ({ ...item, turnId: turn.id }));
    if (settleInterruptedTurnItems(items, turn).length) turn.items = items;
  }
  return page;
}

function loadTurnDetails(turnId: string): Promise<void> {
  const threadId = state.activeThread?.id;
  const turn = state.turns.find(entry => entry.id === turnId);
  if (!threadId || !turn?.historySummary) return Promise.resolve();
  if (!state.connected || state.runtimePaused) return Promise.reject(new Error('连接恢复后可读取过程记录。'));
  const hostId = state.hostId, generation = selectionGeneration, authentication = authenticationGeneration;
  const requestSocket = socket, requestEngine = engineId, revision = itemEventSequence;
  const scope = JSON.stringify([authentication, hostId, requestEngine]);
  const key = JSON.stringify([scope, generation, threadId, turnId]);
  const pending = historyDetailRequests.get(key);
  if (pending) return pending;
  const current = () => hostId === state.hostId && generation === selectionGeneration &&
    authentication === authenticationGeneration && socket === requestSocket && engineId === requestEngine &&
    threadId === state.activeThread?.id && !discardedTurns.has(turnId);
  const operation = (async () => {
    const page = await historyReader.items(scope, (method, params) => rpc(method, params, 45000, { silentError: true }), threadId, turn);
    if (!current()) return;
    const index = state.turns.findIndex(entry => entry.id === turnId);
    if (index < 0 || !state.turns[index].historySummary) return;
    const changed = new Set([...(itemRevisions.get(threadId)?.entries() || [])]
      .filter(([, value]) => value > revision).map(([id]) => id));
    const merged = mergeHistoryDetails(state.items, state.turns, state.turns[index], page, changed);
    state.items = merged.items;
    settleLoadedToolItems(state.items, [merged.turn]);
    rememberAsyncQuestions(threadId, state.items);
    state.turns[index] = merged.turn;
    itemCache.set(threadId, state.items);
    saveConversationSnapshot();
  })().finally(() => { if (historyDetailRequests.get(key) === operation) historyDetailRequests.delete(key); });
  historyDetailRequests.set(key, operation);
  return operation;
}
async function revealBookmarkSource(source: ConversationBookmarkSource) {
  const hostId = state.hostId, generation = selectionGeneration, authentication = authenticationGeneration;
  const current = () => hostId === state.hostId && generation === selectionGeneration && authentication === authenticationGeneration &&
    state.activeThread?.id === source.threadId && state.threadReady && !state.selectingThread;
  if (!current() || state.threadConflict || state.runtimePaused || state.threadReleased) throw new Error('请先恢复并同步此会话，再定位收藏');
  const restoring = historyRestoration;
  if (restoring?.threadId === source.threadId && restoring.generation === generation) await restoring.promise;
  if (!current()) throw new Error('会话已切换，已取消收藏定位');
  const removePreviousTarget = () => {
    const old = new Set(state.turns.filter(turn => turn.historyBookmarkTarget && turn.id !== source.turnId).map(turn => turn.id));
    state.turns = state.turns.filter(turn => !old.has(turn.id));
    state.items = state.items.filter(item => !old.has(item.turnId));
  };
  if (!state.turns.find(turn => turn.id === source.turnId)?.historyBookmarkTarget &&
      state.items.some(item => item.id === source.itemId && item.turnId === source.turnId && !item.cacheTruncated)) {
    removePreviousTarget(); saveConversationSnapshot(); return;
  }
  const revision = itemEventSequence;
  // Locate one native turn directly. Loading a bookmark must not download all
  // intervening turns or every command output in a large conversation.
  let cursor: string | null = null;
  const cursors = new Set<string>(), messages = new Map<string, DisplayItem>(), nativeOrder: string[] = [];
  let found = false;
  for (let pageIndex = 0; pageIndex < 250; pageIndex++) {
    const page: any = await rpc('thread/items/list', { threadId: source.threadId, turnId: source.turnId,
      cursor, limit: 40, sortDirection: 'asc' }, 45000, { silentError: true });
    if (!current()) throw new Error('会话已切换，已取消收藏定位');
    if (!Array.isArray(page.data) || page.data.some((entry: any) => entry.turnId !== source.turnId || typeof entry.item?.id !== 'string' || !entry.item.id))
      throw new Error('收藏对应的历史记录已变化，请同步后重试');
    for (const entry of page.data) {
      nativeOrder.push(entry.item.id);
      if (['agentMessage', 'userMessage', 'contextCompaction'].includes(entry.item.type))
        messages.set(entry.item.id, { ...entry.item, turnId: source.turnId });
      if (entry.item.id === source.itemId) found = true;
    }
    if (found) break;
    cursor = page.nextCursor;
    if (!cursor) break;
    if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('收藏定位的历史分页未能继续，请同步后重试');
    cursors.add(cursor);
  }
  if (!found) throw new Error('未找到收藏的原消息，消息可能已被回退或删除；收藏内容仍保留');
  removePreviousTarget();
  const existing = state.turns.find(turn => turn.id === source.turnId);
  if (!existing) state.turns.unshift({ id: source.turnId, items: [...messages.values()], itemsView: 'summary',
    historySummary: true, historyItemsStarted: false, historyItemsCursor: null, historyItemIds: [], historyBookmarkTarget: true });
  const live = [...state.items];
  const known = live.filter(item => item.turnId === source.turnId);
  const changed = new Set(known.filter(item => (itemRevisions.get(source.threadId)?.get(item.id) || 0) > revision).map(item => item.id));
  const merged = mergeBookmarkMessages(known, [...messages.values()], changed, nativeOrder);
  const before = state.turns.findIndex(turn => turn.id === source.turnId);
  const later = new Set(state.turns.slice(before + 1).map(turn => turn.id));
  const other = live.filter(item => item.turnId !== source.turnId);
  const insertion = other.findIndex(item => item.turnId && later.has(item.turnId));
  other.splice(insertion < 0 ? other.length : insertion, 0, ...merged);
  state.items = other;
  if (!existing) historyWindowTruncated = true;
  rememberAsyncQuestions(source.threadId, state.items);
  itemCache.set(source.threadId, state.items);
  saveConversationSnapshot();
}
function rememberThread(id: string) {
  const selections = saved<Record<string, string>>(
    "codex.selectedThreadIds",
    {},
  );
  selections[state.hostId] = id;
  browserStorage.local.setItem("codex.selectedThreadIds", JSON.stringify(selections));
}
function selectThread(id: string, options: { preserveWriter?: boolean } = {}): Promise<void> {
  if (selectionOperation?.hostId === state.hostId && selectionOperation.threadId === id &&
      selectionOperation.generation === selectionGeneration && selectionOperation.socket === socket &&
      selectionOperation.authentication === authenticationGeneration) return selectionOperation.promise;
  const hostId = state.hostId, selectionSocket = socket, authentication = authenticationGeneration;
  const operation = selectThreadOnce(id, options);
  const promise = operation.finally(() => {
    if (selectionOperation?.promise === promise) selectionOperation = null;
  });
  selectionOperation = { hostId, threadId: id, generation: selectionGeneration, socket: selectionSocket, authentication, promise };
  return promise;
}
async function selectThreadOnce(id: string, options: { preserveWriter?: boolean } = {}) {
  if (deletedThreads.has(recencyKey(state.hostId, id))) throw new Error('此对话已删除，请选择其他对话');
  cancelGoalRefresh();
  const preserveWriter = options.preserveWriter === true && state.activeThread?.id === id &&
    !state.threadConflict && !state.threadReleased && !state.runtimePaused &&
    (state.threadReady || (writerAttachment?.hostId === state.hostId && writerAttachment.threadId === id &&
      !!engineId && writerAttachment.engineId === engineId));
  const generation = ++selectionGeneration;
  const hostId = state.hostId;
  const authentication = authenticationGeneration;
  const selectionSocket = socket;
  const selectionEngine = engineId;
  const current = () => generation === selectionGeneration && hostId === state.hostId
    && authentication === authenticationGeneration && socket === selectionSocket && engineId === selectionEngine;
  if (state.threadConflict) state.error = '';
  state.threadConflict = null;
  state.takingOverThread = false;
  ++takeoverOperation;
  const previousId = state.activeThread?.id;
  if (previousId !== id) {
    // A user's new selection ends the original thread's temporary metadata
    // protection; returning later must load that thread's own choices.
    if (metadataReconnectChoices?.hostId === hostId) metadataReconnectChoices = null;
    pendingMessageEdit = null;
    state.selectedSkills = [];
    ++modeOperation;
    state.modeBusy = false;
    state.modeError = "";
    state.goalReadError = "";
  }
  const modeKey = recencyKey(hostId, id);
  const compactionRevision = compactionRevisions.get(modeKey) || 0;
  const nameRevision = threadNameRevisions.get(modeKey) ?? 0;
  const rememberedMode = conversationModes.get(modeKey) || (previousId === id ? (state.goalMode ? 'goal' : state.collaborationMode) : 'default');
  state.collaborationMode = rememberedMode === 'plan' ? 'plan' : 'default';
  if (previousId !== id) state.permissionChangePending = false;
  state.goalMode = rememberedMode === 'goal';
  state.goal = goals.get(modeKey) || null;
  state.goalTokenBudget = state.goal?.tokenBudget ?? null;
  const previousProfileId = state.activePermissionProfileId;
  const previousPolicy = state.runtimePolicy;
  saveConversationSnapshot();
  state.selectingThread = true;
  if (!preserveWriter) state.threadReady = false;
  if (!preserveWriter && !preserveMetadataChoices()) state.runtimePolicy = null;
  const runtimeRevision = turnRevisions.get(id) ?? 0;
  const itemRevision = itemEventSequence;
  const continuityRevision = eventGapRevision;
  if (state.activeThread) itemCache.set(state.activeThread.id, state.items);
  const cached = conversationCache.peek(hostId, id);
  const loadedHistory = itemCache.history(id);
  const previousPreview = previousId === id ? state.activeThread?.preview : undefined;
  const threadMetadata = state.threads.find((t) => t.id === id) ?? cached?.thread ?? { id };
  state.activeThread = {
    ...threadMetadata,
    ...(!threadMetadata.preview && (cached?.thread?.preview || previousPreview)
      ? { preview: cached?.thread?.preview || previousPreview } : {}),
  };
  state.noProject = isProjectlessThread(state.activeThread);
  state.items = itemCache.get(id) ?? cached?.items ?? [];
  rememberAsyncQuestions(id, state.items);
  state.turns = loadedHistory?.turns ?? cached?.turns ?? (previousId === id ? state.turns : []);
  historyWindowTruncated = (loadedHistory?.historyTruncated ?? cached?.historyTruncated) === true;
  state.tokenUsage = tokenUsages.has(modeKey) ? tokenUsages.get(modeKey) : cached?.tokenUsage ?? null;
  if (cached && !tokenUsages.has(modeKey)) tokenUsages.set(modeKey, cached.tokenUsage);
  state.diff = "";
  state.plan = [];
  state.busy = activeTurns.has(id);
  state.compacting = compactions.has(modeKey);
  turnCursor = loadedHistory ? loadedHistory.cursor : cached?.cursor ?? null;
  state.moreTurns = !!turnCursor;
  rememberThread(id);
  // IndexedDB is a painting aid only. Its delayed answer cannot overwrite live
  // events, a different selection, or a successful native resume.
  if (!cached && !state.items.length) {
    void conversationCache.read(hostId, id).then(snapshot => {
      if (snapshot && current() && !state.threadReady && itemEventSequence === itemRevision)
        applyConversationSnapshot(snapshot, id);
    });
  }
  state.threadReleased = releasedThreads.get(hostId)?.has(id) || false;
  if (state.runtimePaused) { state.selectingThread = false; return; }
  if (state.threadReleased) {
    state.busy = false;
    try {
      const page = await history(id, null, hostId);
      if (!current()) return;
      state.turns = [...page.data].reverse();
      state.items = state.turns.flatMap(turn => turn.items.map((item: any) => ({ ...item, turnId: turn.id })));
      rememberAsyncQuestions(id, state.items);
      itemCache.set(id, state.items); turnCursor = page.nextCursor; state.moreTurns = !!turnCursor;
    } catch (error) { if (current()) fail(error); }
    finally { if (current()) state.selectingThread = false; }
    return;
  }
  try {
    if (!preserveWriter) {
      await ensureConfiguration();
      if (!current()) return;
    }
    if (!preserveWriter && !preserveMetadataChoices()) applyPermissionDefault();
    const resumeSelection = explicitWebPermissionSelection(state.preferences, permissionSelections.get(modeKey));
    const resumeProfile = availablePermissionProfiles(state.preferences.permissionProfiles)
      .find(profile => profile.id === resumeSelection?.profileId);
    const webPermission = !preserveWriter ? resolveResumePermissionOverrides(resumeSelection, {
      profile: resumeProfile, cwd: state.activeThread?.cwd || state.projectPath, requirements: state.requirements,
    }) : {};
    const resumeRequest = preserveWriter ? rpc('thread/read', { threadId: id, includeTurns: false }, 45000, { silentError: true }) : rpc("thread/resume", {
      threadId: id,
      excludeTurns: true,
      ...webPermission,
      config: { ...webPermission.config, 'features.default_mode_request_user_input': true },
    }, 45000, { silentError: true });
    // History reads do not acquire a writer, so they can run beside resume.
    // Neither cached content nor this read authorizes sending until both finish.
    const [result, initialPage] = await Promise.all([resumeRequest, history(id, null, hostId)]);
    const page = initialPage;
    if (!current()) return;
    if (!result.thread?.id) throw new Error('无法恢复此对话，请同步后重试。');
    const depthValue = Number(browserStorage.session.getItem(`codex.historyDepth.${hostId}.${id}`));
    const requestedTurns = Math.max(30, state.turns.length,
      (Number.isFinite(depthValue) ? Math.max(1, Math.min(1000, depthValue)) : 1) * 30);
    // Only reuse a previously validated window on the same continuous engine.
    // A latest-page anchor also proves that an unnoticed native truncation did
    // not remove its prefix. Painting cached history never confirms a writer.
    const cachedTail = loadedHistory?.turns.at(-1)?.id;
    const recentIds = new Set<string>(page.data.map((turn: any) => turn.id));
    const reuseHistory = !!loadedHistory && !loadedHistory.historyTruncated &&
      loadedHistory.engineId === selectionEngine && loadedHistory.eventGapRevision === continuityRevision &&
      !!cachedTail && recentIds.has(cachedTail) && !revertedTurnCandidates.has(id);
    const firstOverlap = reuseHistory ? loadedHistory!.turns.findIndex(turn => recentIds.has(turn.id)) : 0;
    const prefixTurns = reuseHistory && firstOverlap > 0 ? loadedHistory!.turns.slice(0, firstOverlap) : [];
    const prefixIds = new Set<string>(prefixTurns.map(turn => turn.id));
    // Native revert notifications precede their acknowledgement on some Codex
    // versions. The acknowledgement's thread.turns is always empty; confirm the
    // retained prefix from a fresh history read, keeping removed IDs blocked.
    const candidates = revertedTurnCandidates.get(id);
    if (candidates) {
      const retained = new Set(page.data.map((turn: any) => turn.id));
      for (const turnId of candidates.ids) if (retained.has(turnId)) discardedTurns.delete(turnId);
      if (!candidates.awaitingAcknowledgement) revertedTurnCandidates.delete(id);
    }
    const runtimeChanged = (turnRevisions.get(id) ?? 0) !== runtimeRevision;
    const latestStatus = state.activeThread?.status;
    const latestName = state.activeThread?.name;
    const latestPreview = state.activeThread?.preview;
    const nameChanged = (threadNameRevisions.get(modeKey) ?? 0) !== nameRevision;
    // Only a confirmed, complete empty head after a revert invalidates the
    // previous first-message preview; an ordinary empty page does not.
    const revertedEmpty = !!candidates && !runtimeChanged && !page.data.length && !page.nextCursor;
    const previousProject = state.projectPath;
    const preserveChoices = preserveMetadataChoices() && previousId === id;
    if (!preserveChoices) state.activePermissionProfileId = previousId === id ? previousProfileId : "";
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
      ...(revertedEmpty ? { preview: '' }
        : nameChanged && typeof latestPreview === 'string' ? { preview: latestPreview }
        : !result.thread.preview && latestPreview ? { preview: latestPreview } : {}),
      // A canonical response is authoritative for its snapshot, but new live
      // content may have arrived while resume/history hydration was in flight.
      recencyAt: runtimeChanged
        ? Math.max(resumedRecency, knownRecency ?? 0)
        : resumedRecency,
      ...(runtimeChanged && latestStatus ? { status: latestStatus } : {}),
      // Labels observed after this load began win over its older snapshot.
      ...(nameChanged && typeof latestName === 'string' ? { name: latestName } : {}),
    };
    if (result.thread.recencyAt == null)
      legacyRecency.set(recencyKey(hostId, id), {
        stamp: result.thread.updatedAt,
        value: state.activeThread.recencyAt,
      });
    updateThread(state.activeThread, { authoritativePreview: revertedEmpty });
    state.projectPath = result.thread.cwd ?? state.projectPath;
    if (result.collaborationMode?.mode === 'plan' || result.collaborationMode?.mode === 'default') {
      state.collaborationMode = result.collaborationMode.mode;
      if (state.collaborationMode === 'plan') state.goalMode = false;
    }
    if (!preserveChoices) state.model = result.model ?? result.thread.model ?? state.model;
    if ('serviceTier' in result) {
      state.nativeServiceTier = result.serviceTier ?? null;
      state.serviceTier = state.nativeServiceTier;
      state.serviceTierScope = serviceTierScope(state);
    } else if (previousId !== id) {
      state.nativeServiceTier = null;
      state.serviceTierScope = '';
    }
    if (!preserveChoices) state.effort =
      result.reasoningEffort ?? result.thread.reasoningEffort ?? state.effort;
    if (!preserveChoices) {
      // The native response includes saved network grants and the effective
      // managed policy. An implicit Web default must not erase either one.
      const currentSelection = explicitWebPermissionSelection(state.preferences, permissionSelections.get(modeKey));
      const selectedProfile = availablePermissionProfiles(state.preferences.permissionProfiles)
        .find(profile => profile.id === currentSelection?.profileId);
      const retainedWeb = preserveWriter && previousId === id && state.runtimePolicy?.source === 'web' &&
        currentSelection?.mode === sandboxName(state.runtimePolicy.sandboxPolicy.type)
        ? restoreRuntimePermissionPolicy({}, state.runtimePolicy) : null;
      applyPermissionDefault();
      const restored = restoreRuntimePermissionPolicy(result, previousId === id ? previousPolicy : null);
      if (retainedWeb) {
        const requirements = state.requirements;
        if (requirements?.allowedSandboxModes && !requirements.allowedSandboxModes.includes(currentSelection!.mode) ||
            requirements?.allowedApprovalPolicies && !requirements.allowedApprovalPolicies.some((policy: any) => JSON.stringify(policy) === JSON.stringify(retainedWeb.approvalPolicy)))
          throw new Error('保存的会话权限已不符合当前主机管理策略，请重新选择权限。');
        state.runtimePolicy = { ...retainedWeb, source: 'web' };
        state.permission = sandboxName(retainedWeb.sandboxPolicy.type);
      } else if (currentSelection) {
        // Resuming an already loaded thread may only rejoin its writer and
        // report the previous policy. Keep an explicit Web choice for the next
        // turn instead of accepting a broader policy from that response.
        const selected = resolveWebPermissionSelection(currentSelection.mode, {
          profile: selectedProfile, cwd: state.projectPath, requirements: state.requirements,
        });
        state.runtimePolicy = { sandboxPolicy: selected.sandboxPolicy, approvalPolicy: selected.approvalPolicy, source: 'web' };
        state.permission = selected.sandbox;
      } else if (restored) {
        state.runtimePolicy = { ...restored, source: 'native' };
        state.permission = sandboxName(restored.sandboxPolicy.type);
      }
    }
    const live = [...currentItems(id)];
    const liveTurns = runtimeChanged ? [...state.turns] : [];
    if (reuseHistory) page.data = retainHistoryDetails(page.data, loadedHistory!.turns, live);
    const bookmarkTurns = [...state.turns];
    state.turns = retainBookmarkTargets([...prefixTurns, ...[...page.data].reverse()], bookmarkTurns, live);
    for (const turn of liveTurns) if (!turn.historyBookmarkTarget) updateTurn(id, turn);
    const running = [...state.turns].reverse().find((turn) => turn.status === "inProgress");
    if (!runtimeChanged) {
      if (running) activeTurns.set(id, running.id);
      else activeTurns.delete(id);
      threadBusy.set(id, !!running || result.thread.status?.type === "active");
    }
    state.busy = threadBusy.get(id) ?? activeTurns.has(id);
    const loaded = [...live.filter(item => !!item.turnId && prefixIds.has(item.turnId)),
      ...state.turns.flatMap((turn) => (turn.items || []).map((item: any) => ({ ...item, turnId: turn.id })))];
    const changedIds = new Set(
      [...(itemRevisions.get(id)?.entries() ?? [])]
        .filter(([, revision]) => revision > itemRevision)
        .map(([itemId]) => itemId),
    );
    state.items = mergeSnapshotItems(loaded, live, changedIds, {
      retainedTurnIds: new Set(state.turns.map(turn => turn.id)),
      summarizedTurnIds: new Set(page.data.filter((turn: any) => turn.historySummary).map((turn: any) => turn.id)),
    });
    settleLoadedToolItems(state.items, state.turns);
    rememberAsyncQuestions(id, state.items);
    // Deprecated runtimes may expose compression only as thread/compacted.
    // Keep that positional marker while its recorded turn remains retained;
    // canonical ContextCompaction items replace it when they become available.
    for (const item of live) if (item.legacyCompaction && item.turnId &&
      state.turns.some(turn => turn.id === item.turnId) &&
      !state.items.some(entry => entry.type === 'contextCompaction' && entry.turnId === item.turnId)) upsertItem(state.items, item);
    itemCache.set(id, state.items);
    turnCursor = prefixTurns.length ? loadedHistory!.cursor : page.nextCursor;
    historyWindowTruncated = state.turns.some(turn => turn.historyBookmarkTarget);
    state.moreTurns = !!turnCursor;
    state.threadReady = true;
    disconnectedWithMutation = false;
    writerAttachment = { hostId, threadId: id, engineId };
    if (eventGapRevision === continuityRevision) socketHasEventGap = false;
    reconcileCompactionHistory(id, compactionRevision, runtimeChanged ? undefined : result.thread.status?.type);
    const inProgressCompaction = state.items.find(item => item.type === 'contextCompaction' && item.status === 'inProgress' &&
      state.turns.some(turn => turn.id === item.turnId && turn.status === 'inProgress'));
    if (inProgressCompaction) {
      beginCompactionUsage(id);
      compactions.set(modeKey, { ...compactions.get(modeKey), turnId: inProgressCompaction.turnId, itemId: inProgressCompaction.id });
    }
    void refreshContextUsage(hostId, id);
    rememberThread(id);
    saveConversationSnapshot();
    // Revalidate missing older pages in the background; latest native history
    // and a confirmed writer are sufficient to send a new message. A rollback,
    // archive, host change or newer selection cancels the older-window read.
    if (!reuseHistory && page.nextCursor && requestedTurns > page.data.length) {
      const promise = restoreHistoryWindow(id, hostId, generation, page, requestedTurns, itemRevision, current);
      historyRestoration = { threadId: id, generation, promise };
      void promise.finally(() => { if (historyRestoration?.promise === promise) historyRestoration = null; });
    }
    if (state.projectPath !== previousProject) {
      rememberProject();
      void readConfig().catch(fail);
      state.selectedSkills = [];
      void loadSkills().catch(() => {});
    }
    void refreshGoal(hostId, id);
  } catch (error) {
    if (current()) {
      if (writerConflict(error)) {
        const message = '此对话正被其他 Codex 客户端占用。可以重试，或确认后强制进入。';
        state.threadConflict = { hostId, threadId: id, generation, message };
        state.error = message;
        state.busy = false;
        rememberThread(id);
      } else {
        if ((error as any)?.data?.code === 'thread_released' || (error as any)?.code === 'thread_released') {
          updateReleasedThreads(hostId, [...new Set([...(releasedThreads.get(hostId) || []), id])]);
          state.error = '';
        } else if ((error as any)?.data?.code === 'runtime_paused' || (error as any)?.code === 'runtime_paused') {
          state.runtimePaused = true;
          pausedHosts.add(hostId);
          state.error = '此主机的 Web Codex 已释放，请在资源管理中恢复连接。';
        } else fail(error);
        // A transient resume/history failure must keep the selected target and
        // its draft. Returning to welcome previously erased the saved selection.
        rememberThread(id);
      }
    }
  } finally {
    if (current()) { state.selectingThread = false; checkAsyncQuestionAnswers(id); }
  }
}
async function takeoverThread(confirmOwner: (owner: { pid: number; affectedThreadCount: number }) => boolean | Promise<boolean>) {
  const target = state.threadConflict;
  if (!target || state.takingOverThread || !state.online) return;
  const authentication = authenticationGeneration;
  const operation = ++takeoverOperation;
  const current = () => authentication === authenticationGeneration &&
    target.hostId === state.hostId && target.threadId === state.activeThread?.id &&
    target.generation === selectionGeneration && state.threadConflict?.generation === target.generation;
  state.takingOverThread = true;
  const endpoint = `/threads/${encodeURIComponent(target.hostId)}/${encodeURIComponent(target.threadId)}/takeover`;
  try {
    const inspection = await http(endpoint + '/inspect', { method: 'POST', body: '{}' }, false);
    if (!current()) return;
    if (inspection.locked) {
      const owner = inspection.owner;
      if (!owner || !Number.isInteger(owner.pid) || !Number.isInteger(owner.affectedThreadCount)
          || owner.affectedThreadCount < 1 || typeof inspection.challenge !== 'string')
        throw new Error('无法确认占用进程及受影响会话，请重试。');
      if (!await confirmOwner(owner) || !current()) return;
      const result = await http(endpoint, {
        method: 'POST', body: JSON.stringify({ confirmed: true, challenge: inspection.challenge }),
      }, false);
      if (!current()) return;
      if (result.ok !== true || result.released !== true)
        throw new Error('未确认占用已释放，请检查后重试。');
    } else if (inspection.locked !== false) {
      throw new Error('未确认占用状态，请重试。');
    }
    if (current()) await selectThread(target.threadId);
  } catch (error) {
    if (current()) fail(error);
  } finally {
    if (operation === takeoverOperation) state.takingOverThread = false;
  }
}
async function restoreHistoryWindow(id: string, hostId: string, generation: number, initialPage: any,
  requestedTurns: number, itemRevision: number, current: () => boolean) {
  const turns = new Map<string, any>(initialPage.data.map((turn: any) => [turn.id, turn]));
  let cursor = initialPage.nextCursor;
  const cursors = new Set<string>();
  try {
    while (current() && cursor && turns.size < requestedTurns) {
      if (cursors.has(cursor)) throw new Error('历史分页游标重复，请重新同步对话。');
      cursors.add(cursor);
      const page = await history(id, cursor, hostId);
      if (!current()) return;
      for (const turn of page.data) if (!turns.has(turn.id)) turns.set(turn.id, turn);
      cursor = page.nextCursor;
    }
    if (!current() || generation !== selectionGeneration) return;
    const live = [...state.items];
    const liveTurns = [...state.turns];
    state.turns = retainHistoryDetails([...turns.values()].reverse(), liveTurns, live);
    for (const turn of state.turns) discardedTurns.delete(turn.id);
    for (const turn of liveTurns) if (!turn.historyBookmarkTarget) updateTurn(id, turn);
    state.turns = retainBookmarkTargets(state.turns, liveTurns, live);
    const loaded = state.turns.flatMap(turn => (turn.items || []).map((item: any) => ({ ...item, turnId: turn.id })));
    const changedIds = new Set([...(itemRevisions.get(id)?.entries() || [])]
      .filter(([, revision]) => revision > itemRevision).map(([itemId]) => itemId));
    state.items = mergeSnapshotItems(loaded, live, changedIds, {
      retainedTurnIds: new Set(state.turns.map(turn => turn.id)),
      summarizedTurnIds: new Set([...turns.values()].filter(turn => turn.historySummary).map(turn => turn.id)),
    });
    settleLoadedToolItems(state.items, state.turns);
    rememberAsyncQuestions(id, state.items);
    const turnIds = new Set(state.turns.map(turn => turn.id));
    const compactionIds = new Set(state.items.filter(item => item.type === 'contextCompaction').map(item => item.turnId));
    for (const item of live) if (item.legacyCompaction && item.turnId && turnIds.has(item.turnId) && !compactionIds.has(item.turnId))
      upsertItem(state.items, item);
    turnCursor = cursor;
    state.moreTurns = !!cursor;
    historyWindowTruncated = state.turns.some(turn => turn.historyBookmarkTarget);
    saveConversationSnapshot();
  } catch (error) {
    // Older-page recovery must not revoke a successfully confirmed writer or
    // replay an uncertain turn/start. The user can retry loading older history.
    if (current()) fail(error);
  }
}
async function loadOlderTurns() {
  const restoring = historyRestoration;
  if (restoring && restoring.threadId === state.activeThread?.id && restoring.generation === selectionGeneration)
    await restoring.promise;
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
  const knownTurns = new Set(state.turns.map(turn => turn.id));
  const known = new Set(state.items.map((item) => item.id));
  state.items.unshift(
    ...older
      .flatMap((turn: any) =>
        turn.items.map((item: any) => ({ ...item, turnId: turn.id })),
      )
      .filter((item: any) => !known.has(item.id)),
  );
  // An isolated bookmark target precedes the continuous history window until
  // normal pagination reaches it; newer pages must not appear before it.
  const incomingIds = new Set(older.map(turn => turn.id));
  const detached = state.turns.filter(turn => turn.historyBookmarkTarget && !incomingIds.has(turn.id));
  const rest = state.turns.filter(turn => !turn.historyBookmarkTarget);
  state.turns = [...detached, ...older.filter(turn => !knownTurns.has(turn.id) || state.turns.find(entry => entry.id === turn.id)?.historyBookmarkTarget), ...rest];
  rememberAsyncQuestions(id, state.items);
  turnCursor = page.nextCursor;
  state.moreTurns = !!turnCursor;
  saveConversationSnapshot();
  const depthKey = `codex.historyDepth.${state.hostId}.${id}`;
  browserStorage.session.setItem(
    depthKey,
    String(Math.max(1, Math.ceil(state.turns.length / 30))),
  );
}
function newThread(remember = true) {
  cancelGoalRefresh();
  state.threadConflict = null;
  state.takingOverThread = false;
  ++takeoverOperation;
  if (remember) rememberThread("");
  state.selectingThread = false;
  state.runtimePolicy = null;
  ++selectionGeneration;
  saveConversationSnapshot();
  if (state.activeThread) itemCache.set(state.activeThread.id, state.items);
  state.activeThread = null;
  state.noProject = saved<Record<string, boolean>>('codex.projectlessHosts', {})[state.hostId] === true;
  state.threadReady = true;
  state.selectedSkills = [];
  state.goal = null;
  state.goalTokenBudget = null;
  state.goalMode = false;
  state.collaborationMode = 'default';
  state.modeError = "";
  state.goalReadError = "";
  state.modeBusy = false;
  ++modeOperation;
  state.items = [];
  state.turns = [];
  state.busy = false;
  state.tokenUsage = null;
  state.compacting = false;
  state.permissionChangePending = false;
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
      policy.writableRoots = executionRoots(projectPath);
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
    writableRoots: executionRoots(projectPath),
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
function approvalPolicy(permission = state.permission): any {
  return permission === "danger-full-access" ? "never" : "on-request";
}
/** Native project membership is separate from a thread's tool working directory. */
async function resolveNativeProjectIdentity(hostId: string, cwd: string): Promise<string | undefined> {
  const projects = state.projects.filter(entry => (entry.hostId || 'local') === hostId);
  let project = projects.find(entry => entry.path === cwd);
  if (!project) {
    const secondary = projects.filter(entry => (entry.rootPaths || []).includes(cwd));
    if (secondary.length > 1) throw new Error('当前目录属于多个项目，请明确选择项目后发送');
    project = secondary[0];
  }
  if (!project) return undefined;
  const result = await http('/projects/resolve-native', {
    method: 'POST', body: JSON.stringify({ hostId, path: project.path }),
  }, false);
  if (result.supported === false && result.projectId === null) return undefined;
  if (result.supported !== true || typeof result.projectId !== 'string' || !result.projectId.trim())
    throw new Error('无法确认项目归属，请重试后发送');
  return result.projectId;
}
async function send(text: string, editedInput?: any[], selectionContexts: ConversationSelectionSource[] = [], delivery: "immediate" | "queue" = "immediate") {
  if (state.attachmentsLoading) throw fail(new Error('正在恢复附件草稿，请稍后发送'));
  if (messageQueue?.state.uncertain) throw fail(new Error('上一项队列操作尚未确认，请先核对队列和对话后恢复发送。'));
  const waitingForCompaction = state.compacting;
  if (state.runtimePaused) throw fail(new Error('此主机的 Web Codex 已释放，请先在资源管理中恢复连接。'));
  if (state.activeThread && !state.threadReady) throw fail(new Error('正在加载会话，请先同步对话后发送。'));
  if (state.threadConflict) throw fail(new Error('此对话仍被其他 Codex 客户端占用，请先重试或强制进入。'));
  if (!text.trim() && !state.attachments.length && !editedInput?.length && !state.selectedSkills.length && !selectionContexts.length) return;
  const selections = selectionContexts.map(value => normalizeConversationSelection(value));
  if (selectionContexts.length > 8 || selections.some(source => !source || source.hostId !== state.hostId || source.threadId !== state.activeThread?.id))
    throw fail(new Error('引用来自其他会话或内容过长，请重新选择文本'));
  if (state.editingMessage && !editedInput) throw fail(new Error("正在重新发送编辑后的消息，请稍候"));
  if (state.selectingThread || state.switchingHost || state.changingContext)
    throw fail(new Error("正在加载会话或主机配置，请稍后发送"));
  if (sendInFlight) throw fail(new Error("上一条消息正在发送，请稍候"));
  if (state.modeBusy || state.modelSettingsBusy) throw fail(new Error("正在更新会话设置，请稍候"));
  const goalMode = state.goalMode;
  const collaborationMode = state.collaborationMode;
  const supportsCollaborationModes = state.modeCapabilities.plan;
  const goalBudget = state.goalTokenBudget;
  const selectedSkills = editedInput ? [] : [...state.selectedSkills];
  if (delivery === 'queue') {
    if (editedInput) throw fail(new Error('编辑重发不能加入队列，请先完成消息编辑'));
    if (!state.activeThread?.id) throw fail(new Error('请先打开一个已有对话再排队'));
    if (!messageQueue || !waitingForCompaction && !messageQueue.canMutate.value) throw fail(new Error(messageQueue?.blockedReason.value || '原生消息队列尚未准备好'));
    if (goalMode && (!state.goal || state.goal.status === 'complete')) throw fail(new Error('请先发送并创建目标，再添加后续排队消息'));
  }
  const createGoal = delivery !== 'queue' && goalMode && (!state.goal || state.goal.status === 'complete');
  if (createGoal && (!text.trim() || text.trim().length > 4000))
    throw fail(new Error("Goal 目标需要 1–4000 个字符，请填写目标后发送"));
  const hostId = state.hostId;
  const generation = selectionGeneration;
  const authentication = authenticationGeneration;
  const cwd = state.projectPath;
  const noProject = state.noProject;
  const sendSocket = socket, sendEngine = engineId;
  const model = state.model;
  const serviceTier = serviceTierParams(state);
  const effort = state.effort;
  const permission = state.permission;
  const nativePermission = !!state.activeThread && state.runtimePolicy?.source === 'native';
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
    resolveWebPermissionSelection(permission as any, { cwd, requirements: state.requirements }).approvalPolicy;
  const workspaceRoots = executionRoots(cwd);
  if (policy.type === "workspaceWrite" && (!resumed || resolvedProfile))
    policy.writableRoots = workspaceRoots;
  const attachments = editedInput ? [] : [...state.attachments];
  let submittedAttachmentScope = attachmentDraftScope;
  if (attachments.some(file => file.hostId !== hostId))
    throw fail(new Error('附件属于另一台主机，请在原会话发送或重新上传'));
  const selectedModel = state.models.find((entry) => entry.model === model);
  if (
    selectedModel?.inputModalities?.length &&
    !selectedModel.inputModalities.includes("image") &&
    (attachments.some((file) => file.mime?.startsWith("image/")) || editedInput?.some(input => ['image', 'localImage'].includes(input.type)))
  )
    throw fail(
      new Error("当前模型只支持文本输入，请选择支持图片的模型或移除图片附件"),
    );
  const skillReferences = selectedSkills.filter(skill => !skillMention(text, skill.name)).map(skill => `$${skill.name}`).join(' ');
  const messageText = [skillReferences, text].filter(Boolean).join('\n\n');
  const inputs: any[] = editedInput ?? [{ type: "text", text: messageText, text_elements: [] }];
  for (const skill of selectedSkills)
    inputs.push({ type: 'skill', name: skill.name, path: skill.path });
  for (const file of attachments) {
    if (file.mime?.startsWith("image/"))
      inputs.push({ type: "localImage", path: file.path });
    else if (delivery === "queue")
      inputs.push({ type: "text", text: `附件文件：${file.path}（${file.name}）`, text_elements: [] });
    else inputs[0].text += `\n\n附件文件：${file.path}（${file.name}）`;
  }
  // Explicit skill/app selections are persisted as structured protocol inputs.
  for (const skill of state.skills)
    if (skill.enabled !== false && skillMention(inputs[0].text || "", skill.name) && !inputs.some(input => input.type === 'skill' && input.path === skill.path))
      inputs.push({ type: "skill", name: skill.name, path: skill.path });
  for (const app of state.apps)
    if (app.slug && inputs[0].text.includes(`$${app.slug}`) && !inputs.some(input => input.type === 'mention' && input.path === `app://${app.id}`))
      inputs.push({ type: "mention", name: app.name, path: `app://${app.id}` });
  // Quoted text is context, not a source of skill/app commands or a Goal objective.
  if (!editedInput) for (const selection of selections)
    inputs.push({ type: 'text', text: formatConversationQuote(selection!), text_elements: [] });
  state.error = "";
  if (!editedInput) pendingMessageEdit = null;
  sendInFlight = true;
  let id = state.activeThread?.id as string | undefined;
  const messageId = randomUUID();
  let activateGoal: ThreadGoal | null = null;
  if (waitingForCompaction) {
    const threadId = id!, key = recencyKey(hostId, threadId);
    const requestSocket = socket, requestEngine = engineId;
    const requested = !!compactions.get(key)?.requested;
    let dedicatedTurnId = requested ? compactions.get(key)?.turnId : undefined;
    const initialError = state.error;
    try {
      await waitForCompaction(() => {
        if (requested && !dedicatedTurnId) dedicatedTurnId = compactions.get(key)?.turnId;
        const turn = dedicatedTurnId ? state.turns.find(turn => turn.id === dedicatedTurnId) : undefined;
        return {
          valid: hostId === state.hostId && threadId === state.activeThread?.id && cwd === state.projectPath &&
            generation === selectionGeneration && authentication === authenticationGeneration && state.authenticated &&
            state.connected && state.online !== false && !state.runtimePaused && !state.threadReleased && !state.threadConflict &&
            !state.selectingThread && !state.switchingHost && !state.changingContext && requestSocket === socket && requestEngine === engineId,
          compacting: state.compacting,
          dedicatedTurnActive: !!dedicatedTurnId && activeTurns.get(threadId) === dedicatedTurnId && state.busy,
          failed: compactionResults.get(key) === false || ['failed', 'interrupted'].includes(turn?.status) ||
            !!state.error && state.error !== initialError,
        };
      });
      if (delivery === 'queue' && !messageQueue!.canMutate.value)
        throw new Error(messageQueue!.blockedReason.value || '原生消息队列尚未准备好');
    } catch (error) { sendInFlight = false; throw fail(error); }
  }
  if (delivery === 'queue') {
    try {
      await messageQueue!.add(inputs, messageId);
      await consumeAttachmentDraft(submittedAttachmentScope, hostId, attachments, authentication);
      if (generation === selectionGeneration && hostId === state.hostId) {
        state.attachments = state.attachments.filter(file => !attachments.includes(file));
        state.selectedSkills = state.selectedSkills.filter(skill => !selectedSkills.some(sent => sent.path === skill.path));
      }
      return;
    } catch (error) { throw fail(error); }
    finally { sendInFlight = false; }
  }
  try {
    if (!id) {
      const projectId = noProject ? null : await resolveNativeProjectIdentity(hostId, cwd);
      if (hostId !== state.hostId || generation !== selectionGeneration ||
          authentication !== authenticationGeneration || !state.authenticated || state.activeThread || cwd !== state.projectPath || noProject !== state.noProject)
        throw new Error('新对话位置已变化，消息尚未发送，请在目标项目重新确认');
      const result = await rpc("thread/start", {
        ...serviceTier,
        cwd,
        ...(noProject ? { projectId: null, threadSource: PROJECTLESS_THREAD_SOURCE } : projectId ? { projectId } : {}),
        runtimeWorkspaceRoots: workspaceRoots,
        model: model || undefined,
        sandbox: permission as any,
        approvalPolicy: approval,
        historyMode: "paginated",
        config: { 'features.default_mode_request_user_input': true },
      });
      id = result.thread.id;
      if (hostId !== state.hostId)
        throw new Error("工作站已切换，请在原工作站确认消息状态");
      updateThread(result.thread);
      permissionSelections.set(recencyKey(hostId, id!), { mode: permission, profileId: state.activePermissionProfileId });
      if (generation === selectionGeneration && hostId === state.hostId) {
        const nextAttachmentScope = attachmentDraftIdentity(hostId, id, cwd, noProject);
        moveAttachmentDraft(submittedAttachmentScope, nextAttachmentScope, hostId);
        submittedAttachmentScope = nextAttachmentScope;
        state.activeThread = state.threads.find(thread => thread.id === id) ?? result.thread;
        state.items = itemCache.get(id!) ?? [];
        rememberThread(id!);
      }
    }
    if (hostId !== state.hostId)
      throw new Error("工作站已切换，请在原工作站确认消息状态");
    if (goalMode) {
      const currentGoal = goals.get(recencyKey(hostId, id!));
      if (!currentGoal || currentGoal.status === 'complete') {
        activateGoal = await mutateGoal(hostId, id!, { objective: text.trim(), status: 'paused', tokenBudget: goalBudget });
      } else if (currentGoal.status === 'paused') {
        activateGoal = currentGoal;
      }
      if (hostId !== state.hostId) throw new Error('工作站已切换，请在原工作站确认目标状态');
    }
    const busy =
      activeTurns.has(id!) ||
      threadBusy.get(id!) ||
      (state.activeThread?.id === id && state.busy);
    if (busy && editedInput)
      throw new Error("会话已开始新的任务，请取消编辑并确认最新历史");
    if (busy && !activeTurns.has(id!))
      throw new Error("当前任务状态正在同步，请稍后发送");
    const targetTurnId = busy ? activeTurns.get(id!)! : undefined;
    compactedSinceInput.delete(id!);
    // Steering belongs at the current timeline tail from the first paint.
    // Waiting for its canonical alias used to remount it at the turn's head.
    upsertItem(currentItems(id!), {
      id: messageId,
      clientId: messageId,
      type: "userMessage",
      content: inputs,
      status: "sending",
      ...(targetTurnId ? { turnId: targetTurnId } : {}),
    });
    noteItem(id!, messageId);
    if (busy) {
      const threadId = id!;
      const steerGoalRevision = goalRevisions.get(recencyKey(hostId, threadId)) || 0;
      const result = await steerWithConfirmedTurn(targetTurnId!, expectedTurnId => rpc("turn/steer", {
        threadId: id!,
        expectedTurnId,
        clientUserMessageId: messageId,
        input: inputs,
      }, 45000, { silentError: true }), {
        current: () => authentication === authenticationGeneration && hostId === state.hostId &&
          threadId === state.activeThread?.id && generation === selectionGeneration && cwd === state.projectPath &&
          sendSocket === socket && sendEngine === engineId && state.connected && state.online &&
          steerGoalRevision === (goalRevisions.get(recencyKey(hostId, threadId)) || 0) &&
          state.authenticated && state.threadReady && !state.runtimePaused && !state.threadReleased &&
          !state.threadConflict && !state.selectingThread && !state.switchingHost && !state.changingContext,
        runtime: () => ({ turnId: activeTurns.get(threadId), busy: threadBusy.get(threadId) === true,
          revision: turnRevisions.get(threadId) || 0 }),
        readLatest: async () => (await historyReader.turns(JSON.stringify([authentication, hostId, sendEngine]),
          (method, params) => rpc(method, params, 15000, { silentError: true }),
          { threadId, cursor: null, limit: 1, sortDirection: 'desc' })).data[0],
        terminal: turnId => completedTurns.has(turnId),
        discarded: turnId => discardedTurns.has(turnId),
        acceptActiveTurn: turnId => noteRuntime(threadId, true, turnId),
      });
      if (authentication === authenticationGeneration && hostId === state.hostId) {
        // Some runtimes acknowledge the input without emitting a user item.
        // Confirm the optimistic message in place, including observing caches.
        hydrateTurnItems(id!, { id: result.turnId }, {
          input: inputs, clientUserMessageId: messageId, placement: 'steer',
        });
        projectAcceptedThreadPreview(id!, [{ type: 'userMessage', content: inputs }]);
        scheduleConversationSnapshot(id!);
      }
    } else {
      const revision = turnRevisions.get(id!) ?? 0;
      const itemRevision = itemEventSequence;
      threadBusy.set(id!, true);
      if (state.activeThread?.id === id) state.busy = true;
      const result = await rpc("turn/start", {
      ...serviceTier,
        threadId: id!,
        clientUserMessageId: messageId,
        input: inputs,
        cwd,
        runtimeWorkspaceRoots: workspaceRoots,
        model: model || undefined,
        effort: effort as any,
        // Native profiles can contain grants/denials not represented by the
        // legacy sandbox projection. Keep them sticky until a Web choice.
        ...(!nativePermission ? { approvalPolicy: approval, sandboxPolicy: policy } : {}),
        ...(supportsCollaborationModes ? { collaborationMode: nativeCollaborationMode(collaborationMode, model, effort) } : {}),
      });
      if (hostId === state.hostId)
        projectAcceptedThreadPreview(id!, [
          ...(result.turn.items || []),
          { type: 'userMessage', content: inputs },
        ]);
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
    if (activateGoal) {
      // An accepted turn must never be retried because a later goal activation failed.
      // Live complete/clear notifications win over the earlier paused snapshot.
      const current = goals.get(recencyKey(hostId, id!));
      if (current?.status === 'paused' && current.objective === activateGoal.objective) {
        try { await mutateGoal(hostId, id!, { status: 'active' }); }
        catch (error) {
          if (hostId === state.hostId && state.activeThread?.id === id)
            state.modeError = `消息已发送，目标仍暂停，请点击继续：${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    await consumeAttachmentDraft(submittedAttachmentScope, hostId, attachments, authentication);
    if (generation === selectionGeneration && hostId === state.hostId) {
      state.attachments = state.attachments.filter((file) => !attachments.includes(file));
      state.selectedSkills = state.selectedSkills.filter(skill => !selectedSkills.some(sent => sent.path === skill.path));
    }
  } catch (error) {
    if (id && hostId === state.hostId && authentication === authenticationGeneration) {
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
    if (authentication === authenticationGeneration && hostId === state.hostId &&
        generation === selectionGeneration && (!id || state.activeThread?.id === id)) throw fail(error);
    throw error;
  } finally {
    sendInFlight = false;
  }
}
function canEditMessage(itemId: string) {
  const item = state.items.find(entry => entry.id === itemId);
  if (item?.content?.some((input: any) => input.type === 'text' && asyncQuestionAnswerDisplayText(input.text) !== null)) return false;
  const blocked = !state.threadReady || state.runtimePaused || state.threadReleased || !!state.threadConflict || !state.connected || !state.online || state.busy || state.editingMessage || sendInFlight || state.selectingThread || state.switchingHost || state.changingContext;
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
  forgetAsyncQuestions(threadId);
  for (const turnId of removed) discardedTurns.add(turnId);
  itemCache.delete(threadId);
  conversationCache.remove(state.hostId, threadId);
  tokenUsages.delete(recencyKey(state.hostId, threadId));
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
function rememberRevertedHistory(threadId: string, native: boolean) {
  const previous = revertedTurnCandidates.get(threadId);
  if (previous && !native) {
    previous.awaitingAcknowledgement = false;
    return;
  }
  const candidates = previous?.ids || new Set<string>();
  if (state.activeThread?.id === threadId)
    for (const turn of state.turns) if (turn.id) candidates.add(turn.id);
  for (const item of currentItems(threadId)) if (item.turnId) candidates.add(item.turnId);
  revertedTurnCandidates.set(threadId, { ids: candidates, awaitingAcknowledgement: native });
  // Block old events while the retained prefix is being read. This also works
  // for inactive conversations, whose old turns exist only in the item cache.
  for (const turnId of candidates) discardedTurns.add(turnId);
}
function refreshRevertedThread(threadId: string) {
  if (state.activeThread?.id !== threadId) return;
  // Replayed notifications precede connected status. Defer their read until
  // recovery; an old in-flight snapshot must never confirm a reverted head.
  // Closing the old socket already invalidates its pending reads. Advancing
  // this generation again during replay would invalidate resumeConnection's
  // own scope and prevent it from fetching the reverted history at all.
  if (state.connected) ++selectionGeneration;
  state.threadReady = false;
  state.selectingThread = false;
  if (state.connected) void selectThread(threadId, { preserveWriter: true });
}
async function resendEditedMessage(itemId: string, text: string, attachments?: MessageEditAttachment[]) {
  if (!canEditMessage(itemId)) throw fail(new Error("当前消息不能编辑，请等待任务结束并确认会话状态"));
  const hostId = state.hostId;
  const threadId = state.activeThread.id;
  const generation = selectionGeneration;
  const original = pendingMessageEdit?.reverted && pendingMessageEdit.item.id === itemId
    ? pendingMessageEdit.item : state.items.find(item => item.id === itemId)!;
  const input = editedMessageInput(original, text, attachments);
  const profile = availablePermissionProfiles(state.preferences.permissionProfiles).find(profile => profile.id === state.activePermissionProfileId);
  if (profile || !state.runtimePolicy)
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
      updateThread(result.thread, { authoritativePreview: true });
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
      if (!page.data.length && !page.nextCursor)
        updateThread({ ...state.activeThread, preview: '' }, { authoritativePreview: true });
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
  const requestSocket = socket;
  const requestScope = JSON.stringify([authenticationGeneration, state.hostId, state.activeThread?.id, selectionGeneration, engineId]);
  if (interruptOperation?.scope === requestScope && interruptOperation.socket === requestSocket)
    return interruptOperation.promise;
  const promise = interruptOnce();
  interruptOperation = { scope: requestScope, socket: requestSocket, promise };
  try { return await promise; }
  finally { if (interruptOperation?.promise === promise) interruptOperation = null; }
}
async function interruptOnce() {
  const id = state.activeThread?.id;
  const turnId = id && activeTurns.get(id);
  if (!id || !turnId) return;
  const hostId = state.hostId;
  const generation = selectionGeneration;
  const authentication = authenticationGeneration;
  const requestSocket = socket;
  const requestEngine = engineId;
  const current = () => hostId === state.hostId && id === state.activeThread?.id &&
    generation === selectionGeneration && authentication === authenticationGeneration &&
    requestSocket === socket && requestEngine === engineId &&
    state.connected && !state.runtimePaused && !state.threadReleased;
  const changed = () => new Error('任务轮次已变化，请同步对话后再停止。');
  // Send both requests on the captured connection before awaiting either one.
  // A failed pause must not prevent the user's Stop from interrupting the turn.
  const pause = state.goal?.status === 'active'
    ? mutateGoal(hostId, id, { status: 'paused' }) : Promise.resolve(null);
  const stop = rpc('turn/interrupt', { threadId: id, turnId }, 45000, { silentError: true });
  const [paused, interrupted] = await Promise.allSettled([pause, stop]);
  if (!current()) return;
  if (paused.status === 'rejected')
    state.modeError = `停止已提交，目标暂停状态需确认：${paused.reason.message}`;
  if (interrupted.status === 'fulfilled') return;
  try {
    const candidate = interruptConflictCandidate(interrupted.reason, turnId);
    if (!candidate) throw interrupted.reason;
    const otherLiveTurn = () => {
      const live = activeTurns.get(id);
      return !!live && live !== turnId && live !== candidate;
    };
    if (otherLiveTurn()) throw changed();
    const revision = turnRevisions.get(id) ?? 0;
    // A missed continuation can leave the browser's cached ID behind. Confirm
    // only the most recent native turn, without loading a large conversation or
    // reacquiring its writer. Never replay an uncertain Stop or follow new IDs
    // indefinitely; there is at most one confirmed retry for this click.
    const page = await historyReader.turns(JSON.stringify([authentication, hostId, requestEngine]),
      (method, params) => rpc(method, params, 15000, { silentError: true }), {
        threadId: id, cursor: null, limit: 1, sortDirection: 'desc',
      });
    if (!current()) return;
    // Live events may already have advanced before this read began. A lagging
    // history snapshot must neither replace nor clear that newer active turn.
    if (otherLiveTurn()) throw changed();
    const latest = page.data[0];
    if (!latest || latest.id !== candidate || discardedTurns.has(candidate)) throw changed();
    const runtimeChanged = (turnRevisions.get(id) ?? 0) !== revision;
    if (!runtimeChanged && completedTurns.has(candidate)) {
      noteRuntime(id, false);
      return;
    }
    if (runtimeChanged && (activeTurns.get(id) !== candidate || !threadBusy.get(id))) {
      if (!activeTurns.has(id) && !threadBusy.get(id) && completedTurns.has(candidate)) return;
      throw changed();
    }
    if (['completed', 'failed', 'interrupted'].includes(latest.status)) {
      if (!runtimeChanged) noteRuntime(id, false);
      return;
    }
    if (latest.status !== 'inProgress' || completedTurns.has(candidate)) throw changed();
    if (!runtimeChanged) noteRuntime(id, true, candidate);
    try { await rpc('turn/interrupt', { threadId: id, turnId: candidate }, 45000, { silentError: true }); }
    catch (error) { throw interruptConflictCandidate(error, candidate) ? changed() : error; }
  } catch (error) {
    if (current()) throw fail(error);
  }
}
async function attachedThreadCapabilities(hostId: string) {
  const capabilities = await http(`/hosts/${encodeURIComponent(hostId)}/native-capabilities`, {}, false);
  if (!methodAccepts(capabilities, 'thread/fork', ['threadId', 'attachToSource', 'excludeTurns']) ||
      !methodAccepts(capabilities, 'thread/list', ['attachedToThreadId', 'cursor', 'limit', 'modelProviders', 'archived']))
    throw new Error('当前主机尚未确认支持附属分支，请更新并重启至 Codex 0.165 或更新版本后重试');
  return capabilities;
}
async function queryAttachedThreads(threadId: string, hostId = state.hostId, cursor: string | null = null, archived = false) {
  const authentication = authenticationGeneration;
  await attachedThreadCapabilities(hostId);
  if (authentication !== authenticationGeneration || !state.authenticated || !state.hosts.some(host => host.id === hostId))
    throw new Error('登录状态或主机连接已变化，请重新打开附属分支');
  const result = await scopedRpc(hostId, 'thread/list', { attachedToThreadId: threadId, cursor, limit: 60, modelProviders: [], archived });
  if (authentication !== authenticationGeneration || !state.authenticated || !state.hosts.some(host => host.id === hostId))
    throw new Error('登录状态已变化，请重新打开附属分支');
  if (!Array.isArray(result.data) || result.data.some((thread: any) => !thread || typeof thread.id !== 'string' || !thread.id || thread.id === threadId))
    throw new Error('附属分支列表无效，请刷新重试');
  return { data: result.data.map((thread: any) => ({ ...thread, hostId })), nextCursor: result.nextCursor ?? null };
}
async function forkThread(id: string, hostId = state.hostId, lastTurnId?: string, options: { attachToSource?: boolean } = {}) {
  const authentication = authenticationGeneration;
  const selection = selectionGeneration, selectedHost = state.hostId, selectedThread = state.activeThread?.id;
  const source = hostId === state.hostId
    ? state.threads.find(thread => thread.id === id) ?? (state.activeThread?.id === id ? state.activeThread : undefined)
    : state.navigation[hostId]?.threads.find(thread => thread.id === id);
  const attached = options.attachToSource === true;
  if (attached) {
    // Attached branches are persistent, hidden in native ordinary lists, and
    // cannot use deferGoalContinuation. Never copy a goal into an auto-running
    // branch or turn a read-only ephemeral side chat into a persistent one.
    await attachedThreadCapabilities(hostId);
    const [metadata, goal] = await Promise.all([
      scopedRpc(hostId, 'thread/read', { threadId: id, includeTurns: false }),
      scopedRpc(hostId, 'thread/goal/get', { threadId: id }),
    ]);
    if (!metadata.thread?.id || metadata.thread.id !== id || metadata.thread.ephemeral !== false)
      throw new Error('仅支持为已保存的普通对话创建附属分支，请先保存此对话');
    if (!goal || !('goal' in goal) || goal.goal !== null)
      throw new Error('此对话包含 Goal，无法安全创建附属分支；请使用普通分支');
    if (authentication !== authenticationGeneration || !state.authenticated || !state.hosts.some(host => host.id === hostId))
      throw new Error('登录状态或主机连接已变化，请重新打开附属分支');
  }
  // Native allows a snapshot of a running thread when no boundary is given.
  // A lastTurnId naming its active turn is rejected; the snapshot's partial
  // turn gets an interruption marker while the source continues untouched.
  const selectedSource = hostId === state.hostId && state.activeThread?.id === id;
  const activeBoundary = lastTurnId && hostId === state.hostId &&
    (activeTurns.get(id) === lastTurnId || selectedSource && state.turns.some(turn => turn.id === lastTurnId && turn.status === 'inProgress'));
  const result = await scopedRpc(hostId, "thread/fork", {
    threadId: id, ...(lastTurnId && !activeBoundary ? { lastTurnId } : {}), excludeTurns: true,
    ...(attached ? { attachToSource: true } : { deferGoalContinuation: true }),
    ...(isProjectlessThread(source) ? { threadSource: PROJECTLESS_THREAD_SOURCE } : {}),
  });
  if (authentication !== authenticationGeneration || !state.authenticated || attached && !state.hosts.some(host => host.id === hostId))
    throw new Error('登录状态已变化，请重新同步对话后确认已创建的分支');
  if (!result.thread?.id || result.thread.id === id || attached && result.thread.ephemeral !== false)
    throw Object.assign(new Error('无法确认已创建的分支，请刷新分支列表后确认；请勿重复创建'), { uncertain: true });
  invalidateThreadTitleSearch(hostId);
  if (!attached) {
    if (hostId === state.hostId) updateThread(result.thread);
    else mergeNavigation(hostId, [result.thread]);
  }
  toast(attached ? '已创建附属分支，可在附属分支列表打开' : '已创建对话分支');
  return { id: result.thread.id as string, hostId,
    canSelect: selection === selectionGeneration && selectedHost === state.hostId && selectedThread === state.activeThread?.id };
}
async function fork(lastTurnId?: string) {
  if (!state.activeThread) return;
  if (!state.threadReady || state.runtimePaused) throw fail(new Error('请先恢复当前会话连接。'));
  const hostId = state.hostId, id = state.activeThread.id, selection = selectionGeneration;
  const result = await forkThread(id, hostId, lastTurnId);
  if (hostId === state.hostId && id === state.activeThread?.id && selection === selectionGeneration)
    await selectThread(result.id);
}
async function compact() {
  const id = state.activeThread?.id;
  if (!id) return;
  if (!state.threadReady || state.runtimePaused) throw fail(new Error('请先恢复当前会话连接。'));
  if (state.busy || state.compacting) throw fail(new Error("请等待当前任务完成后压缩上下文"));
  const hostId = state.hostId;
  noteRuntime(id, true);
  const key = recencyKey(state.hostId, id);
  const requestId = randomUUID();
  beginCompactionUsage(id);
  compactions.set(key, { requested: true, acknowledged: false, requestId });
  try {
    await rpc("thread/compact/start", { threadId: id });
    // This is an immediate acknowledgement, not the completion event.
    const current = compactions.get(key);
    if (hostId === state.hostId && current?.requestId === requestId) {
      compactions.set(key, { ...current, acknowledged: true });
      compactionRevisions.set(key, (compactionRevisions.get(key) || 0) + 1);
    }
  } catch (error) {
    if (hostId === state.hostId && compactions.get(key)?.requestId === requestId && !(error as any)?.uncertain) {
      finishCompaction(id, undefined, false);
      if (!activeTurns.has(id)) noteRuntime(id, false);
    } else if (hostId === state.hostId && compactions.get(key)?.requestId === requestId) {
      // An uncertain RPC is not replayed. Native read-only recovery must still
      // be able to settle it after a lost ACK or transport interruption.
      compactions.set(key, { ...compactions.get(key), acknowledged: true });
      compactionRevisions.set(key, (compactionRevisions.get(key) || 0) + 1);
    }
    throw error;
  }
}
async function maybeCompact() {
  if (
    state.autoCompact &&
    !state.busy &&
    !state.compacting &&
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
  browserStorage.local.setItem("codex.autoCompact", JSON.stringify(enabled));
  browserStorage.local.setItem(
    "codex.compactThreshold",
    JSON.stringify(state.compactThreshold),
  );
}
function applyThreadRename(id: string, name: string, hostId = state.hostId) {
  invalidateThreadTitleSearch(hostId);
  const key = recencyKey(hostId, id);
  if (deletedThreads.has(key)) return;
  threadNameRevisions.set(key, (threadNameRevisions.get(key) ?? 0) + 1);
  if (hostId === state.hostId) {
    threadRevisions.set(id, ++threadEventSequence);
    const thread = state.threads.find(thread => thread.id === id);
    if (thread) thread.name = name;
    if (state.activeThread?.id === id) {
      state.activeThread = { ...state.activeThread, name };
      // A forced navigation refresh temporarily removes every row. Its parallel
      // project-list response must not reinsert this thread's older label.
      if (!thread && !state.activeThread.ephemeral) state.threads.unshift(state.activeThread);
      saveConversationSnapshot();
    } else conversationCache.remove(hostId, id);
  } else conversationCache.remove(hostId, id);
  const thread = state.navigation[hostId]?.threads.find(thread => thread.id === id);
  if (thread) thread.name = name;
  advanceNavigationRevision(hostId, false);
}
async function renameThread(name: string, id = state.activeThread?.id, hostId = state.hostId) {
  const trimmed = name.trim();
  if (!id || !trimmed) return;
  if (trimmed.length > 1000) throw new Error('对话名称不能超过 1000 个字符');
  const authentication = authenticationGeneration;
  await scopedRpc(hostId, 'thread/name/set', { threadId: id, name: trimmed });
  if (authentication !== authenticationGeneration || !state.hosts.some(host => host.id === hostId)) return;
  applyThreadRename(id, trimmed, hostId);
}
function applyThreadProject(hostId: string, id: string, projectId: string | null) {
  threadProjectChanges.set(recencyKey(hostId, id), { revision: ++projectChangeSequence, projectId });
  invalidateThreadTitleSearch(hostId);
  advanceNavigationRevision(hostId);
  if (hostId === state.hostId) {
    const thread = state.threads.find(thread => thread.id === id)
      ?? (state.activeThread?.id === id ? state.activeThread : undefined);
    if (thread) updateThread({ ...thread, projectId });
    state.projectThreadPages = {};
    if (state.activeThread?.id === id) saveConversationSnapshot();
    else conversationCache.remove(hostId, id);
  } else conversationCache.remove(hostId, id);
  const navigation = state.navigation[hostId];
  if (navigation) {
    const thread = navigation.threads.find(thread => thread.id === id);
    if (thread) thread.projectId = projectId;
    navigation.projectPages = {};
  }
}
const movingThreadProjects = new Set<string>();
async function moveThreadToProject(id: string, destinationPath: string, hostId = state.hostId) {
  const key = recencyKey(hostId, id);
  if (movingThreadProjects.has(key)) throw new Error('正在调整此对话的项目，请稍候');
  const authentication = authenticationGeneration;
  const target = () => state.projects.find(project => (project.hostId || 'local') === hostId && project.path === destinationPath);
  const current = () => authentication === authenticationGeneration && state.authenticated && state.hosts.some(host => host.id === hostId) && target();
  const running = () => hostId === state.hostId && state.activeThread?.id === id && state.busy;
  if (!id || !current()) throw new Error('目标项目必须属于此对话所在的主机，请刷新项目列表后重试');
  if (running()) throw new Error('此对话正在运行，请先停止或等待任务结束后调整项目');
  movingThreadProjects.add(key);
  try {
    const metadata = await scopedRpc(hostId, 'thread/read', { threadId: id, includeTurns: false });
    if (!current()) throw new Error('登录状态或目标项目已变化，请重新确认后调整项目');
    if (metadata.thread?.id !== id) throw new Error('无法确认目标对话，请刷新列表后重试');
    if (running() || metadata.thread?.status?.type === 'active') throw new Error('此对话正在运行，请先停止或等待任务结束后调整项目');
    const projectId = await resolveNativeProjectIdentity(hostId, destinationPath);
    if (!current()) throw new Error('登录状态或目标项目已变化，请重新确认后调整项目');
    if (!projectId) throw new Error('目标主机的 Codex 不支持原生项目调整，请升级 Codex 后重试；对话归属未修改');
    if (running()) throw new Error('此对话正在运行，请先停止或等待任务结束后调整项目');
    const response = await scopedRpc(hostId, 'thread/metadata/update', { threadId: id, projectId });
    if (!current()) return;
    if (response.thread?.id !== id || response.thread.projectId !== projectId)
      throw new Error('Codex 未确认项目调整，请同步对话后确认归属');
    target()!.nativeProjectId = projectId;
    applyThreadProject(hostId, id, projectId);
    toast(`已移至项目「${target()!.name}」`);
    return { id, hostId, projectId };
  } catch (error: any) {
    if (error.code === -32601 || /unknown variant `thread\/metadata\/update`|(?:unsupported|unknown|not found).*method/i.test(error.message || ''))
      error.message = '目标主机的 Codex 不支持原生项目调整，请升级 Codex 后重试；对话归属未修改';
    throw error;
  } finally { movingThreadProjects.delete(key); }
}
function cleanupDeletedThread(id: string, hostId = state.hostId) {
  if (!id) return;
  invalidateThreadTitleSearch(hostId);
  forgetAsyncQuestions(id, hostId);
  const key = recencyKey(hostId, id);
  deletedThreads.add(key);
  void attachmentDrafts.forget(attachmentDraftIdentity(hostId, id, '', false), hostId).catch(() => {});
  threadNameRevisions.delete(key);
  if (hostId === state.hostId) {
    cleanupArchivedThread(id);
    activeTurns.delete(id);
    threadBusy.delete(id);
    turnRevisions.set(id, (turnRevisions.get(id) ?? 0) + 1);
    itemRevisions.delete(id);
    compactedSinceInput.delete(id);
    revertedTurnCandidates.delete(id);
    delete state.agentActivity[id];
    state.pendingRequests = state.pendingRequests.filter(request =>
      (request.params?.threadId || request.params?.conversationId) !== id);
    if (writerAttachment?.hostId === hostId && writerAttachment.threadId === id) writerAttachment = null;
  }
  const nav = state.navigation[hostId];
  if (nav) nav.threads = nav.threads.filter(thread => thread.id !== id);
  advanceNavigationRevision(hostId);
  conversationCache.remove(hostId, id);
  void conversationCache.flush().catch(() => {});
  for (const records of [goals, conversationModes, tokenUsages, compactions, permissionSelections, legacyRecency]) records.delete(key);
  for (const revisions of [goalRevisions, tokenUsageRevisions, compactionRevisions])
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
  for (const storage of [browserStorage.local, browserStorage.session]) {
    storage.removeItem(`codex.draft.${hostId}.${id}`);
    storage.removeItem(`codex.draft.${hostId}.${id}.quotes`);
    storage.removeItem(`codex.historyDepth.${hostId}.${id}`);
  }
  const selections = saved<Record<string, string>>('codex.selectedThreadIds', {});
  if (selections[hostId] === id) {
    delete selections[hostId];
    browserStorage.local.setItem('codex.selectedThreadIds', JSON.stringify(selections));
  }
  void privateState.remove('queue-outcome', JSON.stringify([hostId, id])).catch(() => {});
  notifyProtocol({ method: 'bridge/thread/removed', params: { threadId: id } }, hostId);
  if (state.preferences.pins.some(pin => pin.hostId === hostId && pin.kind === 'thread' && pin.id === id)) {
    void updatePreferences({ pins: state.preferences.pins.filter(pin =>
      pin.hostId !== hostId || pin.kind !== 'thread' || pin.id !== id) }).catch(() => {
      toast('对话已删除；置顶偏好未保存，请刷新确认');
    });
  }
}
async function deleteThread(id: string, hostId = state.hostId) {
  const authentication = authenticationGeneration;
  const running = () => hostId === state.hostId &&
    (activeTurns.has(id) || threadBusy.get(id) || (state.activeThread?.id === id && state.busy));
  if (running()) throw new Error('此会话正在运行，请先暂停或等待完成后再删除');
  // Metadata also catches active writers in the desktop app or CLI without
  // resuming the conversation or taking over their connection.
  const result = await scopedRpc(hostId, 'thread/read', { threadId: id, includeTurns: false });
  if (authentication !== authenticationGeneration || !state.hosts.some(host => host.id === hostId))
    throw new Error('登录状态或目标主机已变化，请重新确认后删除');
  if (result.thread?.id !== id) throw new Error('无法确认目标对话，请刷新列表后重试');
  if (running() || result.thread?.status?.type === 'active')
    throw new Error('此会话正在运行，请先暂停或等待完成后再删除');
  try { await scopedRpc(hostId, 'thread/delete', { threadId: id }); }
  catch (error: any) {
    if (error?.code === -32601) error.message = '目标主机上的 Codex 不支持永久删除会话，请先升级 Codex；会话未被删除';
    throw error;
  }
  if (authentication === authenticationGeneration && state.hosts.some(host => host.id === hostId)) cleanupDeletedThread(id, hostId);
}
function cleanupArchivedThread(id: string) {
  invalidateThreadTitleSearch(state.hostId);
  advanceNavigationRevision(state.hostId);
  forgetAsyncQuestions(id);
  removedThreads.add(id);
  threadRevisions.set(id, ++threadEventSequence);
  state.threads = state.threads.filter((thread) => thread.id !== id);
  if (state.activeThread?.id === id) newThread();
  itemCache.delete(id);
  conversationCache.remove(state.hostId, id);
  tokenUsages.delete(recencyKey(state.hostId, id));
  notifyProtocol({ method: 'bridge/thread/removed', params: { threadId: id } });
}
async function archiveThread(id: string, hostId = state.hostId) {
  const known = hostId === state.hostId ? state.threads.find(thread => thread.id === id)
    : state.navigation[hostId]?.threads.find(thread => thread.id === id);
  if (known?.status?.type === 'active' || hostId === state.hostId && state.activeThread?.id === id && state.busy)
    throw new Error('此会话正在运行，请先停止或等待完成后再归档');
  const authentication = authenticationGeneration;
  await scopedRpc(hostId, "thread/archive", { threadId: id });
  if (authentication !== authenticationGeneration || !state.authenticated) return;
  invalidateThreadTitleSearch(hostId);
  if (hostId === state.hostId) cleanupArchivedThread(id);
  else notifyProtocol({ method: 'bridge/thread/removed', params: { threadId: id } }, hostId);
  const nav = state.navigation[hostId];
  if (nav) nav.threads = nav.threads.filter((thread) => thread.id !== id);
  advanceNavigationRevision(hostId);
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
async function setProject(path: string, noProject = false) {
  state.projectPath = path;
  state.noProject = noProject;
  rememberProject(true);
  newThread();
  await Promise.allSettled([refreshThreads(), readConfig(), loadModeCapabilities(), loadSkills()]);
}
/** Native thread configuration for explicitly started review workflows. */
function workflowThreadOptions() {
  const profile = availablePermissionProfiles(state.preferences.permissionProfiles).find(entry => entry.id === state.activePermissionProfileId);
  const resolved = resolveWebPermissionSelection(state.permission as any, { profile, cwd: state.projectPath, requirements: state.requirements });
  return {
    cwd: state.projectPath,
    runtimeWorkspaceRoots: executionRoots(),
    model: state.model || undefined,
    ...serviceTierParams(state),
    sandbox: resolved.sandbox,
    approvalPolicy: resolved.approvalPolicy,
    config: {
      'features.default_mode_request_user_input': true,
      'model_reasoning_effort': state.effort,
      ...(resolved.sandboxPolicy.type === 'workspaceWrite' ? { sandbox_workspace_write: {
        writable_roots: executionRoots(), network_access: resolved.sandboxPolicy.networkAccess,
        exclude_tmpdir_env_var: resolved.sandboxPolicy.excludeTmpdirEnvVar,
        exclude_slash_tmp: resolved.sandboxPolicy.excludeSlashTmp,
      } } : {}),
    },
  };
}
async function startWorkflowThread() {
  if (state.activeThread) return state.activeThread.id;
  const hostId = state.hostId;
  const generation = selectionGeneration;
  const authentication = authenticationGeneration;
  const options = workflowThreadOptions();
  const noProject = state.noProject;
  const projectId = noProject ? null : await resolveNativeProjectIdentity(hostId, options.cwd);
  if (hostId !== state.hostId || generation !== selectionGeneration ||
      authentication !== authenticationGeneration || !state.authenticated || state.activeThread || options.cwd !== state.projectPath || noProject !== state.noProject)
    throw new Error('工作区已切换，新会话尚未创建；请在目标项目重新确认。');
  const result = await rpc('thread/start', {
    ...options,
    ...(noProject ? { projectId: null, threadSource: PROJECTLESS_THREAD_SOURCE } : projectId ? { projectId } : {}),
    historyMode: 'paginated',
  });
  if (hostId !== state.hostId || generation !== selectionGeneration || authentication !== authenticationGeneration)
    throw new Error('工作区已切换，原主机的新会话已创建；请返回原主机确认。');
  updateThread(result.thread);
  state.activeThread = result.thread;
  state.items = currentItems(result.thread.id);
  state.threadReady = true;
  permissionSelections.set(recencyKey(hostId, result.thread.id), { mode: state.permission, profileId: state.activePermissionProfileId });
  rememberThread(result.thread.id);
  saveConversationSnapshot();
  return result.thread.id as string;
}
async function newThreadInWorktree(path: string) {
  if (state.busy || state.selectingThread || state.switchingHost || state.changingContext || sendInFlight)
    throw new Error('请等待当前操作完成后创建工作树会话');
  if (!state.connected || !state.online || state.runtimePaused) throw new Error('请先连接当前主机');
  sendInFlight = true;
  try {
    const existing = state.projects.find(project => project.hostId === state.hostId && project.path === path);
    if (existing) await setProject(path);
    else await addProject(path);
    // Native blank threads are not written to rollout history until the first
    // real message. Prepare the existing new-chat flow and let send bind cwd.
    return true;
  } finally { sendInFlight = false; }
}
async function startReview(target: ReviewTarget) {
  if (!state.connected || !state.online || state.runtimePaused || state.threadReleased || state.threadConflict || (state.activeThread && !state.threadReady)) throw new Error('请先恢复当前会话连接');
  if (state.busy || state.selectingThread || state.switchingHost || state.changingContext || state.modeBusy || sendInFlight) throw new Error('请等待当前任务或操作完成后开始审阅');
  if (state.goal?.status === 'active' || messageQueue?.state.items.length) throw new Error('请先暂停 Goal 并处理排队消息后开始审阅');
  const hostId = state.hostId;
  const authentication = authenticationGeneration;
  const generation = selectionGeneration;
  sendInFlight = true;
  try {
    const capabilities = await http(`/hosts/${encodeURIComponent(hostId)}/native-capabilities`, {}, false);
    if (hostId !== state.hostId || authentication !== authenticationGeneration || generation !== selectionGeneration) throw new Error('工作区已切换，请重新确认审阅范围');
    if (!methodAccepts(capabilities, 'thread/settings/update', ['threadId', 'cwd', 'sandboxPolicy', 'approvalPolicy', 'model', 'effort'])) throw new Error('当前 Codex 的原生审阅权限设置尚未确认，请更新 Codex 或稍后重试。');
    const id = await startWorkflowThread();
    if (hostId !== state.hostId || authentication !== authenticationGeneration || id !== state.activeThread?.id) throw new Error('会话已切换，请重新确认审阅范围');
    const revision = turnRevisions.get(id) || 0;
    const profile = availablePermissionProfiles(state.preferences.permissionProfiles).find(entry => entry.id === state.activePermissionProfileId);
    const permission = resolveWebPermissionSelection(state.permission as any, { profile, cwd: state.projectPath, requirements: state.requirements });
    const policy = permission.sandboxPolicy;
    if (policy.type === 'workspaceWrite') policy.writableRoots = executionRoots();
    // Resume ignores overrides for an already loaded thread. Update future
    // settings in place, so review retains the existing connection and writer.
    try {
      await rpc('thread/settings/update', { threadId: id, cwd: state.projectPath, sandboxPolicy: policy,
        approvalPolicy: permission.approvalPolicy, model: state.model || undefined, effort: state.effort as any, ...serviceTierParams(state) }, 15000, { silentError: true });
    } catch (error: any) {
      if (error.code === -32601 || /method not found|unknown method|unsupported method/i.test(error.message || '')) throw new Error('当前 Codex 不支持原生审阅权限设置，请更新 Codex 后重试。');
      throw error;
    }
    if (hostId !== state.hostId || authentication !== authenticationGeneration || generation !== selectionGeneration || id !== state.activeThread?.id) throw new Error('会话已切换，审阅尚未启动');
    if (activeTurns.has(id) || state.busy) throw new Error('此会话已开始其他任务，请等待结束后再审阅');
    const result = await rpc('review/start', { threadId: id, target, delivery: 'inline' });
    if (hostId === state.hostId && authentication === authenticationGeneration) {
      hydrateTurnItems(id, result.turn);
      if (revision === (turnRevisions.get(id) || 0)) noteRuntime(id, result.turn.status === 'inProgress', result.turn.status === 'inProgress' ? result.turn.id : undefined);
      if (id === state.activeThread?.id) {
        const index = state.turns.findIndex(turn => turn.id === result.turn.id);
        if (index >= 0) state.turns[index] = mergeTurnSnapshot(state.turns[index], result.turn);
        else state.turns.push(result.turn);
      }
      saveConversationSnapshot();
    }
    return result;
  } finally { sendInFlight = false; }
}
function rememberProject(rememberSelection = false) {
  const paths = saved<Record<string, string>>("codex.projectPaths", {});
  paths[state.hostId] = state.projectPath;
  browserStorage.local.setItem("codex.projectPaths", JSON.stringify(paths));
  if (rememberSelection) {
    const projectless = saved<Record<string, boolean>>('codex.projectlessHosts', {});
    projectless[state.hostId] = state.noProject;
    browserStorage.local.setItem('codex.projectlessHosts', JSON.stringify(projectless));
  }
}
async function addProject(
  path: string,
  name?: string,
  rootPaths?: string[],
  hostId = state.hostId,
) {
  const generation = selectionGeneration;
  const authentication = authenticationGeneration;
  if (!state.hosts.some((host) => host.id === hostId))
    throw new Error("主机不存在");
  const result = await http("/projects", {
    method: "POST",
    body: JSON.stringify({ path, name, rootPaths, hostId }),
  });
  if (authentication !== authenticationGeneration || !state.authenticated) return;
  if (result.projects) replaceProjects(result.projects);
  else {
    const project = result.project ?? result;
    replaceProjects([
      ...state.projects.filter(
        (item) => item.path !== path || item.hostId !== hostId,
      ),
      project,
    ]);
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
async function chooseNewContext(hostId: string, projectPath?: string | null) {
  if (state.activeThread || state.busy || state.selectingThread ||
      state.switchingHost || state.changingContext || sendInFlight)
    throw new Error("请等待当前操作完成后选择新对话位置");
  if (state.attachmentsLoading) throw new Error('正在恢复附件草稿，请稍后选择新对话位置');
  if (!state.hosts.some((host) => host.id === hostId))
    throw new Error("主机不存在");
  if (projectPath != null && !state.projects.some((project) =>
      (project.hostId || "local") === hostId &&
      [project.path, ...(project.rootPaths || [])].includes(projectPath)) &&
      !(hostId === state.hostId && projectPath === state.projectPath))
    throw new Error("所选项目不属于这台主机");
  const noProject = projectPath === null || projectPath === undefined &&
    (hostId === state.hostId ? state.noProject : saved<Record<string, boolean>>('codex.projectlessHosts', {})[hostId] === true);
  if (hostId === state.hostId && noProject === state.noProject &&
      (projectPath == null || projectPath === state.projectPath)) return true;
  const previousHost = state.hostId;
  const previousDraft = attachmentDraftScope;
  const attachments = state.attachments;
  const originals = attachments.map(originalAttachment);
  state.changingContext = true;
  restoringAttachments = true;
  state.attachments = [];
  restoringAttachments = false;
  let restored = false;
  let moved = false;
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
    const preferredPath = noProject ? state.projectPath : projectPath ?? state.projects.find((project) =>
      (project.hostId || "local") === hostId &&
      [project.path, ...(project.rootPaths || [])].includes(state.projectPath))?.path ??
      state.projects.find((project) => (project.hostId || "local") === hostId)?.path;
    if (preferredPath && (preferredPath !== state.projectPath || noProject !== state.noProject)) {
      const changingProject = setProject(preferredPath, noProject);
      expectedSelection = selectionGeneration;
      await changingProject;
      if (!current()) return false;
    }
    if (!current()) return false;
    if (previousHost === hostId) {
      const destination = await attachmentDrafts.read(attachmentDraftScope, hostId);
      if (!current()) return false;
      state.attachments = [...destination, ...attachments.filter(file => !destination.some(existing => existing.id === file.id))];
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
    moved = true;
    if (previousDraft !== attachmentDraftScope) void attachmentSave(previousDraft, previousHost, []);
    return true;
  } finally {
    if (moved && !restored) releaseAttachments(attachments);
    state.changingContext = false;
  }
}
async function updateProject(
  project: any,
  fields: { name: string; rootPaths?: string[] },
) {
  const authentication = authenticationGeneration;
  const result = await http("/projects", {
    method: "PATCH",
    body: JSON.stringify({
      hostId: project.hostId || "local",
      path: project.path,
      ...fields,
    }),
  });
  if (authentication !== authenticationGeneration || !state.authenticated) return;
  replaceProjects(result.projects);
  toast("项目已更新");
}
async function removeProject(project: any) {
  const hostId = project.hostId || "local";
  const authentication = authenticationGeneration;
  const result = await http("/projects", {
    method: "DELETE",
    body: JSON.stringify({ hostId, path: project.path }),
  });
  if (authentication !== authenticationGeneration || !state.authenticated) return;
  replaceProjects(result.projects);
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
  const authentication = authenticationGeneration;
  const hostConfiguration = JSON.stringify(state.hosts.find(host => host.id === hostId));
  const configuration = (entry: any) => JSON.stringify([entry.id, entry.name, entry.path, entry.rootPaths || [], entry.source]);
  const original = configuration(project);
  const target = () => state.projects.find(entry => (entry.hostId || 'local') === hostId && entry.path === project.path);
  const confirmScope = () => {
    const current = target();
    if (authentication !== authenticationGeneration || !state.authenticated ||
        !state.hosts.some(host => host.id === hostId) || JSON.stringify(state.hosts.find(host => host.id === hostId)) !== hostConfiguration ||
        !current || configuration(current) !== original)
      throw new Error('登录状态、主机或项目配置已变化，请重新确认后归档');
  };
  confirmScope();
  // Directory and project membership are independent after a desktop/Web move.
  // Never use a cached (or failed) binding read for this bulk operation.
  const bindings = await http(`/projects/native-bindings?hostId=${encodeURIComponent(hostId)}`, {}, false);
  confirmScope();
  if (typeof bindings.supported !== 'boolean' || !Array.isArray(bindings.bindings) ||
      bindings.bindings.some((entry: any) => typeof entry?.path !== 'string' || typeof entry?.projectId !== 'string' || !entry.projectId.trim()) ||
      !bindings.supported && bindings.bindings.length)
    throw new Error('无法确认项目归属，对话未归档；请检查目标服务器的 Codex 版本');
  const identities = new Set<string>(bindings.bindings.filter((entry: any) => entry.path === project.path).map((entry: any) => entry.projectId));
  if (identities.size > 1) throw new Error('项目归属存在冲突，对话未归档；请刷新后重试');
  const nativeProjectId = identities.values().next().value;
  const membership = { ...project, hostId, nativeProjectId };
  const roots = [...new Set<string>([project.path, ...(project.rootPaths || [])])];
  const ids = new Set<string>();
  const queries: Record<string, any>[] = [
    ...(nativeProjectId ? [{ projectId: nativeProjectId }] : []),
    ...roots.map(cwd => ({ cwd: [cwd], ...(bindings.supported ? { projectId: null } : {}) })),
  ];
  for (const query of queries) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await threadPage(hostId, "thread/list", {
        ...query,
        archived: false,
        limit: 100,
        cursor,
        modelProviders: [],
      });
      confirmScope();
      for (const thread of page.data) {
        if (typeof thread?.id !== 'string' || !thread.id) throw new Error('项目对话列表格式不兼容，对话未归档');
        if (threadMatchesProject(thread, membership)) ids.add(thread.id);
      }
      if (page.nextCursor != null && typeof page.nextCursor !== 'string')
        throw new Error('项目历史分页格式不兼容，对话未归档');
      cursor = page.nextCursor || undefined;
      if (cursor && seen.has(cursor))
        throw new Error("项目历史分页重复，请刷新后重试");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  let archived = 0;
  try {
    for (const id of ids) {
      confirmScope();
      const revision = projectChangeSequence;
      const result = await scopedRpc(hostId, 'thread/read', { threadId: id, includeTurns: false });
      confirmScope();
      if (result.thread?.id !== id || typeof result.thread.cwd !== 'string' ||
          bindings.supported && result.thread.projectId !== null && typeof result.thread.projectId !== 'string' ||
          !bindings.supported && result.thread.projectId != null && typeof result.thread.projectId !== 'string')
        throw new Error('无法重新确认对话归属，请同步项目后重试');
      const change = threadProjectChanges.get(recencyKey(hostId, id));
      const thread = change && change.revision > revision ? { ...result.thread, projectId: change.projectId } : result.thread;
      // Another client can move a conversation while the list is loading.
      if (!threadMatchesProject(thread, membership)) continue;
      if (thread.status?.type === 'active') throw new Error('此会话正在运行，请先停止或等待完成后再归档');
      await archiveThread(id, hostId);
      archived++;
      confirmScope();
    }
  } catch (error: any) {
    throw new Error(`已归档 ${archived} 个对话，其余未完成：${error.message}`);
  }
  toast(`已归档 ${archived} 个对话，可在已归档对话中恢复`);
}
async function setHost(id: string, options: { threadId?: string } = {}) {
  if (id ? !state.hosts.some((host) => host.id === id) : state.hosts.length > 0)
    throw fail(new Error("主机不存在"));
  if (id === state.hostId && (state.connected || connecting)) {
    // Another conversation on the destination host can be selected while its
    // first handshake/configuration is still pending. Keep that transport and
    // invalidate the older selection before awaiting it; restarting setHost
    // would repeatedly close the same connection and reject its native reads.
    const hostGeneration = hostSelectionGeneration;
    const authentication = authenticationGeneration;
    const selection = ++selectionGeneration;
    try { if (!state.connected) await connect(); }
    catch (error) {
      if (hostGeneration === hostSelectionGeneration && authentication === authenticationGeneration && selection === selectionGeneration && id === state.hostId) throw error;
      return;
    }
    if (hostGeneration !== hostSelectionGeneration || authentication !== authenticationGeneration ||
        selection !== selectionGeneration || id !== state.hostId || state.runtimePaused) return;
    if (options.threadId) await selectThread(options.threadId);
    return;
  }
  const hostGeneration = ++hostSelectionGeneration;
  state.switchingHost = true;
  const previous = hostNavigation(state.hostId);
  saveConversationSnapshot();
  previous.threads = [...state.threads];
  previous.cursor = threadCursor;
  previous.loadedMore = loadedMorePages;
  previous.loaded = state.connected || previous.loaded;
  previous.projectPages = { ...state.projectThreadPages };
  closeConnection({ retainHost: true });
  discardedTurns.clear();
  completedTurns.clear();
  seenThreadChanges.clear();
  revertedTurnCandidates.clear();
  localReverts.clear();
  pendingMessageEdit = null;
  activeTurns.clear();
  writerAttachment = null;
  engineId = null;
  eventSequence = null;
  socketHasEventGap = false;
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
  // newThread saves the outgoing selection into this host-local cache. Clear
  // afterwards so equal native IDs on different hosts cannot share live arrays.
  itemCache.clear();
  state.threads = [...(state.navigation[id]?.threads ?? [])];
  state.projectThreadPages = {};
  state.pendingRequests = [];
  state.hostId = id;
  state.runtimePaused = pausedHosts.has(id);
  state.agentActivity = {};
  state.model = "";
  state.models = [];
  state.config = null;
  state.requirements = null;
  state.nativePermissionProfiles = [];
  resetModeContext();
  state.apps = [];
  state.mcpServers = [];
  state.integrationErrors = [];
  state.rateLimits = null;
  state.nativeServiceTier = null;
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
  browserStorage.local.setItem("codex.hostId", JSON.stringify(id));
  state.projectPath = id ?
    saved<Record<string, string>>("codex.projectPaths", {})[id] ??
    state.hosts.find((host) => host.id === id)?.cwd ??
    (id === "local" ? localCwd : "/tmp") : "";
  state.noProject = !!id && saved<Record<string, boolean>>('codex.projectlessHosts', {})[id] === true;
  if (!id) {
    state.threadReady = false;
    state.switchingHost = false;
    return;
  }
  const target = options.threadId;
  const authentication = authenticationGeneration;
  const selection = selectionGeneration;
  const current = () => id === state.hostId && hostGeneration === hostSelectionGeneration &&
    authentication === authenticationGeneration;
  const previewCurrent = () => current() && selection === selectionGeneration &&
    state.activeThread?.id === target && !state.threadReady;
  if (target) {
    // Select before the first await: switching transports must never briefly
    // present a new-chat welcome screen or the previous host's conversation.
    const cached = conversationCache.peek(id, target);
    state.activeThread = state.threads.find(thread => thread.id === target) ?? cached?.thread ?? { id: target };
    state.noProject = isProjectlessThread(state.activeThread);
    if (state.activeThread.cwd) state.projectPath = state.activeThread.cwd;
    state.threadReady = false;
    state.selectingThread = true;
    state.threadReleased = releasedThreads.get(id)?.has(target) || false;
    rememberThread(target);
    if (cached) applyConversationSnapshot(cached, target);
    else void conversationCache.read(id, target).then(snapshot => {
      if (snapshot && previewCurrent() && !state.items.length)
        applyConversationSnapshot(snapshot, target);
    });
  }
  startNavigationRefresh();
  const retainedSocket = hostConnections.get(id)?.socket;
  try {
    await connect();
    if (!current()) return;
    if (state.runtimePaused) return;
    if (retainedSocket && socket === retainedSocket) {
      // Probe a parked OPEN socket before using it. This also refreshes the
      // bounded terminal snapshot and pending approvals missed while inactive.
      try { await probeConnection({ includeState: true }); }
      catch {
        if (!current() || socket !== retainedSocket) return;
        closeConnection();
        await connect();
      }
      if (!current() || state.runtimePaused) return;
    }
    if (!target) { await sync(); return; }
    // A read-only first page can paint while managed permissions are loading.
    // Resume still performs its own fresh read before confirming a writer.
    if (!state.items.length) {
      const revision = itemEventSequence;
      void history(target, null, id).then(page => {
        if (!previewCurrent() || state.items.length || revision !== itemEventSequence) return;
        state.turns = [...page.data].reverse();
        state.items = state.turns.flatMap(turn => (turn.items || []).map((item: any) => ({ ...item, turnId: turn.id })));
        turnCursor = page.nextCursor;
        state.moreTurns = !!turnCursor;
      }).catch(() => {});
    }
    void Promise.allSettled([refreshThreads(), loadModeCapabilities(), loadSkills()]);
    await readConfig();
    if (!previewCurrent()) return;
    await selectThread(target);
  } catch (error) {
    // A retired background handshake cannot replace the destination's errors.
    if (current()) throw error;
  } finally {
    if (current()) {
      state.switchingHost = false;
      if (target && state.activeThread?.id === target) state.selectingThread = false;
    }
  }
}
async function testHost(host: any) {
  return http(
    "/hosts/test",
    { method: "POST", body: JSON.stringify(host) },
    false,
  );
}
async function inspectHostKey(fields: { hostname: string; port?: number | null }) {
  return http('/hosts/key/inspect', { method: 'POST', body: JSON.stringify(fields) }, false);
}
async function trustHostKey(fields: { hostname: string; port?: number | null; challenge: string; replace: boolean }) {
  return http('/hosts/key/trust', { method: 'POST', body: JSON.stringify(fields) }, false);
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
  if (added && !state.hostId) await setHost(added.id).catch(() => toast("SSH 主机已添加；暂时无法连接"));
  else if (added) void refreshHostNavigation(added.id);
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
    retireHostConnection(id);
    conversationCache.removeHost(id);
    for (const key of tokenUsages.keys()) if (JSON.parse(key)[0] === id) tokenUsages.delete(key);
    if (state.hostId === id) { state.threadReady = false; itemCache.clear(); }
    advanceNavigationRevision(id);
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
  void attachmentDrafts.forgetHost(id).catch(() => {});
  retireHostConnection(id);
  advanceNavigationRevision(id);
  navigationRequests.delete(id);
  delete state.navigation[id];
  replaceProjects(state.projects.filter((project) => project.hostId !== id));
  if (state.hostId === id) await setHost(state.hosts[0]?.id || "");
  conversationCache.removeHost(id);
  for (const key of tokenUsages.keys()) if (JSON.parse(key)[0] === id) tokenUsages.delete(key);
}
async function reorderHosts(hostIds: string[]) {
  if (!validHostOrder(hostIds) || hostIds.length !== state.hosts.length ||
    hostIds.some(id => !state.hosts.some(host => host.id === id)))
    throw new Error('连接列表已变化，请重新调整主机顺序');
  const authentication = authenticationGeneration;
  const revision = hostOrderRevision;
  const result = await http('/hosts/order', { method: 'PATCH', body: JSON.stringify({ hostIds }) }, false);
  if (authentication !== authenticationGeneration || !state.authenticated) return;
  const savedIds = Array.isArray(result.hosts) ? result.hosts.map((host: any) => host?.id) : null;
  if (!validHostOrder(savedIds)) throw new Error('主机顺序响应无效，请重新加载连接列表');
  // A shared event may arrive before this ACK, including a later change from
  // another device. Preserve that newer order and any hosts added or removed.
  if (revision === hostOrderRevision) state.hosts = orderHosts(state.hosts, savedIds);
  return result;
}
async function reorderProjects(projects: ProjectOrderEntry[]) {
  const known = new Set(state.projects.map(projectOrderKey));
  if (!validProjectOrder(projects) || projects.length !== known.size || projects.some(project => !known.has(projectOrderKey(project))))
    throw new Error('项目列表已变化，请重新调整顺序');
  const authentication = authenticationGeneration;
  const revision = projectOrderRevision;
  const result = await http('/projects/order', { method: 'PATCH', body: JSON.stringify({ projects }) }, false);
  if (authentication !== authenticationGeneration || !state.authenticated) return;
  const savedOrder = Array.isArray(result.projects) ? result.projects.map((project: any) => ({ hostId: project?.hostId || 'local', path: project?.path })) : null;
  if (!validProjectOrder(savedOrder)) throw new Error('项目顺序响应无效，请重新加载项目列表');
  if (revision === projectOrderRevision) {
    latestProjectOrder = savedOrder;
    state.projects = orderProjects(state.projects, latestProjectOrder);
  }
  return result;
}
let hostAvailabilityRequest: Promise<void> | null = null;
function refreshHostAvailability(): Promise<void> {
  if (hostAvailabilityRequest) return hostAvailabilityRequest;
  const authentication = authenticationGeneration;
  const operation = (async () => {
    const result = await http('/hosts', {}, false);
    if (authentication !== authenticationGeneration || !state.authenticated) return;
    state.hosts = result.hosts;
    pruneHostConnections();
    state.localEnabled = result.localEnabled ?? result.hosts.some((host: any) => host.id === 'local');
    if (Array.isArray(result.projects)) replaceProjects(result.projects);
    if (!state.hosts.some(host => host.id === state.hostId)) {
      await setHost(state.hosts[0]?.id || '').catch(() => toast('连接已更新；远程主机暂时无法连接'));
    }
  })();
  const request = operation.finally(() => { if (hostAvailabilityRequest === request) hostAvailabilityRequest = null; });
  hostAvailabilityRequest = request;
  return request;
}
/** Disabling a local executor never deletes its projects or conversation cache. */
async function setLocalEnabled(enabled: boolean) {
  const authentication = authenticationGeneration;
  const result = await http('/hosts/local/enabled', {
    method: 'PATCH', body: JSON.stringify({ enabled }),
  }, false);
  if (authentication !== authenticationGeneration || !state.authenticated) return;
  state.localEnabled = result.localEnabled ?? enabled;
  state.hosts = result.hosts;
  pruneHostConnections();
  if (Array.isArray(result.projects)) replaceProjects(result.projects);
  advanceNavigationRevision('local');
  navigationRequests.delete('local');
  invalidateThreadTitleSearch('local');
  settingsApi.invalidateHostSettings('local');
  if (!state.hosts.some(host => host.id === state.hostId)) {
    // Saving the setting succeeded even when the selected SSH server is offline.
    await setHost(state.hosts[0]?.id || '').catch(() => toast('设置已保存；所选远程主机暂时无法连接'));
  } else if (enabled && state.hostId !== 'local') void refreshHostNavigation('local');
  toast(state.localEnabled ? '本机 Codex 已启用' : '本机 Codex 已停用，Web 服务继续运行');
  return result;
}
function prepareFileUpload() {
  const target = { identity: attachmentDraftScope || attachmentIdentity(), hostId: state.hostId,
    cwd: state.projectPath, authentication: authenticationGeneration, threadId: state.activeThread?.id };
  return (files: FileList | File[], reportError = false) => uploadFiles(files, reportError, target);
}
async function uploadFiles(files: FileList | File[], reportError = true, target = {
  identity: attachmentDraftScope || attachmentIdentity(), hostId: state.hostId, cwd: state.projectPath,
  authentication: authenticationGeneration, threadId: state.activeThread?.id,
}) {
  const { identity, hostId, cwd, authentication, threadId } = target;
  if (authentication !== authenticationGeneration || !state.authenticated || !state.hosts.some(host => host.id === hostId) ||
    threadId && deletedThreads.has(recencyKey(hostId, threadId))) return;
  const originals = Array.from(files);
  await cacheActivation;
  await attachmentDrafts.read(identity, hostId);
  if (authentication !== authenticationGeneration || !state.authenticated) return;
  const form = new FormData();
  form.set("hostId", hostId);
  form.set("cwd", cwd);
  for (const file of originals) form.append("files", file);
  const result = await http("/uploads", { method: "POST", body: form }, reportError);
  if (authentication !== authenticationGeneration || !state.authenticated || !state.hosts.some(host => host.id === hostId) ||
    threadId && deletedThreads.has(recencyKey(hostId, threadId))) return;
  const additions = result.files.map((file: any, index: number) => {
      const attachment = { ...file, id: randomUUID(), hostId, original: originals[index], lastModified: originals[index]?.lastModified, previewUrl:
        file.mime?.startsWith("image/") && originals[index]
          ? URL.createObjectURL(originals[index])
          : undefined };
      if (originals[index]) attachmentOriginals.set(attachment, originals[index]);
      return attachment;
    });
  const current = attachmentDrafts.peek(identity) || [];
  await attachmentSave(identity, hostId, [...current, ...additions]);
  if (authentication === authenticationGeneration && identity === attachmentDraftScope) {
    restoringAttachments = true; state.attachments = attachmentDrafts.peek(identity) || []; restoringAttachments = false;
  }
}
/** Edit uploads belong to the inline draft, never the next-message composer. */
async function uploadEditFiles(itemId: string, files: FileList | File[]) {
  if (!canEditMessage(itemId) || sendInFlight || state.editingMessage)
    throw new Error('当前无法上传编辑附件，请等待发送或同步完成');
  const hostId = state.hostId;
  const threadId = state.activeThread?.id;
  const authentication = authenticationGeneration;
  const cwd = state.projectPath;
  const originals = Array.from(files);
  if (!originals.length) return [];
  const form = new FormData();
  form.set('hostId', hostId);
  form.set('cwd', cwd);
  for (const file of originals) form.append('files', file);
  const result = await http('/uploads', { method: 'POST', body: form }, false);
  // A history refresh on the same destination must not discard a completed
  // upload. The component also checks the captured editor session identity.
  if (authentication !== authenticationGeneration ||
      hostId !== state.hostId || threadId !== state.activeThread?.id || cwd !== state.projectPath)
    throw new Error('会话已切换，附件未加入其他会话；请返回原会话重新上传');
  return result.files.map((file: any, index: number) => ({ ...file,
    previewUrl: file.mime?.startsWith('image/') && originals[index]?.type.startsWith('image/')
      ? URL.createObjectURL(originals[index]) : undefined,
  }));
}
function removeAttachment(index: number) {
  consumeAttachmentDraft(attachmentDraftScope, state.hostId, state.attachments.slice(index, index + 1));
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
async function readFile(path: string, options: { silentError?: boolean; hostId?: string } = {}) {
  const result = await http(`/hosts/${encodeURIComponent(options.hostId || state.hostId)}/files?path=${encodeURIComponent(path)}`, {}, !options.silentError);
  if (result.dataBase64.length > Math.ceil((8 * 1024 * 1024) / 3) * 4)
    throw (options.silentError ? new Error("文件超过 8 MB，请使用终端读取") : fail(new Error("文件超过 8 MB，请使用终端读取")));
  const extensions: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    avif: "image/avif",
    pdf: "application/pdf",
  };
  const mime =
    extensions[path.split(".").pop()?.toLowerCase() ?? ""] ?? officeMime(path) ?? "text/plain";
  let content = "";
  let binary = false;
  if (officeMime(path)) binary = true;
  else if (!mime.startsWith("image/")) {
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
    version: result.version,
    mime,
    content,
    binary,
    dataBase64: mime === 'application/pdf' || officeMime(path) ? result.dataBase64 : undefined,
    dataUrl: mime.startsWith("image/")
      ? `data:${mime};base64,${result.dataBase64}`
      : undefined,
  };
}
async function downloadFile(path: string) {
  if (!state.authenticated || !state.hosts.some(host => host.id === state.hostId))
    throw new Error('请先登录并选择文件所在主机');
  if (!path.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(path)) throw new Error('需要绝对文件路径');
  // Hand the transfer to the browser's download manager. Large files never
  // enter the WebSocket, a Base64 string, or a browser-sized in-memory Blob.
  const link = document.createElement("a");
  link.href = `/api/hosts/${encodeURIComponent(state.hostId)}/download?path=${encodeURIComponent(path)}`;
  link.download = path.split("/").pop() || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
async function writeFile(path: string, content: string, expectedVersion: string, hostId = state.hostId) {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > 8 * 1024 * 1024) throw new Error("文件超过 8 MB，请使用终端保存");
  const body = new FormData();
  body.set("path", path);
  body.set("expectedVersion", expectedVersion);
  body.set("file", new Blob([bytes], { type: "application/octet-stream" }), "content");
  const result = await http(`/hosts/${encodeURIComponent(hostId)}/files`, { method: "POST", body });
  toast("文件已保存");
  return result;
}
type ModelSettingsChange = { model?: string; effort?: string; serviceTier?: string | null };
let modelSettingsOperation = 0;
watch([() => state.hostId, () => state.activeThread?.id, () => state.projectPath,
  () => state.authenticationGeneration, () => state.connected, () => state.selectingThread], () => {
  ++modelSettingsOperation;
  state.modelSettingsBusy = false;
  state.modelSettingsNotice = "";
}, { flush: 'sync' });
function queueSettingsOperationPending() {
  const queue = messageQueue?.state;
  return !!(queue?.restoring || queue?.loading || queue?.mutating || queue?.uncertain);
}
async function changeModelSettings(change: ModelSettingsChange) {
  if (!state.connected || state.switchingHost || state.selectingThread || state.changingContext || state.modeBusy || state.modelSettingsBusy ||
      state.editingMessage || sendInFlight || queueSettingsOperationPending()) throw new Error("请等待当前设置或消息提交完成后重试");
  if (state.activeThread && (!state.threadReady || state.threadReleased || state.threadConflict)) throw new Error("请先恢复当前会话连接");
  const model = change.model ?? state.model;
  const selectedModel = state.models.find(entry => entry.model === model && !entry.hidden);
  if (change.model && !selectedModel) throw new Error("当前主机没有提供此模型");
  if (change.effort && selectedModel?.supportedReasoningEfforts?.length &&
      !selectedModel.supportedReasoningEfforts.some((entry: any) => entry.reasoningEffort === change.effort)) throw new Error("当前模型不支持此推理强度");
  if ('serviceTier' in change && change.serviceTier !== null && !modelServiceTiers(state).some(tier => tier.id === change.serviceTier))
    throw new Error("当前主机的模型目录未提供此服务层级");
  const hostId = state.hostId, threadId = state.activeThread?.id, cwd = state.projectPath;
  const authentication = authenticationGeneration, selection = selectionGeneration, selectedEngine = engineId, selectedSocket = socket;
  const operation = ++modelSettingsOperation;
  const current = () => operation === modelSettingsOperation && authentication === authenticationGeneration && hostId === state.hostId &&
    threadId === state.activeThread?.id && cwd === state.projectPath && selection === selectionGeneration && selectedEngine === engineId && selectedSocket === socket && state.connected;
  const assertCurrent = () => { if (!current()) throw new Error("会话状态已变化，请在当前会话重新调整设置"); };
  state.modelSettingsBusy = true;
  state.modelSettingsNotice = "";
  try {
    // Unknown/old runtimes can still select model and effort for the next
    // explicit turn/start, whose request already carries these fields.
    let capabilities: any = null;
    try { capabilities = await http(`/hosts/${encodeURIComponent(hostId)}/native-capabilities`, {}, false); } catch {}
    assertCurrent();
    const fields = Object.keys(change);
    const queued = !!messageQueue?.state.items.length;
    let saved = false;
    if (threadId && !queued && methodAccepts(capabilities, 'thread/settings/update', ['threadId', ...fields])) {
      try {
        await rpc('thread/settings/update', { threadId, ...change } as any, 15000, { silentError: true });
        saved = true;
      } catch (cause: any) { if (cause.code !== -32601) throw cause; }
      assertCurrent();
    }
    if ('serviceTier' in change && !saved && !methodAccepts(capabilities, 'turn/start', ['threadId', 'input', 'serviceTier']))
      throw new Error("当前 Codex 的原生服务层级协议尚未确认，请更新 Codex 或稍后重试");
    if (change.model) state.model = change.model;
    if (change.effort) state.effort = change.effort;
    if ('serviceTier' in change) {
      state.serviceTier = change.serviceTier;
      state.serviceTierScope = serviceTierScope(state);
      if (saved) state.nativeServiceTier = change.serviceTier ?? null;
    }
    const queueNotice = queued ? "；已排队消息保留原设置" : "";
    const futureNotice = queued
      ? `已选择，下一次手动发送新一轮时生效${queueNotice}`
      : "已保存，后续新一轮生效";
    const activeTurnId = threadId && state.busy ? activeTurns.get(threadId) : undefined;
    if (!activeTurnId || !methodAccepts(capabilities, 'turn/settings/update', ['threadId', 'turnId', ...fields])) {
      state.modelSettingsNotice = state.busy || queued ? futureNotice : "";
      return;
    }
    try {
      const result = await rpc('turn/settings/update', { threadId: threadId!, turnId: activeTurnId, ...change } as any, 15000, { silentError: true });
      if (!current()) return;
      state.modelSettingsNotice = result?.status === 'applied' && activeTurns.get(threadId!) === activeTurnId
        ? `已更新，当前任务后续模型请求生效；已发出的请求不变${queueNotice}`
        : futureNotice;
    } catch (cause: any) {
      if (current()) state.modelSettingsNotice = cause.code === -32601 || /step_model_switching|feature.*(?:disabled|require)|only fallback metadata/i.test(cause.message || '')
        ? futureNotice : `${futureNotice}；当前轮未更新：${cause.message || '请稍后重试'}`;
    }
  } finally { if (operation === modelSettingsOperation) state.modelSettingsBusy = false; }
}
async function setModel(model: string) {
  const selected = state.models.find(entry => entry.model === model && !entry.hidden);
  if (!selected) throw new Error("当前主机没有提供此模型");
  const efforts = selected.supportedReasoningEfforts || [];
  const effort = efforts.length && !efforts.some((entry: any) => entry.reasoningEffort === state.effort)
    ? selected.defaultReasoningEffort || efforts[0].reasoningEffort : state.effort;
  const override = serviceTierParams(state);
  const explicitTier = Object.prototype.hasOwnProperty.call(override, 'serviceTier');
  const tier = explicitTier ? override.serviceTier : state.nativeServiceTier;
  // An advertised tier list is an explicit compatibility boundary. An omitted
  // catalog is unknown, so leave that validation to the native runtime.
  const unsupportedTier = !!tier && Array.isArray(selected.serviceTiers) && !selected.serviceTiers.some((entry: any) => entry.id === tier);
  await changeModelSettings({ model, effort, ...(unsupportedTier ? { serviceTier: null } : explicitTier ? { serviceTier: tier ?? null } : {}) });
}
async function setReasoningEffort(effort: string) { await changeModelSettings({ effort }); }
async function setServiceTier(value: string | null) { await changeModelSettings({ serviceTier: value }); }

async function runTerminal(command: string) {
  if (state.terminalRunning) throw fail(new Error("已有终端命令正在运行"));
  const hostId = state.hostId, authentication = authenticationGeneration;
  const processId = `web-${randomUUID()}`;
  rememberTerminal(processId);
  state.terminalRunning = true;
  state.terminalSessionName = "";
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
      hostId === state.hostId && authentication === authenticationGeneration &&
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
    if (hostId === state.hostId && authentication === authenticationGeneration && state.terminalProcessId === processId && !uncertain)
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
  const hostId = state.hostId, authentication = authenticationGeneration;
  state.terminalProcesses = [...state.terminalProcesses, {
    processId, tty: true, cwd: state.projectPath, startedAt: Date.now(), lastOutput: "", pending: true,
  }];
  state.terminalSessionName = options.persistent
    ? options.sessionName || "tmux"
    : "";
  if (state.terminalSessionName)
    terminalSessionNames.set(
      `${state.hostId}:${processId}`,
      state.terminalSessionName,
    );
  let uncertain = false;
  try {
    const result = await rpc(
      "command/exec",
      {
        command: options.command || [...interactiveShellCommand],
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
      hostId === state.hostId && authentication === authenticationGeneration &&
      state.terminalProcessId === processId &&
      !completedTerminalProcesses.has(processId)
    )
      appendTerminal(`\r\n[终端退出 ${result.exitCode}]\r\n`);
  } catch (error) {
    uncertain = !!(error as { uncertain?: boolean }).uncertain;
    throw error;
  } finally {
    if (hostId === state.hostId && authentication === authenticationGeneration && !uncertain) {
      state.terminalProcesses = state.terminalProcesses.filter(process => process.processId !== processId);
      if (state.terminalProcessId === processId) state.terminalRunning = false;
    }
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
  if (state.terminalRunning && state.terminalSessionName) await stopTerminal(state.terminalProcessId, false);
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
async function resizeTerminal(cols: number, rows: number, processId = state.terminalProcessId) {
  if (state.terminalRunning && processId && processId === state.terminalProcessId)
    await rpc("command/exec/resize", {
      processId,
      size: { cols, rows },
    });
}
async function writeTerminal(text: string, processId = state.terminalProcessId) {
  if (!state.connected || !state.terminalRunning || !processId || processId !== state.terminalProcessId)
    throw new Error("终端连接已变化，请重新选择终端后输入");
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  await rpc("command/exec/write", {
    processId,
    deltaBase64: btoa(binary),
  });
}
async function stopTerminal(processId = state.terminalProcessId, selectNext = true) {
  if (!processId) return;
  const hostId = state.hostId, authentication = authenticationGeneration;
  await rpc("command/exec/terminate", { processId });
  if (hostId !== state.hostId || authentication !== authenticationGeneration) return;
  state.terminalProcesses = state.terminalProcesses.filter(process => process.processId !== processId);
  if (state.terminalProcessId !== processId) return;
  state.terminalRunning = false;
  state.terminalSessionName = "";
  const next = state.terminalProcesses.find(process => process.tty && process.cwd === state.projectPath);
  if (next && selectNext) attachTerminal(next.processId);
}
async function listSubagents(threadId: string, cursor: string | null = null) {
  if (!threadId) return { data: [], nextCursor: null };
  return rpc('thread/list', {
    ancestorThreadId: threadId, sourceKinds: ['subAgent'], modelProviders: [],
    cursor, limit: 60,
  }, 45000, { silentError: true });
}
async function readSubagent(threadId: string, cursor: string | null = null) {
  const hostId = state.hostId;
  const [metadata, page] = await Promise.all([
    rpc('thread/read', { threadId, includeTurns: false }, 45000, { silentError: true }),
    rpc('thread/turns/list', { threadId, cursor, limit: 30, sortDirection: 'desc', itemsView: 'full' }, 45000, { silentError: true }),
  ]);
  if (hostId !== state.hostId) throw new Error('工作站已切换');
  return { thread: metadata.thread, turns: [...page.data].reverse(), nextCursor: page.nextCursor };
}
function getSubagentSnapshot(threadId: string) {
  if (!state.authenticated) return null;
  const thread = state.threads.find(thread => thread.id === threadId);
  const items = state.activeThread?.id === threadId ? state.items : itemCache.get(threadId);
  if (!thread && !items) return null;
  const turns = state.activeThread?.id === threadId ? state.turns : [...new Set((items || []).map(item => item.turnId).filter(Boolean))]
    .map(id => ({ id, items: (items || []).filter(item => item.turnId === id),
      ...(state.agentActivity[threadId]?.turnId === id && state.agentActivity[threadId]?.turnStatus
        ? { status: state.agentActivity[threadId].turnStatus }
        : activeTurns.get(threadId) === id ? { status: 'inProgress' } : {}) }));
  return { thread, items: items || [], turns };
}
function respond(id: string | number, result: any) {
  if (!socket || !state.connected || socket.readyState !== WebSocket.OPEN)
    throw fail(new Error("连接断开，请等待重新连接后审批"));
  socket.send(JSON.stringify({ id, result }));
  state.pendingRequests = state.pendingRequests.filter(
    (request) => request.id !== id,
  );
}
function readConfig(force = false, preserveChoices = false): Promise<void> {
  const requestScope = scope();
  const requestSocket = socket;
  if (!force && configurationRequest?.scope === requestScope && configurationRequest.socket === requestSocket)
    return configurationRequest.promise;
  const operation = loadConfig(preserveChoices || preserveMetadataChoices()).finally(() => {
    if (configurationRequest?.promise === operation) configurationRequest = null;
  });
  configurationRequest = { scope: requestScope, socket: requestSocket, promise: operation };
  return operation;
}
async function ensureConfiguration() {
  if (configurationRequest?.scope === scope() && configurationRequest.socket === socket)
    await configurationRequest.promise;
  else if (verifiedConfiguration?.scope !== scope() || verifiedConfiguration.socket !== socket)
    await readConfig();
  if (verifiedConfiguration?.scope !== scope() || verifiedConfiguration.socket !== socket)
    throw new Error('主机配置尚未确认，请同步后重试。');
}
async function loadConfig(preserveChoices = false) {
  const generation = ++configGeneration;
  const requestScope = scope();
  const requestSocket = socket;
  const requestAuthentication = authenticationGeneration, requestEngine = engineId;
  verifiedConfiguration = null;
  const current = () => generation === configGeneration && requestScope === scope() && requestSocket === socket &&
    requestAuthentication === authenticationGeneration && state.authenticated && requestEngine === engineId;
  const optional = (method: Method, params: any, apply: (value: any) => void) =>
    rpc(method, params, 45000, { silentError: true }).then(value => {
      if (current()) apply(value);
    }).catch(() => {});
  // Account and quota endpoints can wait on a provider's network. They are
  // useful metadata, but never prerequisites for reading or resuming a thread.
  void optional("account/read", { refreshToken: false }, value => { state.account = value.account; });
  void optional("account/rateLimits/read", {}, value => { state.rateLimits = value; });
  void optional("permissionProfile/list", { cwd: state.projectPath || undefined }, value => {
    state.nativePermissionProfiles = value.data || [];
  });
  // Start the model catalogue concurrently, but apply it after configuration
  // so the provider's default cannot override the user's configured model.
  const modelsRequest = (async () => {
    const data: any[] = [], cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: any = await rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 45000, { silentError: true });
      if (!current()) return null;
      if (!Array.isArray(page.data)) throw new Error('Codex 返回了无效的模型列表');
      data.push(...page.data);
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
      if (data.length > 10000 || cursor && cursors.has(cursor)) throw new Error('模型列表分页无法完成');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { data };
  })().then(value => ({ value }), () => ({ value: null }));
  const results = await Promise.allSettled([
    rpc("config/read", {
      includeLayers: true,
      cwd: state.projectPath || undefined,
    }),
    rpc("configRequirements/read", undefined, 45000, { silentError: true }),
  ]);
  if (!current()) return;
  const config = results[0];
  const requirements = results[1];
  if (config.status === "rejected") throw config.reason;
  // Older Codex versions do not expose managed requirements. A network or
  // runtime failure is different: do not resume with an unverified policy.
  if (requirements.status === "rejected" && requirements.reason?.code !== -32601)
    throw requirements.reason;
  state.requirements =
    requirements.status === "fulfilled" ? requirements.value.requirements : null;
  if (config.status === "fulfilled") {
    state.config = config.value;
    const settings = config.value.config;
    if (!state.model && settings.model) state.model = settings.model;
    if (!preserveChoices && settings.model_reasoning_effort)
      state.effort = settings.model_reasoning_effort;
  }
  if (!preserveChoices && !state.activeThread) {
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
  verifiedConfiguration = { scope: requestScope, socket: requestSocket };
  void modelsRequest.then(({ value }) => {
    if (!current() || !value) return;
    state.models = value.data;
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
  });
}
async function saveConfig(edits: any[]) {
  await rpc("config/batchWrite", { edits });
  await readConfig(true);
  toast("已保存到 Codex 配置");
}
function invalidateRuntimeCapabilities() {
  cancelGoalRefresh();
  clearTimeout(capabilityRetryTimer);
  capabilityRetryTimer = undefined;
  capabilityRetryAttempts = 0;
  ++skillsGeneration;
  ++capabilityGeneration;
  skillsRequest = null;
  capabilityRequest = null;
  skillsLoadedScope = "";
  state.skillsLoading = false;
  state.skillsError = "";
  state.modeCapabilities = { plan: false, goal: false, loaded: false };
}
function scheduleCapabilityRetry() {
  if (capabilityRetryTimer || capabilityRetryAttempts >= 5 || !state.authenticated || !state.connected || state.runtimePaused) return;
  if (state.modeCapabilities.loaded && skillsLoadedScope === scope()) return;
  const hostId = state.hostId;
  const engine = engineId;
  const authentication = authenticationGeneration;
  capabilityRetryTimer = setTimeout(() => {
    capabilityRetryTimer = undefined;
    if (hostId !== state.hostId || engine !== engineId || authentication !== authenticationGeneration || !state.connected || state.runtimePaused) return;
    capabilityRetryAttempts++;
    void Promise.allSettled([loadModeCapabilities(), loadSkills()]).then(scheduleCapabilityRetry);
  }, Math.min(30000, 2500 * 2 ** capabilityRetryAttempts));
}
function resetModeContext(clearGoals = false) {
  cancelGoalRefresh();
  invalidateRuntimeCapabilities();
  ++modeOperation;
  state.skills = [];
  state.skillsLoading = false;
  state.skillsError = "";
  state.selectedSkills = [];
  state.modeCapabilities = { plan: false, goal: false, loaded: false };
  state.modeBusy = false;
  state.modeError = "";
  state.goalReadError = "";
  state.goal = null;
  state.goalTokenBudget = null;
  state.goalMode = false;
  state.collaborationMode = 'default';
  if (clearGoals) { goals.clear(); goalRevisions.clear(); conversationModes.clear(); }
}
async function loadSkills(options: { forceReload?: boolean } = {}) {
  const requestScope = scope();
  if (!options.forceReload && skillsRequest?.scope === requestScope) return skillsRequest.promise;
  if (!options.forceReload && skillsLoadedScope === requestScope) return { data: [{ cwd: state.projectPath, skills: state.skills }] };
  const generation = ++skillsGeneration;
  const auth = authenticationGeneration;
  const cwd = state.projectPath;
  if (skillsLoadedScope !== requestScope) { state.skills = []; state.selectedSkills = []; }
  state.skillsLoading = true;
  state.skillsError = '';
  const promise = rpc('skills/list', { cwds: [cwd], forceReload: !!options.forceReload }, 10000, { silentError: true })
    .then(result => {
      if (generation === skillsGeneration && requestScope === scope() && auth === authenticationGeneration) {
        state.skills = skillInventory(result, cwd);
        skillsLoadedScope = requestScope;
        state.selectedSkills = state.selectedSkills.filter(selected => state.skills.some(skill => skill.path === selected.path && skill.enabled !== false));
        const errors = result.data?.filter((entry: any) => entry.cwd === cwd).flatMap((entry: any) => entry.errors || []) || [];
        state.skillsError = errors.map((error: any) => error.message).filter(Boolean).join('；');
      }
      return result;
    }).catch(error => {
      if (generation === skillsGeneration && requestScope === scope() && auth === authenticationGeneration) state.skillsError = error.message;
      throw error;
    }).finally(() => {
      if (generation === skillsGeneration) { state.skillsLoading = false; skillsRequest = null; scheduleCapabilityRetry(); }
    });
  skillsRequest = { scope: requestScope, promise };
  return promise;
}
function attachSkill(candidate: any) {
  const skill = state.skills.find(skill => skill.path === candidate.path && skill.name === candidate.name && skill.enabled !== false);
  if (!skill) throw new Error('技能不可用，请重新加载当前工作区的技能');
  if (!state.selectedSkills.some(selected => selected.path === skill.path)) state.selectedSkills.push(skill);
}
function removeSkill(path: string) { state.selectedSkills = state.selectedSkills.filter(skill => skill.path !== path); }
async function loadModeCapabilities() {
  const hostId = state.hostId;
  if (state.modeCapabilities.loaded) return;
  if (capabilityRequest?.hostId === hostId) return capabilityRequest.promise;
  const generation = ++capabilityGeneration;
  const auth = authenticationGeneration;
  const promise = (async () => {
    const [plan, goal] = await Promise.allSettled([
      rpc('collaborationMode/list', {}, 8000, { silentError: true }),
      rpc('thread/goal/get', { threadId: '00000000-0000-0000-0000-000000000000' }, 8000, { silentError: true }),
    ]);
    if (hostId !== state.hostId || generation !== capabilityGeneration || auth !== authenticationGeneration) return;
    // Method-not-found is a capability answer. Transport errors, timeouts and
    // arbitrary protocol failures remain unknown and get a bounded retry.
    const unsupported = (result: PromiseSettledResult<any>) => result.status === 'rejected' && result.reason?.code === -32601;
    const knownPlan = plan.status === 'fulfilled' || unsupported(plan);
    const knownGoal = goal.status === 'fulfilled' || (goal.status === 'rejected' && goalMethodSupported(goal.reason)) || unsupported(goal);
    state.modeCapabilities = {
      loaded: knownPlan && knownGoal,
      plan: plan.status === 'fulfilled' && plan.value.data?.some((entry: any) => entry.mode === 'plan'),
      goal: goal.status === 'fulfilled' || goalMethodSupported(goal.reason),
    };
    if (state.modeCapabilities.goal && state.goalReadError) void refreshCurrentGoal();
  })().finally(() => { if (generation === capabilityGeneration) { capabilityRequest = null; scheduleCapabilityRetry(); } });
  capabilityRequest = { hostId, promise };
  return promise;
}
function applyGoal(hostId: string, threadId: string, goal: ThreadGoal | null) {
  const key = recencyKey(hostId, threadId);
  goals.set(key, goal);
  goalRevisions.set(key, (goalRevisions.get(key) || 0) + 1);
  if (hostId !== state.hostId || threadId !== state.activeThread?.id) return;
  clearTimeout(goalRetryTimer); goalRetryTimer = undefined; goalRetryAttempts = 0;
  state.goalReadError = '';
  state.goal = goal;
  state.goalTokenBudget = goal?.tokenBudget ?? null;
  if (goal && state.collaborationMode !== 'plan' && (!conversationModes.has(key) || conversationModes.get(key) === 'goal')) state.goalMode = true;
}
async function goalRpc(hostId: string, method: 'thread/goal/get' | 'thread/goal/set' | 'thread/goal/clear', params: any) {
  return hostId === state.hostId
    ? rpc(method, params, 15000, { silentError: true })
    : http(`/goals/${encodeURIComponent(hostId)}`, { method: 'POST', body: JSON.stringify({ method, params }) }, false);
}
let goalRefreshGeneration = 0;
let goalRetryTimer: ReturnType<typeof setTimeout> | undefined;
let goalRetryAttempts = 0;
let goalRefreshRequest: { hostId: string; threadId: string; selection: number; promise: Promise<void> } | null = null;
function cancelGoalRefresh() {
  ++goalRefreshGeneration;
  clearTimeout(goalRetryTimer); goalRetryTimer = undefined;
  goalRetryAttempts = 0; goalRefreshRequest = null;
}
function refreshCurrentGoal() {
  return state.activeThread?.id ? refreshGoal(state.hostId, state.activeThread.id) : Promise.resolve();
}
function refreshGoal(hostId: string, threadId: string): Promise<void> {
  const selection = selectionGeneration;
  if (!state.modeCapabilities.goal || hostId !== state.hostId || threadId !== state.activeThread?.id ||
      !state.connected || !state.online || state.runtimePaused || state.threadReleased) return Promise.resolve();
  if (goalRefreshRequest?.hostId === hostId && goalRefreshRequest.threadId === threadId && goalRefreshRequest.selection === selection)
    return goalRefreshRequest.promise;
  clearTimeout(goalRetryTimer); goalRetryTimer = undefined;
  const generation = ++goalRefreshGeneration;
  const key = recencyKey(hostId, threadId);
  const revision = goalRevisions.get(key) || 0;
  const auth = authenticationGeneration;
  const requestSocket = socket, requestEngine = engineId;
  const current = () => generation === goalRefreshGeneration && auth === authenticationGeneration &&
    selection === selectionGeneration && hostId === state.hostId && threadId === state.activeThread?.id &&
    socket === requestSocket && engineId === requestEngine && revision === (goalRevisions.get(key) || 0);
  const promise = (async () => { try {
    const result = await goalRpc(hostId, 'thread/goal/get', { threadId });
    if (!current()) return;
    applyGoal(hostId, threadId, result.goal);
  } catch (error) {
    if (!current()) return;
    state.goalReadError = `无法读取目标：${error instanceof Error ? error.message : String(error)}`;
    // Retry reads only; never replay goal/set, goal/clear or turn/start.
    const code = (error as any)?.code;
    if (((error as any)?.uncertain || !Number.isInteger(code) || code === -32000) && state.connected && state.online && !state.runtimePaused && !state.threadReleased) {
      goalRetryTimer = setTimeout(() => {
        goalRetryTimer = undefined;
        if (current() && !document.hidden) void refreshGoal(hostId, threadId);
      }, Math.min(30000, 2500 * 2 ** Math.min(goalRetryAttempts++, 4)));
    }
  } })().finally(() => { if (goalRefreshRequest?.promise === promise) goalRefreshRequest = null; });
  goalRefreshRequest = { hostId, threadId, selection, promise };
  return promise;
}
async function mutateGoal(hostId: string, threadId: string, patch: { objective?: string; status?: 'active' | 'paused'; tokenBudget?: number | null }): Promise<ThreadGoal | null> {
  const key = recencyKey(hostId, threadId);
  const revision = goalRevisions.get(key) || 0;
  const auth = authenticationGeneration;
  const result = await goalRpc(hostId, 'thread/goal/set', { threadId, ...patch });
  if (auth === authenticationGeneration && revision === (goalRevisions.get(key) || 0)) applyGoal(hostId, threadId, result.goal);
  return goals.get(key) || null;
}
async function modeAction(action: (hostId: string, threadId: string | undefined, selected: () => boolean) => Promise<void>) {
  if (state.runtimePaused || state.threadReleased || (state.activeThread && !state.threadReady)) throw new Error('请先恢复当前会话连接。');
  if (state.modeBusy || sendInFlight || state.selectingThread || state.switchingHost || state.changingContext)
    throw new Error('正在提交或加载会话，请稍候');
  if (!state.connected || !state.online) throw new Error('请先连接工作站');
  const operation = ++modeOperation;
  const generation = selectionGeneration;
  const auth = authenticationGeneration;
  const hostId = state.hostId;
  const threadId = state.activeThread?.id;
  const selected = () => operation === modeOperation && generation === selectionGeneration && hostId === state.hostId && auth === authenticationGeneration;
  state.modeBusy = true;
  state.modeError = '';
  try { await action(hostId, threadId, selected); }
  catch (error) {
    if (selected()) state.modeError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally { if (operation === modeOperation) state.modeBusy = false; }
}
async function setConversationMode(mode: 'default' | 'plan' | 'goal') {
  if (state.busy && !(mode === 'goal' && state.goal && state.collaborationMode === 'default'))
    throw new Error('请等待当前任务结束，或先停止任务再切换模式');
  return modeAction(async (hostId, threadId, selected) => {
    await loadModeCapabilities();
    if (!selected()) throw new Error('会话已切换，请在当前会话重新选择模式');
    if (mode === 'plan' && !state.modeCapabilities.plan) throw new Error('当前 Codex 版本未提供 Plan 模式');
    if (mode === 'goal' && !state.modeCapabilities.goal) throw new Error('当前 Codex 版本未提供 Goal 模式');
    const key = threadId && recencyKey(hostId, threadId);
    const goal = key ? goals.get(key) : null;
    if (mode === 'goal' && goal?.status === 'budgetLimited' && goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget)
      throw new Error('目标已达到 token 预算，请先增加或移除预算再继续');
    const restartGoal = mode === 'goal' && goal?.status === 'active' && state.collaborationMode === 'plan';
    if (threadId && (mode !== 'goal' || restartGoal) && goal?.status === 'active') await mutateGoal(hostId, threadId, { status: 'paused' });
    if (!selected()) throw new Error('会话已切换，请返回原会话确认模式');
    if (threadId && state.modeCapabilities.plan) {
      await rpc('thread/settings/update', { threadId, collaborationMode: nativeCollaborationMode(mode === 'plan' ? 'plan' : 'default', state.model, state.effort) }, 15000, { silentError: true });
    }
    if (!selected()) throw new Error('会话已切换，请返回原会话确认模式');
    const latestGoal = key ? goals.get(key) : null;
    if (threadId && mode === 'goal' && goal && latestGoal && latestGoal.objective === goal.objective &&
        latestGoal.createdAt === goal.createdAt && latestGoal.status !== 'active' && latestGoal.status !== 'complete') {
      if (latestGoal.status === 'budgetLimited' && latestGoal.tokenBudget != null && latestGoal.tokensUsed >= latestGoal.tokenBudget)
        throw new Error('目标已达到 token 预算，请先增加或移除预算再继续');
      await mutateGoal(hostId, threadId, { status: 'active' });
    }
    if (!selected()) return;
    state.collaborationMode = mode === 'plan' ? 'plan' : 'default';
    state.goalMode = mode === 'goal';
    if (key) conversationModes.set(key, mode);
  });
}
async function pauseGoal() {
  return modeAction(async (hostId, threadId) => {
    if (threadId && state.goal) await mutateGoal(hostId, threadId, { status: 'paused' });
  });
}
async function resumeGoal() { return setConversationMode('goal'); }
async function setGoalBudget(tokenBudget: number | null) {
  if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) throw new Error('预算需为正整数，留空表示不限');
  return modeAction(async (hostId, threadId, selected) => {
    if (threadId && state.goal) await mutateGoal(hostId, threadId, { tokenBudget });
    if (selected()) state.goalTokenBudget = tokenBudget;
  });
}
async function clearGoal() {
  return modeAction(async (hostId, threadId) => {
    if (!threadId) return;
    const auth = authenticationGeneration;
    const key = recencyKey(hostId, threadId);
    const revision = goalRevisions.get(key) || 0;
    await goalRpc(hostId, 'thread/goal/clear', { threadId });
    if (auth === authenticationGeneration && revision === (goalRevisions.get(key) || 0)) applyGoal(hostId, threadId, null);
  });
}

async function loadIntegrations() {
  const generation = ++integrationGeneration;
  const requestScope = scope();
  const results = await Promise.allSettled([
    loadSkills({ forceReload: true }),
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
    ...(Object.hasOwn(patch, 'defaultPermission') ? { defaultPermissionExplicit: true } : {}),
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
async function rememberSideBranch(hostId: string, id: string, label: string) {
  const authentication = authenticationGeneration;
  const result = await sideChatRpc(hostId, 'thread/read', { threadId: id, includeTurns: false });
  if (authentication !== authenticationGeneration || state.hostId !== hostId || !state.authenticated)
    throw new Error('主机或登录状态已变化，请重新核对保存的分支');
  if (!result?.thread || result.thread.id !== id || result.thread.ephemeral)
    throw new Error('无法确认已保存的正式分支');
  invalidateThreadTitleSearch(hostId);
  // A native fork with injected context can remain absent from thread/list
  // until its first explicit turn. Pins hydrate metadata by ID after reload.
  if (!state.preferences.pins.some(pin => pin.kind === 'thread' && pin.hostId === hostId && pin.id === id))
    await updatePreferences({ pins: [...state.preferences.pins, { kind: 'thread', hostId, id, label }] });
  if (authentication === authenticationGeneration && state.hostId === hostId)
    updateThread(result.thread);
}
function setCollapsed(key: string, collapsed: boolean) {
  return updatePreferences({ collapsed: { [key]: collapsed } });
}
function executionRoots(cwd = state.projectPath, hostId = state.hostId) {
  if (hostId === state.hostId && state.noProject && cwd === state.projectPath) return [cwd];
  return projectRoots(cwd, hostId);
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
  requireQueueSettingsUnlocked();
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
  notePermissionChange();
  await updatePreferences({ activePermissionProfileId: id });
}
function setPermission(mode: string) {
  requireQueueSettingsUnlocked();
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
  notePermissionChange();
  if (state.preferences.activePermissionProfileId)
    return updatePreferences({ activePermissionProfileId: "" });
}
async function selectDefaultPermission(mode: string) {
  requireQueueSettingsUnlocked();
  try {
    resolvePermissionProfile({ id: 'global', name: '全局默认权限', sandboxMode: mode as any, approvalPolicy: approvalPolicy(mode), networkAccess: mode === 'danger-full-access' }, { cwd: state.projectPath, requirements: state.requirements });
    await updatePreferences({ defaultPermission: mode, activePermissionProfileId: "" });
    permissionSelections.clear();
    applyPermissionDefault();
    notePermissionChange();
  } catch (error) { throw fail(error); }
}
function notePermissionChange() {
  state.permissionChangePending = state.busy;
  if (state.busy) toast('权限将在下一轮任务生效，当前任务保留启动时的权限。');
}
async function queryThreads(
  search = "",
  archived = false,
  cursor: string | null = null,
  hostId = state.hostId,
  options: { cwd?: string[]; force?: boolean; projectId?: string | null } = {},
) {
  if (options.force) invalidateThreadTitleSearch(hostId);
  const query = search.trim().normalize("NFKC").toLowerCase();
  const revision = navigationRevisions.get(hostId) ?? 0;
  const key = threadTitleQueryKey(hostId, [authenticationGeneration, revision, archived, query, cursor], options);
  return titleSearchPages.query(key, async () => {
    let result;
    const params = { archived, cursor, limit: 60, modelProviders: [],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(Object.prototype.hasOwnProperty.call(options, 'projectId') ? { projectId: options.projectId } : {}) };
    try {
      result = await threadPage(hostId, "thread/list", {
        ...params,
        ...(query && titleSearchSupport.get(hostId) !== false ? { searchTerm: query } : {}),
      }, true);
      if (query && !titleSearchSupport.has(hostId)) titleSearchSupport.set(hostId, true);
    } catch (error: any) {
      // Old app-servers can reject this optional field. Keep paginating their
      // metadata locally; never fall back to full-text thread/search.
      if (!query || titleSearchSupport.get(hostId) === false ||
          !/search_?term/i.test(error.message) ||
          !/unknown|invalid|unsupported|unexpected|field/i.test(error.message)) throw error;
      titleSearchSupport.set(hostId, false);
      result = await threadPage(hostId, "thread/list", params, true);
    }
    return {
      ...result,
      data: result.data.filter((thread: any) => !query || matchesThreadTitle(thread, query)),
    };
  });
}
async function queryNavigationThreads(
  search = "",
  archived = false,
  cursors?: Record<string, string>,
) {
  const authentication = authenticationGeneration;
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
        authentication !== authenticationGeneration || !state.authenticated ||
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
        authentication === authenticationGeneration && state.authenticated &&
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
  const authentication = authenticationGeneration;
  const result = await scopedRpc(hostId, "thread/unarchive", { threadId: id });
  if (authentication !== authenticationGeneration || !state.authenticated || !state.hosts.some(host => host.id === hostId)) return;
  invalidateThreadTitleSearch(hostId);
  if (hostId === state.hostId) {
    removedThreads.delete(id);
    if (result.thread) updateThread(result.thread);
    await refreshThreads();
  } else {
    advanceNavigationRevision(hostId);
    if (result.thread) mergeNavigation(hostId, [result.thread]);
  }
  toast("对话已恢复");
}
async function readThreadExport(
  id: string,
  format: "markdown" | "json" = "markdown",
  hostId = state.hostId,
) {
  const authentication = authenticationGeneration;
  const checkSession = () => {
    if (authentication !== authenticationGeneration || !state.authenticated)
      throw new Error('登录状态已变化，导出已取消');
  };
  const metadata = await scopedRpc(hostId, "thread/read", {
    threadId: id,
    includeTurns: false,
  });
  checkSession();
  if (metadata.thread?.id !== id) throw new Error('返回的会话与请求不一致，导出已取消');
  const pages: any[][] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let count = 0;
  do {
    const page = await history(id, cursor, hostId, true);
    checkSession();
    if (page.data.some((turn: any) => (turn.itemsView && turn.itemsView !== 'full')
        || turn.cacheTruncated || turn.items?.some((item: any) => item.cacheTruncated)))
      throw new Error('历史内容尚未完整加载，导出已取消，请同步后重试');
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
  return { content, thread: metadata.thread };
}
async function copyThread(id: string, format: 'link' | 'markdown' | 'cwd', hostId = state.hostId) {
  const authentication = authenticationGeneration;
  const checkSession = () => {
    if (authentication !== authenticationGeneration || !state.authenticated)
      throw new Error('登录状态已变化，复制已取消');
  };
  let text: string;
  if (format === 'link') {
    const url = new URL('/', location.origin);
    url.searchParams.set('host', hostId); url.searchParams.set('thread', id);
    text = url.href;
  } else if (format === 'markdown') text = (await readThreadExport(id, 'markdown', hostId)).content;
  else {
    const result = await scopedRpc(hostId, 'thread/read', { threadId: id, includeTurns: false });
    if (result.thread?.id !== id) throw new Error('返回的会话与请求不一致，复制已取消');
    if (typeof result.thread?.cwd !== 'string' || !result.thread.cwd) throw new Error('此对话没有工作目录');
    text = result.thread.cwd;
  }
  await copyText(text, checkSession);
  checkSession();
  toast(format === 'link' ? '已复制对话链接' : format === 'markdown' ? '已复制 Markdown' : '已复制工作目录');
}
async function exportThread(id: string, format: 'markdown' | 'json' = 'markdown', hostId = state.hostId) {
  const { content, thread } = await readThreadExport(id, format, hostId);
  const blob = new Blob([content], {
    type:
      format === "json" ? "application/json" : "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(thread.name || id).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100)}.${format === "json" ? "json" : "md"}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function requireQueueSettingsUnlocked() {
  if (messageQueue?.settingsLocked.value) throw new Error('队列中的消息会自动执行；请先清空队列再调整模型或权限');
}
async function prepareQueuedSettings(hostId: string, threadId: string, capabilities: any) {
  if (hostId !== state.hostId || threadId !== state.activeThread?.id) throw new Error('队列上下文已变化');
  const profile = state.activePermissionProfileId ? availablePermissionProfiles(state.preferences.permissionProfiles).find(profile => profile.id === state.activePermissionProfileId) : undefined;
  const policy = !profile && state.runtimePolicy
    ? state.runtimePolicy
    : resolveWebPermissionSelection(state.permission as any, { profile, cwd: state.projectPath, requirements: state.requirements });
  // Native queue entries share saved thread defaults. Selecting settings for
  // later manual input must not rewrite defaults beneath already queued input.
  const preserveQueuedModels = !!messageQueue?.state.items.length;
  const params: any = { threadId, cwd: state.projectPath, ...(!preserveQueuedModels ? { model: state.model || undefined, effort: state.effort, ...serviceTierParams(state) } : {}),
    ...(state.runtimePolicy?.source !== 'native' ? {
      sandboxPolicy: profile ? policy.sandboxPolicy : sandboxPolicy(), approvalPolicy: profile ? policy.approvalPolicy : state.runtimePolicy?.approvalPolicy ?? policy.approvalPolicy,
    } : {}) };
  if (state.modeCapabilities.plan && !preserveQueuedModels) params.collaborationMode = nativeCollaborationMode(state.collaborationMode, state.model, state.effort);
  if (!methodAccepts(capabilities, 'thread/settings/update', Object.keys(params))) throw new Error('当前 Codex 无法保存下一轮设置，请更新 Codex 后使用队列');
  await sideChatRpc(hostId, 'thread/settings/update', params);
  state.permissionChangePending = state.busy;
}

let messageQueue: ReturnType<typeof useMessageQueue> | null = null;
export function useCodex() {
  messageQueue ??= useMessageQueue({
    sideChatRpc, subscribeProtocol, runtimeIdentity, requestHttp: http, privateSessionReady: () => cacheActivation, prepareQueuedSettings,
    acceptQueuedTurn: (threadId: string, turn: any, request: any) =>
      receiveThreadChange({ threadId, method: 'turn/start', result: { turn }, request }),
  }, state);
  return {
    ...settingsApi,
    reconnectRuntime,
    restartDaemonRuntime: (hostId = state.hostId) => reconnectRuntime(hostId, true),
    messageQueue,
    state,
    initialize,
    resumeConnection,
    flushConversationCache,
    login,
    logout,
    setOnline,
    rpc,
    sideChatRpc,
    subscribeProtocol,
    runtimeIdentity,
    privateSessionReady: () => cacheActivation,
    listSubagents,
    readSubagent,
    getSubagentSnapshot,
    refreshThreads,
    loadMoreThreads,
    loadProjectThreads,
    selectThread,
    resumeThreadConnection,
    updateReleasedThreads,
    takeoverThread,
    loadOlderTurns,
    loadTurnDetails,
    retainHistoryTurns,
    loadToolOutput,
    revealBookmarkSource,
    newThread,
    newThreadInWorktree,
    startReview,
    send,
    asyncQuestionStatus,
    answerAsyncQuestion,
    pendingAsyncQuestions,
    pendingAsyncQuestionNotices,
    dismissAsyncQuestionNotices,
    asyncQuestionNoticesState: asyncQuestionNotices.state,
    canEditMessage,
    resendEditedMessage,
    cancelMessageEdit,
    interrupt,
    fork,
    forkThread,
    queryAttachedThreads,
    compact,
    setAutoCompact,
    renameThread,
    moveThreadToProject,
    loadNativeProjectBindings,
    threadMatchesProject,
    deleteThread,
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
    inspectHostKey,
    trustHostKey,
    uploadSshKey,
    removeSshKey,
    updateHost,
    removeHost,
    reorderHosts,
    reorderProjects,
    setLocalEnabled,
    uploadFiles,
    prepareFileUpload,
    uploadEditFiles,
    removeAttachment,
    searchFiles,
    readDirectory,
    readFile,
    downloadFile,
    writeFile,
    http,
    requestHttp: http,
    setModel,
    setReasoningEffort,
    setServiceTier,
    updatePreferences,
    promptPresets,
    rememberSideBranch,
    pin,
    setCollapsed,
    queryThreads,
    queryNavigationThreads,
    titleSearchVersion: () => titleSearchRevision.value,
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
    copyThread,
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
    loadSkills,
    loadModeCapabilities,
    attachSkill,
    removeSkill,
    setConversationMode,
    refreshCurrentGoal,
    pauseGoal,
    resumeGoal,
    clearGoal,
    setGoalBudget,
    toast,
  };
}
