/**
 * Unified merge backend: fold a branch into the branch checked out in a
 * project folder. Shared by the managed worktree merge and the desktop
 * Source Control dock, so both have one semantics:
 *   - explicit confirmation is required;
 *   - the folder must be on `target` (when given), with no operation in
 *     progress and no uncommitted or untracked changes;
 *   - `git merge-tree --write-tree` previews the exact commits first, and a
 *     conflicting merge returns its files WITHOUT touching the folder;
 *   - a clean preview merges with --no-ff --no-edit; if that merge still
 *     fails (hook, interruption) only the merge this call started is aborted
 *     and the failure is thrown, never reported as success.
 * The caller holds the repository lock (lock.mjs) around the whole call.
 *
 * `git(cwd, args)` resolves to { code, stdout, stderr } and never throws on a
 * non-zero exit.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { worktreeError } from './contract.mjs';
import { firstLine, parseStatusPaths } from './git.mjs';

function failure(args, result) {
  const detail = String(result?.stderr || result?.stdout || '').trim() || 'no diagnostic';
  const error = new Error(`git ${args[0]} failed (exit ${result?.code}): ${detail}`);
  error.code = 'GIT_FAILED';
  return error;
}

/** The sequencer operation in progress in `cwd`, or ''. */
export async function operationInProgress(git, cwd) {
  for (const [ref, name] of [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ]) {
    if ((await git(cwd, ['rev-parse', '--verify', '--quiet', ref])).code === 0) return name;
  }
  const paths = await git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'rebase-merge',
    '--git-path',
    'rebase-apply',
  ]);
  if (paths.code === 0) {
    for (const path of String(paths.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      if (existsSync(resolve(cwd, path))) return 'rebase';
    }
  }
  return '';
}

/** Changed and untracked paths in `cwd` (porcelain v1, -z). */
export async function uncommittedPaths(git, cwd) {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=normal'];
  const result = await git(cwd, args);
  if (result.code !== 0) throw failure(args, result);
  return parseStatusPaths(result.stdout);
}

async function revParse(git, cwd, rev) {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', rev]);
  return result.code === 0 ? firstLine(result.stdout) : null;
}

async function checkedOutBranch(git, cwd) {
  const result = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.code === 0 ? firstLine(result.stdout) || null : null;
}

/**
 * @typedef {{ merged: boolean, commit: string|null, target: string, conflicts?: string[], upToDate?: boolean }} MergeResult
 */

/**
 * @param {{
 *   git: (cwd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   cwd: string,
 *   source: string,
 *   target?: string|null,
 *   confirmed: boolean,
 *   message?: string,
 * }} input
 * @returns {Promise<MergeResult>}
 */
export async function mergeBranchIntoCheckout({ git, cwd, source, target = null, confirmed, message }) {
  if (confirmed !== true) throw worktreeError('WORKTREE_CONFIRM_REQUIRED');
  const sourceName = String(source || '').trim();
  if (!sourceName || sourceName.startsWith('-')) {
    throw worktreeError('MERGE_FAILED', 'A merge source branch is required.', { reason: 'source-invalid' });
  }
  const current = await checkedOutBranch(git, cwd);
  if (target !== null && target !== undefined && target !== current) {
    throw worktreeError(
      'WORKTREE_TARGET_MISMATCH',
      `The project folder is on ${current ?? 'a detached HEAD'}, not ${target}; reload and try again.`,
      { expected: target, actual: current }
    );
  }
  if (!current) {
    throw worktreeError('MERGE_FAILED', 'Check out a branch in the project folder before merging.', {
      reason: 'detached-head',
    });
  }
  const operation = await operationInProgress(git, cwd);
  if (operation) {
    throw worktreeError('MERGE_TARGET_DIRTY', `A ${operation} is already in progress in the project folder.`, {
      operation,
      files: [],
    });
  }
  const dirty = await uncommittedPaths(git, cwd);
  if (dirty.length) {
    throw worktreeError('MERGE_TARGET_DIRTY', undefined, {
      operation: '',
      files: dirty.slice(0, 50),
      count: dirty.length,
    });
  }
  const head = await revParse(git, cwd, 'HEAD^{commit}');
  if (!head) throw worktreeError('MERGE_FAILED', 'The merge target has no commits.', { reason: 'target-empty' });
  const sourceCommit = await revParse(git, cwd, `${sourceName}^{commit}`);
  if (!sourceCommit) {
    throw worktreeError('MERGE_FAILED', `No branch or commit named ${sourceName}.`, {
      reason: 'source-missing',
      source: sourceName,
    });
  }

  if ((await git(cwd, ['merge-base', '--is-ancestor', sourceCommit, head])).code === 0) {
    return { merged: true, commit: head, target: current, upToDate: true };
  }
  const previewArgs = ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, sourceCommit];
  const preview = await git(cwd, previewArgs);
  if (preview.code === 1) {
    const conflicts = [...new Set(String(preview.stdout).split('\0').slice(1).filter(Boolean))];
    return { merged: false, commit: null, target: current, conflicts };
  }
  if (preview.code !== 0) throw failure(previewArgs, preview);

  // Nothing Mixdog runs can move the folder while the caller holds the
  // repository lock; an outside process still could, so re-verify.
  if ((await revParse(git, cwd, 'HEAD^{commit}')) !== head || (await checkedOutBranch(git, cwd)) !== current) {
    throw worktreeError('WORKTREE_TARGET_MISMATCH', 'The project folder changed during the merge; try again.', {
      expected: current,
    });
  }
  const mergeArgs = [
    'merge',
    '--no-ff',
    '--no-edit',
    '-m',
    message || `Merge branch '${sourceName}' into ${current}`,
    sourceCommit,
  ];
  const merged = await git(cwd, mergeArgs);
  if (merged.code !== 0) {
    // No operation was in progress before this call, so a MERGE_HEAD now is
    // the merge this call started.
    let aborted = false;
    if (await revParse(git, cwd, 'MERGE_HEAD')) aborted = (await git(cwd, ['merge', '--abort'])).code === 0;
    const outcome = aborted ? ' (the merge was aborted; the project folder is unchanged)' : '';
    const error = worktreeError('MERGE_FAILED', `${failure(mergeArgs, merged).message}${outcome}`, {
      reason: 'merge-failed',
      aborted,
    });
    error.aborted = aborted;
    throw error;
  }
  const commit = await revParse(git, cwd, 'HEAD^{commit}');
  if (!commit || commit === head || (await revParse(git, cwd, 'HEAD^2')) !== sourceCommit) {
    throw worktreeError('MERGE_FAILED', 'git merge reported success but HEAD is not the expected merge commit.', {
      reason: 'unexpected-head',
    });
  }
  return { merged: true, commit, target: current };
}
