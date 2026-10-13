<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { copyText } from "../lib/copy-text";

const props = defineProps<{ api: any; state: any; hostId: string }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const information = ref<any>(null);
const provider = ref<"official" | "gateway">("official");
const baseUrl = ref("");
const apiKey = ref("");
const model = ref("");
const loading = ref(false);
const operation = ref("");
const error = ref("");
const notice = ref("");
const deviceLogin = ref<any>(null);
let generation = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let loginChecks = 0;
let disposed = false;
const account = computed(() => information.value?.account?.account || information.value?.account || null);
const blocked = computed(() => {
  if (!information.value) return "请先读取主机的 Codex 设置";
  if (information.value.canChange === false) return information.value.disabledReason || "当前主机无法更改 Codex 设置";
  if (props.hostId === props.state.hostId && props.state.busy) return "任务运行中，完成或停止后可切换模型账户。";
  return "";
});
const pending = computed(() => loading.value || !!operation.value);
const loginUrl = computed(() => {
  const value = deviceLogin.value?.verificationUrl;
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
});
function stopPolling() { clearTimeout(pollTimer); pollTimer = undefined; }
function applyInformation(value: any, initializeForm = false) {
  information.value = value;
  if (initializeForm) {
    provider.value = value?.provider === "gateway" ? "gateway" : "official";
    baseUrl.value = value?.baseUrl || "";
    model.value = value?.model || "";
    apiKey.value = "";
  }
}
async function refresh(initializeForm = true) {
  if (pending.value || !props.state.authenticated) return;
  const token = ++generation;
  const hostId = props.hostId;
  loading.value = true;
  error.value = "";
  try {
    const result = await props.api.readHostCodexSettings(hostId);
    if (!disposed && token === generation && hostId === props.hostId) {
      applyInformation(result, initializeForm);
      if (deviceLogin.value) {
        if (account.value?.type === "chatgpt") {
          stopPolling();
          deviceLogin.value = null;
          notice.value = "ChatGPT 账户已登录。";
        } else scheduleLoginCheck(hostId, deviceLogin.value.loginId, token);
      }
    }
  } catch (cause: any) {
    if (!disposed && token === generation && hostId === props.hostId) error.value = cause.message || "无法读取 Codex 设置";
  } finally { if (token === generation) loading.value = false; }
}
async function run(name: string, fn: (hostId: string) => Promise<any>, message?: string, allowBlocked = false) {
  if (pending.value || (!allowBlocked && blocked.value) || !props.state.authenticated) return;
  const token = ++generation;
  const hostId = props.hostId;
  operation.value = name;
  emit("busy", true);
  error.value = "";
  notice.value = "";
  try {
    const result = await fn(hostId);
    if (disposed || token !== generation || hostId !== props.hostId) return;
    if (message) notice.value = message;
    return result;
  } catch (cause: any) {
    if (!disposed && token === generation && hostId === props.hostId) error.value = cause.message || "Codex 设置操作失败";
  } finally {
    if (token === generation) { operation.value = ""; emit("busy", false); }
  }
}
function gatewayAddress(value: string) {
  const input = value.trim();
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search)
    throw new Error("请输入有效的 HTTP / HTTPS 中转地址，不包含账号、密码、查询参数或片段。");
  return input.replace(/\/+$/, "");
}
async function save() {
  const result = await run("save", async hostId => {
    const update: Record<string, string> = { provider: provider.value };
    if (provider.value === "gateway") {
      try { update.baseUrl = gatewayAddress(baseUrl.value); }
      catch (cause: any) { throw new Error(cause.message?.startsWith("请输入") ? cause.message : "请输入有效的中转地址，例如 https://api.example.com/v1"); }
      if (!apiKey.value.trim() && !information.value?.hasApiKey) throw new Error("请输入中转站 API 密钥");
      if (apiKey.value.trim()) update.apiKey = apiKey.value.trim();
      if (model.value.trim()) update.model = model.value.trim();
    }
    try { return await props.api.updateHostCodexProvider(hostId, update); }
    finally { apiKey.value = ""; }
  }, "模型提供方已更新，后续任务使用新配置。");
  if (result) {
    stopPolling();
    deviceLogin.value = null;
    applyInformation(result, true);
    if (result.warning) { notice.value = ""; error.value = result.warning; }
  }
}
function scheduleLoginCheck(hostId: string, loginId: string, token: number) {
  stopPolling();
  if (loginChecks >= 200) {
    notice.value = "登录状态自动检查已暂停，完成授权后可点击“检查登录状态”。";
    return;
  }
  pollTimer = setTimeout(async () => {
    if (disposed || hostId !== props.hostId || deviceLogin.value?.loginId !== loginId || token !== generation) return;
    try {
      loginChecks++;
      const value = await props.api.readHostCodexSettings(hostId);
      if (disposed || token !== generation || hostId !== props.hostId || deviceLogin.value?.loginId !== loginId) return;
      applyInformation(value);
      if (account.value?.type === "chatgpt") {
        deviceLogin.value = null;
        notice.value = "ChatGPT 账户已登录。";
        return;
      }
    } catch (cause: any) {
      if (disposed || token !== generation || hostId !== props.hostId) return;
      error.value = cause.message || "无法确认登录状态，可手动刷新重试。";
    }
    scheduleLoginCheck(hostId, loginId, token);
  }, 3000);
}
async function login() {
  const result = await run("login", hostId => props.api.loginHostCodexAccount(hostId, { type: "deviceAuth" }));
  if (!result) return;
  deviceLogin.value = result;
  loginChecks = 0;
  if (!loginUrl.value || !result.loginId || !result.userCode) {
    error.value = "主机没有返回有效的设备登录地址和验证码，请更新 Codex 后重试。";
    deviceLogin.value = null;
    return;
  }
  notice.value = "在浏览器打开登录页面，输入验证码完成授权。";
  scheduleLoginCheck(props.hostId, result.loginId, generation);
}
async function cancelLogin() {
  if (!deviceLogin.value?.loginId || pending.value || !props.state.authenticated) return;
  const hostId = props.hostId;
  const loginId = deviceLogin.value.loginId;
  await run("cancel", selectedHost => props.api.cancelHostCodexLogin(selectedHost, loginId), "已取消设备登录。", true);
  if (disposed || hostId !== props.hostId || loginId !== deviceLogin.value?.loginId) return;
  if (!error.value) { stopPolling(); deviceLogin.value = null; }
}
async function copyLoginCode() {
  if (!deviceLogin.value?.userCode) return;
  const hostId = props.hostId;
  const loginId = deviceLogin.value.loginId;
  try {
    await copyText(deviceLogin.value.userCode, () => {
      if (disposed || hostId !== props.hostId || loginId !== deviceLogin.value?.loginId) throw new Error("设备登录已变化，请重新复制验证码");
    });
    notice.value = "验证码已复制。";
  } catch (cause: any) { if (!disposed && hostId === props.hostId) error.value = cause.message || "无法复制验证码"; }
}
async function logout() {
  const result = await run("logout", async hostId => {
    await props.api.logoutHostCodexAccount(hostId);
    return props.api.readHostCodexSettings(hostId);
  }, "已退出此主机的 Codex 账户。");
  if (result) applyInformation(result, true);
}
watch(() => props.hostId, () => {
  stopPolling();
  ++generation;
  information.value = null;
  deviceLogin.value = null;
  apiKey.value = "";
  baseUrl.value = "";
  model.value = "";
  error.value = "";
  notice.value = "";
  operation.value = "";
  loading.value = false;
  emit("busy", false);
  void refresh();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; ++generation; stopPolling(); apiKey.value = ""; emit("busy", false); });
