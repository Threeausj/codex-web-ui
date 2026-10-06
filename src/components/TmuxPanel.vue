<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";

type Session = {
  id: string;
  name: string;
  windows: number;
  attached: number;
  createdAt: number;
  path?: string;
};
type Pane = {
  id: string;
  title: string;
  command: string;
  path: string;
  windowId: string;
  windowName: string;
  active: boolean;
  windowActive: boolean;
};
const props = defineProps<{ api: any; state: any }>();
const emit = defineEmits<{ attach: [prepared: any] }>();
const sessions = ref<Session[]>([]);
const selectedId = ref("");
const panes = ref<Pane[]>([]);
const paneId = ref("");
const snapshot = ref("");
const available = ref<boolean | null>(null);
const reason = ref("");
const error = ref("");
const loading = ref(false);
const reading = ref(false);
const busy = ref(false);
const showCreate = ref(false);
const sessionName = ref("");
const deleteId = ref("");
const lastRead = ref("");
let scopeGeneration = 0;
let listGeneration = 0;
let readGeneration = 0;
let disposed = false;
const scope = computed(
  () => `${props.state.hostId}\0${props.state.projectPath}`,
);
const hostName = computed(
  () =>
    props.state.hosts?.find((host: any) => host.id === props.state.hostId)
      ?.name || (props.state.hostId === "local" ? "本机" : props.state.hostId),
);
const readonly = computed(() => props.state.permission === "read-only");
const canRead = computed(
  () =>
    !!props.state.connected &&
    !!props.state.projectPath &&
    !props.state.switchingHost,
);
const canWrite = computed(
  () =>
    canRead.value && !readonly.value && !busy.value && available.value === true,
);
const selected = computed(() =>
  sessions.value.find((session) => session.id === selectedId.value),
);
const deleting = computed(() =>
  sessions.value.find((session) => session.id === deleteId.value),
);
function context() {
  return {
    hostId: props.state.hostId,
    cwd: props.state.projectPath,
    permission: props.state.permission,
  };
}
function request(action: string, values: Record<string, unknown> = {}) {
  return props.api.requestHttp(
    `/tmux/${action}`,
    {
      method: "POST",
      body: JSON.stringify({ ...context(), ...values }),
    },
    false,
  );
}
function current(generation: number) {
  return !disposed && generation === scopeGeneration;
}
async function read(id = selectedId.value, pane?: string) {
  if (!canRead.value || !id || available.value !== true) return;
  const generation = scopeGeneration;
  const readingRequest = ++readGeneration;
  reading.value = true;
  try {
    const result = await request("read", {
      sessionId: id,
      ...(pane ? { paneId: pane } : {}),
    });
    if (
      !current(generation) ||
      readingRequest !== readGeneration ||
      selectedId.value !== id
    )
      return;
    panes.value = result.panes || [];
    paneId.value = result.paneId;
    snapshot.value = result.text || "";
    lastRead.value = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    error.value = "";
  } catch (cause: any) {
    if (current(generation) && readingRequest === readGeneration)
      error.value = cause.message || "读取会话失败";
  } finally {
    if (current(generation) && readingRequest === readGeneration)
      reading.value = false;
  }
}
async function refresh() {
  if (!canRead.value || busy.value) return;
  const generation = scopeGeneration;
  const listRequest = ++listGeneration;
  loading.value = true;
  try {
    const result = await request("list");
    if (!current(generation) || listRequest !== listGeneration) return;
    available.value = result.available;
    reason.value = result.reason || "目标主机未检测到 tmux";
    sessions.value = result.sessions || [];
    error.value = "";
    if (!sessions.value.some((session) => session.id === selectedId.value)) {
      selectedId.value = sessions.value[0]?.id || "";
      paneId.value = "";
      panes.value = [];
      snapshot.value = "";
      lastRead.value = "";
      deleteId.value = "";
      readGeneration++;
      reading.value = false;
    }
    if (available.value && selectedId.value)
      await read(selectedId.value, paneId.value || undefined);
  } catch (cause: any) {
    if (current(generation) && listRequest === listGeneration)
      error.value = cause.message || "读取会话列表失败";
  } finally {
    if (current(generation) && listRequest === listGeneration)
      loading.value = false;
  }
}
function select(session: Session) {
  if (busy.value || selectedId.value === session.id) return;
  selectedId.value = session.id;
  paneId.value = "";
  panes.value = [];
  snapshot.value = "";
  lastRead.value = "";
  deleteId.value = "";
  error.value = "";
  void read(session.id);
}
async function create() {
  if (!canWrite.value) return;
  const generation = scopeGeneration;
  const input = context();
  busy.value = true;
  error.value = "";
  listGeneration++;
  loading.value = false;
  readGeneration++;
  reading.value = false;
  let succeeded = false;
  try {
    const result = await props.api.requestHttp(
      "/tmux/create",
      {
        method: "POST",
        body: JSON.stringify({
          ...input,
          ...(sessionName.value.trim()
            ? { name: sessionName.value.trim() }
            : {}),
        }),
      },
      false,
    );
    if (!current(generation)) return;
    selectedId.value = result.session.id;
    paneId.value = "";
    panes.value = [];
    snapshot.value = "";
    lastRead.value = "";
    showCreate.value = false;
    sessionName.value = "";
    succeeded = true;
  } catch (cause: any) {
    if (current(generation)) error.value = cause.message || "新建会话失败";
  } finally {
    if (current(generation)) {
      busy.value = false;
      if (succeeded) await refresh();
    }
  }
}
async function attach() {
  if (!canWrite.value || !selected.value) return;
  const generation = scopeGeneration;
  const input = context();
  const id = selectedId.value;
  busy.value = true;
  error.value = "";
  readGeneration++;
  reading.value = false;
  try {
    const result = await props.api.requestHttp(
      "/tmux/attach",
      {
        method: "POST",
        body: JSON.stringify({ ...input, sessionId: id }),
      },
      false,
    );
    if (current(generation) && input.permission === props.state.permission)
      emit("attach", { ...result, ...input });
  } catch (cause: any) {
    if (current(generation)) error.value = cause.message || "切换到终端失败";
  } finally {
    if (current(generation)) busy.value = false;
  }
}
async function remove() {
  if (!canWrite.value || !deleteId.value) return;
  const generation = scopeGeneration;
  const input = context();
  const id = deleteId.value;
  busy.value = true;
  error.value = "";
  listGeneration++;
  loading.value = false;
  readGeneration++;
  reading.value = false;
  let succeeded = false;
  try {
    await props.api.requestHttp(
      "/tmux/delete",
      {
        method: "POST",
        body: JSON.stringify({ ...input, sessionId: id }),
      },
      false,
    );
    if (!current(generation)) return;
    deleteId.value = "";
    if (selectedId.value === id) {
      selectedId.value = "";
      panes.value = [];
      paneId.value = "";
      snapshot.value = "";
      lastRead.value = "";
    }
    succeeded = true;
  } catch (cause: any) {
    if (current(generation)) error.value = cause.message || "删除会话失败";
  } finally {
    if (current(generation)) {
      busy.value = false;
      if (succeeded) await refresh();
    }
  }
}
watch(
  () => [scope.value, canRead.value],
  () => {
    scopeGeneration++;
    listGeneration++;
    readGeneration++;
    sessions.value = [];
    selectedId.value = "";
    panes.value = [];
    paneId.value = "";
    snapshot.value = "";
    lastRead.value = "";
    error.value = "";
    reason.value = "";
    available.value = null;
    loading.value = false;
    reading.value = false;
    busy.value = false;
    deleteId.value = "";
    showCreate.value = false;
    sessionName.value = "";
    void refresh();
  },
  { immediate: true },
);
watch(readonly, () => {
  deleteId.value = "";
  showCreate.value = false;
});
const refreshTimer = window.setInterval(() => {
  if (
    document.visibilityState === "visible" &&
    !busy.value &&
    !loading.value &&
    !reading.value
  )
    void refresh();
}, 20_000);
onBeforeUnmount(() => {
  disposed = true;
  scopeGeneration++;
  window.clearInterval(refreshTimer);
});
</script>

