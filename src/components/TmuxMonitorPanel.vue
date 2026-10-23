<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { tmuxOutcomeLabel, type TmuxMonitor, type TmuxMonitorEvent, type TmuxMonitorHost, type TmuxMonitorPane, type TmuxMonitorSnapshot } from '../../shared/tmux-monitors';

const props = defineProps<{ api: any; state: any }>();
const emit = defineEmits<{ open: [target: { hostId: string; sessionId: string; paneId: string; threadId?: string; cwd: string }] }>();
const snapshot = ref<TmuxMonitorSnapshot>({ monitors: [], history: [], hosts: [] });
const hostId = ref(props.state.hostId || props.state.hosts?.[0]?.id || '');
const filter = ref('');
const mode = ref<'once' | 'permanent'>('once');
const loading = ref(false);
const scanning = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const discovered = ref<TmuxMonitorHost>();
let generation = 0;
let scanGeneration = 0;
let disposed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const host = computed(() => props.state.hosts?.find((entry: any) => entry.id === hostId.value));
const monitors = computed(() => snapshot.value.monitors.filter(monitor => !filter.value || monitor.hostId === filter.value));
const history = computed(() => snapshot.value.history.filter(event => !filter.value || event.hostId === filter.value).slice().reverse());
const statusLabel = (status: TmuxMonitor['status']) => ({ waiting: '等待任务', running: '运行中', disconnected: '等待重连', completed: '监控已完成', paused: '已暂停' })[status];
const at = (timestamp: number) => new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
const request = (path: string, options: RequestInit = {}) => props.api.requestHttp(`/tmux-monitors${path}`, { ...options, signal: AbortSignal.timeout(20000) }, false);
function schedule() {
  clearTimeout(timer);
  if (!disposed && props.state.authenticated && props.state.online && !document.hidden) timer = setTimeout(() => void refresh(), 5000);
}
async function refresh() {
  if (disposed || loading.value || !props.state.authenticated || !props.state.online || document.hidden) return;
  const current = generation;
  loading.value = true;
  try {
    const result = await request('');
    if (disposed || current !== generation || !props.state.authenticated) return;
    snapshot.value = result;
    error.value = '';
  } catch (cause: any) {
    if (!disposed && current === generation) error.value = cause.message || '读取任务监控失败';
  } finally { if (current === generation) { loading.value = false; schedule(); } }
}
async function discover() {
  if (!host.value || scanning.value || !props.state.online) return;
  const selected = hostId.value, current = ++scanGeneration;
  scanning.value = true; error.value = ''; notice.value = '';
  try {
    const result = await request('/discover', { method: 'POST', body: JSON.stringify({ hostId: selected }) });
    if (disposed || current !== scanGeneration || selected !== hostId.value || !props.state.authenticated) return;
    discovered.value = result;
  } catch (cause: any) {
    if (!disposed && current === scanGeneration) error.value = cause.message || '发现 Tmux 窗格失败';
  } finally { if (current === scanGeneration) scanning.value = false; }
}
function exists(pane: TmuxMonitorPane) {
  return snapshot.value.monitors.some(monitor => monitor.hostId === hostId.value && monitor.serverPid === pane.serverPid && monitor.paneId === pane.paneId && !['completed', 'paused'].includes(monitor.status));
}
async function action(operation: () => Promise<unknown>, success: string) {
  if (busy.value || disposed || !props.state.online) return;
  const current = generation;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    await operation();
    if (disposed || current !== generation || !props.state.authenticated) return;
    notice.value = success;
    await refresh();
  } catch (cause: any) { if (!disposed && current === generation) error.value = cause.message || '任务监控操作失败'; }
  finally { if (current === generation) busy.value = false; }
}
async function add(pane: TmuxMonitorPane) {
  const selectedHost = hostId.value;
  await action(() => request('', { method: 'POST', body: JSON.stringify({ hostId: selectedHost, sessionId: pane.sessionId, paneId: pane.paneId, mode: mode.value,
    ...(selectedHost === props.state.hostId && props.state.activeThread?.id ? { threadId: props.state.activeThread.id } : {}) }) }), '监控已保存，关闭网页后仍会继续。');
}
async function pause(monitor: TmuxMonitor) {
  await action(() => request(`/${monitor.id}`, { method: 'PATCH', body: JSON.stringify({ paused: monitor.status !== 'paused' }) }), monitor.status === 'paused' ? '监控已恢复，将从当前任务状态继续。' : '监控已暂停，远端任务继续运行。');
}
async function remove(monitor: TmuxMonitor) {
  if (!window.confirm(`删除“${monitor.sessionName}”的任务监控？\n远端 tmux 会话和进程继续运行，已记录的历史保留。`)) return;
  await action(() => request(`/${monitor.id}`, { method: 'DELETE' }), '任务监控已删除。');
}
async function clearHistory() {
  if (!window.confirm('清除已投递到通知队列的任务记录？尚待投递的记录会保留。')) return;
  await action(() => request('/history', { method: 'DELETE' }), '已清除任务记录。');
}
function open(target: TmuxMonitor | TmuxMonitorEvent) {
  emit('open', { hostId: target.hostId, sessionId: target.sessionId, paneId: target.paneId, cwd: target.cwd, ...(target.threadId ? { threadId: target.threadId } : {}) });
}
function visibility() { if (document.hidden) clearTimeout(timer); else void refresh(); }
watch(hostId, () => { ++scanGeneration; scanning.value = false; discovered.value = undefined; });
watch(() => props.state.authenticated, authenticated => {
  ++generation; ++scanGeneration; loading.value = scanning.value = busy.value = false;
  snapshot.value = { monitors: [], history: [], hosts: [] }; discovered.value = undefined;
  error.value = notice.value = ''; clearTimeout(timer); if (authenticated) void refresh();
});
watch(() => props.state.online, online => { if (online) void refresh(); else clearTimeout(timer); });
onMounted(() => { document.addEventListener('visibilitychange', visibility); void refresh(); });
onBeforeUnmount(() => { disposed = true; ++generation; ++scanGeneration; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); });
</script>

