<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
const props = defineProps<{ api: any; state: any }>()
const port = ref(5173)
const path = ref('/')
const preview = ref<{ id: string; url: string; expiresAt: number }>()
const busy = ref(false)
const error = ref('')
const mobile = ref(false)
let generation = 0
let mounted = true
const hostName = computed(() => props.state.hosts?.find((host: any) => host.id === props.state.hostId)?.name || props.state.hostId)
async function release(id?: string) {
  if (!id) return
  try { await props.api.requestHttp(`/dev-previews/${encodeURIComponent(id)}`, { method: 'DELETE' }) } catch { /* Expired authentication also invalidates the ticket. */ }
}
async function close() {
  generation++
  const id = preview.value?.id
  preview.value = undefined
  busy.value = false
  await release(id)
}
async function open() {
  const scope = ++generation
  const hostId = props.state.hostId
  const previous = preview.value?.id
  preview.value = undefined
  error.value = ''
  busy.value = true
  try {
    await release(previous)
    const result = await props.api.requestHttp('/dev-previews', { method: 'POST', body: JSON.stringify({ hostId, port: Number(port.value), path: path.value || '/' }) })
    if (!mounted || scope !== generation || props.state.hostId !== hostId) { await release(result.id); return }
    preview.value = result
  } catch (cause: any) { if (scope === generation) error.value = cause.message || '无法打开开发服务' }
  finally { if (scope === generation) busy.value = false }
}
watch(() => props.state.hostId, () => { void close() })
onBeforeUnmount(() => { mounted = false; void close() })
</script>

<template>
  <div class="development-preview">
    <form class="dev-preview-controls" @submit.prevent="open">
      <label>端口<input v-model.number="port" type="number" min="1024" max="65535" inputmode="numeric" aria-label="开发服务端口" /></label>
      <label class="dev-path">路径<input v-model="path" placeholder="/" aria-label="开发服务路径" /></label>
      <button type="submit" class="button button-small button-secondary" :disabled="busy || !state.connected"><Icon :name="busy ? 'LoaderCircle' : 'ArrowRight'" :size="14" />{{ busy ? '连接中' : '连接' }}</button>
    </form>
    <div class="dev-preview-status"><span>{{ hostName }} · 127.0.0.1:{{ port }}</span><span>HTTP / WebSocket</span></div>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <div v-if="preview" class="dev-preview-actions">
      <div class="segmented-control"><button :class="{ active: !mobile }" @click="mobile = false" title="开发服务桌面预览" aria-label="开发服务桌面预览"><Icon name="Monitor" :size="15" /></button><button :class="{ active: mobile }" @click="mobile = true" title="开发服务手机预览" aria-label="开发服务手机预览"><Icon name="Smartphone" :size="15" /></button></div>
      <span class="dev-preview-expiry">预览连接最长 1 小时</span>
      <button class="icon-button" @click="open" title="重新连接开发服务" aria-label="重新连接开发服务"><Icon name="RefreshCw" :size="15" /></button>
      <button class="icon-button" @click="close" title="关闭开发服务预览" aria-label="关闭开发服务预览"><Icon name="X" :size="15" /></button>
    </div>
    <div v-if="preview" class="dev-preview-frame" :class="{ mobile }"><iframe :src="preview.url" title="开发服务预览" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></div>
    <div v-else class="dev-preview-empty"><Icon name="Globe" :size="30" /><p>连接所选主机的开发服务</p><span>先在终端启动 Vite 等服务，然后输入端口。SSH 主机会建立本地转发，预览内容在隔离框架中运行。</span></div>
  </div>
</template>

<style scoped>
.development-preview { display:flex;flex-direction:column;min-height:0;min-width:0;flex:1; }
.dev-preview-controls { display:flex;flex-shrink:0;gap:8px;padding:12px;border-bottom:1px solid var(--border);align-items:end; }
.dev-preview-controls label { display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--text-muted); }
.dev-preview-controls input { width:80px;min-width:0;border:1px solid var(--border);border-radius:7px;padding:7px 8px;background:var(--bg);color:var(--text); }
.dev-preview-controls .dev-path { flex:1;min-width:0; }
.dev-preview-controls .dev-path input { width:100%; }
.dev-preview-status { display:flex;flex-shrink:0;justify-content:space-between;gap:6px;padding:8px 12px;color:var(--text-muted);font-size:10px; }
.dev-preview-actions { display:flex;flex-shrink:0;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--border); }
.dev-preview-expiry { flex:1;color:var(--text-muted);font-size:10px;text-align:right; }
.dev-preview-frame { flex:1;min-height:0;background:#e8e8e8;display:flex;justify-content:center;overflow:hidden; }
.dev-preview-frame iframe { display:block;width:100%;height:100%;min-height:0;border:0;background:#fff; }
.dev-preview-frame.mobile iframe { max-width:390px; }
.dev-preview-empty { margin:auto;padding:32px 24px;text-align:center;color:var(--text-muted); }
.dev-preview-empty p { margin:12px 0 8px;font-size:14px;color:var(--text); }
.dev-preview-empty span { font-size:12px;line-height:1.7; }
.inline-error { padding:8px 12px; }
@media(max-width:760px) { .dev-preview-controls input { padding:10px 8px; } .dev-preview-controls button { min-height:38px; } }
</style>
