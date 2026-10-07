<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
const props = defineProps<{ api: any; hostId: string; hostName?: string }>();
const open = ref(false);
const loading = ref(false);
const data = ref<any>(null);
const error = ref('');
let generation = 0;
function time(value: number | null | undefined) { return value ? new Date(value).toLocaleString() : '未记录'; }
const errorLabels: Record<string, string> = { unsupportedMethod: '原生 CLI 不支持此方法', invalidParameters: '请求参数与主机协议不匹配', runtimeError: '原生 CLI 返回运行错误' };
async function refresh() {
  const token = ++generation; const hostId = props.hostId;
  loading.value = true; error.value = '';
  try {
    const result = await props.api.requestHttp(`/hosts/${encodeURIComponent(hostId)}/diagnostics`, { signal: AbortSignal.timeout(10000) }, false);
    if (token === generation && hostId === props.hostId) data.value = result;
  } catch (cause: any) { if (token === generation) error.value = cause.message || '无法读取连接诊断'; }
  finally { if (token === generation) loading.value = false; }
}
watch(() => props.hostId, () => { ++generation; data.value = null; error.value = ''; if (open.value) void refresh(); });
watch(open, value => { if (value) void refresh(); });
onBeforeUnmount(() => { ++generation; });
</script>
<template>
  <section class="host-diagnostics">
    <button class="diagnostics-toggle" :aria-expanded="open" aria-controls="host-diagnostics-detail" @click="open = !open"><Icon name="Activity" :size="16" />连接诊断 · {{ hostName || hostId }}<Icon :name="open ? 'ChevronUp' : 'ChevronDown'" :size="14" /></button>
    <div v-if="open" id="host-diagnostics-detail" class="diagnostics-body">
      <button class="button button-small button-secondary" :disabled="loading" @click="refresh"><Icon :name="loading ? 'LoaderCircle' : 'RefreshCw'" :class="{spin: loading}" :size="14" />刷新诊断</button>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-else-if="loading && !data">正在读取连接状态…</p>
      <template v-else-if="data?.runtime">
        <p v-if="data.capabilityNotice === 'proxy_runtime'">当前连接为原生代理，本机 CLI 协议不能证明代理进程版本，因此未推断新原生操作的支持情况。</p>
        <p v-else-if="data.capabilityNotice === 'runtime_version_unknown'">当前连接未报告可验证的 CLI 版本，因此未推断新原生操作的支持情况。</p>
        <dl>
          <dt>连接</dt><dd>{{ data.runtime.paused ? 'Web Codex 已释放' : data.runtime.connected ? '已连接' : '已断开' }} · {{ data.runtime.connectionMode }}</dd>
          <dt>CLI</dt><dd>{{ data.runtime.userAgent || '版本未报告' }}</dd>
          <dt>引擎</dt><dd>{{ data.runtime.engineId || '尚未初始化' }}</dd>
          <dt>重连</dt><dd>{{ data.runtime.reconnectCount }} 次</dd>
          <dt>最近连接</dt><dd>{{ time(data.runtime.lastConnectedAt) }}</dd>
          <dt>最近断开</dt><dd>{{ time(data.runtime.lastDisconnectedAt) }}</dd>
          <dt>事件缓存</dt><dd>{{ data.runtime.cachedEvents?.count || 0 }} / {{ data.runtime.cachedEvents?.capacity || 0 }} 条 · {{ Math.round((data.runtime.cachedEvents?.bytes || 0) / 1024) }} KiB · 保留 {{ Math.round((data.runtime.cachedEvents?.ttlMs || 0) / 60000) }} 分钟</dd>
          <dt>缓存序列</dt><dd>{{ data.runtime.cachedEvents?.firstSequence }} – {{ data.runtime.cachedEvents?.lastSequence }}</dd>
          <template v-if="data.runtime.lastProtocolError"><dt>最近协议错误</dt><dd>{{ errorLabels[data.runtime.lastProtocolError.category] || '协议错误' }}<span v-if="data.runtime.lastProtocolError.method"> · {{ data.runtime.lastProtocolError.method }}</span> · {{ data.runtime.lastProtocolError.code }} · {{ time(data.runtime.lastProtocolError.at) }}</dd></template>
        </dl>
      </template>
      <p v-else-if="data">此主机尚无 Web Codex 连接。查看诊断不会启动或重启 Codex。</p>
    </div>
  </section>
</template>
<style scoped>
.host-diagnostics { margin-top:20px;border-top:1px solid var(--border);padding-top:16px; }
.diagnostics-toggle { display:flex;align-items:center;gap:8px;width:100%;padding:8px 0;background:none;border:0;text-align:left;color:var(--muted);font-size:12px;cursor:pointer; }
.diagnostics-toggle > svg:last-child { margin-left:auto; }
.diagnostics-body { padding-top:10px;font-size:12px;color:var(--muted);line-height:1.7; }
.diagnostics-body p { margin-top:12px; }
dl { display:grid;grid-template-columns:86px minmax(0,1fr);gap:9px 12px;margin-top:16px; }
dt { color:var(--muted); } dd { margin:0;color:var(--text);overflow-wrap:anywhere;min-width:0; }
@media(max-width:760px) { dl { grid-template-columns:74px minmax(0,1fr); } .diagnostics-toggle,.diagnostics-body { font-size:13px; } }
</style>
