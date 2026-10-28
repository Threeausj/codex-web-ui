<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { randomUUID } from '../lib/uuid';
import { activeCodexUpdate, type HostCodexUpdateStatus as UpdateInformation } from '../../shared/host-update';
import { privateState } from '../lib/private-state';
const props = defineProps<{ api: any; state: any; hostId: string; disabled?: boolean }>();
const emit = defineEmits<{ busy: [value: boolean]; completed: [hostId: string] }>();
const information = ref<UpdateInformation | null>(null);
const loading = ref(false);
const starting = ref(false);
const error = ref('');
const uncertain = ref(false);
let generation = 0;
let disposed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
const requestId = ref('');
const receiptNamespace = 'host-codex-update';
const refreshed = new Set<string>();
const operation = computed(() => information.value?.operation || null);
const active = computed(() => activeCodexUpdate(operation.value));
const working = computed(() => starting.value || active.value || uncertain.value);
const authenticated = () => props.state.authenticated !== false;
const authentication = () => props.state.authenticationGeneration ?? props.api.runtimeIdentity?.().authenticationGeneration;
const host = computed(() => props.state.hosts?.find((value: any) => value.id === props.hostId));
const reason = computed(() => {
  if (!authenticated()) return '请先登录';
  if (!host.value) return '请先选择执行主机';
  if (props.disabled) return '请等待当前主机设置操作完成';
  if (starting.value) return '正在提交更新请求';
  if (uncertain.value) return '更新请求结果待确认，请刷新更新状态';
  if (active.value) return '此主机正在更新，服务器会继续执行';
  if (!information.value) return '请先读取更新状态';
  if (!information.value.canUpdate) return information.value.disabledReason || '此主机当前无法更新 Codex';
  if (props.hostId === props.state.hostId && props.state.busy) return '主机上有运行中的任务，结束或停止后可更新';
  return '';
});
const canRetryRequest = computed(() => uncertain.value && !!requestId.value && authenticated() && !!host.value &&
  !starting.value && !loading.value && !props.disabled && !active.value && information.value?.canUpdate === true);
