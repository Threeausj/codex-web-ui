<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import Icon from './Icon.vue';
import { threadLabel } from '../lib/navigation';

const props = defineProps<{ thread: any; hostId: string; state: any; api: any }>();
const emit = defineEmits<{ close: []; open: [selection: { id: string; hostId: string }] }>();
const dialog = ref<HTMLDialogElement>();
const titleId = `attached-threads-${useId()}`;
const entries = ref<any[]>([]);
const cursor = ref<string | null>(null);
const archived = ref(false);
const loading = ref(false);
const pending = ref(false);
const uncertain = ref(false);
const error = ref('');
const action = ref<{ id: string; mode: 'rename' | 'delete' } | null>(null);
const name = ref('');
const authentication = props.api.runtimeIdentity().authenticationGeneration;
let generation = 0, disposed = false;
const current = () => !disposed && props.state.authenticated &&
  props.api.runtimeIdentity().authenticationGeneration === authentication &&
  props.state.hostId === props.hostId && props.state.activeThread?.id === props.thread.id;
function close() { emit('close'); }
async function load(more = false) {
  const operation = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const page = await props.api.queryAttachedThreads(props.thread.id, props.hostId, more ? cursor.value : null, archived.value);
    if (!current() || operation !== generation) return;
    const previous = more ? entries.value : [];
    entries.value = [...new Map([...previous, ...page.data].map((entry: any) => [entry.id, entry])).values()];
    if (page.nextCursor && page.nextCursor === cursor.value && more) throw new Error('附属分支分页未能继续，请刷新');
    cursor.value = page.nextCursor;
    uncertain.value = false;
  } catch (cause: any) { if (current() && operation === generation) error.value = cause.message || '无法读取附属分支'; }
  finally { if (operation === generation && !disposed) loading.value = false; }
}
async function create() {
  if (pending.value || loading.value || uncertain.value || !current()) return;
  pending.value = true;
  error.value = '';
  try {
    await props.api.forkThread(props.thread.id, props.hostId, undefined, { attachToSource: true });
    if (!current()) return;
    if (archived.value) archived.value = false;
    else await load();
  } catch (cause: any) {
    if (current()) {
      uncertain.value = cause.uncertain === true;
      error.value = uncertain.value ? '创建结果尚未确认，请先刷新附属分支列表核对，勿重复创建' : cause.message || '无法创建附属分支，请刷新列表后确认';
    }
  }
  finally { if (!disposed) pending.value = false; }
}
function begin(entry: any, mode: 'rename' | 'delete') {
  if (pending.value) return;
  error.value = '';
  action.value = { id: entry.id, mode };
  name.value = threadLabel(entry);
}
async function submit() {
  if (!action.value || pending.value || !current()) return;
  const selected = action.value;
  const entry = entries.value.find(entry => entry.id === selected.id);
  if (!entry || selected.mode === 'rename' && !name.value.trim()) return;
  pending.value = true;
  error.value = '';
  try {
    if (selected.mode === 'rename') await props.api.renameThread(name.value.trim(), entry.id, props.hostId);
    else await props.api.deleteThread(entry.id, props.hostId);
    if (!current()) return;
    action.value = null;
    await load();
  } catch (cause: any) { if (current()) error.value = cause.message || '无法更新附属分支'; }
  finally { if (!disposed) pending.value = false; }
}
async function open(entry: any) {
  if (!current() || pending.value) return;
  pending.value = true;
  error.value = '';
  try {
    if (archived.value) await props.api.unarchiveThread(entry.id, props.hostId);
    if (current()) emit('open', { id: entry.id, hostId: props.hostId });
  } catch (cause: any) { if (current()) error.value = cause.message || '无法打开附属分支'; }
  finally { if (!disposed) pending.value = false; }
}
watch(archived, () => { action.value = null; entries.value = []; cursor.value = null; void load(); });
onMounted(async () => { await nextTick(); dialog.value?.showModal(); await load(); });
onBeforeUnmount(() => { disposed = true; ++generation; });
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="attached-threads-dialog" :aria-labelledby="titleId" @keydown.stop @cancel.prevent="close">
      <header><h2 :id="titleId">附属分支</h2><button class="icon-button" aria-label="关闭附属分支" @click="close"><Icon name="X" :size="18" /></button></header>
      <p class="source-name">{{ threadLabel(thread) }}</p>
      <p class="description">附属分支保留当前对话的快照，独立继续聊天。它们保存在主机上，通过此列表查看；删除原对话前，需要先删除全部附属分支。此功能需要 Codex 0.165 或更新版本。</p>
      <div class="attached-toolbar">
        <button class="button button-primary" :disabled="pending || loading || uncertain" @click="create"><Icon name="GitBranch" :size="15" />{{ pending ? '处理中…' : '新建附属分支' }}</button>
        <button class="icon-button" aria-label="刷新附属分支" :disabled="pending || loading" @click="load()"><Icon name="RefreshCw" :size="16" :class="{ spin: loading }" /></button>
        <label><input v-model="archived" type="checkbox" :disabled="pending" />已归档</label>
      </div>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      <p v-if="!loading && !error && !entries.length" class="empty-state">{{ archived ? '没有已归档的附属分支' : '还没有附属分支' }}</p>
      <p v-if="loading && !entries.length" role="status">正在读取附属分支…</p>
      <ul class="attached-list">
        <li v-for="entry in entries" :key="entry.id">
          <div class="attached-row">
            <button class="attached-title" :disabled="pending" @click="open(entry)"><Icon name="GitBranch" :size="15" /><span>{{ threadLabel(entry) }}</span></button>
            <button class="icon-button" :disabled="pending" :aria-label="`重命名 ${threadLabel(entry)}`" @click="begin(entry, 'rename')"><Icon name="Pencil" :size="15" /></button>
            <button class="icon-button" :disabled="pending || entry.status?.type === 'active'" :aria-label="`删除 ${threadLabel(entry)}`" @click="begin(entry, 'delete')"><Icon name="Trash2" :size="15" /></button>
          </div>
          <form v-if="action && action.id === entry.id" class="attached-action" @submit.prevent="submit">
            <input v-if="action.mode === 'rename'" v-model="name" aria-label="附属分支名称" maxlength="1000" :disabled="pending" required />
            <p v-else>永久删除此附属分支？此操作无法撤销。</p>
            <div><button type="button" class="button button-secondary" :disabled="pending" @click="action = null">取消</button><button class="button" :class="action.mode === 'delete' ? 'button-danger' : 'button-primary'" :disabled="pending || action.mode === 'rename' && !name.trim()">{{ action.mode === 'rename' ? '保存名称' : '确认删除' }}</button></div>
          </form>
        </li>
      </ul>
      <button v-if="cursor" class="button button-secondary" :disabled="loading || pending" @click="load(true)">加载更多</button>
    </dialog>
  </Teleport>
