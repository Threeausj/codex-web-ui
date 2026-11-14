<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { copyText } from '../lib/copy-text';
import { fileEntryPath, validFileEntryName, type FileEntryChange, type FileEntryOperation, type FileClipboard } from '../../shared/file-entries';
type DialogAction = 'createFile' | 'createDirectory' | 'rename' | 'delete' | 'paste';

const props = defineProps<{ api: any; hostId: string; directory: string; entry?: { name: string; isDirectory: boolean }; disabled?: boolean;
  beforeChange?: (operation: FileEntryOperation, path: string) => boolean | Promise<boolean> }>();
const emit = defineEmits<{ changed: [change: FileEntryChange]; working: [value: boolean] }>();
const dialog = ref<HTMLDialogElement>();
const field = ref<HTMLInputElement>();
const menuButton = ref<HTMLButtonElement>();
const menuPanel = ref<HTMLDivElement>();
const menuPosition = ref({ left: '0px', top: '0px' });
const menu = ref(false);
const action = ref<DialogAction | ''>('');
const name = ref('');
const version = ref('');
const busy = ref(false);
const preparing = ref(false);
const error = ref('');
let generation = 0;
let disposed = false;
let returnFocus: HTMLElement | null = null;
const scope = computed(() => JSON.stringify([props.hostId, props.directory, props.entry?.name]));
const clipboard = computed(() => props.api.fileClipboard?.());
const pasteSource = ref<FileClipboard>();
const canPaste = computed(() => !!clipboard.value && clipboard.value.hostId === props.hostId);
const destination = computed(() => action.value === 'paste' && props.entry?.isDirectory ? fileEntryPath(props.directory, props.entry.name) : props.directory);
const title = computed(() => ({ createFile: '新建文件', createDirectory: '新建文件夹', rename: '重命名', delete: '删除', paste: '粘贴文件' })[action.value || 'createFile']);
const valid = computed(() => action.value === 'delete' || validFileEntryName(name.value) && (action.value !== 'rename' || name.value !== props.entry?.name));
watch(busy, value => { if (!disposed) emit('working', value); }, { flush: 'sync' });
watch(menu, async open => {
  if (!open) { menuPanel.value?.hidePopover?.(); return; }
  await nextTick();
  if (!menu.value || !menuPanel.value || !menuButton.value) return;
  menuPanel.value.showPopover?.();
  const button = menuButton.value.getBoundingClientRect(), panel = menuPanel.value.getBoundingClientRect();
  menuPosition.value = {
    left: `${Math.max(8, Math.min(button.right - panel.width, innerWidth - panel.width - 8))}px`,
    top: `${Math.max(8, button.bottom + panel.height + 8 <= innerHeight ? button.bottom + 4 : button.top - panel.height - 4)}px`,
  };
  menuPanel.value.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
});
watch(scope, () => { ++generation; menu.value = false; dialog.value?.close(); action.value = ''; preparing.value = false; error.value = ''; });
async function start(operation: DialogAction) {
  if (props.disabled || busy.value) return;
  if (operation === 'paste' && !canPaste.value) return;
  const current = ++generation;
  returnFocus = document.activeElement as HTMLElement | null;
  menu.value = false; action.value = operation; name.value = operation === 'rename' ? props.entry?.name || '' : '';
  pasteSource.value = operation === 'paste' ? clipboard.value : undefined;
  if (pasteSource.value) name.value = pasteSource.value.name;
  version.value = ''; error.value = ''; preparing.value = operation === 'rename' || operation === 'delete';
  await nextTick();
  dialog.value?.showModal();
  if (operation !== 'delete') await nextTick(() => {
    field.value?.focus();
    const end = operation === 'rename' && !props.entry?.isDirectory && name.value.lastIndexOf('.') > 0 ? name.value.lastIndexOf('.') : name.value.length;
    field.value?.setSelectionRange(0, end);
  });
  if (!preparing.value) return;
  try {
    const metadata = await props.api.inspectFileEntry(props.hostId, props.directory, props.entry!.name);
    if (current === generation && !disposed) version.value = metadata.version;
  } catch (cause: any) { if (current === generation && !disposed) error.value = cause.message || '无法读取文件信息'; }
  finally { if (current === generation && !disposed) preparing.value = false; }
}
function cancel() {
  if (busy.value) return;
  ++generation; dialog.value?.close(); action.value = ''; preparing.value = false; error.value = '';
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}
async function submit() {
  if (!action.value || busy.value || preparing.value || !valid.value || props.disabled ||
    (action.value === 'rename' || action.value === 'delete') && !version.value) return;
  const selectedAction = action.value, hostId = props.hostId, directory = props.directory;
  const source = props.entry?.name || name.value;
  const currentScope = scope.value, current = generation;
  busy.value = true; error.value = '';
  try {
    if (selectedAction !== 'paste' && props.beforeChange && !await props.beforeChange(selectedAction, fileEntryPath(directory, source))) return;
    if (selectedAction === 'paste' && pasteSource.value && props.beforeChange && !await props.beforeChange(pasteSource.value.mode, fileEntryPath(pasteSource.value.directory, pasteSource.value.name))) return;
    if (disposed || current !== generation || currentScope !== scope.value) return;
    const change = selectedAction === 'paste' ? await props.api.pasteFileEntry(hostId, destination.value, name.value, pasteSource.value) : await props.api.changeFileEntry(hostId, { operation: selectedAction, directory,
      name: selectedAction === 'rename' || selectedAction === 'delete' ? source : name.value,
      ...(selectedAction === 'rename' ? { newName: name.value, expectedVersion: version.value } : {}),
      ...(selectedAction === 'delete' ? { expectedVersion: version.value, confirmed: true } : {}),
    });
    if (disposed || current !== generation || currentScope !== scope.value) return;
    busy.value = false; cancel(); emit('changed', change);
  } catch (cause: any) {
    if (!disposed && current === generation && currentScope === scope.value) error.value = cause.message || '文件操作失败，请刷新后核对结果。';
  } finally { busy.value = false; if (currentScope !== scope.value) cancel(); }
}
async function copyEntry(mode: 'copy' | 'move') {
  if (props.disabled || busy.value || !props.entry) return;
  const current = generation, captured = scope.value;
  const hostId = props.hostId, directory = props.directory, name = props.entry.name;
  menu.value = false; busy.value = true;
  try {
    await props.api.copyFileEntry(hostId, directory, name, mode);
    if (!disposed && current === generation && captured === scope.value) props.api.toast?.(mode === 'copy' ? '已复制，请在目标文件夹粘贴' : '已剪切，请在目标文件夹粘贴以移动');
  } catch (cause: any) { props.api.toast?.(cause.message || '无法读取文件信息'); }
  finally { busy.value = false; }
}
async function copyPath() {
  menu.value = false;
  try { await copyText(fileEntryPath(props.directory, props.entry!.name)); props.api.toast?.('路径已复制'); }
  catch { props.api.toast?.('复制失败，请检查浏览器剪贴板权限'); }
}
function key(event: KeyboardEvent) {
  if (menu.value && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation();
    const buttons = [...menuPanel.value!.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    return;
  }
  if (event.key === 'Escape' && menu.value) { event.preventDefault(); event.stopPropagation(); menu.value = false; menuButton.value?.focus({ preventScroll: true }); return; }
  if (!props.entry) return;
  if (event.key === 'F2' || event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); void start(event.key === 'F2' ? 'rename' : 'delete'); }
}
defineExpose({ openMenu: () => { if (!props.disabled) menu.value = true; }, start, copyEntry });
onBeforeUnmount(() => { disposed = true; ++generation; dialog.value?.close(); if (busy.value) emit('working', false); });
</script>

