import type { ToolRequestUserInputQuestion } from '../../shared/protocol/v2/ToolRequestUserInputQuestion'
import type { ToolRequestUserInputResponse } from '../../shared/protocol/v2/ToolRequestUserInputResponse'

export type UserInputDraft = { selection?: number | 'other'; text?: string }
export type UserInputDrafts = Record<string, UserInputDraft>

export function userInputAnswer(question: ToolRequestUserInputQuestion, draft?: UserInputDraft): string | null {
  if (!draft) return null
  const options = question.options || []
  if (!options.length || (question.isOther && draft.selection === 'other')) {
    const text = draft.text?.trim()
    return text ? question.isSecret ? draft.text! : text : null
  }
  if (typeof draft.selection !== 'number' || !Number.isInteger(draft.selection)) return null
  return options[draft.selection]?.label?.trim() ? options[draft.selection].label : null
}

export function userInputReady(questions: ToolRequestUserInputQuestion[], drafts: UserInputDrafts): boolean {
  return questions.length > 0
    && questions.every(question => typeof question.id === 'string' && question.id.length > 0)
    && new Set(questions.map(question => question.id)).size === questions.length
    && questions.every(question => userInputAnswer(question, drafts[question.id]) !== null)
}

/** Only answers to this request are sent; unselected free-text drafts remain local. */
export function userInputResponse(questions: ToolRequestUserInputQuestion[], drafts: UserInputDrafts): ToolRequestUserInputResponse {
  if (!userInputReady(questions, drafts)) throw new Error('请回答全部问题后再提交')
  return {
    answers: Object.fromEntries(questions.map(question => [question.id, {
      answers: [userInputAnswer(question, drafts[question.id])!],
    }])),
  }
}
