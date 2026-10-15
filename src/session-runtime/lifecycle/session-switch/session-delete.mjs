/**
 * session-switch/session-delete.mjs — deleting a catalogued session together
 * with its linked agent children, and releasing the work a closing session
 * owns (shared with the context switch).
 */
import { clean } from '../../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { forgetSessionSearch } from '../../../runtime/session-search/session-search-ingest.mjs';
import { leadSessionRow } from '../session-catalog.mjs';
import { getStoreDir } from '../../../runtime/agent/orchestrator/session/store/paths-heartbeat.mjs';
import {
  STORED_SESSION_UNREADABLE,
  _storedSessionFromFile,
} from '../../../runtime/agent/orchestrator/session/store/serialize.mjs';
import { SESSION_ID_PATTERN } from '../shared.mjs';
import { replacementSessionCwd } from '../../workspace/workspace-state.mjs';

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

  // Availability is one strict read of the session's own file, filtered like
  // the Lead catalog (an unreadable, foreign, closed or non-Lead record is not
  // deletable). No catalog rebuild, no folder scan.
  function isAvailableLead(sessionId) {
    const stored = _storedSessionFromFile(getStoreDir(), `${sessionId}.json`);
    if (!stored || stored === STORED_SESSION_UNREADABLE || stored.closed === true) return false;
    return leadSessionRow(stored, new Map()) !== null;
  }

  // The deleted task's worktree: the autoCleanup setting decides (clean and
  // merged → removed; otherwise kept). Off the deletion path; never fails it.
  function releaseDeletedWorktree(sessionId) {
    return Promise.resolve()
      .then(() => deps.cleanupDeletedSessionWorktree?.(sessionId))
      .catch(() => {});
  }

  async function deleteSession(id) {
    const sessionId = clean(id);
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return false;
    if (!isAvailableLead(sessionId)) return false;
    const childIds = ownedAgentSessionIds(sessionId);
    const current = getSession();
    const cleanupReason = 'desktop-session-delete';
    if (current?.id !== sessionId) {
      // A turn can still be running in a session that is no longer current.
      // Stop its runtime first (controller abort, shells, generation bump) and
      // release its lead row, agents and tasks, so nothing can write it back.
      if (mgr.closeSession(sessionId, cleanupReason, { tombstone: false }) !== true) return false;
      agentTool?.forgetLeadSession?.(sessionId);
      releaseSessionWork(sessionId, cleanupReason);
      const deleted = mgr.deleteSession(sessionId, { fenceWrites: true }) === true;
      if (!deleted) return false;
      void forgetSessionSearch(sessionId);
      // The parent is already irreversibly gone, so child cleanup is
      // best-effort and idempotent. Any vetoed child becomes sweep-eligible
      // because its retained-parent proof disappeared with the parent.
      for (const childId of childIds) {
        try {
          mgr.deleteSession(childId, { fenceWrites: true });
        } catch {}
      }
      void releaseDeletedWorktree(sessionId);
      return true;
    }
    // Leaving a worktree-bound Lead: the replacement starts in the Project
    // folder, and the worktree can go once nothing runs in it.
    const projectFolder = replacementSessionCwd(current);
    releaseSessionWork(sessionId, cleanupReason);
    // Active sessions retain a tombstone until the normal sweep. Unlinking
    // immediately would let a late provider/save continuation resurrect the
    // deleted conversation after the user has moved to its replacement.
    if (mgr.closeSession(sessionId, cleanupReason, { tombstone: true }) !== true) return false;
    // The unwinding turn's late saves and its idle lead-row upsert must not
    // touch the deleted conversation (an unguarded save would pass the tombstone).
    mgr.fenceSessionWrites?.(sessionId);
    agentTool?.forgetLeadSession?.(sessionId);
    void forgetSessionSearch(sessionId);
    // Active parent deletion uses the same durable tombstone boundary for
    // every linked child. Their files then mature with the parent instead of
    // disappearing while the parent task is still retained.
    for (const childId of childIds) {
      try {
        mgr.closeSession(childId, cleanupReason, { tombstone: true });
      } catch {}
    }
    setSession(null);
    if (projectFolder) await deps.applyResolvedCwd?.(projectFolder);
    invalidateContextStatusCache();
    invalidatePreSessionToolSurface();
    // An addressed runtime never mints a replacement under the deleted
    // address: it becomes terminal and a new conversation needs a new entry.
    if (deps.getAddressedSessionId?.()) {
      deps.markAddressTerminal?.();
      void releaseDeletedWorktree(sessionId);
      return true;
    }
    await createCurrentSession();
    void releaseDeletedWorktree(sessionId);
    return true;
  }

  return { releaseSessionWork, deleteSession };
}