<template>
  <section class="tmux-monitor-panel" aria-label="Tmux 任务监控">
    <header class="monitor-heading"><div><h3>Tmux 任务监控</h3><p>跨主机查看后台任务；关闭网页后监控继续。</p></div><button type="button" class="monitor-button" :disabled="loading || busy || !state.online" @click="refresh"><Icon name="RefreshCw" :size="14" />刷新监控</button></header>
    <p v-if="error" class="monitor-error" role="alert">{{ error }}</p><p v-if="notice" class="monitor-notice" role="status">{{ notice }}</p>
    <div class="monitor-create">
      <label>发现主机<select v-model="hostId" aria-label="发现 Tmux 主机" :disabled="busy"><option v-for="entry in state.hosts" :key="entry.id" :value="entry.id">{{ entry.name }}</option></select></label>
      <label>监控方式<select v-model="mode" aria-label="Tmux 监控方式" :disabled="busy"><option value="once">本次任务结束后停止</option><option value="permanent">持续监控后续任务</option></select></label>
      <button type="button" class="monitor-button" :disabled="scanning || busy || !host || !state.online" @click="discover">{{ scanning ? '正在发现…' : '发现窗格' }}</button>
    </div>
    <p class="monitor-hint">只读取任务状态，不发送按键或改变 tmux 配置。普通 Shell 返回后无法可靠取得退出码；短于采样间隔的任务可能无法发现。</p>
    <p v-if="discovered && !discovered.available" class="monitor-hint">{{ discovered.reason }}</p>
    <div v-else-if="discovered" class="discovered-panes" aria-label="发现的 Tmux 窗格"><p v-if="!discovered.panes.length" class="monitor-hint">此主机当前没有 Tmux 窗格。</p><div v-for="pane in discovered.panes" :key="`${pane.sessionId}:${pane.paneId}`" class="monitor-row"><div><strong>{{ pane.sessionName }} · {{ pane.windowName || pane.windowId }} · {{ pane.paneId }}</strong><small>{{ pane.dead ? '窗格已退出' : pane.active ? `运行中 · ${pane.command}` : '等待命令' }}</small></div><button type="button" class="monitor-button" :disabled="busy || pane.dead || exists(pane)" :aria-label="`监控窗格 ${pane.sessionName} ${pane.paneId}`" @click="add(pane)">{{ exists(pane) ? '已监控' : '添加监控' }}</button></div></div>
    <div class="monitor-filter"><h4>已保存的监控</h4><select v-model="filter" aria-label="筛选监控主机"><option value="">全部主机</option><option v-for="entry in state.hosts" :key="entry.id" :value="entry.id">{{ entry.name }}</option></select></div>
    <p v-if="!monitors.length" class="monitor-hint">还没有监控。先发现窗格，再选择一次或持续监控。</p>
    <article v-for="monitor in monitors" :key="monitor.id" class="monitor-row saved-monitor" :aria-label="`任务监控 ${monitor.sessionName}`"><div><strong>{{ monitor.hostName }} · {{ monitor.sessionName }} · {{ monitor.paneId }}</strong><small :class="`monitor-status-${monitor.status}`">{{ statusLabel(monitor.status) }} · {{ monitor.mode === 'once' ? '单次' : '持续' }}<span v-if="monitor.command"> · {{ monitor.command }}</span></small><small v-if="monitor.error" class="monitor-error">{{ monitor.error }}</small></div><div class="monitor-row-actions"><button type="button" class="monitor-button" :disabled="busy" @click="open(monitor)">查看输出</button><button v-if="monitor.status !== 'completed'" type="button" class="monitor-button" :disabled="busy" @click="pause(monitor)">{{ monitor.status === 'paused' ? '恢复监控' : '暂停监控' }}</button><button type="button" class="icon-button" :disabled="busy" :aria-label="`删除监控 ${monitor.sessionName}`" @click="remove(monitor)"><Icon name="Trash2" :size="15" /></button></div></article>
    <div class="monitor-filter"><h4>执行记录</h4><button type="button" class="monitor-button" :disabled="busy || !snapshot.history.length" @click="clearHistory">清除记录</button></div>
    <p v-if="!history.length" class="monitor-hint">还没有任务结束记录。</p>
    <article v-for="event in history" :key="event.id" class="monitor-row monitor-history"><div><strong>{{ event.hostName }} · {{ event.sessionName }} · {{ event.command }}</strong><small :class="{ 'monitor-error': event.outcome === 'failed' }">{{ tmuxOutcomeLabel(event.outcome) }}<span v-if="event.exitCode !== null"> · 退出码 {{ event.exitCode }}</span> · {{ at(event.at) }}</small><small>{{ event.notification === 'pending' ? '通知等待投递' : '已提交通知队列' }}</small></div><button type="button" class="monitor-button" @click="open(event)">查看输出</button></article>
    <p class="monitor-hint">手机通知需在“设置 → 应用与通知”启用；提交队列不代表手机系统已展示。持续监控会跟随同名会话的窗口／窗格位置，重新创建该位置后继续等待任务。</p>
  </section>
