import { watch } from 'vue';
import {
  isStoredThreadReadReceipt, isThreadReadReceipt, threadReadReceiptKey,
  MAX_THREAD_READ_RECEIPTS, MAX_THREAD_READ_RECEIPT_BATCH, MAX_THREAD_READ_TURN_IDS,
  type ThreadReadReceipt, type StoredThreadReadReceipt,
} from '../../shared/thread-read-receipts';
import type { ThreadIndicators } from './thread-indicators';

/** Share acknowledgements through the Web service; drafts and reading positions stay local. */
export function createThreadReadSync(state: any, api: any, indicators: ThreadIndicators) {
  const pending = new Map<string, ThreadReadReceipt>();
  const confirmed = new Map<string, StoredThreadReadReceipt>();
  const delivered = new Map<string, number>();
  const imported = new Set<string>();
  const requests = new Set<AbortController>();
  let generation = 0, disposed = false, retryDelay = 2000;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<void> | null = null, writing: Promise<void> | null = null;
  const hostExists = (hostId: string) => state.hosts?.some((host: any) => host.id === hostId);
  const ready = () => !disposed && state.authenticated && state.online !== false && typeof api.requestHttp === 'function';
  const identity = (receipt: ThreadReadReceipt) => JSON.stringify([receipt.hostId, receipt.threadId, receipt.turnId]);
  function covered(receipt: ThreadReadReceipt) {
    if ((delivered.get(identity(receipt)) ?? -1) >= receipt.activityAt) return true;
    const value = confirmed.get(threadReadReceiptKey(receipt));
    return !!value && value.activityAt >= receipt.activityAt &&
      (value.turnIds.includes(receipt.turnId) || receipt.turnId.startsWith('recency:') && receipt.activityAt > 0);
  }
  function apply(input: unknown) {
    if (!Array.isArray(input)) return [] as StoredThreadReadReceipt[];
    const receipts = input.slice(0, MAX_THREAD_READ_RECEIPTS).filter(isStoredThreadReadReceipt)
      .filter(receipt => hostExists(receipt.hostId));
    for (const receipt of receipts) {
      const key = threadReadReceiptKey(receipt), previous = confirmed.get(key);
      confirmed.delete(key);
      const ids = previous && receipt.activityAt < previous.activityAt
        ? [...receipt.turnIds, ...previous.turnIds] : [...(previous?.turnIds || []), ...receipt.turnIds];
      confirmed.set(key, { ...receipt, activityAt: Math.max(previous?.activityAt || 0, receipt.activityAt),
        turnIds: [...new Set(ids)].slice(-MAX_THREAD_READ_TURN_IDS) });
    }
    while (confirmed.size > MAX_THREAD_READ_RECEIPTS) confirmed.delete(confirmed.keys().next().value!);
    indicators.mergeReceipts(receipts);
    for (const [key, receipt] of pending) if (covered(receipt)) pending.delete(key);
    return receipts;
  }
  async function request(method: 'GET' | 'POST', receipts?: ThreadReadReceipt[]) {
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await api.requestHttp('/thread-read-receipts', { method, signal: controller.signal,
        ...(receipts ? { body: JSON.stringify({ receipts }) } : {}) }, false);
    } finally { clearTimeout(timer); requests.delete(controller); }
  }
  function schedule(delay = 150) {
    if (!ready() || flushTimer || !pending.size) return;
    flushTimer = setTimeout(() => { flushTimer = undefined; void flush(); }, delay);
  }
  function markRead(receipt: ThreadReadReceipt) {
    if (disposed || !isThreadReadReceipt(receipt) || !hostExists(receipt.hostId) || covered(receipt)) return;
    const key = identity(receipt), previous = pending.get(key);
    if (!previous || receipt.activityAt > previous.activityAt) pending.set(key, { ...receipt });
    // The tracker bounds local receipts too. Keep failed/offline writes bounded.
    while (pending.size > MAX_THREAD_READ_RECEIPTS * MAX_THREAD_READ_TURN_IDS) pending.delete(pending.keys().next().value!);
    schedule();
  }
  function captureLocal() {
    if (!ready()) return;
    for (const receipt of indicators.readReceipts()) {
      if (!hostExists(receipt.hostId)) continue;
      const key = identity(receipt);
      if (imported.has(key)) continue;
      imported.add(key);
      markRead(receipt);
    }
    while (imported.size > MAX_THREAD_READ_RECEIPTS * MAX_THREAD_READ_TURN_IDS) imported.delete(imported.values().next().value!);
  }
  function flush(): Promise<void> {
    if (!ready() || writing) return writing || Promise.resolve();
    const batch = [...pending.values()].filter(receipt => hostExists(receipt.hostId)).slice(0, MAX_THREAD_READ_RECEIPT_BATCH);
    if (!batch.length) return Promise.resolve();
    const version = generation;
    let delay = 150;
    const task = (async () => {
      try {
        const result = await request('POST', batch);
        if (version !== generation || !ready()) return;
        const receipts = apply(result.receipts);
        const accepted = new Map(receipts.map(receipt => [threadReadReceiptKey(receipt), receipt]));
        // A full journal may retain newer exact IDs instead of an old migrated
        // turn. A successful per-thread response still acknowledges delivery.
        for (const receipt of batch) {
          if ((accepted.get(threadReadReceiptKey(receipt))?.activityAt ?? -1) < receipt.activityAt) continue;
          const key = identity(receipt);
          delivered.delete(key); delivered.set(key, receipt.activityAt);
          const queued = pending.get(key);
          if (queued && queued.activityAt <= receipt.activityAt) pending.delete(key);
        }
        while (delivered.size > MAX_THREAD_READ_RECEIPTS * MAX_THREAD_READ_TURN_IDS) delivered.delete(delivered.keys().next().value!);
        // A missing/invalid acknowledgement is not a successful write.
        if (batch.some(receipt => !covered(receipt))) throw new Error('Read acknowledgement was not confirmed');
        retryDelay = 2000;
      } catch {
        delay = retryDelay;
        retryDelay = Math.min(retryDelay * 2, 30000);
        // Reading the chat must work even when acknowledgement delivery fails.
      }
    })().finally(() => {
      if (writing === task) writing = null;
      if (version === generation) schedule(delay);
    });
    writing = task;
    return task;
  }
  function synchronize(): Promise<void> {
    if (!ready() || reading) return reading || Promise.resolve();
    const version = generation;
    const task = (async () => {
      try {
        const result = await request('GET');
        if (version !== generation || !ready()) return;
        apply(result.receipts);
        captureLocal();
        schedule();
      } catch { /* Focus, reconnection and the periodic refresh retry without disrupting chat. */ }
    })().finally(() => { if (reading === task) reading = null; });
    reading = task;
    return task;
  }
  function resume() {
    if (document.visibilityState === 'hidden' || !ready()) return;
    void synchronize();
    schedule(0);
  }
  const unsubscribe = api.subscribeProtocol?.((_hostId: string, message: any) => {
    if (!ready()) return;
    if (message.method === 'bridge/thread-read-receipts') apply(message.params?.receipts);
    else if (message.method === 'bridge/status' && message.params?.connected) resume();
  });
  const stopWatching = watch(() => [state.authenticated, state.authenticationGeneration, state.online,
    state.connected, state.hostId, state.hosts?.map((host: any) => host.id).join(',')], (current, previous) => {
    if (!previous || current[0] !== previous[0] || current[1] !== previous[1]) {
      ++generation;
      for (const controller of requests) controller.abort();
      reading = null; writing = null;
      confirmed.clear(); delivered.clear(); imported.clear(); pending.clear();
      clearTimeout(flushTimer); flushTimer = undefined;
    }
    if (ready()) { captureLocal(); resume(); }
  }, { immediate: true });
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  const refreshTimer = setInterval(resume, 30000);
  function stop() {
    disposed = true; ++generation;
    stopWatching(); unsubscribe?.();
    clearInterval(refreshTimer); clearTimeout(flushTimer);
    for (const controller of requests) controller.abort();
    pending.clear(); confirmed.clear(); delivered.clear(); imported.clear();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('focus', resume);
    window.removeEventListener('online', resume);
  }
  return { markRead, captureLocal, synchronize, stop };
}
