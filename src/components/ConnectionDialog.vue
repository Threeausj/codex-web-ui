<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import Icon from "./Icon.vue";

const props = defineProps<{ api: any; host?: any }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const modal = ref<HTMLElement>();
const form = ref<HTMLFormElement>();
const keyInput = ref<HTMLInputElement>();
const busy = ref<"" | "test" | "save" | "upload" | "inspect" | "trust">("");
type HostKeyInfo = {
  hostname: string;
  port: number;
  status: "unknown" | "trusted" | "changed";
  keys: { type: string; fingerprint: string }[];
  previousFingerprints?: (string | { type?: string; fingerprint: string })[];
  challenge: string;
  expiresAt?: number | string;
};
const hostKey = ref<HostKeyInfo | null>(null);
const replaceHostKey = ref(false);
let hostKeyGeneration = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const uploadedKey = ref<{ identityFile: string; name: string }>();
const draftKeys = new Map<string, string>();
const error = ref("");
const testResult = ref<any>(null);
const identityMode = ref(props.host?.identityFile ? "file" : "default");
const draft = reactive({
  name: props.host?.name || "",
  hostname: `${props.host?.username ? props.host.username + "@" : ""}${props.host?.hostname || ""}`,
  port: props.host?.port ? String(props.host.port) : "",
  identityFile: props.host?.identityFile || "",
  codexPath:
    props.host?.codexPath === "codex" ? "" : props.host?.codexPath || "",
  cwd: props.host?.cwd || "",
});
const title = computed(() =>
  props.host?.id ? "编辑 SSH 连接" : "添加 SSH 连接",
);
const testedVersion = computed(() => testResult.value?.version || "");
const hostKeyTarget = computed(() => `${draft.hostname.trim()}\n${String(draft.port).trim()}`);
const hostKeyTrustLabel = computed(() =>
  hostKey.value?.status === "changed" ? "替换指纹并测试连接" : "信任并测试连接",
);
let previousFocus: HTMLElement | null = null;
let disposed = false;
let savedIdentityFile = "";

function clearHostKey() {
  hostKeyGeneration++;
  hostKey.value = null;
  replaceHostKey.value = false;
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
}
watch(hostKeyTarget, clearHostKey, { flush: "sync" });

