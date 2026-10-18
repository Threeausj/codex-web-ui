<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import Icon from "./Icon.vue";
import { copyText } from "../lib/copy-text";

const props = defineProps<{ api: any; state: any }>();
const element = ref<HTMLDivElement>();
const error = ref("");
const persistent = ref(false);
const persistentNote = ref("");
const starting = ref(false);
const mounted = ref(false);
const ctrl = ref(false);
const hasSelection = ref(false);
const closing = ref(new Set<string>());
const terminals = computed<any[]>(() => (props.state.terminalProcesses || []).filter((process: any) => process.tty));
const canStart = computed(() => !starting.value && !terminals.value.some((process: any) => process.pending) && props.state.connected && !props.state.switchingHost &&
  !!props.state.projectPath && props.state.permission !== "read-only");
const keys = [
  { label: "Ctrl+C", value: "\u0003" },
  { label: "Ctrl+D", value: "\u0004" },
  { label: "Tab", value: "\t" },
  { label: "Esc", value: "\u001b" },
  { label: "↑", value: "\u001b[A" },
  { label: "↓", value: "\u001b[B" },
  { label: "←", value: "\u001b[D" },
  { label: "→", value: "\u001b[C" },
];
let terminal: Terminal | undefined;
let fit: FitAddon | undefined;
let observer: ResizeObserver | undefined;
let unsubscribe: (() => void) | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let startGeneration = 0;
let automaticScope = "";

