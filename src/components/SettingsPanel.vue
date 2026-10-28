<script setup lang="ts">
import { computed, defineAsyncComponent, reactive, ref, watch } from "vue";
import { randomUUID } from "../lib/uuid";
import Icon from "./Icon.vue";
import ConnectionDialog from "./ConnectionDialog.vue";
import FolderPicker from "./FolderPicker.vue";
import PwaSettings from "./PwaSettings.vue";
import PasswordSettings from "./PasswordSettings.vue";
import HostDiagnostics from "./HostDiagnostics.vue";
import IntegrationsSettings from "./IntegrationsSettings.vue";
import PerformanceSettings from "./PerformanceSettings.vue";
import CodexSettings from "./CodexSettings.vue";
import HostCodexUpdate from "./HostCodexUpdate.vue";
import ArchivedChatsPanel from "./ArchivedChatsPanel.vue";
import type { PromptPresetInput } from "../lib/prompt-presets";
const PromptPresetsPanel = defineAsyncComponent(() => import("./PromptPresetsPanel.vue"));
import {
  availablePermissionProfiles,
  configEditRestriction,
  configLayerLabel,
  describeApprovalPolicy,
  describeSandboxMode,
  isManagedConfigSource,
  permissionProfileProblems,
  validatePermissionProfile,
  type WebPermissionProfile,
} from "../lib/configuration";
const props = defineProps<{
  api: any;
  state: any;
  theme: string;
  initialTab?: string;
  currentDraft?: string;
}>();
const emit = defineEmits<{ close: []; theme: [value: string] }>();
const section = ref(props.initialTab || (props.state.hosts?.length ? "general" : "hosts"));
const settingsHostId = ref(props.state.hostId || props.state.hosts?.[0]?.id || "");
const codexSettingsBusy = ref(false);
const codexUpdateBusy = ref(false);
const presetsEditor = ref<InstanceType<typeof PromptPresetsPanel>>();
const presetsState = computed(() => props.api.promptPresets.state);
const presetCommands = [
  { id: "new", name: "/new", description: "新建对话" },
  { id: "compact", name: "/compact", description: "压缩上下文" },
  { id: "fork", name: "/fork", description: "创建分支" },
  { id: "review", name: "/review", description: "代码审查" },
  { id: "terminal", name: "/terminal", description: "打开终端" },
  { id: "settings", name: "/settings", description: "打开设置" },
];
function canLeave() { return section.value !== "presets" || presetsEditor.value?.canLeave() !== false; }
function closeSettings() { if (canLeave()) emit("close"); }
function changeSection(value: string) { if (value !== section.value && canLeave()) section.value = value; }
async function savePreset(value: PromptPresetInput) { try { await props.api.promptPresets.save(value); } catch {} }
async function removePreset(value: { slot: number; expectedVersion: number }) { try { await props.api.promptPresets.remove(value); } catch {} }
watch(section, value => { if (value === "presets") void props.api.promptPresets.refresh(); }, { immediate: true });
defineExpose({ close: closeSettings, working: computed(() => presetsEditor.value?.working || presetsState.value.busy || codexSettingsBusy.value || codexUpdateBusy.value) });
const sections = [
  { id: "general", label: "通用", icon: "Settings2" },
  { id: "performance", label: "性能", icon: "Zap" },
  { id: "pwa", label: "应用与通知", icon: "Smartphone" },
  { id: "projects", label: "项目", icon: "Folder" },
  { id: "archived", label: "已归档的聊天", icon: "Archive" },
  { id: "hosts", label: "连接", icon: "Globe" },
  { id: "presets", label: "提示词预设", icon: "ListChecks" },
  { id: "permissions", label: "权限预设", icon: "Shield" },
  { id: "codex", label: "Codex", icon: "Bot" },
  { id: "account", label: "账户", icon: "Lock" },
  { id: "integrations", label: "技能与集成", icon: "Package" },
  { id: "config", label: "配置", icon: "Code2" },
  { id: "shortcuts", label: "快捷键", icon: "Keyboard" },
];
const projectPath = ref("");
const projectName = ref("");
const projectRootPaths = ref("");
const projectHostId = ref(settingsHostId.value);
const folderPickerTarget = ref<"project" | "root" | null>(null);
const hostForm = ref(false);
const editingHost = ref<any>(null);
const saving = ref(false);
const settingsReading = ref(false);
let settingsReadGeneration = 0;
const error = ref("");
const success = ref("");
const configEdits = ref(
  '[\n  { "keyPath": "model", "value": "", "mergeStrategy": "replace" }\n]',
);
const profileForm = ref(false);
const editingProfileId = ref("");
const profileDraft = reactive<WebPermissionProfile>({
  id: "",
  name: "",
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
  networkAccess: false,
});
const permissionProfiles = computed(() =>
  availablePermissionProfiles(props.state.preferences?.permissionProfiles),
);
const hostSettings = computed(() => props.api.hostSettings(settingsHostId.value));
const settingsState = computed(() => hostSettings.value.state);
const settingsApi = computed(() => hostSettings.value.api);
const requirements = computed(() => settingsState.value.requirements || null);
const defaultPermission = computed(
  () => props.state.preferences?.defaultPermission || "workspace-write",
);
function defaultPermissionProblems(mode: string) {
  return permissionProfileProblems(
    {
      id: "global-default",
      name: "全局默认权限",
      sandboxMode: mode as WebPermissionProfile["sandboxMode"],
      approvalPolicy: mode === "danger-full-access" ? "never" : "on-request",
      networkAccess: mode === "danger-full-access",
    },
    requirements.value,
  );
}
async function chooseDefaultPermission(event: Event) {
  const select = event.target as HTMLSelectElement;
  await action(
    () => props.api.selectDefaultPermission(select.value),
    "全局默认权限已保存，从下一次发送生效",
  );
  select.value = defaultPermission.value;
}
const configLayers = computed(() => settingsState.value.config?.layers || []);
const configOrigins = computed(() =>
  Object.entries(settingsState.value.config?.origins || {}).map(([key, value]) => ({
    key,
    ...(value as any),
  })),
);
const userLayer = computed(() =>
  [...configLayers.value]
    .reverse()
    .find((layer: any) => layer.name.type === "user" && !layer.name.profile),
);
const providerCapabilities = ref<any>(null);
const providerNotice = ref("");
let providerGeneration = 0;
const selectedModel = computed(() =>
  settingsState.value.models?.find((model: any) => model.model === settingsState.value.model),
);
const config = computed(
  () => settingsState.value.config?.config || settingsState.value.config || {},
);
const currentHosts = computed(() => props.state.hosts || []);
const settingsHost = computed(() => currentHosts.value.find((host: any) => host.id === settingsHostId.value));
const globalSection = computed(() => ["general", "pwa", "account", "shortcuts", "hosts", "presets"].includes(section.value));
const projectHost = computed(() =>
  currentHosts.value.find((host: any) => host.id === projectHostId.value),
);
watch(projectHostId, () => {
  projectPath.value = "";
  projectRootPaths.value = "";
  folderPickerTarget.value = null;
  error.value = "";
  success.value = "";
});
watch(currentHosts, (hosts) => {
  if (!hosts.some((host: any) => host.id === settingsHostId.value)) settingsHostId.value = hosts[0]?.id || "";
  if (!hosts.some((host: any) => host.id === projectHostId.value))
    projectHostId.value = hosts.some((host: any) => host.id === props.state.hostId)
      ? props.state.hostId
      : hosts[0]?.id || "";
});
watch(settingsHostId, (value) => {
  projectHostId.value = value;
  error.value = "";
  success.value = "";
  profileForm.value = false;
  configEdits.value = '[\n  { "keyPath": "model", "value": "", "mergeStrategy": "replace" }\n]';
});
function selectedFolder(path: string) {
  if (folderPickerTarget.value === "project") projectPath.value = path;
  else if (folderPickerTarget.value === "root") {
    const roots = projectRootPaths.value.split("\n").map((root) => root.trim()).filter(Boolean);
    if (path !== projectPath.value.trim() && !roots.includes(path)) roots.push(path);
    projectRootPaths.value = roots.join("\n");
  }
  folderPickerTarget.value = null;
}
const shortcuts = [
  { keys: "⌘ / Ctrl + K", action: "打开命令面板" },
  { keys: "⌘ / Ctrl + Shift + O", action: "新建对话" },
  { keys: "⌘ / Ctrl + J", action: "打开终端" },
  { keys: "⌘ / Ctrl + B / I / E", action: "输入框：粗体／斜体／行内代码" },
  { keys: "⌘ / Ctrl + Shift + K", action: "输入框：插入／取消链接" },
  { keys: "Enter", action: "发送消息；列表中续写下一项，空项退出；代码块内换行" },
  { keys: "⌘ / Ctrl + Enter", action: "发送消息（包括列表或代码块）" },
  { keys: "Shift + Enter", action: "换行" },
  { keys: "/", action: "插入对话指令" },
  { keys: "@", action: "引用项目文件" },
  { keys: "Esc", action: "关闭面板" },
  { keys: "?", action: "查看快捷键（输入框外）" },
];
async function action(fn: () => Promise<any>, message?: string) {
  saving.value = true;
  error.value = "";
  success.value = "";
  try {
    const result = await fn();
    if (message) success.value = message;
    return result;
  } catch (cause: any) {
    error.value = cause.message || "操作失败";
  } finally {
    saving.value = false;
  }
}
async function addProject() {
  if (saving.value || !projectPath.value.trim() || !projectHost.value) return;
  await action(async () => {
    const roots = projectRootPaths.value
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    await props.api.addProject(
      projectPath.value.trim(),
      projectName.value.trim() || undefined,
      roots,
      projectHostId.value,
    );
    projectPath.value = "";
    projectName.value = "";
    projectRootPaths.value = "";
  }, "项目已添加");
}
function editHost(host?: any) {
  editingHost.value = host || null;
  error.value = "";
  success.value = "";
  hostForm.value = true;
}
function hostSaved() {
  success.value = editingHost.value ? "SSH 配置已更新" : "SSH 连接已添加";
  hostForm.value = false;
}
async function moveHost(hostId: string, offset: number) {
  if (saving.value) return;
  const ids = currentHosts.value.map((host: any) => host.id);
  const index = ids.indexOf(hostId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  await action(() => props.api.reorderHosts(ids), "主机顺序已保存");
}
async function saveEdits() {
  await action(async () => {
    const edits = JSON.parse(configEdits.value);
    if (
      !Array.isArray(edits) ||
      !edits.length ||
      edits.some(
        (edit: any) =>
          typeof edit.keyPath !== "string" ||
          !edit.keyPath ||
          !["replace", "upsert"].includes(edit.mergeStrategy) ||
          !("value" in edit),
      )
    )
      throw new Error(
        "请提供非空 edits 数组，每项包含 keyPath、value 和 mergeStrategy（replace 或 upsert）。",
      );
    for (const edit of edits) {
      const restriction = configEditRestriction(
        edit.keyPath,
        edit.value,
        settingsState.value.config,
        requirements.value,
      );
      if (restriction) throw new Error(restriction);
    }
    await settingsApi.value.rpc("config/batchWrite", {
      edits,
      filePath: userLayer.value?.name.file,
      expectedVersion: userLayer.value?.version,
      reloadUserConfig: true,
    });
    await settingsApi.value.readConfig();
  }, "配置已保存并重新读取");
}
function editProfile(profile?: WebPermissionProfile) {
  editingProfileId.value = profile?.id || "";
  Object.assign(
    profileDraft,
    profile || {
      id: `web-${randomUUID()}`,
      name: "",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: false,
    },
  );
  profileForm.value = true;
}
async function saveProfile() {
  await action(async () => {
    const profile = {
      ...profileDraft,
      name: profileDraft.name.trim(),
      networkAccess:
        profileDraft.sandboxMode === "danger-full-access"
          ? true
          : profileDraft.networkAccess,
    };
    const problems = validatePermissionProfile(profile);
    if (problems.length) throw new Error(problems.join("；"));
    const profiles = permissionProfiles.value.filter(
      (value) => value.id !== editingProfileId.value,
    );
    profiles.push(profile);
    await props.api.updatePreferences({ permissionProfiles: profiles });
    // Saving is allowed even if this host forbids selection, so the preset remains usable on another host.
    if (settingsHostId.value === props.state.hostId && !permissionProfileProblems(profile, requirements.value).length)
      await props.api.selectPermissionProfile(profile.id);
    profileForm.value = false;
  }, "权限预设已保存到 Web 服务");
}
async function deleteProfile(profile: WebPermissionProfile) {
  await action(async () => {
    if (props.state.activePermissionProfileId === profile.id)
      await props.api.setPermission(props.state.permission);
    await props.api.updatePreferences({
      permissionProfiles: permissionProfiles.value.filter(
        (value) => value.id !== profile.id,
      ),
    });
  }, "权限预设已删除");
}
async function loadProviderCapabilities() {
  const generation = ++providerGeneration;
  const selectedHost = settingsHostId.value;
  providerCapabilities.value = null;
  providerNotice.value = "";
  try {
    const result = await settingsApi.value.rpc(
      "modelProvider/capabilities/read",
      {},
      45000,
      { silentError: true },
    );
    if (
      selectedHost === settingsHostId.value &&
      generation === providerGeneration
    )
      providerCapabilities.value = result;
  } catch (cause: any) {
    if (
      selectedHost === settingsHostId.value &&
      generation === providerGeneration
    )
      providerNotice.value = cause.message || "此主机未报告提供方能力";
  }
}
watch(() => [settingsHostId.value, section.value], () => {
  const readGeneration = ++settingsReadGeneration;
  ++providerGeneration;
  providerCapabilities.value = null;
  providerNotice.value = "";
  if (settingsHost.value && ["general", "config", "permissions", "integrations"].includes(section.value)) {
    settingsReading.value = true;
    const api = settingsApi.value;
    void api.readConfig().catch((cause: any) => {
      if (readGeneration === settingsReadGeneration) error.value = cause.message || "无法读取所选主机的设置";
    }).finally(() => {
      if (readGeneration === settingsReadGeneration) settingsReading.value = false;
    });
    if (section.value === "config") void loadProviderCapabilities();
  } else settingsReading.value = false;
}, { immediate: true });
</script>

<template>
  <div class="modal-backdrop" @click.self="closeSettings">
    <section
      class="settings-modal"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
    >
      <header class="modal-header">
        <h2>设置</h2>
        <button
          class="icon-button"
          @click="closeSettings"
          aria-label="关闭设置"
        >
          <Icon name="X" />
        </button>
      </header>
      <div class="settings-host-bar">
        <label for="settings-host-select"><Icon name="Server" :size="16" /><span>设置主机</span></label>
        <select id="settings-host-select" v-model="settingsHostId" class="text-input" aria-label="设置主机" :disabled="!currentHosts.length || saving || codexSettingsBusy || codexUpdateBusy || !!state.runtimeReconnectingHostId">
          <option v-if="!currentHosts.length" value="">尚未添加执行主机</option>
          <option v-for="host in currentHosts" :key="host.id" :value="host.id">{{ host.name }}{{ host.kind === 'ssh' ? ' · 远程' : ' · 本机' }}</option>
        </select>
        <span v-if="globalSection" class="settings-host-scope">此栏目适用于整个 Web 应用</span>
      </div>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置类别">
          <button
            v-for="entry in sections"
            :key="entry.id"
            :class="{ active: section === entry.id }"
            @click="changeSection(entry.id)"
          >
            <Icon :name="entry.icon" :size="16" /><span>{{ entry.label }}</span>
          </button>
        </nav>
        <div class="settings-content">
          <div v-if="error" class="panel-error">
            <Icon name="AlertCircle" :size="16" />{{ error }}
          </div>
          <div v-if="success" class="settings-success">
            <Icon name="CheckCircle2" :size="16" />{{ success }}
          </div>
          <div v-if="!settingsHost && !globalSection" class="connection-empty">
            <p>先添加 SSH 连接，或在连接设置中启用本机 Codex。</p>
            <button class="button button-secondary" @click="section = 'hosts'">打开连接设置</button>
          </div>
          <PromptPresetsPanel v-else-if="section === 'presets'" ref="presetsEditor" embedded
            :snapshot="presetsState.snapshot" :loading="presetsState.loading" :busy="presetsState.busy"
            :error="presetsState.error" :current-draft="currentDraft || ''" :supported-commands="presetCommands"
            @refresh="api.promptPresets.refresh(true)" @save="savePreset" @remove="removePreset" />
          <template v-else-if="section === 'general'">
            <h3>按你的方式工作</h3>
            <p class="settings-description">
              网页权限预设和导航偏好保存到 Web 服务，Codex 配置与所选主机同步。
            </p>
            <div class="setting-row">
              <div><strong>外观</strong><span>让工作区融入你的环境</span></div>
              <select
                class="text-input compact-select"
                :value="theme"
                @change="
                  emit('theme', ($event.target as HTMLSelectElement).value)
                "
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </div>
            <div class="setting-row">
              <div>
                <strong>全局默认权限</strong>
                <span>新建和打开对话时使用此权限；可在对话中单独调整。修改后从下一轮任务生效，正在运行的任务保持原权限。</span>
              </div>
              <select
                class="text-input compact-select"
                :value="defaultPermission"
                aria-label="全局默认权限"
                :disabled="saving || settingsReading || state.selectingThread || state.switchingHost || state.changingContext"
                @change="chooseDefaultPermission"
              >
                <option value="read-only" :disabled="!!defaultPermissionProblems('read-only').length">只读</option>
                <option value="workspace-write" :disabled="!!defaultPermissionProblems('workspace-write').length">默认</option>
                <option value="danger-full-access" :disabled="!!defaultPermissionProblems('danger-full-access').length">完全访问</option>
              </select>
            </div>
            <p v-if="defaultPermissionProblems(defaultPermission).length" class="settings-description">
              {{ defaultPermissionProblems(defaultPermission).join('；') }}。请选择当前主机允许的权限。
            </p>
            <div class="setting-row">
              <div>
                <strong>自动压缩上下文</strong
                ><span>达到使用阈值后，自动整理对话上下文</span>
              </div>
              <button
                class="toggle"
                :class="{ on: state.autoCompact }"
                role="switch"
                :aria-checked="!!state.autoCompact"
                :disabled="saving"
                @click="
                  action(() =>
                    api.setAutoCompact(
                      !state.autoCompact,
                      state.compactThreshold,
                    ),
                  )
                "
              >
                <span></span>
              </button>
            </div>
            <div v-if="state.autoCompact" class="setting-row">
              <div>
                <strong>压缩阈值</strong><span>模型上下文窗口使用比例</span>
              </div>
              <select
                class="text-input compact-select"
                :value="state.compactThreshold || 85"
                @change="
                  action(() =>
                    api.setAutoCompact(
                      true,
                      Number(($event.target as HTMLSelectElement).value),
                    ),
                  )
                "
              >
                <option :value="60">60%</option>
                <option :value="75">75%</option>
                <option :value="85">85%</option>
                <option :value="90">90%</option>
                <option :value="95">95%</option>
              </select>
            </div>
            <div class="setting-note">
              <Icon name="RefreshCw" :size="17" />
              <p>
                同一 Codex 数据目录共享历史；连接同一个 daemon
                才能加入活动对话。网页审批由首个提交结果的客户端处理。
              </p>
            </div>
          </template>
          <PwaSettings v-else-if="section === 'pwa'" :api="api" :state="state" />
          <PerformanceSettings v-else-if="section === 'performance'" :api="api" :state="state" :host-id="settingsHostId" :maintenance-busy="codexUpdateBusy" />
          <template v-else-if="section === 'projects'">
            <h3>项目</h3>
            <p class="settings-description">
              加载项目目录、历史对话与项目级 Codex 配置。
            </p>
            <div class="settings-list">
              <div
                v-for="project in state.projects"
                :key="project.hostId + project.path"
                class="settings-list-row"
              >
                <Icon name="Folder" :size="20" />
                <div>
                  <strong>{{
                    project.name || project.path.split("/").pop()
                  }}</strong
                  ><code>{{ project.path }}</code
                  ><span>{{
                      currentHosts.find(
                        (host: any) => host.id === project.hostId,
                      )?.name || project.hostId
                    }}</span
                  >
                </div>
                <button
                  class="button button-small button-secondary"
                  @click="
                    action(async () => {
                      if (project.hostId && project.hostId !== state.hostId)
                        await api.setHost(project.hostId);
                      await api.setProject(project.path);
                    })
                  "
                  :disabled="saving"
                >
                  打开
                </button>
              </div>
              <div v-if="!state.projects?.length" class="settings-empty">
                还没有项目，添加一个工作目录。
              </div>
            </div>
            <form class="settings-form" @submit.prevent="addProject">
              <h4>添加项目</h4>
              <label class="form-label"
                >项目路径<div class="project-path-row"><input
                  v-model="projectPath"
                  class="text-input"
                  aria-label="项目路径"
                  placeholder="/home/user/project"
                  :disabled="saving"
                  required /><button
                  type="button"
                  class="button button-secondary"
                  aria-label="浏览项目文件夹"
                  :disabled="saving || !projectHost"
                  @click="folderPickerTarget = 'project'"
                ><Icon name="FolderOpen" :size="16" />浏览</button></div></label
              ><label class="form-label"
                >显示名称<span class="optional">可选</span
                ><input
                  v-model="projectName"
                  class="text-input"
                  :disabled="saving"
                  placeholder="我的项目" /></label
              ><label class="form-label"
                >其他工作目录<span class="optional"
                  >可选 · 每行一个绝对路径</span
                ><textarea
                  v-model="projectRootPaths"
                  class="text-input project-root-input"
                  rows="3"
                  placeholder="/home/user/shared"
                  aria-label="其他工作目录"
                  :disabled="saving"
                ></textarea><button
                  type="button"
                  class="button button-small button-secondary project-root-browse"
                  :disabled="saving || !projectHost"
                  @click="folderPickerTarget = 'root'"
                ><Icon name="Plus" :size="14" />选择其他工作目录</button></label
              ><button
                type="submit"
                class="button button-primary"
                :disabled="saving || !projectPath.trim()"
              >
                <Icon name="Plus" :size="15" />添加项目</button
              ><span class="form-help"
                >路径属于所选主机：{{ projectHost?.name || "本机" }}</span
              >
            </form>
          </template>
          <template v-else-if="section === 'hosts'">
            <div class="connections-page">
              <h3>连接</h3>
              <div class="connection-section-heading">
                <div><h4>执行主机</h4><p>调整顺序后，侧边栏「最近」的设备筛选同步更新。</p></div>
                <button
                  class="button button-primary button-small"
                  :disabled="saving"
                  @click="editHost()"
                  aria-label="添加 SSH 连接"
                >
                  添加
                </button>
              </div>
              <div class="connection-list">
                <div
                  v-for="(host, index) in currentHosts"
                  :key="host.id"
                  class="connection-row"
                  :data-connection-id="host.id"
                  :data-host-id="host.id"
                >
                  <span class="connection-symbol"
                    ><Icon :name="host.kind === 'ssh' ? 'Globe' : 'Monitor'" :size="19"
                  /></span>
                  <div class="connection-details">
                    <strong>{{ host.name }}</strong>
                    <span v-if="host.kind === 'ssh'">{{
                      `${host.username ? host.username + "@" : ""}${host.hostname}${host.port && host.port !== 22 ? ":" + host.port : ""}`
                    }}</span>
                    <span v-else>本机 Codex 执行节点 · 可停用，Web 服务继续运行</span>
                  </div>
                  <span
                    v-if="state.hostId === host.id"
                    class="connection-current"
                    >当前</span
                  >
                  <div class="connection-actions">
                    <button class="icon-button" :disabled="saving || codexSettingsBusy || codexUpdateBusy"
                      @click="settingsHostId = host.id; section = 'performance'"
                      :title="`更新并重启 ${host.name} 的 Codex`" :aria-label="`更新并重启 ${host.name} 的 Codex`">
                      <Icon name="Download" :size="16" />
                    </button>
                    <div class="connection-order-actions" role="group" :aria-label="`调整 ${host.name} 的顺序`">
                      <button class="icon-button" :disabled="saving || index === 0"
                        @click="moveHost(host.id, -1)" :title="`上移 ${host.name}`" :aria-label="`上移 ${host.name}`">
                        <Icon name="ArrowUp" :size="16" />
                      </button>
                      <button class="icon-button" :disabled="saving || index === currentHosts.length - 1"
                        @click="moveHost(host.id, 1)" :title="`下移 ${host.name}`" :aria-label="`下移 ${host.name}`">
                        <Icon name="ArrowDown" :size="16" />
                      </button>
                    </div>
                    <button
                      v-if="state.hostId !== host.id"
                      class="icon-button"
                      @click="action(() => api.setHost(host.id))"
                      :disabled="saving"
                      :title="`连接 ${host.name}`"
                      :aria-label="`连接 ${host.name}`"
                    >
                      <Icon name="Link" :size="17" />
                    </button>
                    <button
                      v-if="host.kind === 'ssh'"
                      class="icon-button"
                      @click="editHost(host)"
                      :disabled="saving"
                      :title="`编辑 ${host.name}`"
                      :aria-label="`编辑 ${host.name}`"
                    >
                      <Icon name="Pencil" :size="16" />
                    </button>
                    <button
                      v-if="host.kind === 'ssh'"
                      class="icon-button"
                      @click="action(() => api.removeHost(host.id))"
                      :disabled="saving"
                      :title="`移除 ${host.name}`"
                      :aria-label="`移除 ${host.name}`"
                    >
                      <Icon name="Trash2" :size="16" />
                    </button>
                    <button v-else class="button button-secondary button-small"
                      :disabled="saving" @click="action(() => api.setLocalEnabled(false))"
                      aria-label="停用本机 Codex">停用</button>
                  </div>
                </div>
                <div
                  v-if="!currentHosts.length"
                  class="connection-empty"
                >
                  添加 SSH 连接，在远端继续你的项目与对话。
                </div>
              </div>
              <div v-if="state.localEnabled === false" class="connection-local-heading">本地主机</div>
              <div v-if="state.localEnabled === false" class="connection-list">
                <div class="connection-row">
                  <span class="connection-symbol"><Icon name="Monitor" :size="19" /></span>
                  <div class="connection-details"><strong>本机 Codex 已停用</strong><span>仅部署 Web 服务；本机项目与对话记录保留</span></div>
                  <button class="button button-secondary button-small" :disabled="saving"
                    @click="action(() => api.setLocalEnabled(true))" aria-label="启用本机 Codex">启用</button>
                </div>
              </div>
              <p class="connection-footnote">
                连接使用此主机的 SSH 配置、已有密钥与 known_hosts。
              </p>
              <HostDiagnostics v-if="settingsHost" :api="api" :host-id="settingsHostId" :host-name="settingsHost?.name" />
            </div>
          </template>
          <template v-else-if="section === 'permissions'">
            <div class="settings-title-row">
              <h3>权限预设</h3>
              <button
                class="button button-small button-secondary"
                @click="editProfile()"
              >
                <Icon name="Plus" :size="14" />新建预设
              </button>
            </div>
            <p class="settings-description">
              给常用沙箱、审批和网络设置命名。Web
              预设跨设备保存，每次发送按官方协议应用，不修改桌面的命名权限配置。
            </p>
            <p v-if="settingsHostId !== state.hostId" class="form-help">按所选主机检查权限策略；要在当前对话使用预设，请先切换到该主机的对话。</p>
            <div class="settings-list">
              <div
                v-for="profile in permissionProfiles"
                :key="profile.id"
                class="settings-list-row"
              >
                <Icon name="Shield" :size="20" />
                <div>
                  <strong>{{ profile.name }}</strong
                  ><span
                    >{{ describeSandboxMode(profile.sandboxMode) }} ·
                    {{ describeApprovalPolicy(profile.approvalPolicy) }} ·
                    {{ profile.networkAccess ? "允许网络" : "限制网络" }}</span
                  ><span
                    v-if="
                      permissionProfileProblems(profile, requirements).length
                    "
                    >{{
                      permissionProfileProblems(profile, requirements).join(
                        "；",
                      )
                    }}</span
                  >
                </div>
                <span
                  v-if="settingsHostId === state.hostId && state.activePermissionProfileId === profile.id"
                  class="status-pill"
                  >当前</span
                ><button
                  v-else
                  class="button button-small button-secondary"
                  :disabled="
                    saving || settingsReading || settingsHostId !== state.hostId ||
                    !!permissionProfileProblems(profile, requirements).length
                  "
                  @click="
                    action(
                      () => api.selectPermissionProfile(profile.id),
                      '已选择权限预设',
                    )
                  "
                >
                  使用</button
                ><button
                  class="icon-button"
                  :aria-label="'编辑权限预设 ' + profile.name"
                  @click="editProfile(profile)"
                >
                  <Icon name="Pencil" :size="15" /></button
                ><button
                  class="icon-button"
                  :aria-label="'删除权限预设 ' + profile.name"
                  :disabled="saving"
                  @click="deleteProfile(profile)"
                >
                  <Icon name="Trash2" :size="15" />
                </button>
              </div>
              <p v-if="!permissionProfiles.length" class="settings-empty">
                暂无 Web 权限预设。可使用聊天输入框的基础权限，或新建预设。
              </p>
            </div>
            <form
              v-if="profileForm"
              class="settings-form"
              @submit.prevent="saveProfile"
            >
              <h4>{{ editingProfileId ? "编辑权限预设" : "新建权限预设" }}</h4>
              <label class="form-label"
                >预设名称<input
                  v-model="profileDraft.name"
                  class="text-input"
                  maxlength="60"
                  required
                  placeholder="例如：只读联网研究"
              /></label>
              <div class="form-grid">
                <label class="form-label"
                  >沙箱权限<select
                    v-model="profileDraft.sandboxMode"
                    class="text-input"
                    aria-label="沙箱权限"
                  >
                    <option value="read-only">只读</option>
                    <option value="workspace-write">工作区写入</option>
                    <option value="danger-full-access">完全访问</option>
                  </select></label
                ><label class="form-label"
                  >审批策略<select
                    v-model="profileDraft.approvalPolicy"
                    class="text-input"
                    aria-label="审批策略"
                  >
                    <option value="untrusted">不可信命令先审批</option>
                    <option value="on-request">由 Codex 请求审批</option>
                    <option value="never">不询问审批</option>
                  </select></label
                >
              </div>
              <div class="setting-row">
                <div>
                  <strong>网络访问</strong
                  ><span>{{
                    profileDraft.sandboxMode === "danger-full-access"
                      ? "完全访问模式始终允许网络"
                      : "允许沙箱内的网络请求"
                  }}</span>
                </div>
                <button
                  type="button"
                  class="toggle"
                  aria-label="预设网络访问"
                  :class="{
                    on:
                      profileDraft.networkAccess ||
                      profileDraft.sandboxMode === 'danger-full-access',
                  }"
                  role="switch"
                  :aria-checked="
                    profileDraft.networkAccess ||
                    profileDraft.sandboxMode === 'danger-full-access'
                  "
                  :disabled="profileDraft.sandboxMode === 'danger-full-access'"
                  @click="
                    profileDraft.networkAccess = !profileDraft.networkAccess
                  "
                >
                  <span></span>
                </button>
              </div>
              <div class="form-actions">
                <button
                  type="button"
                  class="button button-secondary"
                  @click="profileForm = false"
                >
                  取消</button
                ><button
                  type="submit"
                  class="button button-primary"
                  :disabled="saving || !profileDraft.name.trim()"
                >
                  保存预设
                </button>
              </div>
            </form>
            <h4>主机原生权限预设</h4>
            <p class="form-help">
              以下条目由 permissionProfile/list
              读取，用于了解当前主机配置及管理策略。Web 自定义预设与其分别保存。
            </p>
            <div class="settings-list">
              <div
                v-for="profile in settingsState.nativePermissionProfiles || []"
                :key="profile.id"
                class="integration-row"
              >
                <Icon name="Shield" :size="18" />
                <div>
                  <strong>{{ profile.id }}</strong>
                  <p>{{ profile.description }}</p>
                </div>
                <span class="integration-status">{{
                  profile.allowed ? "主机允许" : "策略禁止"
                }}</span>
              </div>
              <p
                v-if="!settingsState.nativePermissionProfiles?.length"
                class="settings-empty"
              >
                此主机未报告原生权限预设。
              </p>
            </div>
          </template>
          <ArchivedChatsPanel v-else-if="section === 'archived'" :api="api" :state="state" :host-id="settingsHostId" />
          <CodexSettings v-else-if="section === 'codex'" :api="api" :state="state" :host-id="settingsHostId" @busy="codexSettingsBusy = $event" />
          <template v-else-if="section === 'account'">
            <h3>网页账户</h3>
            <p class="settings-description">管理此 Web 应用的访问密码与登录。主机的模型账户可在 Codex 中切换。</p>
            <div class="setting-row">
              <div>
                <strong>网页访问</strong
                ><span>{{
                  state.authRequired
                    ? "使用访问密码验证，网页保持登录 30 天"
                    : "当前服务未要求访问密码"
                }}</span>
              </div>
              <button
                v-if="state.authRequired"
                class="button button-small button-secondary"
                :disabled="saving"
                @click="action(() => api.logout())"
              >
                退出网页
              </button>
            </div>
            <PasswordSettings v-if="state.authRequired" :api="api" :state="state" />
          </template>
          <template v-else-if="section === 'integrations'">
            <IntegrationsSettings :key="settingsHostId" :api="settingsApi" :state="settingsState" />
          </template>
          <template v-else-if="section === 'config'">
            <div class="settings-title-row">
              <h3>同步配置</h3>
              <button
                class="icon-button"
                @click="
                  action(async () => {
                    await settingsApi.readConfig();
                    await loadProviderCapabilities();
                  })
                "
                title="重新读取配置"
                aria-label="重新读取配置"
              >
                <Icon name="RefreshCw" :size="16" />
              </button>
            </div>
            <p class="settings-description">
              App Server
              返回当前项目的有效配置、来源与管理限制。写入用户配置时校验版本，避免覆盖其他客户端的修改。
            </p>
            <h4>模型与提供方</h4>
            <div class="setting-row">
              <div>
                <strong>{{
                  selectedModel?.displayName || settingsState.model || "主机默认模型"
                }}</strong
                ><span
                  >{{ config.model_provider || "默认提供方" }} · 输入：{{
                    selectedModel?.inputModalities?.join(" / ") || "目录未报告"
                  }}</span
                ><span
                  >推理强度：{{
                    selectedModel?.supportedReasoningEfforts
                      ?.map((option: any) => option.reasoningEffort)
                      .join(" / ") || "目录未报告"
                  }}</span
                >
              </div>
            </div>
            <div v-if="providerCapabilities" class="setting-note">
              <Icon name="Bot" :size="17" />
              <p>
                当前提供方声明：联网搜索{{
                  providerCapabilities.webSearch ? "支持" : "不支持"
                }}，图像生成{{
                  providerCapabilities.imageGeneration ? "支持" : "不支持"
                }}，命名空间工具{{
                  providerCapabilities.namespaceTools ? "支持" : "不支持"
                }}。模型目录和能力声明不代表账户已获得访问权限。
              </p>
            </div>
            <div v-else-if="providerNotice" class="setting-note">
              <Icon name="CircleHelp" :size="17" />
              <p>{{ providerNotice }}</p>
            </div>
            <h4>配置来源</h4>
            <div class="settings-list">
              <div
                v-for="(layer, index) in configLayers"
                :key="index"
                class="integration-row"
              >
                <Icon
                  :name="
                    isManagedConfigSource(layer.name) ? 'Lock' : 'FileText'
                  "
                  :size="18"
                />
                <div>
                  <strong>{{ configLayerLabel(layer.name) }}</strong
                  ><code>{{ layer.version }}</code>
                  <p v-if="layer.disabledReason">
                    未启用：{{ layer.disabledReason }}
                  </p>
                </div>
                <span class="integration-status">{{
                  layer.disabledReason
                    ? "未启用"
                    : isManagedConfigSource(layer.name)
                      ? "管理员维护"
                      : "已加载"
                }}</span>
              </div>
              <p v-if="!configLayers.length" class="settings-empty">
                主机未返回配置层。
              </p>
            </div>
            <details class="config-details">
              <summary>查看每项配置的生效来源</summary>
              <div
                v-for="origin in configOrigins"
                :key="origin.key"
                class="setting-row"
              >
                <div>
                  <strong>{{ origin.key }}</strong
                  ><span>{{ configLayerLabel(origin.name) }}</span
                  ><code>{{ origin.version }}</code>
                </div>
              </div>
              <p v-if="!configOrigins.length" class="settings-empty">
                暂无来源元数据。
              </p>
            </details>
            <h4>管理策略</h4>
            <div class="setting-note">
              <Icon :name="requirements ? 'Lock' : 'Shield'" :size="17" />
              <p>
                {{
                  requirements
                    ? "当前主机存在受管限制；管理员来源与策略限制的配置无法由网页覆盖。App Server 会再次验证每次配置写入和对话请求。"
                    : "主机未报告 requirements 管理限制。权限仍由 App Server 与运行主机执行。"
                }}
              </p>
            </div>
            <details v-if="requirements" class="config-details">
              <summary>查看 configRequirements/read 返回的策略（只读）</summary>
              <pre>{{ JSON.stringify(requirements, null, 2) }}</pre>
            </details>
            <details class="config-details">
              <summary>查看已加载配置</summary>
              <pre>{{ JSON.stringify(config, null, 2) }}</pre>
            </details>
            <form class="settings-form" @submit.prevent="saveEdits">
              <h4>编辑用户配置项</h4>
              <p class="form-help">
                输入 config/batchWrite 的 edits 数组，按路径替换或合并。{{
                  userLayer?.name.file || "写入当前主机的用户 config.toml"
                }}。模型与推理强度默认值影响后续对话，不会自动改写正在运行的任务。
              </p>
              <textarea
                v-model="configEdits"
                class="config-editor"
                spellcheck="false"
                aria-label="配置修改数组"
              ></textarea
              ><button
                class="button button-primary"
                type="submit"
                :disabled="saving || settingsReading || !settingsState.connected || settingsState.runtimePaused || !settingsState.config"
              >
                <Icon
                  :name="saving ? 'LoaderCircle' : 'Save'"
                  :size="15"
                  :class="{ spin: saving }"
                />保存到主机
              </button>
            </form>
          </template>
          <template v-else
            ><h3>快捷键</h3>
            <p class="settings-description">把注意力留在工作上。</p>
            <div class="shortcut-list">
              <div v-for="shortcut in shortcuts" :key="shortcut.keys">
                <span>{{ shortcut.action }}</span
                ><kbd>{{ shortcut.keys }}</kbd>
              </div>
            </div></template
          >
          <HostCodexUpdate v-if="settingsHost" v-show="['performance', 'codex', 'hosts'].includes(section)"
            :api="api" :state="state" :host-id="settingsHostId"
            :disabled="saving || codexSettingsBusy || !!state.runtimeReconnectingHostId"
            @busy="codexUpdateBusy = $event" />
        </div>
      </div>
    </section>
    <ConnectionDialog
      v-if="hostForm"
      :api="api"
      :host="editingHost"
      @close="hostForm = false"
      @saved="hostSaved"
    />
    <FolderPicker
      v-if="folderPickerTarget && projectHost"
      :api="api"
      :host-id="projectHostId"
      :host-name="projectHost.name"
      :initial-path="projectPath.trim() || undefined"
      @close="folderPickerTarget = null"
      @selected="selectedFolder"
    />
  </div>
