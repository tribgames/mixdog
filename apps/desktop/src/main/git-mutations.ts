import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createGitBranchOperations } from './git-branches';
export type { GitBranchEntry } from './git-branches';
import { createGitCommitPaths } from './git-commit-transaction';
import {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  type GitIgnoreScope,
  type GitResetMode,
} from './git-contract.mjs';
import {
  run,
  runWithInput,
  scrubGitCredentials,
} from './git-runner';
import { currentGitOperation, gitStatus, hasHead } from './git-status';

export {
  applyPublishMode,
  assertCommitHooksRunnable,
  assertIndexLockFree,
  cacheHookRunnerSupport,
  chmodErrorIsIgnorable,
  commitRefreshProbe,
  executableHook,
  hookRunnerSupport,
  indexPublishMode,
  missingHookRunner,
  modeGrantsMoreThan,
  sharedRepositoryMode,
  sharedRepositoryPerm,
  writeIndexBytes,
} from './git-commit-transaction';
export type {
  HookRunnerCache,
  IndexLockFile,
  IndexPublishMode,
  ModedLockFile,
} from './git-commit-transaction';
export {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  requiredRepositoryCwd,
} from './git-contract.mjs';
export type { GitIgnoreScope, GitResetMode } from './git-contract.mjs';
export { publicGitRemoteUrl, scrubGitCredentials } from './git-runner';

const branchOperations = createGitBranchOperations({ run, currentGitOperation, gitStatus });
const { checkedBranchName } = branchOperations;

export const {
  gitBranches,
  gitCheckoutBranch,
  gitCreateBranch,
  gitRenameBranch,
  gitDeleteBranch,
  gitMergeBranch,
} = branchOperations;

export async function gitApplyPatch(
  cwd: string,
  path: string,
  patch: string,
  reverse = false,
): Promise<void> {
  if (!patch.trim()) throw new TypeError('A Git patch is required.');
  await runWithInput(cwd, [
    'apply',
    '--cached',
    '--recount',
    '--whitespace=nowarn',
    ...(reverse ? ['--reverse'] : []),
    `--include=${path}`,
    '-',
  ], patch);
}

export async function gitStage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length) await run(cwd, ['add', '-A', '--', ...paths]);
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  if (await hasHead(cwd)) {
    try {
      await run(cwd, ['restore', '--staged', '--', ...paths]);
    } catch {
      await run(cwd, ['reset', 'HEAD', '--', ...paths]);
    }
    return;
  }
  await run(cwd, ['rm', '--cached', '-r', '--ignore-unmatch', '--', ...paths]);
}

function escapedIgnoreLiteral(value: string): string {
  return value.replace(/([*?[\]\\])/g, '\\$1');
}

function ignoredExtension(normalized: string): string {
  const name = normalized.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    throw new TypeError('Git ignore path has no file extension.');
  }
  return name.slice(dot);
}

export async function gitIgnore(
  cwd: string,
  path: string,
  scope: GitIgnoreScope = 'file',
): Promise<void> {
  const ignoreScope = requiredGitIgnoreScope(scope);
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..')) {
    throw new TypeError('Git ignore path is invalid.');
  }
  const pattern = ignoreScope === 'extension'
    ? `*${escapedIgnoreLiteral(ignoredExtension(normalized))}`
    : `/${escapedIgnoreLiteral(normalized)}`;
  const repositoryRoot = (await run(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const ignorePath = join(repositoryRoot || cwd, '.gitignore');
  let current = '';
  try {
    current = await readFile(ignorePath, 'utf8');
  } catch {
    // A missing .gitignore is the normal first-use path.
  }
  if (current.split(/\r?\n/).includes(pattern)) return;
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  await writeFile(ignorePath, `${current}${separator}${pattern}\n`, 'utf8');
}

export async function gitCommit(cwd: string, message: string): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) throw new TypeError('A commit message is required.');
  return run(cwd, ['commit', '-m', trimmed]);
}

export const gitCommitPaths = createGitCommitPaths(gitStatus);

