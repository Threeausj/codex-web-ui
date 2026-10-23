<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { officeFileKind } from '../lib/file-preview';
import { MAX_OFFICE_BYTES, sheetColumn, SHEET_PAGE_COLUMNS, SHEET_PAGE_ROWS, type SpreadsheetPage } from '../lib/office-preview';
import type { PptxViewer } from '@aiden0z/pptx-renderer';
const props = defineProps<{ dataBase64: string; name: string }>();
const emit = defineEmits<{ download: [] }>();
const kind = computed(() => officeFileKind(props.name));
const spreadsheet = computed(() => ['xlsx', 'xls'].includes(kind.value || ''));
const frame = ref<HTMLIFrameElement>();
const busy = ref(false), error = ref(''), page = ref(1), count = ref(0), zoom = ref(100);
const sheet = ref<SpreadsheetPage>();
let worker: Worker | undefined, viewer: PptxViewer | undefined, generation = 0, requestId = 0;
let abort: AbortController | undefined;
let pending: { id: number; resolve: (value: any) => void; reject: (cause: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
let docPages: HTMLElement[] = [];
const columns = computed(() => sheet.value ? Array.from({ length: sheet.value.columnEnd - sheet.value.columnStart }, (_, i) => sheetColumn(sheet.value!.columnStart + i)) : []);
const pageCount = computed(() => spreadsheet.value ? Math.ceil((sheet.value?.rowCount || 0) / SHEET_PAGE_ROWS) : count.value);
const currentPage = computed(() => spreadsheet.value ? Math.floor((sheet.value?.rowStart || 0) / SHEET_PAGE_ROWS) + 1 : page.value);
const frameDocument = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;min-height:100%;background:#eef0f3;color:#16181d;font-family:Arial,'Noto Sans SC',sans-serif}#office-content{min-height:100vh;box-sizing:border-box;padding:12px;overflow:auto}section[hidden]{display:none!important}.office-docx-wrapper{padding:0!important;background:transparent!important}.office-docx-wrapper>section{margin:0 auto!important;max-width:none;box-shadow:0 1px 6px #0002}a{color:inherit;text-decoration:none;pointer-events:none}</style></head><body><div id="office-content"></div></body></html>`;

function cleanup() {
  abort?.abort(); abort = undefined;
  worker?.terminate(); worker = undefined;
  viewer?.destroy(); viewer = undefined;
  if (pending) { clearTimeout(pending.timer); pending.reject(new DOMException('Cancelled', 'AbortError')); pending = undefined; }
  docPages = [];
  if (frame.value) frame.value.srcdoc = '';
}
function workerRequest(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> {
  const active = worker;
  if (!active) return Promise.reject(new Error('预览已关闭'));
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending?.id !== id) return;
      pending = undefined; active.terminate(); if (worker === active) worker = undefined;
      reject(new Error('Office 文件解析超时，请下载原文件查看'));
    }, 20000);
    pending = { id, resolve, reject, timer };
    active.postMessage({ ...message, id }, transfer);
  });
}
async function readyFrame(signal: AbortSignal): Promise<HTMLElement> {
  await nextTick();
  const element = frame.value;
  if (!element) throw new Error('无法创建文档预览');
  await new Promise<void>((resolve, reject) => {
    const cancelled = () => { element.removeEventListener('load', loaded); reject(new DOMException('Cancelled', 'AbortError')); };
    const loaded = () => { signal.removeEventListener('abort', cancelled); resolve(); };
    element.addEventListener('load', loaded, { once: true });
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) { cancelled(); return; }
    element.srcdoc = frameDocument;
  });
  signal.throwIfAborted();
  const doc = element.contentDocument;
  if (!doc) throw new Error('浏览器无法打开文档预览');
  // Preview links are inert. Embedded content cannot navigate a sandboxed
  // frame to a remote URL or submit forms, even when a document contains links.
  doc.addEventListener('click', event => {
    if ((event.target as Element)?.closest?.('a,form')) event.preventDefault();
    // Internal slide links can be attached to ordinary shapes, not anchors.
    // Keep navigation in the toolbar so its page state cannot drift.
    event.stopPropagation();
  }, true);
  return doc.getElementById('office-content')!;
}
async function load() {
  const current = ++generation;
  cleanup(); sheet.value = undefined; error.value = ''; busy.value = true; page.value = 1; count.value = 0; zoom.value = 100;
  const controller = abort = new AbortController();
  try {
    if (!kind.value || kind.value === 'legacy') throw new Error('旧版 DOC／PPT 暂不支持浏览器预览，请下载原文件，或另存为 DOCX／PPTX');
    if (props.dataBase64.length > Math.ceil(MAX_OFFICE_BYTES / 3) * 4) throw new Error('Office 预览上限为 8 MB，请下载原文件查看');
    const bytes = Uint8Array.from(atob(props.dataBase64), char => char.charCodeAt(0));
    const active = worker = new Worker(new URL('../lib/office-workbook.worker.ts', import.meta.url), { type: 'module' });
    active.onmessage = event => {
      if (worker !== active || !pending || pending.id !== event.data.id) return;
      const result = pending; pending = undefined; clearTimeout(result.timer);
      if (event.data.error) result.reject(new Error(event.data.error)); else result.resolve(event.data);
    };
    active.onerror = () => { if (worker === active && pending) { const result = pending; pending = undefined; clearTimeout(result.timer); result.reject(new Error('Office 预览组件加载失败，请重试或下载原文件')); } };
    const prepared = await workerRequest({ type: 'load', bytes, kind: kind.value }, [bytes.buffer]);
    if (current !== generation) return;
    if (prepared.page) { sheet.value = prepared.page; return; }
    active.terminate(); worker = undefined;
    const target = await readyFrame(controller.signal);
    if (current !== generation) return;
    if (kind.value === 'docx') {
      const { renderAsync } = await import('docx-preview');
      if (current !== generation) return;
      // renderAsync clears its style container; keep the frame's CSP and our
      // layout stylesheet in a separate, untouched head.
      const styles = target.ownerDocument.createElement('div'); target.before(styles);
      await renderAsync(prepared.bytes, target, styles, { className: 'office-docx', inWrapper: true,
        ignoreFonts: true, breakPages: true, ignoreLastRenderedPageBreak: false, useBase64URL: true,
        renderAltChunks: false, renderComments: false, renderChanges: false });
      if (current !== generation) return;
      docPages = [...target.querySelectorAll<HTMLElement>('section.office-docx')];
      count.value = Math.max(1, docPages.length);
      if (count.value > 1000) throw new Error('文档页数过多，请下载原文件查看');
      showDocPage();
    } else {
      const { PptxViewer } = await import('@aiden0z/pptx-renderer');
      if (current !== generation) return;
      const instance = viewer = new PptxViewer(target, { externalMedia: 'block', pdfjs: false, fitMode: 'contain', lazySlides: true, lazyMedia: true,
        zipLimits: { maxEntries: 2000, maxEntryUncompressedBytes: 8 * 1024 * 1024, maxTotalUncompressedBytes: 32 * 1024 * 1024, maxMediaBytes: 24 * 1024 * 1024, maxConcurrency: 2 } });
      await instance.open(prepared.bytes, { renderMode: 'slide', signal: controller.signal });
      if (current !== generation) return;
      count.value = instance.slideCount;
      if (!count.value || count.value > 1000) throw new Error('演示文稿页数不受支持，请下载原文件查看');
    }
  } catch (cause: any) { if (current === generation && cause.name !== 'AbortError') { error.value = cause.message || 'Office 预览失败，请下载原文件查看'; cleanup(); } }
  finally { if (current === generation) busy.value = false; }
}
function showDocPage() { docPages.forEach((element, index) => { element.hidden = index !== page.value - 1; }); }
async function changePage(delta: number) {
  if (busy.value) return;
  if (spreadsheet.value) { await readSheet(sheet.value!.sheetIndex, sheet.value!.rowStart + delta * SHEET_PAGE_ROWS, sheet.value!.columnStart); return; }
  const next = Math.max(1, Math.min(count.value, page.value + delta)), current = generation;
  if (next === page.value) return;
  busy.value = true; error.value = '';
  try { if (viewer) await viewer.goToSlide(next - 1); if (current === generation) { page.value = next; showDocPage(); } }
  catch (cause: any) { if (current === generation) error.value = cause.message || '读取页面失败，请重试'; }
  finally { if (current === generation) busy.value = false; }
}
async function readSheet(index: number, rowStart = 0, columnStart = 0) {
  if (busy.value) return;
  const current = generation; busy.value = true; error.value = '';
  try { const result = await workerRequest({ type: 'page', sheetIndex: index, rowStart, columnStart }); if (current === generation) sheet.value = result.page; }
  catch (cause: any) { if (current === generation && cause.name !== 'AbortError') error.value = cause.message || '读取工作表失败，请重试'; }
  finally { if (current === generation) busy.value = false; }
}
async function changeZoom() {
  const current = generation;
  try {
    if (viewer) await viewer.setZoom(zoom.value);
    else if (frame.value?.contentDocument?.body) frame.value.contentDocument.body.style.zoom = String(zoom.value / 100);
  } catch { if (current === generation) error.value = '调整缩放失败，请重试'; }
}
watch(() => [props.dataBase64, props.name], () => void load(), { immediate: true, flush: 'post' });
onBeforeUnmount(() => { ++generation; cleanup(); });
</script>

