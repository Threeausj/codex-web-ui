<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import VirtualHistoryBlock from "./VirtualHistoryBlock.vue";
import { provideHistoryDisclosures } from "../lib/history-disclosures";
import ChatItem from "./ChatItem.vue";
import ActivityBatch from './ActivityBatch.vue';
import Icon from "./Icon.vue";
import {
  conversationBlocks,
  elapsedLabel,
  turnPresentation,
} from "../lib/presentation";
import type { DisplayItem } from "../lib/events";
import { asyncUserInputQuestions } from '../../shared/async-user-input';

const props = defineProps<{
  items: DisplayItem[];
  turns: any[];
  busy: boolean;
  hideFork?: boolean;
  hostId?: string;
  threadId?: string;
  cwd?: string;
  editableItemId?: string;
  editing?: boolean;
  editDisabled?: boolean;
  editMessage?: (itemId: string, text: string) => Promise<void>;
  cancelMessageEdit?: (itemId: string) => void;
  loadTurnDetails?: (turnId: string) => Promise<void>;
  asyncQuestionStatus?: (item: any, threadId?: string, hostId?: string) => 'pending' | 'sending' | 'answered' | 'uncertain';
  answerAsyncQuestion?: (item: any, answers: string[], threadId?: string, hostId?: string) => Promise<void>;
  asyncQuestionsDisabled?: boolean;
}>();
const emit = defineEmits<{
  fork: [turnId?: string];
  openFile: [path: string, line?: number];
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
provideHistoryDisclosures();
const expandedTurns = reactive(new Set<string>());
const revealedItemId = ref('');
let bookmarkRevealTurn = '';
async function revealItem(itemId: string, turnId: string) {
  revealedItemId.value = itemId;
  bookmarkRevealTurn = turnId;
  expandedTurns.add(turnId);
  await nextTick();
}
defineExpose({ revealItem });
const detailLoads = reactive(new Map<string, { loading: boolean; error: string }>());
async function loadDetails(id: string) {
  if (!props.loadTurnDetails || detailLoads.get(id)?.loading) return;
  const status = reactive({ loading: true, error: '' });
  detailLoads.set(id, status);
  try { await props.loadTurnDetails(id); }
  catch (error: any) { status.error = error?.message || '无法读取过程记录，请重试。'; }
  finally { status.loading = false; }
}
function ensureDetails(id: string) {
  if (id === bookmarkRevealTurn) return;
  const turn = props.turns.find(turn => turn.id === id);
  if (turn?.historySummary && !turn.historyItemsStarted && !detailLoads.get(id)?.error)
    void loadDetails(id);
}
function toggleTurn(event: Event, id: string) {
  if ((event.currentTarget as HTMLDetailsElement).open) { expandedTurns.add(id); ensureDetails(id); }
  else { expandedTurns.delete(id); if (bookmarkRevealTurn === id) bookmarkRevealTurn = ''; }
}
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
  if (previous && previous !== current) {
    finishedTurns.add(previous);
    // Automatic live expansion is not an instruction to keep a finished turn
    // open. Explicitly opened older turns still survive virtual unmounts.
    expandedTurns.delete(previous);
  }
}, { flush: "sync" });
function running(block: any) {
  return block.id === runningTurnId.value;
}
watch(() => props.turns.map(turn => [turn.id, turn.historySummary, turn.historyItemsStarted]), () => {
  for (const id of expandedTurns) ensureDetails(id);
}, { flush: 'post' });
function activityLabel(block: any) {
  const prefix =
    block.turn?.status === "failed"
      ? "执行失败 · "
      : block.turn?.status === "interrupted"
        ? "已停止 · "
        : "";
  return prefix + elapsedLabel(block.turn);
}
function hasPendingQuestion(block: any) {
  const items = block.kind === 'message' ? [block.item] : block.items;
  return !!props.answerAsyncQuestion && items.some((item: any) => asyncUserInputQuestions(item).length > 0 &&
    props.asyncQuestionStatus?.(item, props.threadId, props.hostId) !== 'answered');
}
</script>

