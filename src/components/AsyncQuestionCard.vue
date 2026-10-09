<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { asyncUserInputQuestions } from '../../shared/async-user-input'
import { asyncQuestionFingerprint } from '../../shared/async-question-reply'
import Icon from './Icon.vue'

const props = defineProps<{
  item: any
  status?: 'pending' | 'sending' | 'answered' | 'uncertain'
  disabled?: boolean
  answer?: (answers: string[]) => Promise<void>
}>()
const questions = computed(() => asyncUserInputQuestions(props.item))
const drafts = reactive<Record<number, { selection?: number | 'other'; text?: string }>>({})
const submitting = ref(false)
const error = ref('')
const sending = computed(() => submitting.value || props.status === 'sending')
const locked = computed(() => sending.value || props.disabled || !props.answer || ['answered', 'uncertain'].includes(props.status || ''))
const statusText = computed(() => props.status === 'answered' ? '回答已发送'
  : props.status === 'uncertain' ? '发送结果待确认，请同步对话后检查'
    : sending.value ? '正在发送回答…'
      : !props.answer ? '打开此对话后可回答'
        : 'Codex 可继续运行，回答后会补充给它')
function answerValue(index: number) {
  const question = questions.value[index]
  const draft = drafts[index]
  if (!question || !draft) return ''
  if (!question.options?.length || draft.selection === 'other') return draft.text?.trim() || ''
  return typeof draft.selection === 'number' ? question.options[draft.selection] || '' : ''
}
const answeredCount = computed(() => questions.value.filter((_question, index) => !!answerValue(index)).length)
const ready = computed(() => questions.value.length > 0 && answeredCount.value === questions.value.length)
watch(() => asyncQuestionFingerprint(props.item), () => {
  for (const key of Object.keys(drafts)) delete drafts[Number(key)]
  questions.value.forEach((_question, index) => { drafts[index] = {} })
  submitting.value = false
  error.value = ''
}, { immediate: true })
function fieldId(index: number) { return `async-question-${encodeURIComponent(props.item.id)}-${index}` }
async function submit() {
  if (locked.value || !ready.value || !props.answer) return
  submitting.value = true
  error.value = ''
  try { await props.answer(questions.value.map((_question, index) => answerValue(index))) }
  catch (cause: any) { error.value = cause?.message || '发送回答失败，已保留你的选择，请检查连接后重试。' }
  finally { submitting.value = false }
}
</script>

<template>
  <section v-if="questions.length" class="async-question-card" :class="{ answered: status === 'answered' }" role="region" aria-label="Codex 需要你的选择" :aria-busy="sending" :data-async-question-id="item.id" :data-question-pending="status !== 'answered'">
    <div class="async-question-heading"><Icon name="CircleHelp" :size="18" /><div><strong>Codex 需要你的选择</strong><span role="status">{{ statusText }}</span></div></div>
    <template v-if="status !== 'answered'">
      <fieldset v-for="(question, index) in questions" :key="index" :disabled="locked" class="async-question-field">
        <legend><small v-if="questions.length > 1">{{ index + 1 }}/{{ questions.length }}</small>{{ question.title }}</legend>
        <label v-for="(option, optionIndex) in question.options || []" :key="optionIndex" class="async-question-option" :class="{ selected: drafts[index]?.selection === optionIndex }">
          <input type="radio" :name="fieldId(index)" :value="optionIndex" v-model="drafts[index].selection" /><span>{{ option }}</span><Icon v-if="drafts[index]?.selection === optionIndex" name="Check" :size="16" />
        </label>
        <label v-if="question.options?.length" class="async-question-option" :class="{ selected: drafts[index]?.selection === 'other' }">
          <input type="radio" :name="fieldId(index)" value="other" v-model="drafts[index].selection" /><span>其他</span><Icon v-if="drafts[index]?.selection === 'other'" name="Check" :size="16" />
        </label>
        <label v-if="!question.options?.length || drafts[index]?.selection === 'other'" class="async-question-text" :for="fieldId(index) + '-text'">
          <span>{{ question.options?.length ? '其他回答' : '你的回答' }}</span>
          <textarea :id="fieldId(index) + '-text'" v-model="drafts[index].text" :aria-label="question.options?.length ? `${question.title}：其他回答` : question.title" rows="2" maxlength="16000" placeholder="输入你的回答…" />
        </label>
      </fieldset>
      <p v-if="error" class="async-question-error" role="alert">{{ error }}</p>
      <div class="async-question-actions"><span>已回答 {{ answeredCount }}/{{ questions.length }}</span><button type="button" class="button button-primary" :disabled="locked || !ready" @click="submit"><Icon v-if="sending" name="LoaderCircle" :size="14" class="spin" />提交选择</button></div>
    </template>
  </section>
</template>

<style scoped>
.async-question-card { margin: 14px 0 4px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); min-width: 0; font-size: 13px; }
.async-question-heading { display: flex; align-items: flex-start; gap: 10px; }
.async-question-heading > svg { flex-shrink: 0; margin-top: 2px; }
.async-question-heading > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.async-question-heading strong { font-size: 14px; }
.async-question-heading span { font-size: 12px; line-height: 1.5; color: var(--muted); overflow-wrap: anywhere; }
.async-question-field { min-width: 0; padding: 0; border: 0; margin: 18px 0; }
.async-question-field legend { display: flex; flex-direction: column; gap: 5px; max-width: 100%; font-weight: 550; line-height: 1.6; overflow-wrap: anywhere; padding: 0 0 8px; }
.async-question-field legend small { font-size: 11px; color: var(--muted); }
.async-question-option { display: flex; align-items: flex-start; gap: 10px; min-height: 44px; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 6px 0; cursor: pointer; background: var(--surface); }
.async-question-option:hover { background: var(--hover); }
.async-question-option.selected { background: var(--selected); border-color: var(--text); }
.async-question-option:focus-within { outline: 2px solid var(--green); outline-offset: 2px; }
.async-question-option > input { width: 16px; height: 16px; flex-shrink: 0; accent-color: var(--text); margin: 2px 0 0; }
.async-question-option > span { min-width: 0; flex: 1; line-height: 1.5; overflow-wrap: anywhere; }
.async-question-option > svg { flex-shrink: 0; margin-top: 2px; }
.async-question-text { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; color: var(--muted); font-size: 12px; }
.async-question-text textarea { width: 100%; min-height: 64px; box-sizing: border-box; resize: vertical; font: inherit; font-size: 13px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); }
.async-question-text textarea:focus { outline: 2px solid var(--green); outline-offset: 2px; }
.async-question-error { color: var(--red); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.async-question-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; }
.async-question-actions .button { min-height: 40px; font-size: 12px; padding: 9px 14px; }
.async-question-card.answered { padding: 12px 14px; background: var(--soft); }
@media (max-width: 760px) {
  .async-question-card { padding: 14px; }
  .async-question-text textarea { font-size: 16px; }
  .async-question-actions .button { min-height: 44px; }
}
</style>
