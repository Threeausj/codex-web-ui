<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import ApprovalCard from './ApprovalCard.vue';
import ConversationOutput from './ConversationOutput.vue';
import { conversationSelectionKey } from '../lib/conversation-selection';

const props = defineProps<{ controller: any; api: any; mainState: any }>();
const emit = defineEmits<{ openFile: [path: string, line?: number]; quote: [value: any] }>();
const state = computed(() => props.controller.state);
const question = ref('');
const questionField = ref<HTMLTextAreaElement>();
const transcript = ref<HTMLElement>();
const localError = ref('');
const closing = ref(false);
const synchronizing = ref(false);
const recoveryId = ref('');
const followTail = ref(true);
const sourceKey = computed(() => conversationSelectionKey(state.value.source));
const requests = computed(() => state.value.threadId && state.value.source?.hostId === props.mainState.hostId
  ? (props.mainState.pendingRequests || []).filter((request: any) => (request.params?.threadId || request.params?.conversationId) === state.value.threadId)
  : []);
const sendDisabled = computed(() => !question.value.trim() || question.value.length > 16_000 || state.value.busy || state.value.loading || !state.value.connected || closing.value);
const error = computed(() => localError.value || state.value.error);
function focusQuestion() { void nextTick(() => questionField.value?.focus()); }
defineExpose({ focusQuestion });
onMounted(() => { if (state.value.open) focusQuestion(); });
watch(sourceKey, () => {
  question.value = '';
  localError.value = '';
  followTail.value = true;
  if (state.value.open) focusQuestion();
});
watch(() => state.value.open, open => { if (open) focusQuestion(); });
function onScroll() {
  const element = transcript.value;
  if (element) followTail.value = element.scrollHeight - element.clientHeight - element.scrollTop < 80;
}
watch(() => [state.value.items, state.value.turns, state.value.busy, requests.value.length], () => {
  if (!followTail.value) return;
  void nextTick(() => { if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight; });
}, { deep: true });
async function send() {
  if (sendDisabled.value) return;
  const draft = question.value;
  const key = sourceKey.value;
  localError.value = '';
  try {
    await props.controller.send(draft.trim());
    if (sourceKey.value === key && question.value === draft) question.value = '';
    followTail.value = true;
    focusQuestion();
  } catch (cause: any) {
    if (sourceKey.value === key) localError.value = cause?.message || '发送失败，请重试。';
  }
}
function onQuestionKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void send();
}
async function interrupt() {
  localError.value = '';
  try { await props.controller.interrupt(); }
  catch (cause: any) { localError.value = cause?.message || '停止失败，请重试。'; }
}
async function synchronize() {
  if (synchronizing.value || !state.value.connected || !state.value.threadId) return;
  synchronizing.value = true;
  localError.value = '';
  try { await props.controller.recover(); }
  catch (cause: any) { localError.value = cause?.message || '同步失败，请重试。'; }
  finally { synchronizing.value = false; }
}
async function close() {
  if (closing.value) return;
  closing.value = true;
  localError.value = '';
  try { await props.controller.close(); }
  catch (cause: any) { localError.value = cause?.message || '关闭失败，请重试。'; }
  finally { closing.value = false; }
}
async function newBranch() {
  if (!window.confirm("另开侧边分支会关闭当前临时问答，并按当前选段重新继承历史，是否继续？")) return;
  try { await props.controller.newBranch(); }
  catch (cause: any) { localError.value = cause.message; }
}
async function saveBranch() {
  localError.value = '';
  try { await props.controller.saveBranch(); }
  catch (cause: any) { localError.value = cause.message; }
}
async function recoverSavedBranch() {
  localError.value = '';
  try { await props.controller.resumeSavedBranch(recoveryId.value.trim()); recoveryId.value = ''; }
  catch (cause: any) { localError.value = cause.message; }
}
function quoteAnswer() {
  const value = props.controller.answerQuote();
  if (value) emit('quote', value);
}
</script>

