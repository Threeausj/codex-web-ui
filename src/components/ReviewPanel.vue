<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { reviewTarget, reviewFindings, type ReviewScope } from '../lib/review';
const props = defineProps<{ api: any; state: any }>();
const emit = defineEmits<{ close: []; file: [location: { path: string; line?: number }] }>();
const scope = ref<ReviewScope>('uncommittedChanges');
const value = ref('');
const branches = ref<string[]>([]);
const commits = ref<{ sha: string; title: string }[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
let generation = 0;
type Submission = { hostId: string; cwd: string; threadId: string; allowCreatedThread: boolean; authenticationGeneration?: number; engineId?: string | null };
let submission: Submission | null = null;
const context = computed(() => `${props.state.hostId}\0${props.state.projectPath}\0${props.state.activeThread?.id || ''}`);
function submissionCurrent(operation: Submission) {
  const identity = props.api.runtimeIdentity?.() || {};
  if (submission !== operation || !props.state.authenticated || operation.hostId !== props.state.hostId || operation.cwd !== props.state.projectPath ||
      operation.authenticationGeneration !== identity.authenticationGeneration || operation.engineId !== identity.engineId) return false;
  const threadId = props.state.activeThread?.id || '';
  // The initial thread/start is part of this submit, so its welcome -> thread
  // transition must keep the lock and subsequent errors attached to this form.
  if (operation.allowCreatedThread && threadId) { operation.threadId = threadId; operation.allowCreatedThread = false; }
  return operation.threadId === threadId;
}
const blocked = computed(() => busy.value || props.state.busy || props.state.modeBusy || props.state.goal?.status === 'active' || !props.state.connected || !props.state.online || props.state.selectingThread || props.state.runtimePaused || props.state.threadReleased || !!props.state.threadConflict);
const findings = computed(() => props.state.items.filter((item: any) => item.type === 'exitedReviewMode').slice(-1).flatMap((item: any) => reviewFindings(item.review)));
const canSubmit = computed(() => { try { reviewTarget(scope.value, value.value); return !blocked.value; } catch { return false; } });
async function loadOptions() {
  const request = ++generation;
  const captured = context.value;
  branches.value = []; commits.value = []; loading.value = true;
  if (!busy.value) error.value = '';
  try {
    const result = await props.api.requestHttp(`/git/review-options?${new URLSearchParams({ hostId: props.state.hostId, cwd: props.state.projectPath, permission: props.state.permission })}`, {}, false);
    if (request !== generation || captured !== context.value) return;
    branches.value = result.branches; commits.value = result.commits;
  } catch (cause: any) { if (!busy.value && request === generation && captured === context.value) error.value = cause.message || '无法读取 Git 审阅范围；仍可填写自定义要求。'; }
  finally { if (request === generation) loading.value = false; }
}
async function submit() {
  if (!canSubmit.value) return;
  const operation: Submission = { hostId: props.state.hostId, cwd: props.state.projectPath, threadId: props.state.activeThread?.id || '',
    allowCreatedThread: !props.state.activeThread, ...props.api.runtimeIdentity?.() };
  submission = operation;
  busy.value = true; error.value = '';
  try {
    const commit = commits.value.find(entry => entry.sha === value.value);
    await props.api.startReview(reviewTarget(scope.value, value.value, commit?.title));
    if (submissionCurrent(operation)) emit('close');
  } catch (cause: any) { if (submissionCurrent(operation)) error.value = cause.message || '无法启动代码审阅'; }
  finally { if (submission === operation) { submission = null; busy.value = false; } }
}
watch(scope, () => { value.value = ''; error.value = ''; });
watch(() => [context.value, props.state.authenticated], () => {
  ++generation;
  if (submission && !submissionCurrent(submission)) { submission = null; busy.value = false; }
  void loadOptions();
});
onMounted(loadOptions);
onBeforeUnmount(() => { ++generation; submission = null; });
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="small-modal review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <header class="modal-header"><h2 id="review-title"><Icon name="Eye" :size="20" />代码审阅</h2><button class="icon-button" aria-label="关闭代码审阅" @click="emit('close')"><Icon name="X" :size="18" /></button></header>
      <form @submit.prevent="submit">
        <label>审阅范围<select v-model="scope" class="text-input" aria-label="审阅范围" :disabled="busy">
          <option value="uncommittedChanges">未提交修改</option><option value="baseBranch">与基准分支比较</option><option value="commit">指定 commit</option><option value="custom">自定义要求</option>
        </select></label>
        <label v-if="scope === 'baseBranch'">基准分支<select v-model="value" class="text-input" aria-label="审阅基准分支" :disabled="busy || loading"><option value="">选择基准分支</option><option v-for="branch in branches" :key="branch" :value="branch">{{ branch }}</option></select></label>
        <label v-else-if="scope === 'commit'">Commit SHA<input v-model="value" class="text-input" aria-label="审阅 commit SHA" :disabled="busy" placeholder="完整或缩写 SHA" list="review-commits" /><datalist id="review-commits"><option v-for="entry in commits" :key="entry.sha" :value="entry.sha">{{ entry.title }}</option></datalist></label>
        <label v-else-if="scope === 'custom'">审阅要求<textarea v-model="value" class="text-input" aria-label="自定义审阅要求" :disabled="busy" maxlength="8000" rows="4" placeholder="例如：只审阅登录恢复流程，检查并发请求与会话撤销。" /></label>
        <p class="review-note">在当前对话中启动原生 Codex 审阅，使用该对话的模型与权限。运行中的任务结束后可开始。</p>
        <p v-if="error" class="review-error" role="alert">{{ error }}</p>
        <div class="form-actions"><button type="button" class="button button-secondary" @click="emit('close')">取消</button><button class="button" :disabled="!canSubmit">{{ busy ? '正在启动…' : '开始审阅' }}</button></div>
      </form>
      <section v-if="findings.length" class="review-findings" aria-label="最近审阅发现">
        <h3>最近审阅发现 · {{ findings.length }}</h3>
        <article v-for="(finding, index) in findings" :key="index">
          <strong>{{ finding.title }}</strong><p>{{ finding.body }}</p>
          <button class="review-location" :title="finding.file" @click="emit('file', { path: finding.file, line: finding.start })">{{ finding.file }}{{ finding.start ? ':' + finding.start : '' }}</button>
        </article>
      </section>
    </section>
  </div>
</template>

<style scoped>
.review-modal { width: min(540px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); overflow: auto; color: var(--text); }
.review-modal h2 { display:flex; align-items:center; gap:8px; }.review-modal form,.review-modal label { display:flex; flex-direction:column; gap:10px; }.review-modal form { gap:18px; }
.review-modal select,.review-modal textarea,.review-modal input { width:100%; box-sizing:border-box; }.review-note { color:var(--text-muted); font-size:12px; line-height:1.6; margin:0; }.review-error { color:var(--red); font-size:13px; }.review-findings { margin-top:20px; border-top:1px solid var(--border); padding-top:14px; }.review-findings h3 { font-size:13px; }.review-findings article { padding:12px 0; border-bottom:1px solid var(--border); font-size:13px; }.review-findings p { white-space:pre-wrap; line-height:1.6; }.review-location { color:var(--accent); font-size:12px; overflow-wrap:anywhere; border:0; background:transparent; padding:0; text-align:left; cursor:pointer; }
</style>
