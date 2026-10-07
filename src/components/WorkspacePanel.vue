<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import Icon from "./Icon.vue";
import { diffStats } from "../lib/diff-stats";
import FileMarkdownPreview from "./FileMarkdownPreview.vue";
import { privateState } from "../lib/private-state";
import type { ConversationSelectionSource } from "../lib/conversation-selection";
import { isImagePath, isMarkdownPath } from "../lib/file-preview";
const CodeEditor = defineAsyncComponent(() => import("./CodeEditor.vue"));
const PdfPreview = defineAsyncComponent(() => import("./PdfPreview.vue"));
const InteractiveTerminal = defineAsyncComponent(
  () => import("./InteractiveTerminal.vue"),
);
const GitPanel = defineAsyncComponent(() => import("./GitPanel.vue"));
const DevelopmentPreview = defineAsyncComponent(
  () => import("./DevelopmentPreview.vue"),
);
const TmuxPanel = defineAsyncComponent(() => import("./TmuxPanel.vue"));
const SubagentsPanel = defineAsyncComponent(() => import("./SubagentsPanel.vue"));

const props = defineProps<{
  api: any;
  state: any;
  initialTab?: string;
  openPath?: string;
  openLine?: number;
}>();
const emit = defineEmits<{ close: []; error: [message: string]; add: [source: ConversationSelectionSource]; ask: [source: ConversationSelectionSource] }>();
const tab = ref(props.initialTab || "files");
const tabs = [
  { id: "files", name: "文件", icon: "Folder" },
  { id: "agents", name: "子智能体", icon: "Bot" },
  { id: "preview", name: "预览", icon: "Eye" },
  { id: "terminal", name: "终端", icon: "Terminal" },
  { id: "tmux", name: "Tmux", icon: "Layers" },
  { id: "git", name: "Git", icon: "GitBranch" },
  { id: "changes", name: "变更", icon: "GitCompareArrows" },
];
const fileSearch = ref("");
const changeSearch = ref("");
const directory = ref("");
const directoryInput = ref("");
const entries = ref<any[]>([]);
type EditorTab = { file: any; content: string; original: string; view: "preview" | "source"; conflict: any; saving: boolean; line?: number | null };
const editorTabs = ref<EditorTab[]>([]);
const activePath = ref("");
const activeEditor = computed(() => editorTabs.value.find(entry => entry.file.path === activePath.value));
const file = computed(() => activeEditor.value?.file || null);
const content = computed({ get: () => activeEditor.value?.content || "", set: value => { if (activeEditor.value) activeEditor.value.content = value; } });
const originalContent = computed({ get: () => activeEditor.value?.original || "", set: value => { if (activeEditor.value) activeEditor.value.original = value; } });
const fileEditor = ref<InstanceType<typeof CodeEditor>>();
const selectedLine = computed({ get: () => activeEditor.value?.line || null, set: value => { if (activeEditor.value) activeEditor.value.line = value; } });
const loading = ref(false);
const saving = computed({ get: () => !!activeEditor.value?.saving, set: value => { if (activeEditor.value) activeEditor.value.saving = value; } });
const error = ref("");
const downloading = ref("");
const conflict = computed({ get: () => activeEditor.value?.conflict || null, set: value => { if (activeEditor.value) activeEditor.value.conflict = value; } });
const expandedChanges = ref(new Set<string>());
let directoryGeneration = 0;
let fileGeneration = 0;
let revealGeneration = 0;
let workspaceGeneration = 0;
const fileScope = () => `${props.state.hostId}\0${props.state.projectPath}`;
const terminalCommand = ref("");
const terminalMode = ref("shell");
const terminalScroll = ref<HTMLElement>();
const terminalRef = ref<HTMLInputElement>();
const previewSource = ref("file");
const previewInput = ref("");
const previewUrl = ref("");
const previewMode = ref("desktop");
const previewKey = ref(0);
const previewDocument = ref(false);
const fileView = computed({ get: () => activeEditor.value?.view || "preview", set: value => { if (activeEditor.value) activeEditor.value.view = value; } });
const draftWarning = ref("");
let activeScope = "", draftTimer: ReturnType<typeof setTimeout> | undefined, workspaceReady: Promise<void> = Promise.resolve();
function persistDrafts() {
  clearTimeout(draftTimer);
  if (!activeScope || !props.state.authenticated) return;
  const scope = activeScope;
  const tabs = editorTabs.value.map(entry => ({ ...entry, saving: false, file: { ...entry.file, dataUrl: undefined, dataBase64: undefined } }));
  void privateState.write("file-workspace", scope, { tabs, activePath: activePath.value }).then(() => { if (scope === activeScope) draftWarning.value = ""; }).catch(cause => { if (scope === activeScope) draftWarning.value = `草稿保留在当前页面，持久化失败：${cause.message}`; });
}
function scheduleDrafts() { clearTimeout(draftTimer); draftTimer = setTimeout(persistDrafts, 180); }
watch([editorTabs, activePath], scheduleDrafts, { deep: true });
const dirty = computed(() => content.value !== originalContent.value);
const changeScope = ref("loaded");
// Keep every patch in execution order. These are operation counts, not a net
// repository diff; repeated edits and later undo must not silently disappear.
const changes = computed(() => {
  const map = new Map<string, any>();
  const latestTurnId = props.state.turns?.at(-1)?.id;
  for (const item of props.state.items || []) {
    if (item.type !== "fileChange" || (changeScope.value === "latest" && item.turnId !== latestTurnId)) continue;
    for (const change of item.changes || []) {
      let entry = map.get(change.path);
      if (!entry) { entry = { path: change.path, patches: [] }; map.set(change.path, entry); }
      entry.patches.push({ ...change, itemId: item.id, turnId: item.turnId });
    }
  }
  return [...map.values()].map(change => ({ ...change, diff: change.patches.map((patch: any) => patch.diff || "").join("\n") }));
});
const filteredChanges = computed(() => changes.value.filter(change => change.path.toLocaleLowerCase().includes(changeSearch.value.trim().toLocaleLowerCase())));
const changeTotals = computed(() => changes.value.reduce((sum, change) => { const count = diffStats(change.diff); return { added: sum.added + count.added, removed: sum.removed + count.removed } }, { added: 0, removed: 0 }));
const sortedEntries = computed(() =>
  [...entries.value].filter(entry => (entry.fileName || entry.name).toLocaleLowerCase().includes(fileSearch.value.trim().toLocaleLowerCase())).sort(
    (a, b) =>
      Number(b.isDirectory || b.type === "directory") -
        Number(a.isDirectory || a.type === "directory") ||
      (a.fileName || a.name).localeCompare(b.fileName || b.name),
  ),
);
const displayName = computed(() => file.value?.path?.split("/").pop() || "");
const isImage = computed(
  () =>
    /^image\//.test(file.value?.mime || "") ||
    /^data:image\//.test(file.value?.dataUrl || ""),
);
const isMarkdown = computed(() => !file.value?.binary && isMarkdownPath(file.value?.path || ""));
function join(base: string, name: string) {
  return `${base.replace(/\/$/, "")}/${name}`;
}
async function readDirectory(path: string, interruptReveal = true) {
  if (!path) return;
  if (interruptReveal) ++revealGeneration;
  const generation = ++directoryGeneration;
  const scope = fileScope();
  loading.value = true;
  error.value = "";
  try {
    const result = await props.api.readDirectory(path);
    if (generation !== directoryGeneration || scope !== fileScope()) return;
    entries.value = Array.isArray(result) ? result : result.entries || [];
    directory.value = path;
    directoryInput.value = path;
  } catch (cause: any) {
    if (generation === directoryGeneration && scope === fileScope())
      error.value = cause.message || "读取目录失败";
  } finally {
    if (generation === directoryGeneration && scope === fileScope())
      loading.value = false;
  }
}
async function openFile(path: string, destination = "files", line?: number) {
  if (!path) return;
  if (file.value?.path === path && (!file.value.binary && !/^image\//.test(file.value.mime) || file.value.dataUrl || file.value.dataBase64)) {
    ++fileGeneration;
    loading.value = false;
    tab.value = destination;
    previewDocument.value = destination === "preview";
    if (destination === "preview") previewInput.value = path;
    if (line) await focusLine(line);
    return;
  }
  ++revealGeneration;
  const existing = editorTabs.value.find(entry => entry.file.path === path);
  if (existing) {
    activePath.value = path; tab.value = destination; previewDocument.value = destination === "preview";
    if (!existing.file.binary && !/^image\//.test(existing.file.mime)) { if (line) await focusLine(line); return; }
    if (existing.file.dataUrl || existing.file.dataBase64) return;
  }
  if (!existing && editorTabs.value.length >= 16) { error.value = "最多打开 16 个文件，请先关闭一个标签"; return; }
  loading.value = true;
  const generation = ++fileGeneration;
  const scope = fileScope();
  error.value = "";
  try {
    const result = await props.api.readFile(path);
    if (generation !== fileGeneration || scope !== fileScope()) return;
    const entry: EditorTab = { file: { ...result, path }, content: result.content || "", original: result.content || "", view: "preview", conflict: null, saving: false, line: null };
    if (existing) Object.assign(existing, entry); else editorTabs.value.push(entry);
    activePath.value = path;
    previewDocument.value = destination === "preview";
    if (destination === "preview") previewInput.value = path;
    tab.value = destination;
    if (line) await focusLine(line);
  } catch (cause: any) {
    if (generation === fileGeneration && scope === fileScope())
      error.value = cause.message || "读取文件失败";
  } finally {
    if (generation === fileGeneration && scope === fileScope())
      loading.value = false;
  }
}
async function focusLine(line: number) {
  if (!file.value || file.value.binary || isImage.value) return;
  selectedLine.value = Math.max(1, Math.min(Math.floor(line), content.value.split("\n").length));
  fileView.value = "source";
  await nextTick();
  const editor = fileEditor.value;
  if (!editor) return;
  editor.focusLine(selectedLine.value);
}
async function revealPath(path: string, line?: number) {
  const generation = ++revealGeneration;
  const scope = fileScope();
  try {
    const metadata = await props.api.rpc("fs/getMetadata", { path });
    if (scope !== fileScope() || generation !== revealGeneration) return;
    if (metadata.isDirectory) {
      ++fileGeneration;
      activePath.value = "";
      tab.value = "files";
      await readDirectory(path, false);
    } else await openFile(path, "files", line);
  } catch (cause: any) {
    if (scope === fileScope() && generation === revealGeneration)
      error.value = cause.message || "无法打开路径";
  }
}
async function download(path: string) {
  if (downloading.value) return;
  const scope = fileScope();
  downloading.value = path;
  error.value = "";
  try {
    await props.api.downloadFile(path);
  } catch (cause: any) {
    if (scope === fileScope()) error.value = cause.message || "文件下载失败";
  } finally {
    if (scope === fileScope()) downloading.value = "";
  }
}
async function attachTmux(prepared: any) {
  try {
    await props.api.switchTmuxTerminal(prepared);
    terminalMode.value = "shell";
    tab.value = "terminal";
  } catch (cause: any) {
    error.value = cause.message || "无法连接 tmux 会话";
  }
}
function openEntry(entry: any) {
  const path =
    entry.path || join(directory.value, entry.fileName || entry.name);
  if (entry.isDirectory || entry.type === "directory") void readDirectory(path);
  else void openFile(path);
}
function up() {
  const path =
    directory.value.replace(/\/$/, "").split("/").slice(0, -1).join("/") || "/";
  void readDirectory(path);
}
async function save() {
  if (!file.value || saving.value || props.state.permission === "read-only") return;
  const path = file.value.path;
  const savedEditor = activeEditor.value!;
  const savedFile = savedEditor.file;
  const savedContent = content.value;
  const scope = fileScope();
  const current = () => scope === fileScope() && editorTabs.value.includes(savedEditor);
  saving.value = true;
  error.value = "";
  try {
    const result = await props.api.writeFile(path, savedContent, savedFile.version, props.state.hostId);
    if (current()) { savedEditor.original = savedContent; savedFile.version = result.version; savedEditor.conflict = null; persistDrafts(); }
  } catch (cause: any) {
    if (current()) {
      error.value = cause.message || "保存文件失败";
      if (cause.status === 409 && cause.code === "FILE_CONFLICT") {
        try {
          const disk = await props.api.readFile(path, { silentError: true });
          if (current()) savedEditor.conflict = disk;
        } catch { if (current()) error.value += " 读取磁盘版本失败，请重试保存以重新检查。"; }
      }
    }
  } finally {
    if (current()) savedEditor.saving = false;
  }
}
function resolveConflict(reload: boolean) {
  if (!conflict.value || !file.value) return;
  if (reload && !window.confirm("重新载入会丢弃当前草稿，是否继续？")) return;
  file.value.version = conflict.value.version;
  originalContent.value = conflict.value.content;
  if (reload) content.value = conflict.value.content;
  conflict.value = null;
  error.value = "";
  fileView.value = "source";
}
function toggleChange(event: Event, key: string) {
  if ((event.currentTarget as HTMLDetailsElement).open) expandedChanges.value.add(key);
  else expandedChanges.value.delete(key);
}
function closeFile() {
  ++fileGeneration; activePath.value = ""; previewDocument.value = false; tab.value = "files";
}
function closeEditor(path: string) {
  const entry = editorTabs.value.find(entry => entry.file.path === path);
  if (!entry || entry.saving) return;
  if (entry.content !== entry.original && !window.confirm("关闭标签会丢弃此文件的未保存草稿，是否继续？")) return;
  editorTabs.value = editorTabs.value.filter(candidate => candidate !== entry);
  if (activePath.value === path) activePath.value = editorTabs.value.at(-1)?.file.path || "";
  persistDrafts();
}
function codeSelection(value: { text: string; startLine: number; endLine: number }, action: 'add' | 'ask') {
  if (!file.value || !props.state.activeThread?.id) return;
  const source: ConversationSelectionSource = { hostId: props.state.hostId, threadId: props.state.activeThread.id, threadName: props.state.activeThread.name, path: file.value.path, startLine: value.startLine, endLine: value.endLine, text: value.text };
  if (action === 'add') emit('add', source); else emit('ask', source);
}
async function preview(path?: string) {
  previewSource.value = "file";
  const input = (path || previewInput.value).trim();
  if (!input) return;
  if (/^https?:\/\//i.test(input)) {
    ++fileGeneration;
    loading.value = false;
    previewDocument.value = false;
    previewUrl.value = input;
    previewInput.value = input;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    error.value = "预览地址必须为 HTTP(S) URL 或文件路径";
    return;
  } else {
    const filePath = input.startsWith("/")
      ? input
      : join(props.state.projectPath, input);
    if (isMarkdownPath(filePath) || isImagePath(filePath) || /\.pdf$/i.test(filePath)) {
      previewInput.value = filePath;
      await openFile(filePath, "preview");
      return;
    }
    ++fileGeneration;
    loading.value = false;
    previewDocument.value = false;
    previewUrl.value = `/api/preview?host=${encodeURIComponent(props.state.hostId)}&path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(props.state.projectPath)}`;
    previewInput.value = filePath;
  }
  previewKey.value++;
  tab.value = "preview";
}
async function terminalSubmit() {
  const command = terminalCommand.value;
  if (!command.trim()) return;
  error.value = "";
  terminalCommand.value = "";
  try {
    if (props.state.terminalRunning && props.state.terminalProcessId) {
      const bytes = new TextEncoder().encode(`${command}\n`);
      await props.api.rpc("command/exec/write", {
        processId: props.state.terminalProcessId,
        deltaBase64: btoa(String.fromCharCode(...bytes)),
        closeStdin: false,
      });
    } else await props.api.runTerminal(command);
  } catch (cause: any) {
    error.value = cause.message || "命令执行失败";
  }
  await nextTick();
  terminalRef.value?.focus();
}
async function stopTerminal() {
  try {
    if (props.state.terminalProcessId)
      await props.api.rpc("command/exec/terminate", {
        processId: props.state.terminalProcessId,
      });
  } catch (cause: any) {
    error.value = cause.message;
  }
}
async function checkDiff() {
  try {
    const result = await props.api.rpc("gitDiffToRemote", {
      cwd: props.state.projectPath,
    });
    if (result?.diff) content.value = result.diff;
  } catch (cause: any) {
    error.value = cause.message;
  }
}
watch(
  () => props.initialTab,
  (value) => {
    if (value) tab.value = value;
  },
);
watch(
  () => [props.state.projectPath, props.state.hostId, props.state.authenticated],
  () => {
    persistDrafts();
    ++directoryGeneration; ++fileGeneration; ++revealGeneration;
    const version = ++workspaceGeneration;
    const scope = fileScope(); activeScope = "";
    const current = () => version === workspaceGeneration && scope === fileScope() && props.state.authenticated;
    editorTabs.value = []; activePath.value = ""; downloading.value = ""; previewDocument.value = false;
    workspaceReady = (async () => {
      await props.api.privateSessionReady?.();
      if (!current()) return;
      activeScope = scope;
      try {
        const restored = await privateState.read<{ tabs: EditorTab[]; activePath: string }>("file-workspace", scope);
        if (!current()) return;
        if (restored && Array.isArray(restored.tabs)) { editorTabs.value = restored.tabs.slice(0, 16).filter(entry => typeof entry.file?.path === "string" && typeof entry.content === "string" && typeof entry.original === "string"); activePath.value = restored.activePath; }
      } catch { if (current()) draftWarning.value = "无法读取持久化草稿，请检查网站存储权限"; }
      if (props.state.connected && props.state.projectPath) await readDirectory(props.state.projectPath, false);
      if (!current()) return;
      if (props.openPath) await revealPath(props.openPath, props.openLine);
      else if (file.value?.binary || /^image\//.test(file.value?.mime || "")) await openFile(activePath.value);
    })();
  }, { immediate: true },
);
watch(() => props.state.connected, connected => {
  if (connected && props.state.projectPath) void workspaceReady.then(() => readDirectory(directory.value || props.state.projectPath, false));
});
watch(() => [props.openPath, props.openLine] as const, ([value, line]) => {
  if (value) void workspaceReady.then(() => revealPath(value, line));
});
if (typeof window !== "undefined") window.addEventListener("pagehide", persistDrafts);
onBeforeUnmount(() => {
  persistDrafts(); window.removeEventListener("pagehide", persistDrafts); clearTimeout(draftTimer);
  ++directoryGeneration;
  ++fileGeneration;
  ++revealGeneration;
  ++workspaceGeneration;
});
watch(
  () => props.state.terminalOutput,
  async () => {
    await nextTick();
    if (terminalScroll.value)
      terminalScroll.value.scrollTop = terminalScroll.value.scrollHeight;
  },
);
watch(tab, async (value) => {
  if (value === "terminal") {
    await nextTick();
    terminalRef.value?.focus();
  }
});
defineExpose({
  openFile,
  revealPath,
  setTab: (value: string) => {
    tab.value = value;
  },
});
</script>

<template>
  <aside class="workspace-panel">
    <header class="workspace-header">
      <strong>工作区</strong
      ><button
        class="icon-button"
        @click="emit('close')"
        title="关闭工作区"
        aria-label="关闭工作区"
      >
        <Icon name="PanelRight" :size="17" />
      </button>
    </header>
    <nav class="workspace-tabs" aria-label="工作区视图">
      <button
        v-for="entry in tabs"
        :key="entry.id"
        :class="{ active: tab === entry.id }"
        @click="tab = entry.id"
      >
        <Icon :name="entry.icon" :size="15" />{{ entry.name
        }}<span
          v-if="entry.id === 'changes' && changes.length"
          class="count-badge"
          >{{ changes.length }}</span
        >
      </button>
    </nav>
    <div v-if="error" class="panel-error">
      <Icon name="AlertCircle" :size="16" /><span>{{ error }}</span
      ><button class="icon-button" @click="error = ''" aria-label="关闭错误">
        <Icon name="X" :size="13" />
      </button>
    </div>
    <div v-if="tab === 'files' || (tab === 'preview' && previewSource === 'file' && previewDocument)" class="workspace-body files-view">
      <template v-if="tab === 'preview'">
        <div class="preview-source-toolbar segmented-control">
          <button class="active" @click="previewSource = 'file'">文件 / URL</button>
          <button @click="previewSource = 'service'">开发服务</button>
        </div>
        <form class="preview-toolbar" @submit.prevent="preview()">
          <Icon name="FileText" :size="15" />
          <input v-model="previewInput" placeholder="输入 URL、Markdown、图片或 HTML 路径" aria-label="预览地址" />
          <button class="icon-button" type="submit" title="打开预览" aria-label="打开预览"><Icon name="ArrowRight" :size="15" /></button>
        </form>
      </template>
      <form
        v-else
        class="directory-toolbar"
        @submit.prevent="readDirectory(directoryInput)"
      >
        <button
          class="icon-button"
          type="button"
          @click="up"
          title="上一级目录"
          aria-label="上一级目录"
        >
          <Icon name="ArrowUp" :size="15" /></button
        ><input
          v-model="directoryInput"
          placeholder="项目目录"
          aria-label="目录路径"
        /><button
          class="icon-button"
          type="submit"
          title="刷新目录"
          aria-label="刷新目录"
        >
          <Icon
            :name="loading ? 'LoaderCircle' : 'RefreshCw'"
            :size="14"
            :class="{ spin: loading }"
          />
        </button>
      </form>
      <p v-if="draftWarning" class="panel-error" role="status">{{ draftWarning }}</p>
      <nav v-if="editorTabs.length" class="file-tab-bar" aria-label="已打开文件">
        <div v-for="entry in editorTabs" :key="entry.file.path" :class="{ active: activePath === entry.file.path }">
          <button :title="entry.file.path" :aria-pressed="activePath === entry.file.path" @click="openFile(entry.file.path, tab)">{{ entry.file.path.split('/').pop() }}<i v-if="entry.content !== entry.original" class="dirty-dot"></i></button>
          <button class="icon-button" :disabled="entry.saving" :aria-label="'关闭文件 ' + entry.file.path.split('/').pop()" @click="closeEditor(entry.file.path)"><Icon name="X" :size="12" /></button>
        </div>
      </nav>
      <template v-if="file">
        <div class="file-editor-heading">
          <button
            class="icon-button"
            @click="closeFile"
            title="返回文件列表"
            aria-label="返回文件列表"
          >
            <Icon name="ArrowLeft" :size="15" /></button
          ><span :title="file.path"
            >{{ displayName }}<i v-if="dirty" class="dirty-dot"></i></span
          ><div v-if="isMarkdown" class="segmented-control file-view-switch" aria-label="Markdown 显示方式">
            <button :class="{ active: fileView === 'preview' }" :aria-pressed="fileView === 'preview'" @click="fileView = 'preview'">预览</button>
            <button :class="{ active: fileView === 'source' }" :aria-pressed="fileView === 'source'" @click="fileView = 'source'">源码</button>
          </div><button
            class="icon-button"
            :disabled="!!downloading"
            @click="download(file.path)"
            :title="dirty ? '下载已保存的文件' : '下载文件'"
            aria-label="下载文件"
          >
            <Icon
              :name="downloading === file.path ? 'LoaderCircle' : 'Download'"
              :size="15"
              :class="{ spin: downloading === file.path }"
            /></button
          ><button
            v-if="/\.html?$/i.test(file.path)"
            class="icon-button"
            @click="preview(file.path)"
            title="预览 HTML"
            aria-label="预览 HTML"
          >
            <Icon name="Eye" :size="15" /></button
          ><button
            v-if="!isImage && !file.binary"
            class="button button-small button-secondary"
            :disabled="!dirty || saving || loading || state.permission === 'read-only'"
            @click="save"
          >
            <Icon :name="saving ? 'LoaderCircle' : 'Save'" :size="13" />保存
          </button>
        </div>
        <section v-if="conflict" class="file-save-conflict" role="alert" aria-label="文件保存冲突">
          <strong>磁盘内容已更新，你的草稿已保留</strong>
          <div class="file-conflict-comparison"><div><span>磁盘版本</span><pre>{{ conflict.content }}</pre></div><div><span>当前草稿</span><pre>{{ content }}</pre></div></div>
          <div class="file-conflict-actions"><button class="button button-small button-secondary" @click="resolveConflict(true)">重新载入磁盘版本</button><button class="button button-small" :disabled="conflict.binary" @click="resolveConflict(false)">保留草稿并手动合并</button></div>
          <small>手动合并后再次保存；保存前仍会检查磁盘是否又有更新。</small>
        </section>
        <div v-if="isImage" class="file-image">
          <img :src="file.dataUrl" :alt="displayName" />
        </div>
        <PdfPreview v-else-if="file.mime === 'application/pdf' && file.dataBase64" :key="file.path" :data-base64="file.dataBase64" :name="displayName" />
        <div v-else-if="file.binary" class="panel-empty">
          <Icon name="File" :size="32" />
          <p>此文件可下载后查看</p>
          <span>{{ displayName }}</span>
        </div>
        <FileMarkdownPreview
          v-else-if="isMarkdown && fileView === 'preview'"
          :content="content"
          :path="file.path"
          :root="state.projectPath || file.path.slice(0, file.path.lastIndexOf('/')) || '/'"
          :host-id="state.hostId"
          :api="api"
          @open-file="openFile($event, tab)"
        />
        <CodeEditor
          v-else :key="file.path" ref="fileEditor" v-model="content" :path="file.path"
          :line="selectedLine || undefined" :readonly="state.permission === 'read-only'" :allow-question="!!state.activeThread?.id"
          @save="save" @selection="codeSelection"
        />
        <div class="file-editor-footer">
          <span>{{ isImage ? '图片预览' : content.split("\n").length + ' 行' }}{{ selectedLine && !isImage ? ' · 定位第 ' + selectedLine + ' 行' : '' }}</span
          ><span>{{
            state.permission === "read-only"
              ? "只读"
              : dirty
                ? "未保存"
                : "已保存"
          }}</span>
        </div>
      </template>
      <div v-else class="file-tree">
        <label class="workspace-file-search"><Icon name="Search" :size="14" /><input v-model="fileSearch" aria-label="搜索文件名" placeholder="搜索当前目录文件名" /><button v-if="fileSearch" class="icon-button" aria-label="清除文件名搜索" @click="fileSearch = ''"><Icon name="X" :size="13" /></button></label>
        <p v-if="entries.length && !sortedEntries.length" class="file-search-empty">没有匹配的文件</p>
        <div
          v-for="entry in sortedEntries"
          :key="entry.fileName || entry.name"
          class="file-tree-entry"
        >
          <button class="file-tree-row" @click="openEntry(entry)">
            <Icon
              :name="
                entry.isDirectory || entry.type === 'directory'
                  ? 'Folder'
                  : 'FileText'
              "
              :size="16"
            /><span>{{ entry.fileName || entry.name }}</span
            ><Icon
              v-if="entry.isDirectory || entry.type === 'directory'"
              name="ChevronRight"
              :size="13"
            /></button
          ><button
            v-if="!entry.isDirectory && entry.type !== 'directory'"
            class="icon-button file-download"
            :disabled="!!downloading"
            @click="
              download(
                entry.path || join(directory, entry.fileName || entry.name),
              )
            "
            :title="`下载 ${entry.fileName || entry.name}`"
            :aria-label="`下载 ${entry.fileName || entry.name}`"
          >
            <Icon
              :name="
                downloading ===
                (entry.path || join(directory, entry.fileName || entry.name))
                  ? 'LoaderCircle'
                  : 'Download'
              "
              :size="14"
              :class="{
                spin:
                  downloading ===
                  (entry.path || join(directory, entry.fileName || entry.name)),
              }"
            />
          </button>
        </div>
        <div v-if="!entries.length && !loading" class="panel-empty">
          <Icon name="FolderOpen" :size="32" />
          <p>
            {{
              state.projectPath ? "此目录为空" : "选择一个项目，开始浏览文件"
            }}
          </p>
        </div>
      </div>
    </div>
    <div v-else-if="tab === 'agents'" class="workspace-body agents-view">
      <SubagentsPanel :api="api" :state="state" />
    </div>
    <div v-else-if="tab === 'tmux'" class="workspace-body tmux-view">
      <TmuxPanel :api="api" :state="state" @attach="attachTmux" />
    </div>
    <div v-else-if="tab === 'git'" class="workspace-body git-view">
      <GitPanel
        :api="api"
        :state="state"
        @file="openFile"
        @project="api.toast('已切换工作树')"
        @error="emit('error', $event)"
      />
    </div>
    <div v-else-if="tab === 'preview'" class="workspace-body preview-view">
      <div class="preview-source-toolbar segmented-control">
        <button
          :class="{ active: previewSource === 'file' }"
          @click="previewSource = 'file'"
        >
          文件 / URL</button
        ><button
          :class="{ active: previewSource === 'service' }"
          @click="previewSource = 'service'"
        >
          开发服务
        </button>
      </div>
      <DevelopmentPreview
        v-if="previewSource === 'service'"
        :api="api"
        :state="state"
      />
      <template v-else>
        <form class="preview-toolbar" @submit.prevent="preview()">
          <Icon name="Globe" :size="15" /><input
            v-model="previewInput"
            placeholder="输入 URL、Markdown、图片或 HTML 路径"
            aria-label="预览地址"
          /><button
            class="icon-button"
            type="submit"
            title="打开预览"
            aria-label="打开预览"
          >
            <Icon name="ArrowRight" :size="15" />
          </button>
        </form>
        <div v-if="previewUrl" class="preview-options">
          <div class="segmented-control">
            <button
              :class="{ active: previewMode === 'desktop' }"
              @click="previewMode = 'desktop'"
              title="桌面预览"
              aria-label="桌面预览"
            >
              <Icon name="Monitor" :size="15" /></button
            ><button
              :class="{ active: previewMode === 'mobile' }"
              @click="previewMode = 'mobile'"
              title="手机预览"
              aria-label="手机预览"
            >
              <Icon name="Smartphone" :size="15" />
            </button>
          </div>
          <button
            class="icon-button"
            @click="previewKey++"
            title="刷新预览"
            aria-label="刷新预览"
          >
            <Icon name="RefreshCw" :size="15" /></button
          ><a
            :href="previewUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="icon-button"
            title="在新标签页打开"
            aria-label="在新标签页打开"
            ><Icon name="ExternalLink" :size="15"
          /></a>
        </div>
        <div
          v-if="previewUrl"
          class="preview-frame-container"
          :class="{ mobile: previewMode === 'mobile' }"
        >
          <iframe
            :key="previewKey"
            :src="previewUrl"
            title="项目预览"
            sandbox="allow-scripts allow-forms allow-popups allow-downloads"
            referrerpolicy="no-referrer"
          ></iframe>
        </div>
        <div v-else class="panel-empty">
          <Icon name="Eye" :size="32" />
          <p>把你的作品放在眼前</p>
          <span>输入运行地址，或打开项目里的 Markdown、图片和 HTML 文件。</span>
        </div>
      </template>
    </div>
    <div v-else-if="tab === 'terminal'" class="workspace-body terminal-view">
      <div class="terminal-mode-toolbar">
        <div class="segmented-control">
          <button
            :class="{ active: terminalMode === 'shell' }"
            @click="terminalMode = 'shell'"
          >
            交互 Shell</button
          ><button
            :class="{ active: terminalMode === 'command' }"
            @click="terminalMode = 'command'"
          >
            命令模式
          </button>
        </div>
        <select
          v-if="state.terminalProcesses?.length"
          :value="state.terminalProcessId"
          aria-label="选择运行中的终端"
          @change="
            api.attachTerminal(($event.target as HTMLSelectElement).value)
          "
        >
          <option disabled value="">连接运行中的终端</option>
          <option
            v-for="process in state.terminalProcesses"
            :key="process.processId"
            :value="process.processId"
          >
            {{ process.tty ? "Shell" : "命令" }} ·
            {{ process.cwd?.split("/").pop() || "工作区" }}
          </option>
        </select>
      </div>
      <InteractiveTerminal
        v-if="terminalMode === 'shell'"
        :api="api"
        :state="state"
      />
      <template v-else>
        <div class="terminal-heading">
          <span
            ><i :class="{ running: state.terminalRunning }"></i
            >{{ state.terminalRunning ? "正在运行" : "终端就绪" }}</span
          ><span class="terminal-cwd" :title="state.projectPath">{{
            state.projectPath?.split("/").pop() || "工作目录"
          }}</span
          ><button
            v-if="state.terminalRunning"
            class="icon-button"
            @click="stopTerminal"
            title="结束进程"
            aria-label="结束进程"
          >
            <Icon name="StopCircle" :size="15" />
          </button>
        </div>
        <pre ref="terminalScroll" class="terminal-output">{{
          state.terminalOutput || "在下方输入命令。输出将实时显示在这里。"
        }}</pre>
        <form class="terminal-input" @submit.prevent="terminalSubmit">
          <span>❯</span
          ><input
            ref="terminalRef"
            v-model="terminalCommand"
            :placeholder="
              state.terminalRunning ? '发送到运行中的进程…' : '输入命令…'
            "
            spellcheck="false"
            autocomplete="off"
            aria-label="终端命令"
            :disabled="!state.connected || state.permission === 'read-only'"
          /><button
            class="icon-button"
            type="submit"
            :disabled="
              !terminalCommand.trim() ||
              !state.connected ||
              state.permission === 'read-only'
            "
            title="执行命令"
            aria-label="执行命令"
          >
            <Icon name="CornerDownLeft" :size="15" />
          </button>
        </form>
        <div class="terminal-footnote">
          {{
            state.permission === "read-only"
              ? "当前只读权限，切换权限后可执行命令。"
              : "命令在所选主机的项目目录执行。"
          }}
        </div>
      </template>
    </div>
    <div v-else class="workspace-body changes-view">
      <div class="changes-heading">
        <span>{{ changeScope === 'latest' ? '上一轮操作' : '已加载操作记录' }} · {{ changes.length }} 个文件</span><span class="diff-stats"><span class="diff-count-add">+{{ changeTotals.added }}</span><span class="diff-count-remove">−{{ changeTotals.removed }}</span></span>
      </div>
      <div class="changes-scope"><select v-model="changeScope" aria-label="变更记录范围"><option value="loaded">已加载操作记录</option><option value="latest">上一轮操作</option></select><button class="button button-small button-secondary" @click="tab = 'git'">工作区／暂存差异</button></div>
      <p class="changes-scope-note">行数为所选记录中累计操作；工作区净变更与暂存内容可在 Git 查看。</p>
      <label class="workspace-file-search"><Icon name="Search" :size="14" /><input v-model="changeSearch" aria-label="搜索变更文件名" placeholder="搜索变更文件名" /><button v-if="changeSearch" class="icon-button" aria-label="清除变更搜索" @click="changeSearch = ''"><Icon name="X" :size="13" /></button></label>
      <p v-if="changes.length && !filteredChanges.length" class="file-search-empty">没有匹配的变更文件</p>
      <details v-for="change in filteredChanges" :key="`${state.hostId}:${state.activeThread?.id || ''}:${change.path}`" class="change-card" @toggle="toggleChange($event, change.path)">
        <summary class="file-diff-heading" :title="change.path">
          <Icon name="FileText" :size="15" /><span class="change-path">{{
            change.path.replace(state.projectPath + "/", "")
          }}</span
          ><span class="diff-stats"><span class="diff-count-add">+{{ diffStats(change.diff).added }}</span><span class="diff-count-remove">−{{ diffStats(change.diff).removed }}</span></span><button class="icon-button" :aria-label="`打开文件 ${change.path}`" :title="`打开文件 ${change.path}`" @click.stop.prevent="openFile(change.path)"><Icon name="ArrowUpRight" :size="14" /></button
          ><Icon name="ChevronDown" :size="14" />
        </summary>
        <div v-if="expandedChanges.has(change.path)" class="change-patches">
          <section v-for="(patch, patchIndex) in change.patches" :key="`${patch.itemId}:${patchIndex}`">
            <div v-if="change.patches.length > 1" class="change-patch-label">第 {{ Number(patchIndex) + 1 }} 次修改 <span class="diff-stats"><span class="diff-count-add">+{{ diffStats(patch.diff).added }}</span><span class="diff-count-remove">−{{ diffStats(patch.diff).removed }}</span></span></div>
            <pre class="diff-code"><span v-for="(line, index) in (patch.diff || '').split('\n')" :key="index" :class="line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''">{{ line + '\n' }}</span></pre>
          </section>
        </div>
      </details>
      <div v-if="!changes.length" class="panel-empty">
        <Icon name="GitCompareArrows" :size="32" />
        <p>暂无文件变更</p>
        <span>Codex 对项目的修改将显示在这里。</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.file-save-conflict { flex: 0 0 auto; padding: 12px; border-bottom: 1px solid var(--border); background: var(--surface); font-size: 12px; max-height: 50%; overflow: auto; }
.file-conflict-comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0; }
.file-conflict-comparison > div { min-width: 0; }
.file-conflict-comparison pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto; font-size: 11px; }
.file-conflict-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.changes-scope { display: flex; gap: 6px; align-items: center; }
.changes-scope select { min-width: 0; padding: 4px; font-size: 12px; }
.changes-scope-note { font-size: 11px; color: var(--muted); margin: 8px 0; }
.change-patch-label { display: flex; gap: 8px; padding: 6px 10px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); }
.changes-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.workspace-file-search { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); }
.workspace-file-search input { min-width: 0; width: 100%; border: 0; background: transparent; font-size: 12px; padding: 4px 0; }
.workspace-file-search .icon-button { width: 24px; height: 24px; flex-shrink: 0; }
.file-search-empty { padding: 12px 8px; color: var(--muted); font-size: 12px; }

.change-card > summary { list-style: none; cursor: pointer; }
.change-card > summary::-webkit-details-marker { display: none; }
.change-card > summary > svg:last-child { transition: transform .15s; }
.change-card[open] > summary > svg:last-child { transform: rotate(180deg); }
.file-view-switch { flex: 0 0 auto; }
.file-view-switch button { padding: 4px 7px; font-size: 12px; }
.file-editor-heading { gap: 6px; min-width: 0; }
.file-editor-heading > span { min-width: 0; }
.file-tree-entry {
  display: flex;
  align-items: center;
  min-width: 0;
}
.file-tree-entry .file-tree-row {
  flex: 1;
  min-width: 0;
}
.file-download {
  flex: 0 0 32px;
  color: var(--muted);
  margin-right: 8px;
}
.file-download:hover {
  color: var(--text);
}
@media (max-width: 760px) {
  .file-download {
    min-height: 40px;
    flex-basis: 40px;
  }
}
</style>
