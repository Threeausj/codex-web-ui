<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import Icon from "./Icon.vue";
import NewConversationContext from "./NewConversationContext.vue";
import MessageQueuePanel from "./MessageQueuePanel.vue";
import ModelServiceOptions from "./ModelServiceOptions.vue";
import MarkdownComposerEditor from "./MarkdownComposerEditor.vue";
import { clipboardFiles, uniqueClipboardFiles } from "../lib/clipboard";
import { browserStorage } from "../lib/browser-storage";
import { contextUsage } from "../lib/context-usage";
import { composerMarkdownPreview } from "../lib/composer-markdown";
import { continueMarkdown, formatMarkdown, isMarkdownCodeAt, type MarkdownEdit, type MarkdownFormat } from "../lib/markdown-editing";
import { insertPromptPreset } from "../lib/prompt-presets";
import type { PromptPreset } from "../../shared/prompt-presets";
import { conversationSelectionKey, normalizeConversationSelection, type ConversationSelectionSource } from "../lib/conversation-selection";
import {
  availablePermissionProfiles,
  permissionProfileProblems,
} from "../lib/configuration";
const props = defineProps<{ api: any; state: any; welcome?: boolean; contextBusy?: boolean }>();
const emit = defineEmits<{
  command: [command: string];
  error: [message: string];
  project: [project: any];
  noProject: [];
  host: [hostId: string];
  search: [];
}>();
const draft = ref("");
const markdownPreview = ref(false);
const previewElement = ref<HTMLElement>();
let editingSelection = { start: 0, end: 0 };
const renderedDraft = computed(() => markdownPreview.value
  ? composerMarkdownPreview(draft.value, props.state.hostId, props.state.activeThread?.cwd || props.state.projectPath || '/')
  : null);
const draftStorageWarning = ref(false);
const quotedContexts = ref<ConversationSelectionSource[]>([]);
const input = ref<InstanceType<typeof MarkdownComposerEditor>>();
const area = ref<HTMLElement>();
const pickerElement = ref<HTMLElement>();
const pickerMaxHeight = ref(400);
const fileInput = ref<HTMLInputElement>();
const dropping = ref(false);
const uploadCount = ref(0);
const uploading = computed(() => uploadCount.value > 0);
let uploadContextGeneration = 0;
watch(() => [props.state.hostId, props.state.projectPath, props.state.activeThread?.id], () => { ++uploadContextGeneration; }, { flush: "sync" });
const submitting = ref(false);
const submittedDuringCompaction = ref(false);
const stopProtected = ref(false);
let stopGuardUntil = 0;
let stopGuardTimer: ReturnType<typeof setTimeout> | undefined;
const delivery = ref<"immediate" | "queue">("immediate");
const queue = computed(() => props.api.messageQueue);
watch(() => [props.state.hostId, props.state.activeThread?.id], () => { delivery.value = "immediate"; });
watch(() => props.state.busy, (busy, previous) => { if (!busy && previous && !submitting.value) delivery.value = "immediate"; });
const sendLabel = computed(() => delivery.value === "queue" ? "加入下一轮队列" : props.state.busy ? "追加指令" : "发送消息");
const hasContent = computed(() => !!(draft.value.trim() || quotedContexts.value.length ||
  props.state.attachments?.length || props.state.selectedSkills?.length));
const showStop = computed(() => props.state.busy && !hasContent.value && !submitting.value);
const primaryLabel = computed(() => showStop.value ? "停止生成" : submitting.value && submittedDuringCompaction.value ? "压缩结束后发送" : sendLabel.value);
function protectStop() {
  stopGuardUntil = Date.now() + 600;
  stopProtected.value = true;
  clearTimeout(stopGuardTimer);
  stopGuardTimer = setTimeout(() => { stopProtected.value = false; }, 600);
}
async function primaryAction(event: MouseEvent) {
  if (!showStop.value) { await send(); return; }
  // A double tap still lands on the same single action. Keyboard activation
  // is deliberate and does not need the short pointer protection.
  if (event.detail > 0 && Date.now() < stopGuardUntil) return;
  try { await props.api.interrupt(); }
  catch (cause: any) { emit("error", cause.message || "停止失败"); }
}
let pendingDraftSubmission: {
  key: string; hostId: string; projectPath: string; threadId?: string; targetKey?: string;
} | undefined;
const contextDisabled = computed(
  () => props.contextBusy || props.state.busy || props.state.switchingHost ||
    props.state.selectingThread || props.state.modeBusy || uploading.value || submitting.value,
);
const modelSettingsError = ref("");
let modelChoiceGeneration = 0;
const modelControlsDisabled = computed(() => !!(props.contextBusy || !props.state.connected || props.state.switchingHost ||
  props.state.selectingThread || props.state.threadReleased || props.state.threadConflict || props.state.runtimePaused ||
  (props.state.activeThread && props.state.threadReady === false) || props.state.modeBusy || props.state.modelSettingsBusy || uploading.value || submitting.value ||
  queue.value?.state.restoring || queue.value?.state.loading || queue.value?.state.mutating || queue.value?.state.uncertain));
async function chooseModelSetting(event: Event, kind: 'model' | 'effort') {
  const element = event.target as HTMLSelectElement;
  modelSettingsError.value = "";
  const generation = modelChoiceGeneration;
  try { await (kind === 'model' ? props.api.setModel(element.value) : props.api.setReasoningEffort(element.value)); }
  catch (cause: any) { if (generation === modelChoiceGeneration) modelSettingsError.value = cause.message || '无法更新模型设置'; }
  finally { element.value = kind === 'model' ? props.state.model : props.state.effort; }
}
watch([() => props.state.hostId, () => props.state.activeThread?.id, () => props.state.projectPath, () => props.state.authenticationGeneration, () => props.state.connected, () => props.state.selectingThread],
  () => { ++modelChoiceGeneration; modelSettingsError.value = ""; });
const pickerDisabled = computed(() => !!(props.contextBusy || props.state.switchingHost ||
  props.state.selectingThread || props.state.modeBusy || uploading.value || submitting.value));
const picker = ref<"commands" | "mentions" | "">("");
const query = ref("");
const commandScope = ref(false);
const selected = ref(0);
const searchPending = ref(false);
const choosing = ref(false);
const pickerError = ref("");
let pickerGeneration = 0;
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
  { id: "presets", name: "/presets", description: "管理 10 个提示词和命令预设", icon: "ListChecks" },
];
const presetsState = computed(() => props.api.promptPresets.state);
const presetCommands = commands.filter(command => command.id !== "presets");
function openPresets() {
  if (props.state.authenticated && !pickerDisabled.value) emit("command", "presets");
}
function presetCommand(preset: PromptPreset) {
  return presetCommands.find(command => command.name === preset.content.trim());
}
function usePreset(preset: PromptPreset, position = input.value?.selectionStart ?? draft.value.length) {
  if (pickerDisabled.value || !preset.content.trim()) return;
  if (preset.kind === "command") {
    const command = presetCommand(preset);
    if (!command) { pickerError.value = "当前网页尚不支持此命令，请在设置中编辑预设。"; return; }
    if (!props.state.connected) { pickerError.value = "请连接主机后执行命令。"; return; }
    if (["compact", "fork"].includes(command.id) && !props.state.activeThread) {
      pickerError.value = "请先选择一个对话。";
      return;
    }
    if (command.id === "compact" && props.state.busy) {
      pickerError.value = "请等待当前任务完成后执行此命令。";
      return;
    }
    removePickerToken("/", position);
    emit("command", command.id);
    return;
  }
  const before = draft.value.slice(0, position).replace(/\/[^\s]*$/, "");
  const remaining = before + draft.value.slice(position);
  const inserted = insertPromptPreset(remaining, preset.content, before.length);
  draft.value = inserted.text;
  picker.value = "";
  markdownPreview.value = false;
  void nextTick(() => {
    input.value?.focus(); input.value?.setSelectionRange(inserted.position, inserted.position); resize();
  });
}
const matchingPresets = computed(() => presetsState.value.snapshot.presets
  .filter((preset: PromptPreset) => preset.content &&
    (!query.value || String(preset.slot) === query.value || preset.name.toLowerCase().includes(query.value.toLowerCase())))
  .map((preset: PromptPreset) => ({ kind: "preset", id: `preset:${preset.slot}`, name: `/${preset.slot} · ${preset.name}`,
    description: preset.kind === "command" ? presetCommand(preset) ? `命令 ${preset.content}` : "此命令当前不支持，请到设置修改" : preset.content.replace(/\s+/g, " ").slice(0, 140),
    icon: "ListChecks", preset, disabled: preset.kind === "command" && !presetCommand(preset) })));