export function gitAmend(cwd: string, message = ''): Promise<string> {
  const trimmed = message.trim();
  return run(cwd, trimmed
    ? ['commit', '--amend', '-m', trimmed]
    : ['commit', '--amend', '--no-edit']);
}

export function gitUndoLastCommit(cwd: string): Promise<string> {
  return run(cwd, ['reset', '--soft', 'HEAD~1']);
}

export function gitStash(cwd: string, message = ''): Promise<string> {
  const trimmed = message.trim();
  return run(cwd, ['stash', 'push', '-u', ...(trimmed ? ['-m', trimmed] : [])]);
}

export function gitStashPop(cwd: string): Promise<string> {
  return run(cwd, ['stash', 'pop']);
}

export interface GitStashEntry {
  ref: string;
  message: string;
  when: string;
}

export async function gitStashList(cwd: string): Promise<GitStashEntry[]> {
  const out = await run(cwd, ['stash', 'list', '--format=%gd%x00%s%x00%cr']);
  return String(out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ref = '', message = '', when = ''] = line.split('\u0000');
      return { ref, message, when };
    })
    .filter((entry) => entry.ref.startsWith('stash@{'));
}

const STASH_REF = /^stash@\{\d+\}$/;

function requiredStashRef(ref: string): string {
  const value = String(ref || '').trim();
  if (!STASH_REF.test(value)) throw new TypeError('Stash reference is invalid.');
  return value;
}

export function gitStashApply(cwd: string, ref: string): Promise<string> {
  return run(cwd, ['stash', 'apply', requiredStashRef(ref)]);
}

export function gitStashDrop(cwd: string, ref: string): Promise<string> {
  return run(cwd, ['stash', 'drop', requiredStashRef(ref)]);
}

export async function gitRevertFile(
  cwd: string,
  path: string,
  untracked: boolean,
  mode: 'worktree' | 'all' = 'all',
): Promise<void> {
  if (untracked) {
    await run(cwd, ['clean', '-f', '-d', '--', path]);
    return;
  }
  if (mode === 'worktree') {
    try {
      await run(cwd, ['restore', '--worktree', '--', path]);
    } catch {
      await run(cwd, ['checkout', '--', path]);
    }
    return;
  }
  if (await hasHead(cwd)) {
    await run(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path]);
    return;
  }
  await run(cwd, ['rm', '--cached', '-r', '--ignore-unmatch', '--', path]);
  await run(cwd, ['clean', '-f', '-d', '--', path]);
}

