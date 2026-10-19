<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import ThreadRow from './ThreadRow.vue';
import { matchesProject, sortedThreads } from '../lib/navigation';
import { matchesThreadTitle } from '../lib/thread-title-search';

const props = defineProps<{ api: any; state: any; hostId: string }>();
const search = ref('');
const projectFilter = ref('');
const threads = ref<any[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
const warning = ref('');
const host = computed(() => props.state.hosts?.find((entry: any) => entry.id === props.hostId));
const projects = computed(() => (props.state.projects || []).filter((project: any) => (project.hostId || 'local') === props.hostId));
const selectedProject = computed(() => projects.value.find((project: any) => project.id === projectFilter.value));
const removed = new Set<string>();
let generation = 0;
let disposed = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const matches = (thread: any, project: any) => props.api.threadMatchesProject
  ? props.api.threadMatchesProject(thread, project)
  : matchesProject(thread, project);
const groups = computed(() => {
  const result = new Map<string, { id: string; name: string; path: string; threads: any[] }>();
  for (const thread of sortedThreads<any>(threads.value)) {
    if (!matchesThreadTitle(thread, search.value)) continue;
    const project = projects.value.find((entry: any) => matches(thread, entry));
    if (projectFilter.value === '__other__' ? !!project : selectedProject.value && !matches(thread, selectedProject.value)) continue;
    const id = project?.id || '__other__';
    if (!result.has(id)) result.set(id, { id, name: project?.name || project?.path || '其他对话', path: project?.path || '', threads: [] });
    result.get(id)!.threads.push(thread);
  }
  return [...result.values()];
});
const visibleCount = computed(() => groups.value.reduce((count, group) => count + group.threads.length, 0));

async function load(more = false, force = false) {
  if (disposed || !props.state.authenticated || !host.value || more && (loading.value || !cursor.value)) return;
  clearTimeout(searchTimer);
  const request = ++generation;
  const hostId = props.hostId;
  const query = search.value.trim();
  const pageCursor = more ? cursor.value : null;
  const authentication = props.api.runtimeIdentity?.().authenticationGeneration;
  const current = () => !disposed && request === generation && hostId === props.hostId && props.state.authenticated &&
    !!host.value && authentication === props.api.runtimeIdentity?.().authenticationGeneration;
  loading.value = true;
  error.value = '';
  warning.value = '';
  if (!more) { threads.value = []; cursor.value = null; removed.clear(); }
  try {
    try { await props.api.loadNativeProjectBindings?.(hostId, force); }
    catch { if (current()) warning.value = '项目归属暂时无法同步，仍可管理归档；刷新后可重试同步。'; }
    if (!current()) return;
    const result = await props.api.queryThreads(query, true, pageCursor, hostId, { force });
    if (!current()) return;
    const records = new Map<string, any>();
    for (const thread of [...(more ? threads.value : []), ...(result.data || [])]) {
      if (typeof thread.id === 'string' && !removed.has(thread.id)) records.set(thread.id, { ...thread, hostId });
    }
    threads.value = [...records.values()];
    cursor.value = result.nextCursor || null;
    if (cursor.value && cursor.value === pageCursor) {
      cursor.value = null;
      error.value = '分页未能继续，请刷新列表后重试。';
    }
  } catch (cause: any) {
    if (current()) error.value = cause.message || '无法读取已归档的聊天';
  } finally {
    if (current()) loading.value = false;
  }
}
function removeThread(thread: { id: string; hostId: string }) {
  if (thread.hostId !== props.hostId) return;
  removed.add(thread.id);
  threads.value = threads.value.filter(entry => entry.id !== thread.id);
}
function renameThread(thread: { id: string; hostId: string; name: string }) {
  if (thread.hostId !== props.hostId) return;
  threads.value = threads.value.map(entry => entry.id === thread.id ? { ...entry, name: thread.name } : entry);
}
function moveThread(thread: { id: string; hostId: string; projectId: string | null }) {
  if (thread.hostId !== props.hostId) return;
  threads.value = threads.value.map(entry => entry.id === thread.id ? { ...entry, projectId: thread.projectId } : entry);
}
function rowError(hostId: string, message: string) { if (hostId === props.hostId) error.value = message; }
watch(() => [props.hostId, props.state.authenticated, search.value] as const, (value, previous) => {
  clearTimeout(searchTimer);
  ++generation;
  loading.value = false;
  threads.value = [];
  cursor.value = null;
  error.value = '';
  warning.value = '';
  removed.clear();
  if (value[0] !== previous?.[0]) projectFilter.value = '';
  if (value[1] && host.value) {
    loading.value = true;
    searchTimer = setTimeout(() => { loading.value = false; void load(); }, previous && value[2] !== previous[2] ? 180 : 0);
  }
}, { immediate: true });
watch(projects, () => {
  if (projectFilter.value && projectFilter.value !== '__other__' && !selectedProject.value) projectFilter.value = '';
});
const unsubscribe = props.api.subscribeProtocol?.((hostId: string, message: any) => {
  if (hostId !== props.hostId || !props.state.authenticated) return;
  const params = message.params || {};
  if (typeof params.threadId !== 'string') return;
  if (message.method === 'thread/deleted' || message.method === 'thread/unarchived' ||
      message.method === 'bridge/thread/changed' && ['thread/delete', 'thread/unarchive'].includes(params.method))
    removeThread({ id: params.threadId, hostId });
  else if (message.method === 'thread/name/updated' || message.method === 'bridge/thread/changed' && params.method === 'thread/name/set') {
    const name = params.threadName ?? params.name ?? params.request?.name;
    if (typeof name === 'string') renameThread({ id: params.threadId, hostId, name });
  } else if (message.method === 'thread/project/updated' || message.method === 'bridge/thread/changed' && params.method === 'thread/metadata/update') {
    const projectId = params.projectId ?? params.result?.thread?.projectId ?? params.request?.projectId ?? null;
    moveThread({ id: params.threadId, hostId, projectId });
  }
});
onBeforeUnmount(() => { disposed = true; ++generation; clearTimeout(searchTimer); unsubscribe?.(); });
</script>

<template>
  <section class="archived-chats" aria-label="已归档的聊天">
    <div class="archived-heading">
      <div><h3>已归档的聊天</h3><p>管理 {{ host?.name || '所选主机' }} 的归档，不会切换当前对话。</p></div>
      <button type="button" class="icon-button" aria-label="刷新已归档的聊天" :disabled="loading" @click="load(false, true)"><Icon :name="loading ? 'LoaderCircle' : 'RefreshCw'" :size="17" :class="{ spin: loading }" /></button>
    </div>
    <div class="archived-filters">
      <label class="archived-search"><Icon name="Search" :size="16" /><input v-model="search" type="search" aria-label="搜索归档标题" placeholder="搜索聊天标题…" /></label>
      <select v-model="projectFilter" class="text-input" aria-label="筛选归档项目">
        <option value="">全部项目</option>
        <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name || project.path }}</option>
        <option value="__other__">其他对话</option>
      </select>
    </div>
    <p v-if="error" class="archived-error" role="alert">{{ error }}<button v-if="!threads.length && !loading" type="button" @click="load(false, true)">重试</button></p>
    <p v-if="warning" class="archived-help archived-warning" role="status">{{ warning }}</p>
    <div class="archived-results" :aria-busy="loading">
      <p v-if="loading && !threads.length" class="archived-empty" role="status">正在加载归档…</p>
      <template v-else-if="visibleCount">
        <section v-for="group in groups" :key="group.id" class="archived-project" :aria-label="`${group.name}的归档`">
          <header><Icon :name="group.id === '__other__' ? 'Archive' : 'Folder'" :size="15" /><h4>{{ group.name }}</h4><span>{{ group.threads.length }}</span><p v-if="group.path" :title="group.path">{{ group.path }}</p></header>
          <ThreadRow v-for="thread in group.threads" :key="`${hostId}:${thread.id}`" :thread="thread" :state="state" :api="api" archived @restored="removeThread" @deleted="removeThread" @renamed="renameThread" @moved="moveThread" @error="message => rowError(thread.hostId, message)" />
        </section>
      </template>
      <div v-else-if="!error" class="archived-empty"><Icon name="Archive" :size="26" /><p>{{ search.trim() || projectFilter ? '没有匹配的归档聊天' : '此主机还没有归档聊天' }}</p><span v-if="cursor">已加载的对话中没有匹配项，可继续加载更多。</span></div>
    </div>
    <footer><span>已加载 {{ threads.length }} 条<span v-if="projectFilter"> · 显示 {{ visibleCount }} 条</span></span><button v-if="cursor" type="button" class="button button-small button-secondary" :disabled="loading" @click="load(true)">{{ loading ? '正在加载…' : '加载更多' }}</button></footer>
    <p class="archived-help">点击标题可取消归档；在聊天菜单中可永久删除。搜索仅匹配标题，项目筛选作用于已加载的聊天。</p>
  </section>
