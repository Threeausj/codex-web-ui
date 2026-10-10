import { asyncQuestionFingerprint } from './async-question-reply.js';

/** Dismissing a banner does not answer or cancel the native question. */
export type AsyncQuestionNotice = {
  hostId: string; threadId: string; turnId: string; itemId: string; fingerprint: string;
};

export const asyncQuestionNoticeKey = (notice: Pick<AsyncQuestionNotice, 'hostId' | 'threadId' | 'turnId' | 'itemId'>) =>
  JSON.stringify([notice.hostId, notice.threadId, notice.turnId, notice.itemId]);

/** Keep every request safely inside the application's 64 KiB JSON limit. */
export function asyncQuestionNoticeBatches(notices: AsyncQuestionNotice[]): AsyncQuestionNotice[][] {
  const batches: AsyncQuestionNotice[][] = [];
  let batch: AsyncQuestionNotice[] = [];
  const bytes = (questions: AsyncQuestionNotice[]) => new TextEncoder().encode(JSON.stringify({ questions })).byteLength;
  for (const notice of notices) {
    if (bytes([notice]) > 48 * 1024) throw new Error('此问题内容过长，无法保存关闭记录；请同步对话后重试');
    if (batch.length >= 32 || bytes([...batch, notice]) > 48 * 1024) { batches.push(batch); batch = []; }
    batch.push(notice);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Accept only the exact canonical question fingerprint, bound to its item. */
export function validAsyncQuestionNoticeFingerprint(itemId: string, fingerprint: string): boolean {
  try {
    const parsed: unknown = JSON.parse(fingerprint);
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== itemId || !Array.isArray(parsed[1])) return false;
    return asyncQuestionFingerprint({ id: itemId, type: 'agentMessage', delivery: 'async', questions: parsed[1] }) === fingerprint;
  } catch { return false; }
}
