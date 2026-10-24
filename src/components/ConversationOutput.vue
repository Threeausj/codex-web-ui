<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import VirtualTimeline from "./VirtualTimeline.vue";
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
import { messageEditDraft, releaseEditAttachments, uploadedEditAttachments, type MessageEditAttachment, type MessageEditSession } from '../lib/message-edit';
import { uniqueClipboardFiles } from '../lib/clipboard';
import { conversationTimelineRows, type ConversationTimelineRow } from '../lib/conversation-timeline';
import type { ReadingPosition } from '../lib/reading-positions';
import { captureConversationReading, nearConversationBottom } from '../lib/conversation-reading';

const props = defineProps<{
  items: DisplayItem[];
  turns: any[];
  busy: boolean;
  hideFork?: boolean;
  forkDisabled?: boolean;
  hostId?: string;
  threadId?: string;
  cwd?: string;
  editableItemId?: string;
  editing?: boolean;
  editDisabled?: boolean;
  editMessage?: (itemId: string, text: string, attachments?: MessageEditAttachment[]) => Promise<void>;
  uploadEditFiles?: (itemId: string, files: File[]) => Promise<any[]>;
  cancelMessageEdit?: (itemId: string) => void;
  loadTurnDetails?: (turnId: string) => Promise<void>;
  asyncQuestionStatus?: (item: any, threadId?: string, hostId?: string) => 'pending' | 'sending' | 'answered' | 'uncertain';
  answerAsyncQuestion?: (item: any, answers: string[], threadId?: string, hostId?: string) => Promise<void>;
  asyncQuestionsDisabled?: boolean;
  loadToolOutput?: (item: DisplayItem) => Promise<string>;
}>();
const emit = defineEmits<{
  fork: [turnId?: string];
  openFile: [path: string, line?: number];
  error: [message: string];
  editSessionActive: [active: boolean];
  retainTurns: [value: { hostId?: string; threadId?: string; turnIds: string[] }];
}>();
const editSession = ref<MessageEditSession | null>(null);
const editingItem = ref<DisplayItem | null>(null);
watch(() => !!editSession.value, active => emit('editSessionActive', active), { flush: 'sync' });
function clearEdit() {
  if (editSession.value) releaseEditAttachments(editSession.value.attachments);
  editSession.value = null;
  editingItem.value = null;
}
onBeforeUnmount(() => { clearEdit(); emit('editSessionActive', false); });
function beginEdit(item: DisplayItem, text: string) {
  if (props.editDisabled || props.editing || !props.editMessage ||
      item.id !== props.editableItemId || editSession.value) return;
  editingItem.value = { ...item };
  const draft = messageEditDraft(item, text);
  editSession.value = { itemId: item.id, draft: draft.text, attachments: draft.attachments, error: '', saving: false, uploading: 0 };
}
function cancelEdit() {
  const session = editSession.value;
  if (!session || session.saving || props.editing) return;
  props.cancelMessageEdit?.(session.itemId);
  clearEdit();
}
async function uploadEdit(files: File[], clipboard = false) {
  const session = editSession.value;
  if (!session || session.saving || props.editing || props.editDisabled || !props.uploadEditFiles) return;
  session.uploading++;
  session.error = '';
  try {
    const selected = clipboard ? await uniqueClipboardFiles(files) : files;
    if (session !== editSession.value || session.saving || props.editing || props.editDisabled || !selected.length) return;
    const uploaded = uploadedEditAttachments(await props.uploadEditFiles(session.itemId, selected));
    if (session !== editSession.value) { releaseEditAttachments(uploaded); return; }
    session.attachments.push(...uploaded);
  } catch (cause: any) {
    if (session === editSession.value) session.error = cause?.message || '附件上传失败，请重试。';
  } finally { session.uploading--; }
}
function removeEditAttachment(index: number) {
  const session = editSession.value;
  if (!session || session.saving || session.uploading || props.editing || props.editDisabled) return;
  releaseEditAttachments(session.attachments.splice(index, 1));
}
async function saveEdit() {
  const session = editSession.value;
  if (!session || session.saving || session.uploading || props.editing || props.editDisabled ||
      (!session.draft.trim() && !session.attachments.length) || !props.editMessage) return;
  session.saving = true;
  session.error = '';
  try {
    await props.editMessage(session.itemId, session.draft, session.attachments);
    if (editSession.value === session) clearEdit();
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
const disclosures = provideHistoryDisclosures();
const expandedTurns = reactive(new Set<string>());
const revealedItemId = ref('');
let bookmarkRevealTurn = '';
async function revealItem(itemId: string, turnId: string) {
  revealedItemId.value = itemId;
  bookmarkRevealTurn = turnId;
  expandedTurns.add(turnId);
  await nextTick();
  if (virtualActivated.value) await timeline.value?.revealItem(itemId);
}
const timeline = ref<InstanceType<typeof VirtualTimeline>>();
const location = ref<HTMLElement>();
const initialReading = ref<ReadingPosition | null>(null);
const virtualActivated = ref(false);
async function restoreReading(position: ReadingPosition) { if (virtualActivated.value) await timeline.value?.restoreReading(position); }
function scrollToLatest() { if (virtualActivated.value) timeline.value?.scrollToLatest(); }
function refreshVirtual() { if (virtualActivated.value) timeline.value?.refresh(); }
defineExpose({ revealItem, restoreReading, scrollToLatest, refreshVirtual, isVirtual: virtualActivated });
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
  // A restored/cached turn may already be running when this component mounts.
  // Populate the same state used to render its content, rather than waiting for
  // the browser's asynchronous details toggle event to reveal it.
  if (current) {
    expandedTurns.add(current);
    ensureDetails(current);
  }
}, { flush: "sync", immediate: true });
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
const manuallyClosedBatches = reactive(new Set<string>());
function batchExpanded(entry: any, running: boolean) {
  return running ? !manuallyClosedBatches.has(entry.id) : disclosures.batches.has(entry.items[0]?.id || '');
}
const rows = computed(() => conversationTimelineRows(blocks.value, {
  runningTurnId: runningTurnId.value, expanded: expandedTurns, batchExpanded,
  detailState: id => detailLoads.get(id),
}));
watch(() => rows.value.length, count => {
  if (count > 80 && !virtualActivated.value) {
    const viewport = location.value?.closest<HTMLElement>('.conversation-scroll, .side-chat-transcript');
    if (viewport) initialReading.value = captureConversationReading(viewport, nearConversationBottom(viewport));
    virtualActivated.value = true;
  }
}, { immediate: true, flush: 'sync' });
const pinnedRows = computed(() => rows.value.filter(row => row.item && (row.item.id === revealedItemId.value || row.item.id === editSession.value?.itemId ||
  !!props.answerAsyncQuestion && asyncUserInputQuestions(row.item).length > 0 && props.asyncQuestionStatus?.(row.item, props.threadId, props.hostId) !== 'answered')).map(row => row.id));
