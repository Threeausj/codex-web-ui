<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";

const props = defineProps<{ api: any; state: any; hostId: string }>();
const hostId = computed(() => props.hostId);
const loading = ref(false);
const reconnecting = ref(false);
const error = ref("");
const success = ref("");
let generation = 0;
const hosts = computed(() => props.state.hosts || []);
const host = computed(() => hosts.value.find((entry: any) => entry.id === hostId.value));
const information = computed(() => props.state.runtimeInformation?.[hostId.value] || null);
const runtime = computed(() => information.value?.runtime || null);
const configuration = computed(() => information.value?.config?.config || information.value?.config || {});
const modelCount = computed(() => Array.isArray(information.value?.models) ? information.value.models.filter((entry: any) => !entry.hidden).length : null);
const connection = computed(() => runtime.value?.paused ? "已释放" : runtime.value?.connected ? "已连接" : "未连接");
const mode = computed(() => {
  const value = runtime.value?.mode || runtime.value?.connectionMode;
  if (value === "proxy") return "原生代理";
  if (value === "ssh" || host.value?.kind === "ssh") return "SSH";
  if (value === "spawn") return "本机进程";
  return value || "未报告";
});
const pending = computed(() => loading.value || reconnecting.value || props.state.runtimeReconnectingHostId === hostId.value);
const disabledReason = computed(() => {
  if (!props.state.authenticated) return "请先登录";
  if (pending.value) return "正在更新连接信息…";
  if (!information.value) return "请先读取主机信息";
  if (runtime.value?.paused) return "此主机的 Web Codex 已释放，请在资源管理中恢复连接后重试。";
  if ((hostId.value === props.state.hostId && props.state.busy) || runtime.value?.activeThreadCount > 0)
    return "主机上有正在运行的任务，完成或停止后可重新连接。";
  if (runtime.value?.activeProcesses?.length)
    return "主机上有正在运行的终端，请关闭终端后重新连接。";
  if (information.value.canReconnect === false)
    return information.value.reconnectDisabledReason || "此主机当前无法重新连接，请稍后重试。";
  return "";
});
function tokens(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "未报告";
  const unit = value >= 1_000_000 ? 1_000_000 : value >= 1000 ? 1000 : 1;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / unit)}${unit === 1_000_000 ? "m" : unit === 1000 ? "k" : ""} tokens`;
}
function time(value: number | undefined) {
  return value && Number.isFinite(value) ? new Date(value).toLocaleString() : "尚未读取";
}
async function refresh() {
  if (pending.value || !host.value || !props.state.authenticated) return;
  const token = ++generation;
  const selectedHost = hostId.value;
  loading.value = true;
  error.value = "";
  success.value = "";
  try {
    await props.api.refreshRuntimeInformation(selectedHost);
  } catch (cause: any) {
    if (token === generation && selectedHost === hostId.value) error.value = cause.message || "无法读取 Codex 信息，请重试。";
  } finally {
    if (token === generation) loading.value = false;
  }
}
async function reconnect() {
  if (disabledReason.value || !host.value) return;
  const token = ++generation;
  const selectedHost = hostId.value;
  reconnecting.value = true;
  error.value = "";
  success.value = "";
  try {
    await props.api.reconnectRuntime(selectedHost);
    if (token === generation && selectedHost === hostId.value)
      success.value = "Codex 已重新连接，版本、模型和配置已更新。";
  } catch (cause: any) {
    if (token === generation && selectedHost === hostId.value) error.value = cause.message || "重新连接失败，请重试。";
  } finally {
    if (token === generation) reconnecting.value = false;
  }
}
watch(hostId, () => {
  ++generation;
  loading.value = false;
  reconnecting.value = false;
  error.value = "";
  success.value = "";
  void refresh();
}, { immediate: true });
onBeforeUnmount(() => { ++generation; });
</script>

<template>
  <section class="performance-settings" aria-label="性能设置">
    <h3>性能</h3>
    <p class="settings-description">更新主机上的 Codex 后，重新连接即可读取新模型和上下文配置。</p>
    <dl class="performance-information" :aria-busy="loading">
      <div><dt>连接状态</dt><dd><span class="performance-connection" :class="{ connected: runtime?.connected && !runtime?.paused }">{{ connection }}</span><span class="performance-mode">{{ mode }}</span></dd></div>
      <div><dt>Codex 版本</dt><dd>{{ runtime?.userAgent || "未报告" }}</dd></div>
      <div><dt>可用模型</dt><dd>{{ modelCount === null ? "未读取" : `${modelCount} 个` }}</dd></div>
      <div><dt>默认模型</dt><dd>{{ configuration.model || "未配置" }}</dd></div>
      <div><dt>配置上下文窗口</dt><dd>{{ tokens(configuration.model_context_window) }}</dd></div>
      <div><dt>Codex 自动压缩阈值</dt><dd>{{ tokens(configuration.model_auto_compact_token_limit) }}</dd></div>
    </dl>
    <p class="performance-checked">最近读取：{{ time(information?.checkedAt) }}</p>
    <div class="performance-reconnect">
      <strong>重新连接 Codex</strong>
      <p v-if="runtime?.mode === 'proxy' || runtime?.managed === false">重新建立 Web 与原生代理的连接，刷新模型和配置。Codex 版本由外部进程管理，更新后请先在宿主机重启该进程。</p>
      <p v-else>重启此主机由 Web 管理的 Codex 连接，刷新版本、模型、配置和技能。该主机的其他 Web 页面也会重新连接。</p>
      <p v-if="disabledReason && !pending" class="performance-reason">{{ disabledReason }}</p>
      <div class="performance-actions">
        <button class="button button-secondary" :disabled="pending || !host || !state.authenticated" @click="refresh"><Icon :name="loading ? 'LoaderCircle' : 'RefreshCw'" :class="{ spin: loading }" :size="15" />{{ loading ? "读取中…" : "刷新信息" }}</button>
        <button class="button button-primary" :disabled="!!disabledReason" :title="disabledReason || undefined" @click="reconnect"><Icon :name="reconnecting ? 'LoaderCircle' : 'Zap'" :class="{ spin: reconnecting }" :size="15" />{{ reconnecting ? "重新连接中…" : "重新连接 Codex" }}</button>
      </div>
    </div>
    <p v-if="error" class="panel-error" role="alert"><Icon name="AlertCircle" :size="16" />{{ error }}</p>
    <p v-if="success" class="settings-success" role="status"><Icon name="CheckCircle2" :size="16" />{{ success }}</p>
  </section>
</template>

<style scoped>
.performance-information { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 24px; margin: 26px 0 16px; }
.performance-information div { min-width: 0; }
.performance-information dt { margin-bottom: 7px; color: var(--muted); font-size: 11px; }
.performance-information dd { margin: 0; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.performance-connection.connected { color: var(--green); }
.performance-mode { margin-left: 9px; color: var(--muted); font-size: 11px; }
.performance-checked { font-size: 10px; color: var(--muted); }
.performance-reconnect { border-top: 1px solid var(--border); margin-top: 22px; padding-top: 22px; }
.performance-reconnect strong { font-size: 12px; font-weight: 500; }
.performance-reconnect p { color: var(--muted); font-size: 11px; line-height: 1.8; margin-top: 9px; }
.performance-reconnect .performance-reason { color: var(--text); }
.performance-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.performance-actions .button { min-height: 36px; }
.performance-settings > .panel-error, .performance-settings > .settings-success { margin-top: 16px; }
@media (max-width: 760px) {
  .performance-information { gap: 20px 18px; }
  .performance-information dt, .performance-mode { font-size: 12px; }
  .performance-information dd { font-size: 14px; }
  .performance-checked { font-size: 11px; }
  .performance-reconnect strong { font-size: 14px; }
  .performance-reconnect p { font-size: 13px; }
  .performance-actions .button { min-height: 42px; flex: 1; white-space: nowrap; }
}
</style>
