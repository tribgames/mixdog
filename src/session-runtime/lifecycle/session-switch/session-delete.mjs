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
import { readSessionSidebarState } from '../../../runtime/shared/session-sidebar-host.mjs';

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
  function availableRecord(sessionId) {
    const stored = _storedSessionFromFile(getStoreDir(), `${sessionId}.json`);
    if (!stored || stored === STORED_SESSION_UNREADABLE) return null;
    if (stored.closed === true && !isHistoricalAutomaticClosure(stored)) return null;
    return leadSessionRow(stored) !== null ? stored : null;
  }
  const isAvailableSession = (sessionId) => availableRecord(sessionId) !== null;

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

  /**
   * The desktop's auto-delete of an archived session: only one that is still
   * archived, not a favorite, idle (no turn running, waiting for its ask lock
   * or queued) and unchanged since the caller looked (`expected.lastUsedAt`,
   * which every turn moves). It holds the session's ask lock, which every
   * turn takes, and runs its last checks, the close and the delete in one
   * synchronous stretch, so no turn can start in between. A refusal closes
   * and deletes nothing: `{ deleted: false, reason }`. `isHostedBusy` (the
   * session service) reports queued input in a runtime hosting the session.
   */
  async function deleteSessionIfIdle(id, expected = {}, { isHostedBusy = null } = {}) {
    const sessionId = clean(id);
    const refuse = (reason) => ({ deleted: false, reason });
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return refuse('invalid');
    if (typeof isHostedBusy !== 'function') return refuse('unguarded');
    if (getSession()?.id === sessionId) return refuse('current');
    const unlock = mgr.tryAcquireSessionLock(sessionId);
    if (!unlock) return refuse('busy');
    try {
      // The archive and favorite flags are the desktop's.
      const sidebar = await readSessionSidebarState();
      if (!sidebar || !Object.hasOwn(sidebar.archived ?? {}, sessionId)) return refuse('not-archived');
      if (Object.hasOwn(sidebar.favorites ?? {}, sessionId)) return refuse('favorite');
      // From here to the delete: synchronous.
      if (mgr.sessionLockContended(sessionId)) return refuse('turn-waiting');
      if (mgr.isSessionTurnInFlight(sessionId) || mgr.hasUnsettledTurn(sessionId)) return refuse('busy');
      if (mgr.hasPendingMessages(sessionId) || isHostedBusy(sessionId)) return refuse('queued');
      const stored = availableRecord(sessionId);
      if (!stored) return refuse('missing');
      if ((Number(stored.lastUsedAt) || 0) !== (Number(expected?.lastUsedAt) || 0)) return refuse('changed');
      const reason = 'desktop-auto-delete';
      // The blocking close: its barrier lands before this stretch yields.
      if (closeManagedSession(mgr, sessionId, reason, { tombstone: false }, false) !== true) {
        return refuse('close-failed');
      }
      agentTool?.forgetLeadSession?.(sessionId);
      releaseSessionWork(sessionId, reason);
      if (mgr.deleteSession(sessionId, { fenceWrites: true }) !== true) return refuse('delete-failed');
      void forgetSessionSearch(sessionId);
      void releaseDeletedWorktree(sessionId);
      return { deleted: true };
    } finally {
      unlock();
    }
  }

  return { releaseSessionWork, deleteSession, deleteSessionIfIdle };
}
