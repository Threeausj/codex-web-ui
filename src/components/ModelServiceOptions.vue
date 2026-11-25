<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { methodAccepts } from '../lib/integration-capabilities';
import { modelServiceTiers, rateLimitWindows, serviceTierScope } from '../lib/service-tiers';
const props = defineProps<{ api: any; state: any; disabled?: boolean }>();
const busy = ref(false);
const error = defineModel<string>('error', { default: '' });
const capabilities = ref<any>(null);
const catalogTiers = computed(() => modelServiceTiers(props.state));
const tierSupported = computed(() => props.state.activeThread ?
  methodAccepts(capabilities.value, 'thread/settings/update', ['threadId', 'serviceTier']) || methodAccepts(capabilities.value, 'turn/start', ['threadId', 'input', 'serviceTier']) :
  methodAccepts(capabilities.value, 'thread/start', ['serviceTier']) && methodAccepts(capabilities.value, 'turn/start', ['threadId', 'input', 'serviceTier']));
const tiers = catalogTiers;
const capabilityLoading = ref(false);
const tierHint = computed(() => capabilityLoading.value ? '正在读取主机的速度设置…' : !tierSupported.value ?
  capabilities.value?.reason === 'runtime_version_mismatch' ? '安装的 Codex CLI 与运行中的 App Server 版本不一致；请核对 CLI 路径并重新加载后台服务' :
  capabilities.value?.status === 'known' ? '当前主机暂不支持调整速度' : '暂时无法确认主机的速度设置；请重启或重新连接 Codex 后重试' :
  selectedTier.value?.description || '服务层级由当前主机的模型目录提供');
const windows = computed(() => rateLimitWindows(props.state.rateLimits));
const selected = computed({
  get: () => props.state.serviceTierScope === serviceTierScope(props.state) ? props.state.serviceTier || '' : props.state.nativeServiceTier || '',
  set: (value: string) => { void choose(value); },
});
const selectedTier = computed(() => catalogTiers.value.find(tier => tier.id === selected.value));
const selectedLabel = computed(() => {
  if (!selected.value) return '原生默认';
  return selectedTier.value?.name || (selected.value === 'default' ? '标准' : `原生：${selected.value}`);
});
const unlistedSelection = computed(() => !!selected.value && !selectedTier.value);
let generation = 0;
let choiceGeneration = 0;
watch([() => props.state.hostId, () => props.state.activeThread?.id, () => props.state.projectPath, () => props.state.authenticationGeneration, () => props.state.connected, () => props.state.selectingThread], () => { ++choiceGeneration; busy.value = false; error.value = ''; });
let disposed = false;
let quotaRevision = 0, quotaDirty = false;
let pending: Promise<void> | null = null;
let capabilityPending: Promise<void> | null = null;
let capabilityGeneration = 0;
let capabilityRetry: ReturnType<typeof setTimeout> | undefined;
let capabilityAttempts = 0;
let seenEngine: string | null = null;
function clearCapabilityRetry() { clearTimeout(capabilityRetry); capabilityRetry = undefined; }
function retryCapabilities() {
  clearCapabilityRetry();
  const reason = capabilities.value?.reason;
  if (disposed || !props.state.connected || !props.state.authenticated || !catalogTiers.value.length ||
      capabilities.value?.status === 'known' || reason && reason !== 'schema_unavailable' || capabilityAttempts >= 3) return;
  capabilityRetry = setTimeout(() => { capabilityRetry = undefined; void readCapabilities(); }, capabilityAttempts * 5000);
}
async function readCapabilities() {
  if (disposed || !props.state.connected || !props.state.authenticated || !catalogTiers.value.length || capabilityPending) return;
  clearCapabilityRetry(); capabilityLoading.value = true; capabilityAttempts++;
  const version = generation;
  const revision = capabilityGeneration;
  const host = props.state.hostId;
  const operation = (async () => {
    try {
      const result = await props.api.requestHttp(`/hosts/${encodeURIComponent(host)}/native-capabilities`, {}, false);
      if (version === generation && revision === capabilityGeneration && host === props.state.hostId) capabilities.value = result;
    } catch { if (version === generation && revision === capabilityGeneration) capabilities.value = null; }
  })();
  capabilityPending = operation;
  await operation;
  if (capabilityPending === operation) {
    capabilityPending = null; capabilityLoading.value = false; retryCapabilities();
  }
}
async function readLimits() {
  if (disposed || !props.state.connected || !props.state.authenticated || pending) return;
  const version = generation;
  const host = props.state.hostId;
  const revision = quotaRevision;
  const operation = (async () => {
    try {
      const result = await props.api.rpc('account/rateLimits/read', {}, 15000, { silentError: true });
      if (version === generation && host === props.state.hostId && revision === quotaRevision) props.state.rateLimits = result;
    } catch { /* Unsupported accounts and gateways do not advertise an invented quota. */ }
  })();
  pending = operation;
  await operation;
  if (pending === operation) { pending = null; if (quotaDirty) { quotaDirty = false; void readLimits(); } }
}
watch(() => [props.state.hostId, props.state.connected, props.state.authenticated, props.state.authenticationGeneration], () => { generation++; capabilityGeneration++; clearCapabilityRetry(); capabilityAttempts = 0; capabilityLoading.value = false; quotaDirty = false; pending = capabilityPending = null; capabilities.value = null; void readLimits(); void readCapabilities(); }, { immediate: true });
watch(catalogTiers, () => { capabilityAttempts = 0; void readCapabilities(); });
const unsubscribe = props.api.subscribeProtocol?.((hostId: string, message: any) => {
  if (hostId !== props.state.hostId) return;
  if (message.method === 'account/rateLimits/updated') { quotaRevision++; if (pending) quotaDirty = true; else void readLimits(); }
  if (message.method === 'bridge/status' && message.params?.engineId && message.params.engineId !== seenEngine) {
    if (seenEngine) { quotaRevision++; if (pending) quotaDirty = true; else void readLimits(); }
    seenEngine = message.params.engineId; capabilityGeneration++; clearCapabilityRetry(); capabilityAttempts = 0; capabilities.value = null; capabilityPending = null; void readCapabilities();
  }
}) || (() => {});
onBeforeUnmount(() => { disposed = true; generation++; clearCapabilityRetry(); quotaDirty = false; pending = capabilityPending = null; unsubscribe(); });
async function choose(value: string) {
  busy.value = true; error.value = '';
  const choice = choiceGeneration;
  try { await props.api.setServiceTier(value || null); }
  catch (cause: any) { if (choice === choiceGeneration) error.value = cause.message; }
  finally { if (choice === choiceGeneration) busy.value = false; }
}
function resetTime(value: number | null) { return value ? new Date(value).toLocaleString() : '未提供重置时间'; }
</script>
<template>
  <div v-if="tiers.length || windows.length" class="model-service-options">
    <label v-if="tiers.length" class="composer-select service-tier-select" :title="tierHint">
      <Icon name="Zap" :size="13" /><span class="service-tier-value" aria-hidden="true">{{ selectedLabel }}</span><Icon name="ChevronDown" :size="12" />
      <select v-model="selected" aria-label="模型服务层级" :disabled="disabled || busy || !tierSupported"><option value="">原生默认</option><option v-if="unlistedSelection" :value="selected" disabled>{{ selectedLabel }}</option><option v-for="tier in tiers" :key="tier.id" :value="tier.id" :title="tier.description">{{ tier.name }}</option></select>
    </label>
    <details v-if="windows.length" class="account-usage"><summary aria-label="查看账户使用额度"><Icon name="Gauge" :size="13" /><span class="account-usage-label">额度</span></summary><div class="account-usage-popover"><strong>主机账户额度</strong><div v-for="window in windows" :key="window.key"><span>{{ window.name }} · {{ window.label }}</span><span>已用 {{ Math.round(window.used) }}%</span><progress :value="window.used" max="100"></progress><small>{{ resetTime(window.resetsAt) }}</small></div><p v-if="state.rateLimits?.ordinaryUsageAllowed === false">服务端已限制常规额度；以账户实际状态为准。</p></div></details>
  </div>
