<script setup lang="ts">
import { computed, nextTick, ref, useId } from "vue";
import Icon from "./Icon.vue";
import { isPinned, threadActivityAt, threadLabel } from "../lib/navigation";
const props = defineProps<{
  thread: any;
  state: any;
  api: any;
  nested?: boolean;
  archived?: boolean;
}>();
const emit = defineEmits<{
  select: [selection: { id: string; hostId: string }];
  error: [message: string];
  renamed: [thread: { id: string; hostId: string; name: string }];
  deleted: [thread: { id: string; hostId: string }];
  restored: [thread: { id: string; hostId: string }];
}>();
const menu = ref(false);
const pending = ref(false);
const menuButton = ref<HTMLButtonElement>();
const dialogElement = ref<HTMLDialogElement>();
const nameInput = ref<HTMLInputElement>();
const dialogMode = ref<"rename" | "delete" | null>(null);
const name = ref("");
const dialogError = ref("");
const dialogTitleId = `thread-action-title-${useId()}`;
const hostId = computed(() => props.thread.hostId || props.state.hostId);
const host = computed(() =>
  props.state.hosts.find((item: any) => item.id === hostId.value),
);
const pinned = computed(() =>
  isPinned(
    props.state.preferences.pins,
    hostId.value,
    "thread",
    props.thread.id,
  ),
);
const label = computed(() => threadLabel(props.thread));
const running = computed(() =>
  props.thread.status?.type === "active" ||
  (props.state.hostId === hostId.value &&
    props.state.activeThread?.id === props.thread.id && props.state.busy),
);
const time = computed(() => {
  const timestamp = threadActivityAt(props.thread);
  if (!timestamp) return "";
  const age = Date.now() - (timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return age < 60000
    ? "刚刚"
    : age < 3600000
      ? `${Math.floor(age / 60000)}分`
      : age < 86400000
        ? `${Math.floor(age / 3600000)}时`
        : new Date(
            timestamp < 1e12 ? timestamp * 1000 : timestamp,
          ).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
});
async function run(action: () => any, completed?: () => void) {
  if (pending.value) return;
  pending.value = true;
  menu.value = false;
  try {
    await action();
    completed?.();
  } catch (error: any) {
    emit("error", error.message);
  } finally {
    pending.value = false;
  }
}
function restoreThread() {
  return run(() => props.api.unarchiveThread(props.thread.id, hostId.value), () =>
    emit("restored", { id: props.thread.id, hostId: hostId.value }),
  );
}
async function openDialog(mode: "rename" | "delete") {
  if (pending.value || (mode === "delete" && running.value)) return;
  menu.value = false;
  dialogError.value = "";
  name.value = label.value;
  dialogMode.value = mode;
  await nextTick();
  dialogElement.value?.showModal();
  if (mode === "rename") {
    nameInput.value?.focus();
    nameInput.value?.select();
  }
}
function closeDialog() {
  if (pending.value) return;
  dialogElement.value?.close();
  dialogMode.value = null;
  menuButton.value?.focus({ preventScroll: true });
}
async function submitDialog() {
  if (pending.value || !dialogMode.value) return;
  const mode = dialogMode.value;
  const newName = name.value.trim();
  if (mode === "rename" && !newName) return;
  if (mode === "delete" && running.value) {
    dialogError.value = "对话正在运行，请先停止任务后再删除。";
    return;
  }
  pending.value = true;
  dialogError.value = "";
  try {
    if (mode === "rename") {
      await props.api.renameThread(newName, props.thread.id, hostId.value);
      emit("renamed", { id: props.thread.id, hostId: hostId.value, name: newName });
    } else {
      await props.api.deleteThread(props.thread.id, hostId.value);
      emit("deleted", { id: props.thread.id, hostId: hostId.value });
    }
    pending.value = false;
    closeDialog();
  } catch (error: any) {
    dialogError.value = error.message || (mode === "rename" ? "无法重命名对话" : "无法删除对话");
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <div
    class="nav-thread"
    :data-host-id="hostId"
    :class="{
      nested,
      active: state.hostId === hostId && state.activeThread?.id === thread.id,
    }"
  >
    <button
      class="thread-row"
      @click="
        archived
          ? restoreThread()
          : emit('select', { id: thread.id, hostId })
      "
      :title="label"
      :disabled="pending"
    >
      <span
        v-if="thread.status?.type === 'active'"
        class="thread-running-dot"
      ></span
      ><Icon v-else-if="archived" name="Archive" :size="12" /><span
        class="thread-title"
        >{{ label }}</span
      ><span
        v-if="!nested"
        class="host-badge"
        :title="host?.hostname || host?.name"
        >{{ host?.name || "本机" }}</span
      ><small>{{ time }}</small>
    </button>
    <button
      ref="menuButton"
      class="nav-row-menu icon-button"
      @click="menu = !menu"
      :disabled="pending"
      :aria-label="`${label} 对话操作`"
      :aria-expanded="menu"
      :title="`${label} 对话操作`"
    >
      <Icon name="MoreHorizontal" :size="15" />
    </button>
    <div
      v-if="menu"
      class="nav-context-menu"
      role="menu"
      @keydown.esc.stop="menu = false"
    >
      <button :disabled="pending" @click="openDialog('rename')">
        <Icon name="Pencil" :size="14" />重命名对话
      </button>
      <button
        v-if="!archived"
        @click="run(() => api.pin('thread', thread.id, label, hostId))"
      >
        <Icon :name="pinned ? 'PinOff' : 'Pin'" :size="14" />{{
          pinned ? "取消置顶" : "置顶对话"
        }}
      </button>
      <button
        v-if="!archived"
        @click="run(() => api.archiveThread(thread.id, hostId))"
      >
        <Icon name="Archive" :size="14" />归档对话
      </button>
      <button v-else @click="restoreThread">
        <Icon name="Undo2" :size="14" />恢复对话
      </button>
      <button
        @click="run(() => api.exportThread(thread.id, 'markdown', hostId))"
      >
        <Icon name="Download" :size="14" />导出 Markdown
      </button>
      <button @click="run(() => api.exportThread(thread.id, 'json', hostId))">
        <Icon name="FileText" :size="14" />导出 JSON
      </button>
      <button
        class="delete-thread-action"
        :disabled="pending || running"
        :title="running ? '对话正在运行，请先停止任务后再删除' : '永久删除对话'"
        :aria-describedby="running ? `${dialogTitleId}-running` : undefined"
        @click="openDialog('delete')"
      >
        <Icon name="Trash2" :size="14" />删除对话
      </button>
      <p v-if="running" :id="`${dialogTitleId}-running`" class="delete-thread-note">
        请先停止运行中的任务，再删除对话。
      </p>
      <button @click="menu = false">
        <Icon name="X" :size="14" />关闭菜单
      </button>
    </div>
  </div>
  <Teleport to="body">
    <dialog
      v-if="dialogMode"
      ref="dialogElement"
      class="thread-action-dialog"
      :aria-labelledby="dialogTitleId"
      @keydown.stop
      @cancel.prevent="closeDialog"
    >
      <form @submit.prevent="submitDialog">
        <header>
          <h2 :id="dialogTitleId">{{ dialogMode === 'rename' ? '重命名对话' : '删除对话' }}</h2>
          <button
            type="button"
            class="icon-button"
            :disabled="pending"
            aria-label="关闭对话操作"
            @click="closeDialog"
          ><Icon name="X" :size="17" /></button>
        </header>
        <label v-if="dialogMode === 'rename'">
          对话名称
          <input ref="nameInput" v-model="name" aria-label="对话名称" required maxlength="1000" :disabled="pending" />
        </label>
        <template v-else>
          <p class="delete-description">「{{ label }}」及其子智能体对话将永久删除，无法恢复。项目文件不会被删除。</p>
          <p v-if="running" class="inline-error" role="alert">对话正在运行，请先停止任务后再删除。</p>
        </template>
        <p v-if="dialogError" class="inline-error" role="alert">{{ dialogError }}</p>
        <footer>
          <button type="button" class="button button-secondary" :disabled="pending" autofocus @click="closeDialog">取消</button>
          <button
            class="button"
            :class="dialogMode === 'rename' ? 'button-primary' : 'delete-thread-confirm'"
            :disabled="pending || (dialogMode === 'rename' ? !name.trim() : running)"
          >{{ pending ? (dialogMode === 'rename' ? '保存中…' : '删除中…') : (dialogMode === 'rename' ? '保存名称' : '永久删除') }}</button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>
<style scoped>
.nav-context-menu .delete-thread-action { color: var(--danger); }
.nav-context-menu button:disabled { opacity: .5; cursor: not-allowed; }
.delete-thread-note { color: var(--muted); font-size: 11px; padding: 0 9px 5px; margin: 0; }
.thread-action-dialog {
  padding: 24px;
  width: min(440px, calc(100vw - 28px));
  max-height: calc(100dvh - 32px);
  margin: auto;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 20px 80px #0002;
}
.thread-action-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(3px); }
.thread-action-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
.thread-action-dialog h2 { margin: 0; font-size: 18px; }
.thread-action-dialog label { display: block; font-size: 13px; }
.thread-action-dialog input { display: block; width: 100%; margin-top: 7px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text); font: inherit; }
.thread-action-dialog .delete-description { margin: 0; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.thread-action-dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
.thread-action-dialog .delete-thread-confirm { background: var(--danger); color: var(--surface); }
@media (max-width: 760px) {
  .thread-action-dialog { padding: 20px; }
  .thread-action-dialog input { font-size: 16px; }
}
</style>