</template>

<style scoped>
.settings-host-bar { display:flex; align-items:center; gap:12px; padding:12px 22px; border-bottom:1px solid var(--border); flex-shrink:0; }
.settings-host-bar label { display:flex; align-items:center; gap:7px; color:var(--muted); font-size:11px; flex-shrink:0; }
.settings-host-bar .text-input { width:210px; min-width:0; min-height:32px; font-size:12px; padding:7px 10px; }
.settings-host-scope { font-size:10px; color:var(--muted); margin-left:auto; overflow-wrap:anywhere; }
@media(max-width:760px) { .settings-host-bar { padding:11px 19px; gap:10px; flex-wrap:wrap; } .settings-host-bar label { font-size:12px; } .settings-host-bar .text-input { width:auto; flex:1; font-size:14px; min-height:38px; } .settings-host-scope { flex-basis:100%; margin:0; font-size:11px; } }
.project-path-row { display: flex; align-items: center; gap: 8px; margin-top: 7px; }
.project-path-row .text-input { min-width: 0; flex: 1; margin-top: 0; }
.project-path-row .button { flex-shrink: 0; min-height: 38px; }
.project-root-browse { margin-top: 8px; }
.connections-page > h3 {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.5px;
  margin-bottom: 36px;
}
.connection-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.connection-section-heading h4 {
  font-size: 13px;
  font-weight: 500;
}
.connection-section-heading p {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
}
.connection-section-heading .button {
  border-radius: 999px;
  min-height: 30px;
  padding: 5px 13px;
  font-size: 12px;
}
.connection-list {
  border: 1px solid var(--border);
  border-radius: 13px;
  overflow: hidden;
}
.connection-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 76px;
  padding: 16px;
}
.connection-row + .connection-row {
  border-top: 1px solid var(--border);
}
.connection-symbol {
  display: flex;
  color: var(--muted);
  flex-shrink: 0;
}
.connection-details {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
  min-width: 0;
}
.connection-details strong {
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.connection-details > span {
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.connection-actions {
  display: flex;
  flex-shrink: 0;
  gap: 1px;
}
.connection-actions .icon-button {
  width: 28px;
  height: 30px;
}
.connection-order-actions {
  display: flex;
  gap: 1px;
  padding-right: 5px;
  margin-right: 4px;
  border-right: 1px solid var(--border);
}
.connection-order-actions .icon-button:disabled {
  opacity: 0.3;
  cursor: default;
}
.connection-current {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.connection-local-heading {
  margin: 28px 0 12px;
  font-size: 12px;
  color: var(--muted);
}
.connection-empty {
  padding: 28px 20px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.connection-footnote {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
  margin-top: 18px;
}
@media (max-width: 760px) {
  .project-path-row .text-input, select[aria-label="项目主机"] { font-size: 16px; }
  .project-path-row .button { min-height: 42px; }
  .connections-page > h3 {
    font-size: 20px;
    margin-bottom: 26px;
  }
  .connection-section-heading {
    gap: 10px;
  }
  .connection-section-heading h4 {
    font-size: 12px;
  }
  .connection-row {
    display: grid;
    grid-template-columns: 19px minmax(0, 1fr);
    gap: 10px;
    padding: 14px 12px;
  }
  .connection-actions { grid-column: 2; justify-content: flex-end; }
  .connection-row > .button { grid-column: 2; justify-self: end; }
  .connection-actions .icon-button {
    width: 38px;
    height: 38px;
  }
  .connection-details > span {
    font-size: 11px;
  }
  .connection-current {
    display: none;
  }
}
</style>
