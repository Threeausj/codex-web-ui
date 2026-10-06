<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import ChatItem from "./ChatItem.vue";
import Icon from "./Icon.vue";
import {
  conversationBlocks,
  elapsedLabel,
  turnPresentation,
} from "../lib/presentation";
import type { DisplayItem } from "../lib/events";

const props = defineProps<{
  items: DisplayItem[];
  turns: any[];
  busy: boolean;
  editableItemId?: string;
  editing?: boolean;
  editDisabled?: boolean;
  editMessage?: (itemId: string, text: string) => Promise<void>;
  cancelMessageEdit?: (itemId: string) => void;
}>();
const emit = defineEmits<{
  fork: [turnId?: string];
  openFile: [path: string];
  error: [message: string];
}>();
const editSession = ref<{
  itemId: string;
  draft: string;
  error: string;
  saving: boolean;
} | null>(null);
const editingItem = ref<DisplayItem | null>(null);
function beginEdit(item: DisplayItem, text: string) {
  if (props.editDisabled || props.editing || !props.editMessage ||
      item.id !== props.editableItemId || editSession.value) return;
  editingItem.value = { ...item };
  editSession.value = { itemId: item.id, draft: text, error: '', saving: false };
}
function cancelEdit() {
  const session = editSession.value;
  if (!session || session.saving || props.editing) return;
  props.cancelMessageEdit?.(session.itemId);
  editSession.value = null;
  editingItem.value = null;
}
async function saveEdit() {
  const session = editSession.value;
  const hasImage = editingItem.value?.content?.some((input: any) =>
    ['image', 'localImage'].includes(input.type));
  if (!session || session.saving || props.editing || props.editDisabled ||
      (!session.draft.trim() && !hasImage) || !props.editMessage) return;
  session.saving = true;
  session.error = '';
  try {
    await props.editMessage(session.itemId, session.draft);
    if (editSession.value === session) {
      editSession.value = null;
      editingItem.value = null;
    }
  } catch (cause: any) {
    session.error = cause?.message || '重新发送失败，请重试。';
  } finally {
    session.saving = false;
  }
}
const blocks = computed(() =>
  conversationBlocks(props.items, props.turns).map((block) =>
    block.kind === "message"
      ? block
      : { ...block, ...turnPresentation(block.items) },
  ),
);
const finishedTurns = reactive(new Set<string>());
const runningTurnId = computed(() => {
  if (!props.busy) return null;
  const latest = blocks.value.filter((block) => block.kind === "turn").at(-1);
  if (!latest || latest.kind !== "turn" || finishedTurns.has(latest.id)) return null;
  return !latest.turn?.status || latest.turn.status === "inProgress"
    ? latest.id
    : null;
});
// An idle notification can end work before its turn-completed metadata arrives.
// A later busy notification belongs to new work, so keep the old turn settled.
watch(runningTurnId, (current, previous) => {
  if (previous && previous !== current) finishedTurns.add(previous);
}, { flush: "sync" });
function running(block: any) {
  return block.id === runningTurnId.value;
}
function activityLabel(block: any) {
  const prefix =
    block.turn?.status === "failed"
      ? "执行失败 · "
      : block.turn?.status === "interrupted"
        ? "已停止 · "
        : "";
  return prefix + elapsedLabel(block.turn);
}
</script>

