<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";

const props = defineProps<{
  api: any;
  hostId: string;
  hostName: string;
  initialPath?: string;
}>();
const emit = defineEmits<{ close: []; selected: [path: string] }>();
const dialog = ref<HTMLDialogElement>();
const address = ref(props.initialPath?.trim() || "");
const currentPath = ref("");
const entries = ref<Array<{ fileName: string; isDirectory: boolean }>>([]);
const loading = ref(false);
const error = ref("");
let generation = 0;
let mounted = false;
const canSelect = computed(
  () =>
    !loading.value &&
    !error.value &&
    !!currentPath.value &&
    address.value.trim() === currentPath.value,
);
const parentPath = computed(() => {
  const path = currentPath.value || address.value.trim();
  if (!path.startsWith("/") || path === "/") return "";
  return path.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
});
async function navigate(path?: string) {
  const requestGeneration = ++generation;
  const hostId = props.hostId;
  loading.value = true;
  error.value = "";
  currentPath.value = "";
  entries.value = [];
  address.value = path?.trim() || "";
  try {
    const result = await props.api.browseDirectory(hostId, path?.trim() || undefined);
    if (!mounted || requestGeneration !== generation || hostId !== props.hostId) return;
    currentPath.value = result.path;
    address.value = result.path;
    entries.value = result.entries
      .filter((entry: any) => entry.isDirectory)
      .sort((a: any, b: any) => a.fileName.localeCompare(b.fileName));
  } catch (cause: any) {
    if (!mounted || requestGeneration !== generation || hostId !== props.hostId) return;
    error.value = cause.message || "无法读取文件夹";
  } finally {
    if (mounted && requestGeneration === generation && hostId === props.hostId)
      loading.value = false;
  }
}
function openFolder(fileName: string) {
  void navigate(`${currentPath.value.replace(/\/$/, "")}/${fileName}`);
}
function select() {
  if (canSelect.value) emit("selected", currentPath.value);
}
function onKeydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key !== "Tab") return;
  const controls = [...(dialog.value?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
  ) || [])].filter((element) => element.getClientRects().length > 0);
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
onMounted(() => {
  mounted = true;
  dialog.value?.showModal();
  void navigate(props.initialPath);
});
watch(
  () => props.hostId,
  () => {
    if (mounted) void navigate();
  },
);
onBeforeUnmount(() => {
  mounted = false;
  generation++;
  dialog.value?.close();
});
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="folder-picker"
      aria-labelledby="folder-picker-title"
      @cancel.prevent="emit('close')"
      @keydown="onKeydown"
    >
      <header>
        <div>
          <h2 id="folder-picker-title">选择项目文件夹</h2>
          <span class="picker-host"><Icon name="Monitor" :size="13" />{{ hostName }}</span>
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="关闭文件夹选择"
          @click="emit('close')"
        ><Icon name="X" :size="18" /></button>
      </header>
      <form class="picker-address" @submit.prevent="navigate(address)">
        <button
          type="button"
          class="icon-button"
          aria-label="上级文件夹"
          :disabled="!parentPath"
          @click="navigate(parentPath)"
        ><Icon name="ArrowUp" :size="19" /></button>
        <input
          v-model="address"
          aria-label="文件夹路径"
          placeholder="输入绝对路径，按 Enter 打开"
          autofocus
          autocomplete="off"
          spellcheck="false"
        />
      </form>
      <div class="current-folder">
        <span>选择当前文件夹</span>
        <span v-if="currentPath" class="folder-name">{{ currentPath === '/' ? '/' : currentPath.split('/').pop() }}</span>
      </div>
      <div class="picker-list" :aria-busy="loading">
        <p v-if="loading" class="picker-notice" role="status"><Icon name="LoaderCircle" :size="16" class="spin" />正在读取文件夹…</p>
        <div v-else-if="error" class="picker-error" role="alert">
          <p>{{ error }}</p>
          <button type="button" class="button button-small button-secondary" @click="navigate(address)">重试</button>
        </div>
        <template v-else>
          <button
            v-for="entry in entries"
            :key="entry.fileName"
            type="button"
            class="folder-entry"
            :aria-label="`进入 ${entry.fileName}`"
            @click="openFolder(entry.fileName)"
          ><Icon name="Folder" :size="19" /><span>{{ entry.fileName }}</span><Icon name="ChevronRight" :size="15" /></button>
          <p v-if="!entries.length" class="picker-notice">此文件夹没有子文件夹</p>
        </template>
      </div>
      <footer>
        <button type="button" class="button button-secondary" @click="emit('close')">取消</button>
        <button type="button" class="button button-primary" :disabled="!canSelect" @click="select">使用文件夹</button>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.folder-picker {
  width: min(560px, calc(100vw - 28px));
  max-height: calc(100dvh - 32px);
  padding: 26px;
  margin: auto;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: var(--surface);
  color: var(--text);
  overflow: auto;
  box-shadow: 0 20px 80px #0002;
}
.folder-picker::backdrop { background: #0004; backdrop-filter: blur(3px); }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 22px; }
h2 { font-size: 20px; font-weight: 600; letter-spacing: -.3px; }
.picker-host { display: inline-flex; align-items: center; gap: 5px; margin-top: 8px; color: var(--muted); font-size: 12px; }
.picker-address { display: flex; align-items: center; gap: 9px; }
.picker-address input { width: 100%; min-width: 0; padding: 11px 12px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg); color: var(--text); font: inherit; font-size: 14px; }
.picker-address input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.current-folder { display: flex; align-items: center; gap: 12px; justify-content: space-between; color: var(--muted); font-size: 12px; margin: 18px 2px 10px; }
.folder-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker-list { height: clamp(180px, 34dvh, 310px); overflow-y: auto; border: 1px solid var(--border); border-radius: 12px; padding: 6px; }
.folder-entry { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 43px; padding: 9px 11px; text-align: left; border-radius: 7px; font-size: 13px; }
.folder-entry:hover, .folder-entry:focus-visible { background: var(--hover); }
.folder-entry > svg { color: var(--muted); flex-shrink: 0; }
.folder-entry > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker-notice { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 30px 12px; color: var(--muted); font-size: 12px; }
.picker-error { padding: 20px 12px; color: var(--red); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.picker-error .button { margin-top: 14px; }
footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
@media (max-width: 760px) {
  .folder-picker { padding: 20px; border-radius: 19px; }
  h2 { font-size: 18px; }
  .picker-address input { font-size: 16px; }
  .folder-entry { font-size: 13px; min-height: 44px; padding: 11px 9px; }
  .picker-list { height: clamp(180px, 35dvh, 300px); }
  footer .button { min-height: 40px; }
}
</style>
