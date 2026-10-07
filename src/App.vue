<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useCodex } from "./lib/useCodex";
import { useSubagentPrefetch } from "./lib/subagent-prefetch";
import { useSideChat } from "./lib/side-chat";
import { normalizeConversationSelection, type ConversationSelectionSource } from "./lib/conversation-selection";
import Icon from "./components/Icon.vue";
import CommandLogo from "./components/CommandLogo.vue";
import ConversationOutput from "./components/ConversationOutput.vue";
import ConversationSelectionToolbar from "./components/ConversationSelectionToolbar.vue";
import SideChatPanel from "./components/SideChatPanel.vue";
import ApprovalCard from "./components/ApprovalCard.vue";
import Composer from "./components/Composer.vue";
import WorkspacePanel from "./components/WorkspacePanel.vue";
import ReviewPanel from "./components/ReviewPanel.vue";
import ResizableWorkspace from "./components/ResizableWorkspace.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import ResourcePanel from "./components/ResourcePanel.vue";
import ConversationNav from "./components/ConversationNav.vue";
import ProjectDialog from "./components/ProjectDialog.vue";
import { isPinned } from "./lib/navigation";
import { initializeDevicePush, onPushNavigate, pwaState, updatePwa } from "./lib/pwa";
import { pushTarget, pushTargetFromUrl, type PushTarget } from "./lib/push-navigation";

