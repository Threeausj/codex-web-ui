<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { browserStorage } from '../lib/browser-storage';

const props = defineProps<{ collapsed: boolean; workspaceVisible: boolean }>();
const storageKey = 'codex.sidebarWidth';
const stored = Number(browserStorage.local.getItem(storageKey));
const preferredWidth = ref<number | null>(Number.isFinite(stored) && stored >= 180 && stored <= 480 ? stored : null);
const element = ref<HTMLElement>();
const handle = ref<HTMLElement>();
const viewportWidth = ref(window.innerWidth);
const availableWidth = ref(window.innerWidth);
const dragging = ref(false);
const mobile = computed(() => viewportWidth.value <= 760);
const defaultWidth = computed(() => viewportWidth.value <= 1150 ? (props.workspaceVisible ? 200 : 220) : 246);
const maxWidth = computed(() => Math.max(0, Math.min(480, availableWidth.value -
  (viewportWidth.value <= 1150 ? 240 : 320) - (props.workspaceVisible ? 310 : 0))));
const minWidth = computed(() => Math.min(180, maxWidth.value));
const clamp = (value: number) => Math.round(Math.max(minWidth.value, Math.min(maxWidth.value, value)));
const width = computed(() => clamp(preferredWidth.value ?? defaultWidth.value));
let observer: ResizeObserver | undefined;
let pointerId: number | null = null;
let startX = 0, startWidth = 0;
let previousWidth: number | null = null;
let previousCursor = '', previousSelection = '';

function measure() {
  viewportWidth.value = window.innerWidth;
  availableWidth.value = element.value?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
  if (mobile.value && dragging.value) finish();
}
function persist() {
  if (preferredWidth.value === null) browserStorage.local.removeItem(storageKey);
  else browserStorage.local.setItem(storageKey, String(preferredWidth.value));
}
function begin(event: PointerEvent) {
  if (mobile.value || props.collapsed || event.button !== 0 || dragging.value) return;
  event.preventDefault();
  measure();
  startX = event.clientX; startWidth = width.value; previousWidth = preferredWidth.value;
  pointerId = event.pointerId;
  previousCursor = document.body.style.cursor; previousSelection = document.body.style.userSelect;
  document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  dragging.value = true;
  handle.value?.focus({ preventScroll: true });
  handle.value?.setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!dragging.value || event.pointerId !== pointerId) return;
  event.preventDefault();
  preferredWidth.value = clamp(startWidth + event.clientX - startX);
}
function finish(commit = true) {
  if (!dragging.value) return;
  const captured = pointerId;
  dragging.value = false; pointerId = null;
  if (!commit) preferredWidth.value = previousWidth;
  document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelection;
  if (captured !== null && handle.value?.hasPointerCapture(captured)) handle.value.releasePointerCapture(captured);
  if (commit) persist();
}
function finishPointer(event: PointerEvent, commit: boolean) {
  if (event.pointerId !== pointerId) return;
  if (commit) move(event);
  finish(commit);
}
function interruptPointer(event: PointerEvent) { if (event.pointerId === pointerId) finish(); }
function interruptDrag() { finish(); }
function reset() { finish(false); preferredWidth.value = null; persist(); }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && dragging.value) {
    event.preventDefault(); event.stopPropagation(); finish(false); return;
  }
  if (mobile.value || dragging.value || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  preferredWidth.value = event.key === 'Home' ? minWidth.value : event.key === 'End' ? maxWidth.value :
    clamp(width.value + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10));
  persist();
}
watch(() => props.collapsed, collapsed => { if (collapsed) finish(); });
onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);
  if (element.value?.parentElement) observer.observe(element.value.parentElement);
  window.addEventListener('resize', measure);
  window.addEventListener('blur', interruptDrag);
});
onBeforeUnmount(() => {
  finish(false); observer?.disconnect();
  window.removeEventListener('resize', measure); window.removeEventListener('blur', interruptDrag);
});
</script>

<template>
  <aside id="navigation-sidebar" ref="element" class="sidebar resizable-sidebar" :class="{ dragging }"
    :style="{ '--sidebar-width': `${width}px` }">
    <slot />
    <div ref="handle" class="sidebar-resize-handle" role="separator" tabindex="0"
      aria-label="调整左侧栏宽度" aria-orientation="vertical" aria-controls="navigation-sidebar"
      :aria-valuemin="minWidth" :aria-valuemax="maxWidth" :aria-valuenow="width" :aria-valuetext="`${width} 像素`"
      title="拖动调整宽度 · 双击重置"
      @pointerdown="begin" @pointermove="move" @pointerup="finishPointer($event, true)"
      @pointercancel="interruptPointer" @lostpointercapture="interruptPointer"
      @keydown="keydown" @dblclick="reset" />
    <Teleport to="body"><div v-if="dragging" class="sidebar-drag-overlay" aria-hidden="true" /></Teleport>
  </aside>
</template>

<style scoped>
.sidebar-resize-handle {
  position: absolute; inset: 0 -4px 0 auto; width: 9px; z-index: 34;
  cursor: col-resize; touch-action: none; outline: none;
}
.sidebar-resize-handle::after {
  content: ''; position: absolute; right: 4px; top: 0; bottom: 0; width: 2px;
  background: transparent; transition: background .15s;
}
.sidebar-resize-handle:hover::after, .sidebar-resize-handle:focus-visible::after,
.dragging .sidebar-resize-handle::after { background: var(--muted); }
.sidebar-drag-overlay { position: fixed; inset: 0; z-index: 1000; cursor: col-resize; touch-action: none; user-select: none; }
@media (min-width: 761px) { .resizable-sidebar { position: relative; } }
@media (max-width: 760px) { .sidebar-resize-handle { display: none; } }
</style>
