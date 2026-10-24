/**
 * busy.mjs — whether a session entry is still doing work.
 *
 * Busy is what makes a runtime unreclaimable, so it is deliberately
 * conservative: detached background tasks count, and a runtime whose state
 * cannot be read is treated as busy rather than risking the loss of a live
 * turn. The eviction sweep that consumes this lives in ../retention.mjs.
 */
import { activeBackgroundTaskSessionIds, hasActiveBackgroundTasks } from '../../../runtime/shared/background-tasks.mjs';
import { emitSessionApprovalCardChange } from '../../../runtime/shared/session-activity-signal.mjs';

export function createBusyTracker({ sessions, currentSessionId }) {
  function stateBusy(state) {
    return (
      state?.busy === true || state?.commandBusy === true || (Array.isArray(state?.queued) && state.queued.length > 0)
    );
  }

  function updateEntryBusy(entry, state) {
    const next = stateBusy(state);
    entry.busy = next;
    // Every runtime state change passes here, watched or headless: a session
    // that starts or stops showing an approval card (any kind, a sub-agent's
    // delegated copy included) announces it, so the session catalog — the one
    // status source every list row has, open pane or not — re-reads it.
    const awaitingApproval = Boolean(state?.toolApproval);
    if (awaitingApproval !== (entry.awaitingApproval === true)) {
      entry.awaitingApproval = awaitingApproval;
      emitSessionApprovalCardChange(currentSessionId(entry) || '');
    }
    return next;
  }

  /** Session ids whose live runtime shows an approval card waiting on the user. */
  function awaitingApprovalSessionIds() {
    const ids = new Set();
    for (const entry of sessions) {
      const sessionId = currentSessionId(entry);
      if (sessionId && entry.runtime?.getState?.()?.toolApproval) ids.add(sessionId);
    }
    return ids;
  }

  function sessionBusy(entry) {
    const sessionId = currentSessionId(entry);
    // Detached views do not make their background commands disposable. Keep
    // the owner runtime (and daemon self-shutdown guard) live until the task
    // reaches a terminal state and its completion can be delivered back into
    // this session.
    if (sessionId && hasActiveBackgroundTasks({ callerSessionId: sessionId })) return true;
    return sessionTurnBusy(entry);
  }

  // A turn is running (provider stream / tool call / queued input). Background
  // tasks are deliberately not counted: they run outside the heap-churning turn.
  function sessionTurnBusy(entry) {
    if (typeof entry?.busy === 'boolean') return entry.busy;
    try {
      return updateEntryBusy(entry, entry.runtime.getState?.() || {});
    } catch {
      // A session runtime we cannot read is never assumed idle — losing a live
      // turn is far worse than holding an extra process for one sweep.
      return true;
    }
  }

  // sessionBusy for every entry, with the background tasks scanned once: the
  // owner heartbeat, telemetry and status ask this every few seconds, and a
  // scan per session made it sessions × tasks on the event loop.
  function liveBusyCount() {
    const withTasks = activeBackgroundTaskSessionIds();
    let count = 0;
    for (const entry of sessions) {
      const sessionId = currentSessionId(entry);
      if ((sessionId && withTasks.has(sessionId)) || sessionTurnBusy(entry)) count += 1;
    }
    return count;
  }

  function liveTurnBusyCount() {
    let count = 0;
    for (const entry of sessions) {
      if (sessionTurnBusy(entry)) count += 1;
    }
    return count;
  }

  return {
    stateBusy,
    updateEntryBusy,
    awaitingApprovalSessionIds,
    sessionBusy,
    liveBusyCount,
    liveTurnBusyCount,
  };
}
