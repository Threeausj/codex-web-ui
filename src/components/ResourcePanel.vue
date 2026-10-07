<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import ResourceMetricChart from './ResourceMetricChart.vue';

const props = defineProps<{ api: any; state: any }>();
const emit = defineEmits<{ close: [] }>();
const hostId = ref(props.state.hostId);
const host = computed(() => props.state.hosts.find((entry: any) => entry.id === hostId.value));
const snapshot = ref<any>(null);
const samples = ref<any[]>([]);
const loading = ref(false);
const pending = ref(false);
const error = ref('');
const notice = ref('');
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let disposed = false;
const number = (value: unknown, suffix = '') => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) + suffix : '—';
function bytes(value: unknown, suffix = '') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const size = Math.max(0, value);
  if (size >= 1073741824) return (size / 1073741824).toFixed(1) + ' GiB' + suffix;
  if (size >= 1048576) return (size / 1048576).toFixed(1) + ' MiB' + suffix;
  if (size >= 1024) return (size / 1024).toFixed(1) + ' KiB' + suffix;
  return Math.round(size) + ' B' + suffix;
}
const charts = computed(() => [
  { key: 'cpu', title: 'CPU', value: number(snapshot.value?.cpu?.usagePercent, '%'), detail: `负载 ${snapshot.value?.cpu?.load?.map((value: number) => number(value)).join(' / ') || '—'} · ${snapshot.value?.cpu?.cores || '—'} 核`, labels: ['CPU'], percent: true,
    points: samples.value.map(sample => ({ at: sample.sampledAt, values: [sample.cpu?.usagePercent ?? null] })) },
  { key: 'memory', title: '内存', value: number(snapshot.value?.memory?.usagePercent, '%'), detail: `${bytes(snapshot.value?.memory?.usedBytes)} / ${bytes(snapshot.value?.memory?.totalBytes)}`, labels: ['内存'], percent: true,
    points: samples.value.map(sample => ({ at: sample.sampledAt, values: [sample.memory?.usagePercent ?? null] })) },
  { key: 'network', title: '网络', value: bytes(snapshot.value?.network?.rxBytesPerSecond, '/s ↓'), detail: bytes(snapshot.value?.network?.txBytesPerSecond, '/s ↑'), labels: ['接收', '发送'], percent: false,
    points: samples.value.map(sample => ({ at: sample.sampledAt, values: [sample.network?.rxBytesPerSecond ?? null, sample.network?.txBytesPerSecond ?? null] })) },
  { key: 'disk', title: '磁盘 I/O', value: bytes(snapshot.value?.disk?.readBytesPerSecond, '/s 读'), detail: bytes(snapshot.value?.disk?.writeBytesPerSecond, '/s 写'), labels: ['读取', '写入'], percent: false,
    points: samples.value.map(sample => ({ at: sample.sampledAt, values: [sample.disk?.readBytesPerSecond ?? null, sample.disk?.writeBytesPerSecond ?? null] })) },
]);
function stopPolling() { clearTimeout(timer); controller?.abort(); controller = undefined; }
async function refresh() {
  if (disposed || pending.value || loading.value || !props.state.online || document.hidden) return;
  clearTimeout(timer);
  const selected = hostId.value;
  const operation = generation;
  controller = new AbortController();
  loading.value = true;
  try {
    const data = await props.api.http(`/hosts/${encodeURIComponent(selected)}/resources`, { signal: controller.signal }, false);
    if (disposed || operation !== generation || selected !== hostId.value || !props.state.authenticated) return;
    snapshot.value = data;
    if (!samples.value.some(sample => sample.sampledAt === data.sampledAt)) samples.value = [...samples.value, data].slice(-300);
    error.value = '';
  } catch (cause: any) {
    if (!disposed && operation === generation && cause?.name !== 'AbortError') error.value = cause?.message || '资源采集失败，请重试。';
  } finally {
    if (operation === generation) {
      loading.value = false;
      controller = undefined;
      if (!disposed && props.state.authenticated && props.state.online && !document.hidden) timer = setTimeout(() => void refresh(), 3500);
    }
  }
}
async function runtimeAction(resume: boolean) {
  const selected = hostId.value;
  if (!snapshot.value || pending.value || !props.state.online) return;
  if (!resume && !window.confirm(
    `关闭“${host.value?.name}”的 Web Codex 连接并释放 ${snapshot.value.runtime.loadedThreadCount} 个会话？\n\n此主机上所有 Web 页面的运行任务和交互终端将中断。网页会保持暂停，方便切换到桌面端或 CLI；可随时重新连接。`,
  )) return;
  stopPolling();
  ++generation;
  const operation = generation;
  loading.value = false;
  pending.value = true;
  error.value = ''; notice.value = '';
  try {
    const result = await props.api.http(`/hosts/${encodeURIComponent(selected)}/runtime/${resume ? 'resume' : 'close'}`, {
      method: 'POST', body: JSON.stringify(resume ? {} : { confirmed: true }),
    }, false);
    if (disposed || operation !== generation || !props.state.authenticated) return;
    snapshot.value = { ...snapshot.value, runtime: result.runtime };
    notice.value = resume ? 'Web Codex 已重新连接。' : 'Web Codex 已暂停，已释放会话供桌面端或 CLI 使用。';
    if (resume && props.state.hostId === selected) await props.api.resumeConnection({ explicit: true });
  } catch (cause: any) {
    if (!disposed && operation === generation) error.value = cause?.message || '操作失败，请重试。';
  } finally {
    if (operation === generation) { pending.value = false; void refresh(); }
  }
}
async function threadAction(thread: any, resume: boolean) {
  const selected = hostId.value;
  if (pending.value || !props.state.online) return;
  if (!resume && !window.confirm(`关闭“${thread.name}”的 Web 会话？\n\n该会话及其子智能体将停止，历史和草稿保留。其他会话继续运行，可切换桌面端或 CLI。`)) return;
  stopPolling(); ++generation; const operation = generation; loading.value = false; pending.value = true;
  error.value = ''; notice.value = '';
  try {
    if (resume) await props.api.resumeThreadConnection(selected, thread.id);
    else {
      const result = await props.api.http(`/hosts/${encodeURIComponent(selected)}/runtime/threads/${encodeURIComponent(thread.id)}/close`, { method: 'POST', body: JSON.stringify({ confirmed: true }) }, false);
      props.api.updateReleasedThreads(selected, (result.runtime.threads || []).filter((entry: any) => entry.released).map((entry: any) => entry.id));
      if (!disposed && operation === generation) snapshot.value = { ...snapshot.value, runtime: result.runtime };
    }
    if (!disposed && operation === generation) notice.value = resume ? '会话已允许重新连接。' : `已关闭“${thread.name}”的 Web 连接。`;
  } catch (cause: any) {
    if (!disposed && operation === generation) error.value = cause?.message || '会话操作失败，请重试。';
  } finally { if (operation === generation) { pending.value = false; void refresh(); } }
}
function visibilityChanged() { if (document.hidden) stopPolling(); else void refresh(); }
watch(hostId, () => {
  ++generation; stopPolling(); loading.value = false; pending.value = false;
  snapshot.value = null; samples.value = []; error.value = ''; notice.value = ''; void refresh();
});
watch(() => props.state.online, online => { if (online) void refresh(); else stopPolling(); });
onMounted(() => { document.addEventListener('visibilitychange', visibilityChanged); void refresh(); });
onBeforeUnmount(() => { disposed = true; ++generation; stopPolling(); document.removeEventListener('visibilitychange', visibilityChanged); });
</script>

