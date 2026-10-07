<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
import ChatItem from './ChatItem.vue'
import { subagentStatusLabel, subagentTime, type SubagentGroup } from '../lib/subagents'
import { getSubagentPrefetch } from '../lib/subagent-prefetch'

const props = defineProps<{ api: any; state: any }>()
const { rootId, connected, agents, nextCursor, loading, error, contents, load, read: fetchContent, refresh: refreshContent } = getSubagentPrefetch(props.api, props.state)
const selectedId = ref('')
const localDetailError = ref('')
const now = ref(Date.now())
const selected = computed(() => agents.value.find(agent => agent.id === selectedId.value))
const content = computed(() => contents.value.get(selectedId.value))
const detailThread = computed(() => content.value?.thread)
const detailTurns = computed(() => content.value?.turns || [])
const detailCursor = computed(() => content.value?.cursor)
const detailLoading = computed(() => !!content.value?.loading)
const detailError = computed(() => localDetailError.value || content.value?.error || '')
const definitions: { id: SubagentGroup; label: string }[] = [
  { id: 'active', label: '已开启' }, { id: 'waiting', label: '等待输入' },
  { id: 'completed', label: '完成' }, { id: 'other', label: '其他' },
]
const groups = computed(() => definitions.map(group => ({ ...group, agents: agents.value.filter(agent => agent.group === group.id) })).filter(group => group.agents.length))

function read(id: string, more = false) {
  localDetailError.value = ''
  return fetchContent(id, true, more)
}
function open(id: string) {
  localDetailError.value = ''
  selectedId.value = id
  // A hydrated child opens immediately. An in-flight prefetch is reused.
  if (!contents.value.get(id)?.hydrated && !contents.value.get(id)?.error) void fetchContent(id)
}
function closeDetail() {
  selectedId.value = ''
  localDetailError.value = ''
}
function refresh() {
  localDetailError.value = ''
  void refreshContent(true)
}
watch(() => [props.state.hostId, rootId.value, props.state.authenticated], closeDetail)
const ticker = window.setInterval(() => { now.value = Date.now() }, 1000)
onBeforeUnmount(() => window.clearInterval(ticker))
</script>

<template>
  <section class="subagents-panel" aria-label="子智能体工作区">
    <div class="subagents-toolbar">
      <span>{{ selectedId ? '子智能体对话' : `当前对话 · ${agents.length} 个子智能体` }}</span>
      <button class="icon-button" aria-label="刷新子智能体" title="刷新子智能体" :disabled="!connected || !rootId || loading || detailLoading" @click="refresh">
        <Icon :name="loading || detailLoading ? 'LoaderCircle' : 'RefreshCw'" :size="15" :class="{ spin: loading || detailLoading }" />
      </button>
    </div>
    <p v-if="!connected" class="subagents-note" role="status"><Icon name="WifiOff" :size="15" />连接已断开，重新连接后可刷新状态。</p>
    <p v-if="error" class="subagents-error" role="alert">{{ error }}<button class="button button-small button-secondary" :disabled="!connected || loading" @click="load(false, false, true)">重试</button></p>
    <div v-if="selectedId" class="subagent-detail">
      <div class="subagent-detail-heading">
        <button class="icon-button" aria-label="返回子智能体列表" title="返回子智能体列表" @click="closeDetail"><Icon name="ArrowLeft" :size="16" /></button>
        <div><strong>{{ selected?.name || detailThread?.agentNickname || detailThread?.name || '子智能体' }}</strong><span>{{ selected?.role }}{{ selected?.role ? ' · ' : '' }}{{ subagentStatusLabel(selected?.status || 'unknown') }} · 只读</span></div>
      </div>
      <p v-if="detailError" class="subagents-error" role="alert">{{ detailError }}<button class="button button-small button-secondary" :disabled="!connected || detailLoading" @click="read(selectedId)">重试读取</button></p>
      <div class="subagent-dialogue" aria-label="子智能体对话内容">
        <button v-if="detailCursor" class="button button-small button-secondary subagents-more" :disabled="detailLoading || !connected" @click="read(selectedId, true)">加载更早的消息</button>
        <div v-for="turn in detailTurns" :key="turn.id" class="subagent-turn" :data-agent-turn-id="turn.id">
          <ChatItem v-for="item in turn.items || []" :key="item.id" :item="{ ...item, turnId: turn.id }" :host-id="state.hostId" :cwd="detailThread?.cwd || state.projectPath" @error="localDetailError = $event" />
        </div>
        <p v-if="detailLoading && !detailTurns.length" class="subagents-note" role="status">正在读取对话…</p>
        <div v-else-if="!detailTurns.length && !detailError" class="panel-empty"><Icon name="Bot" :size="30" /><p>暂无可读取的对话</p><span>临时子智能体的活动会显示在列表中。</span></div>
      </div>
    </div>
    <div v-else class="subagents-list">
      <div v-if="!rootId" class="panel-empty"><Icon name="Bot" :size="32" /><p>先打开一个对话</p><span>此处显示该对话创建的子智能体。</span></div>
      <template v-else>
        <section v-for="group in groups" :key="group.id" class="subagents-group" :aria-label="`${group.label}的子智能体`">
          <h3>{{ group.label }} · {{ group.agents.length }}</h3>
          <button v-for="agent in group.agents" :key="agent.id" class="subagent-row" :class="`subagent-${agent.group}`" :data-agent-id="agent.id" :aria-label="`查看子智能体 ${agent.name}`" :disabled="!connected" @click="open(agent.id)">
            <span class="subagent-avatar"><Icon :name="agent.group === 'waiting' ? 'Bell' : agent.status === 'errored' ? 'AlertCircle' : 'Bot'" :size="19" /></span>
            <span class="subagent-description"><span class="subagent-name">{{ agent.name }}</span><span v-if="agent.role" class="subagent-role">{{ agent.role }}</span><span class="subagent-summary">{{ agent.summary || subagentStatusLabel(agent.status) }}</span><span class="subagent-state">{{ subagentStatusLabel(agent.status) }}{{ agent.ephemeral ? ' · 临时' : '' }}</span></span>
            <span class="subagent-time">{{ subagentTime(agent, now) }}</span>
          </button>
        </section>
        <button v-if="nextCursor" class="button button-small button-secondary subagents-more" :disabled="loading || !connected" @click="load(true)">加载更多子智能体</button>
        <p v-if="loading" class="subagents-note" role="status">正在读取子智能体…</p>
        <div v-else-if="!agents.length && !error" class="panel-empty"><Icon name="Bot" :size="32" /><p>暂无子智能体</p><span>Codex 创建的子智能体会自动出现在这里。</span></div>
        <p v-if="error && agents.length" class="subagents-note">已显示当前对话中已知的子智能体，刷新后可补全状态。</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.subagents-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; color: var(--text); background: var(--surface); }
