import { onBeforeUnmount, ref, watchEffect } from 'vue';
import type { ThreadReadResponse } from '../../shared/protocol/v2/ThreadReadResponse';
import type { ThreadTurnsListResponse } from '../../shared/protocol/v2/ThreadTurnsListResponse';

export function useNativeThreadRead(state: any, api: any) {
  const focused = ref(false);
  function updateFocus() {
    focused.value = document.visibilityState === 'visible' && document.hasFocus();
  }
  updateFocus();
  document.addEventListener('visibilitychange', updateFocus);
  window.addEventListener('focus', updateFocus);
  window.addEventListener('blur', updateFocus);
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', updateFocus);
    window.removeEventListener('focus', updateFocus);
    window.removeEventListener('blur', updateFocus);
  });

  const rpc = (method: string, params: object) => api.rpc(method, params, 8000, { silentError: true });
  const viewed = () => {
    const thread = state.activeThread;
    const turn = state.turns?.at(-1);
    if (!focused.value || !state.authenticated || !state.connected || !state.online || !state.threadReady ||
        state.selectingThread || state.changingContext || state.switchingHost || state.busy || state.runtimePaused ||
        state.threadReleased || state.threadConflict || !thread?.id || thread.ephemeral ||
        !turn?.id || turn.historyBookmarkTarget || !['completed', 'interrupted', 'failed'].includes(turn.status)) return null;
    return { hostId: state.hostId, threadId: thread.id, turnId: turn.id, status: turn.status,
      completedAt: turn.completedAt ?? null, authentication: state.authenticationGeneration };
  };

  watchEffect(onCleanup => {
    const snapshot = viewed();
    if (!snapshot) return;
    const engine = api.runtimeIdentity?.().engineId;
    const snapshotKey = JSON.stringify(snapshot);
    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    const current = () => !cancelled && document.visibilityState === 'visible' && document.hasFocus() &&
      api.runtimeIdentity?.().engineId === engine && JSON.stringify(viewed()) === snapshotKey;
    const { threadId, turnId, status, completedAt } = snapshot;
    void (async () => {
      const response: ThreadReadResponse = await rpc('thread/read', { threadId, includeTurns: false });
      const readState = response.readState;
      if (!current() || response.thread?.id !== threadId || response.thread.ephemeral ||
          response.thread.status?.type === 'active' || !readState?.firstUnread || !readState.revision) return;
      const latest: ThreadTurnsListResponse = await rpc('thread/turns/list', {
        threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary',
      });
      const head = latest.data?.[0];
      if (!current() || head?.id !== turnId || head.status !== status || (head.completedAt ?? null) !== completedAt) return;
      await rpc('thread/readState/update', {
        threadId, operation: { type: 'read' }, expectedRevision: readState.revision,
      });
    })().catch(() => {});
  }, { flush: 'post' });
}
