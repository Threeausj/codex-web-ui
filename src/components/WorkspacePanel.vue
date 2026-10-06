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
import FileMarkdownPreview from "./FileMarkdownPreview.vue";
import { isImagePath, isMarkdownPath } from "../lib/file-preview";
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
}>();
const emit = defineEmits<{ close: []; error: [message: string] }>();
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
const directory = ref("");
const directoryInput = ref("");
const entries = ref<any[]>([]);
const file = ref<any>(null);
const content = ref("");
const originalContent = ref("");
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const downloading = ref("");
let directoryGeneration = 0;
let fileGeneration = 0;
let revealGeneration = 0;
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
const fileView = ref<"preview" | "source">("preview");
const dirty = computed(() => content.value !== originalContent.value);
const changes = computed(() => {
  const map = new Map<string, any>();
  for (const item of props.state.items || [])
    if (item.type === "fileChange")
      for (const change of item.changes || []) map.set(change.path, change);
  return [...map.values()];
});
const sortedEntries = computed(() =>
  [...entries.value].sort(
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
async function openFile(path: string, destination = "files") {
  if (!path) return;
  if (file.value?.path === path) {
    ++fileGeneration;
    loading.value = false;
    tab.value = destination;
    previewDocument.value = destination === "preview";
    if (destination === "preview") previewInput.value = path;
    return;
  }
  ++revealGeneration;
  if (
    dirty.value &&
    !window.confirm("当前文件有未保存的修改，仍要打开其他文件吗？")
  )
    return;
  loading.value = true;
  const generation = ++fileGeneration;
  saving.value = false;
  const scope = fileScope();
  error.value = "";
  try {
    const result = await props.api.readFile(path);
    if (generation !== fileGeneration || scope !== fileScope()) return;
    file.value = { ...result, path };
    content.value = result.content || "";
    originalContent.value = content.value;
    fileView.value = "preview";
    previewDocument.value = destination === "preview";
    if (destination === "preview") previewInput.value = path;
    tab.value = destination;
  } catch (cause: any) {
    if (generation === fileGeneration && scope === fileScope())
      error.value = cause.message || "读取文件失败";
  } finally {
    if (generation === fileGeneration && scope === fileScope())
      loading.value = false;
  }
}
async function revealPath(path: string) {
  const generation = ++revealGeneration;
  const scope = fileScope();
  try {
    const metadata = await props.api.rpc("fs/getMetadata", { path });
    if (scope !== fileScope() || generation !== revealGeneration) return;
    if (metadata.isDirectory) {
      if (
        dirty.value &&
        !window.confirm("当前文件有未保存的修改，仍要显示项目目录吗？")
      )
        return;
      ++fileGeneration;
      file.value = null;
      content.value = originalContent.value = "";
      tab.value = "files";
      await readDirectory(path, false);
    } else await openFile(path);
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
  const savedFile = file.value;
  const savedContent = content.value;
  const scope = fileScope();
  const current = () => file.value === savedFile && scope === fileScope();
  saving.value = true;
  error.value = "";
  try {
    await props.api.writeFile(path, savedContent);
    if (current()) originalContent.value = savedContent;
  } catch (cause: any) {
    if (current()) error.value = cause.message || "保存文件失败";
  } finally {
    if (current()) saving.value = false;
  }
}
function closeFile() {
  if (dirty.value && !window.confirm("当前文件有未保存的修改，仍要返回文件列表吗？")) return;
  ++fileGeneration;
  file.value = null;
  content.value = originalContent.value = "";
  saving.value = false;
  previewDocument.value = false;
  tab.value = "files";
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
    if (isMarkdownPath(filePath) || isImagePath(filePath)) {
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
  () => [props.state.projectPath, props.state.hostId, props.state.connected],
  () => {
    ++directoryGeneration;
    ++fileGeneration;
    ++revealGeneration;
    downloading.value = "";
    saving.value = false;
    previewDocument.value = false;
    if (props.state.connected && props.state.projectPath) {
      file.value = null;
      content.value = originalContent.value = "";
      void readDirectory(props.state.projectPath, false);
    }
  },
  { immediate: true },
);
watch(
  () => props.openPath,
  (value) => {
    if (value) void revealPath(value);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++directoryGeneration;
  ++fileGeneration;
  ++revealGeneration;
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
        <div v-if="isImage" class="file-image">
          <img :src="file.dataUrl" :alt="displayName" />
        </div>
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
        <textarea
          v-else
          v-model="content"
          class="file-editor"
          spellcheck="false"
          :readonly="state.permission === 'read-only'"
          :aria-label="displayName + ' 文件内容'"
        ></textarea>
        <div class="file-editor-footer">
          <span>{{ isImage ? '图片预览' : content.split("\n").length + ' 行' }}</span
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
        <span>本次对话 · {{ changes.length }} 个文件</span>
      </div>
      <details v-for="change in changes" :key="`${state.hostId}:${state.activeThread?.id || ''}:${change.path}`" class="change-card">
        <summary class="file-diff-heading" :title="change.path">
          <Icon name="FileText" :size="15" /><span>{{
            change.path.replace(state.projectPath + "/", "")
          }}</span
          ><button class="icon-button" :aria-label="`打开文件 ${change.path}`" :title="`打开文件 ${change.path}`" @click.stop.prevent="openFile(change.path)"><Icon name="ArrowUpRight" :size="14" /></button
          ><Icon name="ChevronDown" :size="14" />
        </summary>
        <pre
          class="diff-code"
        ><span v-for="(line, index) in (change.diff || '').split('\n')" :key="index" :class="line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''">{{ line + '\n' }}</span></pre>
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
