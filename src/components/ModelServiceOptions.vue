<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { methodAccepts } from '../lib/integration-capabilities';
import { modelServiceTiers, rateLimitWindows, serviceTierScope } from '../lib/service-tiers';
const props = defineProps<{ api: any; state: any; disabled?: boolean }>();
const busy = ref(false);
const error = ref('');
const capabilities = ref<any>(null);
const catalogTiers = computed(() => modelServiceTiers(props.state));
const tierSupported = computed(() => props.state.activeThread ? methodAccepts(capabilities.value, 'thread/settings/update', ['threadId', 'serviceTier']) :
  methodAccepts(capabilities.value, 'thread/start', ['serviceTier']) && methodAccepts(capabilities.value, 'turn/start', ['threadId', 'input', 'serviceTier']));
const tiers = computed(() => tierSupported.value ? catalogTiers.value : []);
const windows = computed(() => rateLimitWindows(props.state.rateLimits));
const selected = computed(() => props.state.serviceTierScope === serviceTierScope(props.state) ? props.state.serviceTier || '' : props.state.nativeServiceTier || '');
let generation = 0;
let disposed = false;
let quotaRevision = 0, quotaDirty = false;
let pending: Promise<void> | null = null;
let capabilityPending: Promise<void> | null = null;
let capabilityGeneration = 0;
let seenEngine: string | null = null;
async function readCapabilities() {
  if (disposed || !props.state.connected || !props.state.authenticated || !catalogTiers.value.length || capabilityPending) return;
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
  if (capabilityPending === operation) capabilityPending = null;
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
watch(() => [props.state.hostId, props.state.connected, props.state.authenticated], () => { generation++; capabilityGeneration++; pending = capabilityPending = null; capabilities.value = null; void readLimits(); void readCapabilities(); }, { immediate: true });
watch(catalogTiers, () => { void readCapabilities(); });
const unsubscribe = props.api.subscribeProtocol?.((hostId: string, message: any) => {
  if (hostId !== props.state.hostId) return;
  if (message.method === 'account/rateLimits/updated') { quotaRevision++; if (pending) quotaDirty = true; else void readLimits(); }
  if (message.method === 'bridge/status' && message.params?.engineId !== seenEngine) { seenEngine = message.params?.engineId || null; capabilityGeneration++; capabilities.value = null; capabilityPending = null; void readCapabilities(); }
}) || (() => {});
onBeforeUnmount(() => { disposed = true; generation++; quotaDirty = false; pending = capabilityPending = null; unsubscribe(); });
async function choose(event: Event) {
  busy.value = true; error.value = '';
  try { await props.api.setServiceTier((event.target as HTMLSelectElement).value || null); }
  catch (cause: any) { error.value = cause.message; }
  finally { busy.value = false; }
}
function resetTime(value: number | null) { return value ? new Date(value).toLocaleString() : '未提供重置时间'; }
</script>
<template>
  <div v-if="tiers.length || windows.length || state.rateLimits?.ordinaryUsageAllowed === false" class="model-service-options">
    <label v-if="tiers.length" class="composer-select service-tier-select" title="服务层级由当前主机的模型目录提供"><Icon name="Zap" :size="13" /><select :value="selected" aria-label="模型服务层级" :disabled="disabled || busy" @change="choose"><option value="">原生默认</option><option v-for="tier in tiers" :key="tier.id" :value="tier.id" :title="tier.description">{{ tier.name }}</option></select></label>
    <details v-if="windows.length" class="account-usage"><summary aria-label="查看账户使用额度"><Icon name="Gauge" :size="13" />额度</summary><div class="account-usage-popover"><strong>主机账户额度</strong><div v-for="window in windows" :key="window.key"><span>{{ window.name }} · {{ window.label }}</span><span>已用 {{ Math.round(window.used) }}%</span><progress :value="window.used" max="100"></progress><small>{{ resetTime(window.resetsAt) }}</small></div><p v-if="state.rateLimits?.ordinaryUsageAllowed === false">服务端已限制常规额度；以账户实际状态为准。</p></div></details>
    <span v-if="state.rateLimits?.ordinaryUsageAllowed === false" class="service-tier-error" role="status">常规额度已受限</span>
    <span v-if="error" class="service-tier-error" role="alert">{{ error }}</span>
  </div>
</template>
<style scoped>
.model-service-options { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.service-tier-select { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 11px; }
.service-tier-select select { max-width: 90px; border: 0; color: inherit; font: inherit; background: transparent; }
.account-usage { position: relative; font-size: 11px; color: var(--muted); }
.account-usage summary { display: flex; align-items: center; gap: 4px; cursor: pointer; list-style: none; }
.account-usage summary::-webkit-details-marker { display: none; }
.account-usage-popover { position: absolute; bottom: 28px; right: 0; width: min(280px, 80vw); z-index: 10; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 6px 20px #0002; }
.account-usage-popover > div { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin-top: 12px; }
.account-usage progress, .account-usage small { grid-column: 1 / -1; width: 100%; }
.service-tier-error { color: var(--red); font-size: 11px; }
@media(max-width:760px) { .service-tier-select select { max-width: 68px; } .account-usage summary { min-height: 36px; } }
</style>