<template>
  <VirtualHistoryBlock v-for="(block, index) in blocks" :key="block.id" :data-history-id="block.id" :enabled="blocks.length > 80" :pinned="index >= blocks.length - 2 || running(block) || hasPendingQuestion(block) || (block.kind === 'message' ? block.item.id === revealedItemId : block.items.some(item => item.id === revealedItemId)) || !!editSession && (block.kind === 'message' ? block.item.id === editSession.itemId : block.items.some(item => item.id === editSession?.itemId))">
    <p v-if="block.kind === 'turn' && block.turn?.historyBookmarkTarget" class="bookmark-fragment-label">收藏所在历史片段</p>
    <ChatItem
      v-if="block.kind === 'message'"
      :host-id="hostId" :cwd="cwd" :thread-id="threadId"
      :async-question-status="asyncQuestionStatus" :answer-async-question="answerAsyncQuestion" :async-questions-disabled="asyncQuestionsDisabled"
      :item="block.item"
      :busy="busy"
      :can-fork="!hideFork && !busy && !editing && !!block.item.turnId"
      :can-edit="!editSession && block.item.id === editableItemId"
      :editing="editing"
      :edit-disabled="editDisabled"
      :edit-session="editSession"
      :begin-edit="beginEdit"
      :cancel-edit="cancelEdit"
      :save-edit="saveEdit"
      @fork="emit('fork', $event)"
      @open-file="(path, line) => emit('openFile', path, line)"
      @error="emit('error', $event)"
    />
    <section v-else class="conversation-turn" :data-turn-id="block.id">
      <ChatItem
        v-for="item in block.users"
        :key="item.id"
        :host-id="hostId" :cwd="cwd" :thread-id="threadId"
        :async-question-status="asyncQuestionStatus" :answer-async-question="answerAsyncQuestion" :async-questions-disabled="asyncQuestionsDisabled"
        :item="item"
        :busy="running(block)"
        :can-fork="!hideFork && !busy && !editing && !!item.turnId"
        :can-edit="!editSession && item.id === editableItemId"
        :editing="editing"
        :edit-disabled="editDisabled"
        :edit-session="editSession"
        :begin-edit="beginEdit"
        :cancel-edit="cancelEdit"
        :save-edit="saveEdit"
        @fork="emit('fork', $event)"
        @open-file="(path, line) => emit('openFile', path, line)"
        @error="emit('error', $event)"
      />
      <details
        v-if="
          block.activity.length ||
          block.turn?.historySummary ||
          running(block) ||
          block.turn?.durationMs != null ||
          block.turn?.completedAt != null ||
          ['failed', 'interrupted'].includes(block.turn?.status)
        "
        class="turn-activity"
        @toggle="toggleTurn($event, block.id)"
        :open="running(block) || expandedTurns.has(block.id)"
      >
        <summary
          :title="block.turn?.historySummary ? '展开查看完整过程和补充消息' : undefined"
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
        <div v-if="expandedTurns.has(block.id)" class="turn-activity-content">
          <p v-if="detailLoads.get(block.id)?.loading" class="activity-loading" role="status"><Icon name="LoaderCircle" :size="14" class="spin" />正在加载过程记录…</p>
          <div v-if="detailLoads.get(block.id)?.error" class="activity-load-error" role="alert">
            <span>{{ detailLoads.get(block.id)?.error }}</span>
            <button class="button button-small button-secondary" @click="loadDetails(block.id)">重试加载过程</button>
          </div>
          <template v-for="entry in block.dividers.length ? block.timelineBlocks : block.activityBlocks" :key="entry.id">
            <ActivityBatch
              v-if="entry.kind === 'batch'"
              :host-id="hostId" :cwd="cwd"
              :items="entry.items"
              :busy="running(block)"
              @open-file="(path, line) => emit('openFile', path, line)"
              @error="emit('error', $event)"
            />
            <ChatItem
              v-else
              :host-id="hostId" :cwd="cwd" :thread-id="threadId"
              :async-question-status="asyncQuestionStatus" :answer-async-question="answerAsyncQuestion" :async-questions-disabled="asyncQuestionsDisabled"
              :item="entry.item"
              :class="{ 'timeline-output': block.outputs.some(item => item.id === entry.id) }"
              :busy="running(block)"
              :can-fork="!hideFork && entry.item.type === 'agentMessage' && block.answers.some(item => item.id === entry.id) && !busy && !editing && !!entry.item.turnId"
              @fork="emit('fork', $event)"
              @open-file="(path, line) => emit('openFile', path, line)"
              @error="emit('error', $event)"
            />
          </template>
          <button v-if="block.turn?.historySummary && props.loadTurnDetails && !detailLoads.get(block.id)?.loading && !detailLoads.get(block.id)?.error" class="button button-small button-secondary activity-load-more" @click="loadDetails(block.id)">{{ block.turn.historyItemsStarted ? '加载更多过程记录' : '加载过程记录' }}</button>
          <p v-if="!block.activity.length && !block.turn?.historySummary && !detailLoads.get(block.id)?.loading" class="activity-empty">{{ running(block) ? '正在等待新的进展。' : '此轮没有额外的过程记录。' }}</p>
        </div>
      </details>
      <p v-if="block.turn?.error?.message" class="turn-error" role="alert">
        {{ block.turn.error.message }}
      </p>
      <ChatItem
        v-for="item in block.dividers.length && expandedTurns.has(block.id) ? [] : block.outputs"
        :key="item.id"
        :host-id="hostId" :cwd="cwd" :thread-id="threadId"
        :async-question-status="asyncQuestionStatus" :answer-async-question="answerAsyncQuestion" :async-questions-disabled="asyncQuestionsDisabled"
        :item="item"
        :busy="running(block)"
        :can-fork="!hideFork && item.type === 'agentMessage' && !busy && !editing && !!item.turnId"
        @fork="emit('fork', $event)"
        @open-file="(path, line) => emit('openFile', path, line)"
        @error="emit('error', $event)"
      />
    </section>
  </VirtualHistoryBlock>
  <!-- Revert removes the original turn before the replacement starts. Keep
       the editor mounted at the history tail so failures retain the draft. -->
  <ChatItem
    v-if="editSession && editingItem && !items.some((item) => item.id === editSession?.itemId)"
    :host-id="hostId" :cwd="cwd" :thread-id="threadId"
    :async-question-status="asyncQuestionStatus" :answer-async-question="answerAsyncQuestion" :async-questions-disabled="asyncQuestionsDisabled"
    :item="editingItem"
    :editing="editing"
    :edit-disabled="editDisabled"
    :edit-session="editSession"
    :cancel-edit="cancelEdit"
    :save-edit="saveEdit"
    @open-file="(path, line) => emit('openFile', path, line)"
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
.bookmark-fragment-label { margin: 12px 0; color: var(--muted); font-size: 12px; }
.activity-loading { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.activity-load-error { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--danger); font-size: 12px; }
.activity-load-more { margin: 8px 0; }
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
  padding: 0;
}
.turn-activity-content :deep(.agent-message) {
  color: var(--muted);
  font-size: 13px;
}
.turn-activity-content :deep(.agent-message.timeline-output) {
  color: var(--text);
  font-size: 14px;
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
    padding: 0;
  }
}
</style>