<template>
  <div class="explorer-actions" @keydown="key">
    <template v-if="!entry">
      <button type="button" class="icon-button" aria-label="新建文件" title="新建文件" :disabled="disabled || busy" @click="start('createFile')"><Icon name="FilePlus2" :size="16" /></button>
      <button type="button" class="icon-button" aria-label="新建文件夹" title="新建文件夹" :disabled="disabled || busy" @click="start('createDirectory')"><Icon name="FolderPlus" :size="16" /></button>
      <button type="button" class="icon-button" aria-label="粘贴文件" :title="canPaste ? `粘贴 ${clipboard.name}` : clipboard ? '只能在同一主机内粘贴' : '先复制或剪切文件'" :disabled="disabled || busy || !canPaste" @click="start('paste')"><Icon name="ClipboardPaste" :size="16" /></button>
    </template>
    <template v-else>
      <button ref="menuButton" type="button" class="icon-button" :aria-label="`${entry.name} 文件操作`" :title="`${entry.name} 文件操作`" :aria-expanded="menu" :disabled="disabled || busy" @click="menu = !menu"><Icon name="MoreHorizontal" :size="16" /></button>
      <template v-if="menu">
        <div ref="menuPanel" popover="auto" class="explorer-menu" :style="menuPosition" role="menu" :aria-label="`${entry.name} 文件操作`" @toggle="(event: any) => { if (event.newState === 'closed') menu = false; }">
          <button role="menuitem" @click="start('rename')"><Icon name="Pencil" :size="14" />重命名<span>F2</span></button>
          <button role="menuitem" @click="copyEntry('copy')"><Icon name="Copy" :size="14" />复制<span>Ctrl/⌘ C</span></button>
          <button role="menuitem" @click="copyEntry('move')"><Icon name="Scissors" :size="14" />剪切（移动）<span>Ctrl/⌘ X</span></button>
          <button role="menuitem" :disabled="!canPaste" @click="start('paste')"><Icon name="ClipboardPaste" :size="14" />粘贴<span>Ctrl/⌘ V</span></button>
          <button role="menuitem" @click="copyPath"><Icon name="Copy" :size="14" />复制路径</button>
          <button role="menuitem" class="danger" @click="start('delete')"><Icon name="Trash2" :size="14" />删除<span>Delete</span></button>
        </div>
      </template>
    </template>
    <Teleport to="body">
      <dialog v-if="action" ref="dialog" class="file-operation-dialog" :aria-label="title" @cancel.prevent="cancel" @keydown.stop>
        <form @submit.prevent="submit">
          <header><h2>{{ title }}</h2><button type="button" class="icon-button" aria-label="关闭文件操作" :disabled="busy" @click="cancel"><Icon name="X" :size="17" /></button></header>
          <p class="file-operation-location">{{ destination }}</p>
          <p v-if="action === 'paste'" class="file-operation-note">{{ pasteSource?.mode === 'move' ? '移动' : '复制' }} {{ pasteSource?.name }} 到此文件夹。同名项不会被覆盖，可修改目标名称。</p>
          <template v-if="action === 'delete'">
            <p>确认删除 <strong>{{ entry?.name }}</strong>？{{ entry?.isDirectory ? '文件夹及其内容将被永久删除。' : '此操作无法撤销。' }}</p>
            <p class="file-operation-note">请先保存需要保留的修改。此操作直接修改所选主机的文件。</p>
          </template>
          <label v-else>{{ action === 'rename' ? '新名称' : action === 'createDirectory' ? '文件夹名称' : '文件名称' }}<input ref="field" v-model="name" :aria-label="action === 'rename' ? '新名称' : action === 'createDirectory' ? '文件夹名称' : '文件名称'" required maxlength="255" autocomplete="off" spellcheck="false" :disabled="busy" /></label>
          <p v-if="name && !validFileEntryName(name) && action !== 'delete'" class="inline-error">名称不能包含 /、\ 或控制字符，也不能是 . 或 ..。</p>
          <p v-if="preparing" role="status" class="file-operation-note">正在核对文件…</p>
          <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
          <footer><button type="button" class="button button-secondary" :disabled="busy" @click="cancel">取消</button><button type="submit" class="button" :class="action === 'delete' ? 'file-delete-confirm' : 'button-primary'" :disabled="busy || preparing || !valid || ((action === 'rename' || action === 'delete') && !version)">{{ busy ? '处理中…' : action === 'delete' ? '确认删除' : action === 'rename' ? '确认重命名' : action === 'paste' ? '粘贴' : '创建' }}</button></footer>
        </form>
      </dialog>
    </Teleport>
  </div>
