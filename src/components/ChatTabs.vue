<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';

type ChatTab = { hostId: string; threadId: string; title: string; pinned: boolean };
type FileTab = { scope: string; hostId: string; projectPath: string; threadId?: string; path: string; title: string; dirty: boolean; saving: boolean };
const props = defineProps<{
  tabs: ChatTab[];
  preview?: ChatTab | null;
  activeKey: string | null;
  draft: boolean;
  disabled: boolean;
  fileTabs?: FileTab[];
  activeFilePath?: string | null;
  activeFileScope?: string | null;
  currentWorkspaceScope?: string | null;
}>();
const emit = defineEmits<{ select: [tab: ChatTab]; keep: [tab: ChatTab]; close: [tab: ChatTab]; new: []; selectDraft: []; selectFile: [tab: FileTab]; closeFile: [tab: FileTab] }>();
const key = (tab: ChatTab) => JSON.stringify([tab.hostId, tab.threadId]);
const displayTabs = computed(() => props.preview && !props.tabs.some(tab => key(tab) === key(props.preview!))
  ? [...props.tabs, props.preview] : props.tabs);
const isPreview = (tab: ChatTab) => !!props.preview && key(tab) === key(props.preview) && !props.tabs.some(entry => key(entry) === key(tab));
const draftKey = 'new-chat';
const fileKey = (tab: Pick<FileTab, 'hostId' | 'projectPath' | 'path'>) => JSON.stringify(['file', tab.hostId, tab.projectPath, tab.path]);
const isActiveFile = (tab: FileTab) => props.activeFilePath === tab.path && props.activeFileScope === tab.scope;
const fileTabLabel = (tab: FileTab) => {
  const duplicates = props.fileTabs?.filter(item => item.title === tab.title) || [];
  if (duplicates.length < 2 || tab.scope === props.currentWorkspaceScope) return tab.title;
  const project = tab.projectPath.split('/').filter(Boolean).at(-1) || tab.hostId;
  return `${tab.title} · ${tab.hostId}/${project}`;
};
const viewport = ref<HTMLElement>();
const focusedKey = ref<string | null>(null);
const visibleKeys = computed(() => [...displayTabs.value.map(key), ...(props.draft ? [draftKey] : []), ...(props.fileTabs || []).map(fileKey)]);
const stripWidths = computed(() => ({
  '--tabs-width': `${Math.max(0, visibleKeys.value.length * 228 - 4)}px`,
  '--tabs-width-mobile': `${Math.max(0, visibleKeys.value.length * 199 - 3)}px`,
}));
const selectedKey = computed(() => {
  const activeFile = props.fileTabs?.find(isActiveFile);
  return activeFile ? fileKey(activeFile) : props.draft ? draftKey : props.activeKey;
});
const tabStop = computed(() => visibleKeys.value.includes(focusedKey.value || '')
  ? focusedKey.value : selectedKey.value || visibleKeys.value[0]);
let observer: ResizeObserver | undefined;
let disposed = false;
let closingFocus: string | null = null;

function tabElement(value: string | null) {
  return [...viewport.value?.querySelectorAll<HTMLElement>('[role="tab"]') || []]
    .find(element => element.dataset.tabKey === value);
}
function showTab(value: string | null) {
  const element = tabElement(value)?.parentElement, scroll = viewport.value;
  if (!element || !scroll) return;
  const tabRect = element.getBoundingClientRect(), viewRect = scroll.getBoundingClientRect();
  if (tabRect.left < viewRect.left) scroll.scrollLeft -= viewRect.left - tabRect.left;
  else if (tabRect.right > viewRect.right) scroll.scrollLeft += tabRect.right - viewRect.right;
}
async function showSelected() {
  await nextTick();
  if (!disposed) showTab(selectedKey.value);
}
function focusTab(value: string) {
  focusedKey.value = value;
  tabElement(value)?.focus({ preventScroll: true });
  showTab(value);
}
function closeTab(tab: ChatTab) {
  if (props.disabled || tab.pinned) return;
  const element = tabElement(key(tab))?.parentElement;
  if (element?.contains(document.activeElement)) closingFocus = key(tab);
  emit('close', tab);
}
function keydown(event: KeyboardEvent, value: string) {
  if (props.disabled) return;
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation();
    const keys = visibleKeys.value, index = keys.indexOf(value);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    if (keys[next]) focusTab(keys[next]);
  } else if (event.key === 'Delete') {
    const tab = displayTabs.value.find(tab => key(tab) === value);
    if (tab && !tab.pinned) { event.preventDefault(); event.stopPropagation(); closeTab(tab); }
    const file = props.fileTabs?.find(tab => fileKey(tab) === value);
    if (file && !file.saving) { event.preventDefault(); event.stopPropagation(); emit('closeFile', file); }
  }
}
function closeMiddle(event: MouseEvent, tab: ChatTab) {
  if (event.button !== 1) return;
  event.preventDefault();
  closeTab(tab);
}
watch(selectedKey, selected => { focusedKey.value = selected; });
watch(() => [selectedKey.value, ...displayTabs.value.map(tab => `${key(tab)}:${tab.title}:${tab.pinned}:${isPreview(tab)}`), ...(props.fileTabs || []).map(tab => `${fileKey(tab)}:${tab.title}:${tab.dirty}`), props.draft], async () => {
  if (!visibleKeys.value.includes(focusedKey.value || '')) focusedKey.value = selectedKey.value;
  void showSelected();
  if (closingFocus && !visibleKeys.value.includes(closingFocus)) {
    closingFocus = null;
    await nextTick();
    if (!disposed && selectedKey.value) focusTab(selectedKey.value);
  }
}, { immediate: true });
onMounted(() => {
  observer = new ResizeObserver(() => showTab(selectedKey.value));
  if (viewport.value) observer.observe(viewport.value);
});
onBeforeUnmount(() => { disposed = true; observer?.disconnect(); });
defineExpose({ focusSelected: () => { if (selectedKey.value) focusTab(selectedKey.value); } });
</script>

