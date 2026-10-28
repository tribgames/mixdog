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
  async function listWorktrees({ includeSnapshots = false } = {}) {
    const rows = await maintenance.listWorktreesWithRetention(await maintenanceScope());
    return includeSnapshots ? rows : rows.filter((row) => row.kind !== WORKTREE_SNAPSHOT_KIND);
  }

  /** The manual prune: clean, merged worktrees no stored or live session retains. */
  async function pruneWorktrees({ repoCommonDir = null } = {}) {
    return maintenance.pruneWorktrees({ ...(await maintenanceScope()), repoCommonDir });
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
    return maintenance.cleanupDeletedSessionWorktree(sessionId, {
      manager: await backend(),
      autoCleanup: worktreeSettings().autoCleanup,
    });
  }

  return { listWorktrees, pruneWorktrees, removeOrphanWorktree, cleanupDeletedSession };
}