function fitTerminal() {
  if (!element.value?.clientWidth || !element.value?.clientHeight || !terminal || !fit) return;
  fit.fit();
  clearTimeout(resizeTimer);
  const hostId = props.state.hostId, processId = props.state.terminalProcessId;
  const cols = terminal.cols, rows = terminal.rows;
  resizeTimer = setTimeout(() => {
    if (
      !disposed && hostId === props.state.hostId && processId === props.state.terminalProcessId &&
      props.state.terminalRunning && processId?.startsWith("web-pty-")
    ) {
      void props.api
        .resizeTerminal(cols, rows, processId)
        .catch(() => {});
    }
  }, 120);
}
async function start(newConnection = false) {
  if (disposed || !canStart.value || (props.state.terminalRunning && !newConnection)) return;
  const generation = ++startGeneration;
  error.value = "";
  persistentNote.value = "";
  starting.value = true;
  let options:
    | { command?: string[]; persistent?: boolean; sessionName?: string; newConnection?: boolean }
    | undefined;
  const hostId = props.state.hostId;
  const projectPath = props.state.projectPath;
  const permission = props.state.permission;
  const requestedPersistent = !newConnection && persistent.value;
  options = { newConnection };
  const current = () => !disposed && generation === startGeneration && hostId === props.state.hostId &&
    projectPath === props.state.projectPath && permission === props.state.permission &&
    (newConnection || requestedPersistent === persistent.value);
  try {
    if (requestedPersistent) {
      const result = await props.api.requestHttp("/terminal-sessions/prepare", {
        method: "POST",
        body: JSON.stringify({ hostId, cwd: projectPath, permission }),
      });
      if (!current()) return;
      if (!result.available)
        throw new Error(result.reason || "所选主机没有 tmux");
      options = {
        command: result.command,
        persistent: true,
        sessionName: result.sessionName,
        newConnection,
      };
      persistentNote.value = result.note;
    }
    fitTerminal();
    terminal?.reset();
    terminal?.focus();
    void props.api
      .startTerminal(terminal?.cols ?? 80, terminal?.rows ?? 24, options)
      .catch((cause: Error) => { if (current()) error.value = cause.message; });
  } catch (cause: any) {
    if (current()) error.value = cause.message;
  } finally {
    if (generation === startGeneration) starting.value = false;
  }
}
async function stop(processId = props.state.terminalProcessId) {
  if (!processId || closing.value.has(processId)) return;
  const hostId = props.state.hostId;
  closing.value = new Set([...closing.value, processId]);
  try {
    await props.api.stopTerminal(processId);
  } catch (cause: any) {
    if (hostId === props.state.hostId) error.value = cause.message;
  } finally {
    closing.value = new Set([...closing.value].filter(id => id !== processId));
  }
}
async function selectTerminal(processId: string) {
  ++startGeneration;
  starting.value = false;
  error.value = "";
  persistentNote.value = "";
  ctrl.value = false;
  try { props.api.attachTerminal(processId); await nextTick(); fitTerminal(); terminal?.focus(); }
  catch (cause: any) { error.value = cause.message; }
}
async function copySelection() {
  const text = terminal?.getSelection();
  if (!text) return;
  try { await copyText(text); props.api.toast("已复制终端选中内容"); }
  catch (cause: any) { error.value = cause.message; }
}
async function pasteClipboard() {
  if (!props.state.terminalRunning || !props.state.connected) return;
  const hostId = props.state.hostId, processId = props.state.terminalProcessId;
  try {
    if (!navigator.clipboard?.readText) throw new Error("当前浏览器无法读取剪贴板，请在终端中使用系统粘贴");
    const text = await navigator.clipboard.readText();
    if (!disposed && hostId === props.state.hostId && processId === props.state.terminalProcessId) {
      terminal?.focus(); terminal?.paste(text);
    }
  } catch (cause: any) { if (hostId === props.state.hostId) error.value = cause.message; }
}
async function writeKey(value: string) {
  if (!props.state.terminalRunning || !props.state.connected) return;
  ctrl.value = false;
  terminal?.focus();
  try {
    await props.api.writeTerminal(value);
  } catch (cause: any) {
    error.value = cause.message;
  }
}
onMounted(async () => {
  await nextTick();
  if (disposed || !element.value) return;
  terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    scrollback: 5000,
    convertEol: true,
    theme: {
      background: "#111111",
      foreground: "#f5f5f5",
      cursor: "#f5f5f5",
      selectionBackground: "#484848",
    },
  });
  fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element.value!);
  terminal.write(props.state.terminalOutput);
  unsubscribe = props.api.subscribeTerminal((chunk: string) =>
    terminal?.write(chunk),
  );
  terminal.onData((data) => {
    if (ctrl.value && data.length === 1) {
      data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
      ctrl.value = false;
    }
    if (props.state.terminalRunning && props.state.connected)
      void props.api
        .writeTerminal(data)
        .catch((cause: Error) => (error.value = cause.message));
  });
  terminal.onSelectionChange(() => { hasSelection.value = !!terminal?.hasSelection(); });
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type === "keydown" && event.shiftKey && (event.ctrlKey || event.metaKey)) {
      if (event.code === "KeyC") { event.preventDefault(); void copySelection(); return false; }
      if (event.code === "KeyV") { event.preventDefault(); void pasteClipboard(); return false; }
    }
    return true;
  });
  observer = new ResizeObserver(fitTerminal);
  observer.observe(element.value!);
  fitTerminal();
  mounted.value = true;
});
watch(
  () => [mounted.value, props.state.hostId, props.state.projectPath,
    props.state.connected, props.state.switchingHost, props.state.changingContext,
    props.state.selectingThread, props.state.permission],
  () => {
    if (!mounted.value || disposed || !props.state.connected ||
        !props.state.projectPath || props.state.switchingHost ||
        props.state.changingContext || props.state.selectingThread ||
        props.state.permission === "read-only") return;
    const scope = `${props.state.hostId}\0${props.state.projectPath}`;
    if (automaticScope === scope) return;
    automaticScope = scope;
    // Opening the panel reuses a live shell; tabs and reconnects must not
    // create another PTY merely because xterm mounted again.
    if (props.state.terminalRunning) return;
    const existing = props.state.terminalProcesses?.find((process: any) =>
      process.tty && process.cwd === props.state.projectPath);
    if (existing) props.api.attachTerminal(existing.processId);
    else void start();
  },
  { flush: "post" },
);
watch(
  () => [props.state.hostId, props.state.projectPath, props.state.connected,
    props.state.permission],
  () => {
    ++startGeneration;
    starting.value = false;
    persistentNote.value = "";
    error.value = "";
  },
  { flush: "sync" },
);
watch(
  () => props.state.terminalProcessId,
  () => { terminal?.reset(); ctrl.value = false; hasSelection.value = false; },
  { flush: "sync" },
);
onBeforeUnmount(() => {
  disposed = true;
  ++startGeneration;
  clearTimeout(resizeTimer);
  observer?.disconnect();
  unsubscribe?.();
  terminal?.dispose();
});
</script>

