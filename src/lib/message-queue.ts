import { privateState } from './private-state';
import { computed, getCurrentScope, onScopeDispose, reactive, watch } from 'vue';
import type { QueuedSubmission } from '../../shared/protocol/v2/QueuedSubmission';
import type { UserInput } from '../../shared/protocol/v2/UserInput';
import { methodAccepts, type IntegrationCapabilities } from './integration-capabilities';

const queueFields: Record<string, string[]> = {
  'thread/queue/add': ['threadId', 'input', 'clientUserMessageId'],
  'thread/queue/list': ['threadId', 'limit'],
  'thread/queue/update': ['threadId', 'queuedSubmissionId', 'input'],
  'thread/queue/delete': ['threadId', 'queuedSubmissionId'],
  'thread/queue/reorder': ['threadId', 'queuedSubmissionIds'],
  'thread/queue/start': ['threadId', 'queuedSubmissionId'],
  'thread/settings/update': ['threadId', 'cwd', 'model', 'effort', 'sandboxPolicy', 'approvalPolicy'],
};
type Scope = { key: string; hostId: string; threadId: string; authenticationGeneration?: number; engineId?: string | null };
type UnknownOutcome = { operation: string; clientId?: string; input?: UserInput[] };
export function queuedText(submission: Pick<QueuedSubmission, 'input'>) {
  return submission.input.find(input => input.type === 'text')?.text || '';
}
/** Editing the prompt preserves later quoted context, images and skill/app inputs. */
export function editedQueueInput(submission: Pick<QueuedSubmission, 'input'>, text: string): UserInput[] {
  const input = JSON.parse(JSON.stringify(submission.input)) as UserInput[];
  const prompt = input.findIndex(entry => entry.type === 'text');
  if (prompt >= 0) input[prompt] = { type: 'text', text, text_elements: [] };
  else input.unshift({ type: 'text', text, text_elements: [] });
  return input;
}

