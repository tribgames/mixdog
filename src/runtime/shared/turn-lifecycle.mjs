// turn-lifecycle.mjs
// The turns one session layer runs, each reported once at its real start and
// once at its terminal outcome to whoever observes that session (an agent
// worker's status owner). A turn carries its own id, so an earlier turn's late
// settle is never read as a later turn's. Import-free leaf.

/** One layer's channel. `observer.onTurnStart({ turnId, startedAt,
 *  submissionIds })`, `observer.onTurnAskStarted({ turnId })` once the
 *  turn's ask has claimed the session's runtime (its progress snapshot exists
 *  from here until the ask ends; what runs before it — a compaction the turn
 *  waits on, preparation, the session lock — has no model work yet),
 *  `observer.onTurnAskEnded({ turnId })` once the turn's
 *  model work is over (its ask returned or threw) and only its cleanup
 *  remains, and `observer.onTurnSettled({ turnId, status, result, error,
 *  abortReason, abortCause })`, `status` 'done' | 'failed' | 'cancelled';
 *  `abortCause` is what an abort named as its cause (a watchdog's stall
 *  error). */
export function createTurnLifecycle() {
  const observers = new Map(); // sessionId -> Set<observer>

  function notify(sessionId, hook, event) {
    for (const observer of [...(observers.get(String(sessionId || '')) || [])]) {
      try {
        observer[hook]?.(event);
      } catch {
        /* an observer never affects the turn */
      }
    }
  }

  return {
    /** Observe `sessionId`'s turns; returns the unsubscribe. */
    observe(sessionId, observer) {
      const id = String(sessionId || '');
      if (!id || !observer) return () => {};
      let set = observers.get(id);
      if (!set) {
        set = new Set();
        observers.set(id, set);
      }
      set.add(observer);
      return () => {
        set.delete(observer);
        if (set.size === 0 && observers.get(id) === set) observers.delete(id);
      };
    },
    started: (sessionId, event) => notify(sessionId, 'onTurnStart', event),
    askStarted: (sessionId, event) => notify(sessionId, 'onTurnAskStarted', event),
    askEnded: (sessionId, event) => notify(sessionId, 'onTurnAskEnded', event),
    settled: (sessionId, event) => notify(sessionId, 'onTurnSettled', event),
  };
}

/** A session runtime's conversation turns (tui/session/turn.mjs), however each was submitted. */
export const sessionTurns = createTurnLifecycle();