<template>
  <div class="interactive-terminal">
    <div v-if="terminals.length" class="pty-tabs" role="tablist" aria-label="终端标签">
      <div v-for="(process, index) in terminals" :key="process.processId" class="pty-tab" :class="{ active: process.processId === state.terminalProcessId }">
        <button role="tab" :aria-selected="process.processId === state.terminalProcessId" :aria-label="`终端 ${index + 1}`"
          :title="`${process.cwd || 'Shell'} · ${process.processId}`" @click="selectTerminal(process.processId)">
          <Icon name="Terminal" :size="13" /><span>{{ process.cwd?.split('/').pop() || 'Shell' }} {{ index + 1 }}</span>
        </button>
        <button class="pty-tab-close" :aria-label="`关闭终端 ${index + 1}`" :title="process.processId === state.terminalProcessId && state.terminalSessionName ? '断开此 tmux 连接' : '结束此终端的 Shell'"
          :disabled="closing.has(process.processId) || !state.connected" @click="stop(process.processId)"><Icon name="X" :size="12" /></button>
      </div>
    </div>
    <div class="pty-toolbar">
      <span
        ><i :class="{ running: state.terminalRunning }"></i
        >{{
          state.terminalRunning
            ? state.terminalSessionName
              ? `tmux · ${state.terminalSessionName}`
              : "Shell 正在运行"
            : "交互终端"
        }}</span
      ><div class="pty-actions"><button
        class="icon-button" aria-label="新建终端" title="新建独立 Shell" :disabled="!canStart" @click="start(true)"><Icon name="Plus" :size="16" /></button><button
        class="icon-button" aria-label="复制终端选中内容" title="复制选中内容 · Ctrl+Shift+C" :disabled="!hasSelection" @click="copySelection"><Icon name="Copy" :size="14" /></button><button
        class="icon-button" aria-label="粘贴到终端" title="粘贴 · Ctrl+Shift+V" :disabled="!state.terminalRunning || !state.connected" @click="pasteClipboard"><Icon name="CornerDownLeft" :size="14" /></button><button
        class="icon-button" aria-label="滚动到终端最新输出" title="最新输出" @click="terminal?.scrollToBottom()"><Icon name="ArrowDown" :size="14" /></button><button
        v-if="!state.terminalRunning"
        class="button button-small button-secondary"
        :disabled="
          !canStart
        "
        @click="start()"
      >
        {{ starting ? "检查中…" : "启动终端" }}</button
      ><button
        v-else
        class="icon-button"
        :title="state.terminalSessionName ? '断开 tmux 连接' : '结束终端'"
        aria-label="结束终端"
        @click="stop()"
      >
        <Icon name="StopCircle" :size="15" />
      </button></div>
    </div>
    <label v-if="!state.terminalRunning" class="pty-persistence"
      ><input v-model="persistent" type="checkbox" :disabled="starting" />持久
      Shell（需要目标主机已有 tmux）</label
    >
    <p v-if="error" class="inline-error">{{ error }}</p>
    <div ref="element" class="xterm-container" aria-label="交互式终端"></div>
    <div class="pty-keys" aria-label="终端快捷键">
      <button
        :class="{ active: ctrl }"
        :aria-pressed="ctrl"
        :disabled="!state.terminalRunning || !state.connected"
        @pointerdown.prevent
        @click="
          ctrl = !ctrl;
          terminal?.focus();
        "
      >
        Ctrl</button
      ><button
        v-for="key in keys"
        :key="key.label"
        :aria-label="'终端按键 ' + key.label"
        :disabled="!state.terminalRunning || !state.connected"
        @pointerdown.prevent
        @click="writeKey(key.value)"
      >
        {{ key.label }}
      </button>
    </div>
    <div class="pty-hint">
      {{
        state.permission === "read-only"
          ? "选择工作区写入权限后启动终端"
          : persistentNote ||
            (state.terminalSessionName
              ? "断开网页终端会保留 tmux 会话；可在 Tmux 页面重新连接。"
              : "Tab 补全与命令历史由目标 Shell 提供；关闭工作区会保留终端，服务重启会结束普通 Shell。")
      }}
    </div>
  </div>
