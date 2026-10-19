import { reactive, type InjectionKey } from 'vue';
import { isStoredThreadReadReceipt, isThreadReadReceipt, MAX_THREAD_READ_TURN_IDS, type StoredThreadReadReceipt, type ThreadReadReceipt } from '../../shared/thread-read-receipts';

export type ThreadIndicator = 'running' | 'error' | 'unread' | null;
type Entry = { hostId: string; threadId: string; phase: 'running' | 'error' | 'complete' | 'idle'; turnId: string; startedAt: number; read: boolean; activityAt: number; metadataActive: boolean; settled: string[]; changedAt: number };
type Snapshot = { hostId: string; id: string; status?: { type?: string }; activityAt: number };
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): unknown };
export const threadIndicatorStorageKey = 'codex.threadIndicators.v1';
const key = (hostId: string, threadId: string) => JSON.stringify([hostId, threadId]);
const validId = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256;
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value >= 1e12 ? value / 1000 : value : 0;

/** Only operation identities and read receipts are persisted, never titles,
 * prompts, output or other conversation content. Metadata writes alone cannot
 * create unread completions; activityAt must be actual content recency. */
export function createThreadIndicators(storage: Storage, now = Date.now, onRead?: (receipt: ThreadReadReceipt) => void) {
  const entries = reactive(new Map<string, Entry>());
  // Receipts can precede the navigation page or completion event. Keep them
  // separately from indicators so receiving a receipt cannot invent a phase.
  const receipts = new Map<string, StoredThreadReadReceipt>();
  const localReceipts = new Map<string, StoredThreadReadReceipt>();
  let visible = '';
  function trimReceipts(records: Map<string, StoredThreadReadReceipt>) {
    while (records.size > 1000) records.delete(records.keys().next().value!);
  }
  function mergeReceipt(records: Map<string, StoredThreadReadReceipt>, receipt: StoredThreadReadReceipt) {
    const id = key(receipt.hostId, receipt.threadId), previous = records.get(id);
    const previousTurns = previous?.turnIds || [], newTurns = receipt.turnIds.filter(turn => !previousTurns.includes(turn));
    const turnIds = (previous && receipt.activityAt < previous.activityAt ? [...newTurns, ...previousTurns] : [...previousTurns, ...newTurns]).slice(-MAX_THREAD_READ_TURN_IDS);
    const activityAt = Math.max(previous?.activityAt || 0, receipt.activityAt);
    if (previous && activityAt === previous.activityAt && turnIds.length === previous.turnIds.length && turnIds.every((turn, index) => turn === previous.turnIds[index])) return false;
    records.delete(id);
    records.set(id, { hostId: receipt.hostId, threadId: receipt.threadId, turnIds, activityAt });
    trimReceipts(records);
    return true;
  }
  function receiptFor(entry: Entry): ThreadReadReceipt | null {
    const receipt = { hostId: entry.hostId, threadId: entry.threadId,
      turnId: entry.turnId || (entry.activityAt > 0 ? `recency:${entry.activityAt}` : ''), activityAt: entry.activityAt };
    return isThreadReadReceipt(receipt) ? receipt : null;
  }
  function rememberRead(entry: Entry, notify = true) {
    const receipt = receiptFor(entry);
    if (!receipt) return false;
    const stored = { hostId: receipt.hostId, threadId: receipt.threadId, turnIds: [receipt.turnId], activityAt: receipt.activityAt };
    const changed = mergeReceipt(localReceipts, stored);
    const combinedChanged = mergeReceipt(receipts, stored);
    if (changed && notify) { try { onRead?.(receipt); } catch { /* A failed sync does not undo the local read. */ } }
    return changed || combinedChanged;
  }
  function hasReceipt(entry: Entry) {
    const receipt = receipts.get(key(entry.hostId, entry.threadId));
    if (!receipt) return false;
    // A content watermark is only sufficient for a metadata placeholder. Two
    // actual turns can complete in the same second and require their exact ID.
    return receipt.turnIds.includes(entry.turnId) || entry.turnId.startsWith('recency:') && entry.activityAt > 0 && entry.activityAt <= receipt.activityAt;
  }
  function applyReceipts() {
    let changed = false;
    for (const [id, entry] of entries) {
      if (entry.phase === 'complete' && !entry.read && hasReceipt(entry)) {
        entries.set(id, { ...entry, read: true });
        changed = true;
      }
    }
    return changed;
  }
  function merge(raw: string | null, notify = true) {
    try {
      const saved = JSON.parse(raw || 'null');
      if (saved?.version !== 1 || !Array.isArray(saved.entries)) return;
      let migrated = false;
      for (const receipt of Array.isArray(saved.receipts) ? saved.receipts.slice(-1000) : []) {
        if (isStoredThreadReadReceipt(receipt)) mergeReceipt(receipts, receipt);
      }
      for (const receipt of Array.isArray(saved.localReceipts) ? saved.localReceipts.slice(-1000) : []) {
        if (!isStoredThreadReadReceipt(receipt)) continue;
        const previous = localReceipts.get(key(receipt.hostId, receipt.threadId));
        const previousTurns = new Set(previous?.turnIds || []), previousActivity = previous?.activityAt || 0;
        if (mergeReceipt(localReceipts, receipt) && notify) {
          for (const turnId of receipt.turnIds) {
            if (!previousTurns.has(turnId) || receipt.activityAt > previousActivity) {
              try { onRead?.({ hostId: receipt.hostId, threadId: receipt.threadId, turnId, activityAt: receipt.activityAt }); } catch {}
            }
          }
        }
        mergeReceipt(receipts, receipt);
      }
      for (const item of saved.entries.slice(0, 1000)) {
        if (!item || !validId(item.hostId) || !validId(item.threadId) || !['running', 'error', 'complete', 'idle'].includes(item.phase) ||
          typeof item.turnId !== 'string' || item.turnId.length > 256 || typeof item.read !== 'boolean' ||
          typeof item.metadataActive !== 'boolean' || !Number.isFinite(item.activityAt) || item.activityAt < 0 ||
          !Number.isFinite(item.changedAt) || !Array.isArray(item.settled)) continue;
        const id = key(item.hostId, item.threadId), previous = entries.get(id);
        const entry = { hostId: item.hostId, threadId: item.threadId, phase: item.phase, turnId: item.turnId,
          startedAt: timestamp(item.startedAt), activityAt: timestamp(item.activityAt), metadataActive: item.metadataActive,
          read: item.read || previous?.turnId === item.turnId && !!previous?.read || item.phase === 'complete' && id === visible,
          settled: item.settled.filter(validId).slice(-8), changedAt: item.changedAt } as Entry;
        // Legacy local reads remain useful even when another tab already has
        // a later phase. Only the original read bit is eligible for migration.
        if (entry.phase === 'complete' && item.read && !Array.isArray(saved.localReceipts) && rememberRead(entry, notify)) migrated = true;
        if (previous && previous.changedAt > item.changedAt) continue;
        if (entry.phase === 'complete') {
          entry.read ||= hasReceipt(entry);
          // Migrate the old entries-only format. New remote acknowledgements
          // are never promoted to local reads when another tab merges them.
          if (id === visible) rememberRead(entry, notify);
        }
        entries.set(id, entry);
      }
      applyReceipts();
      if (entries.size > 1000) {
        const retained = [...entries.entries()].sort((a, b) => b[1].changedAt - a[1].changedAt).slice(0, 1000);
        entries.clear();
        for (const [id, entry] of retained) entries.set(id, entry);
      }
      if (migrated) save();
    } catch { /* Missing, blocked or invalid local storage cannot break chat. */ }
  }
  try { merge(storage.getItem(threadIndicatorStorageKey), false); } catch {}
  function save() {
    const records = [...entries.values()].sort((a, b) => b.changedAt - a.changedAt).slice(0, 1000);
    if (entries.size > 1000) {
      const retained = new Set(records.map(record => key(record.hostId, record.threadId)));
      for (const id of entries.keys()) if (!retained.has(id)) entries.delete(id);
    }
    try { storage.setItem(threadIndicatorStorageKey, JSON.stringify({ version: 1, entries: records, receipts: [...receipts.values()], localReceipts: [...localReceipts.values()] })); } catch {}
  }
  function write(entry: Entry) {
    const id = key(entry.hostId, entry.threadId), previous = entries.get(id);
    if (entry.phase === 'complete') entry.read ||= id === visible || hasReceipt(entry);
    const receiptChanged = entry.phase === 'complete' && id === visible ? rememberRead(entry) : false;
    const changed = !previous || JSON.stringify({ ...previous, changedAt: 0 }) !== JSON.stringify({ ...entry, changedAt: 0 });
    if (changed) entries.set(id, { ...entry, changedAt: now() });
    if (changed || receiptChanged) save();
  }
  function initial(hostId: string, threadId: string): Entry {
    return { hostId, threadId, phase: 'idle', turnId: '', startedAt: 0, read: false, activityAt: 0, metadataActive: false, settled: [], changedAt: now() };
  }
  function setVisible(hostId: string, threadId?: string | null) {
    visible = validId(hostId) && validId(threadId) ? key(hostId, threadId) : '';
    const previous = entries.get(visible);
    if (previous?.phase === 'complete') write({ ...previous, read: true });
    else if (previous?.phase === 'idle' && previous.activityAt > 0 && rememberRead(previous)) save();
  }
  function observe(hostId: string, message: any) {
    const params = message?.params, threadId = params?.threadId;
    if (!validId(hostId) || !validId(threadId)) return;
    const id = key(hostId, threadId), previous = entries.get(id) || initial(hostId, threadId);
    if (message.method === 'thread/deleted') {
      const removed = entries.delete(id), receiptRemoved = receipts.delete(id), localRemoved = localReceipts.delete(id);
      if (removed || receiptRemoved || localRemoved) save();
      return;
    }
    if (message.method === 'thread/status/changed' && params.status?.type === 'systemError') { write({ ...previous, phase: 'error' }); return; }
    if (message.method === 'error' && params.willRetry === false) {
      if (params.turnId && previous.turnId && params.turnId !== previous.turnId) return;
      write({ ...previous, phase: 'error' });
      return;
    }
    const turn = params.turn;
    if (!validId(turn?.id)) return;
    if (message.method === 'turn/started') {
      if (previous.settled.includes(turn.id)) return;
      write({ ...previous, phase: 'running', turnId: turn.id, startedAt: timestamp(turn.startedAt), read: false, activityAt: Math.max(previous.activityAt, timestamp(turn.startedAt)) });
    } else if (message.method === 'turn/completed') {
      if (previous.settled.includes(turn.id) && previous.turnId !== turn.id) return;
      if (previous.phase === 'running' && previous.turnId && previous.turnId !== turn.id && !previous.turnId.startsWith('recency:')) return;
      const activityAt = timestamp(turn.completedAt) || timestamp(turn.startedAt);
      if (activityAt && activityAt < previous.activityAt && previous.turnId !== turn.id) return;
      const read = id === visible || previous.read && previous.turnId === turn.id;
      write({ ...previous, phase: turn.status === 'failed' ? 'error' : turn.status === 'completed' ? 'complete' : 'idle',
        turnId: turn.id, read, activityAt: Math.max(previous.activityAt, activityAt),
        settled: [...previous.settled.filter(value => value !== turn.id), turn.id].slice(-8) });
    }
  }
  function observeThreads(threads: Snapshot[]) {
    let changed = false;
    for (const thread of threads) {
      if (!validId(thread.hostId) || !validId(thread.id)) continue;
      const id = key(thread.hostId, thread.id), previous = entries.get(id);
      const activityAt = timestamp(thread.activityAt), status = thread.status?.type;
      if (previous && activityAt && activityAt < previous.activityAt) continue;
      let entry = previous ? { ...previous } : initial(thread.hostId, thread.id);
      if (status === 'systemError') { entry.phase = 'error'; entry.metadataActive = false; }
      else if (status === 'active') {
        if (!previous || activityAt > previous.activityAt || previous.phase === 'idle' && !previous.turnId || previous.phase === 'error' && !previous.metadataActive) {
          entry.phase = 'running'; entry.read = false;
          if (previous && activityAt > previous.activityAt && previous.phase !== 'running') entry.turnId = '';
        }
        entry.metadataActive = true;
      } else if (status === 'idle') {
        if (previous && (previous.activityAt > 0 || previous.metadataActive) && activityAt > previous.activityAt && previous.phase !== 'error' &&
          (previous.phase !== 'running' || previous.metadataActive || previous.startedAt > 0 && activityAt > previous.startedAt)) {
          entry.phase = 'complete'; entry.turnId = `recency:${activityAt}`; entry.read = id === visible;
        } else if (previous?.metadataActive && previous.phase === 'running') entry.phase = 'idle';
        entry.metadataActive = false;
      }
      entry.activityAt = Math.max(entry.activityAt, activityAt);
      if (entry.phase === 'complete') entry.read ||= hasReceipt(entry);
      if (id === visible && (entry.phase === 'complete' || entry.phase === 'idle' && entry.activityAt > 0)) {
        if (entry.phase === 'complete') entry.read = true;
        if (rememberRead(entry)) changed = true;
      }
      if (!previous || JSON.stringify(entry) !== JSON.stringify(previous)) {
        entry.changedAt = now(); entries.set(id, entry); changed = true;
      }
    }
    if (changed) save();
  }
  function indicator(hostId: string, threadId: string, forceRunning = false): ThreadIndicator {
    const entry = entries.get(key(hostId, threadId));
    if (forceRunning || entry?.phase === 'running') return 'running';
    if (entry?.phase === 'error') return 'error';
    return entry?.phase === 'complete' && !entry.read ? 'unread' : null;
  }
  function reconcileCompletedTurn(hostId: string, threadId: string, turn: any) {
    const entry = entries.get(key(hostId, threadId));
    if (!validId(hostId) || !validId(threadId) || !validId(turn?.id) || !['completed', 'failed', 'interrupted'].includes(turn.status)) return;
    if (entry?.phase === 'running') {
      observe(hostId, { method: 'turn/completed', params: { threadId, turn } });
    } else if (turn.status === 'completed' && key(hostId, threadId) === visible) {
      // Reading existing history must acknowledge the actual turn identity,
      // even when navigation only established an idle metadata baseline.
      const receipt = { ...(entry || initial(hostId, threadId)), turnId: turn.id,
        activityAt: timestamp(turn.completedAt) || timestamp(turn.startedAt) || entry?.activityAt || 0 };
      if (rememberRead(receipt)) save();
    }
  }
  function mergeReceipts(records: StoredThreadReadReceipt[]) {
    if (!Array.isArray(records)) return;
    let changed = false;
    for (const receipt of records.slice(-1000)) {
      if (isStoredThreadReadReceipt(receipt) && mergeReceipt(receipts, receipt)) changed = true;
    }
    if (applyReceipts()) changed = true;
    if (changed) save();
  }
  function readReceipts(): ThreadReadReceipt[] {
    return [...localReceipts.values()].flatMap(receipt => receipt.turnIds.map(turnId => ({
      hostId: receipt.hostId, threadId: receipt.threadId, turnId, activityAt: receipt.activityAt,
    })));
  }
  return { mergeReceipts, readReceipts, indicator, known: (hostId: string, threadId: string) => entries.has(key(hostId, threadId)), observe, observeThreads, setVisible, merge, reconcileCompletedTurn };
}

export type ThreadIndicators = ReturnType<typeof createThreadIndicators>;
export const threadIndicatorsKey: InjectionKey<ThreadIndicators> = Symbol('thread-indicators');
