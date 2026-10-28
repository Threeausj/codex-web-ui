<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";

const props = defineProps<{ api: any; state: any; hostId: string; connected: boolean; disabled?: boolean }>();
const status = ref<{ v2ConsolidatedThreads: number; v2Ready: boolean } | null>(null);
const summary = ref<string | null>(null);
const summaryRead = ref(false);
const operation = ref("");
const error = ref("");
let generation = 0;
let disposed = false;
const threadId = computed(() => props.hostId === props.state.hostId && props.state.threadReady && !props.state.threadReleased && !props.state.selectingThread ? props.state.activeThread?.id || "" : "");
const identity = () => JSON.stringify([props.hostId, props.state.authenticated, props.state.authenticationGeneration,
  props.state.runtimeInformation?.[props.hostId]?.runtime?.engineId, props.connected, props.state.hostId, threadId.value]);
const unavailable = computed(() => !props.connected || !props.state.authenticated || props.disabled || !!operation.value);

async function read(kind: "status" | "summary") {
  if (unavailable.value || (kind === "summary" && !threadId.value)) return;
  const selected = identity(), token = ++generation, hostId = props.hostId, selectedThread = threadId.value;
  const current = () => !disposed && token === generation && selected === identity();
  operation.value = kind;
  error.value = "";
  try {
    const settings = props.api.hostSettings(hostId).api;
    const capabilities = await settings.requestHttp(`/hosts/${encodeURIComponent(hostId)}/native-capabilities`, {}, false);
    if (!current()) return;
    const method = kind === "status" ? "memory/status" : "thread/memory/read";
    if (capabilities?.status !== "known" || capabilities.methods?.[method]?.available !== true)
      throw new Error(kind === "summary" ? "此主机尚未提供会话记忆读取接口，请更新至 Codex 0.165.0 并重新连接后重试。" : "此主机暂不支持读取记忆状态。更新并重新连接 Codex 后可重试。");
    const result = await settings.rpc(method, kind === "status" ? {} : { threadId: selectedThread });
    if (!current()) return;
    if (kind === "status") {
      if (!Number.isInteger(result?.v2ConsolidatedThreads) || result.v2ConsolidatedThreads < 0 || typeof result?.v2Ready !== "boolean")
        throw new Error("Codex 返回的记忆状态无效，请更新并重新连接后重试。");
      status.value = result;
    } else {
      if (result?.summary !== null && typeof result?.summary !== "string") throw new Error("Codex 返回的会话记忆无效。");
      summary.value = result.summary;
      summaryRead.value = true;
    }
  } catch (cause: any) {
    if (current()) error.value = cause.message || "无法读取记忆";
  } finally { if (current()) operation.value = ""; }
}
watch(identity, () => {
  ++generation; status.value = null; summary.value = null; summaryRead.value = false; operation.value = ""; error.value = "";
}, { flush: "sync" });
onBeforeUnmount(() => { disposed = true; ++generation; });
</script>

<template>
  <section class="codex-memory" aria-label="Codex 记忆">
    <h4>记忆</h4>
    <p class="codex-memory-note">查看所选主机的记忆状态，以及当前已打开会话的记忆摘要。</p>
    <div class="codex-memory-actions">
      <button class="button button-secondary button-small" :disabled="unavailable" @click="read('status')"><Icon :name="operation === 'status' ? 'LoaderCircle' : 'Database'" :class="{ spin: operation === 'status' }" :size="15" />读取记忆状态</button>
      <button class="button button-secondary button-small" :disabled="unavailable || !threadId" @click="read('summary')"><Icon :name="operation === 'summary' ? 'LoaderCircle' : 'FileText'" :class="{ spin: operation === 'summary' }" :size="15" />查看当前会话记忆</button>
    </div>
    <p v-if="!threadId" class="codex-memory-note">打开所选主机的会话后，可查看该会话的记忆。</p>
    <p v-if="status" class="codex-memory-status" role="status">已整合 {{ status.v2ConsolidatedThreads }} 条会话 · {{ status.v2Ready ? 'V2 记忆已就绪' : 'V2 记忆尚未就绪' }}</p>
    <div v-if="summaryRead" class="codex-memory-summary"><pre v-if="summary">{{ summary }}</pre><p v-else class="codex-memory-note">此会话暂无可读取的记忆摘要。记忆可能未启用或尚未生成。</p></div>
    <p v-if="error" class="panel-error" role="alert"><Icon name="AlertCircle" :size="16" />{{ error }}</p>
  </section>
</template>

<style scoped>
.codex-memory { border-top:1px solid var(--border); margin-top:26px; padding-top:22px; }
.codex-memory h4 { font-size:13px; font-weight:500; margin-bottom:10px; }
.codex-memory-note { font-size:11px; color:var(--muted); line-height:1.8; }
.codex-memory-actions { display:flex; gap:8px; flex-wrap:wrap; margin:14px 0; }
.codex-memory-status { font-size:12px; line-height:1.8; }
.codex-memory-summary { border:1px solid var(--border); border-radius:9px; padding:12px; margin-top:12px; }
.codex-memory-summary pre { font:12px/1.8 var(--font-sans, sans-serif); white-space:pre-wrap; overflow-wrap:anywhere; max-height:400px; overflow:auto; }
.panel-error { margin-top:12px; }
@media(max-width:760px) { .codex-memory h4 { font-size:15px; } .codex-memory-note { font-size:13px; } .codex-memory-actions > button { min-height:42px; } .codex-memory-summary pre { font-size:13px; } }
</style>
