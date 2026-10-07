<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
const props = defineProps<{ api: any; state: any }>();
const emit = defineEmits<{ close: []; open: [hostId: string, threadId: string] }>();
const tasks = ref<any[]>([]), runs = ref<any[]>([]), selected = ref(''), editing = ref(false), busy = ref(false), error = ref('');
const form = reactive({ name: '', hostId: props.state.hostId, cwd: props.state.projectPath || '/workspace', prompt: '', model: props.state.model || '', effort: props.state.effort || 'medium', permission: 'read-only', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', kind: 'daily', minutes: 60, time: '09:00', days: [1,2,3,4,5], enabled: false, maxRetries: 1 });
let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined, disposed = false;
const hostProjects = computed(() => props.state.projects.filter((project: any) => (project.hostId || 'local') === form.hostId));
const visibleRuns = computed(() => runs.value.filter(run => !selected.value || run.automationId === selected.value));
const phases: Record<string, string> = { queued: '等待执行', connecting: '连接中', creating: '创建会话', dispatching: '提交中', running: '执行中', waiting: '等待输入或审批', completed: '已完成', failed: '失败', interrupted: '已中断', needs_review: '需要核对结果' };
const time = (value?: number) => value ? new Date(value).toLocaleString() : '—';
async function refresh() {
  clearTimeout(timer);
  if (disposed || !props.state.authenticated || controller) return;
  controller = new AbortController();
  try { const result = await props.api.http('/automations', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }, false); if (!disposed) { tasks.value = result.tasks; runs.value = result.runs; if (result.error) error.value = result.error; } }
  catch (cause: any) { if (!disposed && cause.name !== 'AbortError') error.value = cause.message; }
  finally { controller = undefined; if (!disposed) timer = setTimeout(() => void refresh(), 5000); }
}
async function action(operation: () => Promise<any>) {
  busy.value = true; error.value = '';
  try { await operation(); await refresh(); } catch (cause: any) { error.value = cause.message || '操作失败'; }
  finally { busy.value = false; }
}
function edit(task?: any) {
  selected.value = task?.id || ''; editing.value = true;
  if (task) Object.assign(form, task, { kind: task.cadence.kind, minutes: task.cadence.minutes || 60, time: `${String(task.cadence.hour ?? 9).padStart(2, '0')}:${String(task.cadence.minute ?? 0).padStart(2, '0')}`, days: task.cadence.days || [1,2,3,4,5] });
  else Object.assign(form, { name: '', prompt: '', hostId: props.state.hostId, cwd: props.state.projectPath || '/workspace', model: props.state.model || '', enabled: false, permission: 'read-only' });
}
function input() {
  const [hour, minute] = form.time.split(':').map(Number);
  return { name: form.name, hostId: form.hostId, cwd: form.cwd, prompt: form.prompt, model: form.model, effort: form.effort, permission: form.permission, timezone: form.timezone, enabled: form.enabled, maxRetries: Number(form.maxRetries),
    cadence: form.kind === 'interval' ? { kind: 'interval', minutes: Number(form.minutes) } : { kind: form.kind, hour, minute, ...(form.kind === 'weekly' ? { days: form.days } : {}) } };
}
async function save() { await action(async () => { const result = await props.api.http(`/automations${selected.value ? '/' + selected.value : ''}`, { method: selected.value ? 'PUT' : 'POST', body: JSON.stringify(input()) }, false); selected.value = result.id; editing.value = false; }); }
async function toggle(task: any) {
  const { id, createdAt, updatedAt, nextAt, ...spec } = task;
  await action(() => props.api.http(`/automations/${id}`, { method: 'PUT', body: JSON.stringify({ ...spec, enabled: !task.enabled }) }, false));
}
async function remove(task: any) { if (window.confirm(`删除自动化“${task.name}”？执行记录将保留。`)) await action(() => props.api.http(`/automations/${task.id}`, { method: 'DELETE' }, false)); }
async function runAction(run: any, operation: string) {
  if (operation === 'retry' && !window.confirm('重新执行会创建新会话，并可能再次修改文件。是否继续？')) return;
  await action(() => props.api.http(`/automation-runs/${run.id}/${operation}`, { method: 'POST', body: '{}' }, false));
}
watch(() => form.hostId, () => { if (!editing.value || selected.value) return; form.cwd = hostProjects.value[0]?.path || '/'; form.model = form.hostId === props.state.hostId ? props.state.model : ''; });
onMounted(() => void refresh());
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); controller?.abort(); });
</script>
<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="automations-panel" role="dialog" aria-modal="true" aria-label="自动化">
      <header><div><Icon name="Clock" :size="18" /><strong>自动化</strong></div><button class="icon-button" aria-label="关闭自动化" @click="emit('close')"><Icon name="X" :size="18" /></button></header>
      <p class="automation-note">由 Web 服务器按时执行，关闭网页后继续。每次创建独立会话；错过的时间合并为一次，运行中的任务不重复启动。</p>
      <p v-if="error" role="alert" class="panel-error">{{ error }}</p>
      <div class="automation-content">
        <aside>
          <button class="button button-small" :disabled="busy" @click="edit()"><Icon name="Plus" :size="14" />新建自动化</button>
          <p v-if="!tasks.length" class="automation-note">还没有自动化</p>
          <article v-for="task in tasks" :key="task.id" :class="{ selected: selected === task.id }">
            <button class="automation-task-name" @click="selected = task.id; editing = false">{{ task.name }}</button>
            <small>{{ task.enabled ? '已启用 · 下次 ' + time(task.nextAt) : '已暂停' }}</small>
            <small>{{ state.hosts.find((host: any) => host.id === task.hostId)?.name || task.hostId }} · {{ task.cwd }}</small>
            <div class="automation-actions"><button class="text-button" :disabled="busy" @click="edit(task)">编辑</button><button class="text-button" :disabled="busy" @click="toggle(task)">{{ task.enabled ? '暂停' : '启用' }}</button><button class="text-button" :disabled="busy" @click="action(() => api.http('/automations/' + task.id + '/run', { method: 'POST', body: '{}' }, false))">立即运行</button><button class="icon-button" aria-label="删除自动化" :disabled="busy" @click="remove(task)"><Icon name="Trash2" :size="13" /></button></div>
          </article>
          <button class="text-button" @click="selected = ''; editing = false">全部执行记录</button>
        </aside>
        <div class="automation-details">
          <form v-if="editing" @submit.prevent="save">
            <label>名称<input v-model="form.name" aria-label="自动化名称" required maxlength="100" /></label>
            <label>主机<select v-model="form.hostId" aria-label="自动化主机"><option v-for="host in state.hosts" :key="host.id" :value="host.id">{{ host.name }}</option></select></label>
            <label>工作目录<input v-model="form.cwd" list="automation-projects" aria-label="自动化工作目录" required /><datalist id="automation-projects"><option v-for="project in hostProjects" :key="project.path" :value="project.path">{{ project.name }}</option></datalist></label>
            <label class="wide">任务<textarea v-model="form.prompt" aria-label="自动化任务" rows="5" required maxlength="16000"></textarea></label>
            <label>模型<input v-model="form.model" aria-label="自动化模型" placeholder="留空使用原生默认" /></label>
            <label>推理强度<select v-model="form.effort" aria-label="自动化推理强度"><option v-for="effort in ['none','minimal','low','medium','high','xhigh','ultra']" :key="effort">{{ effort }}</option></select></label>
            <label>权限<select v-model="form.permission" aria-label="自动化权限"><option value="read-only">只读</option><option value="workspace-write">默认（工作区可写）</option><option value="danger-full-access">完全访问</option></select></label>
            <label>时区<input v-model="form.timezone" aria-label="自动化时区" required /></label>
            <label>频率<select v-model="form.kind" aria-label="自动化频率"><option value="daily">每天</option><option value="weekly">每周指定日期</option><option value="interval">间隔</option></select></label>
            <label v-if="form.kind === 'interval'">间隔（分钟）<input v-model.number="form.minutes" type="number" min="5" max="10080" aria-label="自动化间隔" /></label>
            <label v-else>执行时间<input v-model="form.time" type="time" aria-label="自动化执行时间" required /></label>
            <fieldset v-if="form.kind === 'weekly'" class="wide"><legend>执行日期</legend><label v-for="(day, index) in ['周日','周一','周二','周三','周四','周五','周六']" :key="index"><input v-model="form.days" type="checkbox" :value="index" />{{ day }}</label></fieldset>
            <label>执行前失败重试<select v-model.number="form.maxRetries" aria-label="自动化失败重试"><option v-for="count in [0,1,2,3]" :key="count" :value="count">{{ count }} 次</option></select></label>
            <label class="check"><input v-model="form.enabled" type="checkbox" aria-label="启用自动化" />启用定时执行</label>
            <p class="wide automation-note">无人值守任务使用所选权限和 never 审批策略，受主机托管规则约束。执行过程中需要补充输入时会保留会话并提醒；提交结果未知时停止重试，避免重复操作。</p>
            <div class="wide automation-actions"><button class="button button-small" :disabled="busy" type="submit">保存自动化</button><button class="button button-small button-secondary" type="button" @click="editing = false">取消</button></div>
          </form>
          <template v-else>
            <h3>执行记录</h3><p v-if="!visibleRuns.length" class="automation-note">没有执行记录</p>
            <details v-for="run in visibleRuns" :key="run.id" class="automation-run">
              <summary><strong>{{ run.spec.name }}</strong><span :class="'run-' + run.phase">{{ phases[run.phase] }}</span><time>{{ time(run.createdAt) }}</time></summary>
              <p v-if="run.error" class="panel-error">{{ run.error }}</p>
              <small>{{ run.spec.cwd }} · 尝试 {{ run.attempt }} 次<span v-if="run.retryAt"> · 下次重试 {{ time(run.retryAt) }}</span></small>
              <ol><li v-for="(log, index) in run.logs" :key="index"><time>{{ time(log.at) }}</time> {{ log.text }}</li></ol>
              <div class="automation-actions"><button v-if="run.threadId" class="button button-small button-secondary" @click="emit('open', run.spec.hostId, run.threadId)">打开执行会话</button><button v-if="run.phase === 'needs_review' && run.threadId" class="text-button" :disabled="busy" @click="runAction(run, 'reconcile')">核对原生结果</button><button v-if="['failed','interrupted'].includes(run.phase)" class="text-button" :disabled="busy" @click="runAction(run, 'retry')">重新执行</button><button v-if="['queued','running','waiting'].includes(run.phase)" class="text-button" :disabled="busy" @click="runAction(run, 'cancel')">停止执行</button></div>
            </details>
          </template>
        </div>
      </div>
    </section>
  </div>
