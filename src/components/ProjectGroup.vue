<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import Icon from "./Icon.vue";
import ThreadRow from "./ThreadRow.vue";
import {
  isPinned,
  matchesProject,
  projectKey,
  sortedThreads,
} from "../lib/navigation";
const props = defineProps<{
  project: any;
  state: any;
  api: any;
  pinned?: boolean;
}>();
const emit = defineEmits<{
  project: [project: any];
  select: [selection: { id: string; hostId: string }];
  error: [message: string];
  projectAction: [
    action: {
      action: "files" | "edit" | "archive" | "remove";
      project: any;
    },
  ];
}>();
const menu = ref(false);
const expandedThreads = ref(false);
const loadingOlder = ref(false);
const threadLimit = 4;
const menuElement = ref<HTMLElement>();
const menuReady = ref(false);
const menuPosition = ref({ left: 0, top: 0 });
const menuId = `project-menu-${useId()}`;
let opener: HTMLElement | null = null;
let openerPosition: { left: number; top: number } | null = null;
const openEvent = "codex-project-menu-open";
const hostId = computed(() => props.project.hostId || "local");
const host = computed(() =>
  props.state.hosts.find((item: any) => item.id === hostId.value),
);
const key = computed(() => projectKey(hostId.value, props.project.path));
const collapsed = computed(
  () => props.state.preferences.collapsed[key.value] === true,
);
const starred = computed(() =>
  isPinned(
    props.state.preferences.pins,
    hostId.value,
    "project",
    props.project.path,
  ),
);
const threads = computed(() =>
  sortedThreads<any>(
    props.api
      .navigationThreads()
      .filter((thread: any) =>
        (thread.hostId || props.state.hostId) === hostId.value &&
        matchesProject(thread, props.project),
      ),
  ),
);
const current = computed(
  () =>
    hostId.value === props.state.hostId &&
    [props.project.path, ...(props.project.rootPaths || [])].includes(
      props.state.projectPath,
    ),
);
const visibleThreads = computed(() => {
  if (expandedThreads.value || threads.value.length <= threadLimit)
    return threads.value;
  const visible = threads.value.slice(0, threadLimit);
  const activeIndex = threads.value.findIndex(
    (thread: any) =>
      hostId.value === props.state.hostId &&
      thread.id === props.state.activeThread?.id,
  );
  if (activeIndex >= threadLimit)
    visible[threadLimit - 1] = threads.value[activeIndex];
  return visible;
});
const hasOlderThreads = computed(
  () => !!props.api.navigationProjectPage(hostId.value, props.project.path)?.cursor,
);
async function loadOlderThreads() {
  if (loadingOlder.value) return;
  expandedThreads.value = true;
  loadingOlder.value = true;
  try {
    await props.api.loadNavigationProject(hostId.value, props.project.path, true);
  } catch (error: any) {
    emit("error", error.message);
  } finally {
    loadingOlder.value = false;
  }
}
function closeMenu(restoreFocus = false) {
  menu.value = false;
  menuReady.value = false;
  if (restoreFocus && opener?.isConnected)
    opener.focus({ preventScroll: true });
}
async function openMenu(event: MouseEvent | KeyboardEvent) {
  if (event.type === "click" && menu.value) return closeMenu(true);
  const target =
    event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  opener = target?.matches("button")
    ? target
    : target?.querySelector<HTMLElement>(".project-row") || null;
  const openerBounds = opener?.getBoundingClientRect();
  openerPosition = openerBounds ? { left: openerBounds.left, top: openerBounds.top } : null;
  const anchor = target?.getBoundingClientRect();
  const pointer = event instanceof MouseEvent && event.type === "contextmenu";
  const x = pointer ? event.clientX : anchor?.left || 0;
  const y = pointer ? event.clientY : anchor?.bottom || 0;
  // Another project may have been opened with a keyboard context-menu command.
  document.dispatchEvent(new CustomEvent(openEvent));
  menuReady.value = false;
  menuPosition.value = { left: x, top: y + (pointer ? 0 : 4) };
  menu.value = true;
  await nextTick();
  if (!menu.value || !menuElement.value) return;
  const bounds = menuElement.value.getBoundingClientRect();
  menuPosition.value = {
    left: Math.max(8, Math.min(x, innerWidth - bounds.width - 8)),
    top: Math.max(
      8,
      Math.min(y + (pointer ? 0 : 4), innerHeight - bounds.height - 8),
    ),
  };
  menuReady.value = true;
  await nextTick();
  if (menu.value)
    menuElement.value
      ?.querySelector<HTMLButtonElement>("[role=menuitem]")
      ?.focus();
}
function contextKey(event: KeyboardEvent) {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    void openMenu(event);
  }
}
function outside(event: PointerEvent) {
  if (!(event.target instanceof Node)) return;
  if (
    !menuElement.value?.contains(event.target) &&
    !opener?.contains(event.target)
  )
    closeMenu();
}
function dismissOnScroll(event: Event) {
  if (event.target instanceof Node && menuElement.value?.contains(event.target))
    return;
  // Only movement of the anchor changes the fixed menu position. Streaming
  // replies and cached-history restoration scroll the separate conversation
  // pane and must not dismiss a project menu the user has just opened.
  if (event.target !== window &&
      !(opener && event.target instanceof Node && event.target.contains(opener))) return;
  const position = opener?.getBoundingClientRect();
  // A scrollIntoView from the preceding pointer action can deliver its scroll
  // event after contextmenu. The anchor was already in its final position when
  // the menu opened, so dismiss only when it has actually moved since then.
  if (!position || !openerPosition || Math.abs(position.left - openerPosition.left) > .5 ||
      Math.abs(position.top - openerPosition.top) > .5) closeMenu();
}
function menuKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
    return;
  }
  if (event.key === "Tab") {
    closeMenu(true);
    return;
  }
  const items = Array.from(
    menuElement.value?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ||
      [],
  );
  if (
    !items.length ||
    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
  )
    return;
  event.preventDefault();
  const currentIndex = items.indexOf(
    document.activeElement as HTMLButtonElement,
  );
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
          items.length;
  items[nextIndex]?.focus();
}
function removeListeners() {
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("keydown", menuKey, true);
  document.removeEventListener("scroll", dismissOnScroll, true);
  document.removeEventListener(openEvent, closeMenuListener);
  window.removeEventListener("resize", closeMenuListener);
}
function closeMenuListener() {
  closeMenu();
}
watch(menu, (opened) => {
  removeListeners();
  if (!opened) return;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", menuKey, true);
  document.addEventListener("scroll", dismissOnScroll, true);
  document.addEventListener(openEvent, closeMenuListener);
  window.addEventListener("resize", closeMenuListener);
});
onBeforeUnmount(removeListeners);
function action(action: "files" | "edit" | "archive" | "remove") {
  closeMenu(true);
  emit("projectAction", { action, project: props.project });
}
async function toggle() {
  try {
    await props.api.setCollapsed(key.value, !collapsed.value);
  } catch (error: any) {
    emit("error", error.message);
  }
}
watch(
  () => [
    collapsed.value,
    props.state.authenticated,
    props.state.connected,
    props.state.hostId,
    hostId.value,
    props.project.path,
    props.api.navigationProjectPage(hostId.value, props.project.path)?.loaded,
  ],
  () => {
    if (
      !collapsed.value && props.state.authenticated &&
      (hostId.value !== props.state.hostId || props.state.connected)
    )
      void props.api
        .loadNavigationProject(hostId.value, props.project.path)
        .catch((error: Error) => {
          if (hostId.value === props.state.hostId) emit("error", error.message);
        });
  },
  { immediate: true },
);
async function pin() {
  closeMenu(true);
  try {
    await props.api.pin(
      "project",
      props.project.path,
      props.project.name,
      hostId.value,
    );
  } catch (error: any) {
    emit("error", error.message);
  }
}
</script>
<template>
  <section class="nav-project-group" :data-host-id="hostId" :data-project-path="project.path">
    <div
      class="nav-project-header"
      :class="{ active: current }"
      @contextmenu.prevent="openMenu"
      @keydown="contextKey"
    >
      <button
        class="nav-fold icon-button"
        @click="toggle"
        :aria-label="`${collapsed ? '展开' : '折叠'}项目 ${project.name}`"
        :aria-expanded="!collapsed"
      >
        <Icon :name="collapsed ? 'ChevronRight' : 'ChevronDown'" :size="13" />
      </button>
      <button
        class="project-row"
        @click="emit('project', project)"
        :title="(project.rootPaths || [project.path]).join('\n')"
      >
        <Icon :name="current ? 'FolderOpen' : 'Folder'" :size="16" /><span>{{
          project.name || project.path.split("/").pop()
        }}</span
        ><small v-if="project.rootPaths?.length > 1">{{
          project.rootPaths.length
        }}</small
        ><span class="host-badge" :title="host?.hostname || host?.name">{{
          host?.name || "本机"
        }}</span>
      </button>
      <button
        class="nav-row-menu icon-button"
        @click="openMenu"
        :aria-label="`${project.name} 项目操作`"
        :aria-expanded="menu"
        aria-haspopup="menu"
        :aria-controls="menu ? menuId : undefined"
      >
        <Icon name="MoreHorizontal" :size="15" />
      </button>
    </div>
    <div v-if="!collapsed" class="nav-project-threads">
      <div v-if="project.rootPaths?.length > 1" class="project-roots">
        <button
          v-for="root in project.rootPaths"
          :key="root"
          @click="emit('project', { ...project, path: root })"
          :class="{
            active: state.hostId === hostId && state.projectPath === root,
          }"
          :title="root"
        >
          <Icon name="Folder" :size="12" />{{ root.split("/").pop() }}
        </button>
      </div>
      <ThreadRow
        v-for="thread in visibleThreads"
        :key="`${hostId}:${thread.id}`"
        :thread="thread"
        :state="state"
        :api="api"
        nested
        @select="emit('select', $event)"
        @error="emit('error', $event)"
      />
      <button
        v-if="threads.length > threadLimit"
        class="nav-load-more nav-overflow-toggle"
        :aria-expanded="expandedThreads"
        :disabled="loadingOlder"
        @click="expandedThreads = !expandedThreads"
      >
        <Icon :name="expandedThreads ? 'ChevronUp' : 'ChevronDown'" :size="12" />
        {{ expandedThreads ? "收起对话" : `显示另外 ${threads.length - threadLimit} 个对话` }}
      </button>
      <button
        v-if="hasOlderThreads && (expandedThreads || threads.length <= threadLimit)"
        class="nav-load-more"
        :disabled="loadingOlder"
        @click="loadOlderThreads"
      >
        {{ loadingOlder ? "正在加载…" : "加载项目旧对话" }}
      </button>
      <p v-if="!threads.length" class="nav-empty">暂无对话</p>
    </div>
  </section>
  <Teleport to="body">
    <div
      v-if="menu"
      :id="menuId"
      ref="menuElement"
      class="project-context-menu"
      role="menu"
      :aria-label="`${project.name} 项目菜单`"
      :style="{
        left: `${menuPosition.left}px`,
        top: `${menuPosition.top}px`,
        visibility: menuReady ? 'visible' : 'hidden',
      }"
      @contextmenu.prevent
    >
      <button role="menuitem" tabindex="-1" @click="pin">
        <Icon :name="starred ? 'PinOff' : 'Pin'" :size="17" />{{
          starred ? "取消置顶" : "置顶项目"
        }}
      </button>
      <button role="menuitem" tabindex="-1" @click="action('edit')">
        <Icon name="Settings2" :size="17" />编辑
      </button>
      <div role="separator" class="project-menu-separator" />
      <button role="menuitem" tabindex="-1" @click="action('files')">
        <Icon name="FolderOpen" :size="17" />在工作区文件中显示
      </button>
      <div role="separator" class="project-menu-separator" />
      <button role="menuitem" tabindex="-1" @click="action('archive')">
        <Icon name="Archive" :size="17" />归档聊天
      </button>
      <div role="separator" class="project-menu-separator" />
      <button role="menuitem" tabindex="-1" @click="action('remove')">
        <Icon name="X" :size="17" />移除项目
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.nav-overflow-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 30px;
}
.project-context-menu {
  position: fixed;
  z-index: 100;
  width: min(226px, calc(100vw - 16px));
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow:
    0 8px 30px #00000012,
    0 2px 7px #00000008;
}
.project-context-menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 35px;
  padding: 8px 9px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.project-context-menu button svg {
  flex-shrink: 0;
}
.project-context-menu button:hover,
.project-context-menu button:focus-visible {
  background: var(--hover);
  outline: none;
}
.project-menu-separator {
  height: 1px;
  margin: 5px 8px;
  background: var(--border);
}
@media (max-width: 760px) {
  .nav-overflow-toggle {
    min-height: 40px;
  }
  .project-context-menu button {
    min-height: 42px;
  }
}
</style>
