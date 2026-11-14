<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import type { FileEntryChange } from '../../shared/file-entries';
import { validFileEntryName } from '../../shared/file-entries';
const props = defineProps<{ api: any; hostId: string; hostName?: string; directory: string; disabled?: boolean }>();
const emit = defineEmits<{ working: [value: boolean]; changed: [change: FileEntryChange] }>();
const input = ref<HTMLInputElement>();
const dragging = ref(false), busy = ref(false), progress = ref(''), errors = ref<string[]>([]);
let depth = 0, disposed = false;
watch(busy, value => { if (!disposed) emit('working', value); }, { flush: 'sync' });
watch(() => [props.hostId, props.directory], () => { dragging.value = false; depth = 0; if (!busy.value) { progress.value = ''; errors.value = []; } });
function drag(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault(); event.stopPropagation();
  if (event.type === 'dragleave') { depth = Math.max(0, depth - 1); dragging.value = depth > 0; return; }
  if (event.type === 'dragenter') depth++;
  dragging.value = !props.disabled && !busy.value && !!props.directory;
  event.dataTransfer.dropEffect = dragging.value ? 'copy' : 'none';
}
async function drop(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault(); event.stopPropagation(); dragging.value = false; depth = 0;
  if ([...event.dataTransfer.items].some(item => item.webkitGetAsEntry?.()?.isDirectory)) { errors.value = ['暂不支持拖入文件夹，请选择文件上传。']; return; }
  await upload([...event.dataTransfer.files]);
}
async function upload(files: File[]) {
  if (props.disabled || busy.value || !props.directory || !files.length) return;
  errors.value = [];
  if (files.length > 20) { errors.value = ['每批最多上传 20 个文件。']; return; }
  const invalid = files.filter(file => file.size > 100 * 1024 * 1024 || !validFileEntryName(file.name));
  if (invalid.length) { errors.value = invalid.map(file => `${file.name}：文件名无效或超过 100 MB`); return; }
  const hostId = props.hostId, directory = props.directory;
  const target = `${props.hostName || hostId} · ${directory}`;
  const authentication = props.api.runtimeIdentity?.().authenticationGeneration;
  const authenticated = () => !disposed && authentication === props.api.runtimeIdentity?.().authenticationGeneration;
  busy.value = true;
  let success = 0;
  try {
    for (const [index, file] of files.entries()) {
      if (!authenticated()) break;
      progress.value = `正在上传 ${index + 1}/${files.length}：${file.name} → ${target}`;
      try { const change = await props.api.uploadWorkspaceFile(hostId, directory, file); success++; if (authenticated()) emit('changed', change); }
      catch (cause: any) { if (authenticated()) errors.value.push(`${file.name}：${cause.message || '上传失败，请刷新目录核对'}`); }
    }
    if (authenticated()) progress.value = `${success}/${files.length} 个文件上传完成 → ${target}`;
  } finally { busy.value = false; }
}
function choose() { if (!props.disabled && !busy.value && props.directory) input.value?.click(); }
onBeforeUnmount(() => { disposed = true; if (busy.value) emit('working', false); });
defineExpose({ choose });
</script>
<template>
  <div class="file-upload-zone" :class="{ dragging }" @dragenter="drag" @dragover="drag" @dragleave="drag" @drop="drop">
    <input ref="input" type="file" multiple class="sr-only" aria-label="上传到当前目录" :disabled="disabled || busy" @change="(event: Event) => { const element = event.target as HTMLInputElement; const files = [...(element.files || [])]; element.value = ''; void upload(files); }" />
    <div v-if="progress || errors.length" class="upload-feedback" aria-live="polite"><p v-if="progress" role="status"><Icon v-if="busy" name="LoaderCircle" class="spin" :size="13" />{{ progress }}</p><p v-for="message in errors" :key="message" role="alert">{{ message }}</p><button v-if="!busy" class="icon-button" aria-label="关闭上传结果" @click="progress = ''; errors = []"><Icon name="X" :size="13" /></button></div>
    <slot />
    <div v-if="dragging" class="upload-drop-target" role="status"><Icon name="Upload" :size="28" /><strong>释放文件以上传</strong><span>{{ hostName || hostId }} · {{ directory }}</span></div>
  </div>
</template>
<style scoped>
.file-upload-zone{display:flex;flex-direction:column;flex:1;min-height:0;position:relative}.upload-drop-target{position:absolute;inset:5px;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:20px;border:2px dashed var(--accent);border-radius:10px;background:color-mix(in srgb,var(--surface) 94%,var(--accent));color:var(--accent);pointer-events:none}.upload-drop-target span{font-size:12px;overflow-wrap:anywhere;text-align:center}.upload-feedback{position:relative;flex-shrink:0;padding:9px 34px 9px 12px;border-bottom:1px solid var(--border);font-size:12px}.upload-feedback p{display:flex;gap:6px;align-items:center;overflow-wrap:anywhere;line-height:1.7}.upload-feedback [role=alert]{color:var(--red)}.upload-feedback>.icon-button{position:absolute;right:4px;top:4px}
</style>
