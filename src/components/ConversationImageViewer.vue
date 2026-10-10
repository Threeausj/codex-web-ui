<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { ConversationImagePreview } from '../lib/conversation-image-viewer';
import Icon from './Icon.vue';

const props = defineProps<{ image: ConversationImagePreview }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const viewport = ref<HTMLDivElement>();
const titleId = `conversation-image-title-${useId()}`;
const dimensions = ref({ width: 0, height: 0 });
const available = ref({ width: 0, height: 0 });
const zoom = ref(1);
const loading = ref(true);
const failed = ref(false);
const fit = computed(() => dimensions.value.width && available.value.width
  ? Math.min(1, Math.max(1, available.value.width - 32) / dimensions.value.width,
    Math.max(1, available.value.height - 32) / dimensions.value.height) : 1);
const scale = computed(() => fit.value * zoom.value);
const imageStyle = computed(() => dimensions.value.width ? {
  width: `${Math.round(dimensions.value.width * scale.value)}px`,
  height: `${Math.round(dimensions.value.height * scale.value)}px`,
} : undefined);
const canZoomOut = computed(() => zoom.value > .25);
const canZoomIn = computed(() => zoom.value < Math.max(4, 1 / fit.value));
let observer: ResizeObserver | undefined;
function measure() {
  if (viewport.value) available.value = { width: viewport.value.clientWidth, height: viewport.value.clientHeight };
}
function reset() {
  dimensions.value = { width: 0, height: 0 };
  zoom.value = 1;
  loading.value = true;
  failed.value = false;
  nextTick(() => { measure(); viewport.value?.scrollTo(0, 0); });
}
function loaded(event: Event) {
  const img = event.target as HTMLImageElement;
  dimensions.value = { width: img.naturalWidth, height: img.naturalHeight };
  loading.value = false;
  measure();
}
async function setZoom(value: number) {
  zoom.value = Math.min(Math.max(4, 1 / fit.value), Math.max(.25, value));
  await nextTick();
  const element = viewport.value;
  if (element) element.scrollTo((element.scrollWidth - element.clientWidth) / 2, (element.scrollHeight - element.clientHeight) / 2);
}
function originalSize() { void setZoom(1 / fit.value); }
function fitSize() { void setZoom(1); }
function toggleSize() { if (Math.abs(scale.value - 1) < .001 && fit.value < 1) fitSize(); else originalSize(); }
function onWheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  void setZoom(zoom.value * (event.deltaY > 0 ? .8 : 1.25));
}
function onBackdrop(event: MouseEvent) {
  if (event.target !== dialog.value) return;
  const bounds = dialog.value.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) emit('close');
}
watch(() => props.image.src, reset);
onMounted(() => {
  dialog.value?.showModal();
  measure();
  if (typeof ResizeObserver !== 'undefined' && viewport.value) {
    observer = new ResizeObserver(measure);
    observer.observe(viewport.value);
  }
});
onBeforeUnmount(() => { observer?.disconnect(); dialog.value?.close(); });
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="conversation-image-viewer" :aria-labelledby="titleId" @cancel.prevent="emit('close')" @click="onBackdrop">
      <header>
        <h2 :id="titleId"><Icon name="Image" :size="18" /><span>{{ image.name }}</span></h2>
        <div class="image-viewer-controls">
          <button type="button" class="icon-button" aria-label="缩小图片" title="缩小图片" :disabled="loading || failed || !canZoomOut" @click="setZoom(zoom / 1.25)"><span aria-hidden="true">−</span></button>
          <span class="image-viewer-zoom" aria-live="polite">{{ Math.round(scale * 100) }}%</span>
          <button type="button" class="icon-button" aria-label="放大图片" title="放大图片" :disabled="loading || failed || !canZoomIn" @click="setZoom(zoom * 1.25)"><Icon name="Plus" :size="18" /></button>
          <button type="button" class="button button-small button-secondary image-viewer-fit" :disabled="loading || failed" @click="fitSize">适应窗口</button>
          <button type="button" class="button button-small button-secondary image-viewer-original" :disabled="loading || failed" @click="originalSize">原始尺寸</button>
          <button type="button" class="icon-button image-viewer-close" aria-label="关闭图片预览" title="关闭图片预览 (Esc)" autofocus @click="emit('close')"><Icon name="X" :size="21" /></button>
        </div>
      </header>
      <div ref="viewport" class="image-viewer-viewport" :aria-busy="loading" @wheel="onWheel">
        <div v-if="failed" class="image-viewer-status" role="status"><Icon name="Image" :size="28" /><p>图片无法加载，文件可能已被移动或删除。</p></div>
        <div v-else class="image-viewer-canvas">
          <div v-if="loading" class="image-viewer-status image-viewer-loading" role="status"><Icon name="LoaderCircle" :size="24" class="spin" /><span>正在加载图片…</span></div>
          <img :key="image.src" :src="image.src" :alt="image.name" :style="imageStyle" :class="{ 'image-loading': loading }" decoding="async" draggable="false" @load="loaded" @error="failed = true; loading = false" @dblclick="toggleSize" />
        </div>
      </div>
      <footer><span v-if="dimensions.width">{{ dimensions.width }} × {{ dimensions.height }}</span><span>双击切换原始尺寸 · Esc 关闭</span></footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.conversation-image-viewer { display: flex; flex-direction: column; width: min(1200px, calc(100vw - 32px)); height: min(900px, calc(100dvh - 40px)); max-width: none; max-height: none; margin: auto; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); color: var(--text); box-shadow: 0 22px 80px #0005; overflow: hidden; }