<template>
  <section class="side-chat-panel workspace-panel" aria-label="侧边聊天" :aria-busy="state.loading">
    <header class="side-chat-heading">
      <div><Icon name="PanelRight" :size="16" /><strong>侧边聊天</strong></div>
      <div class="side-chat-heading-actions"><button v-if="state.threadId" type="button" class="icon-button" aria-label="同步侧边聊天" title="同步侧边聊天" :disabled="closing || synchronizing || !state.connected || state.loading" @click="synchronize"><Icon :name="synchronizing ? 'LoaderCircle' : 'RefreshCw'" :size="15" :class="{ spin: synchronizing }" /></button><button type="button" class="icon-button" aria-label="关闭侧边聊天" title="关闭侧边聊天" :disabled="closing || state.saving" @click="close"><Icon :name="closing ? 'LoaderCircle' : 'X'" :size="17" :class="{ spin: closing }" /></button></div>
    </header>
    <p class="side-chat-note">{{ state.anchor ? `历史锚点：${state.boundary.lastTurnId ? '截至首次所选轮次' : state.boundary.beforeTurnId ? '首次所选运行轮次之前' : '首次提问时的对话历史'}。后续问题继续此分支。` : '首次提问继承所选位置的对话历史。' }}</p>
    <div v-if="state.threadId" class="side-chat-branch-actions">
      <button type="button" class="button button-small button-secondary" :disabled="state.busy || state.loading || state.saving || !state.connected" @click="newBranch">另开侧边分支</button>
      <button type="button" class="button button-small button-secondary" :disabled="state.busy || state.loading || state.saving || !!state.savedThreadId || state.saveUncertain === 'fork' || !state.connected" @click="saveBranch">{{ state.savedThreadId ? '分支已保存' : state.saving ? '正在保存…' : state.saveUncertain === 'fork' ? '创建结果待确认' : state.saveUncertain === 'inject' ? '核对并继续保存' : state.saveTargetThreadId ? '保存新增问答到分支' : '保存并置顶正式分支' }}</button>
      <button type="button" class="button button-small button-secondary" :disabled="state.busy || !controller.answerQuote()" @click="quoteAnswer">引用回答到主对话</button>
    </div>
    <form v-if="state.saveUncertain === 'fork'" class="side-chat-save-recovery" @submit.prevent="recoverSavedBranch">
      <label>创建结果待确认：请先核对已创建的原生对话，再填写其对话 ID。<input v-model="recoveryId" maxlength="128" aria-label="已创建正式分支的对话 ID" placeholder="正式分支的对话 ID" :disabled="state.saving" /></label>
      <button type="submit" class="button button-small button-secondary" :disabled="!recoveryId.trim() || state.saving || state.busy || !state.connected">指定已创建分支继续保存</button>
    </form>
    <details v-if="state.source" class="side-chat-quote" open>
      <summary><Icon name="CornerDownLeft" :size="14" /><span>引用 {{ state.source.threadName || '原对话' }}</span><Icon name="ChevronDown" :size="13" /></summary>
      <blockquote>{{ state.source.text }}</blockquote>
    </details>
    <div ref="transcript" class="side-chat-transcript" aria-label="侧边聊天消息" @scroll.passive="onScroll">
      <ConversationOutput :items="state.items || []" :turns="state.turns || []" :busy="state.busy" :host-id="state.source?.hostId" :cwd="mainState.projectPath" :hide-fork="true" @open-file="(path, line) => emit('openFile', path, line)" @error="localError = $event" />
      <ApprovalCard v-for="request in requests" :key="request.id" :request="request" :api="api" />
      <p v-if="state.loading" class="side-chat-status" role="status"><Icon name="LoaderCircle" :size="15" class="spin" />正在准备侧边对话…</p>
      <div v-if="!state.items?.length && !state.loading && !state.busy" class="side-chat-empty"><Icon name="CircleHelp" :size="24" /><p>想了解这段内容的哪一部分？</p></div>
    </div>
    <p v-if="error" class="side-chat-error" role="alert">{{ error }}</p>
    <p v-if="state.notice" class="side-chat-status" role="status">{{ state.notice }}</p>
    <p v-if="!state.connected" class="side-chat-status" role="status"><Icon name="WifiOff" :size="14" />连接已断开，恢复后可继续发送。</p>
    <form class="side-chat-composer" @submit.prevent="send">
      <label class="side-chat-label" for="side-chat-question">围绕引用内容提问</label>
      <textarea id="side-chat-question" ref="questionField" v-model="question" maxlength="16000" rows="3" placeholder="输入问题…" :disabled="closing" @keydown="onQuestionKeydown" />
      <div class="side-chat-actions"><span>{{ state.busy ? '正在回答…' : '侧边对话 · 只读权限' }}</span><button v-if="state.busy" type="button" class="icon-button side-chat-stop" aria-label="停止侧边回答" :disabled="!state.connected || closing" @click="interrupt"><Icon name="StopCircle" :size="19" /></button><button v-else type="submit" class="icon-button side-chat-send" aria-label="发送侧边问题" :disabled="sendDisabled"><Icon :name="state.loading ? 'LoaderCircle' : 'ArrowUp'" :size="19" :class="{ spin: state.loading }" /></button></div>
    </form>
  </section>
