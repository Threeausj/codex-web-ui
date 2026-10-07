<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import Icon from './Icon.vue';
import {
  pwaState,
  installPwa,
  updatePwa,
  initializeDevicePush,
  enableDevicePush,
  disableDevicePush,
  testDevicePush,
  testSystemNotification,
  saveDevicePushPreferences,
  type PushPreferences,
} from '../lib/pwa';
const props = defineProps<{ api: any; state: any }>();
const notice = ref('');
const localError = ref('');
const testing = ref<'push' | 'system' | ''>('');
type DeliveryStatus = { devices: number; queued: number; overflow?: number; backlog?: number; retrying: number; delivered: number; failed: number; expired: number; nextRetryAt: number | null; lastDeliveredAt: number | null; lastFailureAt: number | null; lastFailure: string | null };
const deliveryStatus = ref<DeliveryStatus | null>(null);
const deliveryError = ref('');
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let statusReading = false;
const failures: Record<string, string> = { provider_unavailable: '推送服务暂时不可用', rate_limited: '推送服务限流', timeout: '推送连接超时', rejected: '推送服务拒绝请求', metadata_pending: '正在确认对话类型', expired: '通知已超过有效期' };
const retryTime = computed(() => deliveryStatus.value?.nextRetryAt ? new Date(deliveryStatus.value.nextRetryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
async function refreshDeliveryStatus() {
  clearTimeout(statusTimer);
  if (disposed || statusReading || pwaState.offline) return;
  statusReading = true;
  try {
    const result = await props.api.requestHttp('/push/status', { signal: AbortSignal.timeout(10000) }, false);
    if (!disposed) { deliveryStatus.value = result; deliveryError.value = ''; }
  } catch (cause: any) { if (!disposed) deliveryError.value = cause.message || '无法读取推送状态'; }
  finally {
    statusReading = false;
    if (!disposed && deliveryStatus.value?.queued) statusTimer = setTimeout(() => { void refreshDeliveryStatus(); }, 5000);
  }
}
const android = /Android/i.test(navigator.userAgent);
const categories: { key: keyof PushPreferences; label: string; description: string }[] = [
  { key: 'completed', label: '回复已完成', description: 'Codex 完成本次任务时提醒' },
  { key: 'approval', label: '需要审批', description: '需要你批准操作或回答问题时提醒' },
  { key: 'errors', label: '运行出错', description: '任务失败或运行异常时提醒' },
];
const pushReason = computed(() => {
  if (!pwaState.secureContext) return '手机安装和后台通知需要 HTTPS。请通过安全网址打开应用。';
  if (pwaState.appleMobile && !pwaState.installed) return '先添加到主屏幕，再从主屏幕打开应用启用通知。';
  if (pwaState.registrationStatus === 'development') return '开发模式不启用后台推送。请在生产构建或 Docker 部署中设置。';
  if (!pwaState.pushSupported) return '当前浏览器不支持后台推送，请使用支持 Web Push 的浏览器。';
  if (pwaState.pushPermission === 'denied') return '通知已被阻止。请在系统或浏览器设置中允许此应用发送通知。';
  if (pwaState.pushConfig && !pwaState.pushConfig.enabled) return pwaState.pushConfig.reason || '服务器尚未启用推送，请检查部署配置。';
  if (pwaState.configError) return pwaState.configError;
  if (pwaState.registrationStatus === 'error') return pwaState.error;
  if (!pwaState.pushReady) return '正在准备这台设备的通知设置…';
  return '';
});
const canEnable = computed(() => !pwaState.pushBusy && !pwaState.offline && pwaState.pushReady && pwaState.pushPermission !== 'denied' && (!pwaState.appleMobile || pwaState.installed));
async function operate(action: () => Promise<any>, message: string, progress = '') {
  notice.value = progress;
  localError.value = '';
  try { await action(); notice.value = message; }
  catch (cause: any) { localError.value = cause.message || '操作失败，请重试'; }
  finally { void refreshDeliveryStatus(); }
}
async function sendTest(kind: 'push' | 'system') {
  testing.value = kind;
  let queued = false;
  try {
    await operate(
      async () => {
        const result = kind === 'push' ? await testDevicePush(props.api) : await testSystemNotification();
        // Queue acceptance is different from push-provider acceptance.
        queued = kind === 'push' && result?.queued === true;
        return result;
      },
      kind === 'push' ? '推送服务已接收测试通知，请查看系统通知。' : '系统通知已发出，请查看通知栏。',
      kind === 'push' ? '正在发送测试通知…' : '正在检查系统通知…',
    );
    if (queued) notice.value = '推送服务暂时不可用，测试通知已保存，服务器会自动重试。';
  } finally { testing.value = ''; }
}
async function preferenceChanged(key: keyof PushPreferences, event: Event) {
  const input = event.target as HTMLInputElement;
  const preferences = { ...pwaState.pushPreferences, [key]: input.checked };
  await operate(() => saveDevicePushPreferences(props.api, preferences), '通知偏好已保存');
  input.checked = pwaState.pushPreferences[key];
}
onMounted(() => { void initializeDevicePush(props.api); void refreshDeliveryStatus(); });
onBeforeUnmount(() => { disposed = true; clearTimeout(statusTimer); });
</script>

<template>
  <div class="pwa-settings">
    <h3>应用与通知</h3>
    <p class="pwa-description">把工作区放到主屏幕，离开页面后也能收到任务进展。</p>

    <section class="pwa-section" aria-labelledby="pwa-install-heading">
      <div class="pwa-section-title">
        <div class="pwa-title"><Icon name="Smartphone" :size="18" /><h4 id="pwa-install-heading">安装应用</h4></div>
        <span v-if="pwaState.installed" class="pwa-status active"><Icon name="Check" :size="13" />已安装</span>
      </div>
      <p v-if="pwaState.installed">已通过独立应用打开。网络恢复后即可继续工作。</p>
      <template v-else>
        <p>使用独立窗口访问工作区，手机上无需一直保留浏览器标签页。</p>
        <button v-if="pwaState.canInstall" class="button button-secondary" :disabled="pwaState.installing" @click="operate(installPwa, '')"><Icon name="Download" :size="16" />{{ pwaState.installing ? '安装中…' : '安装应用' }}</button>
        <div v-else-if="pwaState.appleMobile" class="pwa-instructions"><Icon name="Smartphone" :size="17" /><span>在 Safari 中点击<strong>分享</strong>，选择<strong>添加到主屏幕</strong>，然后从主屏幕打开。iOS / iPadOS 16.4 或更新版本支持后台通知。</span></div>
        <div v-else class="pwa-instructions"><Icon name="Monitor" :size="17" /><span>在支持安装的浏览器中，通过地址栏安装图标或菜单中的<strong>安装应用</strong>添加到设备。</span></div>
      </template>
      <div class="pwa-update-row">
        <span>{{ pwaState.updateAvailable ? '有新版本可用' : '更新会在准备好后提示，不会打断对话' }}</span>
        <button v-if="pwaState.updateAvailable" class="button button-small button-secondary" :disabled="state.busy" @click="updatePwa"><Icon name="RefreshCw" :size="14" />更新应用</button>
      </div>
      <p v-if="pwaState.updateAvailable && state.busy" class="pwa-subtle">等待当前任务完成后再更新。</p>
    </section>

    <section class="pwa-section" aria-labelledby="pwa-push-heading">
      <div class="pwa-section-title">
        <div class="pwa-title"><Icon name="Wifi" :size="18" /><h4 id="pwa-push-heading">后台通知</h4></div>
        <span class="pwa-status" :class="{ active: pwaState.pushSubscribed }">{{ pwaState.pushSubscribed ? '本机已启用' : '未启用' }}</span>
      </div>
      <p>关闭页面或切换应用后，服务器通过系统通知提醒你。服务器需保持运行；通知显示对话名和事件，不包含回复正文、命令和文件路径。</p>
      <div v-if="pwaState.offline" class="pwa-instructions"><Icon name="WifiOff" :size="17" /><span>当前离线，连接网络后可修改通知设置。</span></div>
      <div v-else-if="pushReason" class="pwa-instructions"><Icon name="CircleHelp" :size="17" /><span>{{ pushReason }}</span></div>
      <div class="pwa-button-row">
        <button v-if="!pwaState.pushSubscribed" class="button" :disabled="!canEnable" @click="operate(() => enableDevicePush(api), '已启用这台设备的后台通知')"><Icon :name="pwaState.pushBusy ? 'LoaderCircle' : 'CheckCircle2'" :size="16" />启用通知</button>
        <template v-else>
          <button class="button button-secondary" :disabled="pwaState.pushBusy || pwaState.offline" @click="operate(() => disableDevicePush(api), '已关闭这台设备的后台通知')">关闭通知</button>
          <button class="button button-secondary" :disabled="pwaState.pushBusy || !!testing || pwaState.offline || !pwaState.pushReady" @click="sendTest('push')"><Icon :name="testing === 'push' ? 'LoaderCircle' : 'Send'" :class="{ spin: testing === 'push' }" :size="15" />{{ testing === 'push' ? '正在发送…' : '发送测试通知' }}</button>
        </template>
        <button v-if="pwaState.pushPermission === 'granted'" class="button button-secondary" :disabled="pwaState.pushBusy || !!testing" @click="sendTest('system')"><Icon :name="testing === 'system' ? 'LoaderCircle' : 'Bell'" :class="{ spin: testing === 'system' }" :size="15" />检查系统通知</button>
        <button class="icon-button" aria-label="刷新通知状态" title="刷新通知状态" :disabled="pwaState.pushBusy || pwaState.offline" @click="operate(() => initializeDevicePush(api), '')"><Icon name="RefreshCw" :size="16" /></button>
      </div>
      <div class="pwa-preferences" aria-label="通知类别">
        <label v-for="category in categories" :key="category.key" class="pwa-preference">
          <div><strong>{{ category.label }}</strong><span>{{ category.description }}</span></div>
          <input type="checkbox" :aria-label="category.label" :checked="pwaState.pushPreferences[category.key]" :disabled="pwaState.pushBusy || pwaState.offline" @change="preferenceChanged(category.key, $event)" />
        </label>
      </div>
      <div v-if="deliveryStatus && pwaState.pushSubscribed" class="pwa-delivery-status" aria-live="polite" aria-label="推送投递状态">
        <span>推送服务已接收 {{ deliveryStatus.delivered }} 条</span>
        <span v-if="deliveryStatus.queued">待发送 {{ deliveryStatus.queued }} 条<span v-if="deliveryStatus.retrying"> · 自动重试 {{ deliveryStatus.retrying }} 条</span><span v-if="retryTime"> · 下次 {{ retryTime }}</span></span>
        <span v-if="deliveryStatus.overflow">积压已达上限，{{ deliveryStatus.overflow }} 条未能入队</span>
        <span v-if="deliveryStatus.failed || deliveryStatus.expired">发送失败 {{ deliveryStatus.failed }} 条 · 已过期 {{ deliveryStatus.expired }} 条</span>
        <span v-if="deliveryStatus.lastFailure && (deliveryStatus.lastFailure !== 'metadata_pending' || deliveryStatus.queued) && (deliveryStatus.queued || (deliveryStatus.lastFailureAt || 0) > (deliveryStatus.lastDeliveredAt || 0))">{{ failures[deliveryStatus.lastFailure] || '发送暂时受阻' }}</span>
      </div>
      <p v-if="deliveryError" class="pwa-subtle">{{ deliveryError }}</p>
      <p class="pwa-subtle">设置仅作用于这台设备。退出登录会撤销本机通知；移动系统可能因省电或网络状态延迟送达。</p>
      <p class="pwa-subtle">网络或推送服务暂时出错时，服务器会保存通知并自动重试；最多尝试 8 次，有效期 1 小时。服务接收成功不代表手机已显示通知。</p>
      <p v-if="android" class="pwa-subtle">Android Chrome 的后台通知需要手机能连接 Google 推送服务。若测试已接收却未收到，先点击“检查系统通知”；能收到系统检查通知时，请检查手机的 Google 服务连接和省电设置。</p>
    </section>
    <div v-if="localError || pwaState.pushError" class="pwa-feedback error" role="alert"><Icon name="AlertCircle" :size="16" /><span>{{ localError || pwaState.pushError }}</span></div>
    <div v-else-if="notice" class="pwa-feedback" role="status"><Icon :name="testing ? 'LoaderCircle' : 'CheckCircle2'" :class="{ spin: !!testing }" :size="16" /><span>{{ notice }}</span></div>
  </div>
</template>

<style scoped>
.pwa-settings { min-width:0; }
.pwa-settings h3 { margin-bottom:10px; }
.pwa-description, .pwa-section p { color:var(--muted);font-size:12px;line-height:1.8; }
.pwa-description { margin-bottom:25px; }
.pwa-section { margin:0 0 22px;padding:0 0 22px;border-bottom:1px solid var(--border); }
.pwa-section-title, .pwa-title, .pwa-button-row, .pwa-update-row { display:flex;align-items:center;gap:9px; }
.pwa-section-title { justify-content:space-between;gap:12px;margin-bottom:12px; }
.pwa-title h4 { font-size:13px;font-weight:550;margin:0; }
.pwa-title > svg { color:var(--muted);flex-shrink:0; }
.pwa-status { display:inline-flex;align-items:center;gap:4px;flex-shrink:0;font-size:11px;color:var(--muted);background:var(--hover);padding:5px 8px;border-radius:7px; }
.pwa-status.active { color:var(--text);background:var(--selected); }
.pwa-instructions { display:flex;align-items:flex-start;gap:9px;padding:12px;margin:14px 0;background:var(--hover);border-radius:10px;font-size:12px;line-height:1.8;color:var(--muted); }
.pwa-instructions > svg { flex-shrink:0;margin-top:3px; }
.pwa-instructions strong { font-weight:500;color:var(--text);margin:0 3px; }
.pwa-button-row { flex-wrap:wrap;margin:16px 0; }
.pwa-button-row .button, .pwa-section > .button { min-height:38px;font-size:12px; }
.pwa-button-row .icon-button { margin-left:auto; }
.pwa-update-row { justify-content:space-between;margin:16px 0 0;font-size:11px;line-height:1.6;color:var(--muted); }
.pwa-update-row .button { flex-shrink:0; }
.pwa-preferences { margin-top:6px; }
.pwa-preference { display:flex;justify-content:space-between;align-items:center;gap:15px;padding:13px 0;border-top:1px solid var(--border);cursor:pointer; }
.pwa-preference > div { display:flex;flex-direction:column;gap:5px;min-width:0; }
.pwa-preference strong { font-weight:500;font-size:12px; }
.pwa-preference span { color:var(--muted);font-size:11px;line-height:1.6; }
.pwa-preference input { flex-shrink:0;width:17px;height:17px;accent-color:var(--text);cursor:pointer; }
.pwa-section p.pwa-subtle { font-size:11px;margin-top:14px; }
.pwa-feedback { display:flex;align-items:flex-start;gap:8px;line-height:1.7;font-size:12px;color:var(--muted); }
.pwa-feedback > svg { flex-shrink:0;margin-top:2px; }
.pwa-feedback.error { color:var(--danger, #b94d45); }
.pwa-delivery-status { display:flex;flex-direction:column;gap:5px;margin-top:14px;color:var(--muted);font-size:11px;line-height:1.7; }
@media(max-width:760px) {
  .pwa-description, .pwa-section p, .pwa-instructions { font-size:13px; }
  .pwa-title h4, .pwa-preference strong { font-size:14px; }
  .pwa-preference span, .pwa-section p.pwa-subtle { font-size:12px; }
  .pwa-status { font-size:12px; }
  .pwa-button-row .button, .pwa-section > .button { min-height:42px;font-size:13px; }
  .pwa-preference { min-height:44px; }
  .pwa-preference input { width:20px;height:20px; }
  .pwa-update-row { flex-wrap:wrap;font-size:12px; }
}
</style>
