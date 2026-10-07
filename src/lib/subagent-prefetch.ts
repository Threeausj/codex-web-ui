import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { mergeSubagents } from './subagents'
import { SubagentContentCache, type SubagentContent } from './subagent-content-cache'

const stores = new WeakMap<object, ReturnType<typeof createPrefetch>>()

function createPrefetch(api: any, state: any) {
  const threads = ref<any[]>([])
  const nextCursor = ref<string | null>(null)
  const loading = ref(false)
  const error = ref('')
  const contents = shallowRef(new Map<string, SubagentContent>())
  const rootId = computed(() => state.activeThread?.id || state.threadId || '')
  const connected = computed(() => !!state.connected && !!state.authenticated)
  const scope = () => JSON.stringify([state.hostId, rootId.value, state.authenticated])
  const cache = new SubagentContentCache(
    (id, cursor) => api.readSubagent(id, cursor),
    () => { contents.value = new Map([...cache.entries].map(([id, content]) => [id, { ...content }])) },
    id => api.getSubagentSnapshot?.(id),
  )
  const agents = computed(() => {
    const known = new Map(threads.value.map(thread => [thread.id, thread]))
    // A canonical collaboration item can identify a child before its list page.
    for (const [id, content] of contents.value) if (content.thread && !known.has(id)) known.set(id, content.thread)
    return mergeSubagents(rootId.value, [...known.values()].map(thread => ({
      ...thread, turns: contents.value.get(thread.id)?.turns || thread.turns,
    })), state.items || [], state.agentActivity || {})
  })
  let listGeneration = 0
  let listRetryAt = 0
  let listed = false
  const seenActivity = new Map<string, any>()

  async function load(more = false, preserve = false, retry = false) {
    if (!rootId.value || !connected.value || loading.value || (!retry && listRetryAt > Date.now())) return
    const requestScope = scope()
    const generation = ++listGeneration
    loading.value = true
    error.value = ''
    try {
      const result = await api.listSubagents(rootId.value, more ? nextCursor.value : undefined)
      if (generation !== listGeneration || requestScope !== scope() || !connected.value) return
      const page = Array.isArray(result?.data) ? result.data : []
      const combined = new Map<string, any>((more || preserve ? threads.value : []).map(thread => [thread.id, thread]))
      for (const thread of page) combined.set(thread.id, thread)
      threads.value = [...combined.values()]
      if (!preserve || !listed) nextCursor.value = result?.nextCursor || null
      listed = true
      listRetryAt = 0
    } catch (cause: any) {
      if (generation === listGeneration && requestScope === scope()) {
        error.value = cause?.message || '无法读取子智能体'
        listRetryAt = Date.now() + 15_000
      }
    } finally {
      if (generation === listGeneration && requestScope === scope()) loading.value = false
    }
  }

  function read(id: string, force = false, earlier = false) {
    if (!connected.value || !agents.value.some(agent => agent.id === id)) return Promise.resolve()
    return cache.request(id, { force, earlier })
  }
  async function refresh(explicit = false) {
    await load(false, true, explicit)
    if (!connected.value) return
    for (const agent of agents.value) {
      const active = ['active', 'waiting'].includes(agent.group)
      const activity = state.agentActivity?.[agent.id]
      const streaming = activity?.updatedAt > Date.now() - 30_000 && api.getSubagentSnapshot?.(agent.id)?.turns?.length
      void read(agent.id, explicit || (active && !streaming && !!contents.value.get(agent.id)?.hydrated))
    }
  }

  watch(() => [state.hostId, rootId.value, state.authenticated], () => {
    ++listGeneration
    loading.value = false
    threads.value = []
    nextCursor.value = null
    error.value = ''
    listRetryAt = 0
    listed = false
    seenActivity.clear()
    cache.reset()
    void load()
  }, { immediate: true })
  watch(connected, value => {
    ++listGeneration
    loading.value = false
    cache.reset(false)
    if (value) void refresh()
  })
  watch(() => agents.value.map(agent => agent.id).join('\0'), () => {
    if (connected.value) for (const agent of agents.value) void read(agent.id)
  }, { immediate: true })
  watch(() => state.agentActivity, () => {
    // Only this parent's known descendants may consume host-wide snapshots.
    for (const agent of agents.value) {
      const activity = state.agentActivity?.[agent.id]
      if (!activity || seenActivity.get(agent.id) === activity) continue
      seenActivity.set(agent.id, activity)
      cache.live(agent.id)
    }
  }, { deep: true })
  watch(() => agents.value.map(agent => [agent.id, agent.status] as const), (current, previous) => {
    const statuses = new Map(previous || [])
    for (const [id, status] of current)
      if (statuses.has(id) && statuses.get(id) !== status && state.agentActivity?.[id]?.status === status &&
        ['completed', 'errored', 'interrupted', 'shutdown'].includes(status))
        void read(id, true)
  })

  const poller = window.setInterval(() => {
    if (connected.value && rootId.value && document.visibilityState === 'visible') void refresh()
  }, 15_000)
  const wake = () => {
    if (document.visibilityState === 'visible' && connected.value) void refresh()
  }
  document.addEventListener('visibilitychange', wake)
  onBeforeUnmount(() => {
    ++listGeneration
    cache.reset()
    window.clearInterval(poller)
    document.removeEventListener('visibilitychange', wake)
    stores.delete(state)
  })
  return { rootId, connected, threads, nextCursor, loading, error, contents, agents, load, read, refresh }
}

/** Call once from App setup so descendants hydrate while the workspace is shut. */
export function useSubagentPrefetch(api: any, state: any) {
  const existing = stores.get(state)
  if (existing) return existing
  const store = createPrefetch(api, state)
  stores.set(state, store)
  return store
}

export function getSubagentPrefetch(api: any, state: any) {
  return stores.get(state) || useSubagentPrefetch(api, state)
}