function keyTarget() {
  const hostname = draft.hostname.trim();
  if (!hostname) throw new Error("请输入 SSH 主机名");
  const port = String(draft.port).trim() ? Number(draft.port) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error("请输入 1–65535 之间的 SSH 端口");
  return { hostname, port };
}
function isHostKeyError(cause: any) {
  return cause?.hostKeyRequired === true ||
    /主机密钥|服务器指纹|host key|host identification/i.test(cause?.message || "");
}
function previousFingerprint(key: string | { type?: string; fingerprint: string }) {
  return typeof key === "string" ? key : `${key.type ? `${key.type} · ` : ""}${key.fingerprint}`;
}
function scheduleHostKeyExpiry(info: HostKeyInfo, generation: number) {
  if (!info.challenge || !info.expiresAt) return;
  const expiry = typeof info.expiresAt === "number"
    ? (info.expiresAt < 1e12 ? info.expiresAt * 1000 : info.expiresAt)
    : Date.parse(info.expiresAt);
  if (!Number.isFinite(expiry)) return;
  expiryTimer = setTimeout(() => {
    if (disposed || generation !== hostKeyGeneration || hostKey.value?.challenge !== info.challenge) return;
    clearHostKey();
    error.value = "服务器指纹确认已过期，请重新获取服务器指纹。";
  }, Math.max(0, expiry - Date.now()));
}
async function fetchHostKey(target: { hostname: string; port: number | null }) {
  clearHostKey();
  const generation = hostKeyGeneration;
  const scope = hostKeyTarget.value;
  const result = await props.api.inspectHostKey(target);
  if (disposed || generation !== hostKeyGeneration || scope !== hostKeyTarget.value) return;
  if (!result?.keys?.length || !["unknown", "trusted", "changed"].includes(result.status))
    throw new Error("未获取到服务器指纹，请稍后重试。");
  if (result.status !== "trusted" && !result.challenge)
    throw new Error("服务器指纹确认已过期，请重新获取服务器指纹。");
  hostKey.value = result;
  error.value = "";
  scheduleHostKeyExpiry(result, generation);
}
async function finishBusy() {
  if (disposed) await cleanDraftKeys(savedIdentityFile);
  else busy.value = "";
}
async function inspectHostKey() {
  if (busy.value) return;
  error.value = "";
  testResult.value = null;
  try {
    const target = keyTarget();
    busy.value = "inspect";
    await fetchHostKey(target);
  } catch (cause: any) {
    if (!disposed) error.value = cause?.message || "获取服务器指纹失败";
  } finally {
    await finishBusy();
  }
}
async function checkConnection(fields: ReturnType<typeof payload>) {
  const generation = hostKeyGeneration;
  const scope = hostKeyTarget.value;
  const result = await props.api.testHost(fields);
  if (disposed || generation !== hostKeyGeneration || scope !== hostKeyTarget.value) return;
  if (result?.ok === false || result?.success === false) {
    const failure = new Error(result.error || result.message || "连接测试失败");
    if (result.hostKeyRequired === true) Object.assign(failure, { hostKeyRequired: true });
    throw failure;
  }
  testResult.value = result || { ok: true };
}
async function trustHostKey() {
  const info = hostKey.value;
  if (busy.value || !info?.challenge || info.status === "trusted" ||
      (info.status === "changed" && !replaceHostKey.value) || !form.value?.reportValidity()) return;
  error.value = "";
  testResult.value = null;
  try {
    const fields = payload();
    const generation = hostKeyGeneration;
    busy.value = "trust";
    clearTimeout(expiryTimer);
    const result = await props.api.trustHostKey({
      hostname: fields.hostname,
      port: fields.port,
      challenge: info.challenge,
      replace: info.status === "changed",
    });
    if (disposed || generation !== hostKeyGeneration) return;
    if (result?.ok === false) throw new Error(result.error || "信任服务器指纹失败");
    clearTimeout(expiryTimer);
    hostKey.value = { ...info, status: "trusted", challenge: "" };
    replaceHostKey.value = false;
    busy.value = "test";
    await checkConnection(fields);
  } catch (cause: any) {
    if (!disposed) {
      error.value = cause?.message || "信任服务器指纹失败";
      if (busy.value === "trust") clearHostKey();
      else if (isHostKeyError(cause)) {
        busy.value = "inspect";
        try { await fetchHostKey(keyTarget()); }
        catch (scanError: any) { error.value = scanError?.message || "获取服务器指纹失败"; }
      }
    }
  } finally {
    await finishBusy();
  }
}

async function cleanDraftKeys(keep = "") {
  await Promise.all([...draftKeys].map(async ([id, identityFile]) => {
    if (identityFile === keep) return;
    draftKeys.delete(id);
    await props.api.removeSshKey(id).catch(() => {});
  }));
}

async function uploadKey(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value) return;
  error.value = "";
  if (!file.size || file.size > 64 * 1024) {
    error.value = "请选择非空且不超过 64 KB 的私钥文件。";
    return;
  }
  busy.value = "upload";
  testResult.value = null;
  try {
    const key = await props.api.uploadSshKey(file);
    draftKeys.set(key.id, key.identityFile);
    if (disposed) {
      await cleanDraftKeys();
      return;
    }
    draft.identityFile = key.identityFile;
    uploadedKey.value = { identityFile: key.identityFile, name: file.name };
    await cleanDraftKeys(key.identityFile);
  } catch (cause: any) {
    if (!disposed) error.value = cause?.message || "上传私钥失败";
  } finally {
    if (!disposed) busy.value = "";
  }
}

watch(
  [draft, identityMode],
  () => {
    error.value = "";
    testResult.value = null;
  },
  { deep: true },
);

