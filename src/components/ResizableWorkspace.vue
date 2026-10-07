<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
withDefaults(defineProps<{ panelId?: string }>(), { panelId: 'workspace-panel' });

const storageKey = "codex.workspaceWidth";
function savedWidth() {
  try {
    const value = Number(localStorage.getItem(storageKey));
    return Number.isFinite(value) && value >= 160 && value <= 10_000
      ? value
      : null;
  } catch { return null; }
}
const element = ref<HTMLElement>();
const handle = ref<HTMLElement>();
const preferredWidth = ref<number | null>(savedWidth());
const viewportWidth = ref(window.innerWidth);
const availableWidth = ref(window.innerWidth);
const dragging = ref(false);
const mobile = computed(() => viewportWidth.value <= 760);
const defaultWidth = computed(() => viewportWidth.value <= 1150 ? 360 : 410);
const maxWidth = computed(() => Math.max(0, availableWidth.value -
  (viewportWidth.value <= 1150 ? 240 : 320)));
const minWidth = computed(() => Math.min(310, maxWidth.value));
const clamp = (value: number) => Math.round(Math.min(maxWidth.value, Math.max(minWidth.value, value)));
const width = computed(() => clamp(preferredWidth.value ?? defaultWidth.value));
let observer: ResizeObserver | undefined;
let pointerId: number | null = null;
let startX = 0;
let startWidth = 0;
let previousWidth: number | null = null;
let previousCursor = "";
let previousSelection = "";

function measure() {
  viewportWidth.value = window.innerWidth;
  const parent = element.value?.parentElement;
  const sidebar = parent?.querySelector<HTMLElement>(".sidebar");
  availableWidth.value = Math.max(0,
    (parent?.getBoundingClientRect().width ?? window.innerWidth) -
    (sidebar?.getBoundingClientRect().width ?? 0));
  if (mobile.value && dragging.value) finish(false);
}
function persist() {
  try {
    if (preferredWidth.value === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, String(preferredWidth.value));
  } catch { /* Resizing still works when browser storage is unavailable. */ }
}
function begin(event: PointerEvent) {
  if (mobile.value || event.button !== 0 || dragging.value) return;
  event.preventDefault();
  measure();
  startX = event.clientX;
  startWidth = width.value;
  previousWidth = preferredWidth.value;
  pointerId = event.pointerId;
  previousCursor = document.body.style.cursor;
  previousSelection = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  dragging.value = true;
  handle.value?.focus({ preventScroll: true });
  handle.value?.setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!dragging.value || event.pointerId !== pointerId) return;
  event.preventDefault();
  preferredWidth.value = clamp(startWidth + startX - event.clientX);
}
function finish(commit = true) {
  if (!dragging.value) return;
  const captured = pointerId;
  dragging.value = false;
  pointerId = null;
  if (!commit) preferredWidth.value = previousWidth;
  document.body.style.cursor = previousCursor;
  document.body.style.userSelect = previousSelection;
  if (captured !== null && handle.value?.hasPointerCapture(captured))
    handle.value.releasePointerCapture(captured);
  if (commit) persist();
}
function finishPointer(event: PointerEvent, commit: boolean) {
  if (event.pointerId === pointerId) finish(commit);
}
function cancelDrag() { finish(false); }
function reset() {
  finish(false);
  preferredWidth.value = null;
  persist();
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape" && dragging.value) {
    event.preventDefault();
    event.stopPropagation();
    finish(false);
    return;
  }
  if (dragging.value || mobile.value || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const step = event.shiftKey ? 40 : 10;
  preferredWidth.value = event.key === "Home" ? minWidth.value :
    event.key === "End" ? maxWidth.value :
    clamp(width.value + (event.key === "ArrowLeft" ? step : -step));
  persist();
}
onMounted(() => {
  measure();
  const parent = element.value?.parentElement;
  observer = new ResizeObserver(measure);
  if (parent) observer.observe(parent);
  const sidebar = parent?.querySelector<HTMLElement>(".sidebar");
  if (sidebar) observer.observe(sidebar);
  window.addEventListener("resize", measure);
  window.addEventListener("blur", cancelDrag);
});
onBeforeUnmount(() => {
  finish(false);
  observer?.disconnect();
  window.removeEventListener("resize", measure);
  window.removeEventListener("blur", cancelDrag);
});
</script>

<template>
  <div ref="element" class="resizable-workspace" :class="{ dragging }"
    :style="{ '--workspace-width': `${width}px` }">
    <div ref="handle" class="workspace-resize-handle" role="separator"
      tabindex="0" aria-label="调整工作区宽度" aria-orientation="vertical"
      :aria-controls="panelId" :aria-valuemin="minWidth"
      :aria-valuemax="maxWidth" :aria-valuenow="width" :aria-valuetext="`${width} 像素`"
      title="拖动调整宽度 · 双击重置"
      @pointerdown="begin" @pointermove="move" @pointerup="finishPointer($event, true)"
      @pointercancel="finishPointer($event, false)" @lostpointercapture="finish(false)"
      @keydown="keydown" @dblclick="reset" />
    <slot />
    <Teleport to="body">
      <div v-if="dragging" class="workspace-drag-overlay" aria-hidden="true" />
    </Teleport>
  </div>
</template>

<style scoped>
.resizable-workspace {
  position: relative;
  flex: 0 0 auto;
  width: var(--workspace-width);
  height: 100%;
  min-height: 0;
}
.resizable-workspace :deep(.workspace-panel) { width: 100%; min-width: 0; }
.workspace-resize-handle {
  position: absolute;
  inset: 0 auto 0 -4px;
  width: 9px;
  z-index: 34;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}
.workspace-resize-handle::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: transparent;
  transition: background .15s;
}
.workspace-resize-handle:hover::after,
.workspace-resize-handle:focus-visible::after,
.dragging .workspace-resize-handle::after { background: var(--muted); }
.workspace-drag-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}
@media (max-width: 760px) {
  .resizable-workspace {
    position: fixed;
    inset: 0;
    width: 100%;
    height: var(--app-height, 100dvh);
    z-index: 32;
  }
  .workspace-resize-handle { display: none; }
}
</style>
