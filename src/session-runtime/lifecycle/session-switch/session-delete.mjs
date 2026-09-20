/**
 * session-switch/session-delete.mjs — deleting a catalogued session together
 * with its linked agent children, and releasing the work a closing session
 * owns (shared with the context switch).
 */
import { clean } from '../../session-text.mjs';
import { listLeadSessions } from '../session-catalog.mjs';
import { SESSION_ID_PATTERN } from '../shared.mjs';

export function createSessionDelete(deps, { cancelBackgroundTasks }) {
  const {
    getSession,
    setSession,
    mgr,
    statusRoutes,
    agentTool,
    createCurrentSession,
    invalidateContextStatusCache,
    invalidatePreSessionToolSurface,
  } = deps;

  // Cancel the work a closing session owns: background tasks, agent workers,
  // and its gateway status route.
  function releaseSessionWork(sessionId, reason) {
    try {
      cancelBackgroundTasks({ reason, notify: false, callerSessionId: sessionId });
    } catch {}
    try {
      agentTool?.closeAll?.(reason, { callerSessionId: sessionId });
    } catch {}
    statusRoutes?.clearGatewaySessionRoute?.(sessionId);
  }

  function ownedAgentSessionIds(sessionId) {
    try {
      const candidates = mgr.listOwnedAgentSessionIds?.(sessionId);
      if (!Array.isArray(candidates)) return [];
      return [
        ...new Set(
          candidates
            .map(clean)
            .filter((childId) => childId && childId !== sessionId && SESSION_ID_PATTERN.test(childId))
        ),
      ];
    } catch {
      /* parent deletion remains available if child enumeration fails */
      return [];
    }
  }

  async function deleteSession(id) {
    const sessionId = clean(id);
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return false;
    const available = listLeadSessions(mgr, { refreshFromStorage: true }).some((row) => row.id === sessionId);
    if (!available) return false;
    const childIds = ownedAgentSessionIds(sessionId);
    const current = getSession();
    if (current?.id !== sessionId) {
      const deleted = mgr.deleteSession(sessionId) === true;
      if (!deleted) return false;
      // The parent is already irreversibly gone, so child cleanup is
      // best-effort and idempotent. Any vetoed child becomes sweep-eligible
      // because its retained-parent proof disappeared with the parent.
      for (const childId of childIds) {
        try {
          mgr.deleteSession(childId);
        } catch {}
      }
      return true;
    }
    const cleanupReason = 'desktop-session-delete';
    releaseSessionWork(sessionId, cleanupReason);
    // Active sessions retain a tombstone until the normal sweep. Unlinking
    // immediately would let a late provider/save continuation resurrect the
    // deleted conversation after the user has moved to its replacement.
    if (mgr.closeSession(sessionId, cleanupReason, { tombstone: true }) !== true) return false;
    // Active parent deletion uses the same durable tombstone boundary for
    // every linked child. Their files then mature with the parent instead of
    // disappearing while the parent task is still retained.
    for (const childId of childIds) {
      try {
        mgr.closeSession(childId, cleanupReason, { tombstone: true });
      } catch {}
    }
    setSession(null);
    invalidateContextStatusCache();
    invalidatePreSessionToolSurface();
    await createCurrentSession();
    return true;
  }

  return { releaseSessionWork, deleteSession };
}