</template>
<style scoped>
.automations-panel { width:min(940px,96vw); height:min(780px,94dvh); display:flex; flex-direction:column; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:14px; overflow:hidden; box-shadow:0 20px 80px #0004 }
header { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--border) }
header > div { display:flex; align-items:center; gap:8px }
.automation-note { color:var(--muted); font-size:12px; line-height:1.6; margin:10px 16px }
.automation-content { display:grid; grid-template-columns:270px minmax(0,1fr); flex:1; min-height:0 }
aside { overflow:auto; padding:12px; border-right:1px solid var(--border) }
aside article { padding:10px 8px; border-bottom:1px solid var(--border) }
aside article.selected { background:var(--surface) }
.automation-task-name { font-weight:600; text-align:left; display:block; color:var(--text) }
small { color:var(--muted); display:block; font-size:11px; overflow-wrap:anywhere; margin:6px 0 }
.automation-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:8px }
.automation-details { overflow:auto; padding:14px 18px; min-width:0 }
form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px }
form label { display:flex; flex-direction:column; gap:6px; font-size:12px }
form input, form textarea, form select { width:100%; min-width:0; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:8px; font:inherit; box-sizing:border-box }
.wide { grid-column:1 / -1 }
form .check, fieldset label { flex-direction:row; align-items:center }
form input[type=checkbox] { width:auto }
fieldset { display:flex; flex-wrap:wrap; gap:8px; border:1px solid var(--border) }
.automation-run { padding:12px 0; border-bottom:1px solid var(--border); font-size:12px }
.automation-run summary { display:flex; flex-wrap:wrap; align-items:center; gap:8px; cursor:pointer }
.automation-run time { color:var(--muted); font-size:11px }
.automation-run summary time { margin-left:auto }
.automation-run li { margin:6px 0; overflow-wrap:anywhere }
.run-completed { color:var(--green) } .run-failed, .run-needs_review { color:var(--red) }
@media(max-width:760px) { .automation-content { grid-template-columns:1fr; overflow:auto; display:block } aside { border-right:0; max-height:220px; border-bottom:1px solid var(--border) } .automation-details { overflow:visible } form { grid-template-columns:1fr } }
</style>