</template>

<style scoped>
.attached-threads-dialog { width: min(620px, calc(100vw - 28px)); max-height: calc(100dvh - 32px); margin: auto; padding: 24px; overflow: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.attached-threads-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(3px); }
header, .attached-toolbar, .attached-row, .attached-action > div { display: flex; align-items: center; gap: 8px; }
header { justify-content: space-between; } h2 { margin: 0; font-size: 18px; }
.source-name { margin: 8px 0 12px; overflow-wrap: anywhere; font-size: 13px; color: var(--muted); }
.description { margin: 0 0 18px; font-size: 12px; color: var(--muted); line-height: 1.7; }
.attached-toolbar { margin-bottom: 14px; flex-wrap: wrap; } .attached-toolbar label { margin-left: auto; font-size: 12px; }
.attached-list { list-style: none; padding: 0; margin: 0; } .attached-list > li { border-top: 1px solid var(--border); }
.attached-row { min-height: 50px; } .attached-title { flex: 1; display: flex; align-items: center; gap: 9px; min-width: 0; padding: 12px 0; border: 0; background: transparent; color: var(--text); text-align: left; font: inherit; cursor: pointer; } .attached-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attached-action { padding: 4px 0 16px; } .attached-action input { width: 100%; padding: 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; } .attached-action > div { justify-content: flex-end; margin-top: 10px; } .attached-action p { margin: 0; font-size: 13px; }
.empty-state { padding: 20px 0; font-size: 13px; color: var(--muted); }
@media (max-width: 760px) { .attached-threads-dialog { padding: 20px; } .attached-action input { font-size: 16px; } }
</style>