function payload() {
  const { hostname, port } = keyTarget();
  const identityFile =
    identityMode.value === "file" ? draft.identityFile.trim() : "";
  if (identityMode.value === "file" && !identityFile)
    throw new Error("请上传私钥或填写身份文件路径");
  return {
    name: draft.name.trim() || hostname,
    hostname,
    // The server parses user@host and clears the former separate username field.
    username: "",
    port,
    identityFile,
    codexPath: draft.codexPath.trim(),
    cwd: draft.cwd.trim(),
  };
}
async function submit(kind: "test" | "save") {
  if (busy.value || !form.value?.reportValidity()) return;
  error.value = "";
  testResult.value = null;
  try {
    const fields = payload();
    busy.value = kind;
    if (kind === "test") {
      await checkConnection(fields);
    } else {
      if (props.host?.id) await props.api.updateHost(props.host.id, fields);
      else await props.api.addHost(fields);
      savedIdentityFile = fields.identityFile;
      await cleanDraftKeys(savedIdentityFile);
      if (!disposed) emit("saved");
    }
  } catch (cause: any) {
    if (!disposed) {
      error.value =
        cause?.message || (kind === "test" ? "连接测试失败" : "保存连接失败");
      if (kind === "test" && isHostKeyError(cause)) {
        busy.value = "inspect";
        try { await fetchHostKey(keyTarget()); }
        catch (scanError: any) { error.value = scanError?.message || "获取服务器指纹失败"; }
      }
    }
  } finally {
    await finishBusy();
  }
}
function close() {
  if (busy.value !== "save" && busy.value !== "upload" && busy.value !== "trust") emit("close");
}
function focusableElements() {
  return [
    ...(modal.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), summary, textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
    ) || []),
  ].filter((element) => element.getClientRects().length > 0);
}
function onKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const elements = focusableElements();
  const first = elements[0];
  const last = elements.at(-1);
  if (!first) {
    event.preventDefault();
    modal.value?.focus();
    return;
  }
  if (
    event.shiftKey &&
    (document.activeElement === first ||
      !modal.value?.contains(document.activeElement))
  ) {
    event.preventDefault();
    last?.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last ||
      !modal.value?.contains(document.activeElement))
  ) {
    event.preventDefault();
    first.focus();
  }
}
onMounted(async () => {
  previousFocus = document.activeElement as HTMLElement | null;
  document.addEventListener("keydown", onKeyDown, true);
  await nextTick();
  modal.value?.querySelector<HTMLInputElement>("input")?.focus();
});
onBeforeUnmount(() => {
  disposed = true;
  clearHostKey();
  if (!busy.value) void cleanDraftKeys(savedIdentityFile);
  document.removeEventListener("keydown", onKeyDown, true);
  if (previousFocus?.isConnected) previousFocus.focus();
});
</script>

