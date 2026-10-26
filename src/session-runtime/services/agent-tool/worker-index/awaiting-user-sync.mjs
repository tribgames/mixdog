// worker-index/awaiting-user-sync.mjs
// A worker row's approval wait (`awaitingUser`), fenced to its session's turn
// and kept in step with the runtime this process runs for that session. Owns
// the sessions whose deferred rows still wait in the mutation batch.
import { clean } from '../helpers.mjs';
import { applyAwaitingUser, awaitingUserWouldChange } from './approval-wait.mjs';

export function createAwaitingUserSync(store, mgr) {
  // Sessions whose deferred rows still wait in the batch; reconciled once the
  // batch lands in the store.
  const unreconciled = new Set();

  /** Persist (or clear) a worker's approval wait as a field update fenced to
   *  the session and its turn (`turnAt`, ms): a row whose turn started later is
   *  left alone. Writes only when a row of that session exists and would
   *  change, so a Lead's own approvals cost nothing; a row that is not in the
   *  store yet takes the wait when it lands (reconcileAwaitingUser). */
  function setAwaitingUser(sessionId, awaitingUser, { turnAt = 0 } = {}) {
    const fence = {
      sessionId: clean(sessionId),
      awaitingUser: awaitingUser === 'approval' ? 'approval' : null,
      turnAt: Number(turnAt) || 0,
    };
    if (!fence.sessionId || !awaitingUserWouldChange(store.readAll(), fence)) return false;
    store.update((byKey) => applyAwaitingUser(byKey, fence));
    return true;
  }

  /** The runtime of a session this process runs is the authority on its
   *  approval wait (the runtime-liveness counter behind `awaitingUser`): every
   *  row it creates or refreshes takes that state, so a missed or stale
   *  transition heals on the next write. No runtime here: not ours to judge. */
  function reconcileAwaitingUser(sessionId) {
    const runtime = mgr.getSessionRuntime?.(sessionId);
    if (runtime) setAwaitingUser(sessionId, runtime.awaitingUser, { turnAt: runtime.askStartedAt });
  }

  /** A deferred row of `sessionId` is queued; reconciled when its batch lands. */
  function deferReconcile(sessionId) {
    unreconciled.add(sessionId);
  }

  /** The batch landed: reconcile every session whose deferred row it carried. */
  function reconcileDeferred() {
    const ids = [...unreconciled];
    unreconciled.clear();
    for (const id of ids) reconcileAwaitingUser(id);
  }

  return { setAwaitingUser, reconcileAwaitingUser, deferReconcile, reconcileDeferred };
}
