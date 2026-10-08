import { upsertItem, type DisplayItem } from './events';

export function writerConflict(error: unknown): boolean {
  const value = error as { message?: string; data?: { takeoverAvailable?: boolean; code?: string } };
  return value?.data?.takeoverAvailable === true || value?.data?.code === 'THREAD_LOCKED'
    || /already has an active writer/i.test(value?.message || '');
}

/** A start acknowledgement can arrive after streamed or completed items. */
export function mergeAcceptedTurnItems(
  items: DisplayItem[], turn: { id: string; items?: DisplayItem[]; status?: string },
  accepted?: { input?: any[]; clientUserMessageId?: string; placement?: 'start' | 'steer' },
  preserveLive = true,
): string[] {
  const touched: string[] = [];
  const snapshot = turn.items || [];
  for (let snapshotIndex = 0; snapshotIndex < snapshot.length; snapshotIndex++) {
    const incoming = snapshot[snapshotIndex];
    const previous = items.find(item => item.id === incoming.id);
    const knownUser = incoming.type === 'userMessage' && items.some(item => item.id === incoming.id || (incoming.clientId && item.clientId === incoming.clientId));
    upsertItem(items, { ...incoming,
      ...(preserveLive && incoming.type !== 'userMessage' ? previous : {}),
      ...(!preserveLive && incoming.type === 'contextCompaction' ? { status: turn.status || 'completed' } : {}),
      turnId: turn.id,
    });
    if (incoming.type === 'userMessage' && !knownUser) {
      // A user item can be acknowledged after its answer has already streamed.
      // Follow the canonical turn order without moving items of other turns.
      const following = snapshot.slice(snapshotIndex + 1)
        .map(item => items.findIndex(current => current.id === item.id)).find(index => index >= 0);
      const preceding = snapshot.slice(0, snapshotIndex).reverse()
        .map(item => items.findIndex(current => current.id === item.id)).find(index => index >= 0);
      const position = following ?? (preceding === undefined
        ? items.findIndex(item => item.turnId === turn.id && item.id !== incoming.id) : preceding + 1);
      const added = items.findIndex(item => item.id === incoming.id);
      if (position >= 0 && position < added) items.splice(position, 0, items.splice(added, 1)[0]);
    }
    touched.push(incoming.id);
  }
  const clientId = accepted?.clientUserMessageId;
  if (clientId && Array.isArray(accepted?.input)) {
    const previous = items.find(item => item.type === 'userMessage' && (item.id === clientId || item.clientId === clientId));
    if (previous) {
      // A reconnected sender can still have an unconfirmed optimistic alias.
      if (['sending', 'unconfirmed'].includes(previous.status)) delete previous.status;
      previous.turnId = turn.id;
      touched.push(previous.id);
    } else {
      upsertItem(items, { id: clientId, clientId, type: 'userMessage',
        content: accepted.input, turnId: turn.id });
      if (accepted.placement === 'start') {
        const first = items.findIndex(item => item.turnId === turn.id && item.id !== clientId);
        const added = items.findIndex(item => item.id === clientId);
        if (first >= 0 && first < added) items.splice(first, 0, items.splice(added, 1)[0]);
      }
      touched.push(clientId);
    }
  }
  // Completion snapshots contain the native item order. A delayed compaction
  // completion must move back before answers emitted after it in the same turn.
  // Replace only this turn's slots, preserving other turns and live-only items.
  if (!preserveLive && snapshot.length > 1) {
    const rank = new Map(snapshot.map((item, index) => [item.id, index]));
    const positions = items.flatMap((item, index) => item.turnId === turn.id ? [index] : []);
    const ordered = positions.map(index => items[index]).sort((left, right) =>
      (rank.get(left.id) ?? snapshot.length) - (rank.get(right.id) ?? snapshot.length));
    positions.forEach((position, index) => { items[position] = ordered[index]; });
  }
  return touched;
}

export function mergeTurnSnapshot(previous: any, incoming: any): any {
  const completed = ['completed', 'failed', 'interrupted'].includes(previous?.status);
  return { ...previous, ...incoming,
    ...(incoming.itemsView === 'full' && !(completed && incoming.status === 'inProgress')
      ? { historySummary: false, historyItemsCursor: null } : {}),
    items: incoming.items?.length ? incoming.items : (previous?.items || []),
    ...(completed && incoming.status === 'inProgress'
      ? { status: previous.status, completedAt: previous.completedAt, error: previous.error,
        items: previous.items?.length ? previous.items : (incoming.items || []) } : {}),
  };
}
