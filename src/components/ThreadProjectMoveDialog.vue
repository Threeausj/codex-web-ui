<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import Icon from './Icon.vue';
import { threadLabel } from '../lib/navigation';

const props = defineProps<{ thread: any; hostId: string; state: any; api: any }>();
const emit = defineEmits<{ close: []; moved: [change: { id: string; hostId: string; projectId: string }] }>();
const dialog = ref<HTMLDialogElement>();
const titleId = `thread-project-move-${useId()}`;
const destination = ref('');
const pending = ref(false);
const loading = ref(true);
const error = ref('');
const projects = computed(() => props.state.projects.filter((project: any) => (project.hostId || 'local') === props.hostId));
const currentProject = computed(() => projects.value.find((project: any) => props.api.threadMatchesProject(props.thread, project)));
const running = computed(() => props.thread.status?.type === 'active' ||
  props.state.hostId === props.hostId && props.state.activeThread?.id === props.thread.id && props.state.busy);
function close() { if (!pending.value) emit('close'); }
async function load() {
  loading.value = true;
  error.value = '';
  try { await props.api.loadNativeProjectBindings(props.hostId, true); }
  catch (cause: any) { error.value = cause.message || '无法读取项目列表，请重试'; }
  finally { loading.value = false; }
}
async function submit() {
  if (pending.value || loading.value || !destination.value || running.value) return;
  if (!projects.value.some((project: any) => project.path === destination.value)) {
    error.value = '目标项目已移除，请重新选择'; return;
  }
  pending.value = true;
  error.value = '';
  try {
    const change = await props.api.moveThreadToProject(props.thread.id, destination.value, props.hostId);
    if (change) emit('moved', change);
    emit('close');
  } catch (cause: any) { error.value = cause.message || '无法调整项目，请重试'; }
  finally { pending.value = false; }
}
onMounted(async () => { await nextTick(); dialog.value?.showModal(); await load(); });
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="thread-project-dialog" :aria-labelledby="titleId" @keydown.stop @cancel.prevent="close">
      <form @submit.prevent="submit">
        <header>
          <h2 :id="titleId">移动到项目</h2>
          <button type="button" class="icon-button" aria-label="关闭项目调整" :disabled="pending" @click="close"><Icon name="X" :size="17" /></button>
        </header>
        <p class="thread-project-name">{{ threadLabel(thread) }}</p>
        <label>目标项目
          <select v-model="destination" aria-label="目标项目" :disabled="pending || loading || running" required>
            <option value="" disabled>{{ loading ? '正在读取项目…' : '选择同一主机的项目' }}</option>
            <option v-for="project in projects" :key="project.path" :value="project.path" :disabled="currentProject?.path === project.path">
              {{ project.name }}{{ currentProject?.path === project.path ? '（当前项目）' : '' }}
            </option>
          </select>
        </label>
        <p class="thread-project-description">调整此对话的项目归属，并同步至支持原生项目的 Codex 客户端。工作目录和项目文件保持原位。</p>
        <p v-if="!loading && !projects.length" class="inline-error">此主机尚未添加项目，请先添加项目。</p>
        <p v-if="running" class="inline-error">对话正在运行，请先停止或等待任务结束。</p>
        <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
        <footer>
          <button v-if="error" type="button" class="button button-secondary" :disabled="pending || loading" @click="load">刷新项目</button>
          <button type="button" class="button button-secondary" :disabled="pending" @click="close">取消</button>
          <button class="button button-primary" :disabled="pending || loading || !destination || running">{{ pending ? '移动中…' : '移动对话' }}</button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.thread-project-dialog { width: min(460px, calc(100vw - 28px)); max-height: calc(100dvh - 32px); margin: auto; padding: 24px; overflow: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.thread-project-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(3px); }
.thread-project-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.thread-project-dialog h2 { margin: 0; font-size: 18px; }
.thread-project-name { overflow-wrap: anywhere; margin: 0 0 20px; font-size: 13px; color: var(--muted); }
.thread-project-dialog label { display: block; font-size: 13px; }
.thread-project-dialog select { display: block; width: 100%; margin-top: 7px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
.thread-project-description { margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.7; }
.thread-project-dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
@media (max-width: 760px) { .thread-project-dialog { padding: 20px; } .thread-project-dialog select { font-size: 16px; } }
</style>
