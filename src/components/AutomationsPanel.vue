<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
const props = defineProps<{ api: any; state: any }>();
const emit = defineEmits<{ close: []; open: [hostId: string, threadId: string] }>();
const tasks = ref<any[]>([]), runs = ref<any[]>([]), selected = ref(''), editing = ref(false), busy = ref(false), error = ref('');
const serviceError = ref('');
const form = reactive({ name: '', hostId: props.state.hostId, cwd: props.state.projectPath || '/workspace', prompt: '', model: props.state.model || '', effort: props.state.effort || 'medium', permission: 'read-only', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', kind: 'daily', minutes: 60, time: '09:00', days: [1,2,3,4,5], enabled: false, maxRetries: 1 });
let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined, disposed = false;
const hostProjects = computed(() => props.state.projects.filter((project: any) => (project.hostId || 'local') === form.hostId));
const visibleRuns = computed(() => runs.value.filter(run => !selected.value || run.automationId === selected.value));
const selectedTask = computed(() => tasks.value.find(task => task.id === selected.value));
function schedule(task: any) {
  if (task.cadence.kind === 'interval') return `每 ${task.cadence.minutes} 分钟`;
  const at = `${String(task.cadence.hour).padStart(2, '0')}:${String(task.cadence.minute).padStart(2, '0')}`;
  return `${task.cadence.kind === 'weekly' ? '每周' : '每天'} ${at}`;
}
const phases: Record<string, string> = { queued: '等待执行', connecting: '连接中', creating: '创建会话', dispatching: '提交中', running: '执行中', waiting: '等待输入或审批', completed: '已完成', failed: '失败', interrupted: '已中断', needs_review: '需要核对结果' };
const time = (value?: number) => value ? new Date(value).toLocaleString() : '—';
async function refresh() {
  clearTimeout(timer);
  if (disposed || !props.state.authenticated || controller) return;
  controller = new AbortController();
  try { const result = await props.api.http('/automations', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }, false); if (!disposed) { tasks.value = result.tasks; runs.value = result.runs; serviceError.value = result.error || ''; } }
  catch (cause: any) { if (!disposed && cause.name !== 'AbortError') serviceError.value = cause.message; }
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
  <div class="modal-backdrop automations-backdrop" @click.self="emit('close')">
    <section class="automations-panel" :class="{ 'is-empty': !tasks.length && !runs.length && !editing, editing }" role="dialog" aria-modal="true" aria-label="自动化">
      <header class="automation-header"><div class="automation-title"><span class="automation-title-icon"><Icon name="Clock" :size="20" /></span><div><h2>自动化</h2><p>安排重复任务，查看每次执行结果</p></div></div><button class="icon-button" aria-label="关闭自动化" @click="emit('close')"><Icon name="X" :size="18" /></button></header>
      <div class="automation-service-note"><Icon name="CheckCircle2" :size="14" /><span>关闭网页后继续执行，每次运行创建独立会话。</span></div>
      <p v-if="error || serviceError" role="alert" class="panel-error">{{ error || serviceError }}</p>
      <div class="automation-content">
        <aside class="automation-sidebar">
          <button class="button button-primary automation-create" :disabled="busy" @click="edit()"><Icon name="Plus" :size="15" />新建自动化</button>
          <div class="automation-sidebar-heading"><span>任务</span><span>{{ tasks.length }}</span></div>
          <p v-if="!tasks.length" class="automation-sidebar-empty">还没有自动化<br /><span>创建任务后会显示在这里</span></p>
          <article v-for="task in tasks" :key="task.id" :class="{ selected: selected === task.id }">
            <button class="automation-task-name" @click="selected = task.id; editing = false">{{ task.name }}</button>
            <div class="automation-task-meta"><span class="automation-status" :class="{ enabled: task.enabled }">{{ task.enabled ? '已启用' : '已暂停' }}</span><span>{{ schedule(task) }}</span></div>
            <small class="automation-task-path" :title="task.cwd">{{ state.hosts.find((host: any) => host.id === task.hostId)?.name || task.hostId }} · {{ task.cwd }}</small>
            <small v-if="task.enabled && task.nextAt">下次 {{ time(task.nextAt) }}</small>
            <div class="automation-actions"><button class="text-button" :disabled="busy" @click="edit(task)">编辑</button><button class="text-button" :disabled="busy" @click="toggle(task)">{{ task.enabled ? '暂停' : '启用' }}</button><button class="text-button" :disabled="busy" @click="action(() => api.http('/automations/' + task.id + '/run', { method: 'POST', body: '{}' }, false))">立即运行</button><button class="icon-button" aria-label="删除自动化" :disabled="busy" @click="remove(task)"><Icon name="Trash2" :size="13" /></button></div>
          </article>
          <button class="automation-history-button" :class="{ active: !selected && !editing }" @click="selected = ''; editing = false"><Icon name="ListChecks" :size="15" />全部执行记录<span>{{ runs.length }}</span></button>
        </aside>
        <div class="automation-details">
          <form v-if="editing" @submit.prevent="save">
            <div class="wide automation-details-heading"><div><h3>{{ selected ? '编辑自动化' : '新建自动化' }}</h3><p>设置任务内容与执行计划</p></div></div>
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
            <p class="wide automation-form-note">需要补充输入时会保留会话并提醒你。无法确认是否已执行时，会暂停并等待核对。</p>
            <div class="wide automation-actions automation-form-actions"><button class="button button-secondary" type="button" :disabled="busy" @click="editing = false">取消</button><button class="button button-primary" :disabled="busy" type="submit"><Icon v-if="busy" name="LoaderCircle" :size="14" class="spin" />保存自动化</button></div>
          </form>
          <template v-else>
            <div class="automation-details-heading"><div><h3>{{ selectedTask?.name || '执行记录' }}</h3><p>{{ selectedTask ? '查看该任务的执行记录与结果' : '查看全部任务的执行记录与结果' }}</p></div><span class="automation-count">{{ visibleRuns.length }} 条记录</span></div>
            <div v-if="!visibleRuns.length" class="automation-empty-state"><span class="automation-empty-icon"><Icon name="Clock" :size="26" /></span><h4>没有执行记录</h4><p>{{ tasks.length ? '任务执行后，结果与日志会显示在这里。' : '新建自动化，让 Codex 按计划完成任务。' }}</p></div>
            <details v-for="run in visibleRuns" :key="run.id" class="automation-run">
              <summary><Icon name="ChevronRight" :size="14" /><strong>{{ run.spec.name }}</strong><span class="automation-status" :class="'run-' + run.phase">{{ phases[run.phase] }}</span><time>{{ time(run.createdAt) }}</time></summary>
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
.automations-backdrop { padding:24px; }
.automations-panel { width:min(960px,100%); height:min(680px,calc(100dvh - 48px)); display:flex; flex-direction:column; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:16px; overflow:hidden; box-shadow:var(--shadow); font-size:13px; }
.automations-panel.is-empty { height:min(440px,calc(100dvh - 48px)); }
.automation-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:20px 24px; border-bottom:1px solid var(--border); flex-shrink:0; }
.automation-title { display:flex; align-items:center; gap:12px; min-width:0; }
.automation-title-icon, .automation-empty-icon { display:grid; place-items:center; flex-shrink:0; background:var(--soft); border-radius:12px; color:var(--muted); }
.automation-title-icon { width:40px; height:40px; }
.automation-title h2 { margin:0; font-size:18px; font-weight:600; line-height:1.4; }
.automation-title p { margin:4px 0 0; font-size:12px; color:var(--muted); line-height:1.5; }
.automation-service-note { display:flex; align-items:center; gap:8px; padding:12px 24px; color:var(--muted); font-size:12px; border-bottom:1px solid var(--border); flex-shrink:0; }
.automation-service-note svg { flex-shrink:0; }
.automation-content { display:grid; grid-template-columns:250px minmax(0,1fr); flex:1; min-height:0; }
.automation-sidebar { overflow:auto; padding:16px 12px; border-right:1px solid var(--border); background:var(--bg); }
.automation-create { width:100%; justify-content:center; font-size:13px; min-height:36px; padding:8px 12px; }
.automation-sidebar-heading { display:flex; justify-content:space-between; margin:20px 10px 10px; font-size:11px; color:var(--muted); }
.automation-sidebar-empty { margin:16px 10px 24px; color:var(--muted); line-height:1.7; font-size:12px; }
.automation-sidebar-empty span { font-size:11px; }
.automation-sidebar article { margin:6px 0; padding:12px 10px; border:1px solid transparent; border-radius:10px; }
.automation-sidebar article:hover { background:var(--hover); }
.automation-sidebar article.selected { background:var(--selected); border-color:var(--border); }
.automation-task-name { font:inherit; font-weight:600; width:100%; text-align:left; display:block; color:var(--text); background:none; border:0; padding:0; overflow-wrap:anywhere; cursor:pointer; }
.automation-task-meta { display:flex; align-items:center; gap:8px; margin:8px 0; font-size:11px; color:var(--muted); }
.automation-status { display:inline-flex; align-items:center; border-radius:5px; padding:2px 6px; font-size:11px; line-height:1.5; background:var(--soft); color:var(--muted); }
.automation-status.enabled, .run-completed { color:var(--green); background:color-mix(in srgb,var(--green) 9%,var(--surface)); }
.automation-history-button { width:100%; display:flex; align-items:center; gap:8px; padding:10px; margin-top:12px; border:0; border-radius:8px; background:transparent; color:var(--muted); font:inherit; text-align:left; cursor:pointer; }
.automation-history-button.active, .automation-history-button:hover { color:var(--text); background:var(--selected); }
.automation-history-button span { margin-left:auto; font-size:11px; }
small { color:var(--muted); display:block; font-size:11px; overflow-wrap:anywhere; margin:6px 0; line-height:1.5; }
.automation-task-path { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.automation-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:12px; }
.automation-actions .text-button { font-size:11px; padding:4px 0; min-height:28px; }
.automation-actions .icon-button { width:28px; height:28px; margin-left:auto; }
.automation-details { overflow:auto; padding:20px 24px; min-width:0; display:flex; flex-direction:column; }
.automation-details-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:20px; }
.automation-details-heading h3 { margin:0; font-size:16px; font-weight:600; line-height:1.5; overflow-wrap:anywhere; }
.automation-details-heading p { margin:4px 0 0; font-size:12px; color:var(--muted); line-height:1.6; }
.automation-count { flex-shrink:0; color:var(--muted); font-size:11px; }
.automation-empty-state { display:flex; flex-direction:column; align-items:center; justify-content:center; flex:1; text-align:center; min-height:160px; padding:24px; }
.automation-empty-icon { width:52px; height:52px; margin-bottom:16px; }
.automation-empty-state h4 { margin:0; font-size:14px; font-weight:500; }
.automation-empty-state p { margin:8px 0 0; font-size:12px; color:var(--muted); line-height:1.7; }
form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
form .automation-details-heading { margin-bottom:0; }
form label { display:flex; flex-direction:column; gap:7px; font-size:12px; line-height:1.5; }
form input, form textarea, form select { width:100%; min-width:0; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:9px 10px; font:inherit; box-sizing:border-box; min-height:38px; }
form textarea { resize:vertical; min-height:110px; }
form input:focus, form textarea:focus, form select:focus { outline:2px solid var(--green); outline-offset:1px; }
.wide { grid-column:1 / -1; }
form .check, fieldset label { flex-direction:row; align-items:center; }
form input[type=checkbox] { width:16px; height:16px; min-height:0; flex-shrink:0; margin:0; }
fieldset { display:flex; flex-wrap:wrap; gap:14px; border:1px solid var(--border); border-radius:8px; padding:12px; margin:0; }
fieldset legend { font-size:12px; padding:0 4px; }
.automation-form-note { color:var(--muted); font-size:12px; line-height:1.7; margin:0; }
.automation-form-actions { justify-content:flex-end; padding-top:16px; margin-top:0; border-top:1px solid var(--border); }
.automation-form-actions .button { font-size:13px; min-height:36px; padding:8px 14px; }
.automation-run { padding:12px; margin-bottom:10px; border:1px solid var(--border); border-radius:10px; font-size:12px; }
.automation-run summary { display:flex; flex-wrap:wrap; align-items:center; gap:8px; cursor:pointer; list-style:none; min-height:24px; }
.automation-run summary::-webkit-details-marker { display:none; }
.automation-run[open] > summary > svg { transform:rotate(90deg); }
.automation-run summary strong { overflow-wrap:anywhere; }
.automation-run time { color:var(--muted); font-size:11px; }
.automation-run summary time { margin-left:auto; }
.automation-run ol { padding-left:20px; }
.automation-run li { margin:8px 0; overflow-wrap:anywhere; line-height:1.6; }
.run-failed, .run-needs_review { color:var(--red); background:color-mix(in srgb,var(--red) 8%,var(--surface)); }
.panel-error { margin:10px 16px; padding:10px 12px; border-radius:8px; font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
@media(max-width:760px) {
  .automations-backdrop { padding:12px; align-items:center; }
  .automations-panel { height:calc(100dvh - 24px); max-height:760px; border-radius:14px; }
  .automations-panel.is-empty { height:min(500px,calc(100dvh - 24px)); }
  .automation-header { padding:16px; }
  .automation-service-note { padding:10px 16px; }
  .automation-content { display:flex; flex-direction:column; }
  .automation-sidebar { border-right:0; border-bottom:1px solid var(--border); max-height:190px; flex-shrink:0; padding:12px 16px; }
  .editing .automation-sidebar { display:none; }
  .is-empty .automation-sidebar-heading, .is-empty .automation-sidebar-empty { display:none; }
  .automation-create { min-height:40px; }
  .automation-sidebar-heading { margin:12px 0 6px; }
  .automation-sidebar-empty { margin:8px 0; }
  .automation-sidebar-empty br, .automation-sidebar-empty span { display:none; }
  .automation-history-button { min-height:40px; margin-top:8px; }
  .automation-details { flex:1; min-height:0; padding:16px; }
  .automation-details-heading { align-items:flex-start; margin-bottom:16px; }
  form { grid-template-columns:1fr; gap:14px; }
  form input, form textarea, form select { font-size:16px; min-height:42px; }
  .automation-form-actions { position:sticky; bottom:-16px; background:var(--surface); padding-bottom:16px; }
  .automation-form-actions .button { min-height:42px; }
  .automation-run summary time { width:100%; margin-left:22px; }
}
</style>
