<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, watch } from "vue";
import Icon from "./Icon.vue";
import ProjectGroup from "./ProjectGroup.vue";
import ThreadRow from "./ThreadRow.vue";
import { isPinned, sortedThreads } from "../lib/navigation";
import { pinnedNavigation } from '../lib/pinned-navigation';
import { browserStorage } from "../lib/browser-storage";
import { matchesThreadTitle } from "../lib/thread-title-search";
import { matchesBookmark, type useConversationBookmarks } from "../lib/conversation-bookmarks";
import { bookmarkProjectDetails } from "../lib/bookmark-project";
import type { ConversationBookmark } from "../../shared/bookmarks";
import { createThreadIndicators, threadIndicatorsKey, threadIndicatorStorageKey } from '../lib/thread-indicators';
import { createThreadReadSync } from '../lib/thread-read-sync';
const props = defineProps<{ api: any; state: any; bookmarks: ReturnType<typeof useConversationBookmarks> }>();
const emit = defineEmits<{
  select: [selection: { id: string; hostId: string }];
  project: [project: any];
  settings: [tab: string];
  error: [message: string];
  bookmark: [entry: ConversationBookmark];
  projectAction: [
    action: {
      action: "files" | "edit" | "archive" | "remove" | "bookmarks";
      project: any;
    },
  ];
}>();
const search = ref("");
const searching = ref(false);
const archived = ref(false);
const results = ref<any[]>([]);
const cursors = ref<Record<string, string>>({});
const hasMoreResults = computed(() => Object.keys(cursors.value).length > 0);
const recentLimit = ref(20);
const recentHost = ref(browserStorage.local.getItem("codex.recentHostFilter") || "");
const expandedProjects = ref({ pinned: false, projects: false });
const projectLimit = 4;
const pinnedLimit = 6;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
const searchMode = computed(() => !!search.value.trim() || archived.value);
const savedResults = computed(() => !archived.value && search.value.trim()
  ? props.bookmarks.state.allEntries.filter(entry => matchesBookmark(entry, search.value)) : []);
function bookmarkDetail(entry: ConversationBookmark) {
  const project = bookmarkProjectDetails(entry, props.state.projects, props.state.hosts);
  return `${project.projectName} · ${project.hostName}`;
}
const hostProjects = computed(() => props.state.projects);
const pins = computed(() => props.state.preferences.pins);
const allThreads = computed(() => props.api.navigationThreads());
let readSync: ReturnType<typeof createThreadReadSync> | undefined;
const indicators = createThreadIndicators(browserStorage.local, Date.now, receipt => readSync?.markRead(receipt));
readSync = createThreadReadSync(props.state, props.api, indicators);
provide(threadIndicatorsKey, indicators);
function markVisibleConversation() {
  const visible = props.state.authenticated && props.state.threadReady && !props.state.selectingThread && !props.state.changingContext &&
    document.visibilityState === 'visible' && document.hasFocus();
  indicators.setVisible(props.state.hostId, visible ? props.state.activeThread?.id : null);
  if (visible && !props.state.busy && props.state.activeThread?.id)
    indicators.reconcileCompletedTurn(props.state.hostId, props.state.activeThread.id, props.state.turns?.at(-1));
}
watch(() => [props.state.hostId, props.state.activeThread?.id, props.state.threadReady, props.state.selectingThread,
  props.state.changingContext, props.state.authenticated], markVisibleConversation, { immediate: true, flush: 'post' });