const matchingCommands = computed(() => commands
  .filter((command) => commandScope.value && command.name.includes(query.value.toLowerCase()))
  .map((command) => ({ ...command, kind: "command" })));
const matchingSkills = computed(() => (props.state.skills || [])
  .filter((skill: any) => skill.enabled !== false && skill.path && skill.name)
  .filter((skill: any) => `${skill.name} ${skill.interface?.displayName || ""} ${skill.interface?.shortDescription || skill.shortDescription || ""} ${skill.description || ""}`
    .toLowerCase().includes(query.value.toLowerCase()))
  .map((skill: any) => ({ kind: "skill", id: `skill:${skill.path}`, name: `/${skill.name}`,
    description: skill.interface?.shortDescription || skill.shortDescription || skill.description || skill.path, icon: "Sparkles", skill })));
const modes = computed(() => [
  { kind: "mode", id: "default", name: "默认模式", description: "直接执行任务", icon: "Command", disabled: !!props.state.busy },
  { kind: "mode", id: "plan", name: "Plan 模式", description: props.state.modeCapabilities?.plan
    ? "先制定计划，确认后实施" : props.state.modeCapabilities?.loaded ? "当前 Codex 版本未提供 Plan 模式" : "正在检测当前 Codex 的 Plan 模式…", icon: "ListTodo",
    disabled: !!props.state.busy || !props.state.modeCapabilities?.plan },
  { kind: "mode", id: "goal", name: "Goal 模式", description: props.state.modeCapabilities?.goal
    ? "设定目标并持续推进，直到完成" : props.state.modeCapabilities?.loaded ? "当前 Codex 版本未提供 Goal 模式" : "正在检测当前 Codex 的 Goal 模式…", icon: "CheckCircle2",
    disabled: !!props.state.busy || !props.state.modeCapabilities?.goal },
].filter((mode) => `${mode.name} ${mode.id}`.toLowerCase().includes(query.value.toLowerCase())));
const pickerFiles = ref<any[]>([]);
const files = computed(() => pickerFiles.value.slice(0, 12).map((file: any) => ({ ...file, kind: "file" })));
const results = computed<any[]>(() =>
  picker.value === "commands" ? [...matchingCommands.value, ...matchingPresets.value, ...matchingSkills.value] : [...modes.value, ...files.value],
);
const conversationMode = computed(() => props.state.goalMode ? "goal" : props.state.collaborationMode === "plan" ? "plan" : "default");
const modeLabel = computed(() => conversationMode.value === "goal" ? "Goal 模式" : "Plan 模式");
const modeDisabled = computed(() => !!(pickerDisabled.value || props.state.busy || !props.state.connected || choosing.value));
const goalBusy = ref(false);
const goalActionsDisabled = computed(() => !!(goalBusy.value || submitting.value || props.contextBusy || props.state.modeBusy || props.state.selectingThread || props.state.switchingHost || choosing.value || !props.state.connected));
const goalStatusLabels: Record<string, string> = {
  active: "执行中", paused: "已暂停", blocked: "等待处理", complete: "已完成",
  completed: "已完成", budget_limit_reached: "已达到预算", budgetLimited: "已达到预算", usageLimited: "已达到用量限制",
};
const goalStatus = computed(() => goalStatusLabels[props.state.goal?.status] || props.state.goal?.status || "待开始");
const goalBudgetDraft = ref("");
const goalBudgetValue = computed(() => goalBudgetDraft.value.trim() ? Number(goalBudgetDraft.value) : null);
const goalBudgetInvalid = computed(() => goalBudgetValue.value !== null &&
  (!Number.isSafeInteger(goalBudgetValue.value) || goalBudgetValue.value <= 0));
const goalBudgetChanged = computed(() => goalBudgetValue.value !== (props.state.goal?.tokenBudget ?? null));
watch([() => props.state.goal?.threadId, () => props.state.goal?.tokenBudget, () => props.state.goalTokenBudget], () => {
  const value = props.state.goal ? props.state.goal.tokenBudget : props.state.goalTokenBudget;
  goalBudgetDraft.value = String(value ?? "");
}, { immediate: true });
function inputGoalBudget(event: Event) {
  goalBudgetDraft.value = (event.target as HTMLInputElement).value;
  if (!props.state.goal) props.state.goalTokenBudget = goalBudgetValue.value;
}
async function saveGoalBudget() {
  if (goalBudgetInvalid.value) { emit("error", "Token 预算应为正整数，留空表示不限"); return; }
  goalBusy.value = true;
  try { await props.api.setGoalBudget(goalBudgetValue.value); }
  catch (cause: any) { emit("error", cause.message || "保存目标预算失败"); }
  finally { goalBusy.value = false; }
}
async function goalAction(action: "pauseGoal" | "resumeGoal" | "clearGoal") {
  goalBusy.value = true;
  try { await props.api[action](); }
  catch (cause: any) { emit("error", cause.message || "更新目标失败"); }
  finally { goalBusy.value = false; }
}
async function resetMode() {
  choosing.value = true;
  try { await props.api.setConversationMode("default"); }
  catch (cause: any) { emit("error", cause.message || "切换模式失败"); }
  finally { choosing.value = false; }
}
async function reloadSkills() {
  pickerError.value = "";
  try {
    await Promise.all([props.api.loadSkills({ forceReload: true }), props.api.promptPresets.refresh(true)]);
    if (props.api.promptPresets.state.error) pickerError.value = props.api.promptPresets.state.error;
  }
  catch (cause: any) { pickerError.value = cause.message || "加载技能失败"; }
}
const selectedModel = computed(() =>
  (props.state.models || []).find(
    (model: any) =>
      model.model === props.state.model || model.id === props.state.model,
  ),
);
const effortLabels: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
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
    : props.state.runtimePolicy && props.state.runtimePolicy.source !== 'web'
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
const context = computed(() => contextUsage(props.state.tokenUsage));
const contextLabel = computed(() => props.state.compacting ? "正在压缩" : context.value
  ? `上下文 ${context.value.percent}%`
  : props.state.activeThread ? "上下文 —" : "上下文 0%");
