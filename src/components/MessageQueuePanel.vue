<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { queuedText } from '../lib/message-queue';
const props = defineProps<{ controller: any; main: any }>();
const open = ref(false);
const editing = ref('');
const draft = ref('');
const queue = computed(() => props.controller.state);
const visible = computed(() => props.main.activeThread && (props.main.busy || queue.value.items.length || queue.value.error || queue.value.uncertain));
const enabled = computed(() => props.controller.canMutate.value);
function edit(item: any) { editing.value = item.id; draft.value = queuedText(item); open.value = true; }
async function action(operation: () => Promise<any>) {
  try { await operation(); editing.value = ''; }
  catch { /* The controller reports scoped errors without discarding an edit. */ }
}
watch(() => [props.main.hostId, props.main.activeThread?.id], () => { open.value = false; editing.value = ''; draft.value = ''; });
watch(() => queue.value.items.map((item: any) => item.id).join('\n'), () => {
  if (editing.value && !queue.value.items.some((item: any) => item.id === editing.value)) editing.value = '';
});
</script>

<template>
  <section v-if="visible" class="message-queue" aria-label="原生消息队列">
    <button class="queue-heading" :aria-expanded="open" @click="open = !open">
      <Icon name="ListOrdered" :size="14" />
      <span>{{ main.busy ? '运行中' : '当前任务已停止' }} · 下一轮队列 {{ queue.items.length }}</span>
      <Icon v-if="queue.loading" name="LoaderCircle" class="spin" :size="13" />
      <Icon :name="open ? 'ChevronUp' : 'ChevronDown'" :size="14" />
    </button>
    <div v-if="open" class="queue-body">
      <div class="queue-note">队列保存在 Codex 中，任务结束后继续执行，沿用该对话已保存的模型、模式和权限。停止当前任务会保留队列。</div>
      <div v-if="queue.status !== 'supported'" class="queue-note" role="status">{{ queue.reason }} <button class="text-button" @click="controller.checkCapabilities(true)">重新检查</button></div>
      <div v-else-if="!queue.items.length && !queue.loading" class="queue-note">没有等待执行的消息。</div>
      <ol v-if="queue.items.length" class="queue-list">
        <li v-for="(item, index) in queue.items" :key="item.id" class="queue-item">
          <template v-if="editing === item.id">
            <textarea v-model="draft" rows="3" aria-label="编辑排队消息" :disabled="!enabled"></textarea>
            <div class="queue-actions"><button class="text-button" :disabled="!enabled || !draft.trim()" @click="action(() => controller.update(item.id, draft))">保存消息</button><button class="text-button" @click="editing = ''">取消编辑</button></div>
          </template>
          <template v-else>
            <div class="queue-prompt" :title="queuedText(item)"><span class="queue-number">{{ Number(index) + 1 }}</span><span>{{ queuedText(item) || '附件消息' }}</span></div>
            <span v-if="item.input.length > 1 || item.input[0]?.type !== 'text'" class="queue-note">包含附件、引用或技能，编辑时保留</span>
            <div class="queue-actions" :title="controller.blockedReason.value">
              <button class="icon-button" aria-label="编辑排队消息" title="编辑" :disabled="!enabled" @click="edit(item)"><Icon name="Pencil" :size="13" /></button>
              <button class="icon-button" aria-label="上移排队消息" title="上移" :disabled="!enabled || index === 0" @click="action(() => controller.move(item.id, -1))"><Icon name="ArrowUp" :size="13" /></button>
              <button class="icon-button" aria-label="下移排队消息" title="下移" :disabled="!enabled || index === queue.items.length - 1" @click="action(() => controller.move(item.id, 1))"><Icon name="ArrowDown" :size="13" /></button>
              <button class="text-button" :disabled="!enabled || main.busy" :title="main.busy ? '请等待当前任务完成或停止后启动' : '立即执行这条消息'" @click="action(() => controller.start(item.id))">立即启动</button>
              <button class="icon-button" aria-label="删除排队消息" title="删除" :disabled="!enabled" @click="action(() => controller.remove(item.id))"><Icon name="Trash2" :size="13" /></button>
            </div>
          </template>
        </li>
      </ol>
      <button v-if="queue.status === 'supported'" class="text-button" :disabled="queue.loading || !main.connected" @click="controller.refresh()">刷新队列</button>
    </div>
    <div v-if="queue.error || queue.uncertain || queue.notice" class="queue-notice" :role="queue.error || queue.uncertain ? 'alert' : 'status'">
      {{ queue.error || queue.notice }}
      <template v-if="queue.uncertain"><span>核对队列和对话后再恢复发送，避免重复。</span><button class="text-button" :disabled="queue.loading || !main.connected" @click="controller.refresh()">核对队列</button><button class="text-button" :disabled="queue.loading || !main.connected || main.online === false" @click="controller.acknowledgeUncertain()">已核对，恢复发送</button></template>
    </div>
  </section>
</template>

<style scoped>
.message-queue { border-bottom: 1px solid var(--border); padding: 7px 12px; font-size: 12px; }
.queue-heading { display: flex; align-items: center; gap: 6px; background: none; border: 0; color: var(--muted); width: 100%; padding: 2px 0; text-align: left; cursor: pointer; }
.queue-heading > span { flex: 1; }
.queue-body { padding-top: 8px; max-height: 300px; overflow: auto; }
.queue-note { color: var(--muted); font-size: 11px; line-height: 1.5; }
.queue-list { list-style: none; padding: 0; margin: 8px 0; }
.queue-item { border-top: 1px solid var(--border); padding: 8px 0; }
.queue-prompt { display: flex; gap: 8px; color: var(--text); }
.queue-prompt > span:last-child { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 60px; overflow: hidden; }
.queue-number { color: var(--muted); flex: 0 0 14px; }
.queue-actions { display: flex; align-items: center; gap: 5px; margin-top: 4px; }
.queue-actions .icon-button { width: 25px; height: 25px; }
.queue-item textarea { box-sizing: border-box; width: 100%; min-height: 64px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px; resize: vertical; font: inherit; }
.queue-notice { display: flex; gap: 6px; flex-wrap: wrap; color: var(--muted); line-height: 1.5; padding-top: 5px; }
</style>