</template>

<style scoped>
.archived-chats { min-width: 0; }
.archived-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 20px; }
.archived-heading h3 { margin: 0 0 7px; }
.archived-heading p, .archived-help { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.65; }
.archived-heading > .icon-button { flex: none; }
.archived-filters { display: flex; gap: 8px; margin-bottom: 16px; }
.archived-search { display: flex; align-items: center; flex: 1; gap: 8px; min-width: 0; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; color: var(--muted); background: var(--bg); }
.archived-search:focus-within { outline: 2px solid var(--accent-text); outline-offset: 1px; }
.archived-search input { width: 100%; min-width: 0; border: 0; padding: 0; outline: none; background: transparent; color: var(--text); font: inherit; font-size: 13px; }
.archived-search svg { flex: none; }
.archived-filters select { width: auto; max-width: 45%; font-size: 12px; }
.archived-error { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; color: var(--red); font-size: 12px; overflow-wrap: anywhere; }
.archived-error button { color: var(--accent-text); text-decoration: underline; }
.archived-project { min-width: 0; padding: 0 0 12px; }
.archived-project + .archived-project { padding-top: 12px; border-top: 1px solid var(--border); }
.archived-project > header { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; padding: 0 3px 8px; color: var(--muted); }
.archived-project h4 { flex: 1; min-width: 0; margin: 0; color: var(--text); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
.archived-project header > span { font-size: 11px; }
.archived-project header > p { width: 100%; margin: 0 0 0 22px; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archived-results { min-height: 100px; }
.archived-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 30px 12px; color: var(--muted); text-align: center; font-size: 13px; }
.archived-empty p { margin: 0; }
.archived-empty span { font-size: 12px; line-height: 1.6; }
.archived-chats footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-top: 6px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11px; }
.archived-help { margin-top: 14px; font-size: 11px; }
.archived-warning { margin: 0 0 12px; }
.archived-project :deep(.nav-thread) { width: 100%; margin: 0; }
.archived-project :deep(.thread-row) { min-height: 40px; padding-left: 8px; padding-right: 34px; }
.archived-project :deep(.thread-title) { font-size: 13px; }
.archived-project :deep(.host-badge) { display: none; }
.archived-project :deep(.nav-row-menu) { opacity: 1; }
.archived-project :deep(.nav-context-menu) { width: min(238px, 100%); }
@media(max-width: 760px) {
  .archived-heading { margin-bottom: 16px; }
  .archived-filters { flex-wrap: wrap; }
  .archived-search { flex-basis: 100%; min-height: 42px; }
  .archived-search input { font-size: 16px; }
  .archived-filters select { width: 100%; max-width: none; min-height: 40px; font-size: 14px; }
  .archived-project :deep(.thread-row) { min-height: 44px; }
  .archived-project :deep(.nav-row-menu) { width: 36px; height: 40px; }
}
</style>