export async function gitPush(cwd: string): Promise<string> {
  let hasUpstream = true;
  try {
    await run(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    hasUpstream = false;
  }
  return run(cwd, hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']);
}

function readableRemoteError(reason: unknown): Error {
  const message = scrubGitCredentials(reason instanceof Error ? reason.message : String(reason));
  if (/authentication failed|could not read username|terminal prompts disabled|permission denied|publickey/i.test(message)) {
    return new Error('Git authentication is required. Sign in with your Git credential helper and retry.');
  }
  return new Error(message);
}

async function remoteAction(cwd: string, args: string[]): Promise<string> {
  try {
    return await run(cwd, args);
  } catch (reason) {
    throw readableRemoteError(reason);
  }
}

export function gitFetch(cwd: string): Promise<string> {
  return remoteAction(cwd, ['fetch', '--prune']);
}

export function gitPull(cwd: string): Promise<string> {
  return remoteAction(cwd, ['pull', '--no-rebase', '--no-edit']);
}

export async function gitSync(cwd: string): Promise<string> {
  const pulled = await gitPull(cwd);
  const pushed = await gitPush(cwd).catch((reason) => {
    throw readableRemoteError(reason);
  });
  return [pulled, pushed].filter(Boolean).join('\n');
}

export async function gitContinue(cwd: string): Promise<string> {
  const operation = await currentGitOperation(cwd);
  if (!operation) throw new Error('There is no Git operation to continue.');
  if (operation === 'merge') return run(cwd, ['merge', '--continue']);
  if (operation === 'rebase') return run(cwd, ['rebase', '--continue']);
  if (operation === 'cherry-pick') return run(cwd, ['cherry-pick', '--continue']);
  return run(cwd, ['revert', '--continue']);
}

export async function gitAbortOperation(cwd: string): Promise<string> {
  const operation = await currentGitOperation(cwd);
  if (!operation) throw new Error('There is no Git operation to abort.');
  if (operation === 'merge') return run(cwd, ['merge', '--abort']);
  if (operation === 'rebase') return run(cwd, ['rebase', '--abort']);
  if (operation === 'cherry-pick') return run(cwd, ['cherry-pick', '--abort']);
  return run(cwd, ['revert', '--abort']);
}

async function assertNoOperationInProgress(cwd: string, action: string): Promise<void> {
  const inFlight = await currentGitOperation(cwd);
  if (inFlight) {
    throw new Error(
      `A ${inFlight} is already in progress. Continue or abort it before ${action}.`,
    );
  }
}

async function assertCleanWorktree(cwd: string, action: string): Promise<void> {
  const dirty = (await gitStatus(cwd)).files.map((file) => file.path);
  if (dirty.length) {
    throw new Error([
      `Uncommitted changes would be overwritten by ${action}`,
      `: ${dirty.slice(0, 10).join(', ')}`,
      '. Commit or stash them first.',
    ].join(''));
  }
}

async function conflictedPaths(cwd: string): Promise<string[]> {
  const names = await run(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
  return names.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function checkedCommit(cwd: string, value: string): Promise<string> {
  const hash = requiredCommitHash(value);
  const shadowingRef = (await run(cwd, [
    'rev-parse', '--verify', '--quiet', '--symbolic-full-name', hash,
  ]).catch(() => '')).trim();
  if (!shadowingRef) {
    const resolved = (await run(cwd, ['rev-parse', '--verify', '--quiet', `${hash}^{commit}`])
      .catch(() => '')).trim();
    if (resolved) return resolved;
  }
  const candidates = (await run(cwd, ['rev-parse', `--disambiguate=${hash}`]).catch(() => ''))
    .split(/\s+/).map((line) => line.trim()).filter(Boolean);
  const commits: string[] = [];
  for (const candidate of candidates) {
    const peeled = (await run(cwd, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
      .catch(() => '')).trim();
    if (peeled && !commits.includes(peeled)) commits.push(peeled);
  }
  if (commits.length === 1) return commits[0];
  if (commits.length > 1) {
    throw new TypeError(
      `Commit name ${hash} is ambiguous: ${commits.map((sha) => sha.slice(0, 12)).join(', ')}.`,
    );
  }
  throw new TypeError(`No commit named ${hash} in this repository.`);
}

async function commitParentCount(cwd: string, commit: string): Promise<number> {
  const row = await run(cwd, ['rev-list', '--parents', '-n', '1', commit]).catch(() => '');
  return Math.max(0, row.trim().split(/\s+/).filter(Boolean).length - 1);
}

async function checkedTagName(cwd: string, value: string): Promise<string> {
  const tag = String(value || '').trim();
  if (!tag || tag.startsWith('-') || tag.includes('\0') || /[\r\n]/.test(tag)) {
    throw new TypeError('A Git tag name is required.');
  }
  const valid = await run(cwd, ['check-ref-format', `refs/tags/${tag}`])
    .then(() => true)
    .catch(() => false);
  if (!valid) throw new TypeError(`Git tag name is invalid: ${tag}`);
  return tag;
}

async function sequencerFailure(
  cwd: string,
  operation: 'cherry-pick' | 'revert',
  verb: string,
  commit: string,
  reason: unknown,
): Promise<Error> {
  const message = reason instanceof Error ? reason.message : String(reason);
  const conflicted = /conflict/i.test(message)
    || await currentGitOperation(cwd).then((live) => live === operation).catch(() => false);
  if (!conflicted) return reason instanceof Error ? reason : new Error(message);
  const files = await conflictedPaths(cwd);
  return new Error([
    `${verb} ${commit.slice(0, 8)} hit conflicts`,
    files.length ? ` in ${files.length} file(s): ${files.slice(0, 10).join(', ')}` : '',
    `. Resolve them, then continue or abort the ${operation}.`,
  ].join(''));
}

export const GIT_RESET_DIRTY_CODE = 'git-reset-dirty-worktree';

export async function gitResetToCommit(
  cwd: string,
  value: string,
  mode: GitResetMode,
  confirmedDirty = false,
): Promise<string> {
  const reset = requiredGitResetMode(mode);
  const commit = await checkedCommit(cwd, value);
  const action = `resetting to ${commit.slice(0, 8)}`;
  if (reset === 'hard') {
    await assertCleanWorktree(cwd, action);
  } else if (reset === 'mixed' && !confirmedDirty) {
    const dirty = (await gitStatus(cwd)).files.map((file) => file.path);
    if (dirty.length) {
      const refusal: Error & { code?: string } = new Error([
        `A --mixed reset rewrites the index, so ${action} unstages uncommitted work`,
        `: ${dirty.slice(0, 10).join(', ')}`,
        '. Confirm the reset to run it anyway.',
      ].join(''));
      refusal.code = GIT_RESET_DIRTY_CODE;
      throw refusal;
    }
  }
  return run(cwd, ['reset', `--${reset}`, commit]);
}

export async function gitRevertCommit(cwd: string, value: string): Promise<string> {
  const commit = await checkedCommit(cwd, value);
  const mainline = await commitParentCount(cwd, commit) > 1 ? ['-m', '1'] : [];
  try {
    return await run(cwd, ['revert', '--no-edit', ...mainline, commit]);
  } catch (reason) {
    throw await sequencerFailure(cwd, 'revert', 'Reverting', commit, reason);
  }
}

const CHERRY_PICK_KEEP_EMPTY = ['--empty=keep'];
const CHERRY_PICK_KEEP_EMPTY_LEGACY = ['--allow-empty', '--keep-redundant-commits'];

async function runCherryPick(cwd: string, args: string[]): Promise<string> {
  try {
    return await run(cwd, ['cherry-pick', ...CHERRY_PICK_KEEP_EMPTY, ...args]);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (!/unknown option|usage: git cherry-pick/i.test(message)) throw reason;
    return run(cwd, ['cherry-pick', ...CHERRY_PICK_KEEP_EMPTY_LEGACY, ...args]);
  }
}

export async function gitCherryPickCommit(cwd: string, value: string): Promise<string> {
  const commit = await checkedCommit(cwd, value);
  const action = `cherry-picking ${commit.slice(0, 8)}`;
  await assertNoOperationInProgress(cwd, action);
  await assertCleanWorktree(cwd, action);
  const mainline = await commitParentCount(cwd, commit) > 1 ? ['-m', '1'] : [];
  try {
    return await runCherryPick(cwd, [...mainline, commit]);
  } catch (reason) {
    throw await sequencerFailure(cwd, 'cherry-pick', 'Cherry-picking', commit, reason);
  }
}

export async function gitCreateTag(cwd: string, value: string, at: string): Promise<string> {
  const tag = await checkedTagName(cwd, value);
  const commit = await checkedCommit(cwd, at);
  await run(cwd, ['tag', tag, commit]);
  return `Created tag ${tag} at ${commit.slice(0, 8)}.`;
}

export async function gitDeleteTag(cwd: string, value: string): Promise<string> {
  const tag = await checkedTagName(cwd, value);
  return run(cwd, ['tag', '-d', tag]);
}

export async function gitCheckoutCommit(cwd: string, value: string): Promise<string> {
  const commit = await checkedCommit(cwd, value);
  await run(cwd, ['checkout', '--detach', commit]);
  return `HEAD is now at ${commit.slice(0, 8)} (detached).`;
}

export async function gitCreateBranchAtCommit(
  cwd: string,
  value: string,
  at: string,
): Promise<string> {
  const branch = await checkedBranchName(cwd, value);
  const commit = await checkedCommit(cwd, at);
  return run(cwd, ['switch', '-c', branch, commit]);
}
