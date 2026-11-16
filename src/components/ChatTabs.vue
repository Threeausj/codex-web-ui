<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';

type ChatTab = { hostId: string; threadId: string; title: string; pinned: boolean };
const props = defineProps<{
  tabs: ChatTab[];
  activeKey: string | null;
  draft: boolean;
  disabled: boolean;
}>();
const emit = defineEmits<{ select: [tab: ChatTab]; close: [tab: ChatTab]; new: [] }>();
const key = (tab: ChatTab) => JSON.stringify([tab.hostId, tab.threadId]);
const draftKey = 'new-chat';
const viewport = ref<HTMLElement>();
const focusedKey = ref<string | null>(null);
const visibleKeys = computed(() => [...props.tabs.map(key), ...(props.draft ? [draftKey] : [])]);
const stripWidths = computed(() => ({
  '--tabs-width': `${Math.max(0, visibleKeys.value.length * 228 - 4)}px`,
  '--tabs-width-mobile': `${Math.max(0, visibleKeys.value.length * 199 - 3)}px`,
}));
const selectedKey = computed(() => props.draft ? draftKey : props.activeKey);
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
    const tab = props.tabs.find(tab => key(tab) === value);
    if (tab && !tab.pinned) { event.preventDefault(); event.stopPropagation(); closeTab(tab); }
  }
}
function closeMiddle(event: MouseEvent, tab: ChatTab) {
  if (event.button !== 1) return;
  event.preventDefault();
  closeTab(tab);
}
watch(selectedKey, selected => { focusedKey.value = selected; });
watch(() => [selectedKey.value, ...props.tabs.map(tab => `${key(tab)}:${tab.title}:${tab.pinned}`), props.draft], async () => {
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
      <div v-for="tab in tabs" :key="key(tab)" class="chat-tab"
        :class="{ active: !draft && key(tab) === activeKey, pinned: tab.pinned }"
        :data-host-id="tab.hostId" :data-thread-id="tab.threadId"
        @auxclick="closeMiddle($event, tab)">
        <button type="button" class="chat-tab-select" role="tab" :data-tab-key="key(tab)"
          :aria-selected="!draft && key(tab) === activeKey"
          :tabindex="tabStop === key(tab) ? 0 : -1" :disabled="disabled"
          :title="tab.title" @click="emit('select', tab)" @focus="focusedKey = key(tab)"
          @keydown="keydown($event, key(tab))">
          <Icon :name="tab.pinned ? 'Pin' : 'MessagesSquare'" :size="14" />
          <span class="chat-tab-title">{{ tab.title }}</span>
        </button>
        <div v-if="!draft && key(tab) === activeKey" class="chat-tab-menu"><slot name="menu" /></div>
        <button v-if="!tab.pinned" type="button" class="chat-tab-close" :disabled="disabled"
          :aria-label="`关闭标签页：${tab.title}`" title="关闭标签页，不会停止任务"
          @click.stop="closeTab(tab)"><Icon name="X" :size="13" /></button>
      </div>
      <div v-if="draft" class="chat-tab active draft">
        <button type="button" class="chat-tab-select" role="tab" :data-tab-key="draftKey" aria-selected="true"
          :tabindex="tabStop === draftKey ? 0 : -1" :disabled="disabled" title="新对话"
          @focus="focusedKey = draftKey" @keydown="keydown($event, draftKey)">
          <Icon name="SquarePen" :size="14" /><span class="chat-tab-title">新对话</span>
        </button>
        <div class="chat-tab-menu"><slot name="menu" /></div>
      </div>
    </div>
    <button type="button" class="icon-button chat-tab-new" :disabled="disabled"
      aria-label="新建聊天标签页" title="新建聊天标签页" @click="emit('new')"><Icon name="Plus" :size="17" /></button>
  </div>
</template>