function toggleVirtualTurn(row: ConversationTimelineRow) {
  if (!row.turnId) return;
  if (expandedTurns.has(row.turnId)) { expandedTurns.delete(row.turnId); if (bookmarkRevealTurn === row.turnId) bookmarkRevealTurn = ''; }
  else { expandedTurns.add(row.turnId); ensureDetails(row.turnId); }
}
function toggleVirtualBatch(row: ConversationTimelineRow) {
  if (row.running) {
    if (manuallyClosedBatches.has(row.id)) manuallyClosedBatches.delete(row.id);
    else manuallyClosedBatches.add(row.id);
  } else {
    const id = row.items?.[0]?.id || '';
    if (disclosures.batches.has(id)) disclosures.batches.delete(id); else disclosures.batches.add(id);
  }
}
function itemBindings(row: ConversationTimelineRow) {
  const item = row.item!;
  return { item, hostId: props.hostId, threadId: props.threadId, cwd: props.cwd,
    busy: row.running ?? props.busy, collapseTools: row.nested,
    asyncQuestionStatus: props.asyncQuestionStatus, answerAsyncQuestion: props.answerAsyncQuestion, asyncQuestionsDisabled: props.asyncQuestionsDisabled, loadToolOutput: props.loadToolOutput,
    canFork: !props.hideFork && !props.forkDisabled && !props.editing && !!item.turnId && (item.type === 'userMessage' || item.type === 'agentMessage' && row.output),
    canEdit: !editSession.value && item.id === props.editableItemId, editing: props.editing, editDisabled: props.editDisabled,
    editSession: editSession.value, beginEdit, cancelEdit, saveEdit, uploadEdit, removeEditAttachment };
}
watch(() => [[...expandedTurns], editSession.value?.itemId, revealedItemId.value], () => {
  const protectedIds = new Set(expandedTurns);
  if (editSession.value?.itemId) { const turn = props.items.find(item => item.id === editSession.value!.itemId)?.turnId; if (turn) protectedIds.add(turn); }
  if (bookmarkRevealTurn) protectedIds.add(bookmarkRevealTurn);
  emit('retainTurns', { hostId: props.hostId, threadId: props.threadId, turnIds: [...protectedIds] });
}, { immediate: true, flush: 'sync' });
const retainedThreadId = props.threadId;
const retainedHostId = props.hostId;
onBeforeUnmount(() => emit('retainTurns', { hostId: retainedHostId, threadId: retainedThreadId, turnIds: [] }));
</script>

