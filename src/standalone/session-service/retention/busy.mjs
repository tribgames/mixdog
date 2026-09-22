/**
 * busy.mjs — whether a session entry is still doing work.
 *
 * Busy is what makes a runtime unreclaimable, so it is deliberately
 * conservative: detached background tasks count, and a runtime whose state
 * cannot be read is treated as busy rather than risking the loss of a live
 * turn. The eviction sweep that consumes this lives in ../retention.mjs.
 */
import { hasActiveBackgroundTasks } from '../../../runtime/shared/background-tasks.mjs';

export function createBusyTracker({ sessions, currentSessionId }) {
  function stateBusy(state) {
    return (
      state?.busy === true || state?.commandBusy === true || (Array.isArray(state?.queued) && state.queued.length > 0)
    );
  }

  function updateEntryBusy(entry, state) {
    const next = stateBusy(state);
    entry.busy = next;
    return next;
  }

  function sessionBusy(entry) {
    const sessionId = currentSessionId(entry);
    // Detached views do not make their background commands disposable. Keep
    // the owner runtime (and daemon self-shutdown guard) live until the task
    // reaches a terminal state and its completion can be delivered back into
    // this session.
    if (sessionId && hasActiveBackgroundTasks({ callerSessionId: sessionId })) return true;
    if (typeof entry?.busy === 'boolean') return entry.busy;
    try {
      return updateEntryBusy(entry, entry.runtime.getState?.() || {});
    } catch {
      // A session runtime we cannot read is never assumed idle — losing a live
      // turn is far worse than holding an extra process for one sweep.
      return true;
    }
  }

  function liveBusyCount() {
    let count = 0;
    for (const entry of sessions) {
      if (sessionBusy(entry)) count += 1;
    }
    return count;
  }

  return { stateBusy, updateEntryBusy, sessionBusy, liveBusyCount };
}