<template>
  <div class="modal-backdrop resource-backdrop" @click.self="emit('close')">
    <section class="resource-panel" role="dialog" aria-modal="true" aria-label="资源管理">
      <header class="modal-header"><h2>资源管理</h2><button class="icon-button" aria-label="关闭资源管理" @click="emit('close')"><Icon name="X" /></button></header>
      <div class="resource-layout">
        <nav class="resource-hosts" aria-label="资源管理主机">
          <span class="resource-nav-label">主机</span>
          <button v-for="entry in state.hosts" :key="entry.id" :class="{ active: hostId === entry.id }" :aria-pressed="hostId === entry.id" @click="hostId = entry.id">
            <Icon :name="entry.kind === 'ssh' ? 'Server' : 'Monitor'" :size="16" /><span>{{ entry.name }}</span>
          </button>
        </nav>
        <main class="resource-content">
          <div class="resource-heading"><div><h3>{{ host?.name }}</h3><p>{{ snapshot ? `最新 ${new Date(snapshot.sampledAt).toLocaleTimeString('zh-CN', { hour12: false })} · 最近 ${samples.length} 次采样` : '正在采集主机资源…' }}</p></div>
            <button class="resource-refresh" :disabled="loading || pending || !state.online" @click="refresh"><Icon name="RefreshCw" :size="14" :class="{ spin: loading }" />刷新</button>
          </div>
          <p v-if="!state.online" class="resource-message" role="status">目前离线，联网后恢复采样。</p>
          <p v-if="error" class="inline-error resource-message" role="alert">{{ error }}</p>
          <p v-if="notice" class="resource-message" role="status">{{ notice }}</p>
          <p v-if="snapshot?.scope === 'container'" class="resource-message muted">当前数据来自容器可见的资源；查看完整 NAS 主机负载请选择 SSH 连接。</p>
          <div class="resource-grid">
            <article v-for="chart in charts" :key="chart.key" class="resource-card" :aria-label="chart.title">
              <header><div><h4>{{ chart.title }}</h4><p>{{ chart.detail }}</p></div><strong>{{ chart.value }}</strong></header>
              <ResourceMetricChart :title="chart.title" :labels="chart.labels" :points="chart.points" :percent="chart.percent" />
            </article>
          </div>
          <section class="resource-card gpu-card" aria-label="显卡占用">
            <header><h4>显卡</h4><span class="muted">{{ snapshot?.gpus?.devices?.length ? `${snapshot.gpus.devices.length} 张` : '' }}</span></header>
            <p v-if="!snapshot?.gpus?.available" class="resource-message muted">{{ snapshot?.gpus?.reason || '等待显卡数据…' }}</p>
            <div v-for="gpu in snapshot?.gpus?.devices || []" :key="gpu.index" class="gpu-device">
              <h5>{{ gpu.index }} · {{ gpu.name }}</h5><div class="gpu-metrics"><span>GPU <strong>{{ number(gpu.utilizationPercent, '%') }}</strong></span><span>显存 <strong>{{ bytes(gpu.memoryUsedBytes) }} / {{ bytes(gpu.memoryTotalBytes) }}</strong></span><span>温度 <strong>{{ number(gpu.temperatureC, '°C') }}</strong></span><span>功耗 <strong>{{ number(gpu.powerWatts, ' W') }}</strong></span></div>
              <div class="gpu-meter"><span :style="{ width: `${gpu.utilizationPercent || 0}%` }" /></div>
            </div>
          </section>
          <section v-if="snapshot" class="resource-card runtime-card" aria-label="Web Codex 进程">
            <header><div><h4>Web Codex 进程</h4><p>{{ snapshot.runtime.paused ? '已暂停 · 会话已释放' : snapshot.runtime.connected ? '已连接' : '尚未启动' }}</p></div>
              <button v-if="snapshot.runtime.paused || !snapshot.runtime.connected" :disabled="pending || !state.online" @click="runtimeAction(true)">{{ pending ? '处理中…' : '重新连接 Web Codex' }}</button>
              <button v-else class="runtime-close" :disabled="pending || !state.online" @click="runtimeAction(false)">{{ pending ? '处理中…' : '关闭 Web Codex' }}</button>
            </header>
            <div class="runtime-summary"><span>已加载会话 <strong>{{ snapshot.runtime.loadedThreadCount }}</strong></span><span>运行中 <strong>{{ snapshot.runtime.activeThreadCount }}</strong></span><span>交互进程 <strong>{{ snapshot.runtime.activeProcesses?.length || 0 }}</strong></span></div>
            <div v-for="process in snapshot.runtime.processes || []" :key="`${process.local}:${process.pid}`" class="runtime-process"><Icon name="Terminal" :size="14" /><span>{{ process.role === 'app-server' ? 'Codex app-server' : 'SSH 连接' }}</span><code>PID {{ process.pid }}</code><small>{{ process.local ? '服务所在主机' : '远程主机' }}</small></div>
            <div class="runtime-threads" aria-label="Web 会话连接">
              <div v-for="thread in snapshot.runtime.threads || []" :key="thread.id" class="runtime-thread">
                <div><strong :title="thread.name">{{ thread.name }}</strong><small>{{ thread.restoring ? '历史恢复待完成' : thread.released ? '已关闭' : thread.active ? '运行中' : '空闲' }}<code v-if="thread.pid"> · PID {{ thread.pid }}</code></small></div>
                <button v-if="thread.released && !thread.loaded" :disabled="pending || !state.online || snapshot.runtime.paused" :aria-label="`重新连接会话 ${thread.name}`" @click="threadAction(thread, true)">重新连接</button>
                <button v-else class="runtime-close" :disabled="pending || !state.online || snapshot.runtime.managed === false" :aria-label="`关闭会话 ${thread.name}`" @click="threadAction(thread, false)">关闭会话</button>
              </div>
            </div>
            <p v-if="snapshot.runtime.threads?.length" class="resource-message muted">同一主机的会话共享 Codex PID；关闭会话只停止该会话及其子智能体，保留历史。</p>
            <p class="resource-message muted">关闭连接会中断此主机上所有 Web 页面的任务，并保持暂停；重新连接后可继续原会话。</p>
            <p v-if="snapshot.runtime.managed === false" class="resource-message muted">共享桌面进程模式：仅释放网页订阅和连接。</p>
          </section>
        </main>
      </div>
    </section>
  </div>