const contextTitle = computed(() => {
  const details = context.value
    ? `${context.value.used.toLocaleString()} / ${context.value.limit.toLocaleString()} tokens（当前上下文）`
    : props.state.activeThread ? "Codex 尚未报告当前上下文用量" : "新对话尚未使用上下文";
  return `${details}\n点击查看上下文用量与压缩选项`;
});
const compactDisabledReason = computed(() => {
  if (!props.state.activeThread) return "先开始一个对话，再压缩上下文";
  if (props.state.compacting) return "正在压缩上下文，请稍候";
  if (props.state.busy) return "任务结束后可压缩上下文";
  if (props.state.online === false || !props.state.connected) return "工作站未连接，请先恢复连接";
  if (props.state.threadConflict) return "请先处理会话连接冲突";
  if (props.state.runtimePaused || props.state.threadReleased) return "请先恢复当前会话连接";
  if (props.state.threadReady === false || props.state.selectingThread || props.state.switchingHost || props.contextBusy)
    return "会话加载中，请稍候";
  if (props.state.editingMessage) return "请先完成消息编辑";
  if (props.state.modeBusy) return "正在切换对话模式，请稍候";
  if (uploading.value) return "文件上传完成后可压缩上下文";
  if (submitting.value) return "消息提交完成后可压缩上下文";
  return "";
});
const compactDisabled = computed(() => !!compactDisabledReason.value);
const contextMenuOpen = ref(false);
const contextButton = ref<HTMLButtonElement>();
const contextMenu = ref<HTMLElement>();
const contextMenuId = `context-usage-${useId()}`;
const contextMenuPosition = ref({ left: '0px', bottom: '0px', maxHeight: '400px', width: '280px' });
function tokenCount(value: number) {
  if (value < 1000) return value.toLocaleString();
  const scale = value >= 1_000_000 ? 1_000_000 : 1000;
  return `${Number((value / scale).toFixed(1))}${scale === 1000 ? 'k' : 'm'}`;
}
function positionContextMenu() {
  if (!contextMenuOpen.value || !contextButton.value) return;
  const bounds = contextButton.value.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const height = viewport?.height || window.innerHeight;
  const width = Math.min(280, (viewport?.width || window.innerWidth) - 24);
  const menuHeight = Math.min((contextMenu.value?.scrollHeight || 238) + 2, Math.max(1, height - 24));
  const bottom = Math.max(top + menuHeight + 12, Math.min(bounds.top - 8, top + height - 12));
  contextMenuPosition.value = {
    left: `${Math.max(left + 12, Math.min(bounds.right - width, left + (viewport?.width || window.innerWidth) - width - 12))}px`,
    bottom: `${window.innerHeight - bottom}px`,
    maxHeight: `${Math.max(1, bottom - top - 12)}px`,
    width: `${width}px`,
  };
}
function closeContextMenu(restoreFocus = false) {
  contextMenuOpen.value = false;
  if (restoreFocus) contextButton.value?.focus({ preventScroll: true });
}
function contextOutside(event: Event) {
  if (!contextMenuOpen.value || contextMenu.value?.contains(event.target as Node) ||
      contextButton.value?.contains(event.target as Node)) return;
  closeContextMenu();
}
function contextKey(event: KeyboardEvent) {
  if (contextMenuOpen.value && event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); closeContextMenu(true);
  }
}
function requestCompaction() {
  if (compactDisabled.value) return;
  closeContextMenu(); emit('command', 'compact');
}
async function clickContext() {
  if (contextMenuOpen.value) { closeContextMenu(); return; }
  contextMenuOpen.value = true;
  positionContextMenu();
  await nextTick();
  if (contextMenuOpen.value) {
    positionContextMenu();
    contextMenu.value?.focus({ preventScroll: true });
  }
}
watch([() => props.state.hostId, () => props.state.projectPath, () => props.state.activeThread?.id,
  () => props.state.authenticationGeneration, () => props.state.authenticated], () => closeContextMenu(), { flush: 'sync' });