</template>

<style scoped>
.explorer-actions { position: relative; display: flex; align-items: center; flex-shrink: 0; gap: 2px; }
.explorer-actions > .icon-button { width: 28px; height: 28px; }
.explorer-menu { position: fixed; inset: auto; margin: 0; min-width: 176px; padding: 5px; border: 1px solid var(--border); border-radius: 9px; color: var(--text); background: var(--surface); box-shadow: var(--shadow); }
.explorer-menu button { display: flex; align-items: center; width: 100%; gap: 8px; padding: 9px; border-radius: 5px; text-align: left; font-size: 12px; }
.explorer-menu button:hover, .explorer-menu button:focus-visible { background: var(--hover); }
.explorer-menu button span { margin-left: auto; color: var(--muted); font-size: 10px; }
.danger { color: var(--red); }
.file-operation-dialog { width: min(430px, calc(100vw - 28px)); max-height: calc(100dvh - 32px); overflow: auto; padding: 22px; margin: auto; border: 1px solid var(--border); border-radius: 16px; color: var(--text); background: var(--surface); box-shadow: var(--shadow); }
.file-operation-dialog::backdrop { background: var(--scrim); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
h2 { font-size: 17px; }
p { font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
.file-operation-location { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
label { display: block; font-size: 13px; }
input { display: block; width: 100%; margin-top: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
.file-operation-note { margin-top: 10px; font-size: 12px; color: var(--muted); }
footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
.file-delete-confirm { color: var(--red); background: color-mix(in srgb, var(--red) 10%, var(--surface)); }
@media(max-width:760px) { input { font-size: 16px; } .explorer-actions > .icon-button { width: 34px; height: 34px; } }
</style>
