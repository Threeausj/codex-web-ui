import { interruptConflictCandidate } from './turn-interrupt';

type TurnIdentity = { id: string; status?: string };
type RuntimeSnapshot = { turnId?: string; busy: boolean; revision: number };

/** A steer can follow a missed continuation only after the first request was
 * explicitly rejected. A dropped reply might already have changed the model's
 * input, so it never authorizes another send. */
export async function steerWithConfirmedTurn<T>(requestedId: string, send: (turnId: string) => Promise<T>, recovery: {
  current: () => boolean;
  runtime: () => RuntimeSnapshot;
  readLatest: () => Promise<TurnIdentity | undefined>;
  terminal: (turnId: string) => boolean;
  discarded: (turnId: string) => boolean;
  acceptActiveTurn: (turnId: string) => void;
}): Promise<T> {
  try { return await send(requestedId); }
  catch (cause) {
    const candidate = interruptConflictCandidate(cause, requestedId);
    if (!candidate || !recovery.current()) throw cause;
    const changed = () => new Error('任务轮次已变化，消息尚未发送，请同步对话后重新确认。');
    const otherLiveTurn = (snapshot: RuntimeSnapshot) => !!snapshot.turnId && snapshot.turnId !== requestedId && snapshot.turnId !== candidate;
    const before = recovery.runtime();
    if (otherLiveTurn(before)) throw changed();
    const latest = await recovery.readLatest();
    if (!recovery.current()) throw changed();
    const after = recovery.runtime();
    if (!latest || latest.id !== candidate || latest.status !== 'inProgress' ||
        otherLiveTurn(after) || recovery.terminal(candidate) || recovery.discarded(candidate)) throw changed();
    // A read is not authoritative over events received while it was in flight.
    // Only the same active native turn is safe when that revision advanced.
    if (after.revision !== before.revision && (after.turnId !== candidate || !after.busy)) throw changed();
    if (after.revision === before.revision) recovery.acceptActiveTurn(candidate);
    try { return await send(candidate); }
    catch (error) {
      // No loop: another continuation requires another explicit user action.
      throw interruptConflictCandidate(error, candidate) ? changed() : error;
    }
  }
}
