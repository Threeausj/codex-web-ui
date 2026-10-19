<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import ApprovalCard from './ApprovalCard.vue';
import ConversationOutput from './ConversationOutput.vue';
import { conversationSelectionKey } from '../lib/conversation-selection';

const props = defineProps<{ controller: any; api: any; mainState: any }>();
const emit = defineEmits<{ openFile: [path: string, line?: number]; quote: [value: any]; openParent: [hostId: string, threadId: string] }>();
const state = computed(() => props.controller.state);
const question = computed({ get: () => state.value.draft || '', set: value => { state.value.draft = value; } });
const questionField = ref<HTMLTextAreaElement>();
const transcript = ref<HTMLElement>();
const closeDialog = ref<HTMLDialogElement>();
const closePrompt = ref(false);
const localError = ref('');
const closing = ref(false);
const synchronizing = ref(false);
const recoveryId = ref('');
const followTail = ref(true);
const conversationContext = computed(() => (state.value.anchor || state.value.source)?.kind === 'conversation');
const parentSource = computed(() => state.value.anchor || state.value.source);
const parentName = computed(() => parentSource.value?.threadName || '原对话');
const parentChanged = computed(() => !!parentSource.value && (parentSource.value.hostId !== props.mainState.hostId || parentSource.value.threadId !== props.mainState.activeThread?.id));
const parentHostName = computed(() => (props.mainState.hosts || []).find((host: any) => host.id === parentSource.value?.hostId)?.name || parentSource.value?.hostId || '');
const quoteSource = computed(() => state.value.source?.text ? state.value.source : state.value.anchor?.text ? state.value.anchor : null);
const sourceKey = computed(() => state.value.source?.kind === 'conversation'
  ? JSON.stringify(['conversation', state.value.source.hostId, state.value.source.threadId])
  : conversationSelectionKey(state.value.source));
const requests = computed(() => state.value.threadId && state.value.source?.hostId === props.mainState.hostId
  ? (props.mainState.pendingRequests || []).filter((request: any) => (request.params?.threadId || request.params?.conversationId) === state.value.threadId)
  : []);
const sendDisabled = computed(() => !question.value.trim() || question.value.length > 16_000 || state.value.busy || state.value.loading || !state.value.connected || closing.value);
const endUnavailable = computed(() => closing.value || state.value.saving || (!!state.value.threadId && !state.value.connected));
const error = computed(() => localError.value || state.value.error);
const saveLabel = computed(() => state.value.savedThreadId ? '分支已保存' : state.value.saving ? '正在保存…' : state.value.saveUncertain === 'fork' ? '创建结果待确认' : state.value.saveUncertain === 'inject' ? '核对并继续保存' : state.value.saveTargetThreadId ? '保存新增问答到分支' : '保存并置顶正式分支');
function resizeQuestion() {
  const field = questionField.value;
  if (!field) return;
  field.style.height = 'auto';
  const maximum = Number.parseFloat(getComputedStyle(field).maxHeight) || 210;
  field.style.height = `${Math.min(field.scrollHeight, maximum)}px`;
}
function focusQuestion() { void nextTick(() => { resizeQuestion(); if (state.value.open && !closing.value && !closePrompt.value) questionField.value?.focus({ preventScroll: true }); }); }
defineExpose({ focusQuestion, confirmingClose: closePrompt, closeConfirmation: cancelClose });
onMounted(() => { if (state.value.open) focusQuestion(); });
onBeforeUnmount(() => closeDialog.value?.close());
watch(sourceKey, () => {
  localError.value = '';
  followTail.value = true;
  if (state.value.open) focusQuestion();
});
watch(() => state.value.open, open => {
  if (open) focusQuestion();
  else { closeDialog.value?.close(); closePrompt.value = false; }
});
watch(question, () => { void nextTick(resizeQuestion); });
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
    const accepted = await props.controller.send(draft.trim());
    if (accepted !== false && sourceKey.value === key && question.value === draft) question.value = '';
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
function hide() { props.controller.hide(); }
async function requestClose() {
  if (endUnavailable.value) return;
  closePrompt.value = true;
  await nextTick();
  closeDialog.value?.showModal();
}
function cancelClose() {
  closeDialog.value?.close();
  closePrompt.value = false;
  focusQuestion();
}
async function confirmClose() {
  if (endUnavailable.value) return;
  closeDialog.value?.close();
  closePrompt.value = false;
  await close();
}
function openParent() {
  const source = parentSource.value;
  if (source) emit('openParent', source.hostId, source.threadId);
}
async function newBranch() {
  if (!window.confirm(conversationContext.value || parentChanged.value
    ? `另开侧边分支会结束当前临时问答，并继承${parentChanged.value ? '当前主窗口对话' : '原对话'}的上下文。未保存的侧边问答和草稿将清除，是否继续？`
    : '另开侧边分支会关闭当前临时问答，并按当前选段重新继承历史，是否继续？')) return;
  try { await props.controller.newBranch(); localError.value = ''; followTail.value = true; focusQuestion(); }
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
  if (parentChanged.value) return;
  const value = props.controller.answerQuote();
  if (value) emit('quote', value);
}
</script>

