<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue';
import {
  emptyPromptPresets, MAX_PROMPT_PRESET_COMMAND, MAX_PROMPT_PRESET_CONTENT,
  MAX_PROMPT_PRESET_NAME, PROMPT_PRESET_SLOTS,
  type PromptPreset, type PromptPresetsSnapshot,
} from '../../shared/prompt-presets';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  snapshot: PromptPresetsSnapshot;
  embedded?: boolean;
  loading?: boolean;
  error?: string;
  busy?: boolean;
  initialContent?: string;
  currentDraft?: string;
  supportedCommands?: Array<{ name: string; description: string; id: string }>;
}>(), { embedded: false, loading: false, error: '', busy: false, initialContent: '', currentDraft: '', supportedCommands: () => [] });
const emit = defineEmits<{
  close: [];
  refresh: [];
  save: [preset: Pick<PromptPreset, 'slot' | 'name' | 'content' | 'kind'> & { expectedVersion: number }];
  remove: [preset: { slot: number; expectedVersion: number }];
  use: [preset: PromptPreset];
}>();
const dialog = ref<HTMLDialogElement>();
const nameInput = ref<HTMLInputElement>();
const slotList = ref<HTMLElement>();
const titleId = `prompt-presets-title-${useId()}`;
const descriptionId = `prompt-presets-description-${useId()}`;
const nameId = `prompt-presets-name-${useId()}`;
const contentId = `prompt-presets-content-${useId()}`;
const kindId = `prompt-presets-kind-${useId()}`;
const selectedSlot = ref(1);
const slots = computed(() => Array.from({ length: PROMPT_PRESET_SLOTS }, (_, index) =>
  props.snapshot.presets.find(preset => preset.slot === index + 1) || emptyPromptPresets().presets[index]!));
const current = computed(() => slots.value[selectedSlot.value - 1]!);
const form = reactive({ name: '', content: '', kind: 'prompt' as PromptPreset['kind'], version: 0 });
const fields = () => JSON.stringify([form.name, form.content, form.kind]);
const baseline = ref(fields());
const dirty = computed(() => fields() !== baseline.value);
const saved = computed(() => !!current.value.content);
const remoteChanged = computed(() => !props.loading && current.value.version !== form.version);
const command = computed(() => props.supportedCommands.find(command => command.name === current.value.content.trim()));
const contentLimit = computed(() => form.kind === 'command' ? MAX_PROMPT_PRESET_COMMAND : MAX_PROMPT_PRESET_CONTENT);
const commandSyntaxValid = computed(() => form.kind !== 'command' || /^\/[a-z][a-z0-9-]*(?:[ \t][^\r\n]*)?$/i.test(form.content));
const valid = computed(() => !!form.name.trim() && form.name.trim().length <= MAX_PROMPT_PRESET_NAME &&
  !/[\x00-\x1f\x7f]/.test(form.name.trim()) && !!form.content.trim() && !form.content.includes('\0') &&
  form.content.length <= contentLimit.value && commandSyntaxValid.value);
const blocked = computed(() => props.busy || props.loading);
const useDisabled = computed(() => blocked.value || !saved.value || dirty.value ||
  (current.value.kind === 'command' && !command.value));
let initialized = false;
let mutationRejected = false;
let previousFocus: HTMLElement | null = null;
let pendingMutation: { slot: number; expectedVersion: number; fields: string; remove: boolean } | undefined;