const status = computed(() => {
  if (uncertain.value) return '本次更新请求结果尚未确认，请刷新状态或重新提交同一更新请求。';
  const value = operation.value;
  if (!value) return '';
  if (value.message) return value.message;
  return {
    checking: '正在检查主机和当前 Codex 版本…',
    updating: '正在执行 codex update…',
    restarting: 'Codex 已更新，正在重启并核对运行版本…',
    completed: 'Codex 更新并重启完成。',
    failed: '更新未完成，请核对状态后重试。',
  }[value.state];
});
const path = (hostId: string) => `/hosts/${encodeURIComponent(hostId)}/codex-update`;
function stopPolling() { clearTimeout(timer); timer = undefined; }
function current(token: number, hostId: string, identity: unknown) {
  return !disposed && token === generation && hostId === props.hostId && identity === authentication() && authenticated();
}
function validate(value: any): UpdateInformation {
  if (!value || typeof value.canUpdate !== 'boolean' || value.operation !== null &&
      (!value.operation || typeof value.operation.id !== 'string' ||
      !['checking', 'updating', 'restarting', 'completed', 'failed'].includes(value.operation.state)))
    throw new Error('主机返回的更新状态无法识别，请刷新后重试');
  return value;
}
async function apply(value: UpdateInformation, token: number, hostId: string, identity: unknown) {
  if (!current(token, hostId, identity)) return;
  information.value = value;
  error.value = '';
  // A previous operation (or no record yet) cannot acknowledge a timed-out
  // POST. The same request ID remains available for an explicit safe retry.
  if (requestId.value && value.operation?.id === requestId.value) {
    await privateState.remove(receiptNamespace, hostId).catch(() => {});
    if (!current(token, hostId, identity)) return;
    requestId.value = '';
    uncertain.value = false;
  } else if (requestId.value) uncertain.value = true;
  if (!uncertain.value && value.operation?.state === 'completed' && !refreshed.has(value.operation.id)) {
    refreshed.add(value.operation.id);
    try {
      await props.api.refreshRuntimeInformation(hostId);
      if (current(token, hostId, identity)) emit('completed', hostId);
    } catch {
      if (current(token, hostId, identity)) error.value = '主机更新已完成，版本信息暂未同步；可点击“刷新更新状态”重试。';
      refreshed.delete(value.operation.id);
    }
  }
}
function schedule(token: number, hostId: string, identity: unknown, delay = 2000) {
  stopPolling();
  if (!current(token, hostId, identity) || !active.value && !uncertain.value) return;
  timer = setTimeout(() => { void refresh(); }, delay);
}
async function refresh() {
  if (disposed || !authenticated() || !host.value || loading.value || starting.value) return;
  stopPolling();
  const token = generation, hostId = props.hostId, identity = authentication();
  loading.value = true;
  const request = controller = new AbortController();
  try {
    const value = await props.api.requestHttp(path(hostId), {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
    }, false);
    if (!current(token, hostId, identity) || controller !== request) return;
    await apply(validate(value), token, hostId, identity);
  } catch (cause: any) {
    if (current(token, hostId, identity) && controller === request)
      error.value = cause.message || '无法读取主机更新状态；恢复连接后可刷新，不会重复执行更新。';
  } finally {
    if (current(token, hostId, identity) && controller === request) {
      loading.value = false; controller = undefined;
      schedule(token, hostId, identity, error.value ? 5000 : 2000);
    }
  }
}
async function start() {
  if (reason.value && !canRetryRequest.value || loading.value) return;
  stopPolling();
  const token = generation, hostId = props.hostId, identity = authentication();
  requestId.value ||= randomUUID();
  starting.value = true;
  error.value = '';
  const request = controller = new AbortController();
  let dispatched = false;
  try {
    await props.api.privateSessionReady();
    if (!current(token, hostId, identity)) return;
    await privateState.write(receiptNamespace, hostId, { id: requestId.value, createdAt: Date.now() }, true);
    if (!current(token, hostId, identity)) return;
    dispatched = true;
    const result = await props.api.requestHttp(path(hostId), {
      method: 'POST', body: JSON.stringify({ requestId: requestId.value }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
    }, false);
    if (!current(token, hostId, identity) || controller !== request) return;
    await apply(validate(result), token, hostId, identity);
  } catch (cause: any) {
    if (!current(token, hostId, identity) || controller !== request) return;
    const definite = !dispatched || cause.status >= 400 && cause.status < 500 && cause.status !== 408;
    if (definite) {
      await privateState.remove(receiptNamespace, hostId).catch(() => {});
      if (!current(token, hostId, identity)) return;
      requestId.value = '';
      uncertain.value = false;
      if (dispatched && information.value) information.value = { ...information.value, canUpdate: false,
        disabledReason: cause.message || '主机当前无法更新，请刷新状态后重试。' };
    }
    else uncertain.value = true;
    error.value = definite ? cause.message || '主机当前无法更新，请刷新状态后重试。'
      : '更新请求结果未确认。服务器可能已开始执行，正在读取状态；请勿重复提交。';
  } finally {
    if (current(token, hostId, identity) && controller === request) {
      starting.value = false; controller = undefined;
      if (active.value || uncertain.value) schedule(token, hostId, identity);
    }
  }
}
watch(working, value => emit('busy', value), { immediate: true });
watch([() => props.hostId, () => props.state.authenticationGeneration, () => props.state.authenticated], () => {
  ++generation; stopPolling(); controller?.abort(); controller = undefined;
  information.value = null; loading.value = true; starting.value = uncertain.value = false;
  error.value = ''; requestId.value = ''; refreshed.clear();
  const token = generation, hostId = props.hostId, identity = authentication();
  void (async () => {
    try {
      if (!authenticated() || !host.value) return;
      await props.api.privateSessionReady();
      if (!current(token, hostId, identity)) return;
      const receipt = await privateState.read<{ id: string; createdAt: number }>(receiptNamespace, hostId);
      if (!current(token, hostId, identity)) return;
      if (typeof receipt?.id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(receipt.id)) {
        requestId.value = receipt.id;
        uncertain.value = true;
      }
    } catch (cause: any) { if (current(token, hostId, identity)) error.value = cause.message || '无法读取更新凭据'; }
    finally {
      if (current(token, hostId, identity)) { loading.value = false; void refresh(); }
    }
  })();
}, { immediate: true });
watch(() => props.state.online, online => { if (online !== false && authenticated()) void refresh(); });
onBeforeUnmount(() => { disposed = true; ++generation; stopPolling(); controller?.abort(); emit('busy', false); });
defineExpose({ working });
</script>

<template>
  <section class="host-codex-update" aria-label="主机 Codex 更新" :aria-busy="working">
    <div class="host-update-heading"><div><h4>更新并重启 Codex</h4><p>在 {{ host?.name || '所选主机' }} 执行 <code>codex update</code>，再重启 Web 管理的 Codex 并核对运行版本。</p></div><Icon name="Download" :size="19" /></div>
    <dl v-if="information" class="host-update-versions">
      <div><dt>当前运行版本</dt><dd>{{ information.runtimeVersion || operation?.runtimeVersion || '未报告' }}</dd></div>
      <div v-if="operation?.beforeVersion"><dt>更新前</dt><dd>{{ operation.beforeVersion }}</dd></div>
      <div v-if="operation?.installedVersion"><dt>已安装版本</dt><dd>{{ operation.installedVersion }}</dd></div>
    </dl>
    <p v-if="reason && !active && !starting && !loading" class="host-update-reason">{{ reason }}</p>
    <p v-if="status" class="host-update-status" :class="{ failed: !uncertain && operation?.state === 'failed', completed: !uncertain && operation?.state === 'completed' }" role="status"><Icon :name="active || uncertain ? 'LoaderCircle' : operation?.state === 'failed' ? 'AlertCircle' : 'CheckCircle2'" :class="{ spin: active || uncertain }" :size="15" />{{ status }}</p>
    <p v-if="operation?.error && !uncertain" class="panel-error host-update-error" role="alert">{{ operation.error }}</p>
    <p v-if="error" class="panel-error host-update-error" role="alert">{{ error }}</p>
    <div class="host-update-actions">
      <button type="button" class="button button-secondary" :disabled="loading || starting || !host || !state.authenticated" @click="refresh"><Icon :name="loading ? 'LoaderCircle' : 'RefreshCw'" :class="{ spin: loading }" :size="15" />{{ loading ? '读取中…' : '刷新更新状态' }}</button>
      <button type="button" class="button button-primary" :disabled="!!reason && !canRetryRequest || loading" :title="reason || undefined" @click="start"><Icon :name="working && !canRetryRequest ? 'LoaderCircle' : 'Download'" :class="{ spin: working && !canRetryRequest }" :size="15" />{{ canRetryRequest ? '重新提交同一更新请求' : working ? '更新进行中…' : '更新并重启 Codex' }}</button>
    </div>
    <p class="host-update-help">更新由服务器继续执行，关闭设置不会取消。运行中的任务、终端或共享代理需要先处理，网页不会强制终止它们。</p>
  </section>
</template>

<style scoped>
.host-codex-update { margin-top: 26px; border-top: 1px solid var(--border); padding-top: 22px; }
.host-update-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.host-update-heading > svg { flex: 0 0 auto; color: var(--muted); margin-top: 2px; }
.host-update-heading h4 { margin: 0 0 8px; font-size: 13px; font-weight: 550; }
.host-update-heading p, .host-update-reason, .host-update-help { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }
.host-update-heading code { color: var(--text); }
.host-update-versions { display: flex; flex-wrap: wrap; gap: 14px 28px; margin: 18px 0; }
.host-update-versions div { min-width: 110px; }
.host-update-versions dt { font-size: 11px; color: var(--muted); margin-bottom: 5px; }
.host-update-versions dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.host-update-status { display: flex; align-items: flex-start; gap: 7px; font-size: 12px; line-height: 1.65; margin: 16px 0; overflow-wrap: anywhere; }
.host-update-status > svg { flex: 0 0 auto; margin-top: 2px; }
.host-update-status.failed { color: var(--danger); }
.host-update-status.completed { color: var(--green); }
.host-update-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; margin: 18px 0 12px; }
.host-update-actions .button { min-height: 36px; }
.host-update-error { margin: 14px 0 0; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .host-update-heading h4 { font-size: 14px; }
  .host-update-heading p, .host-update-reason, .host-update-help { font-size: 12px; }
  .host-update-status, .host-update-versions dt { font-size: 12px; }
  .host-update-versions dd { font-size: 14px; }
  .host-update-actions .button { flex: 1; min-height: 42px; white-space: nowrap; }
}
</style>
