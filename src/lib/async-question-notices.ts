import { reactive } from 'vue';
import { asyncQuestionNoticeBatches, asyncQuestionNoticeKey, validAsyncQuestionNoticeFingerprint, type AsyncQuestionNotice } from '../../shared/async-question-notices';

type Api = {
  requestHttp(path: string, options?: RequestInit, reportError?: boolean): Promise<any>;
  runtimeIdentity(): { authenticationGeneration: number };
};

/** Server-backed, exact-question banner dismissal; native forms remain untouched. */
export function useAsyncQuestionNoticeDismissals(api: Api) {
  const state = reactive({ dismissals: {} as Record<string, AsyncQuestionNotice>, busy: false, loading: false });
  let revision = 0;
  let reading: { authentication: number; promise: Promise<void> } | undefined;
  let lastRead = 0;
  const authentication = () => api.runtimeIdentity().authenticationGeneration;
  const validated = (input: unknown) => Object.fromEntries((Array.isArray(input) ? input as AsyncQuestionNotice[] : [])
    .filter(entry => entry && typeof entry.fingerprint === 'string' && validAsyncQuestionNoticeFingerprint(entry.itemId, entry.fingerprint))
    .map(entry => [asyncQuestionNoticeKey(entry), entry]));
  function clear() { revision++; state.dismissals = {}; state.busy = false; state.loading = false; reading = undefined; lastRead = 0; }
  function hydrate(dismissals: unknown) {
    revision++; state.dismissals = validated(dismissals); state.loading = false; lastRead = Date.now();
  }
  async function refresh(force = false) {
    const identity = authentication();
    // A GET started during a pending POST could carry its old snapshot even
    // after the POST commits. The next synchronization can read the journal.
    if (state.busy) return;
    if (reading?.authentication === identity) return reading.promise;
    if (!force && Date.now() - lastRead < 15000) return;
    const started = revision;
    state.loading = true;
    const promise = (async () => {
      const result = await api.requestHttp('/async-question-notices', { signal: AbortSignal.timeout(10000) }, false);
      if (identity !== authentication() || started !== revision) return;
      state.dismissals = validated(result.dismissals);
      lastRead = Date.now();
    })().finally(() => {
      if (reading?.promise === promise) reading = undefined;
      if (identity === authentication() && started === revision) state.loading = false;
    });
    reading = { authentication: identity, promise };
    return promise;
  }
  function dismissed(notice: AsyncQuestionNotice) {
    return state.dismissals[asyncQuestionNoticeKey(notice)]?.fingerprint === notice.fingerprint;
  }
  async function dismiss(notices: AsyncQuestionNotice[]) {
    if (state.busy || !notices.length) return;
    const batches = asyncQuestionNoticeBatches(notices);
    const identity = authentication();
    const operation = ++revision;
    state.busy = true;
    state.loading = false;
    try {
      // The API body remains bounded even if many old conversations were read.
      for (const questions of batches) {
        await api.requestHttp('/async-question-notices/dismiss', { method: 'POST', body: JSON.stringify({ questions }), signal: AbortSignal.timeout(15000) }, false);
        if (identity !== authentication() || operation !== revision) return;
        for (const notice of questions) state.dismissals[asyncQuestionNoticeKey(notice)] = { ...notice };
      }
    } finally { if (identity === authentication() && operation === revision) state.busy = false; }
  }
  return { state, refresh, clear, hydrate, dismissed, dismiss };
}

/** At most two read-only native history checks, with retryable negative results. */
export class AsyncQuestionCheckQueue {
  private entries = new Map<string, { promise: Promise<void>; checkedAt: number }>();
  private waiting: Array<{ run(): void; cancel(): void }> = [];
  private running = 0;
  constructor(private now = () => Date.now(), private ttl = 20000) {}
  clear() { this.entries.clear(); for (const entry of this.waiting.splice(0)) entry.cancel(); }
  check(key: string, work: () => Promise<boolean>): Promise<void> {
    const previous = this.entries.get(key);
    if (previous && (!previous.checkedAt || this.now() - previous.checkedAt < this.ttl)) return previous.promise;
    if (!previous && this.entries.size >= 256) {
      const completed = [...this.entries].find(([, entry]) => entry.checkedAt);
      if (completed) this.entries.delete(completed[0]);
      else return Promise.resolve();
    }
    const entry = { promise: Promise.resolve(), checkedAt: 0 };
    entry.promise = new Promise<void>(resolve => {
      const run = () => {
        this.running++;
        void (async () => {
          try {
            // False means transport failure/stale login, so the next sync retries.
            if (await work()) entry.checkedAt = this.now() || 1;
            else if (this.entries.get(key) === entry) this.entries.delete(key);
          } catch { if (this.entries.get(key) === entry) this.entries.delete(key); }
          finally {
            this.running--;
            this.waiting.shift()?.run();
            resolve();
          }
        })();
      };
      if (this.running < 2) run(); else this.waiting.push({ run, cancel: resolve });
    });
    this.entries.set(key, entry);
    if (this.entries.size > 256) {
      for (const [oldKey, old] of this.entries) {
        if (this.entries.size <= 256) break;
        if (old.checkedAt) this.entries.delete(oldKey);
      }
    }
    return entry.promise;
  }
}
