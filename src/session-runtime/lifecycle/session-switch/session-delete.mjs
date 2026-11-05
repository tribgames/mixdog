/**
 * session-switch/session-delete.mjs — deleting one catalogued session (Lead
 * or agent), and releasing the execution work a closing session owns
 * (shared with the context switch).
 */
import { clean } from '../../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { forgetSessionSearch } from '../../../runtime/session-search/session-search-ingest.mjs';
import { leadSessionRow } from '../session-catalog.mjs';
import { getStoreDir } from '../../../runtime/agent/orchestrator/session/store/session-paths.mjs';
import { STORED_SESSION_UNREADABLE } from '../../../runtime/agent/orchestrator/session/store/serialize.mjs';
import { storedSessionSync } from '../../../runtime/agent/orchestrator/session/store/stored-session.mjs';
import { SESSION_ID_PATTERN } from '../shared.mjs';
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

  // Availability is one strict read of the session's own record, filtered like
  // the session catalog (an unreadable, foreign, closed or non-catalogued
  // record is not deletable). No catalog rebuild, no folder scan.
  function availableRecord(sessionId) {
    const stored = storedSessionSync(getStoreDir(), sessionId);
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
      // Either may wait on another thread's commit: one the user made current
      // meanwhile is neither detached nor deleted (asked in each attempt).
      const isSessionLive = () => getSession()?.id === sessionId;
      const closeOptions = { tombstone: false, isSessionLive };
      if ((await mgr.closeSession(sessionId, cleanupReason, closeOptions)) !== true) return false;
      agentTool?.forgetLeadSession?.(sessionId);
      releaseSessionWork(sessionId, cleanupReason);
      const deleted = (await mgr.deleteSession(sessionId, { fenceWrites: true, isSessionLive })) === true;
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
    if ((await mgr.closeSession(sessionId, cleanupReason, { tombstone: true })) !== true) return false;
    // The unwinding turn's late saves and its idle lead-row upsert must not
    // touch the deleted conversation (an unguarded save would pass the tombstone).
    mgr.fenceSessionWrites?.(sessionId);
    agentTool?.forgetLeadSession?.(sessionId);
    void forgetSessionSearch(sessionId);
    // The close may have waited on another thread's commit: a session the
    // user switched to meanwhile stays current, with its own folder.
    if (getSession()?.id !== sessionId) {
      void releaseDeletedWorktree(sessionId);
      return true;
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

  /**
   * The desktop's auto-delete of an archived session: only one that is still
   * archived, not a favorite, idle (no turn running, waiting for its ask lock
   * or queued) and unchanged since the caller looked (`expected.lastUsedAt`,
   * which every turn moves). It holds the session's ask lock, which every
   * turn takes, across its checks, the close and the delete, so no turn can
   * start in between. Holding it does not keep a turn from queueing behind
   * it, and the close and the delete may each wait for a commit of the
   * session still landing on another thread: every check runs again right
   * before the close's barrier and again right before the unlink, in the same
   * synchronous stretch as each, along with the record's generation (the one
   * read first, then the one the close's detach bumped it to). A refusal
   * deletes nothing — one after the close leaves the session detached and
   * resumable, for the turn that arrived — and resolves
   * `{ deleted: false, reason }`. `isHostedBusy` (the session service)
   * reports queued input in a runtime hosting the session.
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
      // Why the session is not (or no longer) deletable as idle, or null.
      let refusal = null;
      let generation = null;
      const ineligible = () => {
        refusal = idleRefusal(sessionId, expected, generation, isHostedBusy);
        return refusal !== null;
      };
      if (ineligible()) return refuse(refusal);
      generation = Number(availableRecord(sessionId).generation) || 0;
      const reason = 'desktop-auto-delete';
      const closeOptions = { tombstone: false, isSessionLive: ineligible };
      if ((await mgr.closeSession(sessionId, reason, closeOptions)) !== true) {
        return refuse(refusal ?? 'close-failed');
      }
      generation += 1;
      if ((await mgr.deleteSession(sessionId, { fenceWrites: true, isSessionLive: ineligible })) !== true) {
        return refuse(refusal ?? 'delete-failed');
      }
      agentTool?.forgetLeadSession?.(sessionId);
      releaseSessionWork(sessionId, reason);
      void forgetSessionSearch(sessionId);
      void releaseDeletedWorktree(sessionId);
      return { deleted: true };
    } finally {
      unlock();
    }
  }

  // The idle delete's eligibility, read now (synchronously): the session the
  // user has current, a turn waiting for the ask lock, running, unsettled or
  // queued, or a record that is gone,
  // moved since the caller looked, or at another generation than `generation`
  // (when one is expected).
  function idleRefusal(sessionId, expected, generation, isHostedBusy) {
    if (getSession()?.id === sessionId) return 'current';
    if (mgr.sessionLockContended(sessionId)) return 'turn-waiting';
    if (mgr.isSessionTurnInFlight(sessionId) || mgr.hasUnsettledTurn(sessionId)) return 'busy';
    if (mgr.hasPendingMessages(sessionId) || isHostedBusy(sessionId)) return 'queued';
    const stored = availableRecord(sessionId);
    if (!stored) return 'missing';
    if ((Number(stored.lastUsedAt) || 0) !== (Number(expected?.lastUsedAt) || 0)) return 'changed';
    if (generation !== null && (Number(stored.generation) || 0) !== generation) return 'changed';
    return null;
  }

  return { releaseSessionWork, deleteSession, deleteSessionIfIdle };
}
