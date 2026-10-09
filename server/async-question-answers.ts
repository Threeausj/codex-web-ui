import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { RpcFailure, type Bridge } from './bridge.js';
import { asyncUserInputQuestions } from '../shared/async-user-input.js';
import { asyncQuestionReplyText, answeredAsyncQuestionIds } from '../shared/async-question-reply.js';

const identifier = z.string().min(1).max(256).refine(value => !/[\x00-\x1f]/.test(value));
const answerRequest = z.object({ turnId: identifier, answers: z.array(z.string().trim().min(1).max(16000)).min(1).max(32) }).strict();
type NativeItem = { id: string; type: string; [key: string]: unknown };
type NativeHistory = { data: { id: string; status: string; items: NativeItem[] }[] };
type TextInput = { type: 'text'; text: string; text_elements: [] };
type Receipt = { accepted: true; alreadyAnswered?: true; input?: TextInput[]; clientUserMessageId?: string; turnId?: string; turn?: unknown };
type Claim = { state: 'pending'; promise: Promise<Receipt> } | { state: 'accepted'; receipt: Receipt } | { state: 'uncertain' };
const claims = new WeakMap<Bridge, Map<string, Claim>>();

class AnswerFailure extends Error {
  constructor(message: string, readonly code: string, readonly status = 409, readonly uncertain = false) { super(message); }
}
function uncertainFailure() { return new AnswerFailure('回答可能已被服务端接收，请同步对话确认；为避免重复发送，暂不重新提交。', 'async_answer_uncertain', 409, true); }

async function findQuestion(bridge: Bridge, threadId: string, turnId: string, itemId: string): Promise<NativeItem> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = await bridge.request('thread/items/list', { threadId, turnId, limit: 100, sortDirection: 'asc', cursor }, 15000) as { data: { turnId: string; item: NativeItem }[]; nextCursor: string | null };
    if (!Array.isArray(result?.data)) throw new AnswerFailure('无法核对问题内容，请同步对话后重试。', 'async_question_unavailable');
    const entry = result.data.find(entry => entry.turnId === turnId && entry.item?.id === itemId);
    if (entry) {
      if (!asyncUserInputQuestions(entry.item).length) throw new AnswerFailure('该消息不是可回答的异步问题，请同步对话。', 'async_question_invalid');
      return entry.item;
    }
    if (!result.nextCursor) break;
    if (seen.has(result.nextCursor)) throw new AnswerFailure('问题分页未能继续，请同步对话后重试。', 'async_question_unavailable');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw new AnswerFailure('问题已不在可核对的对话记录中，请同步并选择最新的问题。', 'async_question_not_found', 404);
}

async function latestHistory(bridge: Bridge, threadId: string) {
  const result = await bridge.request('thread/turns/list', { threadId, limit: 30, sortDirection: 'desc', itemsView: 'summary' }, 15000) as NativeHistory;
  if (!Array.isArray(result?.data)) throw new AnswerFailure('无法核对最近对话，请同步后重试。', 'async_question_unavailable');
  return result;
}

function alreadyAnswered(item: NativeItem, history: NativeHistory) {
  const ids = answeredAsyncQuestionIds([item, ...history.data.flatMap(turn => turn.items || [])]);
  return asyncUserInputQuestions(item).every((_, index) => ids.has(JSON.stringify(['request_user_input_async', item.id, index])));
}

function accept(entries: Map<string, Claim>, key: string, receipt: Receipt) {
  entries.delete(key); entries.set(key, { state: 'accepted', receipt });
  let accepted = [...entries.values()].filter(entry => entry.state === 'accepted').length;
  for (const [oldKey, entry] of entries) {
    if (accepted <= 256) break;
    if (entry.state === 'accepted') { entries.delete(oldKey); accepted--; }
  }
}

async function confirmAnswered(bridge: Bridge, threadId: string, turnId: string, item: NativeItem, history: NativeHistory) {
  // Summaries may omit steering messages. A visible reply is positive evidence;
  // its absence is never proof that an async question remains unanswered.
  if (alreadyAnswered(item, history)) return true;
  const origin = history.data.findIndex(turn => turn.id === turnId);
  if (origin < 0) throw new AnswerFailure('这个问题已超出最近对话，请同步并选择最新的问题；未重新发送回答。', 'async_question_stale');
  const verified: NativeHistory = { data: [] };
  let pages = 0;
  for (const turn of history.data.slice(0, origin + 1)) {
    const items: NativeItem[] = [];
    const completeTurn = { ...turn, items };
    verified.data.push(completeTurn);
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      if (pages++ >= 20) throw new AnswerFailure('需要核对的对话记录过多，请同步并选择最新的问题；为避免重复回答，未重新发送。', 'async_question_history_limit');
      const result = await bridge.request('thread/items/list', { threadId, turnId: turn.id, limit: 100, sortDirection: 'asc', cursor }, 15000) as { data: { turnId: string; item: NativeItem }[]; nextCursor: string | null };
      if (!Array.isArray(result?.data) || result.data.some(entry => entry?.turnId !== turn.id || typeof entry.item?.id !== 'string'))
        throw new AnswerFailure('无法完整核对已提交的回答，请同步对话后重试。', 'async_question_unavailable');
      items.push(...result.data.map(entry => entry.item));
      if (alreadyAnswered(item, verified)) return true;
      cursor = result.nextCursor;
      if (cursor) {
        if (seen.has(cursor)) throw new AnswerFailure('回答记录的分页未能继续，请同步后重试。', 'async_question_unavailable');
        seen.add(cursor);
      }
    } while (cursor);
  }
  if (!verified.data.some(turn => turn.items.some(entry => entry.id === item.id)))
    throw new AnswerFailure('问题记录已改变，请同步对话后确认。', 'async_question_unavailable');
  return false;
}