</template>

<style scoped>
.tmux-monitor-panel { min-width: 0; color: var(--text); }
.monitor-heading, .monitor-filter { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.monitor-heading h3 { font-size: 16px; margin: 0; }
.monitor-heading p, .monitor-hint { font-size: 12px; line-height: 1.6; color: var(--muted); }
.monitor-heading p { margin: 5px 0 0; }
.monitor-hint { margin: 10px 0; }
.monitor-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 7px; font-size: 12px; white-space: nowrap; }
.monitor-button:disabled { opacity: .5; }
.monitor-create { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
.monitor-create label { display: flex; flex: 1; min-width: 140px; flex-direction: column; gap: 6px; font-size: 12px; }
select { min-height: 34px; max-width: 100%; padding: 6px 9px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); font-size: 12px; }
.monitor-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.monitor-row > div:first-child { flex: 1; min-width: 0; }
.monitor-row strong { display: block; font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }
.monitor-row small { display: block; font-size: 11px; color: var(--muted); margin-top: 5px; line-height: 1.5; overflow-wrap: anywhere; }
.monitor-row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; }
.monitor-filter { margin: 22px 0 5px; }
.monitor-filter h4 { font-size: 13px; margin: 0; }
.monitor-error, .monitor-row .monitor-error { color: var(--danger, #c44136); font-size: 12px; line-height: 1.6; }
.monitor-notice { color: var(--accent-text); font-size: 12px; line-height: 1.6; }
.monitor-row .monitor-status-running { color: #b65c08; }
.monitor-row .monitor-status-disconnected { color: var(--danger, #c44136); }
.discovered-panes { max-height: 280px; overflow-y: auto; }
@media (max-width: 760px) { .monitor-heading { align-items: flex-start; } .monitor-row { flex-wrap: wrap; } .monitor-row > div:first-child { flex-basis: 100%; } .monitor-row-actions { justify-content: flex-start; } .monitor-button, select { min-height: 42px; } select { font-size: 16px; } .monitor-create label { flex-basis: 100%; } }
</style>