.conversation-image-viewer:not([open]) { display: none; }
.conversation-image-viewer::backdrop { background: var(--scrim); backdrop-filter: blur(5px); }
header { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
h2 { display: flex; align-items: center; gap: 9px; min-width: 0; margin: 0; font-size: 14px; font-weight: 600; }
h2 > svg { flex: none; }
h2 > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.image-viewer-controls { display: flex; flex: none; align-items: center; gap: 5px; }
.image-viewer-controls .icon-button { width: 34px; height: 34px; }
.image-viewer-controls .icon-button > span { font-size: 25px; line-height: 1; }
.image-viewer-zoom { min-width: 46px; color: var(--muted); text-align: center; font-size: 12px; font-variant-numeric: tabular-nums; }
.image-viewer-close { margin-left: 5px; }
.image-viewer-viewport { flex: 1; min-height: 0; min-width: 0; overflow: auto; overscroll-behavior: contain; background: var(--bg); }
.image-viewer-canvas { display: grid; place-items: center; width: max-content; height: max-content; min-width: 100%; min-height: 100%; padding: 16px; position: relative; }
.image-viewer-canvas img { display: block; max-width: none; max-height: none; object-fit: contain; user-select: none; cursor: zoom-in; }
.image-loading { visibility: hidden; }
.image-viewer-status { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; height: 100%; padding: 32px; color: var(--muted); font-size: 13px; text-align: center; }
.image-viewer-loading { position: absolute; inset: 0; }
.image-viewer-status p { margin: 0; }
footer { display: flex; flex: none; justify-content: space-between; gap: 14px; padding: 9px 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11px; }
button:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
@media (max-width: 760px) {
  .conversation-image-viewer { width: calc(100vw - 16px); height: calc(100dvh - 24px); border-radius: 13px; }
  header { flex-wrap: wrap; gap: 8px; padding: 10px; }
  h2 { max-width: calc(100% - 44px); font-size: 13px; }
  .image-viewer-controls { flex-wrap: wrap; gap: 3px; width: 100%; }
  .image-viewer-controls .icon-button { width: 40px; height: 40px; }
  .image-viewer-controls .button { min-height: 36px; padding: 7px 9px; font-size: 12px; }
  .image-viewer-close { margin-left: auto; }
  footer { padding: 8px 10px; font-size: 10px; }
}
</style>
