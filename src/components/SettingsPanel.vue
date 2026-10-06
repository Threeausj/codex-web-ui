<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { randomUUID } from "../lib/uuid";
import Icon from "./Icon.vue";
import ConnectionDialog from "./ConnectionDialog.vue";
import FolderPicker from "./FolderPicker.vue";
import PwaSettings from "./PwaSettings.vue";
import PasswordSettings from "./PasswordSettings.vue";
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
}>();
const emit = defineEmits<{ close: []; theme: [value: string] }>();
const section = ref(props.initialTab || "general");
const sections = [
  { id: "general", label: "通用", icon: "Settings2" },
  { id: "pwa", label: "应用与通知", icon: "Smartphone" },
  { id: "projects", label: "项目", icon: "Folder" },
  { id: "hosts", label: "连接", icon: "Globe" },
  { id: "permissions", label: "权限预设", icon: "Shield" },
  { id: "account", label: "账户", icon: "Bot" },
  { id: "integrations", label: "技能与集成", icon: "Package" },
  { id: "config", label: "配置", icon: "Code2" },
  { id: "shortcuts", label: "快捷键", icon: "Keyboard" },
];
const projectPath = ref("");
const projectName = ref("");
const projectRootPaths = ref("");
const projectHostId = ref(props.state.hostId || "local");
const folderPickerTarget = ref<"project" | "root" | null>(null);
const hostForm = ref(false);
const editingHost = ref<any>(null);
const saving = ref(false);
const error = ref("");
const success = ref("");
const configEdits = ref(
  '[\n  { "keyPath": "model", "value": "", "mergeStrategy": "replace" }\n]',
);
const loginUrl = ref("");
const apiKey = ref("");
const useApiKey = ref(false);
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
const requirements = computed(() => props.state.requirements || null);
const configLayers = computed(() => props.state.config?.layers || []);
const configOrigins = computed(() =>
  Object.entries(props.state.config?.origins || {}).map(([key, value]) => ({
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
  props.state.models?.find((model: any) => model.model === props.state.model),
);
const account = computed(
  () => props.state.account?.account || props.state.account,
);
const config = computed(
  () => props.state.config?.config || props.state.config || {},
);
const skillList = computed(() => {
  const skills = props.state.skills || [];
  const source = Array.isArray(skills) ? skills : skills.data || [];
  return source.flatMap((entry: any) => entry.skills || [entry]);
});
const appList = computed(() =>
  Array.isArray(props.state.apps)
    ? props.state.apps
    : props.state.apps?.data || [],
);
const mcpList = computed(() =>
  Array.isArray(props.state.mcpServers)
    ? props.state.mcpServers
    : props.state.mcpServers?.data || [],
);
const currentHosts = computed(() => props.state.hosts || []);
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
  if (!hosts.some((host: any) => host.id === projectHostId.value))
    projectHostId.value = hosts.some((host: any) => host.id === props.state.hostId)
      ? props.state.hostId
      : hosts[0]?.id || "local";
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
  { keys: "Enter", action: "发送消息" },
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
        props.state.config,
        requirements.value,
      );
      if (restriction) throw new Error(restriction);
    }
    await props.api.rpc("config/batchWrite", {
      edits,
      filePath: userLayer.value?.name.file,
      expectedVersion: userLayer.value?.version,
      reloadUserConfig: true,
    });
    await props.api.readConfig();
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
    if (!permissionProfileProblems(profile, requirements.value).length)
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
  const selectedHost = props.state.hostId;
  providerCapabilities.value = null;
  providerNotice.value = "";
  try {
    const result = await props.api.rpc(
      "modelProvider/capabilities/read",
      {},
      45000,
      { silentError: true },
    );
    if (
      selectedHost === props.state.hostId &&
      generation === providerGeneration
    )
      providerCapabilities.value = result;
  } catch (cause: any) {
    if (
      selectedHost === props.state.hostId &&
      generation === providerGeneration
    )
      providerNotice.value = cause.message || "此主机未报告提供方能力";
  }
}
async function loginAccount() {
  const result = await action(async () =>
    props.api.rpc(
      "account/login/start",
      useApiKey.value
        ? { type: "apiKey", apiKey: apiKey.value }
        : { type: "chatgpt" },
    ),
  );
  if (result?.authUrl) loginUrl.value = result.authUrl;
  if (result?.type === "apiKey") {
    apiKey.value = "";
    success.value = "API 密钥已保存到当前主机";
    await props.api.readConfig();
  }
}
async function logoutAccount() {
  await action(async () => {
    await props.api.rpc("account/logout", {});
    await props.api.readConfig();
  }, "已退出 Codex 账户");
}
onMounted(() => {
  if (props.state.connected) {
    void action(async () => {
      await props.api.readConfig();
      await props.api.loadIntegrations();
    });
    void loadProviderCapabilities();
  }
});
watch(
  () => props.state.hostId,
  () => {
    if (props.state.connected) void loadProviderCapabilities();
  },
);
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
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
          @click="emit('close')"
          aria-label="关闭设置"
        >
          <Icon name="X" />
        </button>
      </header>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置类别">
          <button
            v-for="entry in sections"
            :key="entry.id"
            :class="{ active: section === entry.id }"
            @click="section = entry.id"
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
          <template v-if="section === 'general'">
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
              <label class="form-label">主机
                <select
                  v-model="projectHostId"
                  class="text-input"
                  aria-label="项目主机"
                  :disabled="saving"
                >
                  <option v-for="host in currentHosts" :key="host.id" :value="host.id">
                    {{ host.name }}{{ host.kind === 'ssh' ? ' · 远程' : ' · 本机' }}
                  </option>
                </select>
              </label>
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
                <h4>来自这台主机的 SSH 连接</h4>
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
                  v-for="host in currentHosts.filter(
                    (host: any) => host.kind === 'ssh',
                  )"
                  :key="host.id"
                  class="connection-row"
                >
                  <span class="connection-symbol"
                    ><Icon name="Globe" :size="19"
                  /></span>
                  <div class="connection-details">
                    <strong>{{ host.name }}</strong>
                    <span>{{
                      `${host.username ? host.username + "@" : ""}${host.hostname}${host.port && host.port !== 22 ? ":" + host.port : ""}`
                    }}</span>
                  </div>
                  <span
                    v-if="state.hostId === host.id"
                    class="connection-current"
                    >当前</span
                  >
                  <div class="connection-actions">
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
                      class="icon-button"
                      @click="editHost(host)"
                      :disabled="saving"
                      :title="`编辑 ${host.name}`"
                      :aria-label="`编辑 ${host.name}`"
                    >
                      <Icon name="Pencil" :size="16" />
                    </button>
                    <button
                      class="icon-button"
                      @click="action(() => api.removeHost(host.id))"
                      :disabled="saving"
                      :title="`移除 ${host.name}`"
                      :aria-label="`移除 ${host.name}`"
                    >
                      <Icon name="Trash2" :size="16" />
                    </button>
                  </div>
                </div>
                <div
                  v-if="!currentHosts.some((host: any) => host.kind === 'ssh')"
                  class="connection-empty"
                >
                  添加 SSH 连接，在远端继续你的项目与对话。
                </div>
              </div>
              <div class="connection-local-heading">本地主机</div>
              <div class="connection-list">
                <div
                  v-for="host in currentHosts.filter(
                    (host: any) => host.kind !== 'ssh',
                  )"
                  :key="host.id"
                  class="connection-row"
                >
                  <span class="connection-symbol"
                    ><Icon name="Monitor" :size="19"
                  /></span>
                  <div class="connection-details">
                    <strong>{{ host.name }}</strong>
                    <span>运行 Web 服务的主机</span>
                  </div>
                  <span
                    v-if="state.hostId === host.id"
                    class="connection-current"
                    >当前</span
                  >
                  <button
                    v-else
                    class="icon-button"
                    @click="action(() => api.setHost(host.id))"
                    :disabled="saving"
                    :title="`连接 ${host.name}`"
                    :aria-label="`连接 ${host.name}`"
                  >
                    <Icon name="Link" :size="17" />
                  </button>
                </div>
              </div>
              <p class="connection-footnote">
                连接使用此主机的 SSH 配置、已有密钥与 known_hosts。
              </p>
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
                  v-if="state.activePermissionProfileId === profile.id"
                  class="status-pill"
                  >当前</span
                ><button
                  v-else
                  class="button button-small button-secondary"
                  :disabled="
                    saving ||
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
                v-for="profile in state.nativePermissionProfiles || []"
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
                v-if="!state.nativePermissionProfiles?.length"
                class="settings-empty"
              >
                此主机未报告原生权限预设。
              </p>
            </div>
          </template>
          <template v-else-if="section === 'account'">
            <h3>Codex 账户</h3>
            <p class="settings-description">
              所选主机的模型账户，与网页访问密码独立。
            </p>
            <div v-if="account" class="account-card">
              <div class="account-avatar"><Icon name="Bot" :size="24" /></div>
              <div>
                <strong>{{ account.email || account.type || "已登录" }}</strong
                ><span>{{
                  account.planType || account.plan || "当前主机账户"
                }}</span>
              </div>
              <button
                class="button button-small button-secondary"
                @click="logoutAccount"
                :disabled="saving"
              >
                退出账户
              </button>
            </div>
            <template v-else
              ><div class="setting-note">
                <Icon name="Bot" :size="22" />
                <p>登录 ChatGPT 账户，或使用 OpenAI API 密钥开始工作。</p>
              </div>
              <div class="segmented-control account-methods">
                <button
                  :class="{ active: !useApiKey }"
                  @click="useApiKey = false"
                >
                  ChatGPT</button
                ><button
                  :class="{ active: useApiKey }"
                  @click="useApiKey = true"
                >
                  API 密钥
                </button>
              </div>
              <label v-if="useApiKey" class="form-label"
                >API 密钥<input
                  v-model="apiKey"
                  class="text-input"
                  type="password"
                  placeholder="sk-…"
                  autocomplete="off" /></label
              ><button
                class="button button-primary"
                :disabled="
                  saving || !state.connected || (useApiKey && !apiKey.trim())
                "
                @click="loginAccount"
              >
                {{ useApiKey ? "保存 API 密钥" : "登录 ChatGPT"
                }}<Icon
                  v-if="saving"
                  name="LoaderCircle"
                  :size="15"
                  class="spin"
                /></button
              ><a
                v-if="loginUrl && /^https?:\/\//.test(loginUrl)"
                :href="loginUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="account-login-link"
                >继续在浏览器完成登录<Icon name="ExternalLink" :size="14" /></a
            ></template>
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
            <div class="settings-title-row">
              <h3>技能与集成</h3>
              <button
                class="icon-button"
                @click="action(() => api.loadIntegrations())"
                title="刷新集成"
                aria-label="刷新集成"
              >
                <Icon name="RefreshCw" :size="16" />
              </button>
            </div>
            <p class="settings-description">
              显示当前主机可用的技能、应用和 MCP 工具。
            </p>
            <div
              v-for="notice in state.integrationErrors || []"
              :key="notice.source"
              class="setting-note"
            >
              <Icon name="CircleHelp" :size="16" />
              <p>{{ notice.source }}：{{ notice.message }}</p>
            </div>
            <h4>
              技能 <span class="count-badge">{{ skillList.length }}</span>
            </h4>
            <div class="settings-list">
              <div
                v-for="(skill, index) in skillList"
                :key="skill.name || index"
                class="integration-row"
              >
                <Icon name="Sparkles" :size="18" />
                <div>
                  <strong>{{ skill.name || skill.displayName }}</strong>
                  <p>{{ skill.description || skill.shortDescription }}</p>
                  <code v-if="skill.path">{{ skill.path }}</code>
                </div>
                <span class="integration-status">{{
                  skill.enabled === false ? "已禁用" : "可用"
                }}</span>
              </div>
              <p v-if="!skillList.length" class="settings-empty">
                当前主机暂无可用技能。
              </p>
            </div>
            <h4>
              应用 <span class="count-badge">{{ appList.length }}</span>
            </h4>
            <div class="settings-list">
              <div
                v-for="(app, index) in appList"
                :key="app.id || index"
                class="integration-row"
              >
                <Icon name="Package" :size="18" />
                <div>
                  <strong>{{ app.name || app.id }}</strong>
                  <p>{{ app.description }}</p>
                </div>
                <span class="integration-status">{{
                  app.isAccessible === false ? "未连接" : "可用"
                }}</span>
              </div>
              <p v-if="!appList.length" class="settings-empty">
                当前主机暂无可用应用。
              </p>
            </div>
            <h4>
              MCP 服务器 <span class="count-badge">{{ mcpList.length }}</span>
            </h4>
            <div class="settings-list">
              <div
                v-for="(server, index) in mcpList"
                :key="server.name || index"
                class="integration-row"
              >
                <Icon name="Server" :size="18" />
                <div>
                  <strong>{{ server.name || server.id }}</strong>
                  <p>
                    {{ Object.keys(server.tools || {}).length }} 个工具 ·
                    {{ server.authStatus || server.status || "已配置" }}
                  </p>
                </div>
              </div>
              <p v-if="!mcpList.length" class="settings-empty">
                当前主机暂无 MCP 服务器。
              </p>
            </div>
          </template>
          <template v-else-if="section === 'config'">
            <div class="settings-title-row">
              <h3>同步配置</h3>
              <button
                class="icon-button"
                @click="
                  action(async () => {
                    await api.readConfig();
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
                  selectedModel?.displayName || state.model || "主机默认模型"
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
                :disabled="saving || !state.connected"
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
    gap: 10px;
    padding: 14px 12px;
  }
  .connection-actions .icon-button {
    width: 30px;
    height: 36px;
  }
  .connection-details > span {
    font-size: 11px;
  }
  .connection-current {
    display: none;
  }
}
</style>
