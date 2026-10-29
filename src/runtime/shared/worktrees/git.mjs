/**
 * Git process access for managed worktrees. Children run on the shared
 * git-runner worker (process creation never stalls the host loop) with a
 * pinned, non-interactive environment that never inherits a caller's
 * GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE.
 */
import { stat } from 'node:fs/promises';
import { runGitOffThread } from '../git-runner.mjs';
import { worktreeError } from './contract.mjs';
import { canonicalPath } from './paths.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const SCOPED_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
];

function gitEnvironment() {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
  };
  for (const name of Object.keys(env)) {
    if (SCOPED_GIT_ENV.includes(name.toUpperCase())) delete env[name];
  }
  return env;
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw Object.assign(new Error('The worktree operation was aborted.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function gitFailure(args, result) {
  const detail = String(result?.stderr || result?.stdout || '').trim() || 'no diagnostic';
  const error = new Error(`git ${args.join(' ')} failed (exit ${result?.code}): ${detail}`);
  error.code = 'GIT_FAILED';
  error.exitCode = result?.code;
  error.stderr = String(result?.stderr || '');
  return error;
}

/** True for a failure caused by a full disk (ENOSPC, git's or Windows' text). */
export function isDiskFullError(error) {
  if (!error) return false;
  if (error.code === 'ENOSPC') return true;
  const text = `${error.message || ''}\n${error.stderr || ''}`;
  return /no space left on device|not enough space|ENOSPC|disk (?:is )?full/i.test(text);
}

// Command-scoped settings only (the repository config is never written):
// paths below a managed worktree root easily pass Windows' MAX_PATH.
const SCOPED_CONFIG = ['-c', 'core.longpaths=true'];
// Read-only status probes never take optional locks nor wake an fsmonitor.
const READ_ONLY_FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, allowFailure?: boolean, readOnly?: boolean, env?: Record<string, string> }} [options]
 *   `env`: variables set on top of the pinned environment (a temporary GIT_INDEX_FILE, a commit identity).
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runGit(
  cwd,
  args,
  { signal, timeoutMs, maxBytes, allowFailure = false, readOnly = false, env = null } = {}
) {
  throwIfAborted(signal);
  const result = await runGitOffThread([...(readOnly ? READ_ONLY_FLAGS : []), ...SCOPED_CONFIG, ...args], {
    cwd,
    env: env ? { ...gitEnvironment(), ...env } : gitEnvironment(),
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: maxBytes ?? DEFAULT_MAX_BYTES,
  });
  if (result.code !== 0 && !allowFailure) throw gitFailure(args, result);
  return result;
}

/** The never-throwing runner shape the merge backend takes. */
export function gitStatusRunner(cwd, args) {
  return runGit(cwd, args, { allowFailure: true });
}

export function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)[0]
    .trim();
}

function lines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** WORKTREE_PROJECT_UNKNOWN (reason 'missing') when the project folder is gone from disk. */
async function assertProjectFolder(cwd) {
  let isFolder = false;
  try {
    isFolder = (await stat(cwd)).isDirectory();
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  if (!isFolder) {
    throw worktreeError('WORKTREE_PROJECT_UNKNOWN', 'The project folder no longer exists.', {
      projectPath: cwd,
      reason: 'missing',
    });
  }
}

/**
 * Repository facts every managed operation starts from. Fails with
 * WORKTREE_PROJECT_UNKNOWN (reason 'missing') when the folder is gone, and
 * WORKTREE_UNSUPPORTED_REPO for non-repositories, bare repositories and
 * repositories without a first commit.
 * @param {string} projectPath
 */
export async function inspectRepo(projectPath, { signal } = {}) {
  const cwd = canonicalPath(projectPath);
  await assertProjectFolder(cwd);
  // The usual repository answers every fact in one `rev-parse`: bareness,
  // top level, common dir and HEAD's commit, in that order, then the echoed
  // `--` (which makes an unresolvable HEAD fail the call instead of being
  // read as a path). Any other answer (bare, no work tree, no commits, an
  // unexpected shape) takes the step-by-step reads, whose results and errors
  // are the contract.
  const facts = await runGit(
    cwd,
    [
      'rev-parse',
      '--is-bare-repository',
      '--show-toplevel',
      '--path-format=absolute',
      '--git-common-dir',
      'HEAD^{commit}',
      '--',
    ],
    { signal, allowFailure: true }
  );
  const [factBare, factTop, factCommonDir, factHead, dashes, ...rest] = String(facts.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (
    facts.code === 0 &&
    factBare === 'false' &&
    factTop &&
    factCommonDir &&
    /^[0-9a-f]{40,64}$/.test(factHead) &&
    dashes === '--' &&
    rest.every((line) => line === '')
  ) {
    return {
      projectPath: cwd,
      topLevel: canonicalPath(factTop),
      repoCommonDir: canonicalPath(factCommonDir),
      headCommit: factHead,
      currentBranch: await currentBranch(cwd, { signal }),
    };
  }
  const probe = await runGit(cwd, ['rev-parse', '--is-bare-repository', '--path-format=absolute', '--git-common-dir'], {
    signal,
    allowFailure: true,
  });
  if (probe.code !== 0) {
    throw worktreeError('WORKTREE_UNSUPPORTED_REPO', 'The project folder is not a git repository.', {
      projectPath: cwd,
    });
  }
  const [bare, commonDir] = lines(probe.stdout);
  if (bare === 'true' || !commonDir) {
    throw worktreeError('WORKTREE_UNSUPPORTED_REPO', 'Bare repositories cannot host managed worktrees.', {
      projectPath: cwd,
    });
  }
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel'], { signal, allowFailure: true });
  if (top.code !== 0) {
    throw worktreeError('WORKTREE_UNSUPPORTED_REPO', 'The project folder has no git work tree.', { projectPath: cwd });
  }
  const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { signal, allowFailure: true });
  if (head.code !== 0) {
    throw worktreeError('WORKTREE_UNSUPPORTED_REPO', 'The repository has no commits yet; commit once first.', {
      projectPath: cwd,
    });
  }
  return {
    projectPath: cwd,
    topLevel: canonicalPath(firstLine(top.stdout)),
    repoCommonDir: canonicalPath(commonDir),
    headCommit: firstLine(head.stdout),
    currentBranch: await currentBranch(cwd, { signal }),
  };
}

/** Short name of the checked-out branch, or null when detached/unborn-less. */
export async function currentBranch(cwd, { signal } = {}) {
  const result = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal, allowFailure: true });
  return result.code === 0 ? firstLine(result.stdout) || null : null;
}

