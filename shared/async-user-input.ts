import type { AsyncUserInputQuestion } from './protocol/v2/AsyncUserInputQuestion.js';

/** Async questions are native message metadata, never inferred from prose. */
export function asyncUserInputQuestions(item: unknown): AsyncUserInputQuestion[] {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
  const message = item as Record<string, unknown>;
  if (message.type !== 'agentMessage' || message.delivery !== 'async' ||
      !Array.isArray(message.questions) || !message.questions.length) return [];
  const questions: AsyncUserInputQuestion[] = [];
  for (const raw of message.questions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const question = raw as Record<string, unknown>;
    if (typeof question.title !== 'string' || !question.title.trim()) return [];
    if (question.options !== undefined && question.options !== null &&
        (!Array.isArray(question.options) || question.options.some(option => typeof option !== 'string' || !option.trim()))) return [];
    questions.push({ title: question.title.trim(), options: Array.isArray(question.options) ? question.options.map(option => (option as string).trim()) : null });
  }
  return questions;
}
