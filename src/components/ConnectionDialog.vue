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
const busy = ref<"" | "test" | "save">("");
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
let previousFocus: HTMLElement | null = null;
let disposed = false;

watch(
  [draft, identityMode],
  () => {
    error.value = "";
    testResult.value = null;
  },
  { deep: true },
);

function payload() {
  const hostname = draft.hostname.trim();
  if (!hostname) throw new Error("请输入 SSH 主机名");
  const port = String(draft.port).trim() ? Number(draft.port) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error("请输入 1–65535 之间的 SSH 端口");
  const identityFile =
    identityMode.value === "file" ? draft.identityFile.trim() : "";
  if (identityMode.value === "file" && !identityFile)
    throw new Error("请输入身份文件路径，或选择无身份验证");
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
      const result = await props.api.testHost(fields);
      if (disposed) return;
      if (result?.ok === false || result?.success === false)
        throw new Error(result.error || result.message || "连接测试失败");
      testResult.value = result || { ok: true };
    } else {
      if (props.host?.id) await props.api.updateHost(props.host.id, fields);
      else await props.api.addHost(fields);
      emit("saved");
    }
  } catch (cause: any) {
    if (!disposed)
      error.value =
        cause?.message || (kind === "test" ? "连接测试失败" : "保存连接失败");
  } finally {
    if (!disposed) busy.value = "";
  }
}
function close() {
  if (busy.value !== "save") emit("close");
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
            :disabled="busy === 'save'"
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
            <label v-if="identityMode === 'file'" class="ssh-field">
              <span>身份文件路径</span>
              <input
                v-model="draft.identityFile"
                aria-label="SSH 身份文件路径"
                :disabled="!!busy"
                required
                autocomplete="off"
                spellcheck="false"
              />
              <small>文件须已存在于运行 Web 服务的主机。</small>
            </label>
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
                :disabled="busy === 'save'"
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
  background: #15171332;
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
  box-shadow:
    0 16px 60px #0002,
    0 2px 6px #0001;
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
  color: #bca15f;
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
  .ssh-cancel,
  .ssh-save {
    min-height: 42px;
    font-size: 13px;
  }
}
</style>
