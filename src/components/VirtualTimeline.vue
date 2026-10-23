<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type ComponentPublicInstance } from 'vue';
import { defaultRangeExtractor, elementScroll, useVirtualizer, type Virtualizer } from '@tanstack/vue-virtual';
import { estimateConversationRow, type ConversationTimelineRow } from '../lib/conversation-timeline';
import type { ReadingPosition } from '../lib/reading-positions';

const props = defineProps<{ rows: ConversationTimelineRow[]; pinnedIds?: string[]; initialReading?: ReadingPosition | null }>();
const container = ref<HTMLElement>();
const viewport = ref<HTMLElement | null>(null);
const margin = ref(0);
const selectionIds = ref<string[]>([]);
let geometry: ResizeObserver | undefined;
const options = computed(() => {
  // Core compares the previous key lookup with this one to detect prepends.
  // Capturing each immutable array is necessary; reading live props defeats it.
  const rows = props.rows;
  const pinned = new Set([...(props.pinnedIds || []), ...selectionIds.value]);
  const protectedIndices = rows.flatMap((row, index) => pinned.has(row.id) ? [index] : []);
  return { count: rows.length, getScrollElement: () => viewport.value,
    getItemKey: (index: number) => rows[index]!.id,
    estimateSize: (index: number) => estimateConversationRow(rows[index]),
    overscan: 8, scrollMargin: margin.value, anchorTo: 'end' as const,
    paddingEnd: viewport.value?.classList.contains('side-chat-transcript') ? 18 : 30,
    followOnAppend: true, scrollEndThreshold: 80,
    // Vue commits reactive styles after Core computes a resize correction.
    // Commit the sizer first so the browser cannot clamp that correction to
    // yesterday's scrollHeight. Core remains the only streaming scroll owner.
    scrollToFn: (offset: number, scrollOptions: { adjustments?: number; behavior?: ScrollBehavior }, instance: Virtualizer<HTMLElement, HTMLElement>) => {
      if (container.value) container.value.style.height = `${instance.getTotalSize()}px`;
      elementScroll(offset, scrollOptions, instance);
    },
    onChange: (instance: Virtualizer<HTMLElement, HTMLElement>) => {
      if (container.value) container.value.style.height = `${instance.getTotalSize()}px`;
    },
    rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) =>
      [...new Set([...defaultRangeExtractor(range), ...protectedIndices])].sort((a, b) => a - b),
  };
});
const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(options);
const visibleRows = computed(() => virtualizer.value.getVirtualItems());
const height = computed(() => virtualizer.value.getTotalSize());
function measure(value: Element | ComponentPublicInstance | null) {
  if (value instanceof HTMLElement) virtualizer.value.measureElement(value);
}
function updateMargin() {
  if (container.value && viewport.value) margin.value = container.value.getBoundingClientRect().top -
    viewport.value.getBoundingClientRect().top + viewport.value.scrollTop;
}
function selectionChanged() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !container.value) { selectionIds.value = []; return; }
  const range = selection.getRangeAt(0);
  selectionIds.value = [...container.value.querySelectorAll<HTMLElement>('[data-timeline-row]')]
    .filter(element => { try { return range.intersectsNode(element); } catch { return false; } })
    .map(element => element.dataset.timelineRow!);
}
onMounted(async () => {
  viewport.value = container.value?.closest<HTMLElement>('.conversation-scroll, .side-chat-transcript') || null;
  updateMargin();
  if (typeof ResizeObserver !== 'undefined') {
    geometry = new ResizeObserver(updateMargin);
    if (viewport.value) geometry.observe(viewport.value);
    if (container.value?.parentElement) geometry.observe(container.value.parentElement);
  }
  document.addEventListener('selectionchange', selectionChanged);
  await nextTick();
  if (props.initialReading && !props.initialReading.bottom) await restoreReading(props.initialReading);
  else virtualizer.value.scrollToEnd();
});
onBeforeUnmount(() => { geometry?.disconnect(); document.removeEventListener('selectionchange', selectionChanged); });
async function revealItem(itemId: string) {
  const index = props.rows.findIndex(row => row.item?.id === itemId || row.id === itemId);
  if (index < 0) return false;
  virtualizer.value.scrollToIndex(index, { align: 'center' });
  await nextTick();
  return true;
}
async function restoreReading(position: ReadingPosition) {
  const id = position.anchor?.historyId;
  const index = id ? props.rows.findIndex(row => row.id === id || row.item?.id === id || row.turnId === id) : -1;
  if (index >= 0) {
    virtualizer.value.scrollToIndex(index, { align: 'start' });
    await nextTick();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const row = container.value?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (row && viewport.value) {
      virtualizer.value.cancelScroll();
      viewport.value.scrollTop += row.getBoundingClientRect().top - viewport.value.getBoundingClientRect().top - (position.anchor?.offset || 0);
    }
  } else if (viewport.value) viewport.value.scrollTop = position.top;
}
function scrollToLatest() { virtualizer.value.scrollToEnd(); }
function refresh() { updateMargin(); }
defineExpose({ revealItem, restoreReading, scrollToLatest, refresh });
</script>

<template>
  <div ref="container" class="virtual-timeline" data-virtual-timeline :data-row-count="rows.length" :style="{ height: height + 'px' }">
    <div v-for="entry in visibleRows" :key="String(entry.key)" :ref="measure" :data-index="entry.index"
      :data-timeline-row="rows[entry.index]!.id" :data-history-id="rows[entry.index]!.id"
      class="virtual-timeline-row" :style="{ transform: `translateY(${entry.start - margin}px)` }">
      <slot :row="rows[entry.index]!" />
    </div>
  </div>
</template>

<style scoped>
.virtual-timeline { position: relative; width: 100%; min-width: 0; overflow-anchor: none; }
.virtual-timeline-row { position: absolute; top: 0; left: 0; width: 100%; min-width: 0; display: flow-root; overflow-anchor: none; }
</style>

<style>
/* Include trailing whitespace in Core's measured extent rather than leaving
   an unaccounted gap outside the virtual list during streaming growth. */
.message-list:has(> [data-virtual-timeline]), .side-chat-transcript:has(> [data-virtual-timeline]) { padding-bottom: 0; }
</style>