async function answer(bridge: Bridge, threadId: string, itemId: string, body: z.infer<typeof answerRequest>, entryMap: Map<string, Claim>, key: string): Promise<Receipt> {
  let mutationStarted = false;
  try {
    const item = await findQuestion(bridge, threadId, body.turnId, itemId);
    const questions = asyncUserInputQuestions(item);
    if (body.answers.length !== questions.length) throw new AnswerFailure('请回答所有问题后提交。', 'async_question_answers_invalid', 400);
    const history = await latestHistory(bridge, threadId);
    if (await confirmAnswered(bridge, threadId, body.turnId, item, history)) {
      const receipt: Receipt = { accepted: true, alreadyAnswered: true };
      accept(entryMap, key, receipt); return receipt;
    }
    const metadata = await bridge.request('thread/read', { threadId, includeTurns: false }, 15000) as { thread?: { id?: string; status?: { type?: string } } };
    if (metadata.thread?.id !== threadId || !metadata.thread.status?.type || metadata.thread.status.type === 'systemError')
      throw new AnswerFailure('无法确认会话状态，请同步后重试。', 'async_question_unavailable');
    const running = history.data.find(turn => turn.status === 'inProgress');
    if (Boolean(running) !== (metadata.thread.status.type === 'active'))
      throw new AnswerFailure('会话运行状态已改变，请同步后重新提交回答。', 'async_question_turn_changed');
    let text: string;
    try { text = asyncQuestionReplyText(item, body.answers); }
    catch (error) { throw new AnswerFailure((error as Error).message, 'async_question_answers_invalid', 400); }
    const input: TextInput[] = [{ type: 'text', text, text_elements: [] }];
    const clientUserMessageId = randomUUID();
    const params = { threadId, input, clientUserMessageId, ...(running ? { expectedTurnId: running.id } : {}) };
    mutationStarted = true;
    const result = await bridge.request(running ? 'turn/steer' : 'turn/start', params, 30000) as { turnId?: string; turn?: unknown };
    const receipt: Receipt = { accepted: true, input, clientUserMessageId,
      ...(typeof result?.turnId === 'string' ? { turnId: result.turnId } : {}),
      ...(result?.turn ? { turn: result.turn } : {}),
    };
    accept(entryMap, key, receipt); return receipt;
  } catch (error) {
    const rpc = error instanceof RpcFailure ? error.rpc : undefined;
    const data = rpc?.data as { uncertain?: boolean } | undefined;
    // A native rejection is definitive. Lost transport acknowledgements are not:
    // keep their claim until native history proves that an answer was recorded.
    const local = error as { uncertain?: boolean; code?: string; status?: number };
    const blockedBeforeDispatch = ['runtime_paused', 'thread_released'].includes(local?.code || '') ||
      typeof local?.status === 'number' && local.status >= 400 && local.status < 500;
    if (mutationStarted && (data?.uncertain === true || local?.uncertain === true || !(error instanceof RpcFailure) && !blockedBeforeDispatch)) {
      entryMap.set(key, { state: 'uncertain' }); throw uncertainFailure();
    }
    entryMap.delete(key);
    throw error;
  }
}

/** Registered after authentication/CSRF; concurrent Web clients share one claim. */
export function registerAsyncQuestionAnswers(app: Express, getBridge: (hostId: string) => Promise<Bridge>) {
  app.get('/api/threads/:hostId/:threadId/async-questions/:itemId/status', (req, res, next) => {
    void (async () => {
      const hostId = identifier.parse(req.params.hostId), threadId = identifier.parse(req.params.threadId), itemId = identifier.parse(req.params.itemId);
      const { turnId } = z.object({ turnId: identifier, _request: z.string().max(256).optional() }).strict().parse(req.query);
      const bridge = await getBridge(hostId);
      const item = await findQuestion(bridge, threadId, turnId, itemId);
      res.json({ answered: await confirmAnswered(bridge, threadId, turnId, item, await latestHistory(bridge, threadId)) });
    })().catch(error => {
      if (error instanceof AnswerFailure) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      next(error);
    });
  });
  app.post('/api/threads/:hostId/:threadId/async-questions/:itemId/answer', (req, res, next) => {
    void (async () => {
      const hostId = identifier.parse(req.params.hostId), threadId = identifier.parse(req.params.threadId), itemId = identifier.parse(req.params.itemId);
      const body = answerRequest.parse(req.body);
      const bridge = await getBridge(hostId);
      let entries = claims.get(bridge);
      if (!entries) { entries = new Map(); claims.set(bridge, entries); }
      const key = JSON.stringify([threadId, itemId]);
      const previous = entries.get(key);
      if (previous?.state === 'accepted') return previous.receipt;
      if (previous?.state === 'pending') return previous.promise;
      if (previous?.state === 'uncertain') {
        try {
          const item = await findQuestion(bridge, threadId, body.turnId, itemId);
          if (!await confirmAnswered(bridge, threadId, body.turnId, item, await latestHistory(bridge, threadId))) throw uncertainFailure();
        } catch { throw uncertainFailure(); }
        const receipt: Receipt = { accepted: true, alreadyAnswered: true };
        accept(entries, key, receipt); return receipt;
      }
      const entryMap = entries;
      // Queue execution only after installing its promise: no first-await gap
      // allows a second browser to submit this question again.
      const promise = Promise.resolve().then(() => answer(bridge, threadId, itemId, body, entryMap, key));
      entries.set(key, { state: 'pending', promise });
      return promise;
    })().then(receipt => res.json(receipt)).catch(error => {
      if (error instanceof AnswerFailure) { res.status(error.status).json({ error: error.message, code: error.code, ...(error.uncertain ? { uncertain: true } : {}) }); return; }
      next(error);
    });
  });
}
