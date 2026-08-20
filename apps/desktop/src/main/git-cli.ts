// Dock Git panel service: plain `git` CLI calls from the singleton daemon,
// scoped to the active project directory.
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createGitBranchOperations } from './git-branches';
export type { GitBranchEntry } from './git-branches';
import {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  type GitIgnoreScope,
  type GitResetMode,
} from './git-contract.mjs';
export {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  requiredRepositoryCwd,
} from './git-contract.mjs';
export type { GitIgnoreScope, GitResetMode } from './git-contract.mjs';

export type GitOperation = '' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface GitFileEntry {
  path: string;
  oldPath?: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
  stagedAdditions: number;
  stagedDeletions: number;
  unstagedAdditions: number;
  unstagedDeletions: number;
  additions: number;
  deletions: number;
}

export interface GitStatusResult {
  repository: boolean;
  branch: string;
  detached: boolean;
  unborn: boolean;
  upstream: boolean;
  upstreamName: string;
  remote: boolean;
  remoteUrl: string;
  ahead: number;
  behind: number;
  operation: GitOperation;
  files: GitFileEntry[];
}

import {
  publicGitRemoteUrl,
  run,
  runWithInput,
  scrubGitCredentials,
  streamNulRecords,
} from './git-runner';
export { publicGitRemoteUrl, scrubGitCredentials } from './git-runner';

function emptyStatus(): GitStatusResult {
  return {
    repository: false,
    branch: '',
    detached: false,
    unborn: false,
    upstream: false,
    upstreamName: '',
    remote: false,
    remoteUrl: '',
    ahead: 0,
    behind: 0,
    operation: '',
    files: [],
  };
}

function pathAfterFields(record: string, fieldCount: number): string {
  let offset = 0;
  for (let index = 0; index < fieldCount; index++) {
    offset = record.indexOf(' ', offset);
    if (offset < 0) return '';
    offset += 1;
  }
  return record.slice(offset);
}

function normalizeStatusLetter(value: string | undefined): string {
  return !value || value === '.' ? ' ' : value;
}

function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const fields = raw.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(fields[index]);
    if (!match) continue;
    let path = match[3];
    if (!path) {
      index += 2;
      path = fields[index] ?? '';
    }
    if (!path) continue;
    stats.set(path, {
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return stats;
}

async function readNumstat(
  cwd: string,
  args: string[],
): Promise<Map<string, { additions: number; deletions: number }>> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  let renameStat: { additions: number; deletions: number; oldPathSeen: boolean } | null = null;
  try {
    await streamNulRecords(cwd, args, (field) => {
      if (renameStat) {
        if (!renameStat.oldPathSeen) {
          renameStat.oldPathSeen = true;
          return;
        }
        if (field) stats.set(field, {
          additions: renameStat.additions,
          deletions: renameStat.deletions,
        });
        renameStat = null;
        return;
      }
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field);
      if (!match) return;
      const value = {
        additions: match[1] === '-' ? 0 : Number(match[1]),
        deletions: match[2] === '-' ? 0 : Number(match[2]),
      };
      if (match[3]) stats.set(match[3], value);
      else renameStat = { ...value, oldPathSeen: false };
    });
    return stats;
  } catch {
    return new Map();
  }
}

