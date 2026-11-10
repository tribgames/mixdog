import { settleWithin } from '../../../runtime/shared/abort-race.mjs';

// Worktree snapshot for the turn review. Captured as soon as the turn's
// workspace is final (after any lazy worktree provisioning, so the baseline is
// taken in the root the turn runs in), but never on the first-token critical
// path: every actual tool execution joins the same promise, so
// shell/apply_patch cannot mutate the worktree before the baseline.
export function createSnapshotTrackerFactory({
  getCurrentCwd,
  beginTurnSnapshotForTurn,
  completeTurnSnapshotForTurn,
  turnCleanupSettleMs,
}) {
  return function createSnapshotTracker(options) {
    // `promise` resolves to the turn token beginTurnSnapshot returns
    // (`{ generation, checkpointId }`), or undefined when nothing began.
    const tracker = { sessionId: null, promise: null };
    const continueTurn = options.continueTurn === true;
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
      // Captured now: a later start (or the next turn) cannot redirect this seal.
      const sessionId = tracker.sessionId;
      const started = Promise.resolve(tracker.promise);
      if (signal.aborted && !continueTurn) {
        // A cancelled turn keeps its edits as a change record. Sealing waits
        // for the snapshot start, never for the abort's settlement, and only
        // seals the generation this turn began: delayed cleanup cannot seal
        // a newer turn.
        void started
          .then((token) => (token ? completeTurnSnapshotForTurn(sessionId, token) : undefined))
          .catch(() => {});
        return;
      }
      const cleanup = started.then((token) => completeTurnSnapshotForTurn(sessionId, token));
      cleanup.catch(() => {});
      try {
        await awaitTurn(() => settleWithin(cleanup, turnCleanupSettleMs));
      } catch {
        /* optional review cleanup never overrides turn settlement */
      }
    };
    return tracker;
  };
}
