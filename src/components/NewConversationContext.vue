<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";

const props = defineProps<{ state: any; disabled?: boolean }>();
const emit = defineEmits<{
  project: [project: any];
  host: [hostId: string];
  manageProjects: [];
}>();
const projects = computed(() =>
  (props.state.projects || []).filter(
    (project: any) => (project.hostId || "local") === props.state.hostId,
  ),
);
const activeProject = computed(() =>
  projects.value.find(
    (project: any) =>
      project.path === props.state.projectPath ||
      project.rootPaths?.includes(props.state.projectPath),
  ),
);
const projectValue = computed(
  () => activeProject.value?.path || props.state.projectPath || "",
);
const directoryLabel = computed(
  () =>
    props.state.projectPath?.split("/").filter(Boolean).pop() ||
    props.state.projectPath ||
    "选择项目",
);
const host = computed(() =>
  (props.state.hosts || []).find((entry: any) => entry.id === props.state.hostId),
);
function chooseProject(event: Event) {
  const select = event.target as HTMLSelectElement;
  const chosen = select.value;
  select.value = projectValue.value;
  if (props.disabled || chosen === projectValue.value) return;
  const project = projects.value.find((entry: any) => entry.path === chosen);
  if (project) emit("project", project);
}
function chooseHost(event: Event) {
  const select = event.target as HTMLSelectElement;
  const chosen = select.value;
  select.value = props.state.hostId;
  if (props.disabled || chosen === props.state.hostId) return;
  if (props.state.hosts?.some((entry: any) => entry.id === chosen))
    emit("host", chosen);
}
</script>

<template>
  <div class="new-context" role="group" aria-label="新对话位置">
    <label class="context-choice project-choice" :title="state.projectPath">
      <Icon name="Folder" :size="16" />
      <select
        :value="projectValue"
        :disabled="disabled || !projects.length"
        aria-label="新对话项目"
        @change="chooseProject"
      >
        <option v-if="!activeProject" :value="projectValue">
          {{ directoryLabel }}{{ state.projectPath ? " · 当前目录" : "" }}
        </option>
        <option v-for="project in projects" :key="project.path" :value="project.path">
          {{ project.name || project.path.split("/").filter(Boolean).pop() || project.path }}
        </option>
      </select>
      <Icon v-if="projects.length" name="ChevronDown" :size="12" />
    </label>
    <label class="context-choice host-choice" :title="host?.name || state.hostId">
      <Icon :name="host?.kind === 'local' ? 'Monitor' : 'Globe'" :size="16" />
      <select
        :value="state.hostId"
        :disabled="disabled"
        aria-label="新对话主机"
        @change="chooseHost"
      >
        <option v-for="entry in state.hosts" :key="entry.id" :value="entry.id">
          {{ entry.kind === "local" ? "本地" : "远程" }} · {{ entry.name || entry.id }}
        </option>
      </select>
      <Icon name="ChevronDown" :size="12" />
    </label>
    <button
      v-if="!projects.length"
      class="context-add"
      :disabled="disabled"
      title="为当前主机添加项目"
      @click="emit('manageProjects')"
    >
      <Icon name="Plus" :size="14" /><span>添加项目</span>
    </button>
  </div>
</template>

<style scoped>
.new-context {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  margin: 0 9px -7px;
  padding: 7px 11px 13px;
  border: 1px solid var(--border);
  border-bottom: 0;
  border-radius: 15px 15px 0 0;
  background: var(--soft);
  color: var(--text);
}
.context-choice {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 52%;
  border-radius: 6px;
}
.context-choice > svg {
  flex: 0 0 auto;
  color: var(--muted);
  pointer-events: none;
}
.context-choice:focus-within {
  outline: 2px solid var(--green);
  outline-offset: 3px;
}
.context-choice select {
  width: 100%;
  min-width: 0;
  max-width: 270px;
  height: 29px;
  padding: 0;
  appearance: none;
  border: 0;
  outline: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-overflow: ellipsis;
  cursor: pointer;
  box-shadow: none;
}
.context-choice select:disabled {
  color: var(--muted);
  cursor: default;
}
.host-choice {
  max-width: 40%;
  color: var(--muted);
}
.context-choice option {
  background: var(--surface);
  color: var(--text);
}
.context-add {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 4px;
  margin-left: auto;
  padding: 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.context-add:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}
@media (max-width: 600px) {
  .new-context {
    flex-wrap: wrap;
    gap: 2px 12px;
    margin-inline: 7px;
    padding: 6px 10px 12px;
  }
  .context-choice {
    flex: 1 1 135px;
    max-width: 100%;
    gap: 5px;
  }
  .context-choice select {
    height: 34px;
    max-width: 100%;
    font-size: 13px;
  }
  .context-add {
    min-height: 34px;
  }
}
</style>
