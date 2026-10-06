<script setup lang="ts">
import { computed, ref } from "vue";
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
}>();
const menu = ref(false);
const pending = ref(false);
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
async function run(action: () => any) {
  pending.value = true;
  menu.value = false;
  try {
    await action();
  } catch (error: any) {
    emit("error", error.message);
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
          ? run(() => api.unarchiveThread(thread.id, hostId))
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
      class="nav-row-menu icon-button"
      @click="menu = !menu"
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
      @keydown.esc="menu = false"
    >
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
      <button v-else @click="run(() => api.unarchiveThread(thread.id, hostId))">
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
      <button @click="menu = false">
        <Icon name="X" :size="14" />关闭菜单
      </button>
    </div>
  </div>
</template>
