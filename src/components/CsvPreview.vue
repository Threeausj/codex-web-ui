<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { CSV_PAGE_ROWS, CSV_PAGE_COLUMNS } from '../lib/csv-preview';
const props = defineProps<{ content: string; name: string; encoding?: string }>();
const delimiter = ref(''), firstHeader = ref(true), busy = ref(false), error = ref(''), page = ref<any>(null);
let worker: Worker | undefined, request = 0, timer: ReturnType<typeof setTimeout> | undefined;
const offset = () => firstHeader.value ? 1 : 0;
const rowCount = computed(() => Math.max(0, (page.value?.rowCount || 0) - offset()));
const currentPage = computed(() => page.value ? Math.floor(Math.max(0, page.value.rowStart - offset()) / CSV_PAGE_ROWS) + 1 : 1);
const pages = computed(() => Math.max(1, Math.ceil(rowCount.value / CSV_PAGE_ROWS)));
const columns = computed(() => page.value ? Array.from({ length: Math.min(CSV_PAGE_COLUMNS, page.value.columnCount - page.value.columnStart) }, (_, i) => page.value.columnStart + i) : []);
function send(type: string, row = offset(), column = 0) {
  if (!worker) return;
  busy.value = true; error.value = '';
  const id = ++request; clearTimeout(timer);
  timer = setTimeout(() => { if (id === request) { error.value = 'CSV 解析超时，请下载原文件查看'; busy.value = false; worker?.terminate(); worker = undefined; } }, 15000);
  worker.postMessage({ id, type, ...(type === 'load' ? { content: props.content, delimiter: delimiter.value || (/\.tsv$/i.test(props.name) ? '\t' : undefined) } : {}), row, column });
}
function load() {
  worker?.terminate(); clearTimeout(timer); page.value = null;
  const active = worker = new Worker(new URL('../lib/csv-preview.worker.ts', import.meta.url), { type: 'module' });
  active.onmessage = event => { if (active !== worker || event.data.id !== request) return; clearTimeout(timer); busy.value = false; if (event.data.error) error.value = event.data.error; else page.value = event.data; };
  active.onerror = () => { if (worker === active) { clearTimeout(timer); busy.value = false; error.value = 'CSV 组件加载失败，请重试或下载原文件'; active.terminate(); worker = undefined; } };
  send('load');
}
watch([() => props.content, () => props.name, delimiter], load, { immediate: true });
watch(firstHeader, () => send('page'));
onBeforeUnmount(() => { ++request; clearTimeout(timer); worker?.terminate(); });
</script>
<template>
  <section class="csv-preview" aria-label="CSV 表格预览" :aria-busy="busy">
    <div class="csv-toolbar">
      <span>{{ rowCount }} 行 · {{ page?.columnCount || 0 }} 列<span v-if="encoding"> · {{ encoding }}</span></span>
      <label>分隔符<select v-model="delimiter" aria-label="CSV 分隔符"><option value="">自动</option><option value=",">逗号</option><option value=";">分号</option><option :value="'\t'">Tab</option></select></label>
      <label><input v-model="firstHeader" type="checkbox" />首行为表头</label>
    </div>
    <p v-if="error" class="csv-notice" role="alert">{{ error }} <button class="button button-small" @click="load">重试</button></p>
    <p v-else-if="busy && !page" class="csv-notice" role="status">正在解析 CSV…</p>
    <template v-if="page">
      <p v-if="page.truncated || page.warning" class="csv-notice" role="status">{{ page.truncated ? '表格较大，当前仅展示预览范围，请下载原文件查看完整内容。' : page.warning }}</p>
      <p v-if="page.clipped" class="csv-notice" role="status">部分单元格内容较长，已缩短显示；切换源码或下载可查看完整内容。</p>
      <div class="csv-scroll" tabindex="0" aria-label="CSV 表格内容">
        <table><thead><tr><th scope="col">#</th><th v-for="(column, i) in columns" :key="column" scope="col">{{ firstHeader ? page.header[i] || `列 ${column + 1}` : `列 ${column + 1}` }}</th></tr></thead>
          <tbody><tr v-for="(row, index) in page.rows" :key="page.rowStart + index"><th scope="row">{{ page.rowStart + index + 1 }}</th><td v-for="(column, i) in columns" :key="column" :title="row[i] || ''">{{ row[i] || '' }}</td></tr></tbody>
        </table>
        <p v-if="!rowCount" class="csv-notice">没有数据行</p>
      </div>
      <div class="csv-pagination">
        <button class="icon-button" :disabled="busy || currentPage <= 1" aria-label="CSV 上一页" @click="send('page', Math.max(offset(), page.rowStart - CSV_PAGE_ROWS), page.columnStart)"><Icon name="ChevronDown" class="previous" :size="16" /></button>
        <span>第 {{ currentPage }} / {{ pages }} 页</span>
        <button class="icon-button" :disabled="busy || currentPage >= pages" aria-label="CSV 下一页" @click="send('page', page.rowStart + CSV_PAGE_ROWS, page.columnStart)"><Icon name="ChevronRight" :size="16" /></button>
        <template v-if="page.columnCount > CSV_PAGE_COLUMNS"><button class="button button-small" :disabled="busy || !page.columnStart" @click="send('page', page.rowStart, Math.max(0, page.columnStart - CSV_PAGE_COLUMNS))">前 {{ CSV_PAGE_COLUMNS }} 列</button><span>{{ page.columnStart + 1 }}–{{ page.columnStart + columns.length }} 列</span><button class="button button-small" :disabled="busy || page.columnStart + columns.length >= page.columnCount" @click="send('page', page.rowStart, page.columnStart + CSV_PAGE_COLUMNS)">后 {{ CSV_PAGE_COLUMNS }} 列</button></template>
      </div>
    </template>
  </section>
</template>
<style scoped>
.csv-preview{display:flex;flex-direction:column;min-height:0;flex:1;overflow:hidden}.csv-toolbar,.csv-pagination{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:9px 12px;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}.csv-toolbar>span{margin-right:auto}.csv-toolbar label{display:flex;align-items:center;gap:6px}.csv-toolbar select{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:4px}.csv-scroll{flex:1;min-height:0;overflow:auto}table{border-collapse:separate;border-spacing:0;min-width:100%;font-size:12px}th,td{padding:8px 12px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);max-width:420px;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:var(--soft);z-index:1;font-weight:600;color:var(--text)}tbody th{color:var(--muted);font-weight:400;background:var(--surface)}td{color:var(--text)}tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--soft) 45%,var(--surface))}.csv-notice{padding:12px;color:var(--muted);font-size:12px}.csv-pagination{justify-content:center;border-top:1px solid var(--border);border-bottom:0}.previous{transform:rotate(90deg)}

th,td{min-width:120px}th:first-child{min-width:44px;width:44px;position:sticky;left:0}thead th:first-child{z-index:2}
</style>
