<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import Icon from './Icon.vue'
import ConversationImage from './ConversationImage.vue'
import { diffStats } from '../lib/diff-stats'

const props = defineProps<{
  item: any
  hostId?: string
  busy?: boolean
  canFork?: boolean
  canEdit?: boolean
  editing?: boolean
  editDisabled?: boolean
  editSession?: { itemId: string; draft: string; error: string; saving: boolean } | null
  beginEdit?: (item: any, text: string) => void
  cancelEdit?: () => void
  saveEdit?: () => Promise<void>
}>()
const emit = defineEmits<{ fork: [turnId?: string]; openFile: [path: string]; error: [message: string] }>()
const copied = ref(false)
const editorOpen = computed(() => props.editSession?.itemId === props.item.id)
const editDraft = computed({
  get: () => props.editSession?.draft || '',
  set: (value: string) => { if (props.editSession) props.editSession.draft = value },
})
const editInput = ref<HTMLTextAreaElement>()
const editPending = computed(() => props.editSession?.saving || props.editing)
const hasEditInput = computed(() => !!editDraft.value.trim() ||
  (props.item.content || []).some((input: any) => ['image', 'localImage'].includes(input.type)))
const text = computed(() => props.item.text || (props.item.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'))
const html = computed(() => DOMPurify.sanitize(marked.parse(text.value, { async: false }) as string, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'iframe', 'form', 'input'] }))
const userImages = computed(() => (props.item.content || []).filter((c: any) => c.type === 'image' && /^data:image\/|^https?:\/\//.test(c.url || '')))
const localImages = computed(() => (props.item.content || []).filter((c: any) => c.type === 'localImage' && c.path))
const readActions = computed(() => (props.item.commandActions || []).filter((action: any) => action.type === 'read'))
const toolTitle = computed(() => {
  const item = props.item
  if (item.type === 'commandExecution' && readActions.value.length) return ['inProgress', 'running'].includes(item.status) ? '正在读取' : '已读取'
  const labels: Record<string, string> = { commandExecution: '运行命令', fileChange: '修改文件', mcpToolCall: `${item.server || 'MCP'} · ${item.tool || '工具'}`, dynamicToolCall: item.tool || '工具调用', collabAgentToolCall: '协作代理', subAgentActivity: '代理动态', webSearch: '搜索网页', imageView: '查看图片', imageGeneration: '生成图片', enteredReviewMode: '开始代码审查', exitedReviewMode: '代码审查完成', hookPrompt: '项目上下文', functionCallOutput: item.name || '工具结果' }
  return labels[item.type] || item.type
})
const toolSummary = computed(() => props.item.type === 'fileChange' ? (props.item.changes || []).map((change: any) => change.path.split('/').pop()).join('、') : readActions.value.length ? readActions.value.map((action: any) => action.name || action.path?.split('/').pop()).join('、') : props.item.command || props.item.query || props.item.path || '')
const totalChanges = computed(() => (props.item.changes || []).reduce((sum: any, change: any) => { const count = diffStats(change.diff); return { added: sum.added + count.added, removed: sum.removed + count.removed } }, { added: 0, removed: 0 }))
const toolIcon = computed(() => readActions.value.length ? 'BookOpen' : ({ commandExecution: 'Terminal', fileChange: 'GitCompareArrows', mcpToolCall: 'Package', dynamicToolCall: 'Zap', collabAgentToolCall: 'Bot', webSearch: 'Globe', imageView: 'Image', imageGeneration: 'Image', enteredReviewMode: 'Eye', exitedReviewMode: 'CheckCircle2' } as Record<string, string>)[props.item.type] || 'Code2')
const toolOpenByDefault = computed(() => !!props.busy && !['commandExecution', 'fileChange'].includes(props.item.type))
const status = computed(() => props.item.status === 'inProgress' || props.item.status === 'running' ? '处理中' : props.item.status === 'failed' ? '失败' : props.item.exitCode != null ? `退出 ${props.item.exitCode}` : '')
const detailsText = computed(() => props.item.aggregatedOutput || props.item.review || props.item.prompt || (props.item.result ? JSON.stringify(props.item.result, null, 2) : props.item.arguments ? JSON.stringify(props.item.arguments, null, 2) : props.item.output ? JSON.stringify(props.item.output, null, 2) : JSON.stringify(props.item, null, 2)))
async function copy() {
  try { await navigator.clipboard.writeText(text.value); copied.value = true; setTimeout(() => { copied.value = false }, 1600) }
  catch { emit('error', '无法复制到剪贴板，请检查浏览器权限。') }
}
function resizeEditor() {
  if (!editInput.value) return
  editInput.value.style.height = 'auto'
  editInput.value.style.height = `${editInput.value.scrollHeight}px`
}
onMounted(() => {
  if (editorOpen.value) resizeEditor()
})
async function beginEdit() {
  if (!props.canEdit || editPending.value || !props.beginEdit) return
  props.beginEdit(props.item, text.value)
  await nextTick()
  resizeEditor()
  editInput.value?.focus()
}
function cancelEdit() {
  if (editPending.value) return
  props.cancelEdit?.()
}
async function saveEdit() {
  if (props.editDisabled || editPending.value || !hasEditInput.value) return
  await props.saveEdit?.()
}
function onEditKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
  } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void saveEdit()
  }
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
    <div v-if="localImages.length" class="message-images"><ConversationImage v-for="(img, index) in localImages" :key="img.path + index" :path="img.path" :host-id="hostId || 'local'" @open-file="emit('openFile', $event)" /></div>
    <form v-if="editorOpen" class="message-editor" @submit.prevent="saveEdit">
      <textarea ref="editInput" v-model="editDraft" aria-label="编辑消息内容" rows="3" :disabled="editPending" @input="resizeEditor" @keydown="onEditKeydown"></textarea>
      <p class="message-edit-note">重新发送会替换本轮回复，已执行的文件修改不会撤销。</p>
      <p v-if="editSession?.error" class="message-edit-error" role="alert">{{ editSession.error }}</p>
      <div class="message-edit-buttons">
        <button type="button" class="button button-small button-secondary" :disabled="editPending" @click="cancelEdit">取消</button>
        <button type="submit" class="button button-small button-primary" :disabled="editPending || editDisabled || !hasEditInput"><Icon v-if="editPending" name="LoaderCircle" :size="15" class="spin" />{{ editPending ? '正在重新发送…' : '保存并重新发送' }}</button>
      </div>
    </form>
    <div v-else class="user-bubble">{{ text }}</div>
    <div v-if="!editorOpen && (text || canEdit || canFork)" class="message-actions">
      <button v-if="text" class="icon-button" @click="copy" :title="copied ? '已复制' : '复制消息'" aria-label="复制消息"><Icon :name="copied ? 'Check' : 'Copy'" :size="15" /></button>
      <button v-if="canEdit && beginEdit" class="icon-button" :disabled="editPending" @click="beginEdit" title="编辑消息" aria-label="编辑消息"><Icon name="Pencil" :size="15" /></button>
      <button v-if="canFork" class="icon-button" @click="emit('fork', item.turnId)" title="从此处创建分支" aria-label="从此处创建分支"><Icon name="GitBranch" :size="15" /></button>
    </div>
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
  <details v-else class="tool-item" :open="toolOpenByDefault" :class="{ 'tool-failed': item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0) }">
    <summary><Icon :name="toolIcon" :size="16" /><span class="tool-title">{{ toolTitle }}</span><span v-if="toolSummary" class="tool-command" :title="toolSummary">{{ toolSummary }}</span><span v-if="item.type === 'fileChange'" class="diff-stats"><span class="diff-count-add">+{{ totalChanges.added }}</span><span class="diff-count-remove">−{{ totalChanges.removed }}</span></span><span class="tool-status">{{ status }}</span><Icon name="ChevronDown" :size="13" /></summary>
    <div v-if="item.type === 'fileChange'" class="file-changes">
      <details v-for="change in item.changes" :key="change.path" class="file-diff">
        <summary class="file-diff-heading"><Icon name="FileText" :size="15" /><span class="file-diff-path" :title="change.path">{{ change.path }}</span><span class="diff-stats"><span class="diff-count-add">+{{ diffStats(change.diff).added }}</span><span class="diff-count-remove">−{{ diffStats(change.diff).removed }}</span></span><span>{{ typeof change.kind === 'string' ? change.kind : Object.keys(change.kind || {})[0] }}</span><button class="icon-button" :aria-label="`打开文件 ${change.path}`" :title="`打开文件 ${change.path}`" @click.stop.prevent="emit('openFile', change.path)"><Icon name="ArrowUpRight" :size="14" /></button><Icon name="ChevronDown" :size="14" /></summary>
        <pre class="diff-code"><span v-for="(line, index) in (change.diff || '').split('\n')" :key="index" :class="line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''">{{ line + '\n' }}</span></pre>
      </details>
    </div>
    <div v-else-if="item.type === 'imageView' && item.path" class="tool-content"><ConversationImage :path="item.path" :host-id="hostId || 'local'" @open-file="emit('openFile', $event)" /></div>
    <div v-else class="tool-content"><div v-if="item.cwd" class="tool-cwd">{{ item.cwd }}</div><pre v-if="item.command" class="command-code">$ {{ item.command }}</pre><pre>{{ detailsText }}</pre></div>
  </details>
</template>

<style scoped>
.file-diff > summary { list-style: none; cursor: pointer; }
.file-diff > summary::-webkit-details-marker { display: none; }
.file-diff-heading .file-diff-path { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-diff > summary > svg:last-child { transition: transform .15s; }
.file-diff[open] > summary > svg:last-child { transform: rotate(180deg); }
.message-editor {
  width: min(100%, 680px);
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--soft);
}
.message-editor textarea {
  display: block;
  width: 100%;
  min-height: 84px;
  max-height: 340px;
  padding: 5px 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  resize: vertical;
  font: inherit;
  font-size: 13px;
  line-height: 1.8;
}
.message-edit-note,
.message-edit-error {
  margin: 10px 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
}
.message-edit-error {
  color: var(--red);
}
.message-edit-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
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
  .message-editor textarea {
    font-size: 16px;
  }
  .user-message .message-actions .icon-button {
    width: 36px;
    height: 36px;
  }
  .message-edit-buttons .button {
    min-height: 36px;
  }
  .reasoning-item > summary,
  .tool-item > summary {
    min-height: 40px;
  }
  .tool-content pre {
    font-size: 12px;
  }
}
</style>
