<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import NewConversationContext from "./NewConversationContext.vue";
import {
  availablePermissionProfiles,
  permissionProfileProblems,
} from "../lib/configuration";
const props = defineProps<{ api: any; state: any; welcome?: boolean; contextBusy?: boolean }>();
const emit = defineEmits<{
  command: [command: string];
  error: [message: string];
  project: [project: any];
  host: [hostId: string];
}>();
const draft = ref("");
const input = ref<HTMLTextAreaElement>();
const fileInput = ref<HTMLInputElement>();
const dropping = ref(false);
const uploading = ref(false);
const submitting = ref(false);
const contextDisabled = computed(
  () => props.contextBusy || props.state.busy || props.state.switchingHost ||
    props.state.selectingThread || uploading.value || submitting.value,
);
const picker = ref<"commands" | "files" | "">("");
const query = ref("");
const selected = ref(0);
const searchPending = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const commands = [
  { id: "new", name: "/new", description: "开始新的对话", icon: "SquarePen" },
  {
    id: "compact",
    name: "/compact",
    description: "压缩当前上下文",
    icon: "RefreshCw",
  },
  {
    id: "fork",
    name: "/fork",
    description: "创建当前对话的分支",
    icon: "GitBranch",
  },
  {
    id: "review",
    name: "/review",
    description: "审查工作区中的代码变更",
    icon: "Eye",
  },
  {
    id: "terminal",
    name: "/terminal",
    description: "打开项目终端",
    icon: "Terminal",
  },
  {
    id: "settings",
    name: "/settings",
    description: "管理配置、项目和主机",
    icon: "Settings2",
  },
];
const matchingCommands = computed(() =>
  commands.filter((command) =>
    command.name.includes(query.value.toLowerCase()),
  ),
);
const files = computed(() => {
  const result = props.state.searchResults || [];
  return (
    Array.isArray(result)
      ? result
      : result.files || result.data || result.results || []
  ).slice(0, 12);
});
const results = computed(() =>
  picker.value === "commands" ? matchingCommands.value : files.value,
);
const selectedModel = computed(() =>
  (props.state.models || []).find(
    (model: any) =>
      model.model === props.state.model || model.id === props.state.model,
  ),
);
const effortLabels: Record<string, string> = {
  none: "无",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "超高",
};
const efforts = computed(
  () => selectedModel.value?.supportedReasoningEfforts || [],
);
const profiles = computed(() =>
  availablePermissionProfiles(props.state.preferences?.permissionProfiles),
);
const selectedPermission = computed(() =>
  props.state.activePermissionProfileId
    ? `profile:${props.state.activePermissionProfileId}`
    : props.state.runtimePolicy
      ? "resumed"
      : props.state.permission,
);
async function choosePermission(event: Event) {
  try {
    const value = (event.target as HTMLSelectElement).value;
    if (value === "resumed") return;
    if (value.startsWith("profile:"))
      await props.api.selectPermissionProfile(value.slice(8));
    else await props.api.setPermission(value);
  } catch (error: any) {
    emit("error", error.message);
  }
}
function basicPermissionBlocked(mode: string) {
  return (
    permissionProfileProblems(
      {
        id: "base",
        name: "基础权限",
        sandboxMode: mode as any,
        approvalPolicy: mode === "danger-full-access" ? "never" : "on-request",
        networkAccess: mode === "danger-full-access",
      },
      props.state.requirements,
    ).length > 0
  );
}
const permissionLabel = computed(
  () =>
    profiles.value.find(
      (profile) => profile.id === props.state.activePermissionProfileId,
    )?.name ||
    (
      {
        "read-only": "只读",
        "workspace-write": "默认权限",
        "danger-full-access": "完全访问",
      } as Record<string, string>
    )[props.state.permission] ||
    "默认权限",
);
const canSend = computed(
  () =>
    props.state.connected &&
    !props.state.selectingThread &&
    !props.state.switchingHost &&
    !props.contextBusy &&
    !submitting.value &&
    !uploading.value &&
    (draft.value.trim() || props.state.attachments?.length),
);
function resize() {
  if (input.value) {
    input.value.style.height = "auto";
    input.value.style.height = `${Math.min(input.value.scrollHeight, 210)}px`;
  }
}
function inspectInput() {
  resize();
  const before = draft.value.slice(
    0,
    input.value?.selectionStart ?? draft.value.length,
  );
  const commandMatch = before.match(/^\/([^\s]*)$/);
  const fileMatch = before.match(/(?:^|\s)@([^\s]*)$/);
  const nextPicker = commandMatch ? "commands" : fileMatch ? "files" : "";
  const nextQuery = commandMatch?.[1] ?? fileMatch?.[1] ?? "";
  if (picker.value !== nextPicker || query.value !== nextQuery)
    selected.value = 0;
  picker.value = nextPicker;
  query.value = nextQuery;
  if (searchTimer) clearTimeout(searchTimer);
  if (picker.value === "files") {
    searchPending.value = true;
    searchTimer = setTimeout(async () => {
      try {
        await props.api.searchFiles(query.value);
      } catch (cause: any) {
        emit("error", cause.message || "搜索文件失败");
      } finally {
        searchPending.value = false;
      }
    }, 180);
  }
}
async function pick(result: any) {
  if (!result) return;
  if (picker.value === "commands") {
    draft.value = "";
    picker.value = "";
    emit("command", result.id);
  } else {
    const position = input.value?.selectionStart ?? draft.value.length;
    const before = draft.value.slice(0, position);
    const match = before.match(/(?:^|\s)@([^\s]*)$/);
    const root = result.root || props.state.projectPath;
    const path = result.path?.startsWith("/")
      ? result.path
      : `${root?.replace(/\/$/, "")}/${result.path || result.file_name || result.name}`;
    const replaced = before.replace(
      /@[^\s]*$/,
      `@${path.includes(" ") ? JSON.stringify(path) : path} `,
    );
    draft.value = replaced + draft.value.slice(position);
    picker.value = "";
    await nextTick();
    input.value?.focus();
    input.value?.setSelectionRange(replaced.length, replaced.length);
  }
  await nextTick();
  resize();
}
function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (picker.value && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    const length = results.value.length;
    if (length)
      selected.value =
        (selected.value + (event.key === "ArrowDown" ? 1 : -1) + length) %
        length;
  } else if (
    picker.value &&
    (event.key === "Enter" || event.key === "Tab") &&
    results.value.length &&
    !event.shiftKey
  ) {
    event.preventDefault();
    void pick(results.value[selected.value]);
  } else if (event.key === "Escape" && picker.value) {
    event.preventDefault();
    picker.value = "";
  } else if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
}
async function send() {
  if (!canSend.value) return;
  const text = draft.value.trim();
  const submittedKey = draftKey.value;
  const submittedDraft = draft.value;
  const command = commands.find((command) => command.name === text);
  if (command) {
    emit("command", command.id);
    draft.value = "";
    resize();
    return;
  }
  submitting.value = true;
  try {
    await props.api.send(text);
    if (draftKey.value === submittedKey && draft.value !== submittedDraft) {
      if (draft.value) sessionStorage.setItem(submittedKey, draft.value);
    } else if (sessionStorage.getItem(submittedKey) === submittedDraft)
      sessionStorage.removeItem(submittedKey);
    if (draftKey.value === submittedKey && draft.value === submittedDraft) {
      draft.value = "";
      picker.value = "";
      await nextTick();
      resize();
    }
  } catch (cause: any) {
    emit("error", cause.message || "发送消息失败");
  } finally {
    submitting.value = false;
  }
}
async function upload(list: FileList | File[] | null) {
  if (!list?.length || props.contextBusy || props.state.switchingHost || props.state.selectingThread) return;
  uploading.value = true;
  try {
    await props.api.uploadFiles(list);
  } catch (cause: any) {
    emit("error", cause.message || "上传失败");
  } finally {
    uploading.value = false;
    if (fileInput.value) fileInput.value.value = "";
  }
}
function paste(event: ClipboardEvent) {
  const items = event.clipboardData?.files;
  if (items?.length) {
    event.preventDefault();
    void upload(items);
  }
}
function drop(event: DragEvent) {
  dropping.value = false;
  if (event.dataTransfer?.files.length) void upload(event.dataTransfer.files);
}
function insertAt() {
  draft.value += draft.value && !draft.value.endsWith(" ") ? " @" : "@";
  void nextTick(() => {
    input.value?.focus();
    inspectInput();
  });
}
const draftKey = computed(
  () =>
    `codex.draft.${props.state.hostId}.${props.state.activeThread?.id || props.state.projectPath || "new"}`,
);
function saveDraft(key: string, value: string) {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
  // Migrate drafts from versions that only kept them for the current window.
  sessionStorage.removeItem(key);
}
watch(
  draftKey,
  (key, previous) => {
    if (previous) saveDraft(previous, draft.value);
    draft.value = localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? "";
    saveDraft(key, draft.value);
    void nextTick(resize);
  },
  { immediate: true, flush: "sync" },
);
watch(draft, (value) => saveDraft(draftKey.value, value), { flush: "sync" });
function setDraft(text: string) {
  draft.value = text;
  void nextTick(() => {
    input.value?.focus();
    resize();
  });
}
watch(
  () => props.state.model,
  () => {
    if (
      selectedModel.value &&
      !efforts.value.some(
        (option: any) => option.reasoningEffort === props.state.effort,
      )
    )
      props.state.effort = selectedModel.value.defaultReasoningEffort;
  },
);
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});
defineExpose({ focus: () => input.value?.focus(), getDraft: () => draft.value, setDraft });
</script>

