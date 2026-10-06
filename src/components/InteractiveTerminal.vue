<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import Icon from "./Icon.vue";

const props = defineProps<{ api: any; state: any }>();
const element = ref<HTMLDivElement>();
const error = ref("");
const persistent = ref(false);
const persistentNote = ref("");
const starting = ref(false);
const mounted = ref(false);
const ctrl = ref(false);
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
  if (!element.value?.clientWidth || !terminal || !fit) return;
  fit.fit();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (
      props.state.terminalRunning &&
      props.state.terminalProcessId?.startsWith("web-pty-")
    ) {
      void props.api
        .resizeTerminal(terminal!.cols, terminal!.rows)
        .catch(() => {});
    }
  }, 120);
}
async function start() {
  if (disposed || starting.value || props.state.terminalRunning ||
      !props.state.connected || !props.state.projectPath ||
      props.state.switchingHost || props.state.permission === "read-only") return;
  const generation = ++startGeneration;
  error.value = "";
  persistentNote.value = "";
  starting.value = true;
  let options:
    | { command?: string[]; persistent?: boolean; sessionName?: string }
    | undefined;
  const hostId = props.state.hostId;
  const projectPath = props.state.projectPath;
  const permission = props.state.permission;
  const requestedPersistent = persistent.value;
  const current = () => !disposed && generation === startGeneration && hostId === props.state.hostId &&
    projectPath === props.state.projectPath && permission === props.state.permission &&
    requestedPersistent === persistent.value;
  try {
    if (persistent.value) {
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
async function stop() {
  try {
    await props.api.stopTerminal();
  } catch (cause: any) {
    error.value = cause.message;
  }
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
      background: "#17191b",
      foreground: "#e5e7eb",
      cursor: "#e5e7eb",
      selectionBackground: "#4a5057",
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
  () => terminal?.reset(),
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
      ><button
        v-if="!state.terminalRunning"
        class="button button-small button-secondary"
        :disabled="
          starting || !state.connected || state.permission === 'read-only'
        "
        @click="start"
      >
        {{ starting ? "检查中…" : "启动终端" }}</button
      ><button
        v-else
        class="icon-button"
        :title="state.terminalSessionName ? '断开 tmux 连接' : '结束终端'"
        aria-label="结束终端"
        @click="stop"
      >
        <Icon name="StopCircle" :size="15" />
      </button>
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
              : "普通 PTY 支持网络断线恢复；服务重启会结束 Shell。")
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
  background: #17191b;
  color: #e5e7eb;
  overflow: hidden;
}
.pty-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 46px;
  padding: 8px 14px;
  border-bottom: 1px solid #303236;
  font-size: 12px;
}
.pty-toolbar span {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pty-toolbar i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #777;
}
.pty-toolbar i.running {
  background: #7bc5a0;
}
.xterm-container {
  flex: 1;
  min-height: 200px;
  padding: 10px 8px;
  overflow: hidden;
}
.pty-hint {
  padding: 8px 14px;
  font-size: 10px;
  color: #999;
  border-top: 1px solid #303236;
}
.pty-persistence {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  color: #a4a9b0;
  padding: 8px 14px;
  border-bottom: 1px solid #303236;
}
.pty-persistence input {
  accent-color: #7bc5a0;
}
.pty-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 7px 9px;
  border-top: 1px solid #303236;
}
.pty-keys button {
  border: 1px solid #3b3f44;
  border-radius: 5px;
  background: #25282c;
  color: #d9dde2;
  min-width: 29px;
  min-height: 29px;
  padding: 4px 6px;
  font:
    11px ui-monospace,
    monospace;
  touch-action: manipulation;
}
.pty-keys button.active {
  background: #4d7864;
  border-color: #7bc5a0;
}
.pty-keys button:disabled {
  opacity: 0.4;
}
@media (max-width: 760px) {
  .pty-keys {
    gap: 4px;
  }
  .pty-keys button {
    min-height: 36px;
    flex: 1;
  }
  .pty-hint {
    font-size: 10px;
  }
  .xterm-container {
    min-height: 150px;
  }
}
</style>
