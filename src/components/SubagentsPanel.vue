<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
import ChatItem from './ChatItem.vue'
import { mergeSubagents, subagentStatusLabel, subagentTime, type SubagentGroup } from '../lib/subagents'

const props = defineProps<{ api: any; state: any }>()
const threads = ref<any[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const error = ref('')
const selectedId = ref('')
const detailThread = ref<any>(null)
const detailTurns = ref<any[]>([])
const detailCursor = ref<string | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const now = ref(Date.now())
let listGeneration = 0
let detailGeneration = 0
const rootId = computed(() => props.state.activeThread?.id || props.state.threadId || '')
const scope = () => JSON.stringify([props.state.hostId, rootId.value])
const connected = computed(() => !!props.state.connected)
const agents = computed(() => mergeSubagents(rootId.value, threads.value, props.state.items || [], props.state.agentActivity || {}))
const selected = computed(() => agents.value.find(agent => agent.id === selectedId.value))
const definitions: { id: SubagentGroup; label: string }[] = [
  { id: 'active', label: '已开启' }, { id: 'waiting', label: '等待输入' },
  { id: 'completed', label: '完成' }, { id: 'other', label: '其他' },
]
const groups = computed(() => definitions.map(group => ({ ...group, agents: agents.value.filter(agent => agent.group === group.id) })).filter(group => group.agents.length))

async function load(more = false, preserve = false) {
  if (!rootId.value || !connected.value || loading.value && more) return
  const requestScope = scope()
  const generation = ++listGeneration
  loading.value = true
  error.value = ''
  try {
    const result = await props.api.listSubagents(rootId.value, more ? nextCursor.value : undefined)
    if (generation !== listGeneration || requestScope !== scope() || !connected.value) return
    const page = Array.isArray(result?.data) ? result.data : []
    const combined = new Map<string, any>((more || preserve ? threads.value : []).map(thread => [thread.id, thread]))
    for (const thread of page) combined.set(thread.id, thread)
    threads.value = [...combined.values()]
    if (!preserve) nextCursor.value = result?.nextCursor || null
  } catch (cause: any) {
    if (generation === listGeneration && requestScope === scope()) error.value = cause.message || '无法读取子智能体'
  } finally {
    if (generation === listGeneration && requestScope === scope()) loading.value = false
  }
}
async function read(id: string, more = false, preserve = false) {
  if (!connected.value || !id || detailLoading.value && more) return
  const requestScope = scope()
  const generation = ++detailGeneration
  selectedId.value = id
  detailLoading.value = true
  detailError.value = ''
  try {
    const result = await props.api.readSubagent(id, more ? detailCursor.value : undefined)
    if (generation !== detailGeneration || requestScope !== scope() || selectedId.value !== id || !connected.value) return
    const page = Array.isArray(result?.turns) ? result.turns : []
    const unique = new Map<string, any>()
    const combined = more ? [...page, ...detailTurns.value] : preserve ? [...detailTurns.value, ...page] : page
    for (const turn of combined) unique.set(turn.id, turn)
    detailTurns.value = [...unique.values()]
    if (!preserve) detailCursor.value = result?.nextCursor || null
    detailThread.value = result?.thread || detailThread.value
    if (result?.thread) {
      const existing = threads.value.findIndex(thread => thread.id === id)
      const thread = { ...result.thread, turns: detailTurns.value }
      if (existing >= 0) threads.value[existing] = thread
      else threads.value.push(thread)
    }
  } catch (cause: any) {
    if (generation === detailGeneration && requestScope === scope() && selectedId.value === id)
      detailError.value = cause.message || '无法读取子智能体对话'
  } finally {
    if (generation === detailGeneration && requestScope === scope() && selectedId.value === id) detailLoading.value = false
  }
}
function open(id: string) {
  ++detailGeneration
  detailTurns.value = []
  detailThread.value = null
  detailCursor.value = null
  detailError.value = ''
  selectedId.value = id
  void read(id)
}
function closeDetail() {
  ++detailGeneration
  selectedId.value = ''
  detailLoading.value = false
}
function refresh() {
  void load()
  if (selectedId.value) void read(selectedId.value, false, true)
}
watch(() => [props.state.hostId, rootId.value], () => {
  ++listGeneration
  ++detailGeneration
  threads.value = []
  nextCursor.value = null
  loading.value = false
  error.value = ''
  closeDetail()
  detailThread.value = null
  detailTurns.value = []
  detailCursor.value = null
  detailError.value = ''
  void load()
}, { immediate: true })
watch(connected, value => {
  ++listGeneration
  ++detailGeneration
  loading.value = detailLoading.value = false
  if (value) refresh()
})
const ticker = window.setInterval(() => { now.value = Date.now() }, 1000)
const poller = window.setInterval(() => {
  if (!connected.value || document.visibilityState !== 'visible') return
  if (!loading.value) void load(false, true)
  if (selectedId.value && ['active', 'waiting'].includes(selected.value?.group || '') && !detailLoading.value)
    void read(selectedId.value, false, true)
}, 15_000)
onBeforeUnmount(() => {
  ++listGeneration
  ++detailGeneration
  window.clearInterval(ticker)
  window.clearInterval(poller)
})
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
    <p v-if="error" class="subagents-error" role="alert">{{ error }}<button class="button button-small button-secondary" :disabled="!connected || loading" @click="load()">重试</button></p>
    <div v-if="selectedId" class="subagent-detail">
      <div class="subagent-detail-heading">
        <button class="icon-button" aria-label="返回子智能体列表" title="返回子智能体列表" @click="closeDetail"><Icon name="ArrowLeft" :size="16" /></button>
        <div><strong>{{ selected?.name || detailThread?.agentNickname || detailThread?.name || '子智能体' }}</strong><span>{{ selected?.role }}{{ selected?.role ? ' · ' : '' }}{{ subagentStatusLabel(selected?.status || 'unknown') }} · 只读</span></div>
      </div>
      <p v-if="detailError" class="subagents-error" role="alert">{{ detailError }}<button class="button button-small button-secondary" :disabled="!connected || detailLoading" @click="read(selectedId)">重试读取</button></p>
      <div class="subagent-dialogue" aria-label="子智能体对话内容">
        <button v-if="detailCursor" class="button button-small button-secondary subagents-more" :disabled="detailLoading || !connected" @click="read(selectedId, true)">加载更早的消息</button>
        <div v-for="turn in detailTurns" :key="turn.id" class="subagent-turn" :data-agent-turn-id="turn.id">
          <ChatItem v-for="item in turn.items || []" :key="item.id" :item="{ ...item, turnId: turn.id }" @error="detailError = $event" />
        </div>
        <p v-if="detailLoading" class="subagents-note" role="status">正在读取对话…</p>
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