.subagents-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; padding: 10px 16px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.subagents-list, .subagent-dialogue { overflow-y: auto; min-height: 0; flex: 1; }
.subagents-list { padding: 6px 8px 18px; }
.subagents-group h3 { margin: 20px 12px 8px; color: var(--muted); font-size: 12px; font-weight: 500; }
.subagent-row { display: flex; align-items: flex-start; width: 100%; gap: 10px; text-align: left; padding: 12px; border-radius: 10px; min-width: 0; }
.subagent-row:hover { background: var(--soft); }
.subagent-avatar { display: grid; place-items: center; width: 28px; height: 28px; flex: 0 0 28px; border-radius: 9px; background: var(--soft); color: var(--green); }
.subagent-waiting .subagent-avatar { color: var(--warning); }
.subagent-completed .subagent-avatar, .subagent-other .subagent-avatar { color: var(--muted); }
.subagent-description { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; }
.subagent-name { font-size: 13px; line-height: 1.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subagent-role, .subagent-summary, .subagent-state { color: var(--muted); font-size: 12px; line-height: 1.5; }
.subagent-summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.subagent-role { overflow-wrap: anywhere; }
.subagent-state { font-size: 11px; }
.subagent-time { color: var(--muted); font-size: 11px; line-height: 1.9; flex-shrink: 0; max-width: 72px; }
.subagents-more { display: flex; margin: 14px auto; }
.subagents-note { display: flex; align-items: center; gap: 7px; margin: 12px 16px; color: var(--muted); font-size: 12px; line-height: 1.7; }
.subagents-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px; color: var(--red); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.subagent-detail { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.subagent-detail-heading { display: flex; align-items: flex-start; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); }
.subagent-detail-heading > div { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.subagent-detail-heading strong { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.subagent-detail-heading span { color: var(--muted); font-size: 11px; }
.subagent-dialogue { padding: 12px 14px; }
.subagent-turn { display: flex; flex-direction: column; gap: 12px; padding-bottom: 18px; margin-bottom: 18px; border-bottom: 1px solid var(--border); min-width: 0; }
.subagent-dialogue :deep(.message), .subagent-dialogue :deep(.tool-item) { min-width: 0; max-width: 100%; }
.subagent-dialogue :deep(.user-bubble) { font-size: 12px; max-width: 100%; }
.subagent-dialogue :deep(.markdown) { font-size: 12px; overflow-wrap: anywhere; }
.subagent-dialogue :deep(pre) { overflow-x: auto; }
.subagents-panel .panel-empty { padding: 36px 18px; font-size: 13px; }
@media (max-width: 760px) { .subagent-row { min-height: 70px; } .subagents-toolbar .icon-button, .subagent-detail-heading .icon-button { min-height: 40px; min-width: 40px; } .subagents-more { min-height: 40px; } }
</style>
