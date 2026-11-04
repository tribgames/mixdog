/**
 * idle-clock.mjs — when a session has been quiet: neither working nor watched.
 *
 * One clock per session id, any number of deadlines on it (the runtime's idle
 * eviction, the writer lock's idle release). A session's clock starts when it
 * turns quiet and starts over at any event that could change that — activity,
 * queued input, a view coming or going, a save landing, a busy change — and
 * every deadline that tracks the session gets one exact timer from there; work
 * or a view clears them all, and each deadline hears every restart. A deadline that comes due on a session found
 * working (work that announced nothing, a background task) waits its whole
 * delay again; one found watched waits for the view to leave. No sweep.
 */
import { hasPendingMessages, onPendingMessagesChange } from '../../runtime/agent/orchestrator/session/manager/pending-messages.mjs';
import { isSessionTurnInFlight } from '../../runtime/agent/orchestrator/session/manager/runtime-liveness.mjs';
import { subscribeSessionPersistence } from '../../runtime/agent/orchestrator/session/store/session-persistence-events.mjs';
import { hasActiveBackgroundTasks } from '../../runtime/shared/background-tasks.mjs';
import { onSessionActivityChange } from '../../runtime/shared/session-activity-signal.mjs';

/**
 * @param {object} deps
 * @param {(sessionId: string) => object|null} deps.sessionOwner  the live entry hosting it
 * @param {Map<string, object>} deps.externalViewEntries  agent-view projections by session id
 * @param {Map<string, Set<string>>} deps.pendingViewers  cold views by session id
 * @param {(entry: object) => boolean} deps.sessionBusy  late-bound (retention)
 */
export function createSessionIdleClock({ sessionOwner, externalViewEntries, pendingViewers, sessionBusy }) {
  const deadlines = new Set();
  const timers = new Map(); // session id -> (deadline -> its timer)
  let stopped = false;

  /** Any view of any projection of the session. */
  function watched(id) {
    return (
      (sessionOwner(id)?.subscribers?.size || 0) > 0 ||
      (externalViewEntries.get(id)?.subscribers?.size || 0) > 0 ||
      (pendingViewers.get(id)?.size || 0) > 0
    );
  }

  function working(id) {
    const owner = sessionOwner(id);
    return (
      (Boolean(owner) && sessionBusy(owner)) ||
      isSessionTurnInFlight(id) ||
      hasPendingMessages(id) ||
      hasActiveBackgroundTasks({ callerSessionId: id })
    );
  }

  function clear(id) {
    const byDeadline = timers.get(id);
    if (!byDeadline) return;
    for (const timer of byDeadline.values()) clearTimeout(timer);
    timers.delete(id);
  }

  function arm(id, deadline) {
    let byDeadline = timers.get(id);
    if (!byDeadline) {
      byDeadline = new Map();
      timers.set(id, byDeadline);
    }
    clearTimeout(byDeadline.get(deadline));
    const timer = setTimeout(() => fire(id, deadline), deadline.delayMs);
    timer.unref?.();
    byDeadline.set(deadline, timer);
  }

  function fire(id, deadline) {
    const byDeadline = timers.get(id);
    byDeadline?.delete(deadline);
    if (byDeadline?.size === 0) timers.delete(id);
    if (stopped || !deadline.tracks(id) || watched(id)) return;
    if (working(id)) {
      arm(id, deadline);
      return;
    }
    deadline.due(id);
  }

  /** Something about `sessionId` changed: its clock starts over, or stops. */
  function refresh(sessionId) {
    const id = String(sessionId || '');
    if (stopped || !id) return;
    clear(id);
    // Every deadline hears the restart first: what one already did on its
    // last due turn (a queued eviction) is void, and work that just ended
    // re-arms whatever it held back.
    for (const deadline of deadlines) deadline.restarted?.(id);
    if (working(id) || watched(id)) return;
    for (const deadline of deadlines) {
      if (deadline.tracks(id)) arm(id, deadline);
    }
  }

  /** `tracks(id)`: whether the deadline applies to the session now; `due(id)`:
   *  it has been quiet for `delayMs`; `restarted(id)` (optional): its clock
   *  started over, quiet or not. */
  function addDeadline({ delayMs, tracks, due, restarted = null }) {
    const deadline = { delayMs, tracks, due, restarted };
    deadlines.add(deadline);
    return deadline;
  }

  const unsubscribers = [
    onSessionActivityChange(refresh),
    onPendingMessagesChange(refresh),
    subscribeSessionPersistence((id, event) => {
      if (event === 'landed') refresh(id);
    }),
  ];

  function stop() {
    stopped = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const id of [...timers.keys()]) clear(id);
  }

  return {
    refresh,
    addDeadline,
    stop,
    armed: (id, deadline) => timers.get(String(id || ''))?.has(deadline) === true,
  };
}