async function hasHead(cwd: string): Promise<boolean> {
  try {
    await run(cwd, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

async function currentGitOperation(cwd: string): Promise<GitOperation> {
  let gitDir = '';
  try {
    gitDir = resolve(cwd, (await run(cwd, ['rev-parse', '--git-dir'])).trim());
  } catch {
    return '';
  }
  const exists = async (name: string): Promise<boolean> => {
    try {
      await access(join(gitDir, name));
      return true;
    } catch {
      return false;
    }
  };
  if (await exists('rebase-merge') || await exists('rebase-apply')) return 'rebase';
  if (await exists('MERGE_HEAD')) return 'merge';
  if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (await exists('REVERT_HEAD')) return 'revert';
  return '';
}

export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  try {
    if ((await run(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') {
      return emptyStatus();
    }
  } catch {
    return emptyStatus();
  }

  const files: GitFileEntry[] = [];
  let branch = '';
  let oid = '';
  let upstreamName = '';
  let unborn = false;
  let ahead = 0;
  let behind = 0;
  let pendingRename: GitFileEntry | null = null;
  const statusStream = streamNulRecords(
    cwd,
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
    (entry) => {
    if (pendingRename) {
      if (entry) pendingRename.oldPath = entry;
      files.push(pendingRename);
      pendingRename = null;
      return;
    }
    if (entry.startsWith('# branch.oid ')) {
      oid = entry.slice('# branch.oid '.length);
      unborn = oid === '(initial)';
      return;
    }
    if (entry.startsWith('# branch.head ')) {
      branch = entry.slice('# branch.head '.length);
      return;
    }
    if (entry.startsWith('# branch.upstream ')) {
      upstreamName = entry.slice('# branch.upstream '.length);
      return;
    }
    if (entry.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(entry);
      ahead = Number(match?.[1] || 0);
      behind = Number(match?.[2] || 0);
      return;
    }
    if (entry.startsWith('? ')) {
      const path = entry.slice(2);
      if (path) {
        files.push({
          path,
          index: '?',
          worktree: '?',
          untracked: true,
          conflicted: false,
          stagedAdditions: 0,
          stagedDeletions: 0,
          unstagedAdditions: 0,
          unstagedDeletions: 0,
          additions: 0,
          deletions: 0,
        });
      }
      return;
    }
    const kind = entry[0];
    if (kind !== '1' && kind !== '2' && kind !== 'u') return;
    const xy = entry.slice(2, 4);
    const path = pathAfterFields(entry, kind === '1' ? 8 : kind === '2' ? 9 : 10);
    if (!path) return;
    const file: GitFileEntry = {
      path,
      index: normalizeStatusLetter(xy[0]),
      worktree: normalizeStatusLetter(xy[1]),
      untracked: false,
      conflicted: kind === 'u',
      stagedAdditions: 0,
      stagedDeletions: 0,
      unstagedAdditions: 0,
      unstagedDeletions: 0,
      additions: 0,
      deletions: 0,
    };
    if (kind === '2') pendingRename = file;
    else files.push(file);
  });
  const [remotesRaw, operation] = await Promise.all([
    run(cwd, ['remote']).catch(() => ''),
    currentGitOperation(cwd),
    statusStream,
  ]).then(([remotes, activeOperation]) => [remotes, activeOperation] as const);
  if (pendingRename) files.push(pendingRename);
  // Hosted-review links prefer origin, else the first remote.
  const remoteNames = remotesRaw.trim().split(/\r?\n/).filter(Boolean);
  const primaryRemote = remoteNames.includes('origin') ? 'origin' : remoteNames[0] || '';
  const remoteUrl = primaryRemote
    ? publicGitRemoteUrl(await run(cwd, ['remote', 'get-url', primaryRemote]).catch(() => ''))
    : '';

  const [stagedStats, unstagedStats] = await Promise.all([
    readNumstat(cwd, ['diff', '--cached', '--numstat', '-z']),
    readNumstat(cwd, ['diff', '--numstat', '-z']),
  ]);
  await Promise.all(files.map(async (file) => {
    const staged = stagedStats.get(file.path);
    const unstaged = unstagedStats.get(file.path);
    file.stagedAdditions = staged?.additions ?? 0;
    file.stagedDeletions = staged?.deletions ?? 0;
    file.unstagedAdditions = unstaged?.additions ?? 0;
    file.unstagedDeletions = unstaged?.deletions ?? 0;
    if (file.untracked) file.unstagedAdditions = await untrackedStat(cwd, file.path);
    file.additions = file.stagedAdditions + file.unstagedAdditions;
    file.deletions = file.stagedDeletions + file.unstagedDeletions;
  }));

  const detached = branch === '(detached)';
  if (detached) {
    branch = oid && oid !== '(initial)' ? `HEAD (${oid.slice(0, 8)})` : 'Detached HEAD';
  }
  return {
    repository: true,
    branch,
    detached,
    unborn,
    upstream: Boolean(upstreamName),
    upstreamName,
    remote: remotesRaw.trim().length > 0,
    remoteUrl,
    ahead,
    behind,
    operation,
    files,
  };
}

// Branch rows carry their tip age ("16 days ago") and,
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

export function gitDiff(
  cwd: string,
  path: string,
  staged: boolean,
  worktreeOnly = false,
  untracked = false,
): Promise<string> {
  if (untracked) return untrackedPatch(cwd, path);
  return run(cwd, ['diff', ...(staged ? ['--cached'] : worktreeOnly ? [] : ['HEAD']), '--', path]);
}

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

/**
 * What a `.gitignore` entry is asked to cover. `file` keeps the historical
 * behavior — one repository-rooted literal path. `extension` is GitHub
 * Desktop's "Ignore all <ext> files", which appends the unanchored `*<ext>`
 * rule (app/src/ui/changes/filter-changes-list.tsx:755 → sidebar.tsx:274 →
 * lib/git/gitignore.ts:63 `appendIgnoreRule`).
 */
/** Glob metacharacters inside text that must match literally. */
function escapedIgnoreLiteral(value: string): string {
  return value.replace(/([*?[\]\\])/g, '\\$1');
}

/**
 * The trailing `.ext` of the path's own name. A dotfile (`.gitignore`) and a
 * bare name have none, and the caller must not be able to turn that into a
 * rule that swallows the repository.
 */
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
  // The extension rule is deliberately UNANCHORED (matches at every depth) and
  // escapes only the literal extension text — the leading `*` is the pattern.
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
  // Source Control owns explicit Stage/Unstage actions. Commit only the
  // index so an unstaged edit can never be swept into an unrelated commit.
  return run(cwd, ['commit', '-m', trimmed]);
}

import { createGitCommitPaths } from './git-commit-transaction';
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

export const gitCommitPaths = createGitCommitPaths(gitStatus);

export function gitAmend(cwd: string, message = ''): Promise<string> {
  const trimmed = message.trim();
  return run(cwd, trimmed
    ? ['commit', '--amend', '-m', trimmed]
    : ['commit', '--amend', '--no-edit']);
}

export function gitUndoLastCommit(cwd: string): Promise<string> {
  // Undo Last Commit keeps the commit's complete index intact.
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

/** `git stash list` — NUL-separated ref/subject/relative-age per line. */
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
      // `checkout -- path` restores from the INDEX, preserving staged work.
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
  // A branch without an upstream publishes
  // to origin, otherwise a plain push (terminal prompts are disabled).
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

// ── History context menu ───────────────────
// Every action below moves HEAD, the index or a ref — but they are
// NOT all gated alike:
//   * a LIVE OPERATION blocks cherry-pick only. The reference's history menu
//     disables that single item while a multi-commit operation runs
//     (app/src/ui/history/commit-list.tsx:843-870 `canCherryPick`) and leaves
//     the reset/checkout/revert/branch/tag dispatchers callable; git itself
//     refuses the ones that really cannot run (a revert on top of a merge, a
//     checkout over unmerged entries) with its own wording.
//   * a DIRTY WORKTREE blocks cherry-pick only, for the same reason: the
//     reference runs `_checkForUncommittedChanges` (app-store.ts:9155) on the
//     cherry-pick path, while "Check out commit" explicitly carries safe local
//     changes across and revert is handed to git, which refuses only when the
//     revert would overwrite the edited file.
//   * `--hard` reset still refuses a dirty worktree outright — it deletes the
//     work — and `--mixed` reset REPORTS the risk instead of silently
//     unstaging staged work (app-store.ts:5839-5856 raises
//     `PopupType.WarningBeforeReset` before it resets).
// Where a check does apply, an untracked file counts as dirty, exactly as
// `gitMergeBranch` above already decided.
// What git itself leaves half-done (a conflicted cherry-pick or revert) is
// left exactly as git left it, so the dock's existing continue/abort path can
// still finish or undo it.

async function assertNoOperationInProgress(cwd: string, action: string): Promise<void> {
  const inFlight = await currentGitOperation(cwd);
  if (inFlight) {
    throw new Error(
      `A ${inFlight} is already in progress. Continue or abort it before ${action}.`,
    );
  }
}

/** Refuse while work that this action would destroy is still uncommitted. */
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

/** The paths git left conflicted, in git's own spelling. */
async function conflictedPaths(cwd: string): Promise<string[]> {
  const names = await run(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
  return names.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * The caller's commit, decided by git and never by a ref that merely LOOKS
 * like an object id. `requiredCommitHash` accepts hex only, so the value can
 * never read as an option — but hex is still a DWIM name: a branch or tag
 * called `7b5a75b` shadows the commit `7b5a75b…` in `git rev-parse`, which
 * would move the wrong history. `rev-parse` is asked first because it is one
 * cheap call, and its answer is trusted only when the name did not resolve to
 * a ref; when it did, `--disambiguate` searches the OBJECT DATABASE alone, so
 * the commit the user pointed at wins over the shadowing ref.
 */
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

/**
 * How many parents a commit has. Two or more is a merge, and a merge can only
 * be replayed against a stated mainline.
 */
async function commitParentCount(cwd: string, commit: string): Promise<number> {
  const row = await run(cwd, ['rev-list', '--parents', '-n', '1', commit]).catch(() => '');
  return Math.max(0, row.trim().split(/\s+/).filter(Boolean).length - 1);
}

/**
 * Tag names are decided by `git check-ref-format`, exactly as branch names are
 * by `checkedBranchName` above. The leading-dash refusal comes first: a name
 * git would accept as a ref could still be read as an option by `git tag`.
 */
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

/**
 * A cherry-pick/revert that stopped: conflicts become a message naming the
 * files, and the sequencer state stays on disk for continue/abort. Anything
 * else is git's own failure, passed through unchanged.
 */
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

/**
 * The `code` a `--mixed` reset refusal carries, so a caller can tell "this
 * needs the user's confirmation" from a real Git failure without matching on
 * prose. The message alone is enough for a UI that only shows text.
 *
 * How far the `code` travels is part of the contract:
 *   * in-process (main-side callers, `remote-methods.ts` handlers) it is the
 *     Error's own property;
 *   * over the remote bridge/relay it is carried as the frame's own
 *     `errorCode` field (remote-methods.ts `RemoteFrameResponse`), because
 *     JSON keeps no custom Error property;
 *   * over Electron IPC it is FLATTENED AWAY — `ipcRenderer.invoke` rebuilds
 *     the rejection from the message alone — so the MESSAGE, which always
 *     names `--mixed` and the files, is the guaranteed carrier and the
 *     renderer matches both (SourceControlDock.tsx `isDirtyResetRefusal`).
 */
export const GIT_RESET_DIRTY_CODE = 'git-reset-dirty-worktree';

/**
 * Move the current branch to `value`. The mode is the caller's, never implied.
 * `hard` rewrites the worktree, so a dirty one is refused outright. `mixed`
 * rewrites the INDEX: staged work silently becomes unstaged, which is why the
 * reference stops for a confirmation first (app-store.ts:5839-5856), so a
 * dirty worktree is reported here — named files and a `code` — until the
 * caller comes back with `confirmedDirty`. `soft` touches neither.
 */
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
  // A MERGE commit has no single "before", so git needs the mainline stated —
  // without it every revert of a merge fails. The reference tests the parent
  // count for exactly this (app/src/lib/git/revert.ts:28-33).
  const mainline = await commitParentCount(cwd, commit) > 1 ? ['-m', '1'] : [];
  try {
    return await run(cwd, ['revert', '--no-edit', ...mainline, commit]);
  } catch (reason) {
    throw await sequencerFailure(cwd, 'revert', 'Reverting', commit, reason);
  }
}

// `--empty=keep` is the reference's flag (app/src/lib/git/cherry-pick.ts:
// 165-179) and the only reason an EMPTY commit can be replayed at all: git's
// default STOPS such a pick (exit 1) and leaves CHERRY_PICK_HEAD on disk, so
// `sequencerFailure` below would report it as a conflict — one the dock cannot
// resolve, because it offers no "skip". It also keeps a commit that became
// empty because its change is already here, which is what makes the picked
// summary appear in this branch's history either way.
//
// git only learned `--empty` for cherry-pick in 2.45, and mixdog does not pin
// the user's git (the same reason `-m 1` is conditional below), so an older git
// is handed the two flags `--empty=keep` replaced: `--keep-redundant-commits`,
// git's own documented synonym for it, plus `--allow-empty` for a commit that
// was empty to begin with. An unknown option is rejected while git parses its
// arguments — before the sequencer touches the repository — so the retry starts
// from exactly the state the first attempt did.
const CHERRY_PICK_KEEP_EMPTY = ['--empty=keep'];
const CHERRY_PICK_KEEP_EMPTY_LEGACY = ['--allow-empty', '--keep-redundant-commits'];
async function runCherryPick(cwd: string, args: string[]): Promise<string> {
  try {
    return await run(cwd, ['cherry-pick', ...CHERRY_PICK_KEEP_EMPTY, ...args]);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (!/unknown option|usage: git cherry-pick/i.test(message)) throw reason;
    return await run(cwd, ['cherry-pick', ...CHERRY_PICK_KEEP_EMPTY_LEGACY, ...args]);
  }
}

export async function gitCherryPickCommit(cwd: string, value: string): Promise<string> {
  const commit = await checkedCommit(cwd, value);
  const action = `cherry-picking ${commit.slice(0, 8)}`;
  await assertNoOperationInProgress(cwd, action);
  await assertCleanWorktree(cwd, action);
  // Same mainline rule as revert. The reference passes `-m 1` unconditionally
  // (app/src/lib/git/cherry-pick.ts:165-179); we pass it only for a merge,
  // because a git older than 2.36 rejects a mainline on a non-merge commit
  // ("mainline was specified but commit … is not a merge") and mixdog does not
  // pin the user's git.
  const mainline = await commitParentCount(cwd, commit) > 1 ? ['-m', '1'] : [];
  try {
    return await runCherryPick(cwd, [...mainline, commit]);
  } catch (reason) {
    throw await sequencerFailure(cwd, 'cherry-pick', 'Cherry-picking', commit, reason);
  }
}

/**
 * A tag only writes `refs/tags`, so uncommitted work is never at risk and is
 * not refused; git prints nothing on stdout, so the dock is handed a line it
 * can show.
 */
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

/**
 * "Check out commit": a detached HEAD at that commit. Local
 * changes are git's business — it carries the safe ones across and refuses the
 * checkout itself when they would be overwritten.
 */
export async function gitCheckoutCommit(cwd: string, value: string): Promise<string> {
  const commit = await checkedCommit(cwd, value);
  await run(cwd, ['checkout', '--detach', commit]);
  return `HEAD is now at ${commit.slice(0, 8)} (detached).`;
}

/** Creating a branch destroys nothing, so uncommitted work rides along. */
export async function gitCreateBranchAtCommit(
  cwd: string,
  value: string,
  at: string,
): Promise<string> {
  const branch = await checkedBranchName(cwd, value);
  const commit = await checkedCommit(cwd, at);
  return run(cwd, ['switch', '-c', branch, commit]);
}

// ── Review surface ─────────────────────────
// The review diff is cumulative: merge-base(origin default branch, HEAD)
// vs the WORKING TREE — committed, uncommitted and untracked work read as
// one change set.
export interface GitReviewFile {
  path: string;
  status: string; // A | M | D (U rendered from untracked)
  additions: number;
  deletions: number;
  untracked: boolean;
  uncommitted: boolean;
}

export interface GitReviewResult {
  base: string;
  files: GitReviewFile[];
}

async function resolveReviewBase(cwd: string): Promise<string> {
  try {
    const head = (await run(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
    const short = head.replace(/^refs\/remotes\//, '');
    if (short) return short;
  } catch { /* no origin/HEAD ref */ }
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      await run(cwd, ['rev-parse', '--verify', '--quiet', candidate]);
      return candidate;
    } catch { /* try next */ }
  }
  return 'HEAD';
}

async function resolveMergeBase(cwd: string): Promise<{ base: string; ref: string }> {
  const base = await resolveReviewBase(cwd);
  if (base === 'HEAD') return { base, ref: 'HEAD' };
  try {
    const ref = (await run(cwd, ['merge-base', base, 'HEAD'])).trim();
    return { base, ref: ref || 'HEAD' };
  } catch {
    return { base, ref: 'HEAD' };
  }
}

async function untrackedStat(cwd: string, path: string): Promise<number> {
  try {
    const text = await readFile(join(cwd, path), 'utf8');
    if (!text || text.includes('\0')) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

async function untrackedPatch(cwd: string, path: string): Promise<string> {
  try {
    const text = await readFile(join(cwd, path), 'utf8');
    if (!text || text.includes('\0')) return '';
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (!lines.length) return '';
    return [
      `diff --git a/${path} b/${path}`,
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n') + '\n';
  } catch {
    return '';
  }
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  when: string;
  author: string;
  authoredAt: string;
  pushed: boolean;
  parents: string[];
  refs: string[];
  /** Tag names only, `tag: `/`refs/tags/` stripped — never a branch. */
  tags: string[];
  /** Local branch names (`refs/heads/…`), never the bare detached `HEAD`. */
  branches: string[];
  /** Remote-tracking names (`refs/remotes/…`), e.g. `origin/main`. */
  remotes: string[];
}

// History view: recent commits with an
// unpushed marker so "committed but not pushed" is visible at a glance.
function displayRef(value: string): string {
  return value.trim()
    .replace(/^HEAD -> /, '')
    .replace(/^tag:\s*/, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/tags\//, '');
}

interface DecodedRefs {
  refs: string[];
  tags: string[];
  branches: string[];
  remotes: string[];
}

/**
 * `%D` reads "HEAD -> refs/heads/main, tag: refs/tags/v1, tag: refs/tags/a,b".
 * Splitting on the ", " separator and testing each entry for the
 * `tag: ` prefix is required precisely because a regex
 * like /tag: ([^\s,]+)/ clips a tag name containing a comma. Refnames cannot
 * contain a space, so ", " can only ever be git's own separator.
 */
function decodeRefs(decorations: string): DecodedRefs {
  const decoded: DecodedRefs = { refs: [], tags: [], branches: [], remotes: [] };
  for (const raw of String(decorations || '').split(', ')) {
    const entry = raw.trim();
    if (!entry) continue;
    const name = displayRef(entry);
    if (!name) continue;
    decoded.refs.push(name);
    const head = entry.replace(/^HEAD -> /, '');
    if (head.startsWith('tag:')) decoded.tags.push(name);
    else if (head.startsWith('refs/remotes/')) decoded.remotes.push(name);
    else if (head !== 'HEAD') decoded.branches.push(name);
  }
  return decoded;
}

export async function gitLog(
  cwd: string,
  query = '',
  skip = 0,
  limit = 40,
): Promise<GitLogEntry[]> {
  let raw = '';
  try {
    const safeQuery = String(query || '').trim().slice(0, 200);
    const safeSkip = Math.max(0, Math.floor(Number(skip) || 0));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
    raw = await run(cwd, [
      'log',
      '--all',
      '--topo-order',
      '--decorate=full',
      `--skip=${safeSkip}`,
      `-n${safeLimit}`,
      ...(safeQuery ? ['--regexp-ignore-case', `--grep=${safeQuery}`] : []),
      '--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%cr%x1f%an%x1f%aI',
    ]);
  } catch {
    return []; // Empty repository (no commits yet).
  }
  let unpushed = new Set<string>();
  try {
    unpushed = new Set((await run(cwd, ['rev-list', '@{u}..HEAD'])).split(/\s+/).filter(Boolean));
  } catch {
    try {
      unpushed = new Set((await run(cwd, ['rev-list', 'HEAD'])).split(/\s+/).filter(Boolean));
    } catch {
      unpushed = new Set();
    }
  }
  return raw.split('\n').filter(Boolean).map((line) => {
    const [hash = '', shortHash = '', parents = '', decorations = '', subject = '',
      when = '', author = '', authoredAt = ''] =
      line.split('\u001f');
    const { refs, tags, branches, remotes } = decodeRefs(decorations);
    return {
      hash,
      shortHash,
      subject,
      when,
      author,
      authoredAt,
      pushed: !unpushed.has(hash),
      parents: parents.split(/\s+/).filter(Boolean),
      refs,
      tags,
      branches,
      remotes,
    };
  });
}

export interface GitCommitFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GitCommitDetails {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  email: string;
  authoredAt: string;
  parents: string[];
  files: GitCommitFile[];
}

function parseCommitFiles(statusRaw: string, numstatRaw: string): GitCommitFile[] {
  const stats = parseNumstat(numstatRaw);
  const fields = statusRaw.split('\0');
  const files: GitCommitFile[] = [];
  for (let index = 0; index < fields.length;) {
    const token = fields[index++];
    if (!token) continue;
    const status = token[0] || 'M';
    let oldPath: string | undefined;
    let path = '';
    if (status === 'R' || status === 'C') {
      oldPath = fields[index++] || undefined;
      path = fields[index++] || '';
    } else {
      path = fields[index++] || '';
    }
    if (!path) continue;
    const stat = stats.get(path);
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
    });
  }
  return files;
}

export async function gitShow(cwd: string, hash: string): Promise<GitCommitDetails> {
  const [metadata, statusRaw, numstatRaw] = await Promise.all([
    run(cwd, ['show', '-s', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P', hash]),
    run(cwd, ['show', '--format=', '--name-status', '-z', '--find-renames', '--first-parent', hash]),
    run(cwd, ['show', '--format=', '--numstat', '-z', '--find-renames', '--first-parent', hash]),
  ]);
  const [fullHash = hash, shortHash = hash.slice(0, 8), subject = '', author = '', email = '',
    authoredAt = '', parents = ''] = metadata.trim().split('\u001f');
  return {
    hash: fullHash,
    shortHash,
    subject,
    author,
    email,
    authoredAt,
    parents: parents.split(/\s+/).filter(Boolean),
    files: parseCommitFiles(statusRaw, numstatRaw),
  };
}

export function gitShowDiff(cwd: string, hash: string, path: string): Promise<string> {
  return run(cwd, [
    'show',
    '--format=',
    '--patch',
    '--no-color',
    '--find-renames',
    '--first-parent',
    hash,
    '--',
    path,
  ]);
}

/** File content at a revision — `HEAD`, `:0` (index) or a commit hash
 *  (optionally `^`-suffixed for its first parent). Returns null when the path
 *  does not exist there (new/untracked files, root-commit parents). */
export async function gitShowFile(cwd: string, rev: string, path: string): Promise<string | null> {
  try {
    return await run(cwd, ['show', `${rev}:${path.replace(/\\/g, '/')}`]);
  } catch {
    return null;
  }
}

export async function gitReview(cwd: string): Promise<GitReviewResult> {
  const { base, ref } = await resolveMergeBase(cwd);
  const files = new Map<string, GitReviewFile>();
  try {
    const nameStatus = await run(cwd, ['diff', ref, '--name-status', '--no-renames', '-z']);
    const fields = nameStatus.split('\0').filter(Boolean);
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const path = fields[i + 1];
      if (!path) continue;
      files.set(path, {
        path,
        status: fields[i][0] ?? 'M',
        additions: 0,
        deletions: 0,
        untracked: false,
        uncommitted: false,
      });
    }
    const numstat = await run(cwd, ['diff', ref, '--numstat', '--no-renames', '-z']);
    for (const field of numstat.split('\0').filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field);
      const entry = match && match[3] ? files.get(match[3]) : undefined;
      if (!match || !entry) continue;
      entry.additions = match[1] === '-' ? 0 : Number(match[1]);
      entry.deletions = match[2] === '-' ? 0 : Number(match[2]);
    }
  } catch { /* empty repository (no HEAD yet) */ }
  // Working-tree overlay: uncommitted rows keep their revert affordance and
  // untracked files join the set as pure additions.
  try {
    const raw = await run(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
    for (const entry of raw.split('\0')) {
      if (entry.length < 4) continue;
      const path = entry.slice(3);
      if (!path) continue;
      const untracked = entry[0] === '?' && entry[1] === '?';
      const existing = files.get(path);
      if (existing) {
        existing.uncommitted = true;
        existing.untracked = untracked;
        continue;
      }
      files.set(path, {
        path,
        status: untracked ? 'A' : 'M',
        additions: untracked ? await untrackedStat(cwd, path) : 0,
        deletions: 0,
        untracked,
        uncommitted: true,
      });
    }
  } catch { /* not a repository */ }
  return { base, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function gitReviewDiff(cwd: string, path: string, untracked: boolean): Promise<string> {
  if (untracked) return untrackedPatch(cwd, path);
  const { ref } = await resolveMergeBase(cwd);
  return run(cwd, ['diff', ref, '--', path]);
}
