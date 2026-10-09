<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ToolRequestUserInputQuestion } from '../../shared/protocol/v2/ToolRequestUserInputQuestion'
import { userInputAnswer, userInputAutoResolveAt, userInputAutoResolutionMs, userInputReady, userInputResponse, type UserInputDrafts } from '../lib/user-input'
import Icon from './Icon.vue'
const props = defineProps<{ request: any; api: any; items?: any[] }>()
const answers = reactive<UserInputDrafts>(Object.create(null))
const formAnswers = reactive<Record<string, any>>({})
const responding = ref(false)
const submitted = ref(false)
const error = ref('')
const params = computed(() => props.request.params || {})
const isQuestion = computed(() => props.request.method?.includes('requestUserInput'))
const questions = computed<ToolRequestUserInputQuestion[]>(() => Array.isArray(params.value.questions) ? params.value.questions : [])
const isBlocking = computed(() => params.value.isBlocking !== false)
const autoResolveAt = computed(() => isQuestion.value ? userInputAutoResolveAt(params.value) : null)
const now = ref(Date.now())
const questionExpired = computed(() => autoResolveAt.value !== null && now.value >= autoResolveAt.value)
const legacyTimeout = computed(() => isQuestion.value && !params.value.bridgeUserInputContext && userInputAutoResolutionMs(params.value) !== null)
const countdown = computed(() => {
  const seconds = Math.max(0, Math.ceil(((autoResolveAt.value ?? now.value) - now.value) / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒` : `${seconds} 秒`
})
const questionStatus = computed(() => questionExpired.value ? '回答时限已到，等待服务器跳过'
  : autoResolveAt.value !== null ? isBlocking.value ? '请在时限内回答，也可等待自动跳过' : 'Codex 可继续运行，请在时限内补充回答'
    : isBlocking.value ? '等待你的回答后继续' : 'Codex 可继续运行，回答后会补充给它')
const refreshQuestionTime = () => { now.value = Date.now() }
watch(autoResolveAt, (deadline, _previous, onCleanup) => {
  refreshQuestionTime()
  if (deadline === null || deadline <= Date.now()) return
  const timer = setInterval(() => {
    refreshQuestionTime()
    if (now.value >= deadline) clearInterval(timer)
  }, 250)
  onCleanup(() => clearInterval(timer))
}, { immediate: true })
onMounted(() => {
  document.addEventListener('visibilitychange', refreshQuestionTime)
  window.addEventListener('focus', refreshQuestionTime)
  window.addEventListener('pageshow', refreshQuestionTime)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', refreshQuestionTime)
  window.removeEventListener('focus', refreshQuestionTime)
  window.removeEventListener('pageshow', refreshQuestionTime)
})
const answerCount = computed(() => questions.value.filter(question => userInputAnswer(question, answers[question.id]) !== null).length)
const isPermissions = computed(() => props.request.method?.includes('permissions/requestApproval'))
const isElicitation = computed(() => props.request.method?.includes('elicitation'))
const isFileChange = computed(() => ['item/fileChange/requestApproval', 'applyPatchApproval'].includes(props.request.method))
const network = computed(() => params.value.networkApprovalContext)
const isStdin = computed(() => params.value.kind === 'writeStdin')
const title = computed(() => isQuestion.value ? 'Codex 需要你的选择' : isPermissions.value ? '请求额外权限' : isElicitation.value ? `${params.value.serverName || 'MCP'} 需要你的输入` : isFileChange.value ? '批准文件修改' : network.value ? '批准网络访问' : isStdin.value ? '批准终端输入' : '批准命令执行')
const relatedItem = computed(() => props.items?.find(item => item.id === (params.value.itemId || params.value.callId) &&
  item.turnId === params.value.turnId && (!item.threadId || item.threadId === (params.value.threadId || params.value.conversationId))))
const context = computed(() => params.value.bridgeApprovalContext || {})
const command = computed(() => {
  const value = params.value.command || context.value.command || relatedItem.value?.command
  return Array.isArray(value) ? value.map(part => /\s/.test(String(part)) ? JSON.stringify(part) : String(part)).join(' ') : typeof value === 'string' ? value : ''
})
const cwd = computed(() => params.value.cwd || context.value.cwd || relatedItem.value?.cwd)
const filePaths = computed<string[]>(() => context.value.filePaths || relatedItem.value?.changes?.map((change: any) => change.path) || Object.keys(params.value.fileChanges || {}))
const properties = computed(() => params.value.requestedSchema?.properties || {})
watch(() => props.request.id, () => {
  for (const key of Object.keys(answers)) delete answers[key]
  for (const key of Object.keys(formAnswers)) delete formAnswers[key]
  responding.value = false; submitted.value = false; error.value = ''
}, { immediate: true })
watch(questions, value => {
  for (const question of value) answers[question.id] ||= {}
}, { immediate: true })
function fieldId(question: ToolRequestUserInputQuestion, suffix = '') {
  return `question-${encodeURIComponent(String(props.request.id))}-${encodeURIComponent(question.id)}${suffix}`
}
function allowedDecision(decision: string) {
  return isQuestion.value || isPermissions.value || isElicitation.value || !params.value.availableDecisions?.length || params.value.availableDecisions.includes(decision)
}
const ready = computed(() => isQuestion.value ? !questionExpired.value && userInputReady(questions.value, answers) : isElicitation.value ? (params.value.requestedSchema?.required || []).every((key: string) => formAnswers[key] != null && formAnswers[key] !== '') : true)
async function respond(decision: string) {
  refreshQuestionTime()
  if (responding.value || submitted.value || (decision === 'accept' && !ready.value)) return
  responding.value = true; error.value = ''
  try {
    let result: any = { decision }
    if (isQuestion.value) result = userInputResponse(questions.value, answers)
    else if (isPermissions.value) result = { permissions: decision.startsWith('accept') ? Object.fromEntries(Object.entries(params.value.permissions || {}).filter(([, value]) => value != null)) : {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' }
    else if (isElicitation.value) result = { action: decision === 'accept' ? 'accept' : decision === 'cancel' ? 'cancel' : 'decline', content: decision === 'accept' ? params.value.mode === 'url' ? null : formAnswers : null, _meta: null }
    else if (['execCommandApproval', 'applyPatchApproval'].includes(props.request.method)) result = { decision: decision === 'accept' ? 'approved' : decision === 'acceptForSession' ? 'approved_for_session' : decision === 'cancel' ? 'abort' : { denied: { rejection: 'Declined by the user' } } }
    await props.api.respond(props.request.id, result)
    submitted.value = true
    if (isQuestion.value) for (const question of questions.value) if (question.isSecret) answers[question.id] = {}
  } catch (cause: any) { error.value = isQuestion.value && questions.value.some(question => question.isSecret) ? '发送回答失败，请检查连接后重试。已保留你的输入。' : cause.message || '发送审批结果失败' }
  finally { responding.value = false }
}
</script>

<template>
  <section class="approval-card" :class="{ 'question-card': isQuestion }" role="region" :aria-label="title" :aria-busy="responding">
    <div class="approval-heading"><div class="approval-icon"><Icon :name="isQuestion ? 'CircleHelp' : 'Shield'" :size="18" /></div><div><strong>{{ title }}</strong><span>{{ isQuestion ? questionStatus : '等待你的确认' }}</span></div></div>
    <p v-if="params.reason || params.message" class="approval-reason">{{ params.reason || params.message }}</p>
    <template v-if="isQuestion">
      <div v-if="autoResolveAt !== null" class="question-timing" :class="{ expired: questionExpired }">
        <div class="question-countdown"><Icon name="Clock" :size="14" /><span v-if="questionExpired" role="status">回答时限已到，等待服务器跳过…</span><span v-else role="timer" aria-live="off">剩余 {{ countdown }}</span></div>
        <p>到时未提交的回答将跳过，Codex 可继续处理。</p>
      </div>
      <p v-else-if="legacyTimeout" class="question-timeout-hint">此问题支持自动跳过；请更新 Web 服务端以显示倒计时。</p>
      <fieldset v-for="(question, questionIndex) in questions" :key="question.id" class="question-field" :disabled="responding || submitted || questionExpired"><legend><span v-if="question.header" class="question-header">{{ question.header }}<span v-if="questions.length > 1"> · {{ questionIndex + 1 }}/{{ questions.length }}</span></span><span class="question-prompt">{{ question.question }}</span></legend>
        <label v-for="(option, optionIndex) in question.options || []" :key="optionIndex" class="question-option" :class="{ selected: answers[question.id]?.selection === optionIndex }"><input type="radio" :name="fieldId(question)" :value="optionIndex" v-model="answers[question.id].selection" /><div><strong>{{ option.label }}</strong><span v-if="option.description">{{ option.description }}</span></div><Icon v-if="answers[question.id]?.selection === optionIndex" name="Check" :size="17" class="question-check" /></label>
        <label v-if="question.options?.length && question.isOther" class="question-option" :class="{ selected: answers[question.id]?.selection === 'other' }"><input type="radio" :name="fieldId(question)" value="other" v-model="answers[question.id].selection" /><div><strong>其他</strong><span>填写自己的回答</span></div><Icon v-if="answers[question.id]?.selection === 'other'" name="Check" :size="17" class="question-check" /></label>
        <div v-if="!question.options?.length || (question.isOther && answers[question.id]?.selection === 'other')" class="question-text-answer"><label :for="fieldId(question, '-text')">{{ question.options?.length ? '其他回答' : '你的回答' }}</label><input :id="fieldId(question, '-text')" class="text-input" :type="question.isSecret ? 'password' : 'text'" v-model="answers[question.id].text" :aria-label="question.options?.length ? `${question.header || question.question}：其他回答` : question.question" :autocomplete="question.isSecret ? 'new-password' : 'off'" :spellcheck="!question.isSecret" :autocapitalize="question.isSecret ? 'none' : undefined" :placeholder="question.isSecret ? '输入保密回答…' : '输入你的回答…'" /><small v-if="question.isSecret" class="question-secret-hint"><Icon name="Lock" :size="12" />回答以隐藏方式输入，不会保存为页面草稿</small></div>
      </fieldset>
      <p v-if="!questions.length" class="inline-error" role="alert">未收到问题内容，请重新连接后检查。</p>
    </template>
    <template v-else-if="isElicitation">
      <a v-if="params.mode === 'url' && /^https?:\/\//.test(params.url)" :href="params.url" target="_blank" rel="noopener noreferrer" class="button button-secondary"><Icon name="ExternalLink" :size="15" />打开授权页面</a>
      <label v-for="(field, name) in properties" :key="name" class="form-label">{{ (field as any).title || name }}<small>{{ (field as any).description }}</small>
        <select v-if="(field as any).enum" v-model="formAnswers[name]" class="text-input"><option disabled value="">选择…</option><option v-for="value in (field as any).enum" :key="String(value)" :value="value">{{ value }}</option></select>
        <input v-else-if="(field as any).type === 'boolean'" v-model="formAnswers[name]" type="checkbox" />
        <input v-else v-model="formAnswers[name]" class="text-input" :type="(field as any).type === 'number' || (field as any).type === 'integer' ? 'number' : 'text'" />
      </label>
    </template>
    <template v-else>
      <p v-if="network" class="approval-reason">请求连接：{{ network.protocol }} · {{ network.host }}</p>
      <p v-else-if="isStdin" class="approval-reason">请求向运行中的终端发送输入。</p>
      <pre v-if="command && !network" class="approval-command">{{ isStdin ? '操作内容：' : '$ ' }}{{ command }}</pre>
      <p v-if="cwd" class="approval-path"><Icon name="Folder" :size="13" />{{ cwd }}</p>
      <ul v-if="isFileChange && filePaths.length" class="approval-files"><li v-for="path in filePaths" :key="path">{{ path }}</li></ul>
      <pre v-if="isPermissions" class="approval-permissions">{{ JSON.stringify(params.permissions, null, 2) }}</pre>
      <p v-if="params.grantRoot" class="approval-path">允许修改：{{ params.grantRoot }}</p>
      <p v-if="!isPermissions && !network && !isStdin && !command && !filePaths.length" class="approval-reason">Codex 未提供此操作的详细内容，请先同步对话核对。</p>
    </template>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <div class="approval-actions">
      <span v-if="isQuestion && questions.length" class="question-progress" role="status">{{ submitted ? '回答已发送' : responding ? '正在发送回答…' : questionExpired ? '未提交的回答不会发送' : `已回答 ${answerCount}/${questions.length}` }}</span>
      <button v-if="!isQuestion && allowedDecision('decline')" class="button button-ghost" :disabled="responding" @click="respond('decline')">拒绝</button>
      <button v-if="!isQuestion && allowedDecision('cancel')" class="button button-ghost" :disabled="responding" @click="respond('cancel')">取消任务</button>
      <button v-if="!isQuestion && !isElicitation && allowedDecision('acceptForSession')" class="button button-secondary" :disabled="responding" @click="respond('acceptForSession')">本会话允许</button>
      <button v-if="allowedDecision('accept')" class="button button-primary" :disabled="responding || submitted || !ready" @click="respond('accept')"><Icon v-if="responding" name="LoaderCircle" :size="14" class="spin" />{{ isQuestion ? '提交选择' : isElicitation ? '确认' : '允许一次' }}</button>
    </div>
  </section>
</template>

<style scoped>
.approval-files { padding-left: 20px; overflow-wrap: anywhere; font-size: 12px; }
.approval-reason { overflow-wrap: anywhere; }
.question-card { border-color: var(--border); font-size: 13px; min-width: 0; }
.question-card .approval-icon { background: var(--soft); color: var(--text); flex-shrink: 0; }
.question-card .approval-heading strong { font-size: 14px; }
.question-card .approval-heading span { font-size: 12px; line-height: 1.5; }
.question-field { min-width: 0; margin: 20px 0; }
.question-field legend { display: flex; flex-direction: column; gap: 5px; font-size: 13px; max-width: 100%; overflow-wrap: anywhere; }
.question-header { font-size: 11px; color: var(--muted); font-weight: 600; }
.question-prompt { color: var(--text); font-weight: 550; }
.question-option { align-items: flex-start; gap: 10px; padding: 12px; min-height: 48px; color: var(--text); background: var(--surface); transition: border-color .12s, background .12s; }
.question-option:hover { background: var(--hover); }
.question-option.selected { background: var(--selected); border-color: var(--text); }
.question-option:focus-within { outline: 2px solid var(--green); outline-offset: 2px; }
.question-option > input { width: 16px; height: 16px; flex-shrink: 0; accent-color: var(--text); margin: 2px 0 0; }
.question-option > div { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.question-option strong { font-size: 13px; line-height: 1.5; }
.question-option span { font-size: 12px; }
.question-check { color: var(--text); flex-shrink: 0; margin-top: 2px; }
.question-text-answer { display: flex; flex-direction: column; gap: 7px; margin-top: 12px; }
.question-text-answer > label { font-size: 12px; color: var(--muted); }
.question-text-answer .text-input { width: 100%; min-height: 40px; font-size: 13px; }
.question-text-answer .text-input:focus { outline: 2px solid var(--green); outline-offset: 2px; }
.question-secret-hint { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted); line-height: 1.5; }
.question-timing { margin-top: 14px; padding: 10px 12px; border-radius: 8px; background: var(--soft); color: var(--text); overflow-wrap: anywhere; }
.question-countdown { display: flex; align-items: center; gap: 6px; font-size: 12px; font-variant-numeric: tabular-nums; }
.question-countdown > svg { flex-shrink: 0; }
.question-timing p, .question-timeout-hint { margin: 5px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.question-timing.expired { color: var(--muted); }
.question-progress { margin-right: auto; color: var(--muted); font-size: 12px; }
.question-card .approval-actions .button { font-size: 12px; min-height: 38px; padding: 9px 14px; }
@media (max-width: 600px) {
  .question-card { padding: 14px; }
  .question-field { margin: 17px 0; }
  .question-option { padding: 11px; }
  .question-card .approval-actions { gap: 12px; }
  .question-card .approval-actions .button { min-height: 44px; }
}
</style>
