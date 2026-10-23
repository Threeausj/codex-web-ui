<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import {
  pwaState,
  installPwa,
  updatePwa,
  checkPwaUpdate,
  cancelDeferredPwaUpdate,
  initializeDevicePush,
  enableDevicePush,
  disableDevicePush,
  testDevicePush,
  readDevicePushTest,
  testSystemNotification,
  saveDevicePushPreferences,
  type PushPreferences,
  type PushTestReceipt,
} from '../lib/pwa';
const props = defineProps<{ api: any; state: any }>();
const notice = ref('');
const localError = ref('');
const testing = ref<'push' | 'system' | ''>('');
const systemNotice = ref('');
type DeliveryStatus = { devices: number; queued: number; overflow?: number; backlog?: number; retrying: number; delivered: number; failed: number; expired: number; nextRetryAt: number | null; lastDeliveredAt: number | null; lastCompletedAcceptedAt?: number | null; lastFailureAt: number | null; lastFailure: string | null; observers?: { enabled: boolean; journalAvailable?: boolean; hosts: { hostId: string; state: string; watchedThreads: number; nextRetryAt: number | null }[] } };
const deliveryStatus = ref<DeliveryStatus | null>(null);
const deliveryError = ref('');
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let statusReading = false;
let statusRefreshPending = false;
let statusController: AbortController | undefined;
const failures: Record<string, string> = { provider_unavailable: '推送服务暂时不可用', rate_limited: '推送服务限流', timeout: '推送连接超时', rejected: '推送服务拒绝请求', metadata_pending: '正在确认对话类型', expired: '通知已超过有效期', queue_full: '推送队列已满' };
const retryTime = computed(() => deliveryStatus.value?.nextRetryAt ? new Date(deliveryStatus.value.nextRetryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const observerHosts = computed(() => deliveryStatus.value?.observers?.hosts || []);
const observerRetries = computed(() => observerHosts.value.filter(host => host.state === 'retrying').length);
const authentication = () => props.state.authenticationGeneration ?? props.api.runtimeIdentity?.().authenticationGeneration;
const authenticated = () => props.state.authenticated !== false;
async function refreshDeliveryStatus() {
  clearTimeout(statusTimer);
  if (disposed || !authenticated() || pwaState.offline) return;
  // A POST may finish while an older read is still in flight. Read again after
  // that response instead of silently dropping the requested refresh.
  if (statusReading) { statusRefreshPending = true; return; }
  const identity = authentication();
  const current = () => !disposed && authenticated() && identity === authentication();
  statusReading = true;
  const controller = statusController = new AbortController();
  try {
    const result = await props.api.requestHttp('/push/status', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) }, false);
    if (current()) { deliveryStatus.value = result; deliveryError.value = ''; }
  } catch (cause: any) { if (current()) deliveryError.value = cause.message || '无法读取推送状态'; }
  finally {
    statusReading = false;
    if (statusController === controller) statusController = undefined;
    if (!disposed && authenticated() && statusRefreshPending) { statusRefreshPending = false; void refreshDeliveryStatus(); }
    else if (current() && (deliveryStatus.value?.queued || observerRetries.value)) statusTimer = setTimeout(() => { void refreshDeliveryStatus(); }, 5000);
  }
}
const testId = ref('');
const testReceipt = ref<PushTestReceipt | null>(null);
const testReading = ref(false);
const testReadError = ref('');
const testQueryPaused = ref(false);
let testGeneration = 0;
let testIdentity: number | undefined;
let testTimer: ReturnType<typeof setTimeout> | undefined;
let testLimitTimer: ReturnType<typeof setTimeout> | undefined;
let testController: AbortController | undefined;
const terminalTest = () => !!testReceipt.value && ['accepted', 'failed', 'expired'].includes(testReceipt.value.state);
const waitingForTest = computed(() => !!testId.value && !terminalTest() && !testQueryPaused.value);
const currentTest = (generation: number) => !disposed && authenticated() && generation === testGeneration && testIdentity === authentication();
function stopTestPolling() {
  clearTimeout(testTimer); clearTimeout(testLimitTimer);
  testTimer = testLimitTimer = undefined;
  testController?.abort(); testController = undefined;
}
function resetTest() {
  ++testGeneration; stopTestPolling();
  testId.value = ''; testReceipt.value = null; testReading.value = false;
  testReadError.value = ''; testQueryPaused.value = false; systemNotice.value = '';
}
function beginTestQueryWindow(generation: number) {
  clearTimeout(testLimitTimer);
  testQueryPaused.value = false;
  testLimitTimer = setTimeout(() => {
    if (!currentTest(generation) || terminalTest()) return;
    testQueryPaused.value = true;
    stopTestPolling(); testReading.value = false;
    testReadError.value = '本次测试状态查询已暂停。服务器仍会按原计划发送；点击“刷新本次测试”继续查询，不会重复发送。';
  }, 120000);
}
async function refreshTestReceipt(manual = false) {
  const generation = testGeneration;
  if (!testId.value || !currentTest(generation) || testReading.value) return;
  if (manual) beginTestQueryWindow(generation);
  clearTimeout(testTimer);
  if (pwaState.offline || testQueryPaused.value) return;
  const controller = testController = new AbortController();
  testReading.value = true;
  try {
    const result = await readDevicePushTest(props.api, testId.value, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
    if (!currentTest(generation) || testController !== controller) return;
    testReceipt.value = result;
    testReadError.value = '';
    if (terminalTest()) stopTestPolling();
  } catch (cause: any) {
    if (!currentTest(generation) || testController !== controller) return;
    if (cause.status === 403 || cause.status === 404 || cause.status === 410) {
      testQueryPaused.value = true;
      testReadError.value = '本次测试记录已失效或无法访问。请刷新通知状态；若仍失败，请关闭并重新启用通知。';
      stopTestPolling();
    } else testReadError.value = cause.name === 'TimeoutError' || cause.name === 'AbortError' || /超时/.test(cause.message || '')
      ? '读取本次测试状态超时，连接恢复后会继续查询，不会重复发送。'
      : '无法读取本次测试状态，请检查网络。连接恢复后会继续查询，不会重复发送。';
  } finally {
    if (currentTest(generation)) {
      // An aborted read can settle after a manual refresh has already begun.
      // Only its own controller may release that newer read's busy state.
      if (!testController || testController === controller) {
        testReading.value = false;
        if (testController === controller) testController = undefined;
        if (!terminalTest() && !testQueryPaused.value && !pwaState.offline)
          testTimer = setTimeout(() => { void refreshTestReceipt(); }, 3000);
      }
    } else if (!disposed && generation === testGeneration) { resetTest(); testing.value = ''; notice.value = ''; localError.value = ''; }
  }
}
const testMessage = computed(() => {
  const receipt = testReceipt.value;
  if (!receipt) return '';
  if (receipt.state === 'accepted') return '推送服务已接收本次测试通知，不代表手机已显示。未收到时可点击“检查系统通知”。';
  if (receipt.state === 'failed') return `本次测试发送失败：${failures[receipt.failure || ''] || '推送服务拒绝请求'}。请刷新通知状态后检查连接。`;
  if (receipt.state === 'expired') return '本次测试通知已过期，未能送达推送服务。请检查连接后再测试。';
  if (receipt.state === 'retrying') {
    const at = receipt.nextRetryAt ? new Date(receipt.nextRetryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    return `本次测试正在自动重试：${failures[receipt.failure || ''] || '发送暂时受阻'}${at ? `；下次 ${at}` : ''}。无需再次发送。`;
  }
  if (receipt.state === 'sending') return '正在向推送服务发送本次测试通知…';
  return '服务器已接收本次测试通知，正在等待发送…';
});
const feedbackError = computed(() => {
  if (testing.value === 'system') return '';
  const error = localError.value || pwaState.pushError || testReadError.value || (['failed', 'expired'].includes(testReceipt.value?.state || '') ? testMessage.value : '');
  return error ? [systemNotice.value, error].filter(Boolean).join(' ') : '';
});
const feedbackNotice = computed(() => [systemNotice.value, testMessage.value || (systemNotice.value ? '' : notice.value)].filter(Boolean).join(' '));
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
const updateStatus = computed(() => {
  if (pwaState.updateCheckStatus === 'checking') return '正在检查更新…';
  if (pwaState.updateBusy) return '正在更新应用…';
  if (pwaState.updateDeferred) return '已安排在当前任务结束后更新';
  if (pwaState.updateAvailable) return '有新版本可用';
  if (pwaState.updateCheckStatus === 'latest') return '当前已是服务器上的最新版本';
  if (pwaState.updateCheckStatus === 'error') return '检查更新失败，请重试';
  return '更新准备好后会提示，也可以手动检查';
});
async function operate(action: () => Promise<any>, message: string, progress = '') {
  const identity = authentication();
  const current = () => !disposed && authenticated() && identity === authentication();
  notice.value = progress;
  systemNotice.value = '';
  localError.value = '';
  try { await action(); if (current()) notice.value = message; }
  catch (cause: any) { if (current()) localError.value = cause.message || '操作失败，请重试'; }
  finally { if (current()) void refreshDeliveryStatus(); }
}
async function sendTest(kind: 'push' | 'system') {
  // Checking local display must not forget an already queued remote test or
  // unlock a second send while the first test is waiting for its receipt.
  if (kind === 'push') { resetTest(); systemNotice.value = ''; }
  const generation = testGeneration;
  testIdentity = authentication();
  testing.value = kind;
  if (kind === 'push') notice.value = '正在发送测试通知…';
  else systemNotice.value = '正在检查系统通知…';
  localError.value = '';
  try {
    const result = kind === 'push' ? await testDevicePush(props.api) : await testSystemNotification();
    if (!currentTest(generation)) return;
    if (kind === 'system') { systemNotice.value = '系统通知已发出，请查看通知栏。'; return; }
    notice.value = result?.queued
      ? '服务器已接收测试通知，正在等待发送。当前服务器不提供本次投递状态，请勿重复点击。'
      : '服务器已接收测试通知请求，请查看系统通知。';
    if (kind === 'push' && typeof result?.deliveryId === 'string' && /^[0-9a-f-]{36}$/i.test(result.deliveryId)) {
      testId.value = result.deliveryId;
      notice.value = '服务器已接收本次测试通知，正在等待发送…';
      beginTestQueryWindow(generation);
      void refreshTestReceipt();
    }
  } catch (cause: any) {
    if (currentTest(generation)) localError.value = cause.status === 403 || cause.status === 404
      ? '这台设备的通知授权已失效，请刷新通知状态；若仍失败，请关闭并重新启用通知。'
      : cause.message || '无法发送测试通知，请重试。';
  } finally {
    if (currentTest(generation)) { testing.value = ''; void refreshDeliveryStatus(); }
    else if (!disposed && generation === testGeneration) { resetTest(); testing.value = ''; notice.value = ''; localError.value = ''; }
  }
}
async function refreshNotificationStatus() {
  await operate(() => initializeDevicePush(props.api), '通知状态已刷新');
  if (testId.value) await refreshTestReceipt(true);
}
async function preferenceChanged(key: keyof PushPreferences, event: Event) {
  const input = event.target as HTMLInputElement;
  const preferences = { ...pwaState.pushPreferences, [key]: input.checked };
  await operate(() => saveDevicePushPreferences(props.api, preferences), '通知偏好已保存');
  input.checked = pwaState.pushPreferences[key];
}
onMounted(() => { void initializeDevicePush(props.api); void refreshDeliveryStatus(); });
watch(() => pwaState.offline, offline => {
  if (offline) { clearTimeout(testTimer); testController?.abort(); }
  else { void refreshDeliveryStatus(); if (testId.value && !testQueryPaused.value) void refreshTestReceipt(); }
});
watch(authentication, () => {
  resetTest(); testing.value = ''; notice.value = ''; localError.value = '';
  deliveryStatus.value = null; deliveryError.value = '';
  clearTimeout(statusTimer); statusController?.abort();
  void refreshDeliveryStatus();
});
watch(() => [props.state.authenticated, pwaState.pushSubscribed], ([signedIn, subscribed]) => {
  if (signedIn === false || !subscribed) { resetTest(); testing.value = ''; }
  if (signedIn === false) { clearTimeout(statusTimer); statusController?.abort(); statusRefreshPending = false; notice.value = ''; systemNotice.value = ''; localError.value = ''; }
});
onBeforeUnmount(() => { disposed = true; ++testGeneration; stopTestPolling(); clearTimeout(statusTimer); statusController?.abort(); });
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
    </section>

    <section class="pwa-section" aria-labelledby="pwa-update-heading">
      <div class="pwa-section-title">
        <div class="pwa-title"><Icon name="RefreshCw" :size="18" /><h4 id="pwa-update-heading">应用更新</h4></div>
      </div>
      <p>获取服务器已部署的最新版，更新当前网页或已安装应用。运行中的任务和正在编辑的消息会在结束后再更新。</p>
      <div class="pwa-update-row">
        <span role="status" aria-live="polite">{{ updateStatus }}</span>
        <div class="pwa-update-actions">
          <button class="button button-small button-secondary" :disabled="pwaState.updateCheckStatus === 'checking' || pwaState.updateBusy" @click="checkPwaUpdate"><Icon name="RefreshCw" :size="14" :class="{ spin: pwaState.updateCheckStatus === 'checking' }" />{{ pwaState.updateCheckStatus === 'checking' ? '正在检查…' : pwaState.updateCheckStatus === 'error' ? '重试检查' : '检查更新' }}</button>
          <button v-if="pwaState.updateDeferred" class="button button-small button-secondary" @click="cancelDeferredPwaUpdate">取消等待</button>
          <button v-else-if="pwaState.updateAvailable || pwaState.updateError" class="button button-small button-secondary" :disabled="pwaState.updateBusy || pwaState.updateCheckStatus === 'checking'" @click="updatePwa"><Icon name="Download" :size="14" :class="{ spin: pwaState.updateBusy }" />{{ pwaState.updateBusy ? '正在更新…' : state.busy ? '任务完成后更新' : '更新应用' }}</button>
        </div>
      </div>
      <p v-if="pwaState.updateCheckError || pwaState.updateError" class="pwa-subtle pwa-update-error" role="alert">{{ pwaState.updateCheckError || pwaState.updateError }}</p>
    </section>

    <section class="pwa-section" aria-labelledby="pwa-push-heading">
      <div class="pwa-section-title">
        <div class="pwa-title"><Icon name="Wifi" :size="18" /><h4 id="pwa-push-heading">后台通知</h4></div>
        <span class="pwa-status" :class="{ active: pwaState.pushSubscribed }">{{ pwaState.pushSubscribed ? '本机已启用' : '未启用' }}</span>
      </div>
      <p>关闭页面或切换应用后，服务器通过系统通知提醒你。服务器需保持运行；通知显示对话名和事件，不包含回复正文、命令和文件路径。</p>
      <div v-if="pwaState.offline" class="pwa-instructions"><Icon name="WifiOff" :size="17" /><span>当前离线，连接网络后可修改通知设置。</span></div>
      <div v-else-if="pushReason" class="pwa-instructions"><Icon name="CircleHelp" :size="17" /><span>{{ pushReason }}</span></div>
      <div class="pwa-feedback-area" aria-label="通知操作结果">
        <div v-if="feedbackError" class="pwa-feedback error" role="alert"><Icon name="AlertCircle" :size="16" /><span>{{ feedbackError }}</span></div>
        <div v-else-if="feedbackNotice" class="pwa-feedback" role="status"><Icon :name="testing || waitingForTest ? 'LoaderCircle' : 'CheckCircle2'" :class="{ spin: !!testing || waitingForTest }" :size="16" /><span>{{ feedbackNotice }}<template v-if="pwaState.offline && waitingForTest"> 当前离线，网络恢复后继续查询。</template></span></div>
      </div>
      <div class="pwa-button-row">
        <button v-if="!pwaState.pushSubscribed" class="button" :disabled="!canEnable" @click="operate(() => enableDevicePush(api), '已启用这台设备的后台通知')"><Icon :name="pwaState.pushBusy ? 'LoaderCircle' : 'CheckCircle2'" :size="16" />启用通知</button>
        <template v-else>
          <button class="button button-secondary" :disabled="pwaState.pushBusy || pwaState.offline" @click="operate(() => disableDevicePush(api), '已关闭这台设备的后台通知')">关闭通知</button>
          <button class="button button-secondary" :disabled="pwaState.pushBusy || !!testing || waitingForTest || pwaState.offline || !pwaState.pushReady" @click="sendTest('push')"><Icon :name="testing === 'push' || waitingForTest ? 'LoaderCircle' : 'Send'" :class="{ spin: testing === 'push' || waitingForTest }" :size="15" />{{ testing === 'push' ? '正在发送…' : waitingForTest ? '等待测试状态…' : '发送测试通知' }}</button>
        </template>
        <button v-if="pwaState.pushPermission === 'granted'" class="button button-secondary" :disabled="pwaState.pushBusy || !!testing" @click="sendTest('system')"><Icon :name="testing === 'system' ? 'LoaderCircle' : 'Bell'" :class="{ spin: testing === 'system' }" :size="15" />检查系统通知</button>
        <button v-if="testId" class="button button-small button-secondary" :disabled="testReading || pwaState.offline || !!testing" @click="refreshTestReceipt(true)"><Icon name="RefreshCw" :size="14" :class="{ spin: testReading }" />刷新本次测试</button>
        <button class="icon-button" aria-label="刷新通知状态" title="刷新通知状态" :disabled="pwaState.pushBusy || pwaState.offline" @click="refreshNotificationStatus"><Icon name="RefreshCw" :size="16" /></button>
      </div>
      <div class="pwa-preferences" aria-label="通知类别">
        <label v-for="category in categories" :key="category.key" class="pwa-preference">
          <div><strong>{{ category.label }}</strong><span>{{ category.description }}</span></div>
          <input type="checkbox" :aria-label="category.label" :checked="pwaState.pushPreferences[category.key]" :disabled="pwaState.pushBusy || pwaState.offline" @change="preferenceChanged(category.key, $event)" />
        </label>
      </div>
      <div v-if="deliveryStatus?.observers?.enabled" class="pwa-delivery-status" aria-live="polite" aria-label="后台通知观察状态">
        <span>后台观察：{{ observerHosts.filter(host => host.state === 'observing').length }} 个主机已连接<span v-if="observerRetries"> · {{ observerRetries }} 个主机正在自动重连</span><span v-if="observerHosts.some(host => host.state === 'paused')"> · {{ observerHosts.filter(host => host.state === 'paused').length }} 个主机已暂停</span></span>
        <span>通知观察由服务器保持，关闭全部网页后仍会继续；恢复连接后会核对运行任务的完成状态。</span>
        <span v-if="deliveryStatus.observers.journalAvailable === false">后台恢复记录暂时无法保存，请检查服务器存储空间和目录权限。</span>
      </div>
      <div v-if="deliveryStatus && pwaState.pushSubscribed" class="pwa-delivery-status" aria-live="polite" aria-label="推送投递状态">
        <span>推送服务已接收 {{ deliveryStatus.delivered }} 条</span>
        <span v-if="deliveryStatus.lastCompletedAcceptedAt">最近完成提醒已由推送服务接收：{{ new Date(deliveryStatus.lastCompletedAcceptedAt).toLocaleString() }}（不代表手机已显示）</span>
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
.pwa-update-actions { display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px; }
.pwa-update-error { color:var(--danger, #b94d45); }
.pwa-preferences { margin-top:6px; }
.pwa-preference { display:flex;justify-content:space-between;align-items:center;gap:15px;padding:13px 0;border-top:1px solid var(--border);cursor:pointer; }
.pwa-preference > div { display:flex;flex-direction:column;gap:5px;min-width:0; }
.pwa-preference strong { font-weight:500;font-size:12px; }
.pwa-preference span { color:var(--muted);font-size:11px;line-height:1.6; }
.pwa-preference input { flex-shrink:0;width:17px;height:17px;accent-color:var(--text);cursor:pointer; }
.pwa-section p.pwa-subtle { font-size:11px;margin-top:14px; }
.pwa-feedback-area { min-height:84px;display:flex;align-items:center;margin-top:12px; }
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
  .pwa-feedback-area { min-height:96px; }
}
</style>
