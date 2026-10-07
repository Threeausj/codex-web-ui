<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps<{ dataBase64: string; name: string }>();
const canvas = ref<HTMLCanvasElement>();
const page = ref(1), count = ref(0), zoom = ref(1), busy = ref(false), error = ref('');
let document: PDFDocumentProxy | undefined, task: ReturnType<typeof getDocument> | undefined, renderTask: RenderTask | undefined, generation = 0;
const label = computed(() => `${props.name} · 第 ${page.value} 页`);
async function render() {
  const current = ++generation;
  const previous = renderTask; previous?.cancel();
  await previous?.promise.catch(() => {});
  if (!document || current !== generation) return;
  busy.value = true; error.value = '';
  try {
    const pdfPage = await document.getPage(page.value);
    await nextTick();
    if (current !== generation || !canvas.value) return;
    const viewport = pdfPage.getViewport({ scale: zoom.value });
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
    canvas.value.width = Math.ceil(viewport.width * ratio); canvas.value.height = Math.ceil(viewport.height * ratio);
    canvas.value.style.width = `${viewport.width}px`; canvas.value.style.height = `${viewport.height}px`;
    renderTask = pdfPage.render({ canvas: canvas.value, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
    await renderTask.promise;
  } catch (cause: any) { if (current === generation && cause.name !== 'RenderingCancelledException') error.value = cause.message || 'PDF 渲染失败'; }
  finally { if (current === generation) busy.value = false; }
}
async function load() {
  const current = ++generation;
  const previous = task; task = undefined;
  renderTask?.cancel(); document = undefined; count.value = 0; page.value = 1;
  busy.value = true; error.value = '';
  try {
    await previous?.destroy();
    if (current !== generation) return;
    const bytes = Uint8Array.from(atob(props.dataBase64), c => c.charCodeAt(0));
    const loading = getDocument({ data: bytes, enableXfa: false }); task = loading;
    const loaded = await loading.promise;
    if (current !== generation) { await loading.destroy(); return; }
    document = loaded; count.value = loaded.numPages; await render();
  } catch (cause: any) { if (current === generation) { error.value = cause.message || 'PDF 读取失败，可下载查看'; busy.value = false; } }
}
watch(() => props.dataBase64, () => void load());
watch([page, zoom], () => { if (document) void render(); });
onMounted(() => void load());
onBeforeUnmount(() => { ++generation; renderTask?.cancel(); void task?.destroy(); });
</script>
<template>
  <section class="pdf-preview" aria-label="PDF 预览">
    <div class="pdf-toolbar">
      <button class="button button-small button-secondary" :disabled="page <= 1" @click="page--">上一页</button>
      <span>{{ page }} / {{ count || '…' }}</span>
      <button class="button button-small button-secondary" :disabled="page >= count" @click="page++">下一页</button>
      <select v-model.number="zoom" aria-label="PDF 缩放"><option :value="0.5">50%</option><option :value="0.75">75%</option><option :value="1">100%</option><option :value="1.5">150%</option><option :value="2">200%</option></select>
      <span v-if="busy" role="status">加载中…</span>
    </div>
    <p v-if="error" class="panel-error" role="alert">{{ error }}</p>
    <div class="pdf-page"><canvas ref="canvas" role="img" :aria-label="label"></canvas></div>
  </section>
</template>
<style scoped>
.pdf-preview { display:flex; flex-direction:column; flex:1; min-height:0 }
.pdf-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px; font-size:12px }
.pdf-page { flex:1; min-height:0; overflow:auto; padding:12px; background:#525659 }
.pdf-page canvas { display:block; margin:auto; background:white }
</style>