</script>

<template>
  <section class="codex-settings" aria-label="Codex 设置">
    <div class="settings-title-row"><h3>Codex</h3><button class="icon-button" :disabled="pending" aria-label="刷新 Codex 设置" title="刷新 Codex 设置" @click="refresh()"><Icon :name="loading ? 'LoaderCircle' : 'RefreshCw'" :class="{ spin: loading }" :size="16" /></button></div>
    <p class="settings-description">切换所选主机的模型提供方和账户。更改会影响这台主机的 Codex，网页访问密码保持独立。</p>
    <p v-if="information?.provider && !['official', 'gateway'].includes(information.provider)" class="codex-note">当前使用自定义提供方 {{ information.provider }}。保存后切换为所选提供方。</p>
    <div class="codex-provider-options" role="group" aria-label="模型提供方">
      <button :class="{ active: provider === 'official' }" :aria-pressed="provider === 'official'" :disabled="pending || !!deviceLogin" @click="provider = 'official'; apiKey = ''"><Icon name="Bot" :size="17" />官方账户</button>
      <button :class="{ active: provider === 'gateway' }" :aria-pressed="provider === 'gateway'" :disabled="pending || !!deviceLogin" @click="provider = 'gateway'"><Icon name="Globe" :size="17" />中转站</button>
    </div>
    <form class="codex-provider-form" @submit.prevent="save">
      <template v-if="provider === 'gateway'">
        <label class="form-label">中转站 URL<input v-model="baseUrl" class="text-input" type="url" aria-label="中转站 URL" placeholder="https://api.example.com/v1" autocomplete="off" :disabled="pending || !!blocked" required /></label>
        <label class="form-label">API 密钥<input v-model="apiKey" class="text-input" type="password" aria-label="中转站 API 密钥" :placeholder="information?.hasApiKey ? '已配置，留空保留现有密钥' : '输入中转站 API 密钥'" autocomplete="new-password" spellcheck="false" :disabled="pending || !!blocked" /></label>
        <label class="form-label">模型<span class="optional">可选</span><input v-model="model" class="text-input" aria-label="中转站默认模型" placeholder="保留主机当前默认模型" autocomplete="off" :disabled="pending || !!blocked" /></label>
      </template>
      <p v-else class="codex-note">使用 OpenAI 官方服务。先保存提供方，再登录 ChatGPT 账户。</p>
      <p v-if="blocked && !loading" class="codex-note">{{ blocked }}</p>
      <button class="button button-primary" type="submit" :disabled="pending || !!blocked || !!deviceLogin"><Icon :name="operation === 'save' ? 'LoaderCircle' : 'Save'" :class="{ spin: operation === 'save' }" :size="15" />{{ operation === 'save' ? '保存中…' : '保存提供方' }}</button>
    </form>
    <div v-if="information?.provider === 'official' && provider === 'official'" class="codex-official-account">
      <h4>ChatGPT 账户</h4>
      <div v-if="account" class="codex-account-row"><Icon name="Bot" :size="22" /><div><strong>{{ account.email || (account.type === 'chatgpt' ? '已登录 ChatGPT' : account.type || '已登录') }}</strong><span>{{ account.planType || account.plan || '当前主机账户' }}</span></div><button class="button button-small button-secondary" :disabled="pending || !!blocked || !!deviceLogin" @click="logout">退出 Codex 账户</button></div>
      <button v-else-if="!deviceLogin" class="button button-secondary" :disabled="pending || !!blocked" @click="login"><Icon :name="operation === 'login' ? 'LoaderCircle' : 'ExternalLink'" :class="{ spin: operation === 'login' }" :size="15" />登录 ChatGPT</button>
      <div v-if="deviceLogin" class="codex-device-login">
        <p>在登录页面输入验证码</p>
        <div class="codex-device-code"><code>{{ deviceLogin.userCode }}</code><button class="icon-button" aria-label="复制登录验证码" title="复制登录验证码" @click="copyLoginCode"><Icon name="Copy" :size="16" /></button></div>
        <a v-if="loginUrl" :href="loginUrl" target="_blank" rel="noopener noreferrer" class="button button-secondary">打开登录页面<Icon name="ExternalLink" :size="14" /></a>
        <div class="codex-login-actions"><button class="button button-small button-secondary" :disabled="pending" @click="cancelLogin">取消登录</button><button class="button button-small button-secondary" :disabled="pending" @click="refresh(false)">检查登录状态</button></div>
      </div>
    </div>
    <p v-if="error" class="panel-error" role="alert"><Icon name="AlertCircle" :size="16" />{{ error }}</p>
    <p v-if="notice" class="settings-success" role="status"><Icon name="CheckCircle2" :size="16" />{{ notice }}</p>
  </section>