<template>
  <template v-for="block in blocks" :key="block.id">
    <ChatItem
      v-if="block.kind === 'message'"
      :item="block.item"
      :busy="busy"
      :can-fork="!busy && !editing && !!block.item.turnId"
      :can-edit="!editSession && block.item.id === editableItemId"
      :editing="editing"
      :edit-disabled="editDisabled"
      :edit-session="editSession"
      :begin-edit="beginEdit"
      :cancel-edit="cancelEdit"
      :save-edit="saveEdit"
      @fork="emit('fork', $event)"
      @open-file="emit('openFile', $event)"
      @error="emit('error', $event)"
    />
    <section v-else class="conversation-turn" :data-turn-id="block.id">
      <ChatItem
        v-for="item in block.users"
        :key="item.id"
        :item="item"
        :busy="running(block)"
        :can-fork="!busy && !editing && !!item.turnId"
        :can-edit="!editSession && item.id === editableItemId"
        :editing="editing"
        :edit-disabled="editDisabled"
        :edit-session="editSession"
        :begin-edit="beginEdit"
        :cancel-edit="cancelEdit"
        :save-edit="saveEdit"
        @fork="emit('fork', $event)"
        @open-file="emit('openFile', $event)"
        @error="emit('error', $event)"
      />
      <details
        v-if="
          block.activity.length ||
          running(block) ||
          block.turn?.durationMs != null ||
          block.turn?.completedAt != null ||
          ['failed', 'interrupted'].includes(block.turn?.status)
        "
        class="turn-activity"
        :open="running(block)"
      >
        <summary
          :aria-label="
            running(block) ? '工作过程（运行中）' : '工作过程与用时'
          "
        >
          <span v-if="running(block)" class="thinking-dot"></span>
          <span>{{
            running(block) ? "正在处理…" : activityLabel(block)
          }}</span>
          <Icon name="ChevronRight" :size="14" />
        </summary>
        <div v-if="block.activity.length" class="turn-activity-content">
          <ChatItem
            v-for="item in block.activity"
            :key="item.id"
            :item="item"
            :busy="running(block)"
            :can-fork="false"
            @open-file="emit('openFile', $event)"
            @error="emit('error', $event)"
          />
        </div>
        <p v-else class="activity-empty">
          {{
            running(block)
              ? "正在等待新的进展。"
              : "此轮没有额外的过程记录。"
          }}
        </p>
      </details>
      <p v-if="block.turn?.error?.message" class="turn-error" role="alert">
        {{ block.turn.error.message }}
      </p>
      <ChatItem
        v-for="item in block.answers"
        :key="item.id"
        :item="item"
        :busy="running(block)"
        :can-fork="!busy && !editing && !!item.turnId"
        @fork="emit('fork', $event)"
        @open-file="emit('openFile', $event)"
        @error="emit('error', $event)"
      />
      <ChatItem
        v-for="item in block.dividers"
        :key="item.id"
        :item="item"
        @open-file="emit('openFile', $event)"
        @error="emit('error', $event)"
      />
    </section>
  </template>
  <!-- Revert removes the original turn before the replacement starts. Keep
       the editor mounted at the history tail so failures retain the draft. -->
  <ChatItem
    v-if="editSession && editingItem && !items.some((item) => item.id === editSession?.itemId)"
    :item="editingItem"
    :editing="editing"
    :edit-disabled="editDisabled"
    :edit-session="editSession"
    :cancel-edit="cancelEdit"
    :save-edit="saveEdit"
    @open-file="emit('openFile', $event)"
    @error="emit('error', $event)"
  />
  <div
    v-if="
      busy &&
      !blocks.some(
        (block) => block.kind === 'turn' && running(block),
      )
    "
    class="working-indicator"
  >
    <span class="thinking-dot"></span>Codex 正在工作
  </div>
</template>

<style scoped>
.conversation-turn {
  min-width: 0;
}
.turn-activity {
  margin: 8px 0 18px;
  color: var(--muted);
}
.turn-activity > summary {
  display: flex;
  align-items: center;
  gap: 7px;
  width: fit-content;
  min-height: 32px;
  list-style: none;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.6;
  user-select: none;
}
.turn-activity > summary::-webkit-details-marker {
  display: none;
}
.turn-activity > summary:hover {
  color: var(--text);
}
.turn-activity[open] > summary svg {
  transform: rotate(90deg);
}
.turn-activity-content {
  margin: 4px 0 16px;
  padding: 12px 14px;
  border-left: 1px solid var(--border);
}
.turn-activity-content :deep(.agent-message) {
  color: var(--muted);
  font-size: 13px;
}
.turn-activity-content :deep(.message:last-child) {
  margin-bottom: 0;
}
.activity-empty {
  margin: 4px 0 12px;
  font-size: 12px;
}
.turn-error {
  margin: 8px 0 18px;
  color: var(--red);
  font-size: 13px;
}
@media (max-width: 760px) {
  .turn-activity > summary {
    min-height: 40px;
    font-size: 12px;
  }
  .turn-activity-content {
    padding: 10px 12px;
  }
}
</style>