watch(() => allThreads.value.map((thread: any) => ({ hostId: thread.hostId, id: thread.id, status: thread.status,
  // createdAt/updatedAt can change without a newly completed conversation.
  activityAt: thread.recencyAt || 0 })), threads => {
  if (props.state.authenticated) indicators.observeThreads(threads);
}, { immediate: true });
watch(() => {
  const turn = props.state.turns?.at(-1);
  return [props.state.hostId, props.state.activeThread?.id, props.state.threadReady, props.state.selectingThread,
    props.state.changingContext, props.state.busy, turn?.id, turn?.status, turn?.startedAt, turn?.completedAt];
}, () => {
  if (!props.state.authenticated || !props.state.threadReady || props.state.selectingThread || props.state.changingContext || props.state.busy || !props.state.activeThread?.id) return;
  indicators.reconcileCompletedTurn(props.state.hostId, props.state.activeThread.id, props.state.turns?.at(-1));
}, { flush: 'post' });
function mergeReadReceipts(event: StorageEvent) {
  if (event.key === threadIndicatorStorageKey) { indicators.merge(event.newValue); readSync?.captureLocal(); }
}
document.addEventListener('visibilitychange', markVisibleConversation);
window.addEventListener('focus', markVisibleConversation);
window.addEventListener('blur', markVisibleConversation);
window.addEventListener('storage', mergeReadReceipts);
const otherProjects = computed(() =>
  hostProjects.value.filter(
    (project: any) =>
      !isPinned(pins.value, project.hostId || "local", "project", project.path),
  ),
);
function visibleProjects(projects: any[], section: "projects") {
  if (expandedProjects.value[section] || projects.length <= projectLimit)
    return projects;
  const activeIndex = projects.findIndex(
    (project) =>
      (project.hostId || "local") === props.state.hostId &&
      !props.state.noProject &&
      [project.path, ...(project.rootPaths || [])].includes(props.state.projectPath),
  );
  const visible = projects.slice(0, projectLimit);
  if (activeIndex >= projectLimit)
    visible[projectLimit - 1] = projects[activeIndex];
  return visible;
}
const visibleOtherProjects = computed(() => visibleProjects(otherProjects.value, "projects"));
const pinnedEntries = computed(() => pinnedNavigation<any, any>(hostProjects.value, allThreads.value, pins.value));
const visiblePinnedEntries = computed(() => expandedProjects.value.pinned ? pinnedEntries.value : pinnedEntries.value.slice(0, pinnedLimit));
const filteredRecentThreads = computed(() =>
  sortedThreads<any>(
    allThreads.value.filter(
      (thread: any) =>
        (!recentHost.value || thread.hostId === recentHost.value) &&
        !isPinned(pins.value, thread.hostId, "thread", thread.id),
    ),
  ),
);
const recentThreads = computed(() => filteredRecentThreads.value.slice(0, recentLimit.value));
const moreRecentAvailable = computed(() =>
  props.api.navigationMore(recentHost.value || undefined) || filteredRecentThreads.value.length > recentLimit.value,
);
function filterRecent(hostId: string) {
  recentHost.value = hostId;
  recentLimit.value = 20;
  if (hostId) browserStorage.local.setItem("codex.recentHostFilter", hostId);
  else browserStorage.local.removeItem("codex.recentHostFilter");
}
// One shared topology; migrate the former selected-host collapse preference.
const key = (section: string) => `section:all:${section}`;
const collapsed = (section: string) =>
  (props.state.preferences.collapsed[key(section)] ??
    props.state.preferences.collapsed[`section:local:${section}`]) === true;