<template>
  <section class="tmux-panel" aria-label="Tmux 会话管理">
    <header class="tmux-toolbar">
      <div class="tmux-heading">
        <strong>Tmux 会话</strong
        ><span class="tmux-host" :title="hostName">{{ hostName }}</span>
      </div>
      <div class="tmux-actions">
        <button
          class="icon-button"
          aria-label="刷新 Tmux 会话"
          title="刷新会话"
          :disabled="!canRead || loading || busy"
          @click="refresh"
        >
          <Icon name="RefreshCw" :size="15" :class="{ spinning: loading }" />
        </button>
        <button
          class="tmux-button"
          :disabled="!canWrite"
          @click="
            showCreate = !showCreate;
            deleteId = '';
          "
        >
          <Icon name="Plus" :size="14" />新建
        </button>
      </div>
    </header>
    <p v-if="readonly" class="tmux-note">
      只读模式可查看会话与输出。切换写入权限后可管理会话。
    </p>
    <p v-if="!canRead" class="tmux-note">连接主机并选择项目后查看会话。</p>
    <div v-if="error" class="tmux-error" role="alert">
      <Icon name="AlertCircle" :size="15" /><span>{{ error }}</span>
    </div>
    <form v-if="showCreate" class="tmux-create" @submit.prevent="create">
      <label for="tmux-session-name">会话名称 <span>可选</span></label>
      <input
        id="tmux-session-name"
        v-model="sessionName"
        placeholder="留空自动命名"
        aria-label="新建 Tmux 会话名称"
        maxlength="80"
        :disabled="busy || readonly"
      />
      <p class="tmux-note">在当前项目目录新建独立 Shell。</p>
      <div class="tmux-form-actions">
        <button
          type="button"
          class="tmux-button"
          :disabled="busy"
          @click="showCreate = false"
        >
          取消</button
        ><button
          type="submit"
          class="tmux-button primary"
          :disabled="!canWrite"
        >
          创建会话
        </button>
      </div>
    </form>
    <div v-if="available === false" class="tmux-empty">
      <Icon name="Terminal" :size="24" /><strong>Tmux 不可用</strong>
      <p>{{ reason }}</p>
      <p>在此主机安装 tmux 后刷新。</p>
    </div>
    <div v-else-if="available === null && loading" class="tmux-empty">
      <Icon name="LoaderCircle" :size="22" class="spinning" />
      <p>正在读取会话…</p>
    </div>
    <div v-else-if="available && !sessions.length" class="tmux-empty">
      <Icon name="Terminal" :size="24" /><strong>还没有会话</strong>
      <p>新建持久 Shell，稍后可继续读取或切换。</p>
    </div>
    <template v-else-if="sessions.length">
      <div class="tmux-session-list" role="group" aria-label="Tmux 会话列表">
        <button
          v-for="session in sessions"
          :key="session.id"
          class="tmux-session"
          :class="{ selected: selectedId === session.id }"
          :aria-pressed="selectedId === session.id"
          :aria-label="`读取会话 ${session.name}`"
          :disabled="busy"
          @click="select(session)"
        >
          <Icon name="Terminal" :size="16" /><span class="tmux-session-info"
            ><span class="tmux-session-name" :title="session.name">{{
              session.name
            }}</span
            ><span class="tmux-session-meta"
              >{{ session.windows }} 个窗口<span v-if="session.attached">
                · {{ session.attached }} 个连接</span
              ></span
            ></span
          ><Icon v-if="selectedId === session.id" name="Check" :size="14" />
        </button>
      </div>
      <section v-if="selected" class="tmux-reader" aria-label="Tmux 会话输出">
        <header class="tmux-reader-header">
          <strong :title="selected.name">{{ selected.name }}</strong>
          <div class="tmux-actions">
            <button class="tmux-button" :disabled="!canWrite" @click="attach">
              <Icon name="Terminal" :size="14" />切换到终端</button
            ><button
              class="icon-button tmux-delete"
              :disabled="!canWrite"
              :aria-label="`删除会话 ${selected.name}`"
              title="删除会话"
              @click="
                deleteId = selectedId;
                showCreate = false;
              "
            >
              <Icon name="Trash2" :size="15" />
            </button>
          </div>
        </header>
        <div
          v-if="deleting"
          class="tmux-confirm"
          role="group"
          aria-label="确认删除 Tmux 会话"
        >
          <strong>删除会话 {{ deleting.name }}？</strong>
          <p>会结束该会话中的进程。其他会话不受影响。</p>
          <div class="tmux-form-actions">
            <button class="tmux-button" :disabled="busy" @click="deleteId = ''">
              取消</button
            ><button
              class="tmux-button danger"
              :disabled="!canWrite"
              @click="remove"
            >
              确认删除会话
            </button>
          </div>
        </div>
        <div class="tmux-pane-toolbar">
          <select
            v-if="panes.length > 1"
            :value="paneId"
            aria-label="Tmux 窗口与面板"
            :disabled="reading || busy"
            @change="
              read(selectedId, ($event.target as HTMLSelectElement).value)
            "
          >
            <option v-for="pane in panes" :key="pane.id" :value="pane.id">
              {{ pane.windowName || pane.windowId }} ·
              {{ pane.command || pane.title || pane.id }} {{ pane.id }}
            </option></select
          ><span v-else class="tmux-pane-name">{{
            panes[0]?.command || "输出快照"
          }}</span
          ><button
            class="icon-button"
            :disabled="reading || busy || !canRead"
            aria-label="刷新会话输出"
            title="读取最新输出"
            @click="read(selectedId, paneId || undefined)"
          >
            <Icon name="RefreshCw" :size="13" :class="{ spinning: reading }" />
          </button>
        </div>
        <pre class="tmux-snapshot" tabindex="0" aria-label="Tmux 输出快照">{{
          snapshot || (reading ? "正在读取…" : "暂无输出")
        }}</pre>
        <div class="tmux-reader-note">
          <span>只读取输出，不发送按键</span
          ><span v-if="lastRead">{{ lastRead }} 更新</span>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.tmux-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 16px;
  gap: 12px;
  font-size: 13px;
}
.tmux-toolbar,
.tmux-heading,
.tmux-actions,
.tmux-reader-header,
.tmux-pane-toolbar,
.tmux-form-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tmux-toolbar,
.tmux-reader-header,
.tmux-pane-toolbar {
  justify-content: space-between;
}
.tmux-heading {
  min-width: 0;
}
.tmux-heading strong {
  font-size: 14px;
  white-space: nowrap;
  font-weight: 550;
}
.tmux-host {
  background: var(--hover);
  color: var(--muted);
  border-radius: 5px;
  padding: 2px 6px;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 110px;
}
.tmux-actions {
  flex-shrink: 0;
}
.tmux-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 30px;
  padding: 5px 9px;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 7px;
  color: var(--text);
  font-size: 12px;
}
.tmux-button:hover:not(:disabled) {
  background: var(--hover);
}
.tmux-button:disabled,
.tmux-session:disabled {
  opacity: 0.4;
  cursor: default;
}
.tmux-button.primary {
  background: var(--text);
  color: var(--bg);
  border-color: var(--text);
}
.tmux-button.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 30%, var(--border));
}
.tmux-delete:hover:not(:disabled) {
  color: var(--red);
}
.tmux-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}
.tmux-error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--red) 7%, var(--surface));
  color: var(--red);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.tmux-error svg {
  flex-shrink: 0;
  margin-top: 1px;
}
.tmux-create,
.tmux-confirm {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
}
.tmux-create label {
  font-size: 12px;
}
.tmux-create label span {
  color: var(--muted);
  margin-left: 4px;
}
.tmux-create input {
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  font-size: 13px;
  background: var(--bg);
  color: var(--text);
}
.tmux-form-actions {
  justify-content: flex-end;
}
.tmux-confirm strong {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.tmux-confirm p {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}
.tmux-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 34px 12px;
  gap: 9px;
  color: var(--muted);
  text-align: center;
}
.tmux-empty strong {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
}
.tmux-empty p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.tmux-session-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 220px;
  overflow: auto;
  flex-shrink: 0;
}
.tmux-session {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  min-width: 0;
  border: 0;
  border-radius: 8px;
  color: var(--text-muted);
  text-align: left;
  background: transparent;
}
.tmux-session:hover:not(:disabled),
.tmux-session.selected {
  background: var(--hover);
  color: var(--text);
}
.tmux-session svg {
  flex-shrink: 0;
}
.tmux-session-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  gap: 3px;
}
.tmux-session-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tmux-session-meta {
  font-size: 11px;
  color: var(--muted);
}
.tmux-reader {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 240px;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 9px;
  overflow: hidden;
}
.tmux-reader-header {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  gap: 10px;
}
.tmux-reader-header strong {
  font-size: 12px;
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tmux-pane-toolbar {
  padding: 5px 10px;
  gap: 8px;
  background: var(--surface);
  font-size: 11px;
  color: var(--muted);
}
.tmux-pane-toolbar select {
  min-width: 0;
  max-width: calc(100% - 30px);
  font-size: 12px;
  color: var(--text-muted);
  border: 0;
  background: transparent;
  padding: 5px 0;
}
.tmux-pane-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tmux-snapshot {
  flex: 1;
  min-width: 0;
  min-height: 150px;
  max-height: 60vh;
  overflow: auto;
  margin: 0;
  padding: 12px;
  font: 12px/1.6
    var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--text);
  background: var(--bg);
  white-space: pre;
  tab-size: 4;
}
.tmux-reader-note {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--muted);
}
@media (max-width: 760px) {
  .tmux-panel {
    padding: 12px;
    font-size: 13px;
  }
  .tmux-button {
    min-height: 36px;
  }
  .tmux-panel .icon-button {
    min-width: 36px;
    min-height: 36px;
  }
  .tmux-host {
    max-width: 90px;
  }
  .tmux-create input {
    font-size: 16px;
  }
  .tmux-session {
    min-height: 50px;
  }
  .tmux-session-meta {
    font-size: 12px;
  }
  .tmux-reader-note {
    font-size: 11px;
  }
  .tmux-reader-header {
    gap: 5px;
  }
  .tmux-reader-header .tmux-actions {
    gap: 4px;
  }
  .tmux-pane-toolbar select {
    font-size: 13px;
    min-height: 36px;
  }
}
</style>