<template>
  <section class="side-chat-panel workspace-panel" aria-label="侧边聊天" :aria-busy="state.loading">
    <header class="side-chat-heading">
      <div><Icon name="PanelRight" :size="16" /><strong>侧边聊天</strong></div>
      <div class="side-chat-heading-actions"><button v-if="state.threadId" type="button" class="icon-button" aria-label="同步侧边聊天" title="同步侧边聊天" :disabled="closing || synchronizing || !state.connected || state.loading" @click="synchronize"><Icon :name="synchronizing ? 'LoaderCircle' : 'RefreshCw'" :size="15" :class="{ spin: synchronizing }" /></button><button type="button" class="icon-button" aria-label="收起侧边聊天" title="收起侧边聊天，保留问答和草稿" @click="hide"><Icon name="X" :size="17" /></button></div>
    </header>
    <div ref="transcript" class="side-chat-transcript" aria-label="侧边聊天消息" @scroll.passive="onScroll">
    <details v-if="quoteSource" class="side-chat-quote" open>
      <summary><Icon name="CornerDownLeft" :size="14" /><span>引用 {{ quoteSource.threadName || '原对话' }}</span><Icon name="ChevronDown" :size="13" /></summary>
      <blockquote>{{ quoteSource.text }}</blockquote>
    </details>
      <ConversationOutput :items="state.items || []" :turns="state.turns || []" :busy="state.busy" :host-id="state.source?.hostId" :thread-id="state.threadId" :cwd="state.sourceCwd" :hide-fork="true" @open-file="(path, line) => emit('openFile', path, line)" @error="localError = $event" />
      <ApprovalCard v-for="request in requests" :key="request.id" :request="request" :items="state.items" :api="api" />
      <p v-if="state.loading" class="side-chat-status" role="status"><Icon name="LoaderCircle" :size="15" class="spin" />正在准备侧边对话…</p>
      <div v-if="!state.items?.length && !state.loading && !state.busy" class="side-chat-empty"><Icon name="CircleHelp" :size="24" /><p>{{ conversationContext ? '基于当前对话，继续提问' : '想了解这段内容的哪一部分？' }}</p></div>
    <p v-if="error" class="side-chat-error" role="alert">{{ error }}</p>
    <p v-if="state.notice" class="side-chat-status" role="status">{{ state.notice }}</p>
    <p v-if="!state.connected" class="side-chat-status" role="status"><Icon name="WifiOff" :size="14" />连接已断开，恢复后可继续发送。</p>
    </div>
    <footer class="side-chat-composer-container composer-container">
    <div class="side-chat-context-controls">
      <details class="side-chat-context-details">
        <summary :aria-label="`侧边聊天上下文说明：${parentName}`" :title="`${parentHostName} · ${parentName} · 查看上下文说明`"><Icon name="GitBranch" :size="13" /><span>{{ parentName }}</span><Icon name="ChevronDown" :size="12" /></summary>
        <div class="side-chat-context-description">
          <div v-if="parentSource" class="side-chat-origin"><span>{{ parentHostName }} · {{ parentName }}</span></div>
          <p v-if="parentChanged" class="side-chat-note side-chat-context-notice">{{ parentSource.hostId !== mainState.hostId ? `保留 ${parentHostName} 上的侧边聊天和草稿，返回原对话连接后继续发送。` : '仍使用原对话上下文。若要继承当前主窗口的对话，请另开侧边分支。' }}</p>
          <p class="side-chat-note">{{ conversationContext ? (state.anchor ? '沿用首次提问时当前对话的上下文，后续问题继续此分支。' : '首次提问继承当前对话的完整上下文，父对话继续独立运行。') : state.anchor ? `历史锚点：${state.boundary.lastTurnId ? '截至首次所选轮次' : state.boundary.beforeTurnId ? '首次所选运行轮次之前' : '首次提问时的对话历史'}。后续问题继续此分支。` : '首次提问继承所选位置的对话历史。' }}</p>
        </div>
      </details>
      <div class="side-chat-branch-actions">
        <button v-if="parentChanged" type="button" class="icon-button" aria-label="返回原对话" title="返回原对话" @click="openParent"><Icon name="CornerUpLeft" :size="15" /></button>
        <button type="button" class="icon-button" aria-label="另开侧边分支" title="另开侧边分支" :disabled="state.busy || state.loading || state.saving || !state.connected" @click="newBranch"><Icon name="Plus" :size="16" /></button>
        <button v-if="state.threadId" type="button" class="icon-button" :aria-label="saveLabel" :title="saveLabel" :disabled="state.busy || state.loading || state.saving || !!state.savedThreadId || state.saveUncertain === 'fork' || !state.connected" @click="saveBranch"><Icon :name="state.savedThreadId ? 'Check' : state.saving ? 'LoaderCircle' : 'Save'" :size="15" :class="{ spin: state.saving }" /></button>
        <button v-if="state.threadId" type="button" class="icon-button" aria-label="引用回答到主对话" :disabled="state.busy || parentChanged || !controller.answerQuote()" :title="parentChanged ? '请先返回原对话，再引用回答' : '引用回答到主对话'" @click="quoteAnswer"><Icon name="Quote" :size="15" /></button>
      </div>
    <form v-if="state.saveUncertain === 'fork'" class="side-chat-save-recovery" @submit.prevent="recoverSavedBranch">
      <label>创建结果待确认：请先核对已创建的原生对话，再填写其对话 ID。<input v-model="recoveryId" maxlength="128" aria-label="已创建正式分支的对话 ID" placeholder="正式分支的对话 ID" :disabled="state.saving" /></label>
      <button type="submit" class="button button-small button-secondary" :disabled="!recoveryId.trim() || state.saving || state.busy || !state.connected">指定已创建分支继续保存</button>
    </form>
    </div>
    <form class="side-chat-composer" @submit.prevent="send">
      <div class="side-chat-composer-body composer">
      <label class="side-chat-label" for="side-chat-question">{{ conversationContext ? '基于当前对话提问' : '围绕引用内容提问' }}</label>
      <textarea id="side-chat-question" ref="questionField" v-model="question" maxlength="16000" rows="2" spellcheck="false" :placeholder="conversationContext ? '基于当前对话提问…' : '输入问题…'" :disabled="closing" @keydown="onQuestionKeydown" />
      <div class="side-chat-actions"><div class="side-chat-composer-meta"><Icon name="MessagesSquare" :size="14" /><span>{{ state.busy ? '正在回答…' : '侧边对话 · 只读权限' }}</span></div><div class="side-chat-submit"><button type="button" class="side-chat-end" :disabled="endUnavailable" :title="state.threadId && !state.connected ? '返回原对话连接后，再结束侧边聊天' : '确认后停止侧边回答并清除侧边问答和草稿'" @click="requestClose">结束侧边聊天</button><button v-if="state.busy" type="button" class="send-button stop-button side-chat-primary side-chat-stop" aria-label="停止侧边回答" :disabled="!state.connected || closing" @click="interrupt"><span /></button><button v-else type="submit" class="send-button side-chat-primary side-chat-send" aria-label="发送侧边问题" :disabled="sendDisabled"><Icon :name="state.loading ? 'LoaderCircle' : 'ArrowUp'" :size="20" :class="{ spin: state.loading }" /></button></div></div>
      </div>
    </form>
    </footer>
    <Teleport to="body">
      <dialog v-if="closePrompt" ref="closeDialog" class="side-chat-close-dialog" aria-labelledby="side-chat-close-title" @cancel.prevent="cancelClose">
        <h2 id="side-chat-close-title">结束侧边聊天？</h2>
        <p>这会停止正在进行的侧边回答，并清除侧边问答和草稿。已保存的正式分支会保留。</p>
        <p>如果稍后继续，请使用右上角的收起按钮。</p>
        <footer><button type="button" class="button button-secondary" autofocus @click="cancelClose">取消</button><button type="button" class="button button-primary" :disabled="endUnavailable" @click="confirmClose">确认结束</button></footer>
      </dialog>
    </Teleport>
  </section>