function loadSlot(slot: number) {
  selectedSlot.value = slot;
  const value = current.value;
  form.name = value.name;
  form.content = value.content;
  form.kind = value.kind;
  form.version = value.version;
  baseline.value = fields();
  pendingMutation = undefined;
  mutationRejected = false;
}
function discardChanges() {
  return !dirty.value || window.confirm('预设有未保存的修改，是否放弃这些修改？');
}
function selectSlot(slot: number) {
  if (blocked.value || slot === selectedSlot.value || !discardChanges()) return;
  loadSlot(slot);
}
function close() {
  if (!props.busy && discardChanges()) emit('close');
}
function refresh() {
  if (blocked.value || !discardChanges()) return;
  loadSlot(selectedSlot.value);
  emit('refresh');
}
function reloadSlot() {
  if (blocked.value || !discardChanges()) return;
  loadSlot(selectedSlot.value);
  emit('refresh');
}
function draftContent() { return props.currentDraft || props.initialContent; }
function fillFromDraft() {
  if (blocked.value || !draftContent().trim() || !discardChanges()) return;
  form.content = draftContent();
  form.kind = 'prompt';
  if (!form.name.trim()) form.name = draftContent().trim().split(/\r?\n/)[0]!.slice(0, MAX_PROMPT_PRESET_NAME);
  void nextTick(() => nameInput.value?.focus());
}
function save() {
  if (blocked.value || !valid.value || !dirty.value) return;
  if (saved.value && !window.confirm(`替换预设 ${selectedSlot.value}「${current.value.name}」？`)) return;
  // Keep the original slot version on conflicts so a second click never silently
  // overwrites a change from another browser. Reloading the slot is explicit.
  pendingMutation = { slot: selectedSlot.value, expectedVersion: form.version, fields: fields(), remove: false };
  emit('save', { slot: selectedSlot.value, name: form.name.trim(), content: form.content, kind: form.kind, expectedVersion: form.version });
}
function remove() {
  if (blocked.value || !saved.value || !discardChanges()) return;
  if (!window.confirm(`清空预设 ${selectedSlot.value}「${current.value.name}」？此操作会同步到其他设备。`)) return;
  pendingMutation = { slot: selectedSlot.value, expectedVersion: form.version, fields: fields(), remove: true };
  emit('remove', { slot: selectedSlot.value, expectedVersion: form.version });
}
function usePreset() {
  if (!useDisabled.value) emit('use', { ...current.value });
}
function listKey(event: KeyboardEvent) {
  if (blocked.value) return;
  let target: number | undefined;
  if (event.key === 'ArrowDown') target = selectedSlot.value % PROMPT_PRESET_SLOTS + 1;
  else if (event.key === 'ArrowUp') target = (selectedSlot.value + PROMPT_PRESET_SLOTS - 2) % PROMPT_PRESET_SLOTS + 1;
  else if (/^[0-9]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) target = event.key === '0' ? 10 : Number(event.key);
  if (!target) return;
  event.preventDefault();
  selectSlot(target);
  void nextTick(() => slotList.value?.querySelector<HTMLButtonElement>(`[data-preset-slot="${selectedSlot.value}"]`)?.focus());
}
watch([() => props.snapshot, () => props.loading, () => props.busy, () => props.error], () => {
  if (!initialized) {
    if (props.loading) return;
    initialized = true;
    loadSlot(1);
    return;
  }
  const pending = pendingMutation;
  if (pending && props.busy) return;
  if (pending && props.error) {
    // A matching live update may have come from another browser. Only the
    // mutation response can acknowledge this edit; a failed request keeps CAS.
    pendingMutation = undefined;
    mutationRejected = true;
    return;
  }
  if (pending && pending.slot === selectedSlot.value && fields() === pending.fields && current.value.version > pending.expectedVersion) {
    const result = current.value;
    const matches = pending.remove ? !result.content :
      result.name === form.name.trim() && result.content === form.content && result.kind === form.kind;
    if (matches) { loadSlot(selectedSlot.value); return; }
  }
  if (!dirty.value && !pendingMutation && !mutationRejected) loadSlot(selectedSlot.value);
}, { immediate: true });
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!props.embedded) dialog.value?.showModal();
  await nextTick();
  slotList.value?.querySelector<HTMLButtonElement>(`[data-preset-slot="${selectedSlot.value}"]`)?.focus();
});
onBeforeUnmount(() => {
  if (!props.embedded) dialog.value?.close();
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
defineExpose({ canLeave: () => !props.busy && discardChanges(), working: computed(() => props.busy || dirty.value) });
</script>

<template>
  <Teleport to="body" :disabled="embedded">
    <component :is="embedded ? 'section' : 'dialog'" ref="dialog" class="prompt-presets-dialog" :class="{ 'presets-embedded': embedded }" :aria-labelledby="titleId" :aria-describedby="descriptionId" @keydown="!embedded && $event.stopPropagation()" @cancel.prevent="close">
      <header class="presets-header">
        <h2 :id="titleId"><Icon name="Command" :size="19" />提示词预设</h2>
        <div class="presets-header-actions">
          <button type="button" class="icon-button" aria-label="刷新预设" title="刷新预设" :disabled="blocked" @click="refresh"><Icon name="RefreshCw" :size="17" /></button>
          <button type="button" class="icon-button" v-if="!embedded" aria-label="关闭提示词预设" :disabled="busy" @click="close"><Icon name="X" :size="19" /></button>
        </div>
      </header>
      <p :id="descriptionId" class="presets-description">10 个编号槽位，保存常用提示词和命令。在对话输入 /、编号或名称快速调用。</p>
      <p v-if="loading" class="presets-loading" role="status">正在读取预设…</p>
      <div class="presets-layout" :aria-busy="busy || loading">
        <nav ref="slotList" class="presets-slots" aria-label="预设槽位" @keydown="listKey">
          <button v-for="preset in slots" :key="preset.slot" type="button" class="preset-slot" :class="{ selected: preset.slot === selectedSlot, empty: !preset.content }" :aria-label="`预设 ${preset.slot}`" :aria-pressed="preset.slot === selectedSlot" :data-preset-slot="preset.slot" :disabled="blocked" @click="selectSlot(preset.slot)">
            <span class="preset-number">{{ preset.slot }}</span>
            <span class="preset-slot-copy"><span class="preset-slot-title">{{ preset.name || `预设 ${preset.slot} · 未设置` }}</span><span v-if="preset.content" class="preset-slot-excerpt">{{ preset.content }}</span></span>
            <span v-if="preset.content" class="preset-kind">{{ preset.kind === 'command' ? '命令' : '文本' }}</span>
          </button>
        </nav>
        <form class="preset-editor" @submit.prevent="save">
          <div class="preset-editor-heading"><h3>预设 {{ selectedSlot }}</h3><button type="button" class="text-button" :disabled="blocked || !draftContent().trim()" @click="fillFromDraft">保存当前草稿</button></div>
          <div class="preset-field-row">
            <label class="preset-name" :for="nameId">预设名称<input :id="nameId" ref="nameInput" v-model="form.name" :maxlength="MAX_PROMPT_PRESET_NAME" :disabled="blocked" placeholder="例如：代码审查" autocomplete="off" required /></label>
            <label class="preset-type" :for="kindId">预设类型<select :id="kindId" v-model="form.kind" :disabled="blocked"><option value="prompt">提示词</option><option value="command">命令</option></select></label>
          </div>
          <label class="preset-content" :for="contentId">预设内容<textarea :id="contentId" v-model="form.content" :maxlength="contentLimit" :disabled="blocked" :placeholder="form.kind === 'command' ? '例如：/compact' : '输入常用提示词，支持多行内容…'" spellcheck="false" required /></label>
          <div class="preset-content-meta"><span>{{ form.kind === 'command' ? '命令需以 / 开头，保持单行' : '只填入输入框，不会自动发送' }}</span><span>{{ form.content.length.toLocaleString() }} / {{ contentLimit.toLocaleString() }}</span></div>
          <p v-if="form.kind === 'command' && form.content && !commandSyntaxValid" class="presets-error">请输入以 / 开头的单行命令。</p>
          <p v-else-if="form.content.length > contentLimit" class="presets-error">内容超过当前类型的长度限制，请缩短后保存。</p>
          <p v-if="saved && current.kind === 'command' && !command" class="preset-unsupported">当前网页版尚不支持此命令，可保留预设并修改内容。</p>
          <div v-if="remoteChanged" class="preset-conflict" role="status"><span>此槽位已更新。你的编辑已保留，重新载入后可修改最新版本。</span><button type="button" class="text-button" :disabled="blocked" @click="reloadSlot">重新载入此槽位</button></div>
          <p v-if="error" class="presets-error" role="alert">{{ error }}</p>
          <footer class="preset-editor-actions">
            <button type="button" class="button preset-delete" :disabled="blocked || !saved" @click="remove"><Icon name="Trash2" :size="15" />清空预设</button>
            <div class="preset-save-actions">
              <button type="submit" class="button button-secondary" :disabled="blocked || !valid || !dirty">{{ busy ? '保存中…' : '保存预设' }}</button>
              <button v-if="!embedded" type="button" class="button button-primary" :disabled="useDisabled" :title="dirty ? '请先保存预设' : undefined" @click="usePreset">{{ current.kind === 'command' ? '执行命令' : '填入输入框' }}</button>
            </div>
          </footer>
        </form>
      </div>
    </component>
  </Teleport>
</template>

<style scoped>
.prompt-presets-dialog { box-sizing: border-box; width: min(760px, calc(100vw - 28px)); max-height: min(780px, calc(var(--app-height, 100dvh) - 28px)); margin: auto; padding: 0; overflow: auto; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.prompt-presets-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(3px); }
.presets-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px 0; }
.presets-header h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 17px; font-weight: 600; }
.presets-header-actions { display: flex; gap: 3px; }
.presets-header .icon-button { width: 36px; height: 36px; }
.presets-description { margin: 6px 18px 16px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.presets-loading { margin: 0 18px 12px; color: var(--muted); font-size: 13px; }
.presets-layout { display: grid; grid-template-columns: minmax(190px, 30%) minmax(0, 1fr); border-top: 1px solid var(--border); }
.presets-slots { max-height: 570px; overflow: auto; padding: 8px; border-right: 1px solid var(--border); }
.preset-slot { display: flex; align-items: center; gap: 8px; box-sizing: border-box; width: 100%; min-height: 48px; margin: 1px 0; padding: 9px 8px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.preset-slot:hover { background: var(--hover); }
.preset-slot.selected { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 32%, transparent); }
.preset-number { display: grid; place-items: center; flex-shrink: 0; width: 22px; height: 22px; border: 1px solid var(--border); border-radius: 5px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.selected .preset-number { color: var(--accent-text); border-color: transparent; }
.preset-slot-copy { min-width: 0; flex: 1; }
.preset-slot-title, .preset-slot-excerpt { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset-slot-title { font-size: 12px; font-weight: 500; }
.preset-slot-excerpt { margin-top: 4px; color: var(--muted); font-size: 11px; }
.preset-slot.empty .preset-slot-title { color: var(--muted); font-weight: 400; }
.preset-kind { flex-shrink: 0; color: var(--muted); font-size: 10px; }
.preset-editor { display: flex; flex-direction: column; gap: 13px; min-width: 0; padding: 16px 18px; }
.preset-editor-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.preset-editor-heading h3 { margin: 0; font-size: 14px; font-weight: 600; }
.preset-editor .text-button { min-height: 32px; font-size: 12px; }
.preset-field-row { display: flex; gap: 10px; }
.preset-editor label { display: flex; flex-direction: column; gap: 7px; min-width: 0; font-size: 12px; }
.preset-name { flex: 1; }
.preset-type { width: 100px; }
.preset-editor input, .preset-editor select, .preset-editor textarea { box-sizing: border-box; width: 100%; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); color: var(--text); font: inherit; font-size: 13px; }
.preset-editor input, .preset-editor select { min-height: 38px; padding: 8px 10px; }
.preset-content { flex: 1; }
.preset-editor textarea { min-height: 200px; max-height: 350px; padding: 11px; resize: vertical; line-height: 1.6; }
.preset-content-meta { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; margin-top: -6px; color: var(--muted); font-size: 10px; }
.preset-content-meta span:last-child { font-variant-numeric: tabular-nums; }
.presets-error, .preset-unsupported { margin: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.presets-error { color: var(--danger, #b54a40); }
.preset-unsupported { color: var(--muted); }
.preset-conflict { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 10px; border: 1px solid var(--border); border-radius: 7px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.preset-editor-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 3px; }
.preset-save-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.preset-editor-actions .button { min-height: 36px; padding: 7px 10px; font-size: 12px; white-space: nowrap; }
.preset-delete { display: flex; align-items: center; gap: 5px; border-color: transparent; background: transparent; color: var(--danger, #b54a40); }
.prompt-presets-dialog :is(button, input, select, textarea):focus-visible { outline: 2px solid var(--accent-text); outline-offset: 2px; }
.prompt-presets-dialog :is(button, input, select, textarea):disabled { cursor: default; opacity: .5; }
@media (max-width: 760px) {
  .prompt-presets-dialog { margin: 14px auto; top: 0; bottom: auto; }
}
@media (max-width: 580px) {
  .prompt-presets-dialog { width: calc(100vw - 20px); max-height: calc(var(--app-height, 100dvh) - 20px); margin: 10px auto; top: 0; bottom: auto; border-radius: 12px; }
  .presets-header { padding: 10px 14px 0; }
  .presets-header .icon-button { width: 44px; height: 44px; }
  .presets-description { margin: 3px 14px 12px; }
  .presets-layout { grid-template-columns: minmax(0, 1fr); }
  .presets-slots { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 4px; max-height: 164px; padding: 7px; border-right: 0; border-bottom: 1px solid var(--border); }
  .preset-slot { min-height: 48px; padding: 7px; }
  .preset-kind { display: none; }
  .preset-editor { padding: 13px 14px 14px; gap: 12px; }
  .preset-editor :is(input, select, textarea) { font-size: 16px; }
  .preset-editor :is(input, select) { min-height: 44px; }
  .preset-editor textarea { min-height: 150px; max-height: 270px; }
  .preset-editor .text-button, .preset-editor-actions .button { min-height: 44px; }
  .preset-editor-actions { gap: 5px; }
  .preset-editor-actions .button { padding: 8px; }
  .preset-save-actions { gap: 5px; }
  .preset-slot-title { font-size: 12px; }
}
.prompt-presets-dialog.presets-embedded { width:100%; max-height:none; margin:0; border:0; border-radius:0; box-shadow:none; overflow:visible; }
.presets-embedded .presets-header { padding:0; }
.presets-embedded .presets-description { margin-left:0; margin-right:0; }
.presets-embedded .presets-layout { border:1px solid var(--border); border-radius:10px; overflow:hidden; }
.presets-embedded .presets-header-actions { margin-left:auto; }
.presets-embedded .presets-slots { max-height:570px; }
@media (max-width:580px) { .presets-embedded .presets-slots { max-height:164px; } }
</style>
