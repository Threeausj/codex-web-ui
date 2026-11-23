<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import mermaidScript from '@mermaid-js/tiny/dist/mermaid.tiny.js?url';
import frameHtml from '../lib/mermaid-frame.html?raw';
import frameScript from '../lib/mermaid-frame.js?raw';
import { randomUUID } from '../lib/uuid';
import Icon from './Icon.vue';

const props = defineProps<{ source: string }>();
const container = ref<HTMLElement>();
const frame = ref<HTMLIFrameElement>();
const visible = ref(false);
const failed = ref(false);
const height = ref(80);
const minimumWidth = ref(0);
const availableWidth = ref(0);
const enlarged = ref(false);
const canEnlarge = computed(() => availableWidth.value > 0 && minimumWidth.value > availableWidth.value);
let observer: IntersectionObserver | undefined;
let sizeObserver: ResizeObserver | undefined;
let timeout: number | undefined;
const nonce = randomUUID();

const frameDocument = computed(() => {
  const fields: Record<string, string> = {
    ASSET: new URL(mermaidScript, location.href).href,
    NONCE: nonce,
    SOURCE: JSON.stringify(props.source).replace(/</g, '\\u003c'),
    RENDER: frameScript,
  };
  return frameHtml.replace(/__(ASSET|NONCE|SOURCE|RENDER)__/g, (_, key: string) => fields[key]!);
});

watch(() => [visible.value, props.source] as const, ([show, source]) => {
  window.clearTimeout(timeout);
  failed.value = !source.trim() || source.length > 24_000;
  height.value = 80;
  minimumWidth.value = 0;
  enlarged.value = false;
  if (show && !failed.value) timeout = window.setTimeout(() => { failed.value = true; }, 20_000);
}, { immediate: true });

function rendered(event: MessageEvent) {
  if (event.origin !== 'null' || event.source !== frame.value?.contentWindow || event.data?.type !== 'mermaid-diagram') return;
  const { height: chartHeight, minimumWidth: chartWidth, failed: renderFailed } = event.data;
  if (renderFailed === true || Number.isFinite(chartHeight) && chartHeight > 24_000) {
    window.clearTimeout(timeout);
    failed.value = true;
    return;
  }
  if (!Number.isFinite(chartHeight) || !Number.isFinite(chartWidth)) return;
  window.clearTimeout(timeout);
  height.value = Math.max(1, chartHeight);
  minimumWidth.value = Math.max(0, Math.min(4800, chartWidth));
}

onMounted(() => {
  window.addEventListener('message', rendered);
  observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting) return;
    visible.value = true;
    observer?.disconnect();
  }, { rootMargin: '180px' });
  observer.observe(container.value!);
  sizeObserver = new ResizeObserver(([entry]) => { availableWidth.value = entry?.contentRect.width || 0; });
  sizeObserver.observe(container.value!);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  sizeObserver?.disconnect();
  window.clearTimeout(timeout);
  window.removeEventListener('message', rendered);
});
</script>

<template>
  <section ref="container" class="mermaid-diagram" data-selection-ignore="true">
    <template v-if="failed">
      <p role="status" class="diagram-status">流程图无法渲染，已保留源码。</p>
      <pre><code>{{ source }}</code></pre>
    </template>
    <template v-else>
      <div v-if="canEnlarge" class="diagram-controls">
        <button type="button" class="button button-small button-secondary" @click="enlarged = !enlarged">
          <Icon :name="enlarged ? 'Minimize2' : 'Maximize2'" :size="13" />
          {{ enlarged ? '适应宽度' : '放大流程图' }}
        </button>
      </div>
      <div class="diagram-scroll" role="region" aria-label="Mermaid 流程图" :tabindex="canEnlarge && enlarged ? 0 : undefined">
        <iframe v-if="visible" :key="source" ref="frame" :srcdoc="frameDocument" title="Mermaid 流程图" tabindex="-1"
          :style="{ height: height + 'px', minWidth: enlarged ? minimumWidth + 'px' : undefined }" sandbox="allow-scripts" referrerpolicy="no-referrer" />
        <p v-else class="diagram-status">正在加载流程图…</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.mermaid-diagram { min-width: 0; margin-block: 14px; }
.diagram-controls { display: flex; justify-content: flex-end; margin-bottom: 4px; }
.diagram-scroll { overflow-x: auto; overscroll-behavior-x: contain; }
.diagram-scroll iframe { display: block; width: 100%; border: 0; pointer-events: none; }
.diagram-status { color: var(--muted); font-size: 12px; }
@media (pointer: coarse) { .diagram-controls .button { min-height: 36px; } }
</style>
