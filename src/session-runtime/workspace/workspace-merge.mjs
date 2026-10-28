/**
 * Merging the hosted Lead's retained worktree (or the linked checkout it
 * works in) into the project folder's checked-out branch, with the optional
 * cleanup of the merged worktree.
 */
import { isWorktreeBound, worktreeError, worktreeRefusal } from '../../runtime/shared/worktrees/contract.mjs';
import { samePath } from '../../runtime/shared/worktrees/paths.mjs';
import { mergeConfirmedTarget } from '../../runtime/shared/worktrees/branch-management.mjs';
import { beginWorkspaceTransition } from './admission-gate.mjs';
import { assertRetainedFits } from './transition-steps.mjs';
import { assertRevision, validRevision } from './transition-runner.mjs';

/**
 * @param {object} deps The session view, assertLeadIdle, withManagementFolders,
 *   the runner's removeWorktree, `backend()` and `worktreeSettings()`.
 */
export function createWorkspaceMerge({
  hostedSession,
  currentWorkspace,
  assertLeadIdle,
  inspectProject,
  backend,
  withManagementFolders,
  removeWorktree,
  worktreeSettings,
  newTxId,
}) {
  /**
   * The merge itself. The retained worktree must belong to this session's
   * Project (same repository and Project folder — a Project switch may have
   * left it behind); its branch, or the branch of the linked checkout the
   * session works in, is merged into the project folder through the shared
   * guarded path (mergeConfirmedTarget): both folders validated and held.
   */
  async function mergeRetainedWorktree(session, { target, ownTurn, expectedRevision }) {
    const workspace = currentWorkspace(session);
    assertRevision(workspace.revision, expectedRevision);
    const leave = beginWorkspaceTransition(session.id, `merge:${newTxId()}`);
    try {
      await assertLeadIdle(session, { ownTurn: ownTurn === true });
      const project = await inspectProject(workspace.projectPath);
      let branch;
      if (!workspace.worktreeId && !samePath(workspace.cwd, workspace.projectPath)) {
        const source = await inspectProject(workspace.cwd);
        if (!samePath(source.repoCommonDir, project.repoCommonDir)) throw worktreeError('WORKTREE_PROJECT_MISMATCH');
        branch = source.currentBranch;
      } else {
        const backendApi = await backend();
        const entry = workspace.worktreeId
          ? await backendApi.findWorktreeContaining(workspace.cwd)
          : await backendApi.getSessionWorktree(session.id);
        if (!entry) throw worktreeError('WORKTREE_MISSING', 'This session has no worktree to merge.');
        assertRetainedFits(entry, project, workspace.projectPath);
        if (!samePath(entry.projectPath, workspace.projectPath)) {
          throw worktreeError('WORKTREE_PROJECT_MISMATCH', undefined, {
            worktreeId: entry.id,
            worktreeProject: entry.projectPath,
            projectPath: workspace.projectPath,
          });
        }
        branch = entry.branch;
      }
      return await mergeConfirmedTarget(
        { projectPath: workspace.projectPath, branch, target },
        (folders, removing, run) => withManagementFolders(folders, removing, run, { actor: session.id })
      );
    } finally {
      leave();
    }
  }

  /**
   * Merge the retained worktree into the project folder's checked-out branch.
   * `ownTurn` (internal: the Lead's own tool call) tolerates the calling turn.
   */
  async function mergeWorkspace(
    { confirmed = false, target = null, cleanup = false, expectedRevision } = {},
    { ownTurn = false } = {}
  ) {
    if (confirmed !== true) {
      throw worktreeError('WORKTREE_CONFIRM_REQUIRED', 'mergeWorkspace requires confirmed: true.');
    }
    const expected = validRevision(expectedRevision);
    const session = hostedSession(null);
    const merged = await mergeRetainedWorktree(session, { target, ownTurn, expectedRevision: expected });
    if (cleanup !== true || merged.merged !== true) return merged;
    // "Merge and clean up": with autoCleanup on, the merged worktree goes now
    // (a dirty one stays, reported); off, nothing is removed automatically.
    // The merge is committed: a failed or refused cleanup (dirty, retained
    // file recovery data, ...) is a cleanup notice, never a merge failure.
    if (worktreeSettings().autoCleanup !== true) {
      return {
        ...merged,
        cleanup: { removed: false, reason: 'auto-cleanup-off', message: 'Auto cleanup is off; the worktree is kept.' },
      };
    }
    // The cleanup never moves a session: while this session still works in the
    // merged folder (or any other session uses it) the removal is refused.
    try {
      if (isWorktreeBound(currentWorkspace(session))) {
        throw worktreeRefusal('folder-in-use', { sessions: [session.id] });
      }
      const entry = await (await backend()).getSessionWorktree(session.id);
      const removed = await withManagementFolders(
        entry ? [entry.path] : [],
        true,
        () => removeWorktree({ force: false }, { ownTurn }),
        { actor: session.id }
      );
      return { ...merged, cleanup: removed.removed, revision: removed.revision, workspace: removed.workspace };
    } catch (error) {
      // The merge stands: a refused or incomplete cleanup (in use, dirty,
      // unmerged, retained file recovery data, partly removed, …) is
      // reported, never thrown, with the workspace as it is now.
      const workspace = currentWorkspace(session);
      const code = typeof error?.code === 'string' ? error.code : '';
      return {
        ...merged,
        cleanup: {
          removed: false,
          reason: code || 'WORKTREE_CLEANUP_FAILED',
          ...(code ? { code } : {}),
          message: String(error?.message || error),
        },
        revision: workspace.revision,
        workspace,
      };
    }
  }

  return { mergeWorkspace };
}