watch([contextLabel, compactDisabledReason, delivery], () => { void nextTick(positionContextMenu); });
const canSend = computed(
  () =>
    !props.state.threadConflict &&
    !queue.value?.state.uncertain &&
    (delivery.value !== "queue" || props.state.compacting && queue.value?.state.status === 'supported' || queue.value?.canMutate.value) &&
    (!props.state.activeThread || props.state.threadReady !== false) &&
    !props.state.runtimePaused &&
    props.state.connected &&
    !props.state.selectingThread &&
    !props.state.switchingHost &&
    !props.state.modeBusy &&
    !props.state.modelSettingsBusy &&
    !(props.state.goalMode && goalBudgetInvalid.value) &&
    !props.contextBusy &&
    !submitting.value &&
    !uploading.value &&
    hasContent.value,
);
function resize() {
  input.value?.resize();
}
function draftSelection() {
  return { start: input.value?.selectionStart ?? draft.value.length, end: input.value?.selectionEnd ?? draft.value.length };
}
function applyMarkdownEdit(edit: MarkdownEdit) {
  if (!edit.handled || !input.value) return false;
  const previous = draft.value;
  let from = 0, tail = 0;
  while (from < previous.length && from < edit.text.length && previous[from] === edit.text[from]) from++;
  while (tail < previous.length - from && tail < edit.text.length - from &&
      previous[previous.length - tail - 1] === edit.text[edit.text.length - tail - 1]) tail++;
  input.value.replaceSelection(from, previous.length - tail, edit.text.slice(from, edit.text.length - tail), edit.selection);
  inspectInput();
  return true;
}
function markdownEnter() {
  const selection = draftSelection();
  const continued = continueMarkdown(draft.value, selection);
  if (applyMarkdownEdit(continued)) return true;
  if (!isMarkdownCodeAt(draft.value, selection.start)) return false;
  const text = draft.value.slice(0, selection.start) + '\n' + draft.value.slice(selection.end);
  return applyMarkdownEdit({ text, selection: { start: selection.start + 1, end: selection.start + 1 }, handled: true });
}
function onBeforeInput(event: InputEvent) {
  if (event.isComposing || input.value?.composing || !event.cancelable || event.inputType !== 'insertParagraph') return;
  if (picker.value) { event.preventDefault(); return; }
  event.preventDefault();
  if (!markdownEnter()) void send();
}
function editDraft() {
  markdownPreview.value = false;
  void nextTick(() => {
    resize();
    input.value?.focus({ preventScroll: true });
    input.value?.setSelectionRange(Math.min(editingSelection.start, draft.value.length), Math.min(editingSelection.end, draft.value.length));
  });
}
function focusInput() {
  markdownPreview.value = false;
  void nextTick(() => { resize(); input.value?.focus({ preventScroll: true }); });
}
function toggleMarkdownPreview() {
  if (markdownPreview.value) { editDraft(); return; }
  if (!draft.value.trim()) return;
  editingSelection = { start: input.value?.selectionStart ?? draft.value.length, end: input.value?.selectionEnd ?? draft.value.length };
  picker.value = "";
  pickerError.value = "";
  searchPending.value = false;
  ++pickerGeneration;
  if (searchTimer) clearTimeout(searchTimer);
  closeContextMenu();
  markdownPreview.value = true;
  void nextTick(() => previewElement.value?.focus({ preventScroll: true }));
}
watch([() => props.state.hostId, () => props.state.projectPath, () => props.state.activeThread?.id,
  () => props.state.authenticationGeneration, () => props.state.authenticated], () => {
  markdownPreview.value = false;
  picker.value = "";
  pickerFiles.value = [];
  pickerError.value = "";
  searchPending.value = false;
  ++pickerGeneration;
  if (searchTimer) clearTimeout(searchTimer);
}, { flush: 'sync' });
function fitPicker() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const space = (area.value?.getBoundingClientRect().top ?? viewportHeight) - 12;
  pickerMaxHeight.value = Math.max(64, Math.min(400, viewportHeight * .45, space));
}
const fitPickerAfterLayout = () => { void nextTick(fitPicker); };
function inspectInput() {
  resize();
  const before = draft.value.slice(
    0,
    input.value?.selectionStart ?? draft.value.length,
  );
  const commandMatch = before.match(/(?:^|\s)\/([^\s]*)$/);
  commandScope.value = /^\/[^\s]*$/.test(before);
  const fileMatch = before.match(/(?:^|\s)@([^\s]*)$/);
  const nextPicker = commandMatch ? "commands" : fileMatch ? "mentions" : "";
  const nextQuery = commandMatch?.[1] ?? fileMatch?.[1] ?? "";
  const wasCommands = picker.value === "commands";
  if (picker.value !== nextPicker || query.value !== nextQuery) {
    selected.value = 0;
    pickerError.value = "";
    // The previous query's files must not remain selectable while a new
    // debounced search is pending, including a late response to the old query.
    pickerFiles.value = [];
    if (pickerElement.value) pickerElement.value.scrollTop = 0;
  }
  picker.value = nextPicker;
  query.value = nextQuery;
  if (searchTimer) clearTimeout(searchTimer);
  const generation = ++pickerGeneration;
  if (picker.value === "commands" && !wasCommands && props.state.connected)
    void props.api.loadSkills().catch((cause: any) => {
      if (generation === pickerGeneration) pickerError.value = cause.message || "加载技能失败";
    });
  if (picker.value === "commands" && !wasCommands)
    void props.api.promptPresets.refresh().then(() => {
      if (generation === pickerGeneration && props.api.promptPresets.state.error)
        pickerError.value = props.api.promptPresets.state.error;
    });
  if (picker.value === "mentions") {
    searchPending.value = true;
    const requestedQuery = nextQuery;
    searchTimer = setTimeout(async () => {
      try {
        const matches = await props.api.searchFiles(requestedQuery);
        if (generation === pickerGeneration) pickerFiles.value = matches;
      } catch (cause: any) {
        if (generation === pickerGeneration) pickerError.value = cause.message || "搜索文件失败";
      } finally {
        if (generation === pickerGeneration) searchPending.value = false;
      }
    }, 180);
  } else searchPending.value = false;
}
function removePickerToken(token: "/" | "@", position = input.value?.selectionStart ?? draft.value.length) {
  const before = draft.value.slice(0, position);
  const expression = token === "/" ? /\/[^\s]*$/ : /@[^\s]*$/;
  const replaced = before.replace(expression, "");
  draft.value = replaced + draft.value.slice(position);
  picker.value = "";
  void nextTick(() => {
    input.value?.focus();
    input.value?.setSelectionRange(replaced.length, replaced.length);
    resize();
  });
}
async function pick(result: any) {
  if (!result || result.disabled || choosing.value || pickerDisabled.value) return;
  if (result.kind === "preset") {
    usePreset(result.preset);
  } else if (result.kind === "skill" || result.kind === "mode") {
    const key = draftKey.value;
    const chosenDraft = draft.value;
    const chosenPosition = input.value?.selectionStart ?? draft.value.length;
    choosing.value = true;
    pickerError.value = "";
    try {
      if (result.kind === "skill") await props.api.attachSkill(result.skill);
      else await props.api.setConversationMode(result.id);
      if (draftKey.value === key && draft.value === chosenDraft)
        removePickerToken(result.kind === "skill" ? "/" : "@", chosenPosition);
    } catch (cause: any) {
      pickerError.value = cause.message || "切换失败";
    } finally { choosing.value = false; }
  } else if (result.kind === "command") {
    if (result.id === "presets") {
      removePickerToken("/");
      await nextTick();
      openPresets();
      return;
    }
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
  if (event.isComposing || event.keyCode === 229 || input.value?.composing) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const key = event.key.toLowerCase();
    const formats: Record<string, MarkdownFormat> = { b: 'bold', i: 'italic', e: 'code' };
    const format = key === 'k' && event.shiftKey ? 'link' : !event.shiftKey && formats[key];
    if (format) {
      event.preventDefault(); event.stopPropagation();
      applyMarkdownEdit(formatMarkdown(draft.value, draftSelection(), format));
      return;
    }
    // Route the existing app shortcut explicitly before the editor keymap can
    // consume it, preserving both search access and the selected draft text.
    if (key === 'k') { event.preventDefault(); event.stopPropagation(); emit('search'); return; }
    if (event.key === 'Enter') { event.preventDefault(); void send(); return; }
  }
  if (choosing.value && picker.value && (event.key === "Enter" || event.key === "Tab")) {
    event.preventDefault();
    return;
  }
  if (picker.value && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    const length = results.value.length;
    if (length) {
      let index = selected.value;
      for (let count = 0; count < length; count++) {
        index = (index + (event.key === "ArrowDown" ? 1 : -1) + length) % length;
        if (!results.value[index]?.disabled) { selected.value = index; break; }
      }
    }
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
    if (picker.value) return;
    if (markdownEnter()) return;
    void send();
  }
}
async function send() {
  if (!canSend.value) return;
  const text = draft.value.trim();
  const submittedKey = draftKey.value;
  const submittedDraft = draft.value;
  const submittedContexts = [...quotedContexts.value];
  const preset = presetsState.value.snapshot.presets.find((preset: PromptPreset) => preset.content && text === `/${preset.slot}`);
  if (preset) { usePreset(preset, draft.value.length); return; }
  const command = commands.find((command) => command.name === text);
  if (command) {
    if (command.id === "presets") {
      draft.value = "";
      resize();
      openPresets();
      return;
    }
    protectStop();
    emit("command", command.id);
    draft.value = "";
    resize();
    return;
  }
  submitting.value = true;
  submittedDuringCompaction.value = !!props.state.compacting;
  pendingDraftSubmission = { key: submittedKey, hostId: props.state.hostId,
    projectPath: props.state.projectPath, threadId: props.state.activeThread?.id };
  try {
    await props.api.send(text, undefined, submittedContexts, delivery.value);
    protectStop();
    clearSubmittedDraft(submittedKey, submittedDraft);
    const sentKeys = new Set(submittedContexts.map(conversationSelectionKey));
    if (draftKey.value === submittedKey)
      quotedContexts.value = quotedContexts.value.filter(source => !sentKeys.has(conversationSelectionKey(source)));
    else saveContexts(submittedKey, readContexts(submittedKey).filter(source => !sentKeys.has(conversationSelectionKey(source))));
    if (draftKey.value === submittedKey && draft.value === submittedDraft) {
      draft.value = "";
      picker.value = "";
      await nextTick();
      resize();
    }
  } catch (cause: any) {
    // Creating a thread changes the storage key before a turn is accepted.
    // Restore only that automatic transition, never a manually selected chat.
    if (pendingDraftSubmission.targetKey === draftKey.value && !draft.value &&
      pendingDraftSubmission.hostId === props.state.hostId &&
      pendingDraftSubmission.projectPath === props.state.projectPath) {
      clearSubmittedDraft(submittedKey, submittedDraft);
      draft.value = submittedDraft;
      await nextTick();
      resize();
    }
    emit("error", cause.message || "发送消息失败");
  } finally {
    submitting.value = false;
    submittedDuringCompaction.value = false;
    if (!props.state.busy) delivery.value = "immediate";
    pendingDraftSubmission = undefined;
  }
}
async function upload(list: FileList | File[] | null, fromClipboard = false) {
  if (!list?.length || props.contextBusy || props.state.switchingHost || props.state.selectingThread) return;
  // Copy browser-owned lists before any asynchronous work. Parallel pastes keep
  // sending disabled until every upload completes.
  const files = Array.from(list);
  const key = draftKey.value;
  const generation = uploadContextGeneration;
  uploadCount.value++;
  try {
    const unique = fromClipboard ? await uniqueClipboardFiles(files) : files;
    if (generation !== uploadContextGeneration || props.contextBusy || props.state.switchingHost || props.state.selectingThread) return;
    await props.api.uploadFiles(unique, false);
  } catch (cause: any) {
    if (key === draftKey.value) emit("error", cause.message || "上传失败");
  } finally {
    uploadCount.value--;
    if (fileInput.value) fileInput.value.value = "";
  }
}
function paste(event: ClipboardEvent) {
  const files = clipboardFiles(event.clipboardData);
  if (!files.length) return;
  if (props.contextBusy || props.state.switchingHost || props.state.selectingThread) {
    emit("error", "会话切换中，请稍后粘贴文件或图片。");
    return;
  }
  // Leave the browser's normal text insertion intact for mixed text/image
  // clipboards. Image-only pastes should not insert a browser-specific filename.
  if (!event.clipboardData?.getData("text/plain")) event.preventDefault();
  void upload(files, true);
}
function drop(event: DragEvent) {
  dropping.value = false;
  if (event.dataTransfer?.files.length) void upload(event.dataTransfer.files);
}
function insertAt() {
  markdownPreview.value = false;
  draft.value += draft.value && !draft.value.endsWith(" ") ? " @" : "@";
  void nextTick(() => {
    input.value?.focus();
    input.value?.setSelectionRange(draft.value.length, draft.value.length);
    inspectInput();
  });
}
function closePicker() {
  picker.value = "";
  pickerGeneration++;
  searchPending.value = false;
  if (searchTimer) clearTimeout(searchTimer);
  input.value?.focus();
}
const draftKey = computed(
  () =>
    `codex.draft.${props.state.hostId}.${props.state.activeThread?.id || (props.state.noProject ? "no-project" : props.state.projectPath || "new")}`,
);
function saveContexts(key: string, sources: ConversationSelectionSource[]) {
  if (sources.length) browserStorage.local.setItem(`${key}.quotes`, JSON.stringify(sources));
  else browserStorage.local.removeItem(`${key}.quotes`);
  updateDraftStorageWarning();
}
function updateDraftStorageWarning() {
  draftStorageWarning.value = browserStorage.local.isTemporary(draftKey.value) ||
    browserStorage.local.isTemporary(`${draftKey.value}.quotes`);
}
function readContexts(key: string): ConversationSelectionSource[] {
  try {
    const saved = JSON.parse(browserStorage.local.getItem(`${key}.quotes`) || '[]');
    if (!Array.isArray(saved)) return [];
    const sources: ConversationSelectionSource[] = [];
    let size = 0;
    for (const value of saved.slice(0, 8)) {
      const source = normalizeConversationSelection(value);
      if (!source || size + source.text.length > 32_000) continue;
      size += source.text.length;
      sources.push(source);
    }
    return sources;
  } catch { return []; }
}
function addContext(value: ConversationSelectionSource) {
  const source = normalizeConversationSelection(value);
  if (!source || source.hostId !== props.state.hostId || source.threadId !== props.state.activeThread?.id) {
    emit('error', '对话已切换，请重新选择要引用的文字。');
    return false;
  }
  if (!quotedContexts.value.some(entry => conversationSelectionKey(entry) === conversationSelectionKey(source))) {
    if (quotedContexts.value.length >= 8 || quotedContexts.value.reduce((size, entry) => size + entry.text.length, source.text.length) > 32_000) {
      emit('error', '引用内容已达上限，请先发送或移除已有引用。');
      return false;
    }
    quotedContexts.value.push(source);
  }
  focusInput();
  return true;
}
function removeContext(index: number) { quotedContexts.value.splice(index, 1); }
function saveDraft(key: string, value: string) {
  const persisted = value ? browserStorage.local.setItem(key, value) : browserStorage.local.removeItem(key);
  // Migrate drafts from versions that only kept them for the current window.
  if (persisted) browserStorage.session.removeItem(key);
  updateDraftStorageWarning();
}
function clearSubmittedDraft(key: string, submitted: string) {
  if (browserStorage.local.getItem(key) === submitted) browserStorage.local.removeItem(key);
  if (browserStorage.session.getItem(key) === submitted) browserStorage.session.removeItem(key);
  updateDraftStorageWarning();
}
watch(
  draftKey,
  (key, previous) => {
    markdownPreview.value = false;
    if (pendingDraftSubmission && !pendingDraftSubmission.threadId &&
      previous === pendingDraftSubmission.key && props.state.activeThread?.id &&
      !props.state.selectingThread && !props.state.switchingHost &&
      pendingDraftSubmission.hostId === props.state.hostId &&
      pendingDraftSubmission.projectPath === props.state.projectPath)
      pendingDraftSubmission.targetKey = key;
    picker.value = "";
    pickerError.value = "";
    searchPending.value = false;
    pickerFiles.value = [];
    pickerGeneration++;
    if (searchTimer) clearTimeout(searchTimer);
    if (previous) {
      saveDraft(previous, draft.value);
      saveContexts(previous, quotedContexts.value);
    }
    draft.value = browserStorage.local.getItem(key) ?? browserStorage.session.getItem(key) ?? "";
    quotedContexts.value = readContexts(key).filter(source => source.hostId === props.state.hostId && source.threadId === props.state.activeThread?.id);
    saveDraft(key, draft.value);
    void nextTick(resize);
  },
  { immediate: true, flush: "sync" },
);
watch(results, (values) => {
  if (selected.value >= values.length || values[selected.value]?.disabled)
    selected.value = Math.max(0, values.findIndex((value) => !value.disabled));
});
watch(picker, fitPickerAfterLayout);
watch(selected, () => {
  void nextTick(() => {
    const container = pickerElement.value;
    const option = container?.querySelector<HTMLElement>(`[data-option-index="${selected.value}"]`);
    if (!container || !option) return;
    if (option.offsetTop < container.scrollTop) container.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > container.scrollTop + container.clientHeight)
      container.scrollTop = option.offsetTop + option.offsetHeight - container.clientHeight;
  });
});
watch(draft, (value) => {
  if (!value.trim()) markdownPreview.value = false;
  saveDraft(draftKey.value, value);
}, { flush: "sync" });
watch(quotedContexts, value => saveContexts(draftKey.value, value), { deep: true, flush: 'sync' });
function setDraft(text: string) {
  markdownPreview.value = false;
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
onMounted(() => {
  window.addEventListener("resize", fitPickerAfterLayout);
  window.visualViewport?.addEventListener("resize", fitPickerAfterLayout);
  window.addEventListener('resize', positionContextMenu);
  window.visualViewport?.addEventListener('resize', positionContextMenu);
  window.visualViewport?.addEventListener('scroll', positionContextMenu);
  document.addEventListener('scroll', positionContextMenu, true);
  document.addEventListener('pointerdown', contextOutside, true);
  document.addEventListener('keydown', contextKey, true);
});
onBeforeUnmount(() => {
  ++uploadContextGeneration;
  clearTimeout(stopGuardTimer);
  if (searchTimer) clearTimeout(searchTimer);
  window.removeEventListener("resize", fitPickerAfterLayout);
  window.visualViewport?.removeEventListener("resize", fitPickerAfterLayout);
  window.removeEventListener('resize', positionContextMenu);
  window.visualViewport?.removeEventListener('resize', positionContextMenu);
  window.visualViewport?.removeEventListener('scroll', positionContextMenu);
  document.removeEventListener('scroll', positionContextMenu, true);
  document.removeEventListener('pointerdown', contextOutside, true);
  document.removeEventListener('keydown', contextKey, true);
});
defineExpose({ focus: focusInput, getDraft: () => draft.value, setDraft, addContext, openPresets, contextMenuOpen, closeContextMenu,
  working: computed(() => uploading.value || submitting.value) });
</script>

<template>
  <div ref="area" class="composer-area" :class="{ 'welcome-composer': welcome }">
    <NewConversationContext
      v-if="!state.activeThread"
      :state="state"
      :disabled="contextDisabled"
      @project="emit('project', $event)"
      @no-project="emit('noProject')"
      @host="emit('host', $event)"
      @manage-projects="emit('command', 'settings-projects')"
    />
    <MessageQueuePanel v-if="queue" :controller="queue" :main="state" />
    <div
      v-if="picker"
      ref="pickerElement"
      class="composer-picker"
      id="composer-picker"
      :style="{ maxHeight: `${pickerMaxHeight}px` }"
      role="listbox"
      :aria-label="picker === 'commands' ? '对话指令' : '模式与项目文件'"
    >
      <div class="picker-label">
        <span class="picker-heading">{{ picker === "commands" ? "指令、预设与技能" : "对话模式与文件" }}</span>
        <span class="picker-input-hint"><span class="picker-keyboard-hint">↑ ↓ 选择 · ↵ 确认</span><span class="picker-touch-hint">点击选择</span></span>
        <button type="button" class="icon-button picker-close" aria-label="关闭选择菜单" @pointerdown.prevent @click="closePicker"><Icon name="X" :size="14" /></button>
      </div>
      <button
        v-for="(result, index) in results"
        :key="result.id || result.path || index"
        :id="`composer-picker-option-${index}`"
        :data-option-index="index"
        :class="{ selected: index === selected }"
        :disabled="result.disabled || choosing || pickerDisabled"
        role="option"
        :aria-selected="index === selected"
        @pointerdown.prevent
        @mousedown.prevent
        @click="pick(result)"
      >
        <Icon
          :name="result.kind === 'file' ? 'FileText' : result.icon"
          :size="17"
        />
        <div>
          <strong>{{
            result.kind !== "file"
              ? result.name
              : result.file_name || result.path?.split("/").pop() || result.name
          }}</strong
          ><span>{{
            result.kind === "mode" && state.busy && (result.id === 'default' || state.modeCapabilities?.[result.id]) ? '任务运行中，结束或停止后切换' : result.kind !== "file" ? result.description : result.path
          }}</span>
        </div>
        <span v-if="result.kind === 'preset'" class="picker-kind">预设</span>
        <span v-else-if="result.kind === 'skill'" class="picker-kind">技能</span>
        <span v-else-if="result.kind === 'mode' && result.id === conversationMode" class="picker-kind">当前</span>
        <Icon v-if="index === selected" name="CornerDownLeft" :size="14" />
      </button>
      <div v-if="!results.length" class="picker-empty">
        {{
          searchPending
            ? "正在搜索…"
            : picker === "mentions"
              ? "没有找到匹配的文件"
              : "没有匹配的指令、预设或技能"
        }}
      </div>
      <div v-if="picker === 'commands' && state.skillsLoading" class="picker-note" role="status">正在加载当前项目的技能…</div>
      <div v-if="pickerError || (picker === 'commands' && state.skillsError)" class="picker-note picker-error" role="alert">
        {{ pickerError || state.skillsError }}
        <button v-if="picker === 'commands'" class="text-button" @click="reloadSkills">重新加载</button>
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
      <div v-if="conversationMode !== 'default' || state.selectedSkills?.length" class="composer-tokens">
        <span v-if="conversationMode !== 'default'" class="composer-token mode-token" :title="state.busy ? '任务运行中，结束或停止后切换' : modeLabel">
          <Icon :name="conversationMode === 'goal' ? 'CheckCircle2' : 'ListTodo'" :size="14" />{{ modeLabel }}
          <button class="icon-button" :disabled="modeDisabled" aria-label="恢复默认模式" title="恢复默认模式" @click="resetMode"><Icon name="X" :size="12" /></button>
        </span>
        <span v-for="skill in state.selectedSkills" :key="skill.path" class="composer-token" :title="skill.description || skill.path">
          <Icon name="Sparkles" :size="14" />{{ skill.name }}
          <button class="icon-button" :disabled="contextDisabled" :aria-label="`移除技能 ${skill.name}`" @click="api.removeSkill(skill.path)"><Icon name="X" :size="12" /></button>
        </span>
      </div>
      <div v-if="conversationMode === 'goal'" class="composer-goal" :class="{ 'has-goal': !!state.goal }" role="status">
        <template v-if="state.goal">
          <div class="goal-summary"><strong>{{ state.goal.objective }}</strong><span>{{ goalStatus }}<template v-if="state.goal.tokensUsed != null"> · 已用 {{ state.goal.tokensUsed.toLocaleString() }} tokens</template><template v-if="state.goal.tokenBudget != null"> / {{ state.goal.tokenBudget.toLocaleString() }}</template></span></div>
          <div class="goal-actions">
            <button v-if="state.goal.status === 'active'" class="text-button" :disabled="goalActionsDisabled" @click="goalAction('pauseGoal')">暂停目标</button>
            <button v-else-if="!['complete', 'completed'].includes(state.goal.status)" class="text-button" :disabled="goalActionsDisabled" @click="goalAction('resumeGoal')">继续目标</button>
            <button class="text-button" :disabled="goalActionsDisabled" @click="goalAction('clearGoal')">清除目标</button>
          </div>
        </template>
        <template v-else><Icon name="CheckCircle2" :size="14" /><span>输入目标后发送，Codex 将持续执行，直到目标完成。</span></template>
        <div class="goal-budget">
          <label><span>Token 预算</span><input type="number" :value="goalBudgetDraft" min="1" step="1" inputmode="numeric" placeholder="不限" aria-label="Goal token 预算" :aria-invalid="goalBudgetInvalid" :disabled="goalActionsDisabled" @input="inputGoalBudget" /></label>
          <button v-if="state.goal" class="text-button" :disabled="goalActionsDisabled || goalBudgetInvalid || !goalBudgetChanged" @click="saveGoalBudget">保存预算</button>
          <span v-if="goalBudgetInvalid" class="goal-budget-error">请输入正整数或留空</span>
        </div>
      </div>
      <div v-if="state.modeError || state.goalReadError" class="composer-mode-error" role="alert">
        {{ state.modeError || state.goalReadError }}
        <button v-if="state.goalReadError && !state.modeError" class="text-button" :disabled="!state.connected || !state.online || state.runtimePaused || state.threadReleased" @click="api.refreshCurrentGoal()">重新读取目标</button>
      </div>
      <div v-if="draftStorageWarning && (draft || quotedContexts.length)" class="composer-mode-error" role="status" aria-label="草稿保存状态">
        浏览器存储不可用或已满；草稿暂存于此窗口，关闭前请复制保存。
      </div>
      <div v-if="quotedContexts.length" class="composer-quotes" aria-label="引用到对话的内容">
        <div v-for="(source, index) in quotedContexts" :key="conversationSelectionKey(source)" class="composer-quote">
          <Icon name="Quote" :size="14" />
          <small v-if="source.path" class="composer-quote-source" :title="source.path">{{ source.path.split('/').pop() }}{{ source.startLine ? ':' + source.startLine + (source.endLine && source.endLine !== source.startLine ? '–' + source.endLine : '') : '' }}</small>
          <span :title="source.text">{{ source.text }}</span>
          <button class="icon-button" :disabled="submitting" :aria-label="`移除引用 ${index + 1}`" @click="removeContext(index)"><Icon name="X" :size="13" /></button>
        </div>
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
      <MarkdownComposerEditor
        v-show="!markdownPreview"
        ref="input"
        v-model="draft"
        :placeholder="
          !state.connected
            ? '连接 Codex 后即可开始对话'
            : state.busy
              ? delivery === 'queue' ? '输入下一轮要执行的任务…' : '追加指令，调整当前任务…'
              : welcome
                ? conversationMode === 'goal' && !state.goal ? '输入希望 Codex 持续完成的目标…' : '描述一个任务，让 Codex 帮你完成'
                : '继续对话，/ 选择技能、@ 选择模式或引用文件'
        "
        :history-scope="draftKey"
        :aria-controls="picker ? 'composer-picker' : undefined"
        :aria-expanded="!!picker"
        :aria-activedescendant="picker && results.length ? `composer-picker-option-${selected}` : undefined"
        aria-autocomplete="list"
        @input="inspectInput"
        @selection-change="inspectInput"
        @click="inspectInput"
        @keydown="onKeydown"
        @beforeinput="onBeforeInput"
        @paste="paste"
        :disabled="!state.connected || contextBusy"
      />
      <section v-if="markdownPreview" ref="previewElement" class="composer-markdown-preview" tabindex="0"
        role="region" aria-label="Markdown 草稿预览" @keydown.esc.prevent="editDraft" @paste="paste">
        <div class="markdown" v-html="renderedDraft?.html"></div>
        <p v-if="renderedDraft?.truncated" class="composer-preview-note" role="status">仅预览前 100,000 个字符，完整原文仍会发送；切回编辑可查看全部内容。</p>
      </section>
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
            :disabled="!state.connected || uploading || contextBusy || state.modeBusy || state.switchingHost || state.selectingThread"
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
            :disabled="!state.connected || contextBusy || state.modeBusy || state.switchingHost || state.selectingThread"
            @pointerdown.prevent
            @click="insertAt"
            title="选择模式或引用项目文件"
            aria-label="选择模式或引用项目文件"
            :aria-expanded="picker === 'mentions'"
            aria-haspopup="listbox"
          >
            @</button
          ><button type="button" class="icon-button markdown-preview-toggle"
            :disabled="!draft.trim() || contextBusy"
            :aria-label="markdownPreview ? '编辑 Markdown' : '预览 Markdown'"
            :title="markdownPreview ? '返回实时 Markdown 编辑' : '完整 Markdown 预览；输入框已实时渲染。Ctrl/⌘+B 粗体、I 斜体、E 代码、Shift+K 链接'"
            :aria-pressed="markdownPreview" @pointerdown.prevent @click="toggleMarkdownPreview">
            <Icon :name="markdownPreview ? 'Pencil' : 'Eye'" :size="16" />
          </button><span class="toolbar-separator"></span
          ><label
            class="composer-select model-select"
            :title="selectedModel?.description || '选择模型'"
            ><select
              :value="state.model"
              @change="chooseModelSetting($event, 'model')"
              aria-label="选择模型"
              :disabled="
                modelControlsDisabled || !state.models?.length
              "
            >
              <option v-if="!state.models?.some((entry: any) => !entry.hidden && entry.model === state.model)" :value="state.model">
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
              :value="state.effort"
              @change="chooseModelSetting($event, 'effort')"
              aria-label="推理强度"
              :disabled="
                modelControlsDisabled
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
          <ModelServiceOptions :api="api" :state="state" :disabled="modelControlsDisabled" />
        </div>
        <div class="composer-submit">
          <label v-if="state.busy || delivery === 'queue'" class="composer-select queue-delivery" :title="delivery === 'queue' ? queue?.blockedReason.value || '当前任务完成后由 Codex 执行' : queue?.state.status !== 'supported' ? queue?.state.reason : '立即补充到当前任务'">
            <select v-model="delivery" aria-label="消息发送方式" :disabled="submitting || contextBusy">
              <option value="immediate">立即补充</option>
              <option value="queue" :disabled="!queue?.canMutate.value">下一轮排队</option>
            </select><Icon name="ChevronDown" :size="11" />
          </label>
          <button
            ref="contextButton"
            class="context-usage"
            :class="{ 'context-high': context && context.percent >= 80 }"
            :title="contextTitle"
            :aria-label="contextLabel"
            aria-haspopup="dialog"
            :aria-expanded="contextMenuOpen"
            :aria-controls="contextMenuId"
            @click="clickContext"
          >
            <span class="context-ring" :style="{ '--context-percent': `${context?.percent || 0}%` }" aria-hidden="true"></span>
            <span>{{ contextLabel }}</span>
          </button>
          <label
            class="composer-select permission-select"
            :class="{
              'full-access': state.permission === 'danger-full-access',
            }"
            :title="state.permissionChangePending ? `${permissionLabel}：下一轮生效，当前任务保留启动时权限` : permissionLabel"
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
              aria-label="选择权限" :data-queue-locked="queue?.settingsLocked.value"
              :disabled="
                state.busy || queue?.settingsLocked.value || state.modeBusy || state.selectingThread || state.switchingHost || contextBusy
              "
            >
              <option
                v-if="state.runtimePolicy && state.runtimePolicy.source !== 'web' && !state.activePermissionProfileId"
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
            class="send-button"
            :class="{ 'stop-button': showStop }"
            :disabled="showStop ? !state.connected : !canSend"
            :data-stop-protected="showStop && stopProtected || undefined"
            @click="primaryAction"
            :title="primaryLabel"
            :aria-label="primaryLabel"
          >
            <span v-if="showStop"></span>
            <Icon
              v-else
              :name="submitting ? 'LoaderCircle' : 'ArrowUp'"
              :size="20"
              :class="{ spin: submitting }"
            />
          </button>
        </div>
      </div>
    </div>
    <p v-if="modelSettingsError || state.modelSettingsNotice" class="composer-setting-notice" :class="{ 'is-error': !!modelSettingsError }" :role="modelSettingsError ? 'alert' : 'status'">{{ modelSettingsError || state.modelSettingsNotice }}</p>
    <p v-if="submitting && submittedDuringCompaction" class="compaction-send-note" role="status"><Icon name="LoaderCircle" :size="12" class="spin" />压缩结束后发送，草稿暂时保留。</p>
  </div>
  <Teleport to="body">
    <section
      v-if="contextMenuOpen"
      ref="contextMenu"
      :id="contextMenuId"
      class="context-usage-menu"
      :style="contextMenuPosition"
      role="dialog"
      aria-label="上下文用量与压缩"
      tabindex="-1"
    >
      <header><strong>上下文用量</strong><div class="context-menu-actions"><span v-if="context">{{ context.percent }}%</span><button type="button" class="icon-button" aria-label="关闭上下文用量" @click="closeContextMenu(true)"><Icon name="X" :size="16" /></button></div></header>
      <template v-if="context">
        <p class="context-token-count" :title="`${context.used.toLocaleString()} / ${context.limit.toLocaleString()} tokens`">
          <strong>{{ tokenCount(context.used) }} / {{ tokenCount(context.limit) }}</strong><span>tokens</span>
        </p>
        <div class="context-usage-bar" role="progressbar" aria-label="上下文使用比例"
          :aria-valuenow="context.percent" :aria-valuemin="0" :aria-valuemax="100">
          <span :style="{ width: `${context.percent}%` }" :class="{ 'context-high': context.percent >= 80 }"></span>
        </div>
      </template>
      <p v-else class="context-menu-note">{{ state.activeThread ? 'Codex 尚未报告当前上下文用量' : '新对话尚未使用上下文' }}</p>
      <button class="context-compact-action" :disabled="compactDisabled" @click="requestCompaction"
        :aria-describedby="compactDisabledReason ? `${contextMenuId}-reason` : undefined">
        <Icon name="RefreshCw" :size="14" />立即压缩
      </button>
      <p v-if="compactDisabledReason" :id="`${contextMenuId}-reason`" class="context-menu-note">{{ compactDisabledReason }}</p>
    </section>
  </Teleport>