</template>

<style scoped>
.interactive-terminal {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--surface);
  color: var(--text);
  overflow: hidden;
}
.pty-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 46px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  gap: 8px;
}
.pty-toolbar > span {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pty-actions { display: flex; align-items: center; flex-shrink: 0; gap: 3px; }
.pty-actions .icon-button { color: var(--muted); width: 29px; height: 29px; }
.pty-actions .icon-button:disabled { opacity: .35; }
.pty-tabs { display: flex; gap: 4px; flex: 0 0 auto; overflow-x: auto; padding: 7px 9px 0; border-bottom: 1px solid var(--border); scrollbar-width: thin; }
.pty-tab { display: flex; align-items: center; flex: 0 0 auto; border-radius: 6px 6px 0 0; color: var(--muted); background: var(--soft); border-bottom: 2px solid transparent; }
.pty-tab.active { background: var(--selected); color: var(--text); border-bottom-color: var(--green); }
.pty-tab > button { display: flex; align-items: center; gap: 6px; background: transparent; color: inherit; border: 0; min-height: 33px; padding: 5px 9px; font-size: 11px; }
.pty-tab > button:first-child { max-width: 180px; }
.pty-tab span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pty-tab > .pty-tab-close { padding: 5px; margin-right: 3px; min-width: 26px; justify-content: center; }
.pty-tab-close:hover { background: var(--hover); border-radius: 4px; }
.pty-tab button:focus-visible { outline: 2px solid var(--text); outline-offset: -2px; }
.pty-toolbar i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
}
.pty-toolbar i.running {
  background: var(--green);
}
.xterm-container {
  flex: 1;
  min-height: 200px;
  padding: 10px 8px;
  background: #111111;
  color: #f5f5f5;
  overflow: hidden;
}
.pty-hint {
  padding: 8px 14px;
  font-size: 10px;
  color: var(--muted);
  border-top: 1px solid var(--border);
}
.pty-persistence {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  color: var(--muted);
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}
.pty-persistence input {
  accent-color: var(--green);
}
.pty-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 7px 9px;
  border-top: 1px solid var(--border);
}
.pty-keys button {
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--soft);
  color: var(--text);
  min-width: 29px;
  min-height: 29px;
  padding: 4px 6px;
  font:
    11px ui-monospace,
    monospace;
  touch-action: manipulation;
}
.pty-keys button.active {
  background: var(--selected);
  border-color: var(--green);
}
.pty-keys button:disabled {
  opacity: 0.4;
}
@media (max-width: 760px) {
  .pty-toolbar { min-height: 40px; padding: 5px 8px; font-size: 11px; }
  .pty-actions .icon-button { width: 30px; height: 32px; }
  .pty-tab > button { min-height: 38px; }
  .pty-tab > .pty-tab-close { min-width: 32px; }
  .pty-keys {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 4px;
  }
  .pty-keys button {
    min-height: 36px;
    padding-inline: 4px;
  }
  .pty-hint {
    font-size: 10px;
  }
  .xterm-container {
    min-height: 150px;
  }
}
</style>