async function fold(section: string) {
  try {
    await props.api.setCollapsed(key(section), !collapsed(section));
  } catch (error: any) {
    emit("error", error.message);
  }
}
async function query(more = false) {
  const request = ++generation;
  searching.value = true;
  if (!more && !archived.value)
    results.value = sortedThreads<any>(allThreads.value.filter((thread: any) => matchesThreadTitle(thread, search.value)));
  try {
    const result = await props.api.queryNavigationThreads(
      search.value,
      archived.value,
      more ? cursors.value : undefined,
    );
    if (request !== generation) return;
    const records = new Map<string, any>();
    for (const thread of result.data) records.set(`${thread.hostId}:${thread.id}`, thread);
    for (const thread of more ? results.value : archived.value ? [] : allThreads.value.filter((thread: any) => matchesThreadTitle(thread, search.value)))
      records.set(`${thread.hostId}:${thread.id}`, thread);
    results.value = sortedThreads<any>([...records.values()]);
    cursors.value = result.nextCursors;
  } catch (error: any) {
    if (request === generation) emit("error", error.message);
  } finally {
    if (request === generation) searching.value = false;
  }
}
async function moreRecent() {
  recentLimit.value += 20;
  if (props.api.navigationMore(recentHost.value || undefined)) {
    try {
      await props.api.loadMoreNavigation(recentHost.value || undefined);
    } catch (error: any) {
      emit("error", error.message);
    }
  }
}
async function refresh() {
  try {
    await Promise.all([
      props.api.refreshNavigation(true),
      search.value.trim() && !archived.value ? props.bookmarks.ensureIndex({ force: true }) : undefined,
    ]);
    if (searchMode.value) await query();
  } catch (error: any) {
    emit("error", error.message);
  }
}
async function restored() {
  if (archived.value) await query();
}
function resultChanged(thread: { id: string; hostId: string; name?: string }, remove = false) {
  // A query started before the mutation must not bring the removed row or its
  // former name back after the action has succeeded.
  ++generation;
  clearTimeout(searchTimer);
  searching.value = false;
  const matches = (item: any) => item.id === thread.id && item.hostId === thread.hostId;
  results.value = remove
    ? results.value.filter((item) => !matches(item))
    : results.value.map((item) => matches(item) ? { ...item, name: thread.name } : item)
      .filter((item) => matchesThreadTitle(item, search.value));
}
const seenChanges = new Set<string>();
const unsubscribe = props.api.subscribeProtocol?.((hostId: string, message: any) => {
  if (props.state.authenticated) indicators.observe(hostId, message);
  const params = message.params || {};
  if (message.method === "bridge/disconnecting" ||
      (message.method === "bridge/status" && params.connected && !props.state.connected)) {
    seenChanges.clear();
    return;
  }
  if (typeof params.threadId !== "string") return;
  if (message.method === "bridge/thread/changed") {
    if (!["thread/name/set", "thread/delete", "thread/archive", "thread/unarchive"].includes(params.method)) return;
    if (typeof params.changeId === "string") {
      const key = `${hostId}:${params.changeId}`;
      if (seenChanges.has(key)) return;
      seenChanges.add(key);
      if (seenChanges.size > 512) seenChanges.delete(seenChanges.values().next().value!);
    }
    if (params.method === "thread/name/set" && typeof params.request?.name === "string")
      resultChanged({ id: params.threadId, hostId, name: params.request.name });
    else if (params.method === "thread/delete" ||
      (params.method === "thread/archive" && !archived.value) ||
      (params.method === "thread/unarchive" && archived.value))
      resultChanged({ id: params.threadId, hostId }, true);
  } else if (message.method === "thread/deleted")
    resultChanged({ id: params.threadId, hostId }, true);
  else if (message.method === "thread/name/updated" && typeof (params.threadName ?? params.name) === "string")
    resultChanged({ id: params.threadId, hostId, name: params.threadName ?? params.name });
}) || (() => {});
watch(() => [props.state.hostId, props.state.authenticated], () => seenChanges.clear());
watch(() => props.state.hosts.map((host: any) => host.id), (hosts) => {
  if (hosts.length && recentHost.value && !hosts.includes(recentHost.value)) filterRecent("");
});
watch(
  () => [
    search.value,
    archived.value,
    props.state.hosts.map((host: any) => host.id).join(","),
  ],
  () => {
    ++generation;
    clearTimeout(searchTimer);
    results.value = [];
    cursors.value = {};
    if (searchMode.value) {
      if (!archived.value && props.state.authenticated) void props.bookmarks.ensureIndex();
      if (!archived.value)
        results.value = sortedThreads<any>(allThreads.value.filter((thread: any) => matchesThreadTitle(thread, search.value)));
      searchTimer = setTimeout(() => void query(), 220);
    }
  },
);
watch(
  () =>
    allThreads.value
      .map((thread: any) => `${thread.hostId}:${thread.id}`)
      .join(","),
  () => {
    if (archived.value) void restored();
  },
);
onBeforeUnmount(() => {
  readSync?.stop();
  clearTimeout(searchTimer);
  ++generation;
  unsubscribe();
  document.removeEventListener('visibilitychange', markVisibleConversation);
  window.removeEventListener('focus', markVisibleConversation);
  window.removeEventListener('blur', markVisibleConversation);
  window.removeEventListener('storage', mergeReadReceipts);
});
</script>
<template>
  <nav class="conversation-nav" aria-label="会话导航">
    <div class="nav-search">
      <Icon name="Search" :size="14" /><input
        v-model="search"
        placeholder="搜索对话标题或收藏…"
        aria-label="搜索对话"
      /><button
        v-if="search"
        class="icon-button"
        @click="search = ''"
        aria-label="清空搜索"
      >
        <Icon name="X" :size="13" /></button
      ><button
        class="icon-button"
        @click="refresh"
        title="刷新对话"
        aria-label="刷新对话"
      >
        <Icon
          :name="searching ? 'LoaderCircle' : 'RefreshCw'"
          :size="13"
          :class="{ spin: searching }"
        />
      </button>
    </div>
    <div v-if="searchMode" class="nav-search-results">
      <div class="sidebar-section-heading">
        <strong>{{ archived ? "已归档" : "搜索结果" }}</strong
        ><button
          class="icon-button"
          @click="
            search = '';
            archived = false;
          "
          title="返回会话导航"
          aria-label="返回会话导航"
        >
          <Icon name="ArrowLeft" :size="14" />
        </button>
      </div>
      <section v-if="!archived && search.trim()" class="nav-bookmark-results" aria-label="收藏搜索结果">
        <div class="sidebar-section-heading"><strong>收藏对话</strong><span>{{ savedResults.length }}</span></div>
        <button v-for="entry in savedResults" :key="entry.id" type="button" class="nav-bookmark-result"
          :disabled="!!bookmarks.state.busyId" :aria-label="`跳转到收藏 ${entry.name}`" @click="emit('bookmark', entry)">
          <Icon name="Bookmark" :size="14" />
          <span><strong>{{ entry.name }}</strong><small>{{ bookmarkDetail(entry) }}</small><span class="nav-bookmark-excerpt">{{ entry.source.text.slice(0, 180) }}</span></span>
        </button>
        <p v-if="bookmarks.state.indexError" class="nav-bookmark-error" role="alert">{{ bookmarks.state.indexError }}<button type="button" @click="bookmarks.ensureIndex({ force: true })">重试</button></p>
        <p v-else-if="!savedResults.length" class="nav-empty">{{ bookmarks.state.indexLoading ? '正在搜索收藏…' : '没有匹配的收藏' }}</p>
      </section>
      <div v-if="!archived && search.trim()" class="sidebar-section-heading"><strong>对话标题</strong></div>
      <ThreadRow
        v-for="thread in results"
        :key="`${thread.hostId}:${thread.id}`"
        :thread="thread"
        :state="state"
        :api="api"
        :archived="archived"
        @select="emit('select', $event)"
        @error="emit('error', $event)"
        @renamed="resultChanged($event)"
        @deleted="resultChanged($event, true)"
        @restored="resultChanged($event, true)"
      />
      <p v-if="!results.length" class="nav-empty">
        {{
          searching
            ? "正在搜索…"
            : archived
              ? "没有已归档对话"
              : "没有匹配的对话"
        }}
      </p>
      <button
        v-if="hasMoreResults"
        class="nav-load-more"
        :disabled="searching"
        @click="query(true)"
      >
        加载更多结果
      </button>
    </div>
    <template v-else>
      <section class="nav-section" data-section="pinned">
        <div class="sidebar-section-heading">
          <button
            class="nav-section-toggle"
            @click="fold('pinned')"
            :aria-expanded="!collapsed('pinned')"
            :aria-label="`${collapsed('pinned') ? '展开' : '折叠'}置顶`"
          >
            <Icon
              :name="collapsed('pinned') ? 'ChevronRight' : 'ChevronDown'"
              :size="13"
            /><span>置顶</span></button
          ><Icon name="Pin" :size="12" />
        </div>
        <div v-if="!collapsed('pinned')">
          <template v-for="entry in visiblePinnedEntries" :key="entry.key">
            <ProjectGroup
              v-if="entry.kind === 'project'"
              :project="entry.project"
              :state="state"
              :api="api"
              pinned
              @project="emit('project', $event)"
              @project-action="emit('projectAction', $event)"
              @select="emit('select', $event)"
              @error="emit('error', $event)"
            />
            <ThreadRow
              v-else
              :thread="entry.thread"
              :state="state"
              :api="api"
              @select="emit('select', $event)"
              @error="emit('error', $event)"
            />
          </template>
          <button
            v-if="pinnedEntries.length > pinnedLimit"
            class="nav-load-more nav-overflow-toggle"
            :aria-expanded="expandedProjects.pinned"
            @click="expandedProjects.pinned = !expandedProjects.pinned"
          >
            <Icon :name="expandedProjects.pinned ? 'ChevronUp' : 'ChevronDown'" :size="12" />
            {{ expandedProjects.pinned ? "收起置顶" : `显示另外 ${pinnedEntries.length - pinnedLimit} 个置顶项` }}
          </button>
          <p
            v-if="!pinnedEntries.length"
            class="nav-empty"
          >
            置顶常用项目或对话
          </p>
        </div>
      </section>
      <section class="nav-section" data-section="projects">
        <div class="sidebar-section-heading">
          <button
            class="nav-section-toggle"
            @click="fold('projects')"
            :aria-expanded="!collapsed('projects')"
            :aria-label="`${collapsed('projects') ? '展开' : '折叠'}项目`"
          >
            <Icon
              :name="collapsed('projects') ? 'ChevronRight' : 'ChevronDown'"
              :size="13"
            /><span>项目</span></button
          ><button
            class="icon-button"
            @click="emit('settings', 'projects')"
            title="添加项目"
            aria-label="添加项目"
          >
            <Icon name="Plus" :size="14" />
          </button>
        </div>
        <div v-if="!collapsed('projects')">
          <ProjectGroup
            v-for="project in visibleOtherProjects"
            :key="`${project.hostId}:${project.path}`"
            :project="project"
            :state="state"
            :api="api"
            @project="emit('project', $event)"
            @project-action="emit('projectAction', $event)"
            @select="emit('select', $event)"
            @error="emit('error', $event)"
          />
          <button
            v-if="otherProjects.length > projectLimit"
            class="nav-load-more nav-overflow-toggle"
            :aria-expanded="expandedProjects.projects"
            @click="expandedProjects.projects = !expandedProjects.projects"
          >
            <Icon :name="expandedProjects.projects ? 'ChevronUp' : 'ChevronDown'" :size="12" />
            {{ expandedProjects.projects ? "收起项目" : `显示另外 ${otherProjects.length - projectLimit} 个项目` }}
          </button>
          <button
            v-if="!hostProjects.length"
            class="sidebar-add-project"
            @click="emit('settings', 'projects')"
          >
            <Icon name="Plus" :size="15" />添加你的第一个项目
          </button>
          <p v-else-if="!otherProjects.length" class="nav-empty">
            项目已移至置顶
          </p>
        </div>
      </section>
      <section class="nav-section" data-section="recent">
        <div class="sidebar-section-heading">
          <button
            class="nav-section-toggle"
            @click="fold('recent')"
            :aria-expanded="!collapsed('recent')"
            :aria-label="`${collapsed('recent') ? '展开' : '折叠'}最近`"
          >
            <Icon
              :name="collapsed('recent') ? 'ChevronRight' : 'ChevronDown'"
              :size="13"
            /><span>最近</span></button
          ><button
            class="icon-button"
            @click="archived = true"
            title="已归档对话"
            aria-label="已归档对话"
          >
            <Icon name="Archive" :size="14" />
          </button>
        </div>
        <div v-if="!collapsed('recent')">
          <div class="recent-host-filter" role="group" aria-label="按设备筛选最近对话">
            <button type="button" :aria-pressed="!recentHost" :class="{ selected: !recentHost }" @click="filterRecent('')">全部</button>
            <button v-for="host in state.hosts" :key="host.id" type="button"
              :aria-pressed="recentHost === host.id" :class="{ selected: recentHost === host.id }"
              :title="host.name" @click="filterRecent(host.id)">{{ host.name }}</button>
          </div>
          <ThreadRow
            v-for="thread in recentThreads"
            :key="`${thread.hostId}:${thread.id}`"
            :thread="thread"
            :state="state"
            :api="api"
            @select="emit('select', $event)"
            @error="emit('error', $event)"
          />
          <p v-if="!recentThreads.length" class="nav-empty">{{ recentHost ? "此设备暂无最近对话" : "暂无最近对话" }}</p>
          <button
            v-if="moreRecentAvailable"
            class="nav-load-more"
            @click="moreRecent"
          >
            加载更早的对话
          </button>
        </div>
      </section>
    </template>
  </nav>
