import { reactive, type InjectionKey } from 'vue';

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
export function createThreadIndicators(storage: Storage, now = Date.now) {
  const entries = reactive(new Map<string, Entry>());
  let visible = '';
  function merge(raw: string | null) {
    try {
      const saved = JSON.parse(raw || 'null');
      if (saved?.version !== 1 || !Array.isArray(saved.entries)) return;
      for (const item of saved.entries.slice(0, 1000)) {
        if (!item || !validId(item.hostId) || !validId(item.threadId) || !['running', 'error', 'complete', 'idle'].includes(item.phase) ||
          typeof item.turnId !== 'string' || item.turnId.length > 256 || typeof item.read !== 'boolean' ||
          typeof item.metadataActive !== 'boolean' || !Number.isFinite(item.activityAt) || item.activityAt < 0 ||
          !Number.isFinite(item.changedAt) || !Array.isArray(item.settled)) continue;
        const id = key(item.hostId, item.threadId), previous = entries.get(id);
        if (previous && previous.changedAt > item.changedAt) continue;
        entries.set(id, { ...item, startedAt: timestamp(item.startedAt), read: item.read || previous?.turnId === item.turnId && previous?.read || item.phase === 'complete' && id === visible,
          settled: item.settled.filter(validId).slice(-8) });
      }
    } catch { /* Missing, blocked or invalid local storage cannot break chat. */ }
  }
  try { merge(storage.getItem(threadIndicatorStorageKey)); } catch {}
  function save() {
    const records = [...entries.values()].sort((a, b) => b.changedAt - a.changedAt).slice(0, 1000);
    if (entries.size > 1000) {
      const retained = new Set(records.map(record => key(record.hostId, record.threadId)));
      for (const id of entries.keys()) if (!retained.has(id)) entries.delete(id);
    }
    try { storage.setItem(threadIndicatorStorageKey, JSON.stringify({ version: 1, entries: records })); } catch {}
  }
  function write(entry: Entry) {
    entries.set(key(entry.hostId, entry.threadId), { ...entry, changedAt: now() });
    save();
  }
  function initial(hostId: string, threadId: string): Entry {
    return { hostId, threadId, phase: 'idle', turnId: '', startedAt: 0, read: false, activityAt: 0, metadataActive: false, settled: [], changedAt: now() };
  }
  function setVisible(hostId: string, threadId?: string | null) {
    visible = threadId ? key(hostId, threadId) : '';
    const previous = entries.get(visible);
    if (previous && previous.phase === 'complete' && !previous.read) write({ ...previous, read: true });
  }
  function observe(hostId: string, message: any) {
    const params = message?.params, threadId = params?.threadId;
    if (!validId(hostId) || !validId(threadId)) return;
    const id = key(hostId, threadId), previous = entries.get(id) || initial(hostId, threadId);
    if (message.method === 'thread/deleted') { if (entries.delete(id)) save(); return; }
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
      const read = id === visible || previous.read && (previous.turnId === turn.id || previous.turnId.startsWith('recency:') && activityAt <= previous.activityAt);
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
    if (entry?.phase !== 'running' || !['completed', 'failed', 'interrupted'].includes(turn?.status)) return;
    observe(hostId, { method: 'turn/completed', params: { threadId, turn } });
  }
  return { indicator, known: (hostId: string, threadId: string) => entries.has(key(hostId, threadId)), observe, observeThreads, setVisible, merge, reconcileCompletedTurn };
}

export type ThreadIndicators = ReturnType<typeof createThreadIndicators>;
export const threadIndicatorsKey: InjectionKey<ThreadIndicators> = Symbol('thread-indicators');