<template>
  <section class="office-preview" aria-label="Office 文件预览">
    <div class="office-toolbar">
      <select v-if="sheet" aria-label="选择工作表" :value="sheet.sheetIndex" :disabled="busy" @change="readSheet(Number(($event.target as HTMLSelectElement).value))"><option v-for="(name, index) in sheet.sheetNames" :key="index" :value="index">{{ name }}</option></select>
      <button class="button button-small button-secondary" :disabled="busy || currentPage <= 1" @click="changePage(-1)">上一页</button>
      <span aria-label="Office 页码">{{ currentPage }} / {{ pageCount || '…' }}</span>
      <button class="button button-small button-secondary" :disabled="busy || currentPage >= pageCount" @click="changePage(1)">下一页</button>
      <select v-if="!spreadsheet && kind !== 'legacy'" v-model.number="zoom" aria-label="Office 缩放" :disabled="busy" @change="changeZoom"><option :value="50">50%</option><option :value="75">75%</option><option :value="100">100%</option><option :value="125">125%</option><option :value="150">150%</option></select>
      <span v-if="busy" role="status">正在加载 Office 文档…</span>
    </div>
    <div v-if="error" class="office-error" role="alert"><p>{{ error }}</p><button class="button button-small button-secondary" :disabled="busy" @click="load">重试预览</button><button class="button button-small" @click="emit('download')">下载原文件</button></div>
    <template v-if="sheet">
      <div class="office-sheet-info"><span>第 {{ sheet.rowStart + 1 }}–{{ sheet.rowEnd }} 行，共 {{ sheet.rowCount }} 行 · {{ sheet.columnCount }} 列</span><div><button class="button button-small button-secondary" aria-label="上一组列" :disabled="busy || sheet.columnStart === 0" @click="readSheet(sheet.sheetIndex, sheet.rowStart, sheet.columnStart - SHEET_PAGE_COLUMNS)">← 列</button><span>{{ sheetColumn(sheet.columnStart) }}–{{ sheetColumn(sheet.columnEnd - 1) }}</span><button class="button button-small button-secondary" aria-label="下一组列" :disabled="busy || sheet.columnEnd >= sheet.columnCount" @click="readSheet(sheet.sheetIndex, sheet.rowStart, sheet.columnStart + SHEET_PAGE_COLUMNS)">列 →</button></div></div>
      <p v-if="sheet.limited" class="office-note">仅预览前 10,000 行，下载原文件可查看完整工作表。</p>
      <div class="office-sheet-scroll"><table aria-label="工作表内容"><thead><tr><th></th><th v-for="column in columns" :key="column" scope="col">{{ column }}</th></tr></thead><tbody><tr v-for="(row, index) in sheet.rows" :key="sheet.rowStart + index"><th scope="row">{{ sheet.rowStart + index + 1 }}</th><td v-for="(cell, column) in row" :key="column">{{ cell }}</td></tr></tbody></table></div>
    </template>
    <iframe v-else-if="kind === 'docx' || kind === 'pptx'" ref="frame" class="office-frame" :title="`${name} 只读预览`" sandbox="allow-same-origin" referrerpolicy="no-referrer" v-show="!error" />
    <p class="office-note">本地只读预览；复杂排版、图表或动画可能与 Office 不同。原文件保持不变。</p>
  </section>
