<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
const props = defineProps<{ enabled: boolean; pinned?: boolean }>();
const element = ref<HTMLElement>();
const visible = ref(true), selected = ref(false), height = ref(0);
const mounted = computed(() => !props.enabled || props.pinned || selected.value || visible.value || !height.value);
let intersection: IntersectionObserver | undefined, resize: ResizeObserver | undefined;
function measure() { if (mounted.value && element.value) height.value = element.value.getBoundingClientRect().height; }
function selection() {
  const range = window.getSelection();
  try { selected.value = !!range && !range.isCollapsed && range.rangeCount > 0 && !!element.value && range.getRangeAt(0).intersectsNode(element.value); }
  catch { selected.value = false; }
}
onMounted(() => {
  measure();
  if (!('IntersectionObserver' in window) || !('ResizeObserver' in window)) return;
  let root = element.value?.parentElement || null;
  while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
  intersection = new IntersectionObserver(entries => {
    for (const entry of entries) { if (!entry.isIntersecting) { measure(); selection(); } visible.value = entry.isIntersecting; }
  }, { root, rootMargin: '1000px 0px' });
  intersection.observe(element.value!);
  resize = new ResizeObserver(measure); resize.observe(element.value!);
  document.addEventListener('selectionchange', selection);
});
watch(mounted, async value => { if (value) { await nextTick(); measure(); } });
onBeforeUnmount(() => { intersection?.disconnect(); resize?.disconnect(); document.removeEventListener('selectionchange', selection); });
</script>
<template><div ref="element" class="virtual-history-block" :style="mounted ? undefined : { height: height + 'px' }"><slot v-if="mounted"></slot></div></template>
<style scoped>.virtual-history-block { display:flow-root; min-width:0; overflow-anchor:auto }</style>
