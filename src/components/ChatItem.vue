<script setup lang="ts">
import { computed, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import Icon from './Icon.vue'

const props = defineProps<{ item: any; busy?: boolean; canFork?: boolean }>()
const emit = defineEmits<{ fork: [turnId?: string]; openFile: [path: string]; error: [message: string] }>()
const copied = ref(false)
const text = computed(() => props.item.text || (props.item.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'))
const html = computed(() => DOMPurify.sanitize(marked.parse(text.value, { async: false }) as string, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'iframe', 'form', 'input'] }))
const userImages = computed(() => (props.item.content || []).filter((c: any) => c.type === 'image' && /^data:image\/|^https?:\/\//.test(c.url || '')))
const localImages = computed(() => (props.item.content || []).filter((c: any) => c.type === 'localImage' && c.path))
const toolTitle = computed(() => {
  const item = props.item
  const labels: Record<string, string> = { commandExecution: '运行命令', fileChange: '修改文件', mcpToolCall: `${item.server || 'MCP'} · ${item.tool || '工具'}`, dynamicToolCall: item.tool || '工具调用', collabAgentToolCall: '协作代理', subAgentActivity: '代理动态', webSearch: '搜索网页', imageView: '查看图片', imageGeneration: '生成图片', enteredReviewMode: '开始代码审查', exitedReviewMode: '代码审查完成', hookPrompt: '项目上下文', functionCallOutput: item.name || '工具结果' }
  return labels[item.type] || item.type
})
const toolIcon = computed(() => ({ commandExecution: 'Terminal', fileChange: 'GitCompareArrows', mcpToolCall: 'Package', dynamicToolCall: 'Zap', collabAgentToolCall: 'Bot', webSearch: 'Globe', imageView: 'Image', imageGeneration: 'Image', enteredReviewMode: 'Eye', exitedReviewMode: 'CheckCircle2' } as Record<string, string>)[props.item.type] || 'Code2')
const status = computed(() => props.item.status === 'inProgress' || props.item.status === 'running' ? '处理中' : props.item.status === 'failed' ? '失败' : props.item.exitCode != null ? `退出 ${props.item.exitCode}` : '')
const detailsText = computed(() => props.item.aggregatedOutput || props.item.review || props.item.prompt || (props.item.result ? JSON.stringify(props.item.result, null, 2) : props.item.arguments ? JSON.stringify(props.item.arguments, null, 2) : props.item.output ? JSON.stringify(props.item.output, null, 2) : JSON.stringify(props.item, null, 2)))
async function copy() {
  try { await navigator.clipboard.writeText(text.value); copied.value = true; setTimeout(() => { copied.value = false }, 1600) }
  catch { emit('error', '无法复制到剪贴板，请检查浏览器权限。') }
}
function onLink(event: MouseEvent) {
  const anchor = (event.target as Element).closest('a')
  if (!anchor) return
  const href = anchor.getAttribute('href') || ''
  if (href.startsWith('/') && !href.startsWith('//')) { event.preventDefault(); emit('openFile', href.replace(/:\d+(?::\d+)?$/, '')) }
  else { anchor.setAttribute('target', '_blank'); anchor.setAttribute('rel', 'noopener noreferrer') }
}
</script>

<template>
  <article v-if="item.type === 'userMessage'" class="message user-message">
    <div v-if="userImages.length" class="message-images"><img v-for="(img, index) in userImages" :key="index" :src="img.url" alt="上传的图片" loading="lazy" /></div>
    <div v-if="localImages.length" class="message-images"><button v-for="(img, index) in localImages" :key="index" class="button button-secondary" @click="emit('openFile', img.path)"><Icon name="Image" :size="16" />{{ img.path.split('/').pop() }}<Icon name="Eye" :size="14" /></button></div>
    <div class="user-bubble">{{ text }}</div>
    <div v-if="canFork" class="message-actions"><button class="icon-button" @click="emit('fork', item.turnId)" title="从此处创建分支" aria-label="从此处创建分支"><Icon name="GitBranch" :size="15" /></button></div>
  </article>
  <article v-else-if="item.type === 'agentMessage'" class="message agent-message">
    <div v-if="text" class="markdown" v-html="html" @click="onLink"></div>
    <div v-else class="thinking-line"><span class="thinking-dot"></span>正在思考</div>
    <div v-if="text && (!busy || canFork)" class="message-actions">
      <button class="icon-button" @click="copy" :title="copied ? '已复制' : '复制回复'" aria-label="复制回复"><Icon :name="copied ? 'Check' : 'Copy'" :size="15" /></button>
      <button v-if="canFork" class="icon-button" @click="emit('fork', item.turnId)" title="从此处创建分支" aria-label="从此处创建分支"><Icon name="GitBranch" :size="15" /></button>
    </div>
  </article>
  <details v-else-if="item.type === 'reasoning'" class="reasoning-item" :open="!!busy">
    <summary><Icon name="Sparkles" :size="15" />思考过程<Icon name="ChevronDown" :size="13" /></summary>
    <div class="reasoning-content">{{ (item.summary || []).join('\n\n') || '此模型未提供公开的思考摘要。' }}</div>
  </details>
  <div v-else-if="item.type === 'contextCompaction'" class="compaction-divider"><span></span><Icon name="RefreshCw" :size="13" />上下文已压缩<span></span></div>
  <article v-else-if="item.type === 'plan'" class="plan-card"><div class="tool-heading"><Icon name="ListTodo" :size="16" />计划</div><div class="markdown" v-html="html"></div></article>
  <details v-else class="tool-item" :open="!!busy" :class="{ 'tool-failed': item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0) }">
    <summary><Icon :name="toolIcon" :size="16" /><span class="tool-title">{{ toolTitle }}</span><code v-if="item.command" class="tool-command">{{ item.command }}</code><span class="tool-status">{{ status }}</span><Icon name="ChevronDown" :size="13" /></summary>
    <div v-if="item.type === 'fileChange'" class="file-changes">
      <div v-for="change in item.changes" :key="change.path" class="file-diff">
        <button class="file-diff-heading" @click="emit('openFile', change.path)"><Icon name="FileText" :size="15" />{{ change.path }}<span>{{ typeof change.kind === 'string' ? change.kind : Object.keys(change.kind || {})[0] }}</span><Icon name="ArrowUpRight" :size="14" /></button>
        <pre class="diff-code"><span v-for="(line, index) in (change.diff || '').split('\n')" :key="index" :class="line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''">{{ line + '\n' }}</span></pre>
      </div>
    </div>
    <div v-else class="tool-content"><div v-if="item.cwd" class="tool-cwd">{{ item.cwd }}</div><pre v-if="item.command" class="command-code">$ {{ item.command }}</pre><pre>{{ detailsText }}</pre></div>
  </details>
</template>

<style scoped>
.reasoning-item > summary {
  min-height: 32px;
  font-size: 12px;
}
.reasoning-content {
  padding: 10px 0;
  font-size: 12px;
  line-height: 1.7;
}
.reasoning-item > summary > svg:last-child,
.tool-item > summary > svg:last-child {
  transition: transform 0.15s;
}
.reasoning-item[open] > summary > svg:last-child,
.tool-item[open] > summary > svg:last-child {
  transform: rotate(180deg);
}
@media (max-width: 760px) {
  .reasoning-item > summary,
  .tool-item > summary {
    min-height: 40px;
  }
  .tool-content pre {
    font-size: 12px;
  }
}
</style>