/** Full commit id of a local branch, or null when it does not exist. */
export async function branchCommit(cwd, branch, { signal } = {}) {
  const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], {
    signal,
    allowFailure: true,
  });
  return result.code === 0 ? firstLine(result.stdout) : null;
}

/** Full commit ids of two existing local branches from one `rev-parse` (the
 *  trailing `--` makes a missing one fail the call), or null whenever that
 *  answer is not exactly two commit ids: the caller then reads each with
 *  branchCommit(). */
export async function branchCommitPair(cwd, first, second, { signal } = {}) {
  const result = await runGit(cwd, ['rev-parse', `refs/heads/${first}^{commit}`, `refs/heads/${second}^{commit}`, '--'], {
    signal,
    allowFailure: true,
  });
  const [a, b, dashes, ...rest] = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const commit = /^[0-9a-f]{40,64}$/;
  return result.code === 0 && commit.test(a) && commit.test(b) && dashes === '--' && rest.every((line) => !line)
    ? [a, b]
    : null;
}

export async function localBranches(cwd, { signal, prefix = '' } = {}) {
  const result = await runGit(cwd, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`], { signal });
  return lines(result.stdout);
}

/** The local branch names the repository's remotes declare as their default (`refs/remotes/<remote>/HEAD`). */
export async function remoteDefaultBranches(cwd) {
  const result = await runGit(cwd, ['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes'], {
    readOnly: true,
  });
  const names = [];
  for (const line of lines(result.stdout)) {
    const [ref, target] = line.split(' ');
    if (!ref.endsWith('/HEAD') || !target) continue;
    const remote = ref.slice(0, -'HEAD'.length);
    if (target.startsWith(remote)) names.push(target.slice(remote.length));
  }
  return names;
}

export async function validBranchName(cwd, branch) {
  if (typeof branch !== 'string' || !branch.trim() || branch.startsWith('-')) return false;
  const result = await runGit(cwd, ['check-ref-format', '--branch', branch], { allowFailure: true });
  return result.code === 0;
}

/**
 * `git worktree list --porcelain -z`, with canonical paths.
 * @returns {Promise<Array<{ path: string, head: string|null, branch: string|null, bare: boolean, detached: boolean, locked: string|null, prunable: string|null }>>}
 */
export async function listWorktrees(cwd, { signal } = {}) {
  const result = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'], { signal });
  const worktrees = [];
  let current = null;
  for (const field of result.stdout.split('\0')) {
    if (!field) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (current) worktrees.push(current);
      current = {
        path: canonicalPath(value),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: null,
        prunable: null,
      };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = value;
    else if (key === 'prunable') current.prunable = value;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

/**
 * Paths reported by `git status --porcelain=v1 -z`.
 * @param {string} raw
 */
export function parseStatusPaths(raw) {
  const fields = String(raw || '').split('\0');
  const paths = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    paths.push(field.slice(3));
    if (code.includes('R') || code.includes('C')) index++;
  }
  return paths;
}
