import { existsSync } from 'node:fs';
import { branchCommit, inspectRepo, listWorktrees, runGit, validBranchName } from './git.mjs';
import { worktreeError, worktreeRefusal } from './contract.mjs';
import { samePath } from './paths.mjs';
import { getRecord, putRecord, readRegistry } from './registry.mjs';
import { readOwnerLease } from './owner.mjs';
import { isPidAliveOrUnknown } from '../pid-liveness.mjs';
import { operationInProgress, uncommittedPaths } from './merge.mjs';
import { gitStatusRunner } from './git.mjs';
import {
  withRepoLock,
  getWorktreeByPath,
  mergeBranchIntoProject,
  assertWorktreeRemovable,
  removeManagedWorktree,
  managedWorktreeDirtyPaths,
} from './manager.mjs';

/**
 * WORKTREE_UNSUPPORTED_REPO when the project folder has no checked-out branch
 * to merge into; WORKTREE_TARGET_MISMATCH when the confirmed `target` (null:
 * none confirmed) is no longer the checked-out branch.
 */
function assertMergeTarget(currentBranch, target) {
  if (!currentBranch) {
    throw worktreeError('WORKTREE_UNSUPPORTED_REPO', 'The project folder has no checked-out branch to merge into.');
  }
  if (target !== null && target !== currentBranch) {
    throw worktreeError(
      'WORKTREE_TARGET_MISMATCH',
      `The project folder is now on "${currentBranch}"; confirm the merge again.`,
      { target, current: currentBranch }
    );
  }
}

async function inspect(projectPath, branch) {
  const repo = await inspectRepo(projectPath);
  if (!(await validBranchName(repo.projectPath, branch))) throw new TypeError('Invalid local branch name.');
  const commit = await branchCommit(repo.projectPath, branch);
  if (!commit) throw worktreeError('WORKTREE_MISSING', 'The local branch no longer exists.');
  const holder = (await listWorktrees(repo.projectPath)).find((row) => row.branch === branch && !row.prunable);
  const entry = holder ? await getWorktreeByPath(holder.path) : null;
  return {
    repo,
    branch,
    commit,
    target: repo.currentBranch,
    targetCommit: repo.currentBranch ? await branchCommit(repo.projectPath, repo.currentBranch) : null,
    path: holder?.path ?? null,
    worktreeId: entry?.id ?? null,
    kind: holder ? (samePath(holder.path, repo.topLevel) ? 'project' : entry ? 'managed' : 'external') : 'free',
  };
}

export async function inspectProjectBranch({ projectPath, branch }) {
  const repo = await inspectRepo(projectPath);
  return withRepoLock(repo.repoCommonDir, async () => {
    const { repo: _repo, ...state } = await inspect(projectPath, branch);
    return state;
  });
}

/**
 * A merge confirmed by its target branch only (the dock, a session merging
 * its own checkout): the identities inspected now are the confirmed ones, and
 * the merge then takes the one guarded path (manageProjectBranch). `target`
 * null accepts the folder's checked-out branch.
 */
export async function mergeConfirmedTarget({ projectPath, branch, target = null }, withFolders) {
  const state = await inspectProjectBranch({ projectPath, branch });
  assertMergeTarget(state.target, target);
  return manageProjectBranch(
    {
      projectPath,
      branch,
      action: 'merge',
      commit: state.commit,
      target: state.target,
      targetCommit: state.targetCommit,
      confirmed: true,
    },
    withFolders
  );
}

/**
 * The one guarded path of every merge, folder cleanup and branch deletion.
 * The caller supplies process/session admission (`withFolders(folders,
 * removing, run)`: a merge holds both the project folder and the source
 * checkout) while this module owns Git/ref validation: a merge refuses a dirty
 * source or one with a Git operation in progress, and the destination's own
 * preflight refuses a dirty target.
 */
