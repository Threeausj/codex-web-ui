<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{ api: any; state: any }>();
const expanded = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const confirmation = ref('');
const saving = ref(false);
const error = ref('');
const success = ref('');
const invalidField = ref<'current' | 'new' | 'confirmation' | ''>('');
const online = computed(() => props.state.online !== false);
let mounted = true;

function clearSecrets() {
  currentPassword.value = '';
  newPassword.value = '';
  confirmation.value = '';
}
function closeForm() {
  clearSecrets();
  error.value = '';
  invalidField.value = '';
  expanded.value = false;
}
function openForm() {
  clearSecrets();
  error.value = '';
  success.value = '';
  invalidField.value = '';
  expanded.value = true;
}
function validate() {
  if (!online.value) return '连接网络后再修改访问密码。';
  if (!currentPassword.value) {
    invalidField.value = 'current';
    return '请输入当前访问密码。';
  }
  if (newPassword.value.length < 12 || newPassword.value.length > 1024) {
    invalidField.value = 'new';
    return '新访问密码需要 12 至 1024 个字符。';
  }
  if (newPassword.value === currentPassword.value) {
    invalidField.value = 'new';
    return '新访问密码需要与当前密码不同。';
  }
  if (newPassword.value !== confirmation.value) {
    invalidField.value = 'confirmation';
    return '两次输入的新访问密码不一致。';
  }
  return '';
}
function failureMessage(status: number | undefined) {
  // Never render a server error body: it can contain request details or credentials.
  if (status === 403) return '当前访问密码不正确，请重新输入。';
  if (status === 400) return '新访问密码不符合要求，请使用 12 至 1024 个字符并与当前密码不同。';
  if (status === 401) return '网页登录已过期，请重新登录后再修改。';
  if (status === 429) return '尝试次数过多，请稍后重试。';
  if (status === 503) return '访问密码暂时无法保存，请稍后重试。';
  return online.value ? '未能修改访问密码，请稍后重试。' : '连接网络后再修改访问密码。';
}
async function savePassword() {
  if (saving.value) return;
  error.value = '';
  success.value = '';
  invalidField.value = '';
  const problem = validate();
  if (problem) { error.value = problem; return; }
  saving.value = true;
  try {
    await props.api.requestHttp('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: currentPassword.value, newPassword: newPassword.value }),
    }, false);
    if (!mounted) return;
    closeForm();
    success.value = '访问密码已更新，其他设备需要重新登录。';
  } catch (cause: any) {
    if (!mounted) return;
    currentPassword.value = '';
    invalidField.value = cause.status === 403 ? 'current' : '';
    error.value = failureMessage(cause.status);
  } finally {
    if (mounted) saving.value = false;
  }
}
onBeforeUnmount(() => {
  mounted = false;
  clearSecrets();
});
</script>

<template>
  <section class="password-settings" aria-label="网页访问密码">
    <div class="password-heading">
      <span>访问密码</span>
      <button
        v-if="!expanded"
        class="button button-small button-secondary"
        type="button"
        :disabled="!online"
        :aria-expanded="expanded"
        aria-controls="password-change-form"
        @click="openForm"
      ><Icon name="KeyRound" :size="14" />修改访问密码</button>
    </div>
    <p v-if="!online" class="password-note" role="status">连接网络后可修改访问密码。</p>
    <form v-if="expanded" id="password-change-form" class="password-form" novalidate @submit.prevent="savePassword">
      <label class="form-label">当前访问密码
        <input
          v-model="currentPassword"
          class="text-input"
          aria-label="当前访问密码"
          type="password"
          autocomplete="current-password"
          maxlength="1024"
          :disabled="saving || !online"
          :aria-invalid="invalidField === 'current'"
          :aria-describedby="error ? 'password-change-error' : undefined"
          required
        />
      </label>
      <label class="form-label">新访问密码
        <input
          v-model="newPassword"
          class="text-input"
          aria-label="新访问密码"
          type="password"
          autocomplete="new-password"
          minlength="12"
          maxlength="1024"
          :disabled="saving || !online"
          :aria-invalid="invalidField === 'new'"
          :aria-describedby="error ? 'password-change-error password-change-help' : 'password-change-help'"
          required
        />
      </label>
      <label class="form-label">确认新访问密码
        <input
          v-model="confirmation"
          class="text-input"
          aria-label="确认新访问密码"
          type="password"
          autocomplete="new-password"
          minlength="12"
          maxlength="1024"
          :disabled="saving || !online"
          :aria-invalid="invalidField === 'confirmation'"
          :aria-describedby="error ? 'password-change-error' : undefined"
          required
        />
      </label>
      <p id="password-change-help" class="password-note">使用 12 至 1024 个字符。此设备保持登录，其他设备需要重新登录。</p>
      <p v-if="error" id="password-change-error" class="password-feedback error" role="alert"><Icon name="AlertCircle" :size="15" />{{ error }}</p>
      <div class="password-actions">
        <button type="button" class="button button-secondary" :disabled="saving" @click="closeForm">取消</button>
        <button type="submit" class="button" :disabled="saving || !online"><Icon v-if="saving" name="LoaderCircle" :size="15" class="spin" />{{ saving ? '保存中…' : '保存访问密码' }}</button>
      </div>
    </form>
    <p v-if="success" class="password-feedback" role="status"><Icon name="CheckCircle2" :size="15" />{{ success }}</p>
  </section>
</template>

<style scoped>
.password-settings { min-width:0;padding:16px 0; }
.password-heading { display:flex;align-items:center;justify-content:space-between;gap:12px; }
.password-heading > span { font-size:12px;color:var(--muted); }
.password-form { display:flex;flex-direction:column;gap:15px;margin-top:18px; }
.password-form .form-label { min-width:0;margin:0; }
.password-form .text-input { width:100%;min-width:0; }
.password-note { margin:0;font-size:11px;line-height:1.7;color:var(--muted); }
.password-heading + .password-note { margin-top:12px; }
.password-actions { display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap; }
.password-feedback { display:flex;align-items:flex-start;gap:7px;margin:14px 0 0;font-size:12px;line-height:1.7;color:var(--muted); }
.password-feedback > svg { flex-shrink:0;margin-top:3px; }
.password-feedback.error { margin-top:0;color:var(--danger, #b94d45); }
@media(max-width:760px) {
  .password-heading > span, .password-note { font-size:12px; }
  .password-actions .button, .password-heading .button { min-height:42px;font-size:13px; }
  .password-feedback { font-size:13px; }
}
</style>
