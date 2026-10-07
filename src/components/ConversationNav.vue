<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import ProjectGroup from "./ProjectGroup.vue";
import ThreadRow from "./ThreadRow.vue";
import { isPinned, sortedThreads } from "../lib/navigation";
const props = defineProps<{ api: any; state: any }>();
const emit = defineEmits<{
  select: [selection: { id: string; hostId: string }];
  project: [project: any];
  settings: [tab: string];
  error: [message: string];
  projectAction: [
    action: {
      action: "files" | "edit" | "archive" | "remove";
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
const expandedProjects = ref({ pinned: false, projects: false });
const projectLimit = 4;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
const searchMode = computed(() => !!search.value.trim() || archived.value);
const hostProjects = computed(() => props.state.projects);
const pins = computed(() => props.state.preferences.pins);
const allThreads = computed(() => props.api.navigationThreads());
const pinnedProjects = computed(() =>
  hostProjects.value.filter((project: any) =>
    isPinned(pins.value, project.hostId || "local", "project", project.path),
  ),
);
const otherProjects = computed(() =>
  hostProjects.value.filter(
    (project: any) =>
      !isPinned(pins.value, project.hostId || "local", "project", project.path),
  ),
);
function visibleProjects(projects: any[], section: "pinned" | "projects") {
  if (expandedProjects.value[section] || projects.length <= projectLimit)
    return projects;
  const activeIndex = projects.findIndex(
    (project) =>
      (project.hostId || "local") === props.state.hostId &&
      [project.path, ...(project.rootPaths || [])].includes(props.state.projectPath),
  );
  const visible = projects.slice(0, projectLimit);
  if (activeIndex >= projectLimit)
    visible[projectLimit - 1] = projects[activeIndex];
  return visible;
}
const visiblePinnedProjects = computed(() => visibleProjects(pinnedProjects.value, "pinned"));
const visibleOtherProjects = computed(() => visibleProjects(otherProjects.value, "projects"));
const pinnedThreads = computed(() =>
  pins.value
    .filter((pin: any) => pin.kind === "thread")
    .map((pin: any) =>
      allThreads.value.find(
        (thread: any) => thread.id === pin.id && thread.hostId === pin.hostId,
      ),
    )
    .filter(Boolean),
);
const recentThreads = computed(() =>
  sortedThreads<any>(
    allThreads.value.filter(
      (thread: any) =>
        !isPinned(pins.value, thread.hostId, "thread", thread.id),
    ),
  ).slice(0, recentLimit.value),
);
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
  try {
    const result = await props.api.queryNavigationThreads(
      search.value,
      archived.value,
      more ? cursors.value : undefined,
    );
    if (request !== generation) return;
    const known = new Set(
      more
        ? results.value.map((thread) => `${thread.hostId}:${thread.id}`)
        : [],
    );
    results.value = [
      ...(more ? results.value : []),
      ...sortedThreads<any>(
        result.data.filter(
          (thread: any) => !known.has(`${thread.hostId}:${thread.id}`),
        ),
      ),
    ];
    cursors.value = result.nextCursors;
  } catch (error: any) {
    if (request === generation) emit("error", error.message);
  } finally {
    if (request === generation) searching.value = false;
  }
}
async function moreRecent() {
  recentLimit.value += 20;
  if (props.api.navigationMore()) {
    try {
      await props.api.loadMoreNavigation();
    } catch (error: any) {
      emit("error", error.message);
    }
  }
}
async function refresh() {
  try {
    await props.api.refreshNavigation(true);
    if (searchMode.value) await query();
  } catch (error: any) {
    emit("error", error.message);
  }
}
async function restored() {
  if (archived.value) await query();
}
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
    if (searchMode.value) searchTimer = setTimeout(() => void query(), 220);
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
  clearTimeout(searchTimer);
  ++generation;
});
</script>
<template>
  <nav class="conversation-nav" aria-label="会话导航">
    <div class="nav-search">
      <Icon name="Search" :size="14" /><input
        v-model="search"
        placeholder="搜索全部对话…"
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
      <ThreadRow
        v-for="thread in results"
        :key="`${thread.hostId}:${thread.id}`"
        :thread="thread"
        :state="state"
        :api="api"
        :archived="archived"
        @select="emit('select', $event)"
        @error="emit('error', $event)"
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
          <ProjectGroup
            v-for="project in visiblePinnedProjects"
            :key="`${project.hostId}:${project.path}`"
            :project="project"
            :state="state"
            :api="api"
            pinned
            @project="emit('project', $event)"
            @project-action="emit('projectAction', $event)"
            @select="emit('select', $event)"
            @error="emit('error', $event)"
          />
          <button
            v-if="pinnedProjects.length > projectLimit"
            class="nav-load-more nav-overflow-toggle"
            :aria-expanded="expandedProjects.pinned"
            @click="expandedProjects.pinned = !expandedProjects.pinned"
          >
            <Icon :name="expandedProjects.pinned ? 'ChevronUp' : 'ChevronDown'" :size="12" />
            {{ expandedProjects.pinned ? "收起置顶项目" : `显示另外 ${pinnedProjects.length - projectLimit} 个置顶项目` }}
          </button>
          <ThreadRow
            v-for="thread in pinnedThreads"
            :key="`${thread.hostId}:${thread.id}`"
            :thread="thread"
            :state="state"
            :api="api"
            @select="emit('select', $event)"
            @error="emit('error', $event)"
          />
          <p
            v-if="!pinnedProjects.length && !pinnedThreads.length"
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
          <ThreadRow
            v-for="thread in recentThreads"
            :key="`${thread.hostId}:${thread.id}`"
            :thread="thread"
            :state="state"
            :api="api"
            @select="emit('select', $event)"
            @error="emit('error', $event)"
          />
          <p v-if="!recentThreads.length" class="nav-empty">暂无最近对话</p>
          <button
            v-if="api.navigationMore() || allThreads.length > recentLimit"
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
.nav-overflow-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
}
@media (max-width: 760px) {
  .nav-overflow-toggle {
    min-height: 40px;
  }
}
</style>
