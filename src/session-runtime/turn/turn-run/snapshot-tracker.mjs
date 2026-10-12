import { settleWithin } from '../../../runtime/shared/abort-race.mjs';

// Worktree snapshot for the turn review. Captured as soon as the turn's
// workspace is final (after any lazy worktree provisioning, so the baseline is
// taken in the root the turn runs in), but never on the first-token critical
// path: every actual tool execution joins the same promise, so
// shell/apply_patch cannot mutate the worktree before the baseline.
export function createSnapshotTrackerFactory({
  getCurrentCwd,
  beginTurnSnapshotForTurn,
  cancelTurnSnapshotForTurn,
  completeTurnSnapshotForTurn,
  turnCleanupSettleMs,
}) {
  return function createSnapshotTracker(options) {
    const tracker = { sessionId: null, promise: null };
    // A completion wake continues the user turn whose review already exists;
    // aborting the wake seals that review instead of discarding it.
    const continueTurn = options.continueTurn === true;
    const cancel = () => {
      try {
        cancelTurnSnapshotForTurn(tracker.sessionId);
      } catch {}
    };
    tracker.start = (sessionId) => {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!id || (tracker.promise && tracker.sessionId === id)) return;
      tracker.sessionId = id;
      tracker.promise = Promise.resolve()
        .then(() =>
          beginTurnSnapshotForTurn(getCurrentCwd(), id, {
            // The first submitted row is the outer prompt. Mid-loop steering
            // is drained inside this ask() and deliberately keeps this ID.
            checkpointId: String(options.id || '').trim(),
            continueTurn,
          })
        )
        .catch(() => undefined);
    };
    tracker.finish = async (signal, awaitTurn) => {
      // A turn refused before its workspace was final never began a review.
      if (!tracker.promise) return;
      if (signal.aborted && !continueTurn) {
        cancel();
        void Promise.resolve(tracker.promise).catch(() => {});
        return;
      }
      const cleanup = Promise.resolve(tracker.promise).then(() => completeTurnSnapshotForTurn(tracker.sessionId));
      cleanup.catch(() => {});
      try {
        await awaitTurn(() => settleWithin(cleanup, turnCleanupSettleMs));
      } catch {
        /* optional review cleanup never overrides turn settlement */
      }
      if (signal.aborted && !continueTurn) cancel();
    };
    return tracker;
  };
}