</template>

<style scoped>
.codex-provider-options { display:flex; gap:8px; margin:20px 0; }
.codex-provider-options button { display:flex; align-items:center; justify-content:center; gap:8px; flex:1; border:1px solid var(--border); border-radius:9px; padding:12px; font-size:12px; color:var(--muted); }
.codex-provider-options button.active { color:var(--text); background:var(--selected); border-color:var(--text); }
.codex-provider-form { display:flex; flex-direction:column; gap:17px; }
.codex-provider-form > .button { align-self:flex-end; }
.codex-note { color:var(--muted); font-size:11px; line-height:1.8; }
.codex-official-account { margin-top:26px; border-top:1px solid var(--border); padding-top:22px; }
.codex-official-account h4 { margin-bottom:16px; font-size:13px; font-weight:500; }
.codex-account-row { display:flex; align-items:center; gap:12px; }
.codex-account-row > div { display:flex; flex-direction:column; gap:5px; flex:1; min-width:0; }
.codex-account-row strong { font-size:12px; font-weight:500; overflow-wrap:anywhere; }
.codex-account-row span { font-size:11px; color:var(--muted); }
.codex-device-login { display:flex; flex-direction:column; align-items:flex-start; gap:14px; }
.codex-device-login p { color:var(--muted); font-size:12px; }
.codex-device-login code { font-size:20px; letter-spacing:3px; font-weight:500; }
.codex-device-code { display:flex; align-items:center; gap:14px; }
.codex-login-actions { display:flex; gap:9px; }
.codex-settings > .panel-error, .codex-settings > .settings-success { margin-top:16px; }
@media(max-width:760px) { .codex-provider-options button { font-size:13px; min-height:44px; } .codex-note { font-size:13px; } .codex-provider-form > .button { min-height:42px; width:100%; } .codex-account-row { flex-wrap:wrap; } .codex-account-row > .button { margin-left:auto; min-height:38px; } .codex-account-row strong { font-size:14px; } .codex-account-row span, .codex-device-login p { font-size:12px; } }
</style>
