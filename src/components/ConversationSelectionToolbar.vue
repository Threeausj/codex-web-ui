<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { captureConversationSelection, type ConversationSelectionSource } from '../lib/conversation-selection';

const props = defineProps<{ container?: HTMLElement | null; hostId: string; threadId?: string; threadName?: string; disabled?: boolean }>();
const emit = defineEmits<{ add: [source: ConversationSelectionSource]; ask: [source: ConversationSelectionSource] }>();
const source = ref<ConversationSelectionSource | null>(null);
const toolbar = ref<HTMLElement>();
const position = ref({ left: 12, top: 12, width: 328 });
const mobile = ref(false);
let scheduled = 0;
let currentContainer: HTMLElement | null = null;
const style = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px`, maxWidth: `${position.value.width}px` }));

function dismiss() { source.value = null; }
function updatePosition() {
  if (!source.value) return;
  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth;
  const height = viewport?.height || window.innerHeight;
  const offsetTop = viewport?.offsetTop || 0;
  const offsetLeft = viewport?.offsetLeft || 0;
  mobile.value = width <= 760 || window.matchMedia('(pointer: coarse)').matches;
  const toolbarWidth = Math.min(toolbar.value?.offsetWidth || 328, width - 24);
  const toolbarHeight = toolbar.value?.offsetHeight || 44;
  const rect = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
  const left = mobile.value ? offsetLeft + (width - toolbarWidth) / 2 : Math.min(offsetLeft + width - toolbarWidth - 12, Math.max(offsetLeft + 12, (rect?.left || 12) + (rect?.width || 0) / 2 - toolbarWidth / 2));
  let top = offsetTop + height - toolbarHeight - 18;
  if (!mobile.value && rect) {
    top = rect.top - toolbarHeight - 10;
    if (top < offsetTop + 12) top = rect.bottom + 10;
    top = Math.min(offsetTop + height - toolbarHeight - 12, Math.max(offsetTop + 12, top));
  }
  position.value = { left, top, width: width - 24 };
}
function capture() {
  // Keyboard tabbing to the actions can clear the native highlight. Keep its
  // captured text while the toolbar owns focus, until an explicit action.
  if (toolbar.value?.contains(document.activeElement)) return;
  source.value = !props.disabled && props.container ? captureConversationSelection(props.container, window.getSelection(), props) : null;
  if (source.value) void nextTick(updatePosition);
}
function schedule() {
  if (scheduled) return;
  scheduled = window.requestAnimationFrame(() => { scheduled = 0; capture(); });
}
function onPointerDown(event: PointerEvent) {
  const target = event.target as Node | null;
  if (target && toolbar.value?.contains(target)) return;
  dismiss();
}
function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') dismiss();
}
function action(kind: 'add' | 'ask') {
  const captured = source.value;
  if (!captured || props.disabled || captured.hostId !== props.hostId || captured.threadId !== props.threadId) return;
  dismiss();
  window.getSelection()?.removeAllRanges();
  if (kind === 'add') emit('add', captured);
  else emit('ask', captured);
}
watch(() => [props.hostId, props.threadId, props.disabled], dismiss, { flush: 'sync' });
watch(() => props.container, container => {
  currentContainer?.removeEventListener('scroll', dismiss);
  currentContainer = container || null;
  currentContainer?.addEventListener('scroll', dismiss, { passive: true });
  dismiss();
}, { immediate: true });
onMounted(() => {
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('pointerup', schedule);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', updatePosition);
  window.visualViewport?.addEventListener('resize', updatePosition);
  window.visualViewport?.addEventListener('scroll', updatePosition);
});
onBeforeUnmount(() => {
  if (scheduled) window.cancelAnimationFrame(scheduled);
  currentContainer?.removeEventListener('scroll', dismiss);
  document.removeEventListener('selectionchange', schedule);
  document.removeEventListener('pointerup', schedule);
  document.removeEventListener('pointerdown', onPointerDown);
  document.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('resize', updatePosition);
  window.visualViewport?.removeEventListener('resize', updatePosition);
  window.visualViewport?.removeEventListener('scroll', updatePosition);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="source" ref="toolbar" class="conversation-selection-toolbar" :class="{ mobile }" :style="style" role="toolbar" aria-label="所选对话内容">
      <button type="button" @pointerdown.prevent @click="action('add')"><Icon name="Plus" :size="15" />添加到对话</button>
      <button type="button" @pointerdown.prevent @click="action('ask')"><Icon name="PanelRight" :size="15" />在侧边聊天中提问</button>
    </div>
  </Teleport>
</template>

<style scoped>
.conversation-selection-toolbar { position: fixed; z-index: 1000; display: flex; align-items: center; gap: 2px; padding: 4px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--text); box-shadow: 0 5px 24px #0002; }
.conversation-selection-toolbar button { display: flex; align-items: center; justify-content: center; gap: 5px; border: 0; border-radius: 7px; padding: 8px 10px; white-space: nowrap; font-size: 12px; line-height: 1.4; color: inherit; background: transparent; cursor: pointer; }
.conversation-selection-toolbar button:hover { background: var(--hover); }
.conversation-selection-toolbar button:focus-visible { outline: 2px solid var(--green); outline-offset: -1px; }
.conversation-selection-toolbar.mobile button { min-height: 40px; padding: 8px; }
@media (max-width: 360px) { .conversation-selection-toolbar button { gap: 3px; padding: 8px 5px; font-size: 11px; } }
</style>