export async function manageProjectBranch(input, withFolders) {
  const { projectPath, branch, action, commit, target, targetCommit } = input;
  if (input.confirmed !== true) throw worktreeError('WORKTREE_CONFIRM_REQUIRED');
  if (!['merge', 'remove-worktree', 'delete-branch'].includes(action)) throw new TypeError('Unknown branch action.');
  const initial = await inspect(projectPath, branch);
  const folders =
    action === 'merge'
      ? [initial.repo.topLevel, initial.path].filter(Boolean)
      : action === 'remove-worktree' && initial.path
        ? [initial.path]
        : [];
  return withFolders([...new Set(folders)], action === 'remove-worktree', async (retainedSessionIds) =>
    withRepoLock(initial.repo.repoCommonDir, async () => {
      const state = await inspect(projectPath, branch);
      if (
        state.commit !== commit ||
        state.path !== initial.path ||
        (action !== 'remove-worktree' && (state.target !== target || state.targetCommit !== targetCommit))
      ) {
        throw worktreeError('WORKTREE_REVISION_CONFLICT', 'The branch changed; reopen the menu and confirm again.');
      }
      const record = state.worktreeId ? await getRecord(state.worktreeId) : null;
      if (record) {
        const leases = [
          await readOwnerLease(record, { strict: true }),
          ...Object.values(record.sharedLeases ?? {}),
        ].filter(Boolean);
        if (
          leases.some(
            (lease) => isPidAliveOrUnknown(lease.pid) && (action === 'remove-worktree' || lease.pid !== process.pid)
          )
        ) {
          throw worktreeRefusal('workspace-lease');
        }
      }
      if (action === 'remove-worktree') {
        if (
          state.kind !== 'managed' ||
          !record ||
          !(record.state === 'ready' || (record.state === 'deleting' && record.deleting?.safeOnly)) ||
          !existsSync(record.path)
        ) {
          throw worktreeError('WORKTREE_PATH_UNSAFE', 'Only an unused Mixdog-managed worktree can be removed.');
        }
        const retained = new Set(retainedSessionIds);
        const users = [record.ownerSessionId, ...(record.sharedSessionIds ?? [])].filter((id) => retained.has(id));
        if (users.length) throw worktreeRefusal('workspace-retained', { sessions: users });
        await assertWorktreeRemovable({ entryId: record.id });
        return removeManagedWorktree({ entryId: record.id, preserveBranch: true, safeOnly: true });
      }
      if (!target || branch === target)
        throw worktreeError('WORKTREE_TARGET_MISMATCH', 'Select a different source branch.');
      if (action === 'delete-branch') {
        if (state.path)
          throw worktreeError('WORKTREE_BRANCH_OCCUPIED', 'Remove or leave the checkout before deleting its branch.');
        const held = Object.values((await readRegistry()).entries).some(
          (row) => row.branch === branch && samePath(row.repoCommonDir, state.repo.repoCommonDir)
        );
        if (held) throw worktreeError('WORKTREE_BUSY_JOBS', 'A managed worktree still retains this branch.');
        const merged = await runGit(projectPath, ['merge-base', '--is-ancestor', commit, targetCommit], {
          allowFailure: true,
        });
        if (merged.code !== 0) throw worktreeError('WORKTREE_UNMERGED', `The branch is not merged into ${target}.`);
        await runGit(projectPath, ['branch', '-d', '--', branch]);
        return { deleted: true, branch };
      }
      if (state.path) {
        const operation = await operationInProgress(gitStatusRunner, state.path);
        const dirty = record
          ? await managedWorktreeDirtyPaths(record.id)
          : await uncommittedPaths(gitStatusRunner, state.path);
        if (operation || dirty.length)
          throw worktreeError('WORKTREE_DIRTY', 'Commit or finish the source work before merging.', {
            operation,
            count: dirty.length,
          });
      }
      const merged = await mergeBranchIntoProject({ projectPath, source: branch, target, confirmed: true });
      // A managed worktree remembers where it was merged (its later removal checks against it).
      const current = merged.merged && record ? await getRecord(record.id) : null;
      if (current && current.mergeTarget !== target) await putRecord({ ...current, mergeTarget: target });
      return merged;
    })
  );
}
