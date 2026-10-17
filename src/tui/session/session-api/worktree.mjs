/**
 * worktree.mjs — the session object's Lead worktree surface. The daemon
 * resolves these advertised actions by name (session-protocol.mjs) and each
 * delegates to the runtime's workspace transition authority
 * (session-runtime/workspace/transitions.mjs), then republishes the route
 * state so the new `workspace` reaches every viewer. Failures are typed
 * WorktreeErrors whose `code` crosses the daemon wire; a runtime without the
 * authority rejects with WORKTREE_NOT_IMPLEMENTED.
 *
 *   getBranchMenu()                                → { workspace, pendingWorktree, branches, occupancy, retainedWorktree }
 *   getProjectBranchMenu({ projectPath })          → { workspace, branches, occupancy, retainedWorktree: null }
 *     (no session: a New Task draft or the source-control dock)
 *   selectBranch({ branch, create?, expectedRevision?, confirmLarge? }) → { revision, workspace }
 *   selectProjectBranch({ projectPath, branch, create?, remote?, startPoint? }) → { branch, changed, commit? }
 *   selectProjectBranch({ projectPath, detach: commitId }) → { branch: null, changed, commit, detached: true }
 *     (no session: the guarded project-folder checkout)
 *   mergeProjectBranch({ projectPath, branch, target }) → backend merge result
 *     (no session: the source-control dock's merge into the confirmed target)
 *   requestWorktree({ name?, confirmLarge?, provision?, prompt?, txId?, expectedRevision? }) → { revision, workspace, pending, warnings? }
 *     (provision: a New Task's first send creates and enters it now)
 *   mergeWorkspace({ confirmed: true, target, cleanup?, expectedRevision? }) → backend merge result (+ cleanup)
 *   removeWorktree({ force?, expectedRevision? })  → { revision, workspace, removed }
 *     (expectedRevision: WORKTREE_REVISION_CONFLICT when the session moved on)
 *     (WORKTREE_REMOVAL_INCOMPLETE: partly removed; call again to finish)
 *   listWorktrees()                                → every managed worktree with its retention
 *   pruneWorktrees()                               → reconcile report (never a retained worktree) */
import { worktreeError } from '../../../runtime/shared/worktrees/contract.mjs';

/** Session actions of the Lead worktree feature (settings live in settings.mjs). */
export const SESSION_WORKTREE_ACTIONS = Object.freeze([
  'getBranchMenu',
  'getProjectBranchMenu',
  'selectBranch',
  'selectProjectBranch',
  'mergeProjectBranch',
  'inspectProjectBranch',
  'manageProjectBranch',
  'requestWorktree',
  'mergeWorkspace',
  'removeWorktree',
  'listWorktrees',
  'pruneWorktrees',
]);

export function createSessionWorktreeApi({ runtime, set, routeState } = {}) {
  return Object.fromEntries(
    SESSION_WORKTREE_ACTIONS.map((action) => [
      action,
      async (input = {}) => {
        if (typeof runtime?.[action] !== 'function') {
          throw worktreeError('WORKTREE_NOT_IMPLEMENTED', `${action} is not implemented yet.`);
        }
        const value = await runtime[action](input ?? {});
        if (!action.startsWith('get') && typeof set === 'function' && typeof routeState === 'function') {
          set({ ...routeState() });
        }
        return value;
      },
    ])
  );
}