<template>
  <Teleport to="body">
    <div class="ssh-dialog-backdrop" @click.self="close">
      <section
        ref="modal"
        class="ssh-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
      >
        <header class="ssh-dialog-header">
          <h2>{{ title }}</h2>
          <button
            class="ssh-close icon-button"
            type="button"
            aria-label="关闭 SSH 连接"
            :disabled="busy === 'save' || busy === 'upload' || busy === 'trust'"
            @click="close"
          >
            <Icon name="X" :size="18" />
          </button>
        </header>
        <form
          ref="form"
          class="ssh-dialog-form"
          @submit.prevent="submit('save')"
        >
          <div class="ssh-dialog-fields">
            <label class="ssh-field">
              <span>显示名称</span>
              <div class="ssh-name-input">
                <span><Icon name="Globe" :size="18" /></span>
                <input
                  v-model="draft.name"
                  aria-label="SSH 显示名称"
                  :disabled="!!busy"
                  autocomplete="off"
                />
              </div>
            </label>
            <label class="ssh-field">
              <span>主机名</span>
              <input
                v-model="draft.hostname"
                aria-label="SSH 主机地址"
                placeholder="host.com 或 user@host.com"
                :disabled="!!busy"
                required
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <label class="ssh-field">
              <span>SSH 端口 <small>（可选）</small></span>
              <input
                v-model="draft.port"
                aria-label="SSH 端口"
                :disabled="!!busy"
                type="number"
                inputmode="numeric"
                min="1"
                max="65535"
                autocomplete="off"
              />
            </label>
            <button
              class="ssh-fingerprint-button"
              type="button"
              :disabled="!!busy || !draft.hostname.trim()"
              @click="inspectHostKey"
            >
              <Icon
                :name="busy === 'inspect' ? 'LoaderCircle' : 'Shield'"
                :size="15"
                :class="{ spin: busy === 'inspect' }"
              />{{ busy === "inspect" ? "正在获取服务器指纹…" : "获取服务器指纹" }}
            </button>
            <section
              v-if="hostKey"
              class="ssh-host-key"
              :class="{ changed: hostKey.status === 'changed', trusted: hostKey.status === 'trusted' }"
              aria-label="SSH 服务器指纹"
            >
              <h3>{{ hostKey.status === "changed" ? "服务器指纹已变更" : hostKey.status === "trusted" ? "服务器指纹已受信任" : "首次连接：确认服务器指纹" }}</h3>
              <p class="ssh-host-key-target">{{ hostKey.hostname }}:{{ hostKey.port }}</p>
              <template v-if="hostKey.status === 'changed'">
                <p>请确认服务器重装或更换密钥后，再替换此前保存的指纹。</p>
                <div v-if="hostKey.previousFingerprints?.length" class="ssh-fingerprint-list previous">
                  <strong>此前信任的指纹</strong>
                  <code v-for="(key, index) in hostKey.previousFingerprints" :key="index">{{ previousFingerprint(key) }}</code>
                </div>
              </template>
              <p v-else-if="hostKey.status === 'unknown'">核对下方指纹后点击信任，即可直接测试连接。</p>
              <div class="ssh-fingerprint-list">
                <strong>{{ hostKey.status === "changed" ? "本次获取的指纹" : "服务器公钥指纹" }}</strong>
                <div v-for="key in hostKey.keys" :key="`${key.type}:${key.fingerprint}`">
                  <span>{{ key.type }}</span>
                  <code>{{ key.fingerprint }}</code>
                </div>
              </div>
              <label v-if="hostKey.status === 'changed'" class="ssh-replace-host-key">
                <input v-model="replaceHostKey" type="checkbox" :disabled="!!busy" />
                <span>我已确认服务器密钥变更，同意替换此前信任的指纹</span>
              </label>
              <button
                v-if="hostKey.status !== 'trusted'"
                class="ssh-trust-button"
                type="button"
                :disabled="!!busy || !hostKey.challenge || (hostKey.status === 'changed' && !replaceHostKey)"
                @click="trustHostKey"
              >
                <Icon :name="busy === 'trust' ? 'LoaderCircle' : 'Shield'" :size="15" :class="{ spin: busy === 'trust' }" />
                {{ busy === "trust" ? "正在保存服务器指纹…" : hostKeyTrustLabel }}
              </button>
            </section>
            <div
              class="ssh-identity-selector"
              role="group"
              aria-label="SSH 身份验证方式"
            >
              <button
                type="button"
                :class="{ active: identityMode === 'default' }"
                :aria-pressed="identityMode === 'default'"
                :disabled="!!busy"
                @click="identityMode = 'default'"
              >
                无身份验证
              </button>
              <button
                type="button"
                :class="{ active: identityMode === 'file' }"
                :aria-pressed="identityMode === 'file'"
                :disabled="!!busy"
                @click="identityMode = 'file'"
              >
                身份文件
              </button>
            </div>
            <div v-if="identityMode === 'file'" class="ssh-field">
              <div class="ssh-key-heading">
                <label for="ssh-identity-file">身份文件路径</label>
                <button
                  type="button"
                  class="ssh-upload-button"
                  :disabled="!!busy"
                  @click="keyInput?.click()"
                >
                  <Icon
                    :name="busy === 'upload' ? 'LoaderCircle' : 'Upload'"
                    :size="14"
                    :class="{ spin: busy === 'upload' }"
                  />{{ busy === "upload" ? "上传中…" : "上传私钥" }}
                </button>
              </div>
              <input
                ref="keyInput"
                type="file"
                class="ssh-key-input"
                aria-label="SSH 私钥文件"
                :disabled="!!busy"
                @change="uploadKey"
              />
              <input
                id="ssh-identity-file"
                v-model="draft.identityFile"
                aria-label="SSH 身份文件路径"
                placeholder="上传私钥或填写服务端路径"
                :disabled="!!busy"
                required
                autocomplete="off"
                spellcheck="false"
              />
              <small
                v-if="uploadedKey?.identityFile === draft.identityFile"
                class="ssh-upload-result"
                role="status"
              >已上传 {{ uploadedKey?.name }}</small>
              <small>支持无口令的 OpenSSH / PEM 私钥，最大 64 KB。也可填写服务端已有文件路径。</small>
            </div>
            <p v-else class="ssh-form-note">使用已有的 SSH 配置和代理身份。</p>
            <details class="ssh-advanced">
              <summary>高级选项 <Icon name="ChevronDown" :size="14" /></summary>
              <div class="ssh-advanced-fields">
                <label class="ssh-field">
                  <span>Codex 路径 <small>（可选）</small></span>
                  <input
                    v-model="draft.codexPath"
                    aria-label="远端 Codex 路径"
                    placeholder="自动识别"
                    :disabled="!!busy"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <small>留空即可自动识别远端终端中的 codex。</small>
                </label>
                <label class="ssh-field">
                  <span>默认工作目录 <small>（可选）</small></span>
                  <input
                    v-model="draft.cwd"
                    aria-label="SSH 默认工作目录"
                    :disabled="!!busy"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </label>
              </div>
            </details>
            <div v-if="busy === 'test'" class="ssh-test-result" role="status">
              <Icon name="LoaderCircle" :size="16" class="spin" />
              <div>
                <strong>正在测试连接…</strong
                ><span>检查 SSH、Codex 与 app-server。</span>
              </div>
            </div>
            <div
              v-if="testResult"
              class="ssh-test-result success"
              role="status"
            >
              <Icon name="CheckCircle2" :size="16" />
              <div>
                <strong>连接成功</strong
                ><span
                  >SSH 与 Codex app-server 均可用{{
                    testedVersion ? ` · ${testedVersion}` : ""
                  }}</span
                >
              </div>
            </div>
            <div v-if="error" class="ssh-test-result failure" role="alert">
              <Icon name="AlertCircle" :size="16" />
              <div>
                <strong>{{ error }}</strong>
              </div>
            </div>
          </div>
          <footer class="ssh-dialog-footer">
            <button
              type="button"
              class="ssh-test-button"
              :disabled="!!busy || !draft.hostname.trim()"
              @click="submit('test')"
            >
              <Icon
                :name="busy === 'test' ? 'LoaderCircle' : 'Wifi'"
                :size="15"
                :class="{ spin: busy === 'test' }"
              />{{ busy === "test" ? "测试中…" : "测试连接" }}
            </button>
            <div class="ssh-save-actions">
              <button
                type="button"
                class="ssh-cancel"
                :disabled="busy === 'save' || busy === 'upload' || busy === 'trust'"
                @click="close"
              >
                取消
              </button>
              <button
                type="submit"
                class="ssh-save"
                :disabled="!!busy || !draft.hostname.trim()"
              >
                {{ busy === "save" ? "保存中…" : "保存" }}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.ssh-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.ssh-dialog {
  width: 520px;
  max-width: 100%;
  max-height: calc(100dvh - 48px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  outline: none;
  overflow: hidden;
}
.ssh-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 24px 16px;
}
.ssh-dialog-header h2 {
  font-size: 20px;
  line-height: 1.4;
  font-weight: 600;
  letter-spacing: -0.4px;
  margin: 0;
}
.ssh-close {
  width: 28px;
  height: 28px;
}
.ssh-dialog-form {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ssh-dialog-fields {
  padding: 0 24px 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 17px;
}
.ssh-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
.ssh-field > span {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
.ssh-key-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  font-weight: 500;
}
.ssh-upload-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  font-size: 12px;
  white-space: nowrap;
}
.ssh-field .ssh-key-input {
  display: none;
}
.ssh-field .ssh-upload-result {
  overflow-wrap: anywhere;
}
.ssh-field small {
  font-size: 11px;
  font-weight: 400;
  color: var(--muted);
  line-height: 1.6;
}
.ssh-field > span > small {
  font-size: 12px;
}
.ssh-field input {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  padding: 10px 11px;
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  outline: none;
  transition:
    border-color 120ms,
    box-shadow 120ms;
}
.ssh-field input::placeholder {
  color: var(--muted);
  opacity: 0.7;
}
.ssh-field input:focus {
  border-color: var(--muted);
  box-shadow: 0 0 0 2px var(--hover);
}
.ssh-field input:disabled {
  opacity: 0.6;
}
.ssh-fingerprint-button,
.ssh-trust-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  padding: 8px 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  font-size: 12px;
}
.ssh-fingerprint-button {
  align-self: flex-start;
  margin-top: -7px;
  color: var(--muted);
}
.ssh-fingerprint-button:hover:not(:disabled) {
  color: var(--text);
  background: var(--hover);
}
.ssh-host-key {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  padding: 13px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--soft);
  color: var(--text);
  font-size: 12px;
  line-height: 1.6;
}
.ssh-host-key h3,
.ssh-host-key p {
  margin: 0;
  overflow-wrap: anywhere;
}
.ssh-host-key h3 {
  font-size: 13px;
  font-weight: 600;
}
.ssh-host-key p {
  color: var(--muted);
}
.ssh-host-key .ssh-host-key-target {
  color: var(--text);
}
.ssh-host-key.changed {
  border-color: color-mix(in srgb, var(--warning) 45%, var(--border));
}
.ssh-host-key.changed h3 {
  color: var(--warning);
}
.ssh-host-key.trusted h3 {
  color: var(--green);
}
.ssh-fingerprint-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.ssh-fingerprint-list > strong {
  font-size: 11px;
  font-weight: 500;
}
.ssh-fingerprint-list > div {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ssh-fingerprint-list span {
  color: var(--muted);
  font-size: 11px;
}
.ssh-fingerprint-list code {
  font-size: 11px;
  overflow-wrap: anywhere;
  white-space: normal;
}
.ssh-fingerprint-list.previous {
  padding-bottom: 9px;
  border-bottom: 1px solid var(--border);
}
.ssh-replace-host-key {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}
.ssh-replace-host-key input {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  margin: 2px 0 0;
  accent-color: var(--text);
}
.ssh-trust-button {
  align-self: flex-start;
  color: var(--surface);
  background: var(--text);
}
.ssh-name-input {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: 11px;
  overflow: hidden;
}
.ssh-name-input > span {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  flex-shrink: 0;
  color: var(--warning);
  border-right: 1px solid var(--border);
}
.ssh-name-input input {
  border: 0;
  border-radius: 0;
}
.ssh-name-input:focus-within {
  border-color: var(--muted);
  box-shadow: 0 0 0 2px var(--hover);
}
.ssh-name-input input:focus {
  box-shadow: none;
}
.ssh-identity-selector {
  display: flex;
  gap: 4px;
  margin-top: 1px;
}
.ssh-identity-selector button {
  flex: 1;
  padding: 6px 10px;
  min-height: 32px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--muted);
}
.ssh-identity-selector button.active {
  background: var(--soft);
  color: var(--text);
  font-weight: 500;
}
.ssh-identity-selector button:hover {
  background: var(--hover);
}
.ssh-form-note {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
  margin: -8px 0 0;
}
.ssh-advanced {
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.ssh-advanced summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  list-style: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
  min-height: 26px;
}
.ssh-advanced summary::-webkit-details-marker {
  display: none;
}
.ssh-advanced[open] summary svg {
  transform: rotate(180deg);
}
.ssh-advanced-fields {
  display: flex;
  flex-direction: column;
  gap: 15px;
  padding: 12px 0 6px;
}
.ssh-test-result {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 11px 12px;
  border-radius: 9px;
  background: var(--soft);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.ssh-test-result > svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.ssh-test-result > div {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 3px;
}
.ssh-test-result strong {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.ssh-test-result span {
  font-size: 11px;
}
.ssh-test-result code {
  font-size: 10px;
  overflow-wrap: anywhere;
}
.ssh-test-result.success {
  color: var(--green);
  background: color-mix(in srgb, var(--green) 7%, var(--surface));
}
.ssh-test-result.failure {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 7%, var(--surface));
}
.ssh-dialog-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 19px 24px 22px;
}
.ssh-test-button {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  padding: 8px 0;
  min-height: 36px;
}
.ssh-test-button:hover:not(:disabled) {
  color: var(--text);
}
.ssh-save-actions {
  display: flex;
  align-items: center;
  gap: 9px;
}
.ssh-cancel {
  color: var(--muted);
  font-size: 13px;
  min-height: 36px;
  padding: 8px 10px;
  border-radius: 8px;
}
.ssh-cancel:hover:not(:disabled) {
  background: var(--hover);
}
.ssh-save {
  color: var(--surface);
  background: var(--text);
  font-size: 13px;
  font-weight: 500;
  min-height: 36px;
  padding: 8px 17px;
  border-radius: 9px;
}
.ssh-dialog button:disabled {
  opacity: 0.45;
  cursor: default;
}
@media (max-width: 760px) {
  .ssh-dialog-backdrop {
    padding: 12px;
  }
  .ssh-dialog {
    max-height: calc(100dvh - 24px);
    border-radius: 18px;
  }
  .ssh-dialog-header {
    padding: 19px 18px 15px;
  }
  .ssh-dialog-header h2 {
    font-size: 18px;
  }
  .ssh-close {
    width: 34px;
    height: 34px;
  }
  .ssh-dialog-fields {
    padding: 0 18px 4px;
    gap: 15px;
  }
  .ssh-field input {
    font-size: 16px;
    min-height: 43px;
  }
  .ssh-field > span {
    font-size: 12px;
  }
  .ssh-identity-selector button {
    font-size: 12px;
    min-height: 36px;
  }
  .ssh-dialog-footer {
    padding: 16px 18px 18px;
    gap: 8px;
  }
  .ssh-test-button {
    min-height: 42px;
  }
  .ssh-fingerprint-button,
  .ssh-trust-button {
    min-height: 42px;
  }
  .ssh-cancel,
  .ssh-save {
    min-height: 42px;
    font-size: 13px;
  }
}
</style>
