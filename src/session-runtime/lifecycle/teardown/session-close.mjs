/**
 * session-close.mjs — what teardown does to the session itself: the
 * SessionEnd hook, closing the owned surface session, the canonical-session
 * tombstone barrier and the turn abort.
 */
import { SessionClosedError } from '../../../runtime/agent/orchestrator/session/manager/session-errors.mjs';
import { isScratchSession } from '../shared.mjs';

// SessionEnd reason mapped to standard values ('clear'/'exit' where
// applicable, else 'other').
function sessionEndReason(reason) {
  const rl = String(reason || '').toLowerCase();
  if (/clear/.test(rl)) return 'clear';
  if (/exit|quit|cli-exit|shutdown|sigint|sigterm/.test(rl)) return 'exit';
  return 'other';
}

// SessionEnd: bridge teardown to the standard hook bus. Short await guard so
// a slow hook cannot wedge teardown; best-effort.
export async function dispatchSessionEnd(deps, reason) {
  const { getSession, hooks, hookCommonPayload, withTeardownDeadline } = deps;
  try {
    const session = getSession();
    if (!session?.id) return;
    await withTeardownDeadline(
      Promise.resolve(
        hooks.dispatch('SessionEnd', hookCommonPayload({ session_id: session.id, reason: sessionEndReason(reason) }))
      ).catch(() => {}),
      300,
      undefined
    );
  } catch {
    /* best-effort: SessionEnd hook must never wedge teardown */
  }
}

// Runtime stop/exit (TUI Ctrl-C, process exit) previously always tombstoned
// the current session, so a session you were mid-conversation in vanished
// from the Resume list the instant you quit and was hard-deleted by the 24h
// tombstone sweep. Only tombstone truly-empty scratch sessions.
export function closeOwnSession(deps, closeSurfaceSession, reason) {
  const {
    getSession,
    setSession,
    statusRoutes,
    invalidateContextStatusCache,
    clearRuntimeNotifications,
    notificationListeners,
  } = deps;
  let ok = false;
  const session = getSession();
  if (session?.id) {
    statusRoutes?.clearGatewaySessionRoute?.(session.id);
    ok = closeSurfaceSession(session, reason, { tombstone: isScratchSession(session) });
    setSession(null);
  }
  invalidateContextStatusCache();
  if (typeof clearRuntimeNotifications === 'function') clearRuntimeNotifications();
  else notificationListeners?.clear?.();
  return ok;
}

/** Plant the ordinary manager/store tombstone barrier for a canonical
 *  child session without running whole-process teardown. */
export function closeCanonicalSession(deps, reason = 'canonical-session-close') {
  const { getSession, setSession, mgr, invalidateContextStatusCache } = deps;
  const session = getSession?.();
  if (!session?.id || session.remoteAttached === true) return false;
  const closed = mgr.closeSession(session.id, reason, { tombstone: true }) === true;
  if (!closed) return false;
  setSession?.(null);
  invalidateContextStatusCache?.();
  return true;
}

export function abortRuntime(deps, reason = 'cli-abort') {
  const { getSession, getReservedSessionId, abortActiveTurns, mgr } = deps;
  const session = getSession();
  const sessionId = session?.id || getReservedSessionId?.() || 'pending';
  const abortError = new SessionClosedError(sessionId, `runtime abort (reason=${reason})`, reason);
  let outerAborted = false;
  try {
    outerAborted = abortActiveTurns?.(abortError) === true;
  } catch {}
  const managerAborted = session?.id ? mgr.abortSessionTurn(session.id, reason) : false;
  return outerAborted || managerAborted;
}
