import { getCurrentScope, onScopeDispose, reactive, watch } from 'vue';
import { resolvePermissionProfile } from './configuration';
import { nativeCollaborationMode } from './conversation-modes';
import { applyItemEvent, mergeSnapshotItems, upsertItem, type DisplayItem } from './events';
import { mergeTurnSnapshot } from './thread-sync';
import { formatConversationQuote, normalizeConversationSelection, type ConversationSelectionSource } from './conversation-selection';
import { randomUUID } from './uuid';

export type SelectedConversationText = ConversationSelectionSource;
export type SideChatState = {
  open: boolean;
  source: SelectedConversationText | null;
  threadId: string;
  anchor: SelectedConversationText | null;
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
  let disposed = false;
  let threadEnded = false;
  let identity: { authenticationGeneration?: number; engineId?: string | null } | null = null;
  let recovering: Promise<void> | null = null;
  let eventRevision = 0;
  const revisions = new Map<string, number>();
  const turnRevisions = new Map<string, number>();
  const ownedThreads = new Set<string>();
  const savedMessages = new Map<string, string>();
  const unknownForks = new Set<string>();
  const saveScope = (source: SelectedConversationText) => JSON.stringify([source.hostId, source.threadId, runtimeIdentity().authenticationGeneration]);
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
  function stillCurrent(version: number, source: SelectedConversationText) {
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
    if (state.source && (state.source.hostId !== source.hostId || state.source.threadId !== source.threadId)) void close();
    if (!state.source) {
      ++generation;
      identity = runtimeIdentity();
      if (unknownForks.has(saveScope(source))) state.saveUncertain = 'fork';
    }
    state.source = source;
    state.open = true;
    state.connected = canConnect();
    state.error = '';
    state.notice = state.threadId ? '后续提问沿用首次创建的侧边上下文；如需按新选段重新继承历史，请另开侧边分支。' : '';
  }
  async function newBranch() {
    const source = state.source && { ...state.source };
    if (!source || state.busy || state.loading || state.saving) throw new Error('请等待侧边任务完成');
    await close();
    prepare(source);
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
  function forkBoundary(source: SelectedConversationText) {
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
    const source = state.source && { ...state.source };
    if (!source || !sourceScope()) throw new Error('请在当前对话中重新选择文本');
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
        state.boundary = boundary;
        emptyAnchorTail = mainState.turns?.at(-1)?.id || null;
      }
      if (!stillCurrent(version, source)) return;
      optimisticId = randomUUID();
      const input = [
        { type: 'text', text: question.trim(), text_elements: [] },
        { type: 'text', text: formatConversationQuote(source), text_elements: [] },
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
  async function verifyPendingInjection(source: SelectedConversationText) {
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
    const source = state.anchor && { ...state.anchor };
    if (!source || !state.threadId || !canConnect()) throw new Error('请先完成侧边提问并连接主机');
    if (state.busy || state.loading || requestPending || state.saving) throw new Error('请等待侧边任务完成');
    if (state.saveUncertain === 'fork') throw new Error('创建分支的结果尚未确认；请先核对原生对话 ID，不能重复创建');
    if (state.items.some(item => ['sending', 'unconfirmed'].includes(item.status))) throw new Error('侧边消息尚未确认，请先同步后再保存');
    if (state.savedThreadId && !hasUnsavedMessages()) return state.savedThreadId;
    if (!state.boundary.lastTurnId && !state.boundary.beforeTurnId && (mainState.turns?.at(-1)?.id || null) !== emptyAnchorTail)
      throw new Error('首次侧边提问没有可固定的轮次，而父对话历史已变化；请引用回答到主对话，或另开侧边分支');
    const policy = readOnlyPolicy();
    const version = generation;
    const current = () => stillCurrent(version, source);
    const savedScopeKey = saveScope(source);
    const batch = pendingSaveBatch || (() => {
      const entries = visibleMessages().filter(item => savedMessages.get(item.key) !== item.text);
      const marker = randomUUID();
      const text = `侧边问答记录（仅可见新增或更新的问答，作为参考上下文；批次 ${marker}）：\n\n${entries.map(item => item.text).join('\n\n')}`;
      if (new TextEncoder().encode(text).length > 128 * 1024) throw new Error('侧边问答超过 128 KB，请先引用需要保存的回答到主对话');
      return { marker, text, entries };
    })();
    state.saving = true; state.error = '';
    let saved = state.saveTargetThreadId;
    let phase: 'fork' | 'goal' | 'inject' | 'name' = saved ? 'goal' : 'fork';
    try {
      if (!saved) {
        const result = await call(source.hostId, 'thread/fork', {
          threadId: source.threadId, ...state.boundary, ephemeral: false, excludeTurns: true, deferGoalContinuation: true,
          sandbox: policy.sandbox, approvalPolicy: policy.approvalPolicy, cwd: mainState.activeThread?.cwd || mainState.projectPath,
        });
        saved = result?.thread?.id;
        if (!saved || saved === source.threadId || result.thread.ephemeral) throw new Error('服务器未创建正式分支');
        if (!current()) return saved;
        state.saveTargetThreadId = saved;
        savedBranchPath = typeof result.thread.path === 'string' ? result.thread.path : '';
      }
      if (!current()) return saved;
      if (!inheritedGoalCleared) {
        phase = 'goal'; await clearInheritedGoal(source.hostId, saved);
        if (!current()) return saved;
        inheritedGoalCleared = true;
      }
      phase = 'inject';
      if (state.saveUncertain === 'inject') {
        let confirmed = false;
        try { confirmed = await verifyPendingInjection(source); } catch { /* Keep the outcome protected. */ }
        if (!current()) return saved;
        if (!confirmed) throw Object.assign(new Error('问答追加结果尚未确认，不能重复追加；请检查已创建分支'), { uncertain: true });
        state.saveUncertain = '';
      } else if (batch.entries.length) {
        pendingSaveBatch = batch;
        await call(source.hostId, 'thread/inject_items', { threadId: saved, items: [{ type: 'message', role: 'user',
          content: [{ type: 'input_text', text: batch.text }] }] });
        if (!current()) return saved;
      }
      for (const item of batch.entries) savedMessages.set(item.key, item.text);
      pendingSaveBatch = null;
      phase = 'name';
      const label = (name?.trim() || `${source.threadName || '对话'} · 侧边问答`).slice(0, 160);
      await call(source.hostId, 'thread/name/set', { threadId: saved, name: label });
      if (!current()) return saved;
      await api.rememberSideBranch?.(source.hostId, saved, label);
      await api.refreshThreads?.();
      if (current()) {
        state.savedThreadId = hasUnsavedMessages() ? '' : saved;
        state.notice = '已保存并置顶正式分支：继承首次历史锚点，并追加新增可见问答作为上下文。';
      }
      return saved;
    } catch (cause: any) {
      if (cause?.uncertain && phase === 'fork') {
        unknownForks.add(savedScopeKey);
        while (unknownForks.size > 32) unknownForks.delete(unknownForks.values().next().value!);
      }
      if (current()) {
        if (cause?.uncertain && phase === 'fork') state.saveUncertain = 'fork';
        if (cause?.uncertain && phase === 'inject') state.saveUncertain = 'inject';
        if (!cause?.uncertain && phase === 'inject') pendingSaveBatch = null;
        state.savedThreadId = '';
        state.error = saved ? `分支已创建（${saved}），保存尚未完成：${cause?.message || String(cause)}；重试会核对并继续此分支。` :
          cause?.uncertain ? '创建分支的结果尚未确认；请先核对原生对话 ID，已阻止重复创建。' : cause?.message || String(cause);
      }
      throw cause;
    } finally {
      if (saved) await call(source.hostId, 'thread/unsubscribe', { threadId: saved }).catch(() => {});
      if (generation === version) state.saving = false;
    }
  }
  async function resumeSavedBranch(threadId: string) {
    const source = state.anchor && { ...state.anchor };
    if (!source || state.saveUncertain !== 'fork' || !canConnect() || state.saving || state.busy || state.loading)
      throw new Error('请先完成当前任务并连接主机');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId) || threadId === source.threadId) throw new Error('请输入已创建分支的有效对话 ID');
    const version = generation;
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
      // Resume can continue an inherited goal before its response. Both native
      // goal clearing and settings updates work directly on unloaded threads.
      await clearInheritedGoal(source.hostId, threadId);
      if (!current()) throw new Error('侧边聊天已切换，请重新核对分支');
      await call(source.hostId, 'thread/settings/update', { threadId, sandboxPolicy: policy.sandboxPolicy, approvalPolicy: policy.approvalPolicy });
      if (!current()) throw new Error('侧边聊天已切换，请重新核对分支');
      state.saveTargetThreadId = threadId; state.savedThreadId = ''; state.saveUncertain = '';
      savedBranchPath = metadata.thread.path || '';
      inheritedGoalCleared = true; savedMessages.clear(); pendingSaveBatch = null;
      unknownForks.delete(saveScope(source));
      state.notice = '已核对正式分支来源；后续保存将继续此分支，并保持只读权限。';
    } catch (cause: any) {
      if (current()) state.error = cause?.message || String(cause);
      throw cause;
    } finally {
      if (verified) await call(source.hostId, 'thread/unsubscribe', { threadId }).catch(() => {});
      if (generation === version) state.saving = false;
    }
  }
  function answerQuote() {
    if (!state.source) return null;
    const answer = [...state.items].reverse().find(item => item.type === 'agentMessage' && item.text?.trim());
    return answer ? normalizeConversationSelection({ ...state.source, itemId: undefined, turnId: undefined, text: answer.text }) : null;
  }
  async function interrupt() {
    if (!state.source || !state.threadId) return;
    if (!activeTurnId) {
      if (state.busy) throw new Error('无法确定侧边任务的轮次，请等待状态更新或关闭侧边聊天');
      return;
    }
    await call(state.source.hostId, 'turn/interrupt', { threadId: state.threadId, turnId: activeTurnId });
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
        state.items = mergeSnapshotItems(turns.flatMap(turn => (turn.items || []).map((item: any) => ({ ...item, turnId: turn.id }))), state.items, changed);
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
      const nextIdentity = runtimeIdentity();
      if (params.permanent || identity?.authenticationGeneration !== nextIdentity.authenticationGeneration) void close();
      else state.connected = false;
      return;
    }
    if (method === 'bridge/status' && state.source && hostId === state.source?.hostId) {
      if (identity?.engineId && params.engineId && identity.engineId !== params.engineId) {
        state.threadId = '';
        resetSavedBranch();
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
    if (method === 'thread/closed') {
      state.threadId = '';
      state.busy = false;
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
  return { state, prepare, send, interrupt, close, recover, newBranch, saveBranch, resumeSavedBranch, answerQuote, dispose };
}
