<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { methodAccepts, mcpAuthLabel, mcpRuntimeLabel, safeAuthorizationUrl, type IntegrationCapabilities } from '../lib/integration-capabilities';
const props = defineProps<{ api: any; state: any }>();
const capabilities = ref<IntegrationCapabilities | null>(null);
const loading = ref(false);
const saving = ref('');
const error = ref('');
const notice = ref('');
const authorization = ref<{ name: string; url: string } | null>(null);
let generation = 0;
let disposed = false;
const skills = computed(() => {
  const source = Array.isArray(props.state.skills) ? props.state.skills : props.state.skills?.data || [];
  return source.flatMap((entry: any) => entry.skills || [entry]);
});
const apps = computed(() => Array.isArray(props.state.apps) ? props.state.apps : props.state.apps?.data || []);
const servers = computed(() => Array.isArray(props.state.mcpServers) ? props.state.mcpServers : props.state.mcpServers?.data || []);
const ready = computed(() => props.state.connected && !props.state.runtimePaused && !props.state.switchingHost);
const scope = () => JSON.stringify([props.state.hostId, props.api.runtimeIdentity?.()]);
const canReload = computed(() => methodAccepts(capabilities.value, 'config/mcpServer/reload', []));
const capabilityNotice = computed(() => ({ proxy_runtime: '当前连接使用原生代理，无法用本机 CLI 协议确认代理进程的版本。原生操作暂不显示，请使用直接连接并刷新。', runtime_version_unknown: '当前连接未报告可验证的 Codex 版本。重新连接 Web Codex 后可刷新操作能力。', runtime_version_mismatch: '安装的 Codex 已更新，但当前连接仍使用旧版本。重新连接 Web Codex 后可刷新操作能力。' } as Record<string, string>)[capabilities.value?.reason || ''] || '暂时无法确认主机原生协议。清单仍可查看，更新 Codex 后可刷新操作能力。');
function skillParams(skill: any, enabled: boolean) {
  if (typeof skill.path === 'string' && skill.path.startsWith('/') && methodAccepts(capabilities.value, 'skills/config/write', ['path', 'enabled'])) return { path: skill.path, enabled };
  if (typeof skill.name === 'string' && skill.name && methodAccepts(capabilities.value, 'skills/config/write', ['name', 'enabled'])) return { name: skill.name, enabled };
  return null;
}
function loginParams(server: any) {
  if (!['notLoggedIn', 'oAuth'].includes(server.authStatus) || typeof server.name !== 'string' || !server.name) return null;
  const threadId = props.state.activeThread?.id;
  if (threadId && methodAccepts(capabilities.value, 'mcpServer/oauth/login', ['name', 'threadId'])) return { name: server.name, threadId };
  return methodAccepts(capabilities.value, 'mcpServer/oauth/login', ['name']) ? { name: server.name } : null;
}
async function readCapabilities() {
  const current = scope(); const token = generation;
  const result = await props.api.requestHttp(`/hosts/${encodeURIComponent(props.state.hostId)}/native-capabilities`, { signal: AbortSignal.timeout(20000) }, false);
  if (disposed || current !== scope() || token !== generation) return null;
  capabilities.value = result;
  return result;
}
async function refresh() {
  const token = ++generation; const current = scope();
  loading.value = true; error.value = '';
  try {
    if (!ready.value) return;
    await Promise.all([readCapabilities(), props.api.loadIntegrations()]);
  } catch (cause: any) { if (!disposed && token === generation && current === scope()) error.value = cause.message || '无法刷新集成'; }
  finally { if (token === generation) loading.value = false; }
}
async function operation(key: string, method: string, params: () => any, after: (result: any) => Promise<void>, message: string) {
  if (saving.value || !ready.value) return;
  const token = generation; const current = scope();
  saving.value = key; error.value = ''; notice.value = ''; authorization.value = null;
  try {
    await readCapabilities();
    if (disposed || token !== generation || current !== scope()) return;
    const input = params();
    if (input === null || !methodAccepts(capabilities.value, method, input === undefined ? [] : Object.keys(input))) throw new Error('当前主机协议未确认支持此操作，请更新 Codex 后刷新集成。');
    const result = await props.api.rpc(method, input, 30000, { silentError: true });
    if (disposed || token !== generation || current !== scope()) return;
    await after(result);
    if (token === generation && current === scope()) notice.value = message;
  } catch (cause: any) {
    if (!disposed && token === generation && current === scope()) {
      if (cause.code === -32601 && capabilities.value?.methods[method]) capabilities.value.methods[method].available = false;
      error.value = cause.code === -32601 ? '此主机的 Codex 尚不支持该操作，请更新后重试。' : cause.message || '集成操作失败';
    }
  } finally { if (token === generation) saving.value = ''; }
}
async function toggleSkill(skill: any) {
  const enabled = skill.enabled === false;
  await operation(`skill:${skill.path || skill.name}`, 'skills/config/write', () => skillParams(skill, enabled), async result => {
    if (props.api.loadSkills) await props.api.loadSkills({ forceReload: true });
    else await props.api.loadIntegrations();
    if (typeof result?.effectiveEnabled === 'boolean' && result.effectiveEnabled !== enabled) throw new Error(`当前主机策略保持此技能${result.effectiveEnabled ? '启用' : '禁用'}，请求未生效。`);
  }, `${skill.name || '技能'}已${enabled ? '启用' : '禁用'}，从下次任务生效`);
}
async function reloadMcp() {
  await operation('mcp:reload', 'config/mcpServer/reload', () => undefined, async () => { await props.api.loadIntegrations(); }, 'MCP 配置已重新加载。点击刷新可查看最新连接状态。');
}
async function loginMcp(server: any) {
  if (saving.value || !ready.value) return;
  const token = generation; const current = scope(); saving.value = `mcp:${server.name}`; error.value = ''; notice.value = ''; authorization.value = null;
  try {
    await readCapabilities();
    if (disposed || token !== generation || current !== scope()) return;
    const params = loginParams(server);
    if (!params) throw new Error('当前主机未确认支持此服务器的 OAuth 登录。');
    const result = await props.api.rpc('mcpServer/oauth/login', params, 30000, { silentError: true });
    if (disposed || token !== generation || current !== scope()) return;
    const url = safeAuthorizationUrl(result?.authorizationUrl);
    if (!url) throw new Error('主机没有返回有效的安全授权地址。');
    authorization.value = { name: server.name, url }; notice.value = '点击授权链接完成登录，然后刷新集成。';
  } catch (cause: any) {
    if (!disposed && token === generation && current === scope()) {
      if (cause.code === -32601 && capabilities.value?.methods['mcpServer/oauth/login']) capabilities.value.methods['mcpServer/oauth/login'].available = false;
      error.value = cause.code === -32601 ? '此主机不支持 MCP OAuth 登录，请更新 Codex。' : cause.message || '无法开始授权';
    }
  } finally { if (token === generation) saving.value = ''; }
}
watch(() => [props.state.hostId, ready.value], () => {
  ++generation; capabilities.value = null; authorization.value = null; error.value = ''; notice.value = ''; saving.value = ''; loading.value = false;
  if (ready.value) void refresh();
});
onMounted(() => { void refresh(); });
onBeforeUnmount(() => { disposed = true; ++generation; });
</script>
<template>
  <div class="integrations-settings">
    <div class="integration-heading"><h3>技能与集成</h3><button class="icon-button" :disabled="loading || !!saving || !ready" aria-label="刷新集成" title="刷新集成" @click="refresh"><Icon :name="loading ? 'LoaderCircle' : 'RefreshCw'" :class="{spin: loading}" :size="16" /></button></div>
    <p class="integration-description">当前主机的技能、应用和 MCP。原生操作按该主机实际协议显示，配置更改从下一次任务生效。</p>
    <p v-if="!ready" class="integration-note">连接 Web Codex 后可管理当前主机的集成。</p>
    <p v-else-if="capabilities?.status === 'unknown'" class="integration-note">{{ capabilityNotice }}</p>
    <div v-if="error" class="integration-error" role="alert"><Icon name="AlertCircle" :size="15" />{{ error }}</div>
    <div v-if="notice" class="integration-note" role="status">{{ notice }}</div>
    <a v-if="authorization" :href="authorization.url" target="_blank" rel="noopener noreferrer" class="authorization-link">在浏览器授权 {{ authorization.name }}<Icon name="ExternalLink" :size="14" /></a>
    <p v-for="entry in state.integrationErrors || []" :key="entry.source" class="integration-note">{{ entry.source }} 清单读取失败，请检查主机配置后刷新。</p>
    <h4>技能 <span class="count-badge">{{ skills.length }}</span></h4>
    <div class="integration-list">
      <div v-for="(skill,index) in skills" :key="skill.path || skill.name || index" class="integration-entry"><Icon name="Sparkles" :size="18" /><div><strong>{{ skill.name || skill.displayName }}</strong><p>{{ skill.description || skill.shortDescription }}</p><code v-if="skill.path">{{ skill.path }}</code></div><span class="integration-status">{{ skill.enabled === false ? '已禁用' : '可用' }}</span><button v-if="skillParams(skill,skill.enabled === false)" class="button button-small button-secondary" :disabled="!!saving || !ready || loading" :aria-label="`${skill.enabled === false ? '启用' : '禁用'}技能 ${skill.name}`" @click="toggleSkill(skill)">{{ skill.enabled === false ? '启用' : '禁用' }}</button></div>
      <p v-if="!skills.length" class="integration-empty">当前主机暂无可用技能。</p>
    </div>
    <h4>应用 <span class="count-badge">{{ apps.length }}</span></h4>
    <div class="integration-list"><div v-for="(app,index) in apps" :key="app.id || index" class="integration-entry"><Icon name="Package" :size="18" /><div><strong>{{ app.name || app.id }}</strong><p>{{ app.description }}</p></div><span class="integration-status">{{ app.isAccessible === false ? '未连接' : '可用' }}</span></div><p v-if="!apps.length" class="integration-empty">当前主机暂无可用应用。</p></div>
    <div class="integration-heading"><h4>MCP 服务器 <span class="count-badge">{{ servers.length }}</span></h4><button v-if="canReload" class="button button-small button-secondary" :disabled="!!saving || !ready || loading" @click="reloadMcp"><Icon name="RefreshCw" :size="14" />重新加载 MCP</button></div>
    <div class="integration-list"><div v-for="(server,index) in servers" :key="server.name || index" class="integration-entry"><Icon name="Server" :size="18" /><div><strong>{{ server.name || server.id }}</strong><p>{{ mcpRuntimeLabel(server.runtimeStatus) }} · {{ mcpAuthLabel(server.authStatus) }} · {{ Object.keys(server.tools || {}).length }} 个工具</p><p v-if="server.toolsError">工具清单读取失败，请检查服务器连接或重新登录。</p></div><button v-if="loginParams(server)" class="button button-small button-secondary" :disabled="!!saving || !ready || loading" :aria-label="`${server.authStatus === 'oAuth' ? '重新登录' : '登录'} MCP ${server.name}`" @click="loginMcp(server)">{{ server.authStatus === 'oAuth' ? '重新登录' : '登录' }}</button></div><p v-if="!servers.length" class="integration-empty">当前主机暂无 MCP 服务器。</p></div>
  </div>
