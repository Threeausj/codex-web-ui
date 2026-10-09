import { asyncUserInputQuestions } from './async-user-input.js';

const openingTag = '<send_user_message_question_reply>';
const closingTag = '</send_user_message_question_reply>';
const questionTool = 'request_user_input_async';
const maxAnswerLength = 16_000;
const maxReplyLength = 64_000;
// Leave room for the surrounding JSON request inside the HTTP body limit.
const maxReplyBytes = 48 * 1024;

type QuestionReply = { questionItemId: string; question: string; answer: string };

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function itemId(item: unknown): string | null {
  const id = object(item)?.id;
  return typeof id === 'string' && id.trim() && id.length <= 1000 ? id : null;
}

function replyId(id: string, index: number): string {
  return JSON.stringify([questionTool, id, index]);
}

function withinReplyLimit(text: string): boolean {
  return text.length <= maxReplyLength && new TextEncoder().encode(text).byteLength <= maxReplyBytes;
}

/** The native async tool has already returned; replies are regular user input. */
export function asyncQuestionReplyText(item: unknown, answers: readonly string[]): string {
  const questions = asyncUserInputQuestions(item);
  const id = itemId(item);
  if (!id || !questions.length) throw new Error('此提问已无效，请同步对话后重试');
  if (!Array.isArray(answers) || answers.length !== questions.length ||
      answers.some(answer => typeof answer !== 'string' || !answer.trim() || answer.length > maxAnswerLength))
    throw new Error('请回答全部问题；每题回答不能超过 16000 个字符');
  const replies: QuestionReply[] = questions.map((question, index) => ({
    questionItemId: replyId(id, index), question: question.title, answer: answers[index],
  }));
  // JSON escaping preserves the answer and prevents embedded XML from ending
  // the envelope before the actual closing tag.
  const body = JSON.stringify(replies).replace(/</g, '\\u003c');
  const text = `${openingTag}${body}${closingTag}`;
  if (!withinReplyLimit(text)) throw new Error('回答内容过长，请缩短后再提交');
  return text;
}

/** A changed question invalidates an open form, including changed choices. */
export function asyncQuestionFingerprint(item: unknown): string | null {
  const id = itemId(item);
  const questions = asyncUserInputQuestions(item);
  return id && questions.length ? JSON.stringify([id, questions]) : null;
}

function parsedReplyId(value: unknown): [string, number] | null {
  if (typeof value !== 'string' || value.length > 6400) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== questionTool ||
        typeof parsed[1] !== 'string' || !parsed[1].trim() || parsed[1].length > 1000 ||
        !Number.isSafeInteger(parsed[2]) || parsed[2] < 0) return null;
    return [parsed[1], parsed[2]];
  } catch { return null; }
}

function parsedReplies(text: unknown): QuestionReply[] {
  if (typeof text !== 'string' || !withinReplyLimit(text)) return [];
  const envelope = text.trim();
  // Only actual reply messages count. Quoted XML, fenced examples and ordinary
  // prose containing a question never dismiss a form.
  if (!envelope.startsWith(openingTag) || !envelope.endsWith(closingTag)) return [];
  try {
    const parsed: unknown = JSON.parse(envelope.slice(openingTag.length, -closingTag.length));
    if (!Array.isArray(parsed) || !parsed.length) return [];
    const seen = new Set<string>();
    const replies: QuestionReply[] = [];
    for (const entry of parsed) {
      const value = object(entry);
      const reference = parsedReplyId(value?.questionItemId);
      if (!value || !reference || typeof value.question !== 'string' || !value.question.trim() ||
          typeof value.answer !== 'string' || !value.answer.trim() || value.answer.length > maxAnswerLength ||
          seen.has(replyId(...reference))) return [];
      seen.add(replyId(...reference));
      replies.push({ questionItemId: value.questionItemId as string, question: value.question, answer: value.answer });
    }
    return replies;
  } catch { return []; }
}

/** Only native, confirmed user input should resolve reminders using these IDs. */
export function asyncQuestionReplyReferences(text: unknown): Array<{ itemId: string; index: number }> {
  return parsedReplies(text).map(reply => {
    const [id, index] = parsedReplyId(reply.questionItemId)!;
    return { itemId: id, index };
  });
}

/** Keep protocol bookkeeping out of the readable user-message bubble. */
export function asyncQuestionAnswerDisplayText(text: unknown): string | null {
  const replies = parsedReplies(text);
  return replies.length ? replies.map(reply => reply.answer).join('\n\n') : null;
}

/** Match persisted replies to native questions, including after reconnect. */
export function answeredAsyncQuestionAnswers(items: readonly unknown[]): Map<string, string> {
  const originals = new Map<string, ReturnType<typeof asyncUserInputQuestions>>();
  for (const item of items) {
    const id = itemId(item);
    const questions = asyncUserInputQuestions(item);
    if (id && questions.length) originals.set(id, questions);
  }
  const answers = new Map<string, string>();
  for (const item of items) {
    const message = object(item);
    if (message?.type !== 'userMessage' || !Array.isArray(message.content) ||
        message.status === 'sending' || message.status === 'unconfirmed') continue;
    for (const input of message.content) {
      const content = object(input);
      if (content?.type !== 'text') continue;
      for (const reply of parsedReplies(content.text)) {
        const [id, index] = parsedReplyId(reply.questionItemId)!;
        const question = originals.get(id)?.[index];
        if (question?.title === reply.question) answers.set(replyId(id, index), reply.answer);
      }
    }
  }
  return answers;
}

export function answeredAsyncQuestionIds(items: readonly unknown[]): Set<string> {
  return new Set(answeredAsyncQuestionAnswers(items).keys());
}

/** A multi-question form stays pending until every question has an answer. */
export function asyncQuestionAnswered(item: unknown, items: readonly unknown[]): boolean {
  const id = itemId(item);
  const questions = asyncUserInputQuestions(item);
  if (!id || !questions.length) return false;
  const answered = answeredAsyncQuestionIds([...items, item]);
  return questions.every((_, index) => answered.has(replyId(id, index)));
}
