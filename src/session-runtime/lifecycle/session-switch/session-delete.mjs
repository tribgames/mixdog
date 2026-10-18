/**
 * session-switch/session-delete.mjs — deleting one catalogued session (Lead
 * or agent), and releasing the execution work a closing session owns
 * (shared with the context switch).
 */
import { clean } from '../../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { forgetSessionSearch } from '../../../runtime/session-search/session-search-ingest.mjs';
import { leadSessionRow } from '../session-catalog.mjs';
import { getStoreDir } from '../../../runtime/agent/orchestrator/session/store/session-paths.mjs';
import {
  STORED_SESSION_UNREADABLE,
  _storedSessionFromFile,
} from '../../../runtime/agent/orchestrator/session/store/serialize.mjs';
import { SESSION_ID_PATTERN, closeManagedSession } from '../shared.mjs';
import { replacementSessionCwd } from '../../workspace/workspace-state.mjs';
import { isHistoricalAutomaticClosure } from '../../../runtime/agent/orchestrator/session/historical-session-closure.mjs';

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

  // Release this execution session, not independent sessions it delegated to.
  function releaseSessionWork(sessionId, reason) {
    try {
      cancelBackgroundTasks({ reason, notify: false, executionSessionId: sessionId });
    } catch {}
    statusRoutes?.clearGatewaySessionRoute?.(sessionId);
  }

  // Availability is one strict read of the session's own file, filtered like
  // the session catalog (an unreadable, foreign, closed or non-catalogued
  // record is not deletable). No catalog rebuild, no folder scan.
  function isAvailableSession(sessionId) {
    const stored = _storedSessionFromFile(getStoreDir(), `${sessionId}.json`);
    if (!stored || stored === STORED_SESSION_UNREADABLE) return false;
    if (stored.closed === true && !isHistoricalAutomaticClosure(stored)) return false;
    return leadSessionRow(stored) !== null;
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
    if (!isAvailableSession(sessionId)) return false;
    const current = getSession();
    const cleanupReason = 'desktop-session-delete';
    if (current?.id !== sessionId) {
      // A turn can still be running in a session that is no longer current.
      // Stop its runtime first (controller abort, shells, generation bump) and
      // release its worker row and its own background tasks, so nothing can
      // write it back. Sessions it delegated to are independent and keep running.
      if ((await closeManagedSession(mgr, sessionId, cleanupReason, { tombstone: false })) !== true) return false;
      agentTool?.forgetLeadSession?.(sessionId);
      releaseSessionWork(sessionId, cleanupReason);
      const deleted = mgr.deleteSession(sessionId, { fenceWrites: true }) === true;
      if (!deleted) return false;
      void forgetSessionSearch(sessionId);
      void releaseDeletedWorktree(sessionId);
      return true;
    }
    // Leaving a worktree-bound current session: the replacement starts in the
    // Project folder, and the worktree can go once nothing runs in it.
    const projectFolder = replacementSessionCwd(current);
    releaseSessionWork(sessionId, cleanupReason);
    // Active sessions retain a tombstone until the normal sweep. Unlinking
    // immediately would let a late provider/save continuation resurrect the
    // deleted conversation after the user has moved to its replacement.
    if ((await closeManagedSession(mgr, sessionId, cleanupReason, { tombstone: true })) !== true) return false;
    // The unwinding turn's late saves and its idle lead-row upsert must not
    // touch the deleted conversation (an unguarded save would pass the tombstone).
    mgr.fenceSessionWrites?.(sessionId);
    agentTool?.forgetLeadSession?.(sessionId);
    void forgetSessionSearch(sessionId);
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