</template>

<style scoped>
.office-preview{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden}
.office-toolbar,.office-sheet-info,.office-sheet-info>div{display:flex;align-items:center;flex-wrap:wrap;gap:7px}
.office-toolbar,.office-sheet-info{padding:8px 10px;font-size:12px;border-bottom:1px solid var(--border);flex-shrink:0}
.office-toolbar select{max-width:220px;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)}
.office-toolbar>span[role=status]{color:var(--muted)}
.office-frame{flex:1;min-width:0;min-height:180px;width:100%;border:0;background:#eef0f3}
.office-error{padding:12px;color:var(--danger);font-size:12px;line-height:1.7;flex-shrink:0}.office-error p{margin:0 0 10px}.office-error .button{margin-right:8px}
.office-note{margin:0;padding:7px 10px;font-size:11px;line-height:1.6;color:var(--muted);flex-shrink:0}
.office-sheet-info{justify-content:space-between}.office-sheet-info .button{padding:3px 6px;min-height:28px}
.office-sheet-scroll{overflow:auto;flex:1;min-height:0}.office-sheet-scroll table{border-collapse:separate;border-spacing:0;font-size:12px;min-width:100%;background:var(--surface)}
.office-sheet-scroll :is(th,td){padding:7px 9px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);text-align:left;max-width:360px;min-width:85px;white-space:pre-wrap;overflow-wrap:anywhere}
.office-sheet-scroll thead th{position:sticky;top:0;z-index:2;background:var(--hover);font-weight:500}.office-sheet-scroll tbody th{position:sticky;left:0;z-index:1;background:var(--hover);font-weight:400;min-width:35px;font-variant-numeric:tabular-nums}.office-sheet-scroll thead th:first-child{left:0;z-index:3;min-width:35px}
@media(max-width:760px){.office-toolbar .button{min-height:40px}.office-toolbar select{max-width:180px;min-height:40px;font-size:16px}.office-sheet-info{font-size:11px}.office-sheet-info .button{min-height:38px}}
</style>