</template>

<style scoped>
.nav-bookmark-result { display: flex; align-items: flex-start; gap: 9px; width: 100%; padding: 10px 12px; border: 0; border-radius: 9px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.nav-bookmark-result:hover { background: var(--hover); }
.nav-bookmark-result:focus-visible { outline: 2px solid var(--green); outline-offset: -2px; }
.nav-bookmark-result > svg { flex: none; margin-top: 3px; color: var(--muted); }
.nav-bookmark-result > span { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.nav-bookmark-result strong { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.nav-bookmark-result small { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-bookmark-excerpt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; color: var(--muted); font-size: 11px; line-height: 1.6; }
.nav-bookmark-result:disabled { opacity: .6; cursor: default; }
.nav-bookmark-error { padding: 0 12px; font-size: 12px; color: var(--danger); overflow-wrap: anywhere; }
.nav-bookmark-error button { margin-left: 6px; padding: 4px 8px; background: var(--hover); color: var(--text); border: 1px solid var(--border); border-radius: 6px; }
.recent-host-filter {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scrollbar-width: thin;
  padding: 0 6px 6px;
  margin-bottom: 3px;
}
.recent-host-filter button {
  flex: 0 0 auto;
  max-width: 144px;
  min-height: 27px;
  padding: 3px 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-host-filter button:hover { background: var(--hover); color: var(--text); }
.recent-host-filter button.selected { background: var(--selected); color: var(--text); border-color: var(--border); }
.nav-overflow-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
}
@media (max-width: 760px) {
  .recent-host-filter button { min-height: 36px; }
  .nav-overflow-toggle {
    min-height: 40px;
  }
}
</style>
