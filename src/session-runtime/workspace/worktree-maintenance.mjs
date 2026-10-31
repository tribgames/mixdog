/**
 * The managed-worktree maintenance the hosted runtime offers: the retention
 * list, the manual prune, an orphan's removal and a deleted session's
 * cleanup. Every live session of this process counts as a live owner.
 */
import { WORKTREE_SNAPSHOT_KIND, worktreeError } from '../../runtime/shared/worktrees/contract.mjs';
import * as maintenance from '../../runtime/shared/worktrees/maintenance.mjs';

/**
 * @param {object} deps The host's session listings, the `backend()` loader,
 *   withManagementFolders, cancelSnapshotCleanups and `worktreeSettings()`.
 */
export function createWorktreeMaintenance({
  getSession,
  listLiveSessions,
  listStoredSessionIds,
  backend,
  withManagementFolders,
  cancelSnapshotCleanups,
  worktreeSettings,
}) {
  /** The maintenance scope here: every live session of this process counts as a live owner. */
  async function maintenanceScope() {
    const liveSessionIds = [
      ...new Set([getSession()?.id, ...listLiveSessions().map((candidate) => candidate?.id)].filter(Boolean)),
    ];
    return { liveSessionIds, listSessionIds: listStoredSessionIds, manager: await backend() };
  }

  /**
   * Every managed worktree with who retains it (the manual list). Read-only
   * snapshots (no branch) only with `includeSnapshots` (the git tool); the
   * desktop list (DesktopManagedWorktreeRow, a branch per row) never gets them.
   */
  async function listWorktrees({ includeSnapshots = false, details = false } = {}) {
    const rows = await maintenance.listWorktreesWithRetention({
      ...(await maintenanceScope()),
      details,
      settings: worktreeSettings(),
    });
    return includeSnapshots ? rows : rows.filter((row) => row.kind !== WORKTREE_SNAPSHOT_KIND);
  }

  /** The manual prune: clean, merged worktrees no stored or live session retains
   *  (plus, with autoCleanup on, what the automatic cleanup would remove). */
  async function pruneWorktrees({ repoCommonDir = null } = {}) {
    return maintenance.pruneWorktrees({
      ...(await maintenanceScope()),
      repoCommonDir,
      settings: worktreeSettings(),
      currentLiveSessionIds: () => listLiveSessions().map((candidate) => candidate?.id),
    });
  }

  /** Whether the manual prune could act on anything (no git verification, nothing removed). */
  async function previewWorktreeCleanup({ repoCommonDir = null } = {}) {
    const { hasCandidates } = await maintenance.previewWorktreeCleanup({
      ...(await maintenanceScope()),
      repoCommonDir,
      settings: worktreeSettings(),
    });
    return { hasCandidates };
  }

  /**
   * Delete managed worktree `entryId` from the worktree list (Settings →
   * Worktrees), whoever owns it: a session the store keeps no longer protects
   * it, but a live owner or a session or background command working in the
   * folder refuses (folder-in-use, folder-shell-jobs, workspace-lease), as do
   * other sessions' shared references and retained recovery data. Dirty or
   * unmerged work needs `force`; a forced unmerged tip stays under
   * refs/mixdog/removed/<id>.
   */
  async function deleteWorktree({ entryId, force = false } = {}) {
    const row = (await listWorktrees()).find((item) => item.id === entryId);
    if (!row) throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
    const removed = await withManagementFolders([row.path], false, async () => {
      const { liveSessionIds, listSessionIds, manager: backendApi } = await maintenanceScope();
      return backendApi.removeOrphanedWorktree({
        entryId,
        force: force === true,
        liveSessionIds,
        retainedSessionIds: await listSessionIds(),
        allowRetained: true,
      });
    });
    return { removed, entryId, path: row.path };
  }

  /**
   * Remove managed worktree `entryId` whose owner is gone (listed `ownerLive:
   * false, removable: true`), on an explicit request: no owner lane exists to
   * do it. No stored or live session may still use the folder; the manager
   * reads the retention again under the repository lock (an owner that came
   * back refuses) and keeps its guards: dirty or unmerged work needs `force`,
   * other sessions' references and retained recovery data refuse, and only
   * the managed checkout is deleted.
   */
  async function removeOrphanWorktree({ entryId, force = false } = {}) {
    const row = (await listWorktrees()).find((item) => item.id === entryId);
    if (!row) throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
    const removed = await withManagementFolders([row.path], true, async () => {
      const { liveSessionIds, listSessionIds, manager: backendApi } = await maintenanceScope();
      return backendApi.removeOrphanedWorktree({
        entryId,
        force: force === true,
        liveSessionIds,
        retainedSessionIds: await listSessionIds(),
      });
    });
    return { removed, entryId, path: row.path };
  }

  /** After `sessionId` was deleted: autoCleanup removes its clean, merged worktree. */
  async function cleanupDeletedSession(sessionId) {
    // Its snapshots go with it below; no turn cleanup keeps retrying them.
    cancelSnapshotCleanups(sessionId);
    const settings = worktreeSettings();
    return maintenance.cleanupDeletedSessionWorktree(sessionId, {
      manager: await backend(),
      autoCleanup: settings.autoCleanup,
      deleteBranch: settings.deleteBranch,
    });
  }

  /**
   * Remove managed worktree `entryId` this session owns but does not work in
   * now, without entering it first: the session does not move, so its own
   * turn and workers elsewhere never block it. The folder's consumers still
   * refuse (another session or a background command in it), as do dirty or
   * unmerged work without `force`, other sessions' references and retained
   * recovery data (the manager's guards).
   */
  async function removeOwnedWorktree({ entryId, force = false } = {}) {
    const session = getSession();
    const row = (await listWorktrees()).find((item) => item.id === entryId);
    if (!row) throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
    if (!session?.id || row.ownerSessionId !== session.id) {
      throw worktreeError('WORKTREE_BUSY_JOBS', 'This worktree belongs to another session.', {
        reason: 'workspace-shared',
        sessions: [row.ownerSessionId].filter(Boolean),
      });
    }
    if (session.workspace?.worktreeId === entryId) {
      throw worktreeError('WORKTREE_BUSY_JOBS', 'The session works in this worktree; return to the project first.', {
        reason: 'folder-in-use',
        sessions: [session.id],
      });
    }
    const removed = await withManagementFolders([row.path], true, async () =>
      (await backend()).removeManagedWorktree({ entryId, force: force === true, sessionId: session.id })
    );
    return { removed, entryId, path: row.path };
  }

  /**
   * Of `sessionIds`, the ones owning a managed worktree whose removal would be
   * refused without `force` (dirty or unmerged work, another session's
   * reference, retained recovery data): the desktop's auto-delete keeps those
   * sessions archived. Read-only; a check that fails counts as holding work.
   */
  async function getSessionWorktreeWork({ sessionIds = [] } = {}) {
    const wanted = new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === 'string' && id));
    const holding = new Set();
    if (!wanted.size) return { sessionIds: [] };
    const manager = await backend();
    for (const row of await listWorktrees()) {
      const owner = row.ownerSessionId;
      if (!wanted.has(owner) || holding.has(owner)) continue;
      try {
        await manager.assertWorktreeRemovable({ entryId: row.id, sessionId: owner });
      } catch {
        holding.add(owner);
      }
    }
    return { sessionIds: [...holding] };
  }

  /** Archived (or restored) sessions: autoCleanup and cleanupArchived decide whether their worktrees become disposable. */
  async function setArchivedSessionWorktrees({ sessionIds = [], archived = false } = {}) {
    const settings = worktreeSettings();
    return maintenance.setArchivedSessionWorktrees(sessionIds, archived === true, {
      manager: await backend(),
      autoCleanup: settings.autoCleanup,
      cleanupArchived: settings.cleanupArchived,
    });
  }

  return {
    listWorktrees,
    pruneWorktrees,
    previewWorktreeCleanup,
    deleteWorktree,
    removeOrphanWorktree,
    removeOwnedWorktree,
    getSessionWorktreeWork,
    setArchivedSessionWorktrees,
    cleanupDeletedSession,
  };
}