/** Native queues survive browser closure; this controller never runs a web timer to send them. */
export function useMessageQueue(api: any, main: any) {
  const state = reactive({
    status: 'unknown' as 'unknown' | 'supported' | 'unsupported',
    reason: '正在检查当前 Codex 的原生消息队列能力…',
    items: [] as QueuedSubmission[], loading: false, mutating: false,
    error: '', notice: '', restoring: false, uncertain: null as UnknownOutcome | null,
  });
  let disposed = false;
  let generation = 0;
  let listRevision = 0;
  let capabilityIdentity = '';
  let capabilities: IntegrationCapabilities | null = null;
  let capabilityRequest: Promise<void> | null = null;
  let listRequest: Promise<void> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let capabilityRetry: ReturnType<typeof setTimeout> | undefined;
  let retryCount = 0;
  let verifiedRead = false;
  const journal = api.operationJournal || privateState;
  let restoring: Promise<void> | null = null;
  const receiptKey = (saved: Scope) => JSON.stringify([saved.hostId, saved.threadId]);
  const unknownOutcomes = new Map<string, UnknownOutcome>();
  const scope = (): Scope | null => {
    const identity = api.runtimeIdentity?.() || {};
    const threadId = main.activeThread?.id;
    if (!main.authenticated || !threadId) return null;
    return { ...identity, hostId: main.hostId, threadId,
      key: JSON.stringify([main.hostId, threadId, identity.authenticationGeneration]) };
  };
  const current = (saved: Scope, version: number) => !disposed && generation === version &&
    scope()?.key === saved.key && (api.runtimeIdentity?.().engineId ?? null) === (saved.engineId ?? null);
  const readable = () => !!scope() && main.connected && main.online !== false && !main.runtimePaused && !main.switchingHost &&
    !main.selectingThread && main.threadReady !== false;
  const blockedReason = computed(() => {
    if (!scope()) return '请先打开一个对话';
    if (!main.connected || main.online === false) return '工作站连接中断，请等待恢复';
    if (main.switchingHost || main.selectingThread || main.threadReady === false) return '正在同步当前对话';
    if (main.runtimePaused || main.threadReleased) return '此会话的 Web Codex 已释放，请先恢复连接';
    if (main.threadConflict) return '此对话被其他 Codex 客户端占用，请先取得写入权限';
    if (main.permission === 'read-only') return '只读权限下不能修改消息队列';
    if (main.compacting || main.changingContext || main.editingMessage || main.modeBusy) return '当前对话正在变更，请稍候';
    if (state.status !== 'supported') return state.reason;
    if (state.restoring) return '正在恢复队列操作回执';
    if (state.uncertain) return '上一项队列操作的结果尚未确认，请先核对队列和对话';
    if (state.mutating) return '队列操作正在提交';
    return '';
  });
  const canMutate = computed(() => !blockedReason.value);
  function call(saved: Scope, method: string, params: any) {
    try { return Promise.resolve(api.sideChatRpc(saved.hostId, method, params)); }
    catch (cause) { return Promise.reject(cause); }
  }
  function clearTimers() {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (capabilityRetry) clearTimeout(capabilityRetry);
    refreshTimer = capabilityRetry = undefined;
  }
  function resetScope() {
    ++generation; ++listRevision;
    listRequest = null; capabilityRequest = null; verifiedRead = false; state.items = []; state.loading = false; state.mutating = false;
    state.error = ''; state.notice = '';
    restoring = null; state.restoring = !!scope();
    state.uncertain = scope() ? unknownOutcomes.get(scope()!.key) || null : null;
  }
  async function restoreReceipt() {
    const saved = scope(); if (!saved || !state.restoring) return;
    if (restoring) return restoring;
    const version = generation;
    const operation = (async () => {
      try {
        await api.privateSessionReady?.();
        const outcome = await journal.read('queue-outcome', receiptKey(saved));
        if (!current(saved, version)) return;
        if (outcome) { unknownOutcomes.set(saved.key, outcome); state.uncertain = outcome; }
        state.restoring = false;
      } catch (cause: any) {
        if (current(saved, version)) { state.error = `恢复队列回执失败：${cause.message}`; state.restoring = true; }
      }
    })();
    restoring = operation; await operation; if (restoring === operation) restoring = null;
  }
  function scheduleRefresh() {
    ++listRevision;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 80);
  }
  async function checkCapabilities(force = false) {
    const saved = scope();
    if (!saved || !main.connected || main.runtimePaused) return;
    const identity = JSON.stringify([saved.hostId, saved.engineId, saved.authenticationGeneration]);
    if (!force && identity === capabilityIdentity && state.status !== 'unknown') return;
    if (state.restoring) await restoreReceipt();
    if (capabilityRequest) return capabilityRequest;
    const version = generation;
    capabilityIdentity = identity;
    capabilityRequest = (async () => {
      try {
        const result = await api.requestHttp(`/hosts/${encodeURIComponent(saved.hostId)}/native-capabilities`, {}, false);
        if (!current(saved, version)) return;
        capabilities = result;
        if (result?.status !== 'known') {
          state.status = 'unknown'; state.reason = '暂时无法确认原生队列能力，可稍后重试';
        } else {
          const supported = Object.entries(queueFields).every(([method, fields]) => methodAccepts(result, method, fields));
          state.status = supported ? 'supported' : 'unsupported';
          state.reason = supported ? '' : '此主机的 Codex 不支持当前原生消息队列协议，请更新 Codex 并重新连接';
          retryCount = 0;
        }
      } catch (cause: any) {
        if (!current(saved, version)) return;
        state.status = 'unknown'; state.reason = `队列能力检查失败：${cause?.message || String(cause)}`;
      } finally {
        if (current(saved, version)) {
          capabilityRequest = null;
          if (state.status === 'supported') void refresh();
          else if (state.status === 'unknown' && retryCount < 3 && !capabilityRetry) {
            capabilityRetry = setTimeout(() => {
              capabilityRetry = undefined;
              if (current(saved, version) && main.connected) void checkCapabilities(true);
            }, Math.min(30000, 15000 * ++retryCount));
          }
        }
      }
    })();
    return capabilityRequest;
  }
  function confirmedClient(clientId: string) {
    return state.items.some(item => item.clientUserMessageId === clientId) || (main.items || []).some((item: any) =>
      item.type === 'userMessage' && (item.clientId === clientId || item.id === clientId) &&
      !['sending', 'unconfirmed'].includes(item.status));
  }
  function reconcileUnknown(saved: Scope) {
    const outcome = unknownOutcomes.get(saved.key);
    if (outcome?.clientId && confirmedClient(outcome.clientId)) {
      state.notice = '已确认上一条消息已被 Codex 接收，请核对并清理保留的草稿';
      state.error = '';
    }
  }
  async function refresh() {
    const saved = scope();
    if (!saved || !readable() || state.status !== 'supported') return;
    if (state.restoring) await restoreReceipt();
    if (listRequest) return listRequest;
    const version = generation;
    const revision = listRevision;
    state.loading = true;
    let request!: Promise<void>;
    request = (async () => {
      try {
        const items: QueuedSubmission[] = [];
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const params: any = { threadId: saved.threadId, limit: 100 };
          if (cursor) {
            if (!methodAccepts(capabilities, 'thread/queue/list', ['threadId', 'limit', 'cursor']))
              throw new Error('当前 Codex 的队列分页协议不兼容');
            params.cursor = cursor;
          }
          const page = await call(saved, 'thread/queue/list', params);
          if (!current(saved, version)) return;
          if (!Array.isArray(page?.data)) throw new Error('Codex 返回了无效的消息队列');
          for (const item of page.data) {
            if (!item || typeof item.id !== 'string' || !Array.isArray(item.input) || typeof item.clientUserMessageId !== 'string')
              throw new Error('Codex 返回了无效的队列项');
            items.push(item);
          }
          if (items.length > 1000) throw new Error('消息队列过大，请在 Codex 终端中检查');
          cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
          if (cursor && cursors.has(cursor)) throw new Error('消息队列分页游标重复');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        if (current(saved, version) && revision === listRevision) {
          state.items = items; verifiedRead = true;
          if (state.error.startsWith('加载消息队列失败：')) state.error = '';
          reconcileUnknown(saved);
        }
      } catch (cause: any) {
        if (current(saved, version)) state.error = `加载消息队列失败：${cause?.message || String(cause)}`;
      } finally {
        if (current(saved, version)) {
          state.loading = false;
          if (listRequest === request) listRequest = null;
          if (revision !== listRevision) scheduleRefresh();
        }
      }
    })();
    listRequest = request;
    return request;
  }
  async function mutate(method: string, params: any, outcome?: UnknownOutcome) {
    if (state.restoring) await restoreReceipt();
    if (blockedReason.value) throw new Error(blockedReason.value);
    const saved = scope()!;
    if (!methodAccepts(capabilities, method, Object.keys({ threadId: saved.threadId, ...params })))
      throw new Error('当前 Codex 的消息队列参数不兼容，请更新后重新连接');
    const version = generation;
    state.mutating = true; state.error = ''; state.notice = '';
    let accepted = false, dispatched = false;
    const receipt: UnknownOutcome = outcome || { operation: method, input: params.input };
    try {
      await api.privateSessionReady?.();
      await journal.write('queue-outcome', receiptKey(saved), receipt, true);
      if (!current(saved, version)) throw new Error('对话或连接已变化，操作未发送');
      if (['thread/queue/add', 'thread/queue/start'].includes(method)) await api.prepareQueuedSettings?.(saved.hostId, saved.threadId, capabilities);
      if (!current(saved, version)) throw new Error('对话或连接已变化，操作未发送');
      dispatched = true;
      const result = await call(saved, method, { threadId: saved.threadId, ...params });
      accepted = true;
      await journal.remove('queue-outcome', receiptKey(saved)).catch(() => {
        unknownOutcomes.set(saved.key, receipt); if (current(saved, version)) { state.uncertain = receipt; state.notice = '原生操作已接收，本机回执待清理，请先核对'; }
      });
      if (current(saved, version)) {
        ++listRevision;
        if (['thread/queue/add', 'thread/queue/update'].includes(method) && result?.queuedSubmission) {
          const item = result.queuedSubmission;
          const index = state.items.findIndex(existing => existing.id === item.id);
          if (index >= 0) state.items[index] = item; else state.items.push(item);
        }
        if (['thread/queue/delete', 'thread/queue/start'].includes(method))
          state.items = state.items.filter(item => item.id !== params.queuedSubmissionId);
        if (method === 'thread/queue/reorder') {
          const byId = new Map(state.items.map(item => [item.id, item]));
          state.items = params.queuedSubmissionIds.map((id: string) => byId.get(id)).filter(Boolean);
        }
      }
      return result;
    } catch (cause: any) {
      if (dispatched && cause?.uncertain) {
        const unknown = outcome || { operation: method };
        unknownOutcomes.set(saved.key, unknown);
        if (current(saved, version)) state.uncertain = unknown;
      }
      if (!dispatched || !cause?.uncertain) await journal.remove('queue-outcome', receiptKey(saved)).catch(() => {});
      if (current(saved, version)) state.error = cause?.uncertain
        ? '连接中断，队列操作可能已生效。已保留草稿，不会自动重复提交。'
        : cause?.message || String(cause);
      throw cause;
    } finally {
      if (current(saved, version)) {
        state.mutating = false;
        if (accepted) void refresh(); else await refresh();
      }
    }
  }
  async function add(input: UserInput[], clientId: string) {
    if (state.items.length >= 100) throw new Error('原生消息队列最多容纳 100 条消息');
    const saved = scope();
    try { return await mutate('thread/queue/add', { input, clientUserMessageId: clientId }, { operation: 'add', input, clientId }); }
    catch (cause: any) {
      if (cause?.uncertain && saved && scope()?.key === saved.key && confirmedClient(clientId)) {
        await journal.remove('queue-outcome', receiptKey(saved));
        unknownOutcomes.delete(saved.key); state.uncertain = null; state.error = '';
        return {};
      }
      throw cause;
    }
  }
  async function update(id: string, text: string) {
    const item = state.items.find(item => item.id === id);
    if (!item) throw new Error('队列项已变更，请刷新后重试');
    if (!text.trim()) throw new Error('排队消息不能为空');
    return mutate('thread/queue/update', { queuedSubmissionId: id, input: editedQueueInput(item, text) });
  }
  function remove(id: string) { return mutate('thread/queue/delete', { queuedSubmissionId: id }); }
  async function move(id: string, direction: -1 | 1) {
    const ids = state.items.map(item => item.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    return mutate('thread/queue/reorder', { queuedSubmissionIds: ids });
  }
  async function start(id: string) {
    if (main.busy) throw new Error('当前任务正在运行，请等待完成或停止后启动队列项');
    const saved = scope();
    const version = generation;
    const item = state.items.find(item => item.id === id);
    if (!item) throw new Error('队列项已变更，请刷新后重试');
    const result = await mutate('thread/queue/start', { queuedSubmissionId: id });
    if (saved && current(saved, version) && result?.turn)
      api.acceptQueuedTurn?.(saved.threadId, result.turn, { input: item.input, clientUserMessageId: item.clientUserMessageId });
    return result;
  }
  async function acknowledgeUncertain() {
    if (!readable() || !verifiedRead || state.loading || state.mutating) throw new Error('请先连接并刷新队列');
    const saved = scope();
    if (saved) { await journal.remove('queue-outcome', receiptKey(saved)); unknownOutcomes.delete(saved.key); }
    state.uncertain = null; state.error = '';
    state.notice = '已解除保护；再次发送前请确认对话和队列中没有同一条消息';
  }
  const stop = watch(() => [main.authenticated, main.hostId, main.activeThread?.id,
    main.connected, main.threadReady, main.runtimePaused, main.switchingHost, main.selectingThread, main.online], (values, previous) => {
    const saved = scope();
    if (!main.connected || main.online === false) verifiedRead = false;
    const previousScope = previous && JSON.stringify(previous.slice(0, 3));
    if (!previous || previousScope !== JSON.stringify(values.slice(0, 3))) resetScope();
    const identity = saved ? JSON.stringify([saved.hostId, saved.engineId, saved.authenticationGeneration]) : '';
    if (identity !== capabilityIdentity) {
      capabilities = null; capabilityRequest = null; capabilityIdentity = ''; retryCount = 0;
      state.status = 'unknown'; state.reason = '正在检查当前 Codex 的原生消息队列能力…';
      if (capabilityRetry) clearTimeout(capabilityRetry); capabilityRetry = undefined;
    }
    if (readable()) { void checkCapabilities(); if (state.status === 'supported') void refresh(); }
  }, { immediate: true });
  const unsubscribe = api.subscribeProtocol?.((hostId: string, message: any) => {
    if (hostId !== main.hostId) return;
    const p = message.params || {};
    if (message.method === 'bridge/status' && p.engineId && p.engineId !== (scope()?.engineId ?? null)) {
      resetScope(); capabilities = null; capabilityRequest = null; capabilityIdentity = ''; state.status = 'unknown';
      state.reason = 'Codex 已重新连接，正在检查队列能力…';
      queueMicrotask(() => { if (readable()) void checkCapabilities(); });
    }
    if ((message.method === 'thread/queue/changed' && p.threadId === main.activeThread?.id) ||
      (['turn/started', 'turn/completed'].includes(message.method) && p.threadId === main.activeThread?.id && (state.items.length || state.uncertain)) ||
      (['item/started', 'item/completed'].includes(message.method) && p.threadId === main.activeThread?.id && p.item?.type === 'userMessage' && state.uncertain))
      scheduleRefresh();
  });
  function dispose() { disposed = true; ++generation; clearTimers(); stop(); unsubscribe?.(); }
  if (getCurrentScope()) onScopeDispose(dispose);
  return { settingsLocked: computed(() => state.restoring || state.loading || state.mutating || !!state.uncertain || state.items.length > 0), state, canMutate, blockedReason, checkCapabilities, refresh, add, update, remove, move, start, acknowledgeUncertain, dispose };
}
