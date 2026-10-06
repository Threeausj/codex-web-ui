<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Icon from './Icon.vue'
const props = defineProps<{ request: any; api: any }>()
const answers = reactive<Record<string, string>>({})
const formAnswers = reactive<Record<string, any>>({})
const responding = ref(false)
const error = ref('')
const params = computed(() => props.request.params || {})
const isQuestion = computed(() => props.request.method?.includes('requestUserInput'))
const isPermissions = computed(() => props.request.method?.includes('permissions/requestApproval'))
const isElicitation = computed(() => props.request.method?.includes('elicitation'))
const title = computed(() => isQuestion.value ? 'Codex 需要你的选择' : isPermissions.value ? '请求额外权限' : isElicitation.value ? `${params.value.serverName || 'MCP'} 需要你的输入` : props.request.method?.includes('fileChange') ? '批准文件修改' : '批准命令执行')
const properties = computed(() => params.value.requestedSchema?.properties || {})
function allowedDecision(decision: string) {
  return isQuestion.value || isPermissions.value || isElicitation.value || !params.value.availableDecisions?.length || params.value.availableDecisions.includes(decision)
}
const ready = computed(() => isQuestion.value ? (params.value.questions || []).every((q: any) => answers[q.id]?.trim()) : isElicitation.value ? (params.value.requestedSchema?.required || []).every((key: string) => formAnswers[key] != null && formAnswers[key] !== '') : true)
async function respond(decision: string) {
  responding.value = true; error.value = ''
  try {
    let result: any = { decision }
    if (isQuestion.value) result = { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: [value] }])) }
    else if (isPermissions.value) result = { permissions: decision.startsWith('accept') ? Object.fromEntries(Object.entries(params.value.permissions || {}).filter(([, value]) => value != null)) : {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' }
    else if (isElicitation.value) result = { action: decision === 'accept' ? 'accept' : decision === 'cancel' ? 'cancel' : 'decline', content: decision === 'accept' ? params.value.mode === 'url' ? null : formAnswers : null, _meta: null }
    await props.api.respond(props.request.id, result)
  } catch (cause: any) { error.value = cause.message || '发送审批结果失败' }
  finally { responding.value = false }
}
</script>

<template>
  <section class="approval-card" role="region" :aria-label="title">
    <div class="approval-heading"><div class="approval-icon"><Icon :name="isQuestion ? 'CircleHelp' : 'Shield'" :size="18" /></div><div><strong>{{ title }}</strong><span>等待你的确认</span></div></div>
    <p v-if="params.reason || params.message" class="approval-reason">{{ params.reason || params.message }}</p>
    <template v-if="isQuestion">
      <fieldset v-for="question in params.questions" :key="question.id" class="question-field"><legend>{{ question.question }}</legend>
        <label v-for="option in question.options || []" :key="option.label" class="question-option" :class="{ selected: answers[question.id] === option.label }"><input type="radio" :name="String(request.id) + question.id" :value="option.label" v-model="answers[question.id]" /><div><strong>{{ option.label }}</strong><span>{{ option.description }}</span></div></label>
        <input v-if="question.isOther || !question.options?.length" class="text-input" :type="question.isSecret ? 'password' : 'text'" v-model="answers[question.id]" :placeholder="question.options?.length ? '或输入其他回答…' : '输入你的回答…'" />
      </fieldset>
    </template>
    <template v-else-if="isElicitation">
      <a v-if="params.mode === 'url' && /^https?:\/\//.test(params.url)" :href="params.url" target="_blank" rel="noopener noreferrer" class="button button-secondary"><Icon name="ExternalLink" :size="15" />打开授权页面</a>
      <label v-for="(field, name) in properties" :key="name" class="form-label">{{ (field as any).title || name }}<small>{{ (field as any).description }}</small>
        <select v-if="(field as any).enum" v-model="formAnswers[name]" class="text-input"><option disabled value="">选择…</option><option v-for="value in (field as any).enum" :key="String(value)" :value="value">{{ value }}</option></select>
        <input v-else-if="(field as any).type === 'boolean'" v-model="formAnswers[name]" type="checkbox" />
        <input v-else v-model="formAnswers[name]" class="text-input" :type="(field as any).type === 'number' || (field as any).type === 'integer' ? 'number' : 'text'" />
      </label>
    </template>
    <template v-else><pre v-if="params.command" class="approval-command">$ {{ params.command }}</pre><p v-if="params.cwd" class="approval-path"><Icon name="Folder" :size="13" />{{ params.cwd }}</p><pre v-if="isPermissions" class="approval-permissions">{{ JSON.stringify(params.permissions, null, 2) }}</pre><p v-if="params.grantRoot" class="approval-path">允许修改：{{ params.grantRoot }}</p></template>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <div class="approval-actions">
      <button v-if="!isQuestion && allowedDecision('decline')" class="button button-ghost" :disabled="responding" @click="respond('decline')">拒绝</button>
      <button v-if="!isQuestion && allowedDecision('cancel')" class="button button-ghost" :disabled="responding" @click="respond('cancel')">取消任务</button>
      <button v-if="!isQuestion && !isElicitation && allowedDecision('acceptForSession')" class="button button-secondary" :disabled="responding" @click="respond('acceptForSession')">本会话允许</button>
      <button v-if="allowedDecision('accept')" class="button button-primary" :disabled="responding || !ready" @click="respond('accept')"><Icon v-if="responding" name="LoaderCircle" :size="14" class="spin" />{{ isQuestion ? '提交选择' : isElicitation ? '确认' : '允许一次' }}</button>
    </div>
  </section>
</template>