</template>

<style scoped>
.resource-panel { width: 1060px; height: min(850px, calc(100dvh - 60px)); max-width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); display: flex; flex-direction: column; overflow: hidden; }
.resource-layout { display: flex; flex: 1; min-height: 0; }
.resource-hosts { flex: 0 0 170px; padding: 16px 10px; background: var(--sidebar); border-right: 1px solid var(--border); overflow-y: auto; }
.resource-nav-label { display: block; color: var(--muted); font-size: 11px; padding: 0 10px 8px; }
.resource-hosts button { display: flex; gap: 10px; align-items: center; width: 100%; padding: 10px; text-align: left; border-radius: 8px; color: var(--muted); }
.resource-hosts button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resource-hosts button.active { background: var(--soft); color: var(--text); }
.resource-content { flex: 1; min-width: 0; overflow-y: auto; padding: 22px; }
.resource-heading, .resource-card > header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.resource-heading { align-items: center; margin-bottom: 18px; }
.resource-heading > div { min-width: 0; }
.resource-heading h3 { font-size: 18px; overflow-wrap: anywhere; }
.resource-heading p, .resource-card header p { font-size: 12px; color: var(--muted); margin-top: 5px; }
.resource-refresh, .runtime-card button { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; flex-shrink: 0; }
.resource-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.resource-card { min-width: 0; border: 1px solid var(--border); border-radius: 13px; padding: 18px; background: var(--surface); }
.resource-card h4 { font-size: 14px; font-weight: 600; }
.resource-card header > strong { font-size: 19px; white-space: nowrap; }
.resource-message { font-size: 12px; line-height: 1.6; margin: 8px 0 12px; }
.muted { color: var(--muted); }
.gpu-card, .runtime-card { margin-top: 16px; }
.gpu-device { padding-top: 16px; }
.gpu-device h5 { font-size: 13px; font-weight: 500; margin-bottom: 10px; overflow-wrap: anywhere; }
.gpu-metrics, .runtime-summary { display: flex; flex-wrap: wrap; gap: 10px 20px; font-size: 12px; color: var(--muted); }
.gpu-metrics strong, .runtime-summary strong { color: var(--text); font-weight: 500; margin-left: 6px; }
.gpu-meter { height: 4px; background: var(--soft); margin-top: 10px; border-radius: 3px; overflow: hidden; }
.gpu-meter span { display: block; height: 100%; background: #2587eb; }
.runtime-summary { margin-top: 16px; }
.runtime-process { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; }
.runtime-process small { color: var(--muted); }
.runtime-threads { margin-top: 12px; }
.runtime-thread { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
.runtime-thread > div { flex: 1; min-width: 0; }
.runtime-thread strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
.runtime-thread small { display: block; color: var(--muted); margin-top: 4px; }
.runtime-thread button { padding: 5px 8px; }
.runtime-close { color: var(--danger, #dc4545); }
@media (max-width: 760px) {
  .resource-backdrop { padding: 10px; }
  .resource-panel { height: calc(100dvh - 20px); border-radius: 12px; }
  .resource-layout { flex-direction: column; }
  .resource-hosts { display: flex; flex: 0 0 auto; gap: 6px; padding: 8px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .resource-nav-label { display: none; }
  .resource-hosts button { width: auto; max-width: 200px; flex-shrink: 0; padding: 8px 10px; }
  .resource-content { padding: 14px; }
  .resource-grid { grid-template-columns: 1fr; gap: 12px; }
  .resource-card { padding: 14px; }
  .runtime-card > header { flex-wrap: wrap; }
  .resource-card header > strong { font-size: 17px; }
}
</style>