const api = useCodex();
const state = api.state;
const sideChat = useSideChat(api, state);
const sideChatPanel = ref<InstanceType<typeof SideChatPanel>>();
useSubagentPrefetch(api, state);
let pendingPushTarget: PushTarget | null = pushTargetFromUrl(new URL(location.href));
let openingPushTarget = false;
let stopPushNavigation: (() => void) | undefined;
let foregroundTimer: ReturnType<typeof setTimeout> | undefined;
const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
const workspaceOpen = ref(false);
const workspaceTab = ref("files");
const workspacePath = ref("");
const workspaceLine = ref<number>();
const workspace = ref<InstanceType<typeof WorkspacePanel>>();
const composer = ref<InstanceType<typeof Composer>>();
const scroll = ref<HTMLElement>();
const showScrollBottom = ref(false);
const settingsOpen = ref(false);
const resourcesOpen = ref(false);
const reviewOpen = ref(false);
const settingsTab = ref("general");
const paletteOpen = ref(false);
const paletteQuery = ref("");
const paletteInput = ref<HTMLInputElement>();
const paletteSelected = ref(0);
const searchOpen = ref(false);
const threadSearch = ref("");
const threadMenu = ref(false);
const renameOpen = ref(false);
const renameValue = ref("");
const editingProject = ref<any>(null);
const renameInput = ref<HTMLInputElement>();
const loginPassword = ref("");
const loginBusy = ref(false);
const actionPending = ref(false);
const actionBusy = computed(() => actionPending.value || state.editingMessage);
let navigationSelection = 0;
let activeActionCount = 0;
const theme = ref(localStorage.getItem("codex.theme") || "system");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
function updateViewport() {
  const viewport = window.visualViewport;
  if (viewport && viewport.width <= 760 && viewport.scale === 1)
    document.documentElement.style.setProperty(
      "--app-height",
      `${viewport.height}px`,
    );
  else document.documentElement.style.removeProperty("--app-height");
}
const currentHost = computed(() =>
  state.hosts.find((host: any) => host.id === state.hostId),
);
const currentProject = computed(() =>
  state.projects.find(
    (project: any) =>
      [project.path, ...(project.rootPaths || [])].includes(
        state.projectPath,
      ) &&
      (!project.hostId || project.hostId === state.hostId),
  ),
);
const projectName = computed(
  () =>
    currentProject.value?.name ||
    state.projectPath.split("/").filter(Boolean).pop() ||
    "选择项目",
);
const threadTitle = computed(
  () =>
    state.activeThread?.name ||
    state.activeThread?.preview?.slice(0, 70) ||
    "新对话",
);
const visibleThreads = computed(() =>
  state.threads.filter(
    (thread: any) =>
      !threadSearch.value ||
      `${thread.name || ""} ${thread.preview || ""} ${thread.cwd || ""}`
        .toLowerCase()
        .includes(threadSearch.value.toLowerCase()),
  ),
);
const hostProjects = computed(() =>
  state.projects.filter(
    (project: any) => !project.hostId || project.hostId === state.hostId,
  ),
);
const activeRequests = computed(() =>
  state.pendingRequests.filter(
    (request: any) =>
      !request.params?.threadId ||
      request.params.threadId === state.activeThread?.id,
  ),
);
const otherRequests = computed(() =>
  state.pendingRequests.filter(
    (request: any) =>
      request.params?.threadId &&
      request.params.threadId !== state.activeThread?.id &&
      request.params.threadId !== sideChat.state.threadId,
  ),
);
const choiceRequests = computed(() => state.pendingRequests.filter((request: any) => request.method?.includes('requestUserInput')));
const activeChoices = computed(() => activeRequests.value.filter((request: any) => request.method?.includes('requestUserInput')));
function showChoices() {
  scroll.value?.querySelector('.question-card')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
watch(() => [state.authenticated, choiceRequests.value.length, threadTitle.value], () => {
  const reminder = choiceRequests.value.length ? `（${choiceRequests.value.length} 待选择）` : '';
  document.title = state.authenticated ? `${reminder}${threadTitle.value} · Codex Web` : 'Codex Web';
}, { immediate: true });
const welcome = computed(() => !state.activeThread && !state.items.length);
const editDisabled = computed(() =>
  actionBusy.value || state.busy || state.compacting || state.loading || !state.online ||
  state.selectingThread || state.switchingHost || state.changingContext ||
  state.runtimePaused || state.threadReleased || (state.activeThread && !state.threadReady),
);
const threadActionsDisabled = computed(() =>
  !state.activeThread || state.busy || state.compacting || !state.connected || !state.online ||
  !state.threadReady || state.runtimePaused || state.threadReleased || state.selectingThread,
);
const editableItemId = computed(() => {
  if (editDisabled.value) return undefined;
  const item = state.items.filter((item) => item.type === 'userMessage').at(-1);
  return item && api.canEditMessage(item.id) ? item.id : undefined;
});
const paletteActions = [
  {
    id: "new",
    name: "新建对话",
    detail: "⌘ / Ctrl + Shift + O",
    icon: "SquarePen",
  },
  { id: "compact", name: "压缩上下文", detail: "/compact", icon: "RefreshCw" },
  { id: "fork", name: "创建对话分支", detail: "/fork", icon: "GitBranch" },
  {
    id: "terminal",
    name: "打开终端",
    detail: "⌘ / Ctrl + J",
    icon: "Terminal",
  },
  {
    id: "git",
    name: "Git 与工作树",
    detail: "分支 · 提交 · Worktree",
    icon: "GitBranch",
  },
  { id: "files", name: "浏览项目文件", detail: "工作区", icon: "Folder" },
  { id: "agents", name: "查看子智能体", detail: "状态与对话", icon: "Bot" },
  { id: "preview", name: "打开预览", detail: "工作区", icon: "Eye" },
  {
    id: "review",
    name: "审查代码变更",
    detail: "/review",
    icon: "GitCompareArrows",
  },
  {
    id: "settings",
    name: "设置",
    detail: "配置 · SSH · 账户",
    icon: "Settings2",
  },
];
const paletteResults = computed(() => {
  const q = paletteQuery.value.toLowerCase();
  const actions: any[] = paletteActions
    .filter(
      (action) => !q || `${action.name} ${action.id}`.toLowerCase().includes(q),
    )
    .map((action) => ({ ...action, kind: "action" }));
  const threads = api
    .navigationThreads()
    .filter(
      (thread: any) =>
        !q ||
        `${thread.name || ""} ${thread.preview || ""}`
          .toLowerCase()
          .includes(q),
    )
    .slice(0, q ? 12 : 5)
    .map((thread: any) => ({
      id: thread.id,
      hostId: thread.hostId,
      name: thread.name || thread.preview || "未命名对话",
      detail:
        state.hosts.find((host) => host.id === thread.hostId)?.name || "对话",
      icon: "Command",
      kind: "thread",
    }));
  return [...actions, ...threads];
});
function displayTime(value: number | string) {
  if (!value) return "";
  const date = new Date(
    typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : value,
  );
  const age = Date.now() - date.getTime();
  if (age < 60000) return "刚刚";
  if (age < 3600000) return `${Math.floor(age / 60000)}分`;
  if (age < 86400000) return `${Math.floor(age / 3600000)}时`;
  if (age < 604800000) return `${Math.floor(age / 86400000)}天`;
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
function showError(message: string) {
  state.error = message;
}
async function action(fn: () => any) {
  if (state.editingMessage) return;
  ++activeActionCount;
  actionPending.value = true;
  try {
    return await fn();
  } catch (cause: any) {
    showError(cause.message || "操作失败");
  } finally {
    actionPending.value = --activeActionCount > 0;
  }
}
function saveScroll() {
  // Cached history paints before native hydration finishes. Its initial layout
  // must not replace the reading position saved by the previous app window.
  if (state.loading || state.selectingThread || (state.activeThread && !state.threadReady)) return;
  if (scroll.value && state.activeThread?.id)
    sessionStorage.setItem(
      `codex.scroll.${state.hostId}.${state.activeThread.id}`,
      JSON.stringify({
        top: scroll.value.scrollTop,
        bottom: !showScrollBottom.value,
      }),
    );
}
function restoreScroll(id: string) {
  try {
    const position = JSON.parse(
      sessionStorage.getItem(`codex.scroll.${state.hostId}.${id}`) || "null",
    );
    if (position && !position.bottom && scroll.value) {
      scroll.value.scrollTop = position.top;
      onScroll();
    } else scrollBottom();
  } catch {
    scrollBottom();
  }
}
async function selectThread(
  selection: string | { id: string; hostId: string },
) {
  if (state.editingMessage) return;
  const generation = ++navigationSelection;
  const id = typeof selection === "string" ? selection : selection.id;
  const hostId =
    typeof selection === "string" ? state.hostId : selection.hostId;
  saveScroll();
  sidebarOpen.value = false;
  showScrollBottom.value = true;
  await action(async () => {
    try {
      if (hostId !== state.hostId) await api.setHost(hostId);
      if (generation !== navigationSelection || hostId !== state.hostId) return;
      await api.selectThread(id);
    } catch (error) {
      if (generation === navigationSelection) throw error;
    }
  });
  if (generation !== navigationSelection) return;
  await nextTick();
  restoreScroll(id);
}
async function newThread() {
  if (state.editingMessage) return;
  ++navigationSelection;
  saveScroll();
  sidebarOpen.value = false;
  threadMenu.value = false;
  await action(() => api.newThread());
  await nextTick();
  composer.value?.focus();
}
async function forceEnterThread() {
  await api.takeoverThread(owner => window.confirm(
    `强制进入会终止当前占用此对话的 Codex 进程（PID ${owner.pid}），该进程占用的 ${owner.affectedThreadCount} 个会话都会结束，正在运行的任务将被中断。\n\n确认终止并进入此对话？`,
  ));
}
async function selectProject(project: any) {
  if (state.editingMessage) return;
  const generation = ++navigationSelection;
  const hostId = project.hostId || "local";
  saveScroll();
  sidebarOpen.value = false;
  await action(async () => {
    try {
      if (hostId !== state.hostId) await api.setHost(hostId);
      if (generation !== navigationSelection || hostId !== state.hostId) return;
      await api.setProject(project.path);
    } catch (error) {
      if (generation === navigationSelection) throw error;
    }
  });
}
async function switchHost(event: Event) {
  if (state.editingMessage) return;
  ++navigationSelection;
  const id = (event.target as HTMLSelectElement).value;
  await action(() => api.setHost(id));
}
async function chooseNewContext(hostId: string, path?: string) {
  if (state.activeThread || state.changingContext || state.switchingHost ||
      state.selectingThread || state.busy) return;
  const generation = ++navigationSelection;
  const draft = composer.value?.getDraft() || "";
  saveScroll();
  sidebarOpen.value = false;
  await action(async () => {
    try {
      await api.chooseNewContext(hostId, path);
    } catch (error) {
      if (generation === navigationSelection) throw error;
    } finally {
      if (generation === navigationSelection && !state.activeThread && draft) {
        await nextTick();
        composer.value?.setDraft(draft);
      }
    }
  });
  if (generation === navigationSelection && !state.activeThread) {
    await nextTick();
    composer.value?.focus();
  }
}
function openWorkspace(tab = "files", path = "", line?: number) {
  sideChat.state.open = false;
  const samePath = workspaceOpen.value && workspacePath.value === path;
  workspaceTab.value = tab;
  workspaceOpen.value = true;
  workspacePath.value = path;
  workspaceLine.value = line;
  if (path && samePath) void nextTick(() => workspace.value?.revealPath(path, line));
  else if (!path) void nextTick(() => workspace.value?.setTab(tab));
}
function toggleWorkspace() {
  if (sideChat.state.open) {
    sideChat.state.open = false;
    workspaceOpen.value = true;
  } else workspaceOpen.value = !workspaceOpen.value;
}
function selectedSource(value: ConversationSelectionSource) {
  const source = normalizeConversationSelection(value);
  return state.authenticated && source?.hostId === state.hostId && source.threadId === state.activeThread?.id ? source : null;
}
function addToConversation(value: ConversationSelectionSource) {
  const source = selectedSource(value);
  if (!source) return;
  if (composer.value?.addContext(source)) api.toast('已添加到对话');
}
function askInSideChat(value: ConversationSelectionSource) {
  const source = selectedSource(value);
  if (!source) return;
  try {
    sideChat.prepare(source);
    void nextTick(() => sideChatPanel.value?.focusQuestion());
  } catch (error: any) { showError(error.message || '无法打开侧边聊天'); }
}
async function projectAction({
  action: command,
  project,
}: {
  action: string;
  project: any;
}) {
  if (command === "edit") {
    sidebarOpen.value = false;
    editingProject.value = project;
  } else if (command === "files") {
    await selectProject(project);
    if (
      state.hostId === (project.hostId || "local") &&
      state.projectPath === project.path &&
      !state.switchingHost
    )
      openWorkspace("files", project.path);
  } else if (command === "remove") {
    if (
      window.confirm(
        `从侧栏移除“${project.name}”？项目文件和对话会保留，可重新添加目录。`,
      )
    )
      await action(() => api.removeProject(project));
  } else if (command === "archive") {
    if (
      window.confirm(
        `归档“${project.name}”的所有对话？包括其他工作目录中的对话，可在已归档对话中恢复。`,
      )
    )
      await action(() => api.archiveProject(project));
  }
}
function openSettings(tab = "general") {
  resourcesOpen.value = false;
  settingsTab.value = tab;
  settingsOpen.value = true;
  threadMenu.value = false;
  sidebarOpen.value = false;
}
function openResources() {
  resourcesOpen.value = true;
  settingsOpen.value = false;
  sidebarOpen.value = false;
  threadMenu.value = false;
}
function openPalette() {
  paletteQuery.value = "";
  paletteSelected.value = 0;
  paletteOpen.value = true;
  void nextTick(() => paletteInput.value?.focus());
}
async function execute(command: string) {
  threadMenu.value = false;
  paletteOpen.value = false;
  if (command === "new") await newThread();
  else if (command === "compact") {
    if (state.activeThread && !state.busy) await action(() => api.compact());
    else
      showError(
        state.busy
          ? "请等待当前任务完成后压缩上下文。"
          : "先开始一个对话，再压缩上下文。",
      );
  } else if (command === "fork") {
    if (state.activeThread && !state.busy) await action(() => api.fork());
    else
      showError(
        state.busy
          ? "请等待当前任务完成后创建分支。"
          : "先选择一个对话，再创建分支。",
      );
  } else if (
    ["terminal", "files", "preview", "changes", "git", "agents"].includes(command)
  )
    openWorkspace(command);
  else if (command === "settings") openSettings();
  else if (command === "settings-projects") openSettings("projects");
  else if (command === "review") {
    reviewOpen.value = true;
  }
}
async function fork(turnId?: string) {
  await action(() => api.fork(turnId));
  await nextTick();
  scrollBottom();
}
function openRename() {
  renameValue.value = state.activeThread?.name || "";
  renameOpen.value = true;
  threadMenu.value = false;
  void nextTick(() => renameInput.value?.focus());
}
async function rename() {
  if (!renameValue.value.trim()) return;
  await action(() => api.renameThread(renameValue.value.trim()));
  renameOpen.value = false;
}
async function archive() {
  threadMenu.value = false;
  if (state.activeThread)
    await action(() => api.archiveThread(state.activeThread.id));
}
async function login() {
  loginBusy.value = true;
  try {
    await api.login(loginPassword.value);
    loginPassword.value = "";
  } catch (cause: any) {
    showError(cause.message);
  } finally {
    loginBusy.value = false;
  }
}
async function openPendingPushTarget() {
  if (openingPushTarget || !pendingPushTarget || !state.authenticated ||
      !state.online || state.loading || state.switchingHost ||
      state.selectingThread) return;
  openingPushTarget = true;
  try {
    while (pendingPushTarget && state.authenticated && state.online) {
      const target = pendingPushTarget;
      pendingPushTarget = null;
      if (!state.hosts.some((host: any) => host.id === target.hostId)) {
        showError("通知对应的主机已被移除。");
        continue;
      }
      await selectThread({ id: target.threadId, hostId: target.hostId });
      if (state.hostId === target.hostId && state.activeThread?.id === target.threadId) {
        settingsOpen.value = false;
        workspaceOpen.value = false;
        paletteOpen.value = false;
        const url = new URL(location.href);
        const link = pushTargetFromUrl(url);
        if (link?.hostId === target.hostId && link.threadId === target.threadId) {
          url.searchParams.delete("host");
          url.searchParams.delete("thread");
          history.replaceState(history.state, "", url);
        }
      }
    }
  } finally {
    openingPushTarget = false;
  }
}
function onNetworkChange() {
  api.setOnline(navigator.onLine);
  if (state.online && !state.loading) {
    if (!state.authenticated) void action(() => api.initialize());
    else onForeground();
  }
}
function onForeground() {
  if (document.visibilityState !== "visible" || !navigator.onLine) return;
  clearTimeout(foregroundTimer);
  foregroundTimer = setTimeout(async () => {
    if (state.loading) return;
    if (state.authenticated) await api.resumeConnection();
    else await api.initialize();
    if (state.authenticated && state.online && !state.loading)
      await initializeDevicePush(api);
  }, 250);
}
function onPageShow(event: PageTransitionEvent) {
  if (event.persisted) onForeground();
}
function onScroll() {
  if (scroll.value) {
    showScrollBottom.value =
      scroll.value.scrollHeight -
        scroll.value.scrollTop -
        scroll.value.clientHeight >
      140;
    saveScroll();
  }
}
function scrollBottom() {
  if (scroll.value) {
    scroll.value.scrollTop = scroll.value.scrollHeight;
    showScrollBottom.value = false;
  }
}
async function loadOlder() {
  const height = scroll.value?.scrollHeight || 0;
  await action(() => api.loadOlderTurns());
  await nextTick();
  if (scroll.value) scroll.value.scrollTop = scroll.value.scrollHeight - height;
}
async function pickPalette(result: any) {
  if (!result) return;
  paletteOpen.value = false;
  if (result.kind === "thread")
    await selectThread({ id: result.id, hostId: result.hostId });
  else await execute(result.id);
}
function paletteKey(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const length = paletteResults.value.length;
    if (length)
      paletteSelected.value =
        (paletteSelected.value +
          (event.key === "ArrowDown" ? 1 : -1) +
          length) %
        length;
  } else if (event.key === "Enter") {
    event.preventDefault();
    void pickPalette(paletteResults.value[paletteSelected.value]);
  }
}
function onKeydown(event: KeyboardEvent) {
  const modifier = event.metaKey || event.ctrlKey;
  const editable = (event.target as HTMLElement)?.closest(
    'input, textarea, [contenteditable="true"]',
  );
  if (modifier && event.key.toLowerCase() === "k") {
    event.preventDefault();
    paletteOpen.value ? (paletteOpen.value = false) : openPalette();
  } else if (modifier && event.shiftKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void newThread();
  } else if (modifier && event.key.toLowerCase() === "j") {
    event.preventDefault();
    openWorkspace("terminal");
  } else if (event.key === "?" && !editable) {
    event.preventDefault();
    openSettings("shortcuts");
  } else if (event.key === "Escape") {
    paletteOpen.value = false;
    settingsOpen.value = false;
    resourcesOpen.value = false;
    reviewOpen.value = false;
    renameOpen.value = false;
    sidebarOpen.value = false;
    threadMenu.value = false;
  }
}
function applyTheme() {
  document.documentElement.dataset.theme =
    theme.value === "system"
      ? prefersDark.matches
        ? "dark"
        : "light"
      : theme.value;
  document.documentElement.style.colorScheme =
    document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
}
watch(theme, () => {
  localStorage.setItem("codex.theme", theme.value);
  applyTheme();
});
watch(paletteQuery, () => {
  paletteSelected.value = 0;
});
watch(
  () => [
    state.items.length,
    state.items[state.items.length - 1]?.text,
    state.items[state.items.length - 1]?.aggregatedOutput,
    state.pendingRequests.length,
    state.busy,
  ],
  async () => {
    if (!showScrollBottom.value && !state.loading && !state.selectingThread && state.threadReady) {
      await nextTick();
      if (!showScrollBottom.value && !state.loading && !state.selectingThread && state.threadReady)
        scrollBottom();
    }
  },
);
onMounted(() => {
  applyTheme();
  updateViewport();
  window.visualViewport?.addEventListener("resize", updateViewport);
  window.addEventListener("resize", updateViewport);
  document.addEventListener("keydown", onKeydown);
  prefersDark.addEventListener("change", applyTheme);
  window.addEventListener("online", onNetworkChange);
  window.addEventListener("offline", onNetworkChange);
  document.addEventListener("visibilitychange", onForeground);
  document.addEventListener("resume", onForeground);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("focus", onForeground);
  stopPushNavigation = onPushNavigate((value) => {
    const target = pushTarget(value);
    if (!target) return;
    pendingPushTarget = target;
    void openPendingPushTarget();
  });
  void action(() => api.initialize()).then(async () => {
    await nextTick();
    if (state.activeThread) restoreScroll(state.activeThread.id);
  });
});
onBeforeUnmount(() => {
  saveScroll();
  document.removeEventListener("keydown", onKeydown);
  prefersDark.removeEventListener("change", applyTheme);
  window.visualViewport?.removeEventListener("resize", updateViewport);
  window.removeEventListener("resize", updateViewport);
  window.removeEventListener("online", onNetworkChange);
  window.removeEventListener("offline", onNetworkChange);
  document.removeEventListener("visibilitychange", onForeground);
  document.removeEventListener("resume", onForeground);
  window.removeEventListener("pageshow", onPageShow);
  window.removeEventListener("focus", onForeground);
  clearTimeout(foregroundTimer);
  stopPushNavigation?.();
});
watch(() => [state.authenticated, state.online, state.connected, state.loading, state.switchingHost, state.selectingThread], () => {
  void openPendingPushTarget();
});
watch(() => [state.authenticated, state.loading], () => {
  if (state.authenticated && !state.loading)
    void initializeDevicePush(api);
});
</script>

<template>
  <main v-if="!state.authenticated" class="login-screen">
    <div class="login-card">
      <div class="codex-mark large">
        <CommandLogo :size="36" />
      </div>
      <h1>Codex</h1>
      <p>
        {{ state.loading ? "正在连接你的工作区…" : "你的开发伙伴，随处可用。" }}
      </p>
      <div v-if="state.loading" class="login-loading">
        <Icon name="LoaderCircle" :size="22" class="spin" />
      </div>
      <form v-else @submit.prevent="login">
        <label class="form-label"
          >访问密码
          <div class="login-password">
            <Icon name="Lock" :size="17" /><input
              v-model="loginPassword"
              type="password"
              placeholder="输入服务器访问密码"
              required
              autofocus
              autocomplete="current-password"
              aria-label="访问密码"
            /></div
        ></label>
        <div v-if="state.error" class="inline-error">{{ state.error }}</div>
        <button
          class="button button-primary login-submit"
          type="submit"
          :disabled="loginBusy || !loginPassword || !state.online"
        >
          <Icon
            v-if="loginBusy"
            name="LoaderCircle"
            :size="17"
            class="spin"
          />进入工作区<Icon v-if="!loginBusy" name="ArrowRight" :size="17" />
        </button>
      </form>
      <p v-if="!state.online" class="inline-error" role="status">目前离线，联网后即可登录工作区。</p>
      <span class="login-caption">连接你的项目，把想法变成现实。</span>
    </div>
  </main>
  <div
    v-else
    class="app-shell"
    :class="{
      'sidebar-collapsed': sidebarCollapsed,
      'workspace-visible': workspaceOpen || sideChat.state.open,
    }"
  >
    <div
      v-if="sidebarOpen"
      class="sidebar-backdrop"
      @click="sidebarOpen = false"
    ></div>
    <aside class="sidebar" :class="{ 'mobile-open': sidebarOpen }">
      <header class="sidebar-header">
        <a class="brand" href="#" @click.prevent="newThread"
          ><span class="codex-mark"><Icon name="Command" :size="16" /></span
          ><strong>Codex</strong></a
        ><button
          class="icon-button desktop-only"
          @click="sidebarCollapsed = true"
          title="收起侧边栏"
          aria-label="收起侧边栏"
        >
          <Icon name="PanelLeft" :size="17" /></button
        ><button
          class="icon-button mobile-only"
          @click="sidebarOpen = false"
          aria-label="关闭侧边栏"
        >
          <Icon name="X" :size="18" />
        </button>
      </header>
      <div class="sidebar-top">
        <button class="sidebar-action new-thread-button" :disabled="state.editingMessage" @click="newThread">
          <Icon name="SquarePen" :size="17" /><span>新建对话</span
          ><kbd>⌘ ⇧ O</kbd></button
        ><button class="sidebar-action" @click="openPalette">
          <Icon name="Search" :size="17" /><span>搜索与指令</span><kbd>⌘ K</kbd>
        </button>
      </div>
      <div class="sidebar-scroll">
        <ConversationNav
          :api="api"
          :state="state"
          @select="selectThread"
          @project="selectProject"
          @project-action="projectAction"
          @settings="openSettings"
          @error="showError"
        />
      </div>
      <footer class="sidebar-footer">
        <div class="host-selector">
          <Icon
            :name="currentHost?.kind === 'ssh' ? 'Server' : 'Monitor'"
            :size="17"
          /><select
            :value="state.hostId"
            :disabled="state.editingMessage"
            @change="switchHost"
            aria-label="选择主机"
            title="新对话与工作区使用的主机；侧栏始终显示所有主机"
          >
            <option v-for="host in state.hosts" :key="host.id" :value="host.id">
              {{ host.name }}
            </option></select
          ><span
            class="connection-dot"
            :class="{ connected: state.connected }"
            :title="state.connected ? '已连接' : '未连接'"
          ></span
          ><Icon name="ChevronDown" :size="12" />
        </div>
        <button class="sidebar-action resources-button" @click="openResources">
          <Icon name="Server" :size="17" /><span>资源管理</span><Icon name="ChevronRight" :size="14" />
        </button>
        <button class="sidebar-action settings-button" @click="openSettings()">
          <Icon name="Settings2" :size="17" /><span>设置</span
          ><span class="sidebar-account">{{
            state.account?.account?.email?.split("@")[0] ||
            state.account?.email?.split("@")[0] ||
            "工作区"
          }}</span>
        </button>
      </footer>
    </aside>
    <section class="main-column">
      <header class="main-header">
        <div class="header-left">
          <button
            class="icon-button mobile-only"
            @click="sidebarOpen = true"
            aria-label="打开侧边栏"
          >
            <Icon name="PanelLeft" /></button
          ><button
            v-if="sidebarCollapsed"
            class="icon-button desktop-only"
            @click="sidebarCollapsed = false"
            aria-label="展开侧边栏"
          >
            <Icon name="PanelLeft" />
          </button>
          <div class="header-project">
            <button
              @click="openSettings('projects')"
              :title="state.projectPath"
            >
              <Icon name="Folder" :size="15" /><span>{{ projectName }}</span
              ><Icon name="ChevronDown" :size="12" /></button
            ><span class="header-breadcrumb">/</span>
            <h1 :title="threadTitle">{{ threadTitle }}</h1>
          </div>
        </div>
        <div class="header-actions">
          <span
            class="host-badge header-host"
            :title="currentHost?.hostname || currentHost?.name"
            ><Icon
              :name="currentHost?.kind === 'ssh' ? 'Server' : 'Monitor'"
              :size="12"
            /><span>{{ currentHost?.name || "本机" }}</span></span
          ><button
            class="icon-button"
            :disabled="!state.activeThread"
            @click="openWorkspace('agents')"
            title="查看子智能体"
            aria-label="查看子智能体"
          >
            <Icon name="Bot" :size="18" />
          </button><button
            class="icon-button"
            :class="{ selected: workspaceOpen && !sideChat.state.open }"
            @click="toggleWorkspace"
            title="工作区：文件、预览、终端"
            aria-label="切换工作区"
          >
            <Icon name="PanelRight" :size="18" />
          </button>
          <button v-if="sideChat.state.source" class="icon-button" :class="{ selected: sideChat.state.open }" title="打开侧边聊天" aria-label="打开侧边聊天" @click="sideChat.state.open = true"><Icon name="MessagesSquare" :size="18" /></button>
          <div class="thread-menu-wrapper">
            <button
              class="icon-button"
              @click="threadMenu = !threadMenu"
              title="对话操作"
              aria-label="对话操作"
              :aria-expanded="threadMenu"
            >
              <Icon name="MoreHorizontal" :size="19" />
            </button>
            <div v-if="threadMenu" class="thread-menu">
              <button
                :disabled="threadActionsDisabled"
                @click="execute('fork')"
              >
                <Icon name="GitBranch" :size="16" />创建分支</button
              ><button
                :disabled="threadActionsDisabled"
                @click="execute('compact')"
              >
                <Icon name="RefreshCw" :size="16" />压缩上下文</button
              ><button :disabled="!state.activeThread" @click="openRename">
                <Icon name="Pencil" :size="16" />重命名对话</button
              ><button
                :disabled="!state.activeThread"
                @click="
                  threadMenu = false;
                  action(() =>
                    api.pin('thread', state.activeThread.id, threadTitle),
                  );
                "
              >
                <Icon name="Pin" :size="16" />{{
                  isPinned(
                    state.preferences.pins,
                    state.hostId,
                    "thread",
                    state.activeThread?.id,
                  )
                    ? "取消置顶"
                    : "置顶对话"
                }}</button
              ><button
                :disabled="!state.activeThread"
                @click="
                  threadMenu = false;
                  action(() =>
                    api.exportThread(state.activeThread.id, 'markdown'),
                  );
                "
              >
                <Icon name="Download" :size="16" />导出 Markdown</button
              ><button
                :disabled="!state.activeThread || state.busy"
                @click="archive"
              >
                <Icon name="Archive" :size="16" />归档对话
              </button>
              <hr />
              <button @click="openSettings('shortcuts')">
                <Icon name="Keyboard" :size="16" />快捷键
              </button>
            </div>
          </div>
        </div>
      </header>
      <div v-if="state.runtimePaused" class="connection-banner" role="status">
        <Icon name="Server" :size="15" />Web Codex 已释放，可切换桌面端。
        <button class="button button-small button-secondary" @click="openResources">资源管理中恢复连接</button>
      </div>
      <div v-else-if="state.threadReleased" class="connection-banner" role="status"><Icon name="Server" :size="15" />此会话的 Web 连接已关闭，可切换桌面端。<button class="button button-small button-secondary" :disabled="!state.connected || !state.online" @click="api.resumeThreadConnection(state.hostId, state.activeThread.id)">重新连接会话</button></div>
      <div v-else-if="state.error || state.threadConflict" class="global-error" :class="{ 'thread-conflict': state.threadConflict }" role="alert">
        <Icon name="AlertCircle" :size="16" /><span>{{ state.error || state.threadConflict?.message }}</span
        ><button
          v-if="state.threadConflict"
          :disabled="state.takingOverThread || state.selectingThread || !state.online"
          @click="api.selectThread(state.threadConflict.threadId)"
        >重试进入</button
        ><button
          v-if="state.threadConflict"
          :disabled="state.takingOverThread || state.selectingThread || !state.online"
          @click="forceEnterThread"
        >{{ state.takingOverThread ? '正在确认占用…' : '强制进入' }}</button
        ><button
          v-if="!state.connected"
          @click="action(() => api.initialize())"
        >
          重新连接</button
        ><button
          v-if="!state.threadConflict"
          class="icon-button"
          @click="state.error = ''"
          aria-label="关闭错误"
        >
          <Icon name="X" :size="14" />
        </button>
      </div>
      <div v-if="!state.online" class="connection-banner" role="status">
        <Icon name="WifiOff" :size="15" />目前离线，联网后将重新连接。操作不会自动提交。
      </div>
      <div v-else-if="!state.connected && !state.error && !state.runtimePaused" class="connection-banner">
        <Icon
          :name="state.loading ? 'LoaderCircle' : 'WifiOff'"
          :size="15"
          :class="{ spin: state.loading }"
        />{{
          state.loading
            ? "正在连接 App Server…"
            : "App Server 已断开，正在尝试重连…"
        }}
      </div>
      <div v-if="pwaState.updateAvailable" class="connection-banner" role="status">
        <Icon name="Download" :size="15" />应用有新版本
        <button class="button button-small button-secondary" :disabled="state.busy || actionBusy" @click="updatePwa()">{{ state.busy ? '任务完成后更新' : '更新应用' }}</button>
      </div>
      <button
        v-if="otherRequests.length"
        class="other-requests-banner"
        @click="selectThread(otherRequests[0].params.threadId)"
      >
        <Icon name="Shield" :size="15" />{{
          otherRequests.length
        }}
        个其他对话等待选择或确认<Icon name="ArrowRight" :size="14" />
      </button>
      <div v-if="activeChoices.length" class="connection-banner choice-reminder" role="status">
        <Icon name="Bell" :size="15" />{{ activeChoices.length }} 个问题等待你的选择
        <button class="button button-small button-secondary" @click="showChoices">查看问题</button>
      </div>
      <div class="conversation-shell" :class="{ 'welcome-state': welcome }">
        <div ref="scroll" class="conversation-scroll" @scroll="onScroll">
          <div v-if="welcome" class="welcome">
            <div class="welcome-mark">
              <CommandLogo />
            </div>
            <h2>今天，想构建什么？</h2>
            <p>
              在
              {{ projectName === "选择项目" ? "你的项目" : projectName }} 中，与
              Codex 一起把想法变成现实。
            </p>
            <div class="welcome-suggestions">
              <button
                :disabled="!state.connected || state.changingContext"
                @click="
                  composer?.setDraft(
                    '请阅读当前项目，介绍它的结构、主要功能和如何运行。',
                  )
                "
              >
                <Icon name="FolderOpen" :size="17" /><span>了解这个项目</span
                ><Icon name="ArrowUpRight" :size="13" /></button
              ><button
                :disabled="!state.connected || state.changingContext"
                @click="
                  composer?.setDraft(
                    '请审查当前项目的代码，找出最值得优先解决的问题，并说明原因。',
                  )
                "
              >
                <Icon name="Eye" :size="17" /><span>一起审查代码</span
                ><Icon name="ArrowUpRight" :size="13" /></button
              ><button
                :disabled="!state.connected || state.changingContext"
                @click="
                  composer?.setDraft(
                    '我想在这个项目中添加一个新功能。请先阅读项目，然后和我一起明确实现方案。',
                  )
                "
              >
                <Icon name="Code2" :size="17" /><span>实现一个想法</span
                ><Icon name="ArrowUpRight" :size="13" />
              </button>
            </div>
          </div>
          <div v-else class="message-list">
            <button
              v-if="state.moreTurns"
              class="load-older"
              :disabled="actionBusy"
              @click="loadOlder"
            >
              <Icon
                :name="actionBusy ? 'LoaderCircle' : 'ArrowUp'"
                :size="14"
                :class="{ spin: actionBusy }"
              />加载更早的消息
            </button>
            <div v-if="state.activeThread?.forkedFromId" class="fork-indicator">
              <Icon name="GitBranch" :size="14" />此对话由另一段对话分支而来
            </div>
            <ConversationOutput
              :key="`${state.hostId}:${state.activeThread?.id || 'new'}`"
              :host-id="state.hostId"
              :cwd="state.activeThread?.cwd || state.projectPath"
              :items="state.items"
              :turns="state.turns"
              :busy="state.busy"
              :editable-item-id="editableItemId"
              :editing="state.editingMessage"
              :edit-disabled="editDisabled"
              :edit-message="api.resendEditedMessage"
              :cancel-message-edit="api.cancelMessageEdit"
              @fork="fork"
              @open-file="(path, line) => openWorkspace('files', path, line)"
              @error="showError"
            />
            <ApprovalCard
              v-for="request in activeRequests"
              :key="String(request.id)"
              :request="request"
              :api="api"
            />
            <div
              v-if="
                !state.items.length &&
                !state.turns.length &&
                !state.busy &&
                !activeRequests.length
              "
              class="empty-conversation"
            >
              <Icon name="Command" :size="27" />
              <p>从一条消息开始</p>
            </div>
          </div>
        </div>
        <button
          v-if="showScrollBottom"
          class="scroll-bottom"
          @click="scrollBottom"
          title="跳到最新消息"
          aria-label="跳到最新消息"
        >
          <Icon name="ArrowDown" :size="18" />
        </button>
        <div class="composer-container">
          <div v-if="state.compacting" class="compaction-progress compaction-status" role="status" aria-live="polite">
            <Icon name="LoaderCircle" :size="14" class="spin" />正在压缩上下文…
          </div>
          <div v-if="state.plan?.length" class="turn-plan">
            <details>
              <summary>
                <Icon name="ListTodo" :size="14" /><span>执行计划</span
                ><span
                  >{{
                    state.plan.filter(
                      (step: any) => step.status === "completed",
                    ).length
                  }}/{{ state.plan.length }}</span
                ><Icon name="ChevronDown" :size="12" />
              </summary>
              <div v-for="(step, index) in state.plan" :key="index">
                <Icon
                  :name="
                    step.status === 'completed'
                      ? 'CheckCircle2'
                      : step.status === 'inProgress'
                        ? 'LoaderCircle'
                        : 'Circle'
                  "
                  :size="14"
                  :class="{ spin: step.status === 'inProgress' }"
                />{{ step.step }}
              </div>
            </details>
          </div>
          <Composer
            ref="composer"
            :api="api"
            :state="state"
            :welcome="welcome"
            :context-busy="state.changingContext"
            @project="chooseNewContext($event.hostId || 'local', $event.path)"
            @host="chooseNewContext($event)"
            @command="execute"
            @error="showError"
          />
        </div>
      </div>
    </section>
    <ConversationSelectionToolbar :container="scroll" :host-id="state.hostId" :thread-id="state.activeThread?.id" :thread-name="threadTitle" :disabled="!state.authenticated || state.selectingThread || state.switchingHost || state.changingContext || state.editingMessage" @add="addToConversation" @ask="askInSideChat" />
    <ResizableWorkspace v-if="workspaceOpen" v-show="!sideChat.state.open">
      <WorkspacePanel
        id="workspace-panel"
        ref="workspace"
        :api="api"
        :state="state"
        :initial-tab="workspaceTab"
        :open-path="workspacePath"
        :open-line="workspaceLine"
        @close="workspaceOpen = false"
        @error="showError"
      />
    </ResizableWorkspace>
    <ResizableWorkspace v-if="sideChat.state.source" v-show="sideChat.state.open" panel-id="side-chat-panel">
      <SideChatPanel id="side-chat-panel" ref="sideChatPanel" :controller="sideChat" :api="api" :main-state="state" @quote="addToConversation" @open-file="(path, line) => openWorkspace('files', path, line)" />
    </ResizableWorkspace>
    <ProjectDialog
      v-if="editingProject"
      :key="`${editingProject.hostId}:${editingProject.path}`"
      :project="editingProject"
      :api="api"
      :state="state"
      @close="editingProject = null"
    />
    <ResourcePanel
      v-if="resourcesOpen"
      :api="api"
      :state="state"
      @close="resourcesOpen = false"
    />
    <ReviewPanel
      v-if="reviewOpen"
      :api="api"
      :state="state"
      @close="reviewOpen = false"
      @file="reviewOpen = false; openWorkspace('files', $event.path, $event.line)"
    />
    <SettingsPanel
      v-if="settingsOpen"
      :api="api"
      :state="state"
      :theme="theme"
      :initial-tab="settingsTab"
      @close="settingsOpen = false"
      @theme="theme = $event"
    />
    <div
      v-if="paletteOpen"
      class="modal-backdrop palette-backdrop"
      @click.self="paletteOpen = false"
    >
      <section
        class="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <div class="palette-search">
          <Icon name="Search" :size="20" /><input
            ref="paletteInput"
            v-model="paletteQuery"
            placeholder="搜索对话或输入指令…"
            aria-label="搜索对话或指令"
            @keydown="paletteKey"
          /><kbd @click="paletteOpen = false">Esc</kbd>
        </div>
        <div class="palette-results">
          <button
            v-for="(result, index) in paletteResults"
            :key="result.kind + result.id"
            :class="{ selected: index === paletteSelected }"
            @click="pickPalette(result)"
          >
            <Icon :name="result.icon" :size="18" /><span>{{ result.name }}</span
            ><small>{{ result.detail }}</small
            ><Icon
              v-if="index === paletteSelected"
              name="CornerDownLeft"
              :size="14"
            />
          </button>
          <div v-if="!paletteResults.length" class="palette-empty">
            没有找到匹配的对话或指令
          </div>
        </div>
        <footer>↑ ↓ 选择<span>↵ 打开</span></footer>
      </section>
    </div>
    <div
      v-if="renameOpen"
      class="modal-backdrop"
      @click.self="renameOpen = false"
    >
      <form class="small-modal" @submit.prevent="rename">
        <header class="modal-header">
          <h2>重命名对话</h2>
          <button
            type="button"
            class="icon-button"
            @click="renameOpen = false"
            aria-label="关闭重命名"
          >
            <Icon name="X" :size="17" />
          </button>
        </header>
        <input
          ref="renameInput"
          v-model="renameValue"
          class="text-input"
          placeholder="对话名称"
          aria-label="对话名称"
          required
        />
        <div class="form-actions">
          <button
            type="button"
            class="button button-secondary"
            @click="renameOpen = false"
          >
            取消</button
          ><button
            type="submit"
            class="button button-primary"
            :disabled="!renameValue.trim() || actionBusy"
          >
            保存
          </button>
        </div>
      </form>
    </div>
    <Transition name="toast"
      ><div v-if="state.toast" class="toast-message" role="status">
        <Icon name="CheckCircle2" :size="17" />{{ state.toast }}
      </div></Transition
    >
  </div>
</template>

<style scoped>
.global-error.thread-conflict { flex-wrap: wrap; }
.global-error.thread-conflict > span { flex: 1 1 240px; }
.global-error.thread-conflict > button { white-space: nowrap; }
.compaction-progress { display: flex; align-items: center; gap: 7px; padding: 6px 4px; color: var(--muted); font-size: 12px; }
</style>