<template>
  <div class="chat-tabs">
    <div ref="viewport" class="chat-tabs-scroll" role="tablist" aria-label="聊天标签页" :style="stripWidths">
      <div v-for="tab in displayTabs" :key="key(tab)" class="chat-tab"
        :class="{ active: !activeFilePath && !draft && key(tab) === activeKey, pinned: tab.pinned, preview: isPreview(tab) }"
        :data-host-id="tab.hostId" :data-thread-id="tab.threadId" :data-preview="isPreview(tab) || undefined"
        @auxclick="closeMiddle($event, tab)">
        <button type="button" class="chat-tab-select" role="tab" :data-tab-key="key(tab)"
          :aria-selected="!activeFilePath && !draft && key(tab) === activeKey"
          :aria-description="isPreview(tab) ? '临时预览，双击保留在标签栏' : undefined"
          :tabindex="tabStop === key(tab) ? 0 : -1" :disabled="disabled"
          :title="tab.title" @click="emit('select', tab)" @dblclick.prevent="!disabled && emit('keep', tab)" @focus="focusedKey = key(tab)"
          @keydown="keydown($event, key(tab))">
          <Icon :name="tab.pinned ? 'Pin' : 'MessagesSquare'" :size="14" />
          <span class="chat-tab-title">{{ tab.title }}</span>
        </button>
        <div v-if="!activeFilePath && !draft && key(tab) === activeKey" class="chat-tab-menu"><slot name="menu" /></div>
        <button v-if="!tab.pinned" type="button" class="chat-tab-close" :disabled="disabled"
          :aria-label="`关闭标签页：${tab.title}`" title="关闭标签页，不会停止任务"
          @click.stop="closeTab(tab)"><Icon name="X" :size="13" /></button>
      </div>
      <div v-if="draft" class="chat-tab draft" :class="{ active: !activeFilePath }">
        <button type="button" class="chat-tab-select" role="tab" :data-tab-key="draftKey" :aria-selected="!activeFilePath"
          :tabindex="tabStop === draftKey ? 0 : -1" :disabled="disabled" title="新对话"
          @click="emit('selectDraft')" @focus="focusedKey = draftKey" @keydown="keydown($event, draftKey)">
          <Icon name="SquarePen" :size="14" /><span class="chat-tab-title">新对话</span>
        </button>
        <div v-if="!activeFilePath" class="chat-tab-menu"><slot name="menu" /></div>
      </div>
      <div v-for="tab in fileTabs || []" :key="fileKey(tab)" class="chat-tab file-tab"
        :class="{ active: isActiveFile(tab) }" :data-file-path="tab.path" :data-file-host="tab.hostId" :data-file-project="tab.projectPath"
        @auxclick="event => { if (event.button === 1) { event.preventDefault(); if (!disabled && !tab.saving) emit('closeFile', tab); } }">
        <button type="button" class="chat-tab-select" role="tab" :data-tab-key="fileKey(tab)"
          :aria-label="fileTabLabel(tab)" :aria-description="tab.dirty ? '有未保存的修改' : undefined"
          :aria-selected="isActiveFile(tab)" :tabindex="tabStop === fileKey(tab) ? 0 : -1"
          :disabled="disabled" :title="`${tab.hostId} · ${tab.projectPath || '无项目'} · ${tab.path}`" @click="emit('selectFile', tab)"
          @focus="focusedKey = fileKey(tab)" @keydown="keydown($event, fileKey(tab))">
          <Icon name="FileText" :size="14" /><span class="chat-tab-title">{{ fileTabLabel(tab) }}</span><i v-if="tab.dirty" class="dirty-dot" aria-label="未保存"></i>
        </button>
        <button type="button" class="chat-tab-close" :disabled="disabled || tab.saving" :aria-label="`关闭文件 ${tab.title}`"
          :title="`关闭文件 ${tab.title}`" @click.stop="emit('closeFile', tab)"><Icon name="X" :size="13" /></button>
      </div>
    </div>
    <button type="button" class="icon-button chat-tab-new" :disabled="disabled"
      aria-label="新建聊天标签页" title="新建聊天标签页" @click="emit('new')"><Icon name="Plus" :size="17" /></button>
  </div>
</template>

<style scoped>
.chat-tab.preview .chat-tab-title {
  /* CJK fallback fonts commonly lack italics and the app disables synthetic
     faces. Tilt the whole label so every script uses the same preview cue. */
  font-style: normal;
  transform: skewX(-10deg);
  transform-origin: center;
}
</style>