</template>

<style scoped>
.composer-setting-notice { color:var(--muted);font-size:11px;line-height:1.5;margin:5px 2px 0; }
.composer-setting-notice.is-error { color:var(--red); }
.compaction-send-note { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; margin: 7px 4px 0; }
.composer-area {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: 0 3px 16px color-mix(in srgb, var(--text) 4%, transparent);
  min-width: 0;
}
.composer-area:focus-within {
  border-color: color-mix(in srgb, var(--accent-text) 55%, var(--border));
}
.composer {
  border: 0;
  border-radius: inherit;
  box-shadow: none;
}
.composer:focus-within { box-shadow: none; }
.markdown-preview-toggle[aria-pressed="true"] { color: var(--accent-text); background: var(--accent-soft); }
.composer-markdown-preview { min-height: 51px; max-height: 210px; overflow: auto; overscroll-behavior: contain; padding: 0 2px 8px; outline: none; }
.composer-markdown-preview .markdown { font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.composer-markdown-preview :deep(h1), .composer-markdown-preview :deep(h2), .composer-markdown-preview :deep(h3) { margin-top: 8px; font-size: 1.1em; }
.composer-markdown-preview :deep(h1:first-child), .composer-markdown-preview :deep(h2:first-child), .composer-markdown-preview :deep(h3:first-child) { margin-top: 0; }
.composer-markdown-preview :deep(pre), .composer-markdown-preview :deep(table) { max-width: 100%; }
.composer-markdown-preview :deep(img) { max-height: 140px; object-fit: contain; }
.composer-preview-note { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.composer-area :deep(.new-context) {
  margin: 0;
  padding: 6px 15px;
  border: 0;
  border-bottom: 1px solid var(--border);
  border-radius: 11px 11px 0 0;
  background: var(--soft);
}
.composer-picker {
  bottom: calc(100% + 7px);
  border-radius: 10px;
  max-height: min(400px, 45dvh);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.composer-picker > button:disabled { opacity: .55; cursor: default; }
.composer-picker > button:disabled:hover { background: transparent; }
.composer-picker > button.selected:not(:disabled) { background: var(--accent-soft); color: var(--accent-text); }
.picker-label { align-items: center; padding: 3px 6px 5px 10px; }
.picker-label .picker-heading { flex: 1; }
.picker-input-hint { flex: 0 0 auto; }
.picker-touch-hint { display: none; }
.picker-close { flex: 0 0 auto; width: 28px; height: 28px; }
@media (pointer: coarse) {
  .picker-keyboard-hint { display: none; }
  .picker-touch-hint { display: inline; }
  .composer-picker > button { min-height: 44px; touch-action: manipulation; }
  .picker-close { width: 36px; height: 36px; }
}
.picker-kind { flex: 0 0 auto; font-size: 10px; color: var(--muted); }
.picker-note { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; font-size: 11px; color: var(--muted); }
.picker-error, .composer-mode-error { color: var(--danger); }
.composer-mode-error { padding-bottom: 9px; font-size: 12px; }
.composer-quotes { display: grid; gap: 5px; margin-bottom: 9px; max-height: 125px; overflow-y: auto; }
.composer-quote { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 5px 7px; border-left: 2px solid var(--accent-text); border-radius: 5px; background: var(--accent-soft); color: var(--muted); font-size: 12px; }
.composer-quote > svg { flex: 0 0 auto; }
.composer-quote-source { flex: 0 0 auto; max-width: 35%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.composer-quote > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-quote .icon-button { flex: 0 0 auto; width: 24px; height: 24px; }
.composer-tokens { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-bottom: 9px; }
.composer-token { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%; padding: 3px 5px 3px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--soft); font-size: 11px; overflow-wrap: anywhere; }
.composer-token > svg { flex: 0 0 auto; color: var(--muted); }
.composer-token .icon-button { flex: 0 0 auto; width: 22px; height: 22px; }
.mode-token { color: var(--text); }
.composer-goal { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 7px; margin: 0 0 10px; color: var(--muted); font-size: 12px; line-height: 1.5; }
.composer-goal > svg { flex: 0 0 auto; margin-top: 2px; }
.composer-goal.has-goal { display: grid; gap: 4px; padding: 8px 10px; border-radius: 9px; background: var(--soft); }
.goal-summary { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.goal-summary strong { font-size: 12px; color: var(--text); font-weight: 500; overflow-wrap: anywhere; max-height: 4.5em; overflow-y: auto; }
.goal-summary span { font-size: 10px; }
.goal-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.goal-budget { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; width: 100%; }
.goal-budget label { display: flex; align-items: center; gap: 7px; font-size: 11px; }
.goal-budget input { width: 110px; min-width: 0; padding: 4px 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 5px; font-size: 11px; }
.goal-budget input[aria-invalid="true"] { border-color: var(--red); }
.goal-budget-error { color: var(--red); font-size: 10px; }
.text-button { padding: 3px 0; font-size: 11px; color: var(--muted); }
.text-button:hover:not(:disabled) { color: var(--text); }
.composer .composer-toolbar { flex-wrap: wrap; }
.composer .composer-tools { min-width: 0; flex: 1 1 auto; }
.composer .composer-submit { flex-wrap: wrap; max-width: 100%; margin-left: auto; justify-content: flex-end; }
.composer .model-select { min-width: 0; }
.composer .model-select select { width: 100%; min-width: 0; text-overflow: ellipsis; }
.composer .effort-select { flex: 0 0 auto; }
.composer .effort-select select { width: auto; max-width: none; }
.context-usage { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; min-height: 28px; padding: 3px; border: 0; border-radius: 5px; background: transparent; color: var(--muted); font-size: 11px; white-space: nowrap; }
.context-usage:hover:not(:disabled) { color: var(--text); background: var(--soft); }
.context-usage:disabled { opacity: 1; cursor: default; }
.context-usage.context-high { color: var(--warning); }
.context-ring { display: inline-block; width: 13px; height: 13px; flex: 0 0 auto; border-radius: 50%; background: conic-gradient(currentColor var(--context-percent), var(--border) 0); mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0); }
.context-usage-menu { position: fixed; z-index: 70; width: min(280px, calc(100vw - 24px)); padding: 14px; overflow-y: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); outline: none; }
.context-usage-menu header { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; }
.context-usage-menu header strong { font-weight: 500; }
.context-usage-menu header span { color: var(--muted); }
.context-menu-actions { display: flex; align-items: center; gap: 8px; }
.context-menu-actions .icon-button { width: 28px; height: 28px; }
.context-token-count { display: flex; align-items: baseline; gap: 7px; margin: 13px 0 10px; }
.context-token-count strong { font-size: 18px; font-weight: 500; font-variant-numeric: tabular-nums; }
.context-token-count span, .context-menu-note { color: var(--muted); font-size: 11px; }
.context-usage-bar { height: 4px; overflow: hidden; border-radius: 4px; background: var(--soft); }
.context-usage-bar > span { display: block; height: 100%; background: var(--accent-text); }
.context-usage-bar > .context-high { background: var(--warning); }
.context-compact-action { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 12px; padding: 9px 0 2px; border: 0; background: transparent; color: var(--text); text-align: left; font-size: 12px; }
.context-compact-action:hover:not(:disabled) { color: var(--green); }
.context-compact-action:disabled { color: var(--muted); cursor: default; }
.context-menu-note { margin: 9px 0 0; line-height: 1.6; }
@media (max-width: 760px) {
  .context-menu-actions .icon-button { width: 40px; height: 40px; }
  .context-compact-action { min-height: 44px; font-size: 13px; }
}
@media (max-width: 600px) {
  .composer-markdown-preview { max-height: min(210px, 35dvh); }
  .composer-area { border-radius: 12px; }
  .composer { padding: 12px 12px 10px; }
  .composer-area :deep(.new-context) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
    padding: 5px 12px;
    border-radius: 11px 11px 0 0;
  }
  .composer-area :deep(.context-choice) { max-width: 100%; }
  .composer-area :deep(.context-choice select) { max-width: 100%; }
  .composer-area :deep(.context-add) { grid-column: 1 / -1; margin-left: 0; padding: 0; }
  .composer > textarea { padding: 0 0 8px; min-height: 52px; font-size: 16px; }
  .composer-toolbar { display: grid; grid-template-columns: minmax(0, 1fr); align-items: center; gap: 3px; width: 100%; }
  .composer .composer-tools { display: flex; flex-wrap: nowrap; width: 100%; gap: 3px; }
  .composer .composer-tools > .icon-button { flex: 0 0 34px; width: 34px; height: 36px; }
  .toolbar-separator { flex: 0 0 1px; margin-inline: 3px; }
  .composer .model-select { flex: 1 1 0; margin-left: 0; gap: 3px; }
  .composer .model-select select { flex: 1 1 0; max-width: none; min-height: 36px; font-size: 12px; }
  .composer .effort-select { flex: 0 0 auto; margin: 0 0 0 4px; gap: 3px; }
  .composer .effort-select select { min-height: 36px; padding-inline: 0; font-size: 12px; }
  .composer .composer-submit { min-width: 0; width: 100%; justify-content: flex-end; gap: 7px; }
  .context-usage { margin-right: auto; min-height: 36px; font-size: 11px; gap: 4px; padding-inline: 0; }
  .composer .permission-select { min-width: 0; max-width: calc(100% - 50px); }
  .composer .permission-select select { width: auto; max-width: min(170px, 100%); text-overflow: ellipsis; min-height: 36px; font-size: 12px; }
  .composer .send-button { width: 36px; height: 36px; }
  .composer-picker { bottom: calc(100% + 7px); }
  .composer-tokens { gap: 6px; }
  .composer-token { font-size: 12px; }
}
</style>