</template>

<style scoped>
.side-chat-panel { display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; flex: 1; background: var(--surface); color: var(--text); }
.side-chat-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.side-chat-heading > div { display: flex; align-items: center; gap: 8px; }
.side-chat-heading-actions { margin-left: auto; }
.side-chat-heading strong { font-size: 13px; font-weight: 600; }
.side-chat-branch-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px 0; flex-shrink: 0; }
.side-chat-note { font-size: 11px; color: var(--muted); padding: 10px 16px 0; margin: 0; line-height: 1.7; }
.side-chat-quote { margin: 10px 14px 0; padding: 9px 10px; border-left: 2px solid var(--green); background: var(--soft); border-radius: 6px; flex-shrink: 0; font-size: 12px; min-width: 0; }
.side-chat-quote summary { display: flex; align-items: center; gap: 6px; list-style: none; color: var(--muted); cursor: pointer; }
.side-chat-quote summary::-webkit-details-marker { display: none; }
.side-chat-quote summary span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-chat-quote:not([open]) summary > :last-child { transform: rotate(-90deg); }
.side-chat-quote blockquote { font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; max-height: 120px; overflow-y: auto; margin: 8px 0 0; }
.side-chat-transcript { min-height: 0; min-width: 0; flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; overscroll-behavior: contain; }
.side-chat-transcript :deep(.message), .side-chat-transcript :deep(.tool-item), .side-chat-transcript :deep(.conversation-turn) { min-width: 0; max-width: 100%; }
.side-chat-transcript :deep(.markdown), .side-chat-transcript :deep(.user-bubble) { font-size: 12px; max-width: 100%; overflow-wrap: anywhere; }
.side-chat-transcript :deep(.approval-card) { min-width: 0; margin: 0; }
.side-chat-transcript :deep(pre) { max-width: 100%; overflow-x: auto; }
.side-chat-empty { color: var(--muted); text-align: center; padding: 30px 8px; font-size: 12px; }
.side-chat-error { color: var(--red); font-size: 12px; line-height: 1.7; padding: 8px 16px; margin: 0; overflow-wrap: anywhere; flex-shrink: 0; }
.side-chat-status { display: flex; align-items: center; gap: 6px; padding: 8px 16px; margin: 0; color: var(--muted); font-size: 12px; flex-shrink: 0; line-height: 1.7; }
.side-chat-save-recovery { margin: 4px 12px; display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: var(--muted); }
.side-chat-save-recovery input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 6px; padding: 6px; }
.side-chat-composer { margin: 8px 12px 12px; padding: 10px 12px 8px; flex-shrink: 0; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); min-width: 0; }
.side-chat-composer:focus-within { border-color: var(--muted); }
.side-chat-label { position: absolute; clip: rect(0, 0, 0, 0); width: 1px; height: 1px; overflow: hidden; }
.side-chat-composer textarea { resize: vertical; display: block; width: 100%; min-height: 58px; max-height: 180px; border: 0; outline: 0; font: inherit; font-size: 13px; line-height: 1.7; color: var(--text); background: transparent; padding: 0; }
.side-chat-composer textarea::placeholder { color: var(--muted); }
.side-chat-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 6px; }
.side-chat-actions > span { color: var(--muted); font-size: 10px; }
.side-chat-send { background: var(--text); color: var(--surface); border-radius: 50%; }
.side-chat-actions .icon-button { min-height: 32px; min-width: 32px; }
.side-chat-send:disabled { opacity: .35; }
@media (max-width: 760px) {
  .side-chat-heading .icon-button, .side-chat-actions .icon-button { min-height: 40px; min-width: 40px; }
  .side-chat-composer { margin-bottom: max(12px, env(safe-area-inset-bottom)); }
  .side-chat-composer textarea { font-size: 16px; max-height: 120px; }
  .side-chat-quote blockquote { max-height: 90px; }
}
</style>