</template>
<style scoped>
.integration-heading { display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px; }.integration-heading h3,.integration-heading h4 { margin:0; }
h3 { font-size:18px;font-weight:550; }h4 { font-size:13px;font-weight:550;margin:26px 0 12px; }
.integration-description,.integration-note,.integration-empty { color:var(--muted);font-size:12px;line-height:1.7; }.integration-description { margin-bottom:20px; }.integration-note { margin:12px 0; }
.integration-list { border:1px solid var(--border);border-radius:10px;overflow:hidden; }.integration-entry { display:flex;align-items:center;gap:12px;padding:14px;border-bottom:1px solid var(--border); }.integration-entry:last-child { border:0; }
.integration-entry > svg { flex-shrink:0;color:var(--muted); }.integration-entry > div { min-width:0;flex:1; }.integration-entry strong { font-size:12px;font-weight:550;overflow-wrap:anywhere; }.integration-entry p { color:var(--muted);font-size:11px;line-height:1.7;margin:4px 0;overflow-wrap:anywhere; }.integration-entry code { display:block;font-size:10px;color:var(--muted);overflow-wrap:anywhere; }
.integration-status { color:var(--muted);font-size:11px;white-space:nowrap; }.integration-empty { padding:16px; }.count-badge { font-size:11px;color:var(--muted);font-weight:400; }
.authorization-link { display:inline-flex;align-items:center;gap:5px;color:var(--accent);font-size:12px;overflow-wrap:anywhere; }.integration-error { display:flex;gap:7px;color:var(--danger);font-size:12px;line-height:1.7;margin:12px 0; }
@media(max-width:760px) { .integration-entry { gap:9px;padding:12px;flex-wrap:wrap; }.integration-entry > div { flex-basis:calc(100% - 32px); }.integration-entry > button { margin-left:auto;min-height:36px; }.integration-entry strong,.integration-description,.integration-note { font-size:13px; }.integration-entry p { font-size:12px; } }
</style>