</template>
<style scoped>
.model-service-options { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.service-tier-select { display: flex; align-items: center; flex: none; gap: 4px; color: var(--muted); font-size: 11px; }
/* Keep the current speed visible during native-select repaint and catalog
   updates. The select still owns pointer, keyboard and assistive interaction. */
.service-tier-value { max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.service-tier-select select { position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; opacity: 0; cursor: pointer; }
.service-tier-select:has(select:focus-visible) { outline: 2px solid var(--green); outline-offset: 3px; border-radius: 4px; }
.service-tier-select:has(select:disabled) { opacity: .65; }
.service-tier-select select:disabled { cursor: default; }
.account-usage { position: relative; font-size: 11px; color: var(--muted); }
.account-usage summary { display: flex; align-items: center; gap: 4px; cursor: pointer; list-style: none; }
.account-usage summary::-webkit-details-marker { display: none; }
.account-usage-popover { position: absolute; bottom: 28px; right: 0; width: min(280px, 80vw); z-index: 10; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 6px 20px #0002; }
.account-usage-popover > div { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin-top: 12px; }
.account-usage progress, .account-usage small { grid-column: 1 / -1; width: 100%; }
@media(max-width:760px) {
  .model-service-options { gap: 4px; margin-left: auto; }
  .service-tier-select {
    flex: 0 1 auto;
    height: var(--composer-control-height);
    gap: var(--composer-select-gap);
    font: inherit;
  }
  .service-tier-select > svg { flex: none; }
  .service-tier-select > svg:last-of-type { width: 11px; }
  .service-tier-value { min-width: 0; max-width: 80px; }
  .account-usage { flex: none; }
  .account-usage summary {
    justify-content: center;
    width: 26px;
    height: var(--composer-control-height);
  }
  .account-usage-label { display: none; }
  .account-usage-popover { bottom: var(--composer-control-height); }
}
@media (max-width: 360px) {
  .model-service-options { gap: 2px; }
  .service-tier-select > svg:first-child { display: none; }
  .account-usage summary { width: 24px; }
}
</style>