</template>

<style scoped>
.side-chat-panel { --side-chat-accent: #7050ca; display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; flex: 1; background: var(--surface); color: var(--text); }
.side-chat-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 42px; min-height: 42px; padding: 0 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.side-chat-heading > div { display: flex; align-items: center; gap: 8px; }
.side-chat-heading .icon-button { width: 28px; height: 28px; }
.side-chat-heading-actions { margin-left: auto; }
.side-chat-heading strong { font-size: 12px; font-weight: 550; }
.side-chat-origin { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; }
.side-chat-origin > span { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.side-chat-origin > button { flex-shrink: 0; }
.side-chat-branch-actions { display: flex; gap: 2px; flex-shrink: 0; }
.side-chat-branch-actions .icon-button { width: 28px; height: 28px; }
.side-chat-context-controls { position: relative; display: flex; align-items: center; justify-content: space-between; min-height: 34px; gap: 8px; padding: 0 2px 4px; }
.side-chat-context-details { flex: 1; min-width: 0; font-size: 11px; color: var(--muted); }
.side-chat-context-details > summary { display: flex; align-items: center; gap: 5px; min-height: 28px; cursor: pointer; list-style: none; }
.side-chat-context-details > summary::-webkit-details-marker { display: none; }
.side-chat-context-details > summary:focus-visible { outline: 2px solid var(--accent-text); outline-offset: 1px; border-radius: 5px; }
.side-chat-context-details > summary > svg { flex-shrink: 0; }
.side-chat-context-details > summary > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-chat-context-details[open] > summary > svg:last-child { transform: rotate(180deg); }
.side-chat-context-description { position: absolute; z-index: 4; bottom: calc(100% + 4px); left: 0; right: 0; display: grid; gap: 7px; max-height: min(180px, 35dvh); overflow-y: auto; overscroll-behavior: contain; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); box-shadow: var(--shadow); }
.side-chat-context-description .side-chat-origin > span { white-space: normal; overflow-wrap: anywhere; }
.side-chat-note { font-size: 11px; color: var(--muted); margin: 0; line-height: 1.7; flex-shrink: 0; }
.side-chat-context-notice { padding: 8px 10px; background: var(--soft); border-radius: 7px; }
.side-chat-quote { margin: 0; padding: 9px 10px; border-left: 2px solid var(--green); background: var(--soft); border-radius: 6px; flex-shrink: 0; font-size: 12px; min-width: 0; }
.side-chat-quote summary { display: flex; align-items: center; gap: 6px; list-style: none; color: var(--muted); cursor: pointer; }
.side-chat-quote summary::-webkit-details-marker { display: none; }
.side-chat-quote summary span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-chat-quote:not([open]) summary > :last-child { transform: rotate(-90deg); }
.side-chat-quote blockquote { font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; max-height: 120px; overflow-y: auto; margin: 8px 0 0; }
.side-chat-transcript { min-height: 0; min-width: 0; flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; overscroll-behavior: contain; }
.side-chat-transcript > * { flex-shrink: 0; }
.side-chat-transcript :deep(.message), .side-chat-transcript :deep(.tool-item), .side-chat-transcript :deep(.conversation-turn) { min-width: 0; max-width: 100%; }
.side-chat-transcript :deep(.markdown), .side-chat-transcript :deep(.user-bubble) { font-size: 12px; max-width: 100%; overflow-wrap: anywhere; }
.side-chat-transcript :deep(.approval-card) { min-width: 0; margin: 0; }
.side-chat-transcript :deep(pre) { max-width: 100%; overflow-x: auto; }
.side-chat-empty { color: var(--muted); text-align: center; padding: 30px 8px; font-size: 12px; }
.side-chat-error { color: var(--red); font-size: 12px; line-height: 1.7; margin: 0; overflow-wrap: anywhere; flex-shrink: 0; }
.side-chat-status { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--muted); font-size: 12px; flex-shrink: 0; line-height: 1.7; }
.side-chat-save-recovery { position: absolute; z-index: 4; bottom: calc(100% + 4px); left: 0; right: 0; display: flex; flex-wrap: wrap; gap: 6px; max-height: min(160px, 25dvh); overflow-y: auto; overscroll-behavior: contain; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); box-shadow: var(--shadow); font-size: 11px; color: var(--muted); }
.side-chat-save-recovery input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 6px; padding: 6px; }
.side-chat-composer-container { flex-shrink: 0; }
.side-chat-composer { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); box-shadow: 0 3px 16px color-mix(in srgb, var(--text) 4%, transparent); min-width: 0; }
.side-chat-composer:focus-within { border-color: color-mix(in srgb, var(--accent-text) 55%, var(--border)); }
.side-chat-composer-body { border: 0; border-radius: inherit; box-shadow: none; }
.side-chat-composer-body:focus-within { box-shadow: none; }
.side-chat-label { position: absolute; clip: rect(0, 0, 0, 0); width: 1px; height: 1px; overflow: hidden; }
.side-chat-composer textarea::placeholder { color: var(--muted); }
.side-chat-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; min-width: 0; gap: 8px; }
.side-chat-composer-meta { display: flex; align-items: center; gap: 5px; min-height: 30px; min-width: 0; color: var(--muted); font-size: 11px; }
.side-chat-submit { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-left: auto; }
.side-chat-end { border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 11px; min-height: 30px; padding: 4px 0; cursor: pointer; }
.side-chat-end:hover { color: var(--text); }
.side-chat-end:disabled { opacity: .4; cursor: default; }
.side-chat-close-dialog { width: min(410px, calc(100vw - 28px)); max-height: calc(var(--app-height, 100dvh) - 28px); padding: 22px; margin: auto; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); color: var(--text); overflow-y: auto; box-shadow: 0 18px 70px #0003; }
.side-chat-close-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(3px); }
.side-chat-close-dialog h2 { margin: 0 0 12px; font-size: 16px; }
.side-chat-close-dialog p { margin: 8px 0; font-size: 13px; line-height: 1.7; color: var(--muted); }
.side-chat-close-dialog footer { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }
.side-chat-primary:not(:disabled) { background: var(--side-chat-accent); color: var(--inverse); }
@media (max-width: 760px) {
  .side-chat-heading { height: calc(48px + env(safe-area-inset-top)); min-height: calc(48px + env(safe-area-inset-top)); padding: env(safe-area-inset-top) 11px 0; }
  .side-chat-heading .icon-button { width: 36px; height: 38px; }
  .side-chat-heading strong { font-size: 13px; }
  .side-chat-context-controls { min-height: 40px; }
  .side-chat-context-details > summary, .side-chat-branch-actions .icon-button { min-height: 36px; }
  .side-chat-branch-actions .icon-button { width: 36px; }
  .side-chat-composer textarea { max-height: min(120px, 25dvh); }
  .side-chat-composer-meta, .side-chat-end { min-height: 36px; }
  .side-chat-primary { width: 36px; height: 36px; }
  .side-chat-quote blockquote { max-height: 90px; }
  .side-chat-close-dialog .button { min-height: 42px; }
}
@media (max-width: 600px) {
  .side-chat-composer-body { padding: 12px 12px 10px; }
  .side-chat-composer-body > textarea { padding: 0 0 8px; min-height: 52px; font-size: 16px; }
  .side-chat-actions { display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .side-chat-submit { width: 100%; }
}
@media (max-width: 760px) and (max-height: 400px) {
  .side-chat-context-description, .side-chat-save-recovery { max-height: max(40px, calc(75dvh - 200px - env(safe-area-inset-top) - env(safe-area-inset-bottom))); padding: 8px; }
}
</style>
