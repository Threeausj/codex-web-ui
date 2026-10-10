import { privateState } from './private-state';
import { getCurrentScope, onScopeDispose, reactive, watch } from 'vue';
import { resolvePermissionProfile } from './configuration';
import { nativeCollaborationMode } from './conversation-modes';
import { applyItemEvent, mergeSnapshotItems, upsertItem, type DisplayItem } from './events';
import { mergeTurnSnapshot } from './thread-sync';
import { formatConversationQuote, normalizeConversationSelection, type ConversationSelectionSource } from './conversation-selection';
import { randomUUID } from './uuid';
import { interruptConflictCandidate } from './turn-interrupt';

export type SelectedConversationText = ConversationSelectionSource;
export type ConversationSideChatSource = {
  kind: 'conversation';
  hostId: string;
  threadId: string;
  threadName?: string;
  text?: undefined;
  turnId?: undefined;
  itemId?: undefined;
  path?: undefined;
};
export type SideChatSource = SelectedConversationText | ConversationSideChatSource;
export type SideChatState = {
  open: boolean;
  source: SideChatSource | null;
  threadId: string;
  anchor: SideChatSource | null;
  boundary: { lastTurnId?: string; beforeTurnId?: string };
  savedThreadId: string;
  saving: boolean;
  saveTargetThreadId: string;
  saveUncertain: '' | 'fork' | 'inject';
  items: DisplayItem[];
  turns: any[];
  busy: boolean;
  loading: boolean;
  connected: boolean;
  error: string;
  notice: string;
};