<template>
  <div class="composer-area" :class="{ 'welcome-composer': welcome }">
    <NewConversationContext
      v-if="!state.activeThread"
      :state="state"
      :disabled="contextDisabled"
      @project="emit('project', $event)"
      @host="emit('host', $event)"
      @manage-projects="emit('command', 'settings-projects')"
    />
    <div
      v-if="picker"
      class="composer-picker"
      role="listbox"
      :aria-label="picker === 'commands' ? '对话指令' : '项目文件'"
    >
      <div class="picker-label">
        {{ picker === "commands" ? "对话指令" : "引用文件"
        }}<span>↑ ↓ 选择 · ↵ 确认</span>
      </div>
      <button
        v-for="(result, index) in results"
        :key="result.id || result.path || index"
        :class="{ selected: index === selected }"
        role="option"
        :aria-selected="index === selected"
        @mousedown.prevent="pick(result)"
      >
        <Icon
          :name="picker === 'commands' ? result.icon : 'FileText'"
          :size="17"
        />
        <div>
          <strong>{{
            picker === "commands"
              ? result.name
              : result.file_name || result.path?.split("/").pop() || result.name
          }}</strong
          ><span>{{
            picker === "commands" ? result.description : result.path
          }}</span>
        </div>
        <Icon v-if="index === selected" name="CornerDownLeft" :size="14" />
      </button>
      <div v-if="!results.length" class="picker-empty">
        {{
          searchPending
            ? "正在搜索…"
            : picker === "files"
              ? "没有找到匹配的文件"
              : "没有匹配的指令"
        }}
      </div>
    </div>
    <div
      class="composer"
      :class="{ dropping, 'composer-disabled': !state.connected }"
      @dragover.prevent="dropping = true"
      @dragleave.prevent="dropping = false"
      @drop.prevent="drop"
    >
      <div v-if="dropping" class="drop-overlay">
        <Icon name="Paperclip" :size="24" /><strong
          >松开以上传文件或图片</strong
        >
      </div>
      <div v-if="state.attachments?.length" class="attachments">
        <div
          v-for="(attachment, index) in state.attachments"
          :key="attachment.id || index"
          class="attachment"
        >
          <img
            v-if="attachment.previewUrl || attachment.dataUrl"
            :src="attachment.previewUrl || attachment.dataUrl"
            :alt="attachment.name || '附件'"
          /><Icon
            v-else
            :name="
              attachment.type === 'localImage' ||
              attachment.mime?.startsWith('image/')
                ? 'Image'
                : 'FileText'
            "
            :size="18"
          />
          <div>
            <strong>{{
              attachment.name || attachment.path?.split("/").pop() || "附件"
            }}</strong
            ><span>{{
              attachment.size
                ? `${Math.max(1, Math.round(attachment.size / 1024))} KB`
                : "已添加"
            }}</span>
          </div>
          <button
            class="icon-button"
            :disabled="contextBusy || state.selectingThread || state.switchingHost || submitting"
            @click="api.removeAttachment(index)"
            title="移除附件"
            aria-label="移除附件"
          >
            <Icon name="X" :size="13" />
          </button>
        </div>
      </div>
      <textarea
        ref="input"
        v-model="draft"
        :placeholder="
          !state.connected
            ? '连接 Codex 后即可开始对话'
            : state.busy
              ? '追加指令，调整当前任务…'
              : welcome
                ? '描述一个任务，让 Codex 帮你完成'
                : '继续对话，或输入 / 查看指令、@ 引用文件'
        "
        rows="2"
        spellcheck="false"
        aria-label="消息输入框"
        @input="inspectInput"
        @click="inspectInput"
        @keydown="onKeydown"
        @paste="paste"
        :disabled="!state.connected || contextBusy"
      ></textarea>
      <div class="composer-toolbar">
        <div class="composer-tools">
          <input
            ref="fileInput"
            type="file"
            multiple
            class="sr-only"
            @change="upload(($event.target as HTMLInputElement).files)"
          /><button
            class="icon-button"
            :disabled="!state.connected || uploading || contextBusy || state.switchingHost || state.selectingThread"
            @click="fileInput?.click()"
            title="上传文件或图片"
            aria-label="上传文件或图片"
          >
            <Icon
              :name="uploading ? 'LoaderCircle' : 'Plus'"
              :size="19"
              :class="{ spin: uploading }"
            /></button
          ><button
            class="icon-button mention-button"
            :disabled="!state.connected || contextBusy || state.switchingHost || state.selectingThread"
            @click="insertAt"
            title="引用项目文件"
            aria-label="引用项目文件"
          >
            @</button
          ><span class="toolbar-separator"></span
          ><label
            class="composer-select model-select"
            :title="selectedModel?.description || '选择模型'"
            ><select
              v-model="state.model"
              aria-label="选择模型"
              :disabled="
                state.busy ||
                state.selectingThread ||
                state.switchingHost ||
                contextBusy ||
                !state.models?.length
              "
            >
              <option v-if="!state.models?.length" :value="state.model">
                {{ state.model || "加载模型…" }}
              </option>
              <option
                v-for="model in state.models.filter(
                  (entry: any) => !entry.hidden,
                )"
                :key="model.id || model.model"
                :value="model.model"
              >
                {{ model.displayName || model.model }}
              </option></select
            ><Icon name="ChevronDown" :size="12" /></label
          ><label
            v-if="efforts.length"
            class="composer-select effort-select"
            title="推理强度"
            ><select
              v-model="state.effort"
              aria-label="推理强度"
              :disabled="
                state.busy || state.selectingThread || state.switchingHost || contextBusy
              "
            >
              <option
                v-for="option in efforts"
                :key="option.reasoningEffort"
                :value="option.reasoningEffort"
              >
                {{
                  effortLabels[option.reasoningEffort] || option.reasoningEffort
                }}
              </option></select
            ><Icon name="ChevronDown" :size="12"
          /></label>
        </div>
        <div class="composer-submit">
          <label
            class="composer-select permission-select"
            :class="{
              'full-access': state.permission === 'danger-full-access',
            }"
            :title="permissionLabel"
            ><Icon
              :name="
                state.permission === 'danger-full-access'
                  ? 'Zap'
                  : state.permission === 'read-only'
                    ? 'Lock'
                    : 'Shield'
              "
              :size="13" /><select
              :value="selectedPermission"
              @change="choosePermission"
              aria-label="选择权限"
              :disabled="
                state.busy || state.selectingThread || state.switchingHost || contextBusy
              "
            >
              <option
                v-if="state.runtimePolicy && !state.activePermissionProfileId"
                value="resumed"
              >
                当前会话权限
              </option>
              <option
                value="read-only"
                :disabled="basicPermissionBlocked('read-only')"
              >
                只读
              </option>
              <option
                value="workspace-write"
                :disabled="basicPermissionBlocked('workspace-write')"
              >
                默认权限
              </option>
              <option
                value="danger-full-access"
                :disabled="basicPermissionBlocked('danger-full-access')"
              >
                完全访问
              </option>
              <optgroup v-if="profiles.length" label="命名权限预设">
                <option
                  v-for="profile in profiles"
                  :key="profile.id"
                  :value="`profile:${profile.id}`"
                  :disabled="
                    !!permissionProfileProblems(profile, state.requirements)
                      .length
                  "
                >
                  {{ profile.name }}
                </option>
              </optgroup></select
            ><Icon name="ChevronDown" :size="11" /></label
          ><button
            v-if="state.busy"
            class="send-button stop-button"
            @click="api.interrupt()"
            title="停止生成"
            aria-label="停止生成"
          >
            <span></span></button
          ><button
            v-if="!state.busy || canSend"
            class="send-button"
            :disabled="!canSend"
            @click="send"
            :title="state.busy ? '追加指令' : '发送消息'"
            :aria-label="state.busy ? '追加指令' : '发送消息'"
          >
            <Icon
              :name="submitting ? 'LoaderCircle' : 'ArrowUp'"
              :size="20"
              :class="{ spin: submitting }"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
