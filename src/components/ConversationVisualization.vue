<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { hostBasename } from '../../shared/host-path';
import type { ConversationVisualization } from '../lib/conversation-visualization';
import { useCodex } from '../lib/useCodex';
import { visualizationFrame } from '../lib/visualization-frame';

const props = defineProps<{ reference: ConversationVisualization; hostId: string }>();
const { readFile } = useCodex();
const container = ref<HTMLElement>();
const frame = ref<HTMLIFrameElement>();
const visible = ref(false);
const attempt = ref(0);
const source = ref('');
const height = ref(160);
const error = ref('');
const title = computed(() => props.reference.title || hostBasename(props.reference.path));
let observer: IntersectionObserver | undefined;

watch(() => [visible.value, props.hostId, props.reference.path, attempt.value] as const,
  async ([canLoad, hostId, path], _previous, onCleanup) => {
    if (!canLoad) return;
    source.value = '';
    height.value = 160;
    error.value = '';
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    try {
      const file = await readFile(path, { hostId, silentError: true, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (file.binary || !file.content.trim()) { error.value = '图表文件为空或无法解析。'; return; }
      source.value = visualizationFrame(file.content);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const status = (cause as { status?: number })?.status;
      error.value = status === 404 ? '找不到图表文件，可能已移动或删除。' : '图表加载失败，请重试。';
    }
  },
);

function resize(event: MessageEvent) {
  if (event.origin !== 'null' || event.source !== frame.value?.contentWindow ||
      event.data?.type !== 'codex-visualization-height' || !Number.isFinite(event.data.height)) return;
  height.value = Math.min(1600, Math.max(1, Math.ceil(event.data.height)));
}

onMounted(() => {
  window.addEventListener('message', resize);
  observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting) return;
    visible.value = true;
    observer?.disconnect();
  }, { rootMargin: '160px' });
  observer.observe(container.value!);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener('message', resize);
});
</script>

<template>
  <section ref="container" class="conversation-visualization" data-selection-ignore="true">
    <iframe v-if="source" ref="frame" :srcdoc="source" :title="title" :style="{ height: height + 'px' }"
      sandbox="allow-scripts" referrerpolicy="no-referrer" />
    <div v-else class="visualization-status">
      <span role="status">{{ error || '正在加载图表…' }}</span>
      <button v-if="error" type="button" class="button button-small button-secondary" @click="attempt++">重试</button>
    </div>
  </section>
</template>

<style scoped>
.conversation-visualization { min-width: 0; margin-block: 14px; }
iframe { display: block; width: 100%; border: 0; }
.visualization-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 36px; color: var(--muted); font-size: 13px; }
</style>
