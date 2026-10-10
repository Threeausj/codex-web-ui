<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
const props = defineProps<{ api: any; state: any; target?: { port: number; path: string; requestId: number } }>()
const port = ref(5173)
const path = ref('/')
const preview = ref<{ id: string; url: string; expiresAt: number; port: number; path: string }>()
const busy = ref(false)
const error = ref('')
const mobile = ref(false)
const frameLoading = ref(false)
const copied = ref(false)
let generation = 0
let mounted = true
const hostName = computed(() => props.state.hosts?.find((host: any) => host.id === props.state.hostId)?.name || props.state.hostId)
const hostAvailable = computed(() => props.state.authenticated && !!props.state.hosts?.some((host: any) => host.id === props.state.hostId))
const connectedAddress = computed(() => `127.0.0.1:${preview.value?.port ?? port.value}${preview.value?.path || ''}`)
async function release(id?: string) {
  if (!id) return
  try { await props.api.requestHttp(`/dev-previews/${encodeURIComponent(id)}`, { method: 'DELETE' }) } catch { /* Expired authentication also invalidates the ticket. */ }
}
async function close() {
  generation++
  const id = preview.value?.id
  preview.value = undefined
  busy.value = false
  frameLoading.value = false
  copied.value = false
  await release(id)
}
async function open() {
  const targetPort = Number(port.value)
  const targetPath = path.value.trim() || '/'
  if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) { error.value = '请输入 1024–65535 之间的端口'; return }
  if (!targetPath.startsWith('/') || targetPath.startsWith('//') || /[\u0000-\u0020\u007f\\]/.test(targetPath)) { error.value = '路径须以 / 开头，且不能包含空格、控制字符或反斜线'; return }
  const scope = ++generation
  const hostId = props.state.hostId
  const previous = preview.value?.id
  preview.value = undefined
  error.value = ''
  copied.value = false
  frameLoading.value = false
  busy.value = true
  try {
    await release(previous)
    const result = await props.api.requestHttp('/dev-previews', { method: 'POST', body: JSON.stringify({ hostId, port: targetPort, path: targetPath }) })
    if (!mounted || scope !== generation || props.state.hostId !== hostId) { await release(result.id); return }
    frameLoading.value = true
    preview.value = { ...result, port: targetPort, path: targetPath }
  } catch (cause: any) { if (scope === generation) error.value = cause.message || '无法打开开发服务' }
  finally { if (scope === generation) busy.value = false }
}
async function copyUrl() {
  if (!preview.value) return
  const id = preview.value.id
  try {
    await navigator.clipboard.writeText(new URL(preview.value.url, window.location.href).href)
    if (preview.value?.id === id) copied.value = true
  } catch { error.value = '无法复制地址，可使用“在新标签页打开开发服务”按钮' }
}
watch(() => props.target, target => {
  if (!target) return
  port.value = target.port
  path.value = target.path
  void open()
}, { immediate: true })
watch(() => props.state.hostId, () => { void close() })
onBeforeUnmount(() => { mounted = false; void close() })
</script>

<template>
  <div class="development-preview">
    <form class="dev-preview-controls" @submit.prevent="open">
      <label>端口<input v-model.number="port" type="number" min="1024" max="65535" inputmode="numeric" aria-label="开发服务端口" /></label>
      <label class="dev-path">路径<input v-model="path" placeholder="/" aria-label="开发服务路径" /></label>
      <button type="submit" class="button button-small button-secondary" :disabled="busy || !hostAvailable"><Icon :name="busy ? 'LoaderCircle' : 'ArrowRight'" :size="14" />{{ busy ? '连接中' : '连接' }}</button>
    </form>
    <div class="dev-preview-status"><span>{{ hostName }} · {{ connectedAddress }}</span><span>{{ preview ? '已转发 · HTTP / WebSocket' : 'HTTP / WebSocket' }}</span></div>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <div v-if="preview" class="dev-preview-actions">
      <div class="segmented-control"><button :class="{ active: !mobile }" @click="mobile = false" title="开发服务桌面预览" aria-label="开发服务桌面预览"><Icon name="Monitor" :size="15" /></button><button :class="{ active: mobile }" @click="mobile = true" title="开发服务手机预览" aria-label="开发服务手机预览"><Icon name="Smartphone" :size="15" /></button></div>
      <span class="dev-preview-expiry">连接最长 1 小时</span>
      <button class="icon-button" @click="copyUrl" :title="copied ? '已复制转发地址' : '复制转发地址'" :aria-label="copied ? '已复制转发地址' : '复制转发地址'"><Icon :name="copied ? 'Check' : 'Copy'" :size="15" /></button>
      <a :href="preview.url" target="_blank" rel="noopener noreferrer" class="icon-button" title="在新标签页打开开发服务" aria-label="在新标签页打开开发服务"><Icon name="ExternalLink" :size="15" /></a>
      <button class="icon-button" @click="open" :disabled="busy" title="重新连接开发服务" aria-label="重新连接开发服务"><Icon name="RefreshCw" :size="15" /></button>
      <button class="icon-button" @click="close" title="关闭开发服务预览" aria-label="关闭开发服务预览"><Icon name="X" :size="15" /></button>
    </div>
    <div v-if="preview" class="dev-preview-frame" :class="{ mobile }"><iframe :key="preview.id" :src="preview.url" title="开发服务预览" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" @load="frameLoading = false" @error="frameLoading = false; error = '页面加载失败，请检查开发服务或重新连接'"></iframe><div v-if="frameLoading" class="dev-preview-loading" role="status"><Icon name="LoaderCircle" :size="16" />正在加载开发服务…</div></div>
    <div v-else class="dev-preview-empty"><Icon name="Globe" :size="30" /><p>输入端口，直接预览</p><span>先在 {{ hostName }} 启动开发服务，例如 Vite 的 5173 端口。连接后自动转发 HTTP 和 WebSocket；也可复制地址或在新标签页打开。</span></div>
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
.dev-preview-status > span:first-child { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.dev-preview-status > span:last-child { flex-shrink:0; }
.dev-preview-actions { display:flex;flex-shrink:0;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--border); }
.dev-preview-expiry { flex:1;color:var(--text-muted);font-size:10px;text-align:right; }
.dev-preview-frame { position:relative;flex:1;min-height:0;background:var(--soft);display:flex;justify-content:center;overflow:hidden; }
.dev-preview-loading { position:absolute;inset:0;display:flex;justify-content:center;align-items:center;gap:8px;background:var(--surface);color:var(--text-muted);font-size:12px;pointer-events:none; }
.dev-preview-frame iframe { display:block;width:100%;height:100%;min-height:0;border:0;background:var(--surface); }
.dev-preview-frame.mobile iframe { max-width:390px; }
.dev-preview-empty { margin:auto;padding:32px 24px;text-align:center;color:var(--text-muted); }
.dev-preview-empty p { margin:12px 0 8px;font-size:14px;color:var(--text); }
.dev-preview-empty span { font-size:12px;line-height:1.7; }
.inline-error { padding:8px 12px; }
@media(max-width:760px) { .dev-preview-controls input { padding:10px 8px; } .dev-preview-controls button { min-height:38px; } .dev-preview-actions { gap:3px;padding:6px 8px; } .dev-preview-expiry { font-size:9px; } }
</style>