/** A sidebar answer is a separate ephemeral branch, never a steer of the parent. */
export function useSideChat(api: any, mainState: any) {
  const state = reactive<SideChatState>({ open: false, source: null, threadId: '', anchor: null, boundary: {}, savedThreadId: '', saving: false, saveTargetThreadId: '', saveUncertain: '', items: [], turns: [], busy: false, loading: false, connected: false, error: '', notice: '' });
  let generation = 0;
  let activeTurnId = '';
  let requestPending = false;
  let savingOperation = 0;
  let disposed = false;
  let threadEnded = false;
  let identity: { authenticationGeneration?: number; engineId?: string | null } | null = null;
  let recovering: Promise<void> | null = null;
  let interruptGeneration = 0;
  let interruptRequest: { source: SideChatSource; threadId: string; version: number; authenticationGeneration?: number; engineId?: string | null; promise: Promise<void> } | null = null;
  let eventRevision = 0;
  const revisions = new Map<string, number>();
  const turnRevisions = new Map<string, number>();
  const ownedThreads = new Set<string>();
  const savedMessages = new Map<string, string>();
  const journal = api.operationJournal || privateState;
  let restoringSave: Promise<void> | null = null;
  const journalKey = (source: SideChatSource) => JSON.stringify([source.hostId, source.threadId]);
  const unknownForks = new Set<string>();
  const saveScope = (source: SideChatSource) => JSON.stringify([source.hostId, source.threadId, runtimeIdentity().authenticationGeneration]);
  let pendingSaveBatch: { marker: string; text: string; entries: { key: string; text: string }[] } | null = null;
  let savedBranchPath = '';
  let inheritedGoalCleared = false;
  let emptyAnchorTail: string | null = null;
  const visibleMessages = () => state.items.filter(item => item.type === 'userMessage' || item.type === 'agentMessage').map(item => ({
    key: `${item.type}:${item.clientId || item.id}`,
    text: `${item.type === 'userMessage' ? '用户' : '助手'}：${item.text || (item.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')}`,
  }));
  const hasUnsavedMessages = () => visibleMessages().some(item => savedMessages.get(item.key) !== item.text);
  const invalidateSavedTranscript = () => { if (state.savedThreadId && hasUnsavedMessages()) state.savedThreadId = ''; };
  function resetSavedBranch() {
    state.savedThreadId = ''; state.saveTargetThreadId = ''; state.saveUncertain = '';
    savedMessages.clear(); pendingSaveBatch = null; savedBranchPath = ''; inheritedGoalCleared = false;
  }
  const ownedKey = (hostId: string, threadId: string) => JSON.stringify([hostId, threadId]);
  const runtimeIdentity = () => api.runtimeIdentity?.() || {};
  const sourceScope = () => state.source && mainState.authenticated && mainState.hostId === state.source.hostId && mainState.activeThread?.id === state.source.threadId;
  const canConnect = () => !!sourceScope() && !!mainState.connected && !mainState.runtimePaused && !mainState.switchingHost;
  function remember(hostId: string, id: string) {
    ownedThreads.add(ownedKey(hostId, id));
    if (ownedThreads.size > 64) ownedThreads.delete(ownedThreads.values().next().value!);
  }
  function stillCurrent(version: number, source: SideChatSource) {
    return !disposed && generation === version && !!sourceScope() && state.source?.hostId === source.hostId && state.source?.threadId === source.threadId;
  }
  function call(hostId: string, method: string, params: any) {
    try { return Promise.resolve(api.sideChatRpc(hostId, method, params)); }
    catch (cause) { return Promise.reject(cause); }
  }
  async function release(hostId: string, threadId: string, turnId?: string) {
    if (!threadId) return;
    // Submit both before awaiting, so a tab/host switch cannot delay cleanup.
    const requests = [
      ...(turnId ? [call(hostId, 'turn/interrupt', { threadId, turnId })] : []),
      call(hostId, 'thread/unsubscribe', { threadId }),
    ];
    const results = await Promise.allSettled(requests);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }
  function reset() {
    ++generation;
    ++savingOperation;
    ++interruptGeneration;
    interruptRequest = null;
    state.open = false;
    state.source = null;
    state.threadId = '';
    state.anchor = null;
    state.boundary = {};
    resetSavedBranch();
    emptyAnchorTail = null;
    state.saving = false;
    state.items = [];
    state.turns = [];
    state.busy = false;
    state.loading = false;
    state.connected = false;
    state.error = '';
    state.notice = '';
    activeTurnId = '';
    threadEnded = false;
    identity = null;
    requestPending = false;
    recovering = null;
    revisions.clear();
    turnRevisions.clear();
  }
  async function close() {
    if (state.saving) { state.open = false; return; }
    const hostId = state.source?.hostId;
    const threadId = state.threadId;
    const turnId = activeTurnId;
    // Invoke cleanup while the old socket remains usable, then clear this view.
    const released = hostId && threadId ? release(hostId, threadId, turnId) : Promise.resolve();
    reset();
    try { await released; }
    catch (cause: any) {
      if (hostId === mainState.hostId && mainState.authenticated && mainState.connected)
        api.toast?.(`侧边聊天已关闭，后台释放状态需要确认：${cause?.message || String(cause)}`);
    }
  }
  function prepare(value: SelectedConversationText) {
    const source = normalizeConversationSelection(value);
    if (!source || !mainState.authenticated || source.hostId !== mainState.hostId || source.threadId !== mainState.activeThread?.id)
      throw new Error('请在当前对话中重新选择文本');
    prepareSource(source);
  }
  function prepareConversation() {
    const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
    if (!mainState.authenticated || !validId(mainState.hostId) || !validId(mainState.activeThread?.id) || mainState.switchingHost)
      throw new Error('请先打开当前主机的对话');
    if (state.source && sourceScope()) {
      // Reopening the shortcut must retain the draft, selection and active turn.
      state.open = true;
      state.connected = canConnect();
      state.notice = '已打开现有侧边聊天，保留当前问答和草稿。需要新的上下文时，请等待任务完成后另开侧边分支。';
      return;
    }
    const title = mainState.activeThread.name || mainState.activeThread.preview || '';
    prepareSource({ kind: 'conversation', hostId: mainState.hostId, threadId: mainState.activeThread.id,
      ...(typeof title === 'string' && title.trim() ? { threadName: title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) } : {}) });
  }
  function prepareSource(source: SideChatSource) {
    if (state.saving && state.source && (state.source.hostId !== source.hostId || state.source.threadId !== source.threadId))
      throw new Error('侧边分支正在保存，请等待保存回执后再打开新的侧边聊天');
    if (state.source && (state.source.hostId !== source.hostId || state.source.threadId !== source.threadId)) void close();
    if (!state.source) {
      ++generation;
      identity = runtimeIdentity();
      if (unknownForks.has(saveScope(source))) state.saveUncertain = 'fork';
    }
    state.source = source;
    if (!state.threadId && !restoringSave) {
      const version = generation;
      restoringSave = (async () => {
        await api.privateSessionReady?.();
        const receipt = await journal.read('side-branch-save', journalKey(source));
        if (!receipt || !stillCurrent(version, source) || state.threadId || !receipt.anchor) return;
        const anchor = receipt.anchor.kind === 'conversation' ? receipt.anchor : normalizeConversationSelection(receipt.anchor);
        if (!anchor || anchor.hostId !== source.hostId || anchor.threadId !== source.threadId) return;
        state.anchor = anchor; state.boundary = receipt.boundary || {};
        state.threadId = receipt.threadId || ''; state.items = receipt.items || []; state.turns = receipt.turns || [];
        state.saveTargetThreadId = receipt.saved || ''; savedBranchPath = receipt.path || '';
        inheritedGoalCleared = !!receipt.goalCleared; pendingSaveBatch = receipt.batch || null;
        for (const [key, text] of receipt.messages || []) savedMessages.set(key, text);
        emptyAnchorTail = receipt.emptyAnchorTail || null;
        state.saveUncertain = !receipt.saved ? 'fork' : receipt.phase === 'inject' ? 'inject' : '';
        state.notice = receipt.saved ? `已恢复保存记录，正式分支 ${receipt.saved} 可核对并继续保存。` : '已恢复未确认的分支创建记录，请先核对原生对话 ID。';
      })().catch((cause: any) => { if (stillCurrent(version, source)) state.error = `无法恢复分支保存记录：${cause.message}`; }).finally(() => { restoringSave = null; });
    }
    state.open = true;
    state.connected = canConnect();
    state.error = '';
    state.notice = state.threadId ? '后续提问沿用首次创建的侧边上下文；如需按新选段重新继承历史，请另开侧边分支。' : '';
  }
  async function newBranch() {
    const source = state.source && { ...state.source };
    if (!source || state.busy || state.loading || state.saving) throw new Error('请等待侧边任务完成');
    await close();
    prepareSource(source);
  }
  function noteTurn(turn: any) {
    if (!turn?.id) return;
    const index = state.turns.findIndex(entry => entry.id === turn.id);
    const previous = index < 0 ? null : state.turns[index];
    const merged = mergeTurnSnapshot(previous, turn);
    if (index < 0) state.turns.push(merged);
    else state.turns[index] = merged;
    for (const item of turn.items || []) {
      upsertItem(state.items, { ...item, turnId: turn.id });
      revisions.set(item.id, ++eventRevision);
    }
    invalidateSavedTranscript();
  }
  function forkBoundary(source: SideChatSource) {
    // The official /side behavior forks all native history, including the
    // current partial turn. A lastTurnId cannot name an in-progress turn.
    if ('kind' in source && source.kind === 'conversation') return {};
    const turns = mainState.turns || [];
    const selected = source.turnId && turns.find((turn: any) => turn.id === source.turnId);
    if (selected && ['completed', 'failed', 'interrupted'].includes(selected.status)) return { lastTurnId: selected.id };
    const active = [...turns].reverse().find((turn: any) => !turn.status || turn.status === 'inProgress');
    // The protocol forbids forking through a running turn. Its selected text is
    // supplied explicitly even when only the preceding history can be forked.
    if (active) return { beforeTurnId: active.id };
    const completed = [...turns].reverse().find((turn: any) => ['completed', 'failed', 'interrupted'].includes(turn.status));
    return completed ? { lastTurnId: completed.id } : {};
  }
  function readOnlyPolicy() {
    const requirements = mainState.requirements;
    const allowed = requirements?.allowedApprovalPolicies;
    const approvalPolicy = !allowed || allowed.includes('never') ? 'never' : ['on-request', 'untrusted'].find(value => allowed.includes(value));
    if (!approvalPolicy) throw new Error('当前主机的管理策略不允许侧边聊天的审批策略');
    return resolvePermissionProfile({
      id: 'web-side-chat', name: '侧边聊天', sandboxMode: 'read-only',
      approvalPolicy: approvalPolicy as any, networkAccess: false,
    }, { cwd: mainState.activeThread?.cwd || mainState.projectPath, requirements });
  }
  async function clearInheritedGoal(hostId: string, threadId: string) {
    try {
      const result = await call(hostId, 'thread/goal/get', { threadId });
      if (result?.goal) await call(hostId, 'thread/goal/clear', { threadId });
    } catch (cause: any) {
      // A CLI predating native goals cannot have an inherited goal to run.
      if (cause?.code === -32601) return;
      // Current native app-server explicitly forbids goals on ephemeral forks.
      if (cause?.code === -32600 && String(cause?.message || '').startsWith('ephemeral thread does not support goals:')) return;
      throw new Error(`无法确认侧边聊天的目标状态：${cause?.message || String(cause)}`);
    }
  }
  async function send(question: string) {
    const preparedGeneration = generation;
    if (restoringSave) await restoringSave;
    if (preparedGeneration !== generation || disposed) return;
    const source = state.source && { ...state.source };
    if (!source || !sourceScope()) throw new Error('当前对话已变化，请重新打开侧边聊天');
    if (!question.trim()) return;
    if (question.trim().length > 16_000) throw new Error('侧边问题过长，请缩短后发送');
    if (!canConnect()) throw new Error('工作站尚未连接，请等待连接恢复');
    if (requestPending || state.busy || state.loading) throw new Error('请等待侧边聊天当前任务完成');
    const policy = readOnlyPolicy();
    const version = generation;
    const model = mainState.model || mainState.activeThread?.model || '';
    const effort = mainState.effort || 'medium';
    const cwd = mainState.activeThread?.cwd || mainState.projectPath;
    requestPending = true;
    state.loading = true;
    state.error = '';
    state.notice = '';
    let id = state.threadId;
    let optimisticId = '';
    try {
      if (!id) {
        if (threadEnded) { state.items = []; state.turns = []; threadEnded = false; }
        const boundary = forkBoundary(source);
        const parentTail = mainState.turns?.at(-1);
        const stableTailId = !mainState.busy && ['completed', 'failed', 'interrupted'].includes(parentTail?.status) ? parentTail.id : '';
        const result = await call(source.hostId, 'thread/fork', {
          threadId: source.threadId, ...boundary, excludeTurns: true, ephemeral: true,
          sandbox: policy.sandbox, approvalPolicy: policy.approvalPolicy,
          model: model || undefined, cwd,
        });
        id = result?.thread?.id;
        if (typeof id !== 'string' || id === source.threadId) throw new Error('服务器未创建独立的侧边聊天');
        remember(source.hostId, id);
        if (!stillCurrent(version, source)) { await release(source.hostId, id); return; }
        if (result.thread.ephemeral !== true) {
          await release(source.hostId, id);
          throw new Error('当前 Codex 不支持临时侧边聊天，请更新服务器上的 Codex');
        }
        // Ephemeral forks cannot use deferGoalContinuation. Confirm the new
        // branch's independent goal state before its first explicit turn.
        try { await clearInheritedGoal(source.hostId, id); }
        catch (cause) { await release(source.hostId, id).catch(() => {}); throw cause; }
        if (!stillCurrent(version, source)) { await release(source.hostId, id); return; }
        state.threadId = id;
        state.anchor = { ...source };
        // A later formal save can reproduce a completed parent anchor. A fork
        // containing an active partial turn cannot be recreated by truncating
        // the subsequently changed parent, so keep that case explicitly guarded.
        state.boundary = 'kind' in source && source.kind === 'conversation' && stableTailId &&
          !mainState.busy && mainState.turns?.at(-1)?.id === stableTailId ? { lastTurnId: stableTailId } : boundary;
        emptyAnchorTail = mainState.turns?.at(-1)?.id || null;
      }
      if (!stillCurrent(version, source)) return;
      optimisticId = randomUUID();
      const input = [
        { type: 'text', text: question.trim(), text_elements: [] },
        ...(source.text ? [{ type: 'text', text: formatConversationQuote(source as SelectedConversationText), text_elements: [] }] : []),
      ];
      upsertItem(state.items, { id: optimisticId, clientId: optimisticId, type: 'userMessage', content: input, status: 'sending' });
      invalidateSavedTranscript();
      state.busy = true;
      const revision = eventRevision;
      const result = await call(source.hostId, 'turn/start', {
        threadId: id, clientUserMessageId: optimisticId, input, cwd,
        model: model || undefined, effort, approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy,
        ...(mainState.modeCapabilities?.plan && model ? { collaborationMode: nativeCollaborationMode('default', model, effort) } : {}),
      });
      if (!stillCurrent(version, source)) {
        await release(source.hostId, id, result?.turn?.status === 'inProgress' ? result.turn.id : undefined);
        return;
      }
      // A streamed completion can precede the private start acknowledgement.
      if (eventRevision === revision) {
        noteTurn(result?.turn);
        state.busy = !result?.turn?.status || result.turn.status === 'inProgress';
        activeTurnId = state.busy ? result.turn?.id || '' : '';
      } else if (!activeTurnId && state.busy && result?.turn?.id) {
        const completed = state.turns.some(turn => turn.id === result.turn.id && ['completed', 'failed', 'interrupted'].includes(turn.status));
        if (!completed) activeTurnId = result.turn.id;
      }
      const item = state.items.find(entry => entry.id === optimisticId || entry.clientId === optimisticId);
      if (item) {
        if (['sending', 'unconfirmed'].includes(item.status)) delete item.status;
        if (result?.turn?.id) item.turnId = result.turn.id;
      }
    } catch (cause: any) {
      if (!stillCurrent(version, source)) return;
      state.error = cause?.message || String(cause);
      if (cause?.uncertain) {
        state.error += '；请同步侧边聊天后确认，勿重复发送';
        if (optimisticId) {
          const item = state.items.find(entry => entry.id === optimisticId);
          if (item) item.status = 'unconfirmed';
        }
        void recover();
      } else {
        if (optimisticId) state.items = state.items.filter(item => item.id !== optimisticId);
        state.busy = false;
        activeTurnId = '';
      }
      throw cause;
    } finally {
      if (generation === version) { requestPending = false; state.loading = false; }
    }
  }
  async function verifyPendingInjection(source: SideChatSource) {
    if (!pendingSaveBatch || !state.saveTargetThreadId) return false;
    let path = savedBranchPath;
    if (!path) {
      const metadata = await call(source.hostId, 'thread/read', { threadId: state.saveTargetThreadId, includeTurns: false });
      path = metadata?.thread?.path;
    }
    if (typeof path !== 'string' || !path.startsWith('/')) return false;
    const result = await call(source.hostId, 'fs/readFile', { path });
    if (typeof result?.dataBase64 !== 'string' || result.dataBase64.length > 12 * 1024 * 1024) return false;
    const bytes = Uint8Array.from(atob(result.dataBase64), character => character.charCodeAt(0));
    const rollout = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // A positive native append is conclusive. Absence cannot rule out a delayed
    // mutation, so it never authorizes re-injecting an unknown batch.
    return rollout.split('\n').some(line => {
      try {
        const row = JSON.parse(line);
        return row.type === 'response_item' && row.payload?.type === 'message' &&
          row.payload.content?.some((part: any) => part.type === 'input_text' && part.text === pendingSaveBatch?.text);
      } catch { return false; }
    });
  }
  async function saveBranch(name?: string) {
    if (restoringSave) await restoringSave;
    const source = state.anchor && { ...state.anchor };
    if (!source || !state.threadId || !canConnect()) throw new Error('请先完成侧边提问并连接主机');
    if (state.busy || state.loading || requestPending || state.saving) throw new Error('请等待侧边任务完成');
    if (state.saveUncertain === 'fork') throw new Error('创建分支的结果尚未确认；请先核对原生对话 ID，不能重复创建');
    if (state.items.some(item => ['sending', 'unconfirmed'].includes(item.status))) throw new Error('侧边消息尚未确认，请先同步后再保存');
    if (state.savedThreadId && !hasUnsavedMessages()) return state.savedThreadId;
    if ('kind' in source && source.kind === 'conversation' && !state.boundary.lastTurnId)
      throw new Error('此侧边聊天继承了运行中的部分上下文，无法准确复刻为正式分支；请使用“引用回答到主对话”保留回答');
    if (!state.boundary.lastTurnId && !state.boundary.beforeTurnId && (mainState.turns?.at(-1)?.id || null) !== emptyAnchorTail)
      throw new Error('首次侧边提问没有可固定的轮次，而父对话历史已变化；请引用回答到主对话，或另开侧边分支');
    const policy = readOnlyPolicy();
    const version = generation;
    const current = () => stillCurrent(version, source);
    const savedScopeKey = saveScope(source);
    const savingVersion = ++savingOperation;
    const batch = pendingSaveBatch || (() => {
      const entries = visibleMessages().filter(item => savedMessages.get(item.key) !== item.text);
      const marker = randomUUID();
      const text = `侧边问答记录（仅可见新增或更新的问答，作为参考上下文；批次 ${marker}）：\n\n${entries.map(item => item.text).join('\n\n')}`;
      if (new TextEncoder().encode(text).length > 128 * 1024) throw new Error('侧边问答超过 128 KB，请先引用需要保存的回答到主对话');
      return { marker, text, entries };
    })();
    state.saving = true; state.error = '';
    let saved = state.saveTargetThreadId;
    let forkDispatched = false;
    let phase: 'fork' | 'goal' | 'inject' | 'name' = saved ? 'goal' : 'fork';
    const receipt: any = { anchor: source, boundary: { ...state.boundary }, threadId: state.threadId, items: JSON.parse(JSON.stringify(state.items)), turns: JSON.parse(JSON.stringify(state.turns)), emptyAnchorTail, messages: [...savedMessages], saved, path: savedBranchPath, goalCleared: inheritedGoalCleared, batch, phase };
    const persist = () => journal.write('side-branch-save', journalKey(source), { ...receipt, saved, phase }, true);
    try {
      await api.privateSessionReady?.(); await persist();
      if (!current()) throw new Error('侧边聊天已切换，保存操作尚未发送');
      if (!saved) {
        forkDispatched = true;
        const result = await call(source.hostId, 'thread/fork', {
          threadId: source.threadId, ...state.boundary, ephemeral: false, excludeTurns: true, deferGoalContinuation: true,
          sandbox: policy.sandbox, approvalPolicy: policy.approvalPolicy, cwd: mainState.activeThread?.cwd || mainState.projectPath,
        });
        saved = result?.thread?.id;
        if (!saved || saved === source.threadId || result.thread.ephemeral) { saved = ''; throw Object.assign(new Error('服务器未返回可核对的正式分支 ID'), { uncertain: true }); }
        receipt.path = typeof result.thread.path === 'string' ? result.thread.path : '';
        if (current()) { state.saveTargetThreadId = saved; savedBranchPath = receipt.path; }
        phase = 'goal'; await persist();
        if (!current()) return saved;
      }
      if (!current()) return saved;
      if (!inheritedGoalCleared) {
        phase = 'goal'; await clearInheritedGoal(source.hostId, saved);
        if (!current()) return saved;
        inheritedGoalCleared = true; receipt.goalCleared = true;
      }
      phase = 'inject';
      if (state.saveUncertain === 'inject') {
        let confirmed = false;
        try { confirmed = await verifyPendingInjection(source); } catch { /* Keep the outcome protected. */ }
        if (!current()) return saved;
        if (!confirmed) throw Object.assign(new Error('问答追加结果尚未确认，不能重复追加；请检查已创建分支'), { uncertain: true });
        state.saveUncertain = '';
      } else if (batch.entries.length) {
        pendingSaveBatch = batch; await persist();
        await call(source.hostId, 'thread/inject_items', { threadId: saved, items: [{ type: 'message', role: 'user',
          content: [{ type: 'input_text', text: batch.text }] }] });
        if (!current()) return saved;
      }
      for (const item of batch.entries) savedMessages.set(item.key, item.text);
      pendingSaveBatch = null;
      phase = 'name'; receipt.batch = null; receipt.messages = [...savedMessages]; await persist();
      const label = (name?.trim() || `${source.threadName || '对话'} · 侧边问答`).slice(0, 160);
      await call(source.hostId, 'thread/name/set', { threadId: saved, name: label });
      if (!current()) return saved;
      await api.rememberSideBranch?.(source.hostId, saved, label);
      await api.refreshThreads?.();
      if (current()) {
        state.savedThreadId = hasUnsavedMessages() ? '' : saved;
        state.notice = '已保存并置顶正式分支：继承首次历史锚点，并追加新增可见问答作为上下文。';
      }
      await journal.remove('side-branch-save', journalKey(source));
      return saved;
    } catch (cause: any) {
      // Only a confirmed pre-fork failure permits a new creation attempt.
      const failedPhase = phase;
      // A known formal ID is retained even when saving its receipt fails.
      if (!saved && (!forkDispatched || !cause?.uncertain)) await journal.remove('side-branch-save', journalKey(source)).catch(() => {});
      if (saved && phase === 'inject' && !cause?.uncertain) {
        phase = 'goal'; receipt.batch = null;
        await persist().catch(() => {});
      }
      if (cause?.uncertain && phase === 'fork') {
        unknownForks.add(savedScopeKey);
      }
      if (current()) {
        if (cause?.uncertain && phase === 'fork') state.saveUncertain = 'fork';
        if (cause?.uncertain && phase === 'inject') state.saveUncertain = 'inject';
        if (!cause?.uncertain && failedPhase === 'inject') pendingSaveBatch = null;
        state.savedThreadId = '';
        state.error = saved ? `分支已创建（${saved}），保存尚未完成：${cause?.message || String(cause)}；重试会核对并继续此分支。` :
          cause?.uncertain ? '创建分支的结果尚未确认；请先核对原生对话 ID，已阻止重复创建。' : cause?.message || String(cause);
      }
      throw cause;
    } finally {
      if (saved) await call(source.hostId, 'thread/unsubscribe', { threadId: saved }).catch(() => {});
      if (savingOperation === savingVersion) state.saving = false;
    }
  }
  async function resumeSavedBranch(threadId: string) {
    const source = state.anchor && { ...state.anchor };
    if (!source || state.saveUncertain !== 'fork' || !canConnect() || state.saving || state.busy || state.loading)
      throw new Error('请先完成当前任务并连接主机');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId) || threadId === source.threadId) throw new Error('请输入已创建分支的有效对话 ID');
    const version = generation;
    const savingVersion = ++savingOperation;
    const current = () => stillCurrent(version, source);
    const policy = readOnlyPolicy();
    state.saving = true; state.error = '';
    let verified = false;
    try {
      const metadata = await call(source.hostId, 'thread/read', { threadId, includeTurns: false });
      if (!current()) throw new Error('侧边聊天已切换，请重新核对分支');
      if (metadata?.thread?.id !== threadId || metadata.thread.ephemeral || metadata.thread.forkedFromId !== source.threadId)
        throw new Error('此对话不是从当前父对话创建的正式分支');
      if (metadata.thread.status?.type === 'active') throw new Error('此分支正在运行，请先等待其任务完成');
      verified = true;
      // Record the verified ID before any further native mutation. A refresh
      // during goal/settings cleanup must continue this branch, never fork again.
      await api.privateSessionReady?.();
      const recovered = { anchor: source, boundary: { ...state.boundary }, threadId: state.threadId,
        items: JSON.parse(JSON.stringify(state.items)), turns: JSON.parse(JSON.stringify(state.turns)),
        emptyAnchorTail, messages: [], saved: threadId, path: metadata.thread.path || '', goalCleared: false, batch: null, phase: 'goal' };
      await journal.write('side-branch-save', journalKey(source), recovered, true);
      // Resume can continue an inherited goal before its response. Both native
      // goal clearing and settings updates work directly on unloaded threads.
      await clearInheritedGoal(source.hostId, threadId);
      if (!current()) throw new Error('侧边聊天已切换，请重新核对分支');
      await call(source.hostId, 'thread/settings/update', { threadId, sandboxPolicy: policy.sandboxPolicy, approvalPolicy: policy.approvalPolicy });
      if (!current()) throw new Error('侧边聊天已切换，请重新核对分支');
      state.saveTargetThreadId = threadId; state.savedThreadId = ''; state.saveUncertain = '';
      savedBranchPath = metadata.thread.path || '';
      inheritedGoalCleared = true; savedMessages.clear(); pendingSaveBatch = null;
      await journal.write('side-branch-save', journalKey(source), { ...recovered, goalCleared: true }, true);
      unknownForks.delete(saveScope(source));
      state.notice = '已核对正式分支来源；后续保存将继续此分支，并保持只读权限。';
    } catch (cause: any) {
      if (current()) state.error = cause?.message || String(cause);
      throw cause;
    } finally {
      if (verified) await call(source.hostId, 'thread/unsubscribe', { threadId }).catch(() => {});
      if (savingOperation === savingVersion) state.saving = false;
    }
  }
  function answerQuote() {
    if (!state.source) return null;
    const answer = [...state.items].reverse().find(item => item.type === 'agentMessage' && item.text?.trim());
    return answer ? normalizeConversationSelection({ hostId: state.source.hostId, threadId: state.source.threadId, threadName: state.source.threadName,
      itemId: undefined, turnId: undefined, text: answer.text }) : null;
  }
  function interrupt(): Promise<void> {
    const source = state.source;
    const threadId = state.threadId;
    if (!source || !threadId) return Promise.resolve();
    if (threadId === source.threadId) return Promise.reject(new Error('无法确认独立的侧边分支，请重新打开侧边聊天'));
    if (!canConnect() || !state.connected) return Promise.reject(new Error('工作站尚未连接，请等待连接恢复'));
    if (requestPending || state.loading || state.saving) return Promise.reject(new Error('侧边任务正在准备，请等待轮次确认后再停止'));
    if (!activeTurnId) {
      return state.busy ? Promise.reject(new Error('无法确定侧边任务的轮次，请等待状态更新或关闭侧边聊天')) : Promise.resolve();
    }
    const version = generation;
    const requestIdentity = runtimeIdentity();
    if (interruptRequest?.source === source && interruptRequest.threadId === threadId && interruptRequest.version === version &&
        interruptRequest.authenticationGeneration === requestIdentity.authenticationGeneration && interruptRequest.engineId === requestIdentity.engineId)
      return interruptRequest.promise;
    const operation = ++interruptGeneration;
    const turnId = activeTurnId;
    const current = () => operation === interruptGeneration && stillCurrent(version, source) && state.source === source &&
      state.threadId === threadId && canConnect() && state.connected && !requestPending && !state.loading && !state.saving &&
      runtimeIdentity().authenticationGeneration === requestIdentity.authenticationGeneration && runtimeIdentity().engineId === requestIdentity.engineId;
    const changed = () => new Error('侧边任务轮次已变化，请同步侧边聊天后再停止。');
    const promise = (async () => {
      try {
        try { await call(source.hostId, 'turn/interrupt', { threadId, turnId }); return; }
        catch (cause) {
          if (!current()) return;
          const candidate = interruptConflictCandidate(cause, turnId);
          if (!candidate) throw cause;
          const otherLiveTurn = () => !!activeTurnId && activeTurnId !== turnId && activeTurnId !== candidate;
          if (otherLiveTurn()) throw changed();
          const revision = eventRevision;
          // Verify only the newest native turn. Ephemeral stores which cannot
          // page history stay protected; never resume or read the parent here.
          const page = await call(source.hostId, 'thread/turns/list', {
            threadId, cursor: null, limit: 1, sortDirection: 'desc', itemsView: 'summary',
          });
          if (!current()) return;
          // A newer turn observed before the read also outranks stored history.
          if (otherLiveTurn()) throw changed();
          const latest = Array.isArray(page?.data) ? page.data[0] : undefined;
          if (!latest || latest.id !== candidate) throw changed();
          const known = state.turns.find(turn => turn.id === candidate);
          const runtimeChanged = eventRevision !== revision;
          if (runtimeChanged && (activeTurnId !== candidate || !state.busy)) {
            if ((!activeTurnId || activeTurnId === turnId) && ['completed', 'failed', 'interrupted'].includes(known?.status)) {
              activeTurnId = ''; state.busy = false;
              return;
            }
            throw changed();
          }
          if (['completed', 'failed', 'interrupted'].includes(latest.status)) {
            if (!runtimeChanged) { activeTurnId = ''; state.busy = false; }
            return;
          }
          if (latest.status !== 'inProgress' || ['completed', 'failed', 'interrupted'].includes(known?.status)) throw changed();
          if (!runtimeChanged) { activeTurnId = candidate; state.busy = true; }
          try { await call(source.hostId, 'turn/interrupt', { threadId, turnId: candidate }); }
          catch (error) { throw interruptConflictCandidate(error, candidate) ? changed() : error; }
        }
      } catch (error) { if (current()) throw error; }
    })().finally(() => { if (interruptRequest?.promise === promise) interruptRequest = null; });
    interruptRequest = { source, threadId, version, ...requestIdentity, promise };
    return promise;
  }
  async function recover() {
    if (recovering) return recovering;
    const source = state.source && { ...state.source };
    if (!source || !state.threadId || !canConnect()) return;
    const version = generation;
    const threadId = state.threadId;
    const revision = eventRevision;
    const recovery = (async () => {
      try {
        let page: any;
        try { page = await call(source.hostId, 'thread/turns/list', { threadId, limit: 30, sortDirection: 'desc', itemsView: 'full' }); }
        catch (cause: any) {
          if (cause?.code !== -32600 || cause?.message !== 'ephemeral threads do not support thread/turns/list') throw cause;
          const metadata = await call(source.hostId, 'thread/read', { threadId, includeTurns: false });
          if (!stillCurrent(version, source) || threadId !== state.threadId) return;
          if (revision === eventRevision) {
            state.busy = metadata?.thread?.status?.type === 'active';
            if (!state.busy) activeTurnId = '';
          }
          state.notice = state.busy && !activeTurnId
            ? '侧边连接已恢复，但临时对话无法补读断线消息；正在等待回答状态，关闭侧边聊天可释放此分支'
            : '侧边连接已恢复；临时对话不支持补读断线期间的消息';
          return;
        }
        if (!stillCurrent(version, source) || threadId !== state.threadId) return;
        const turns = [...(page.data || [])].reverse();
        const live = new Map(state.turns.map(turn => [turn.id, turn]));
        const seen = new Set(turns.map(turn => turn.id));
        state.turns = [
          ...turns.map(turn => (turnRevisions.get(turn.id) || 0) > revision && live.has(turn.id) ? mergeTurnSnapshot(turn, live.get(turn.id)) : turn),
          ...state.turns.filter(turn => !seen.has(turn.id) && (turnRevisions.get(turn.id) || 0) > revision),
        ];
        const changed = new Set([...revisions].filter(([, value]) => value > revision).map(([id]) => id));
        state.items = mergeSnapshotItems(turns.flatMap(turn => (turn.items || []).map((item: any) => ({ ...item, turnId: turn.id }))), state.items, changed,
          { retainedTurnIds: new Set(state.turns.map(turn => turn.id)) });
        const active = [...state.turns].reverse().find(turn => turn.status === 'inProgress');
        state.busy = !!active;
        activeTurnId = active?.id || '';
      } catch (cause: any) {
        if (stillCurrent(version, source)) state.error = `无法恢复侧边聊天：${cause?.message || String(cause)}`;
      }
    })();
    recovering = recovery;
    await recovery;
    if (recovering === recovery) recovering = null;
  }
  const unsubscribe = api.subscribeProtocol?.((hostId: string, message: any) => {
    const { method, params: params = {} } = message;
    if (method === 'bridge/disconnecting' && state.source) {
      ++interruptGeneration;
      interruptRequest = null;
      const nextIdentity = runtimeIdentity();
      if (params.permanent || identity?.authenticationGeneration !== nextIdentity.authenticationGeneration) void close();
      else state.connected = false;
      return;
    }
    if (method === 'bridge/status' && state.source && hostId === state.source?.hostId) {
      if (identity?.engineId && params.engineId && identity.engineId !== params.engineId) {
        state.threadId = '';
        if (!state.saveTargetThreadId) resetSavedBranch();
        if (state.source && unknownForks.has(saveScope(state.source))) state.saveUncertain = 'fork';
        state.items = [];
        state.turns = [];
        state.busy = false;
        activeTurnId = '';
        threadEnded = true;
        state.error = 'Codex 进程已重启，临时侧边聊天已结束；重新发送会创建新分支';
        state.notice = '';
        ++generation;
        requestPending = false;
        state.loading = false;
      }
      if (params.engineId) identity = { ...runtimeIdentity(), engineId: params.engineId };
      return;
    }
    const thread = params.thread;
    const threadId = params.threadId || thread?.id;
    if (!threadId || !ownedThreads.has(ownedKey(hostId, threadId))) return;
    if (message.id !== undefined) return; // Managed-policy approvals remain globally accessible.
    if (!state.source || hostId !== state.source.hostId || threadId !== state.threadId) return true;
    if (method?.startsWith('item/')) {
      const itemId = params.item?.id || params.itemId;
      if (itemId) revisions.set(itemId, ++eventRevision);
      applyItemEvent(state.items, method, params);
      invalidateSavedTranscript();
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      noteTurn(params.turn);
      turnRevisions.set(params.turn?.id, ++eventRevision);
      if (method === 'turn/started' && !state.turns.some(turn => turn.id === params.turn?.id && ['completed', 'failed', 'interrupted'].includes(turn.status))) {
        activeTurnId = params.turn?.id || '';
        state.busy = true;
      } else if (method === 'turn/completed' && (!activeTurnId || activeTurnId === params.turn?.id)) {
        activeTurnId = '';
        state.busy = false;
        if (params.turn?.error?.message) state.error = params.turn.error.message;
      }
    }
    if (method === 'error') state.error = params.error?.message || '侧边聊天运行失败';
    if (method === 'thread/closed' || method === 'thread/deleted') {
      // A delayed start/read acknowledgement must not revive an ended branch.
      // Keep any in-flight formal save and its durable receipt until it settles;
      // it has its own identity so invalidating this renderer cannot strand it.
      ++generation;
      ++interruptGeneration;
      interruptRequest = null;
      ++eventRevision;
      requestPending = false;
      recovering = null;
      state.threadId = '';
      state.busy = false;
      state.loading = false;
      activeTurnId = '';
      threadEnded = true;
      state.error = '临时侧边聊天已结束，重新发送会创建新分支';
    }
    return true;
  }) || (() => {});
  const stopScope = watch(() => [mainState.hostId, mainState.activeThread?.id, mainState.authenticated, mainState.switchingHost], () => {
    if (state.source && (!sourceScope() || mainState.switchingHost)) void close();
  }, { flush: 'sync' });
  const stopConnection = watch(() => [mainState.connected, mainState.runtimePaused], () => {
    if (!state.source) return;
    const previous = state.connected;
    state.connected = canConnect();
    if (!previous && state.connected) void recover();
  });
  function dispose() {
    if (disposed) return;
    void close();
    disposed = true;
    stopScope(); stopConnection(); unsubscribe();
  }
  if (getCurrentScope()) onScopeDispose(dispose);
  return { state, prepare, prepareConversation, send, interrupt, close, recover, newBranch, saveBranch, resumeSavedBranch, answerQuote, dispose };
}