<template>
  <span ref="location" class="timeline-location" aria-hidden="true"></span>
  <VirtualTimeline v-if="virtualActivated" ref="timeline" :rows="rows" :pinned-ids="pinnedRows" :initial-reading="initialReading" v-slot="{ row }">
    <ChatItem v-if="row.kind === 'item'" v-bind="itemBindings(row)"
      :class="{ 'virtual-activity-item': row.activity, 'virtual-nested-item': row.nested, 'timeline-output': row.output }"
      @fork="emit('fork', $event)" @open-file="(path, line) => emit('openFile', path, line)" @error="emit('error', $event)" />
    <button v-else-if="row.kind === 'turn'" type="button" class="virtual-turn-toggle"
      :aria-label="row.running ? '工作过程（运行中）' : '工作过程与用时'" :aria-expanded="row.expanded" @click="toggleVirtualTurn(row)">
      <span v-if="row.running" class="thinking-dot"></span><span>{{ row.label }}</span><Icon name="ChevronRight" :size="14" :class="{ 'virtual-expanded': row.expanded }" />
    </button>
    <button v-else-if="row.kind === 'batch'" type="button" class="virtual-batch-toggle" :class="{ 'activity-batch-failed': row.failed }" :aria-expanded="row.expanded" @click="toggleVirtualBatch(row)">
      <Icon :name="row.running ? 'LoaderCircle' : 'ListChecks'" :size="16" :class="{ spin: row.running }" /><span>{{ row.label }}</span>
      <small v-if="row.status">{{ row.status }}</small><Icon name="ChevronDown" :size="13" :class="{ 'virtual-expanded': row.expanded }" />
    </button>
    <div v-else-if="row.kind === 'load'" class="virtual-load-state">
      <p v-if="row.loading" class="activity-loading" role="status"><Icon name="LoaderCircle" :size="14" class="spin" />正在加载过程记录…</p>
      <div v-if="row.error" class="activity-load-error" role="alert"><span>{{ row.error }}</span><button class="button button-small button-secondary" @click="loadDetails(row.turnId!)">重试加载过程</button></div>
      <button v-if="row.hasMore && props.loadTurnDetails" class="button button-small button-secondary activity-load-more" @click="loadDetails(row.turnId!)">{{ row.label }}</button>
    </div>
    <p v-else-if="row.kind === 'error'" class="turn-error" role="alert">{{ row.text }}</p>
    <p v-else :class="row.kind === 'note' ? 'bookmark-fragment-label' : 'activity-empty'">{{ row.text }}</p>
  </VirtualTimeline>
  <template v-else>
  <div v-for="block in blocks" :key="block.id" :data-history-id="block.id">
    <p v-if="block.kind === 'turn' && block.turn?.historyBookmarkTarget" class="bookmark-fragment-label">收藏所在历史片段</p>
    <ChatItem
      v-if="block.kind === 'message'"
      :host-id="hostId" :cwd="cwd" :thread-id="threadId"
      :load-tool-output="loadToolOutput" :async-question-status="asyncQuestionStatus" :answer-async-question="answerAsyncQuestion" :async-questions-disabled="asyncQuestionsDisabled"
      :item="block.item"
      :busy="busy"
      :can-fork="!hideFork && !forkDisabled && !editing && !!block.item.turnId"
      :can-edit="!editSession && block.item.id === editableItemId"
      :editing="editing"
      :edit-disabled="editDisabled"
      :edit-session="editSession"
      :begin-edit="beginEdit"
      :cancel-edit="cancelEdit"
      :save-edit="saveEdit"
      :upload-edit="uploadEdit"
      :remove-edit-attachment="removeEditAttachment"
      @fork="emit('fork', $event)"
      @open-file="(path, line) => emit('openFile', path, line)"
      @error="emit('error', $event)"
    />
    <section v-else class="conversation-turn" :data-turn-id="block.id">
      <template v-for="(segment, segmentIndex) in block.segments" :key="segment.id">
      <ChatItem
        v-for="item in segment.users"
        :key="item.id"
        :host-id="hostId" :cwd="cwd" :thread-id="threadId"
        :load-tool-output="loadToolOutput" :async-question-status="asyncQuestionStatus" :answer-async-question="answerAsyncQuestion" :async-questions-disabled="asyncQuestionsDisabled"
        :item="item"
        :busy="running(block)"
        :can-fork="!hideFork && !forkDisabled && !editing && !!item.turnId"
        :can-edit="!editSession && item.id === editableItemId"
        :editing="editing"
        :edit-disabled="editDisabled"
        :edit-session="editSession"
        :begin-edit="beginEdit"
        :cancel-edit="cancelEdit"
        :save-edit="saveEdit"
        :upload-edit="uploadEdit"
        :remove-edit-attachment="removeEditAttachment"
        @fork="emit('fork', $event)"
        @open-file="(path, line) => emit('openFile', path, line)"
        @error="emit('error', $event)"
      />
      <component
        :is="segmentIndex === 0 ? 'details' : 'div'"
        v-if="segmentIndex === 0 ? (
          block.activity.length ||
          block.turn?.historySummary ||
          running(block) ||
          block.turn?.durationMs != null ||
          block.turn?.completedAt != null ||
          ['failed', 'interrupted'].includes(block.turn?.status)
        ) : segment.activity.length || (segment.dividers.length && expandedTurns.has(block.id))"
        :class="segmentIndex === 0 ? 'turn-activity' : 'turn-segment-activity'"
        @toggle="segmentIndex === 0 && toggleTurn($event, block.id)"
        :open="expandedTurns.has(block.id)"
      >
        <summary
          v-if="segmentIndex === 0"
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
          <p v-if="segmentIndex === 0 && detailLoads.get(block.id)?.loading" class="activity-loading" role="status"><Icon name="LoaderCircle" :size="14" class="spin" />正在加载过程记录…</p>
          <div v-if="segmentIndex === 0 && detailLoads.get(block.id)?.error" class="activity-load-error" role="alert">
            <span>{{ detailLoads.get(block.id)?.error }}</span>
            <button class="button button-small button-secondary" @click="loadDetails(block.id)">重试加载过程</button>
          </div>
          <template v-for="entry in segment.dividers.length ? segment.timelineBlocks : segment.activityBlocks" :key="entry.id">
            <ActivityBatch
              v-if="entry.kind === 'batch'"
              :host-id="hostId" :thread-id="threadId" :cwd="cwd"
              :items="entry.items"
              :load-tool-output="loadToolOutput"
              :busy="running(block)"
              @open-file="(path, line) => emit('openFile', path, line)"
              @error="emit('error', $event)"
            />
            <ChatItem
              v-else
              :host-id="hostId" :cwd="cwd" :thread-id="threadId"
              :load-tool-output="loadToolOutput" :async-question-status="asyncQuestionStatus" :answer-async-question="answerAsyncQuestion" :async-questions-disabled="asyncQuestionsDisabled"
              :item="entry.item"
              :class="{ 'timeline-output': segment.outputs.some(item => item.id === entry.id) }"
              :busy="running(block)"
              :can-fork="!hideFork && !forkDisabled && entry.item.type === 'agentMessage' && block.answers.some(item => item.id === entry.id) && !editing && !!entry.item.turnId"
              @fork="emit('fork', $event)"
              @open-file="(path, line) => emit('openFile', path, line)"
              @error="emit('error', $event)"
            />
          </template>
          <button v-if="segmentIndex === 0 && block.turn?.historySummary && props.loadTurnDetails && !detailLoads.get(block.id)?.loading && !detailLoads.get(block.id)?.error" class="button button-small button-secondary activity-load-more" @click="loadDetails(block.id)">{{ block.turn.historyItemsStarted ? '加载更多过程记录' : '加载过程记录' }}</button>
          <p v-if="segmentIndex === 0 && !block.activity.length && !block.turn?.historySummary && !detailLoads.get(block.id)?.loading" class="activity-empty">{{ running(block) ? '正在等待新的进展。' : '此轮没有额外的过程记录。' }}</p>
        </div>
      </component>
      <ChatItem
        v-for="item in segment.dividers.length && expandedTurns.has(block.id) ? [] : segment.outputs"
        :key="item.id"
        :host-id="hostId" :cwd="cwd" :thread-id="threadId"
        :load-tool-output="loadToolOutput" :async-question-status="asyncQuestionStatus" :answer-async-question="answerAsyncQuestion" :async-questions-disabled="asyncQuestionsDisabled"
        :item="item"
        :busy="running(block)"
        :can-fork="!hideFork && !forkDisabled && item.type === 'agentMessage' && !editing && !!item.turnId"
        @fork="emit('fork', $event)"
        @open-file="(path, line) => emit('openFile', path, line)"
        @error="emit('error', $event)"
      />
      </template>
      <p v-if="block.turn?.error?.message" class="turn-error" role="alert">
        {{ block.turn.error.message }}
      </p>
    </section>
  </div>
  </template>
  <!-- Revert removes the original turn before the replacement starts. Keep
       the editor mounted at the history tail so failures retain the draft. -->
  <ChatItem
    v-if="editSession && editingItem && !items.some((item) => item.id === editSession?.itemId)"
    :host-id="hostId" :cwd="cwd" :thread-id="threadId"
    :load-tool-output="loadToolOutput" :async-question-status="asyncQuestionStatus" :answer-async-question="answerAsyncQuestion" :async-questions-disabled="asyncQuestionsDisabled"
    :item="editingItem"
    :editing="editing"
    :edit-disabled="editDisabled"
    :edit-session="editSession"
    :cancel-edit="cancelEdit"
    :save-edit="saveEdit"
    :upload-edit="uploadEdit"
    :remove-edit-attachment="removeEditAttachment"
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
.timeline-location { display: none; }
.virtual-turn-toggle, .virtual-batch-toggle { display: flex; align-items: center; gap: 7px; width: fit-content; max-width: 100%; min-height: 40px; margin: 4px 0 12px; padding: 0; border: 0; background: transparent; color: var(--muted); font-size: 12px; line-height: 1.6; cursor: pointer; text-align: left; }
.virtual-turn-toggle:hover, .virtual-batch-toggle:hover { color: var(--text); }
.virtual-turn-toggle .virtual-expanded { transform: rotate(90deg); }
.virtual-batch-toggle { width: 100%; margin: 4px 0; gap: 8px; }
.virtual-batch-toggle > span { flex: 1; }
.virtual-batch-toggle > small { font-size: 10px; white-space: nowrap; }
.virtual-batch-toggle > svg:last-child { transform: rotate(-90deg); }
.virtual-batch-toggle > svg.virtual-expanded:last-child { transform: rotate(0); }
.virtual-batch-toggle.activity-batch-failed > small { color: var(--red); }
.virtual-nested-item { margin-left: 24px; }
.virtual-activity-item:deep(.agent-message), .virtual-activity-item.agent-message { color: var(--muted); font-size: 13px; }
.virtual-activity-item.timeline-output { color: var(--text); font-size: 14px; }
.virtual-load-state { margin: 4px 0; }
@media (max-width: 760px) { .virtual-nested-item { margin-left: 12px; } }
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
