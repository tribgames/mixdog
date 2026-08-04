// Dock Git panel backend: plain `git` CLI
// calls from the main process, scoped to the active project directory.
import { execFile, spawn } from 'node:child_process';
import {
  access, copyFile, lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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

export interface GitBranchEntry {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string;
  /** Branch tip committer date (ISO-8601), '' when the ref has no date. */
  lastCommitAt?: string;
  /** Branch tip age in git's relative grammar ("16 days ago"). */
  lastCommitRelative?: string;
  /** Commits this branch has that HEAD lacks (git >= 2.31 only). */
  ahead?: number;
  /** Commits HEAD has that this branch lacks (git >= 2.31 only). */
  behind?: number;
}

/**
 * The environment every git child runs with. `GIT_INDEX_FILE` is decided here
 * and nowhere else: a command either writes the scratch index it was handed,
 * or the repository's own — an inherited value can never choose for us.
 */
function gitEnvironment(indexFile?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
  };
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  else delete env.GIT_INDEX_FILE;
  return env;
}

function run(cwd: string, args: string[], indexFile?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16_000_000,
      env: gitEnvironment(indexFile),
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout));
    });
  });
}

/**
 * The same child, but with git's EXIT CODE kept. Git spends exit codes on
 * meaning — `config --get` answers 1 for "not set" and something else for a
 * config it could not read — and a caller that only sees "it failed" has to
 * guess between the two. `code: -1` is a process that never ran.
 */
interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

function runWithStatus(cwd: string, args: string[]): Promise<GitOutcome> {
  return new Promise((settle) => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16_000_000,
      env: gitEnvironment(),
    }, (error, stdout, stderr) => {
      const raw = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
      settle({
        code: error ? (typeof raw === 'number' ? raw : -1) : 0,
        stdout: String(stdout),
        stderr: String(stderr || error?.message || '').trim(),
      });
    });
  });
}

function runWithInput(
  cwd: string,
  args: string[],
  input: string,
  indexFile?: string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: gitEnvironment(indexFile),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-64_000);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-64_000);
    });
    child.stdin.on('error', () => {
      // A failed git process can close stdin before the buffered patch drains.
      // The close handler below reports the authoritative stderr.
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(stderr.trim() || `git exited with code ${code}.`));
        return;
      }
      resolvePromise(stdout);
    });
    child.stdin.end(input);
  });
}

function streamNulRecords(
  cwd: string,
  args: string[],
  onRecord: (record: string) => void,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: gitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let pending = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let separator = pending.indexOf('\0');
      while (separator >= 0) {
        onRecord(pending.slice(0, separator));
        pending = pending.slice(separator + 1);
        separator = pending.indexOf('\0');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-64_000);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(stderr.trim() || `git exited with code ${code}.`));
        return;
      }
      if (pending) onRecord(pending);
      resolvePromise();
    });
  });
}

export function requiredRepositoryCwd(value: unknown): string {
  const cwd = typeof value === 'string' ? value.trim() : '';
  if (!cwd || !isAbsolute(cwd)) throw new TypeError('A project directory is required.');
  return cwd;
}

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
  // Hosted-review links (Orca grammar): prefer origin, else the first remote.
  const remoteNames = remotesRaw.trim().split(/\r?\n/).filter(Boolean);
  const primaryRemote = remoteNames.includes('origin') ? 'origin' : remoteNames[0] || '';
  const remoteUrl = primaryRemote
    ? (await run(cwd, ['remote', 'get-url', primaryRemote]).catch(() => '')).trim()
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

// Branch rows carry their tip age (GitHub Desktop shows "16 days ago") and,
// when git can compute it in the same walk, ahead/behind against HEAD.
const BRANCH_FIELDS =
  '%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)'
  + '%00%(committerdate:iso-strict)%00%(committerdate:relative)';

function parseBranchRows(raw: string): GitBranchEntry[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    const [
      ref = '',
      name = '',
      head = '',
      upstream = '',
      committerDate = '',
      relativeDate = '',
      aheadBehind = '',
    ] = line.split('\0');
    if (!ref || !name || /\/HEAD$/.test(name)) return [];
    // `%(ahead-behind:HEAD)` prints "<ahead> <behind>"; absent on older git.
    const [ahead = '', behind = ''] = aheadBehind.trim().split(/\s+/);
    const counted = /^\d+$/.test(ahead) && /^\d+$/.test(behind);
    return [{
      name,
      current: head.trim() === '*',
      remote: ref.startsWith('refs/remotes/'),
      upstream,
      lastCommitAt: committerDate.trim(),
      lastCommitRelative: relativeDate.trim(),
      ...(counted ? { ahead: Number(ahead), behind: Number(behind) } : {}),
    }];
  }).sort((left, right) =>
    Number(right.current) - Number(left.current)
    || Number(left.remote) - Number(right.remote)
    || left.name.localeCompare(right.name));
}

export async function gitBranches(cwd: string): Promise<GitBranchEntry[]> {
  const refs = ['refs/heads', 'refs/remotes'];
  try {
    return parseBranchRows(await run(cwd, [
      'for-each-ref',
      `--format=${BRANCH_FIELDS}%00%(ahead-behind:HEAD)`,
      ...refs,
    ]));
  } catch {
    // Older git (no ahead-behind field) or an unborn HEAD: age only.
    return parseBranchRows(await run(cwd, ['for-each-ref', `--format=${BRANCH_FIELDS}`, ...refs]));
  }
}

async function checkedBranchName(cwd: string, value: string): Promise<string> {
  const branch = String(value || '').trim();
  if (!branch) throw new TypeError('A Git branch name is required.');
  await run(cwd, ['check-ref-format', '--branch', branch]);
  return branch;
}

export async function gitCheckoutBranch(
  cwd: string,
  value: string,
  remote = false,
): Promise<string> {
  const branch = await checkedBranchName(cwd, value);
  if (!remote) return run(cwd, ['switch', branch]);
  const localBranch = branch.replace(/^[^/]+\//, '');
  const localExists = await run(cwd, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${localBranch}`,
  ]).then(() => true).catch(() => false);
  return run(cwd, localExists
    ? ['switch', localBranch]
    : ['switch', '--track', branch]);
}

export async function gitCreateBranch(cwd: string, value: string): Promise<string> {
  return run(cwd, ['switch', '-c', await checkedBranchName(cwd, value)]);
}

export async function gitRenameBranch(
  cwd: string,
  value: string,
  nextValue: string,
): Promise<string> {
  const branch = await checkedBranchName(cwd, value);
  const nextBranch = await checkedBranchName(cwd, nextValue);
  return run(cwd, ['branch', '-m', branch, nextBranch]);
}

export async function gitDeleteBranch(cwd: string, value: string): Promise<string> {
  return run(cwd, ['branch', '-d', await checkedBranchName(cwd, value)]);
}

// GitHub Desktop's "Choose a branch to merge into <current>": merge the chosen
// branch into the checked-out one, reporting conflicts as an actionable error
// while the half-done merge stays in the worktree for continue/abort.
// Two pre-flights mirror GitHub Desktop's dispatcher (app/src/ui/dispatcher/
// dispatcher.ts:3007 -> app-store.ts:9155 `_checkForUncommittedChanges`):
// never start a second operation on top of a live one, and never start a merge
// over a dirty working directory — the reference refuses and names the files
// instead of letting them intermingle with merge state.
export async function gitMergeBranch(cwd: string, value: string): Promise<string> {
  const branch = await checkedBranchName(cwd, value);
  const inFlight = await currentGitOperation(cwd);
  if (inFlight) {
    throw new Error(
      `A ${inFlight} is already in progress. Continue or abort it before merging ${branch}.`,
    );
  }
  const dirty = (await gitStatus(cwd)).files.map((file) => file.path);
  if (dirty.length) {
    throw new Error([
      `Uncommitted changes would be overwritten by merging ${branch}`,
      `: ${dirty.slice(0, 10).join(', ')}`,
      '. Commit or stash them first.',
    ].join(''));
  }
  try {
    return await run(cwd, ['merge', '--no-edit', branch]);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    const conflicted = /conflict/i.test(message)
      || await currentGitOperation(cwd).then((operation) => operation === 'merge').catch(() => false);
    if (!conflicted) throw reason instanceof Error ? reason : new Error(message);
    const names = await run(cwd, ['diff', '--name-only', '--diff-filter=U'])
      .catch(() => '');
    const files = names.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const current = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
      .then((name) => name.trim()).catch(() => 'HEAD');
    throw new Error([
      `Merging ${branch} into ${current} hit conflicts`,
      files.length ? ` in ${files.length} file(s): ${files.slice(0, 10).join(', ')}` : '',
      '. Resolve them, then continue or abort the merge.',
    ].join(''));
  }
}

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
export type GitIgnoreScope = 'file' | 'extension';

export function requiredGitIgnoreScope(value: unknown): GitIgnoreScope {
  if (value === undefined || value === 'file') return 'file';
  if (value === 'extension') return 'extension';
  throw new TypeError('Git ignore scope is invalid.');
}

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

// `:(literal)` keeps a real path with glob characters ("cache[1].txt") from
// being read as a pattern, and keeps a leading `:` out of pathspec magic.
function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

/** A repository's identity: the realpath'd git dir plus its worktree root. */
interface RepositoryIdentity {
  gitDir: string;
  toplevel: string;
}

async function repositoryIdentity(cwd: string): Promise<RepositoryIdentity> {
  const raw = await run(cwd, ['rev-parse', '--absolute-git-dir', '--show-toplevel'])
    .catch(() => '');
  const [gitDir = '', toplevel = ''] = raw.split(/\r?\n/).map((line) => line.trim());
  if (!gitDir || !toplevel) throw new Error('This folder is not a Git repository.');
  const real = async (path: string): Promise<string> =>
    realpath(resolve(path)).catch(() => resolve(path));
  return { gitDir: await real(gitDir), toplevel: await real(toplevel) };
}

// One in-flight commit sequence per REPOSITORY, not per cwd: a nested path, a
// symlinked spelling and the repository root all resolve to the same git dir,
// so they queue behind one another and cannot build two commits on the same
// HEAD. What this cannot cover: a second OS process (another mixdog window, a
// terminal, an editor). There the guards are git's own — the compare-and-swap
// on `update-ref` refuses a ref that moved underneath us, and the post-commit
// index refresh is the only step that can meet `.git/index.lock`, which
// `indexLockContention` reports as "another Git process".
const repositorySequences = new Map<string, Promise<void>>();

function withRepositorySequence<T>(gitDir: string, task: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? gitDir.toLowerCase() : gitDir;
  const previous = repositorySequences.get(key) ?? Promise.resolve();
  const result = previous.then(task, task);
  const settled: Promise<void> = result.then(() => undefined, () => undefined).then(() => {
    if (repositorySequences.get(key) === settled) repositorySequences.delete(key);
  });
  repositorySequences.set(key, settled);
  return result;
}

/**
 * Contention — but only when git itself reports that it could not create THIS
 * repository's `index.lock`. The pathspec commit opens the real index exactly
 * once (the post-commit refresh), so a hook, a file name or a diff that merely
 * contains the string "index.lock" can no longer be relabelled as contention.
 */
function indexLockContention(gitDir: string, reason: unknown): Error {
  const failure = reason instanceof Error ? reason : new Error(String(reason));
  const lock = /Unable to create '([^']+)': File exists/i.exec(failure.message);
  if (!lock || comparablePath(lock[1] ?? '') !== comparablePath(join(gitDir, 'index.lock'))) {
    return failure;
  }
  return new Error([
    'Another Git process is using this repository (index.lock is held)',
    '. Wait for it to finish, then commit again.',
  ].join(''));
}

function assertCommitPath(path: string): void {
  // Argument-injection guard, applied to the caller's EXACT bytes: a pathspec
  // may never read as an option, an absolute/drive path, a traversal, or a
  // NUL-spliced value.
  if (path.startsWith('-') || path.includes('\0') || isAbsolute(path)
    || /^[A-Za-z]:[\\/]/.test(path)
    || path.split(/[\\/]/).includes('..')) {
    throw new TypeError(`Commit path is invalid: ${path}`);
  }
}

function pathIsInIndex(cwd: string, path: string): Promise<boolean> {
  return run(cwd, ['ls-files', '--error-unmatch', '--', literalPathspec(path)])
    .then(() => true)
    .catch(() => false);
}

function pathIsInHead(cwd: string, path: string): Promise<boolean> {
  return run(cwd, ['ls-tree', '-r', '--name-only', 'HEAD', '--', literalPathspec(path)])
    .then((output) => output.trim().length > 0)
    .catch(() => false);
}

/** Every path git knows here, in git's own spelling. */
async function repositoryPaths(cwd: string, seeded: Iterable<string>): Promise<string[]> {
  const paths = new Set<string>(seeded);
  await streamNulRecords(cwd, ['ls-files', '-z'], (record) => {
    if (record) paths.add(record);
  }).catch(() => {});
  return [...paths];
}

function comparablePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Line the caller's input up against the repository's own path list instead of
 * rewriting the string: separator or case differences resolve to git's exact
 * spelling, and anything matching more than one entry is refused.
 */
function matchRepositoryPath(candidates: string[], path: string): string[] {
  const wanted = comparablePath(path);
  return candidates.filter((candidate) => comparablePath(candidate) === wanted);
}

async function existsInsideWorktree(cwd: string, path: string): Promise<boolean> {
  const root = await run(cwd, ['rev-parse', '--show-toplevel'])
    .then((value) => resolve(value.trim()))
    .catch(() => '');
  if (!root) return false;
  const absolute = resolve(cwd, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const inside = comparablePath(absolute).startsWith(comparablePath(prefix));
  if (!inside) return false;
  return access(absolute).then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------
// "Commit the selected files", assembled in a SCRATCH index instead of the
// user's. `git commit -- <paths>` could only see paths the real index already
// knew, so untracked selections had to be marked with `git add
// --intent-to-add` and journaled for crash repair; all of that is gone. The
// commit is built from HEAD plus the worktree content of the selected paths in
// a throwaway index file outside the repository (GIT_INDEX_FILE), and the only
// write to the user's index happens AFTER the commit object exists and the
// branch has moved.
//
// The whole sequence, in order:
//   git rev-parse --verify --quiet HEAD^{commit}
//   git ls-files --stage -z                    (the user's index, for comparison)
//   git read-tree <HEAD>                       (or --empty on an unborn branch)
//   git add --all --force -- <selected paths>  (worktree content, deletions too)
//   git hook run --ignore-missing pre-commit
//   git hook run --ignore-missing prepare-commit-msg -- <COMMIT_EDITMSG> message
//   git hook run --ignore-missing commit-msg -- <COMMIT_EDITMSG>
//   git ls-files --stage -z                    (did a hook write the real index?)
//   git stripspace [--strip-comments]          (commit.cleanup, `-m` semantics)
//   git write-tree
//   git diff-tree -r --name-only -z --no-commit-id <HEAD>^{tree} <tree>
//   git config --bool --default false --get commit.gpgsign
//   git commit-tree <tree> [-S] [-p <HEAD>]    (message on stdin)
//   git update-ref -m "commit[ (initial)]: <subject>" HEAD <new> <old|"">
//   git hook run --ignore-missing post-commit
//   open .git/index.lock (O_CREAT|O_EXCL)      (git's own lock, held by us)
//   git ls-files --stage -z                    (did anything move underneath?)
//   copy .git/index -> <scratch>/refresh.index
//   git reset --quiet <new> -- <paths still as we left them>   (into the copy)
//   rename .git/index.lock -> .git/index       (publish and unlock, one step)
// Everything before `update-ref` touches nothing but the scratch index and the
// object database, so an interrupted run leaves the index, HEAD and every ref
// exactly as they were — there is no marker to undo and nothing to journal.

/** The hooks git runs for `commit -m`, in git's own order. */
const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'];

/**
 * `git hook run` is missing (git < 2.36): a CAPABILITY answer, not a failure.
 * Every other probe error is a fault and must never be read as "hooks are not
 * available" — that would bypass a pre-commit policy in silence.
 *
 * ONE signature qualifies: git's own "not a git command" answer for the `hook`
 * subcommand. `usage: git hook …` is what a git that HAS the command prints
 * for a bad invocation, and "unknown subcommand" is what it prints for `git
 * hook <typo>` — reading either as "no hooks here" would skip a repository's
 * pre-commit policy on a git that can run it.
 */
export function missingHookRunner(message: string): boolean {
  return /'hook' is not a git command/i.test(message);
}

/**
 * Hook-less operation is never silent. A git too old for `git hook run` may
 * still commit — but only where the repository defines no commit hook at all.
 * With a hook installed the commit is refused instead of skipping it quietly.
 */
export function assertCommitHooksRunnable(supported: boolean, present: string[]): void {
  if (supported || !present.length) return;
  throw new Error([
    'This Git cannot run commit hooks (git hook run needs Git 2.36 or newer), and this ',
    `repository defines ${present.join(', ')}`,
    '. Update Git, or remove the hook, then commit again.',
  ].join(''));
}

/**
 * git's own rule for "there is a hook here" (`find_hook`): the file must be
 * EXECUTABLE, not merely present — git skips a non-executable hook and commits.
 * Windows has no executable bit and git's compat `access()` drops `X_OK`
 * there, so on win32 presence is the whole test. `mode === null` is "no such
 * file, or not a file at all".
 */
export function executableHook(mode: number | null, platform: string = process.platform): boolean {
  if (mode === null) return false;
  if (platform === 'win32') return true;
  return (mode & 0o111) !== 0;
}

/** Which commit hooks this repository defines (`core.hooksPath` aware). */
async function presentCommitHooks(cwd: string): Promise<string[]> {
  const hooks = (await run(cwd, ['rev-parse', '--git-path', 'hooks']).catch(() => '')).trim();
  if (!hooks) return [];
  const root = resolve(cwd, hooks);
  const present: string[] = [];
  for (const name of COMMIT_HOOKS) {
    const info = await stat(join(root, name)).catch(() => null);
    if (executableHook(info?.isFile() ? info.mode : null)) present.push(name);
  }
  return present;
}

/**
 * Probed once per process with a hook name that cannot exist, so the probe
 * itself runs nothing. ONLY a definitive answer is cached: an unrelated failure
 * throws and is probed again on the next call, because "the probe broke" may
 * never be read as "this repository has no hooks".
 */
export interface HookRunnerCache {
  value: Promise<boolean> | null;
}

export function cacheHookRunnerSupport(
  probe: () => Promise<unknown>,
  cache: HookRunnerCache,
): Promise<boolean> {
  cache.value ??= probe().then(() => true, (reason: unknown) => {
    const detail = (reason instanceof Error ? reason.message : String(reason)).trim();
    if (missingHookRunner(detail)) return false;
    // A broken probe is not an answer: forget it so the next call asks again.
    cache.value = null;
    throw new Error(`Could not check whether Git can run commit hooks: ${detail}`);
  });
  return cache.value;
}

/**
 * Process-wide, and exported ONLY so a test can forget the answer: the probe
 * is a real `git hook run`, and an ordering test has to be able to make it run
 * again instead of reading a cache some earlier commit filled in.
 */
export const hookRunnerSupport: HookRunnerCache = { value: null };

function hookRunnerAvailable(cwd: string): Promise<boolean> {
  return cacheHookRunnerSupport(
    () => run(cwd, ['hook', 'run', '--ignore-missing', 'mixdog-hook-probe']),
    hookRunnerSupport,
  );
}

/**
 * One hook, against the SCRATCH index: a hook that stages (`git add`) writes
 * the commit we are building, never the user's index — exactly what git does
 * for its own partial commits.
 */
async function runCommitHook(
  cwd: string,
  indexFile: string,
  hooks: boolean,
  name: string,
  args: string[] = [],
  advisory = false,
): Promise<void> {
  if (!hooks) return;
  try {
    await run(cwd, [
      'hook', 'run', '--ignore-missing', name, ...(args.length ? ['--', ...args] : []),
    ], indexFile);
  } catch (reason) {
    // git ignores post-commit's exit status; every other hook is a veto.
    if (advisory) return;
    const detail = (reason instanceof Error ? reason.message : String(reason)).trim();
    throw new Error(`The ${name} hook refused this commit${detail ? `:\n${detail}` : '.'}`);
  }
}

/**
 * The message hooks git runs for `commit -m`, through the file git uses
 * (`<git dir>/COMMIT_EDITMSG`) so a hook that rewrites $1 is honoured.
 */
async function messageThroughHooks(
  cwd: string,
  repository: RepositoryIdentity,
  indexFile: string,
  hooks: boolean,
  message: string,
): Promise<string> {
  if (!hooks) return message;
  const messagePath = join(repository.gitDir, 'COMMIT_EDITMSG');
  await writeFile(messagePath, message.endsWith('\n') ? message : `${message}\n`, 'utf8');
  await runCommitHook(cwd, indexFile, hooks, 'prepare-commit-msg', [messagePath, 'message']);
  await runCommitHook(cwd, indexFile, hooks, 'commit-msg', [messagePath]);
  return readFile(messagePath, 'utf8');
}

/** The cleanup modes `git commit` accepts. Anything else is fatal, as in git. */
const CLEANUP_MODES = new Set(['strip', 'whitespace', 'verbatim', 'scissors', 'default']);

/**
 * `commit.cleanup`, read the way git reads it. `git config --get` spends exit
 * code 1 on "not set" and every other non-zero code on a config it could not
 * read, so only the first may become a default. An unknown mode is REFUSED in
 * git's own words: swallowing it would silently apply `whitespace` cleanup to a
 * repository that asked for something else, on a commit native git will not
 * make at all.
 */
async function commitCleanupMode(cwd: string): Promise<string> {
  const probe = await runWithStatus(cwd, ['config', '--get', 'commit.cleanup']);
  if (probe.code === 1) return 'default';
  if (probe.code !== 0) {
    const detail = probe.stderr || `git exited with code ${probe.code}`;
    throw new Error(`Could not read commit.cleanup: ${detail}`);
  }
  const mode = probe.stdout.trim();
  if (!mode) return 'default';
  if (!CLEANUP_MODES.has(mode)) throw new Error(`fatal: Invalid cleanup mode ${mode}`);
  return mode;
}

/**
 * `git commit -m` cleanup, replicated: with no editor the default mode is
 * whitespace-only, so comment lines are KEPT. `strip` is the one mode that
 * removes them, and `git stripspace --strip-comments` reads this repository's
 * `core.commentChar` itself, so the comment character never has to be guessed.
 * The message arrives UNTRIMMED, for the reason git never trims one either:
 * only the cleanup mode may change it, and `verbatim` may not change it at all.
 */
function cleanCommitMessage(cwd: string, mode: string, raw: string): Promise<string> {
  if (mode === 'verbatim') return Promise.resolve(raw.endsWith('\n') ? raw : `${raw}\n`);
  return runWithInput(cwd, mode === 'strip'
    ? ['stripspace', '--strip-comments']
    : ['stripspace'], raw);
}

/** The paths a tree changes against HEAD — the commit's real reach. */
async function committedPaths(cwd: string, head: string, tree: string): Promise<string[]> {
  const changed: string[] = [];
  await streamNulRecords(cwd, head
    ? ['diff-tree', '-r', '--name-only', '-z', '--no-commit-id', `${head}^{tree}`, tree]
    : ['ls-tree', '-r', '--name-only', '-z', tree], (record) => {
    if (record) changed.push(record);
  });
  return changed;
}

/** Every entry of the USER's index: path → "<mode> <object> <stage>". */
async function indexSnapshot(toplevel: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  await streamNulRecords(toplevel, ['ls-files', '--stage', '-z'], (record) => {
    const tab = record.indexOf('\t');
    if (tab > 0) entries.set(record.slice(tab + 1), record.slice(0, tab));
  });
  return entries;
}

/** The caller's selection, as repository-root relative path prefixes. */
function selectionPrefixes(
  repository: RepositoryIdentity,
  cwd: string,
  specs: string[],
): string[] {
  return specs.map((spec) =>
    comparablePath(relative(repository.toplevel, resolve(cwd, spec))));
}

function withinSelection(prefixes: string[], path: string): boolean {
  const value = comparablePath(path);
  return prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

/**
 * The contract, enforced on the finished tree: a commit may only carry paths
 * the caller selected. A hook that stages something else (`git add -u`) is
 * refused here, BEFORE any commit object is referenced by a ref.
 */
function assertWithinSelection(prefixes: string[], changed: string[]): void {
  const outside = changed.filter((path) => !withinSelection(prefixes, path));
  if (!outside.length) return;
  throw new Error([
    `A commit hook staged ${outside.slice(0, 10).join(', ')}, which was not selected`,
    '. Nothing was committed.',
  ].join(''));
}

/**
 * `GIT_INDEX_FILE` isolates a hook; it does not sandbox one. A hook can unset
 * it and write the real index, and nothing can prevent that — so it is
 * DETECTED: the user's entries are compared around the hooks, and a change
 * outside the selection refuses the commit while no commit object exists yet.
 */
function assertHooksLeftIndexAlone(
  prefixes: string[],
  before: Map<string, string>,
  after: Map<string, string>,
): void {
  const touched = new Set<string>();
  for (const [path, entry] of after) if (before.get(path) !== entry) touched.add(path);
  for (const path of before.keys()) if (!after.has(path)) touched.add(path);
  const outside = [...touched].filter((path) => !withinSelection(prefixes, path));
  if (!outside.length) return;
  throw new Error([
    `A commit hook changed the staged entry for ${outside.slice(0, 10).join(', ')}`,
    ', which was not selected. Nothing was committed; review the index before retrying.',
  ].join(''));
}

/**
 * A path as a shell WORD the user can paste back: `:(literal)` keeps git from
 * reading a name like `cache[1].txt` or `:(glob)*` as a PATTERN — a suggestion
 * that widened the reset would undo work the commit never touched — and the
 * quoting keeps the shell from splitting or expanding it.
 */
function shellArgument(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** The commit landed, the index did not follow — with a recovery that is safe. */
function refreshFailure(commit: string, paths: string[], detail: string): Error {
  const short = commit.slice(0, 7);
  const listed = paths.slice(0, 10);
  // Scoped to the committed paths: a bare `git reset <commit>` would rewrite
  // the WHOLE index and throw away unrelated staged work.
  const recovery = listed.map((path) => shellArgument(literalPathspec(path))).join(' ');
  return new Error([
    `Commit ${short} was created, but the index entries for `,
    `${listed.join(', ')} could not be refreshed: ${detail}`,
    `. Run "git reset ${short} -- ${recovery}" to finish it`,
    paths.length > 10 ? ', then the remaining paths the same way.' : '.',
  ].join(''));
}

/** Somebody staged a committed path underneath us; we kept our hands off it. */
function stagedUnderneathError(commit: string, moved: string[]): Error {
  return new Error([
    `Commit ${commit.slice(0, 7)} was created. ${moved.slice(0, 10).join(', ')} was staged `,
    'again while it was being committed, so that entry was left exactly as it is — nothing ',
    'staged has been overwritten. Refresh Source Control to see the current state.',
  ].join(''));
}

/**
 * A lock that is already there is either a live git process or the wreckage of
 * one that was killed mid-publish. Neither is ours to remove — but both have to
 * be said in words the user can ACT on: which file is in the way, and what to
 * do about it.
 */
function indexLockPresentError(lockPath: string): Error {
  return new Error([
    'Another Git process is using this repository, or an earlier one was interrupted: ',
    `"${lockPath}" already exists. Nothing was committed — wait for that process to finish`,
    `, or, if no Git process is running, delete "${lockPath}" and commit again.`,
  ].join(''));
}

/**
 * A lock we could not even LOOK at. "Absent" is a claim about the filesystem,
 * and EACCES/EIO/ELOOP say nothing of the kind — carrying on there would run
 * the capability probe (a real `git hook run`) and move HEAD on top of a lock
 * that may well be held.
 */
function indexLockUnknownError(lockPath: string, reason: unknown): Error {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return new Error([
    `Git's index lock "${lockPath}" could not be checked, so another Git process using this `,
    `repository cannot be ruled out: ${detail}`,
    '. Nothing was committed — restore access to that file, then commit again.',
  ].join(''));
}

/**
 * The lock is discovered BEFORE anything moves: a hook has not run, no commit
 * object exists and HEAD is where it was, so the commit can simply be retried.
 * Found later — during the refresh — the commit would already be on the branch
 * and the repair we print (`git reset <commit> -- <paths>`) could not even run
 * until this same file was removed by hand.
 *
 * Three answers, never two: ENOENT/ENOTDIR is the only "there is no lock"
 * (the file, or a directory on the way to it, definitively does not exist),
 * a successful probe is "held", and EVERY other error is "cannot determine",
 * which fails closed. `lstat` and not `stat`: git creates this file with
 * O_CREAT|O_EXCL, which a DANGLING SYMLINK named `index.lock` also refuses —
 * following the link would report "no lock" for a file git cannot create.
 *
 * `probe` exists so a test can present a state that cannot be determined;
 * production always uses `lstat`.
 */
export async function assertIndexLockFree(
  gitDir: string,
  probe: (path: string) => Promise<unknown> = lstat,
): Promise<void> {
  const lockPath = join(gitDir, 'index.lock');
  try {
    await probe(lockPath);
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException)?.code ?? '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw indexLockUnknownError(lockPath, reason);
  }
  throw indexLockPresentError(lockPath);
}

/**
 * Test seams, awaited INSIDE the refresh's critical section. Production never
 * sets them; a test uses them to run a real second git process in exactly the
 * window a lost update would need, and prove that git meets the lock instead
 * of interleaving.
 *
 * `beforeIndexRead` runs once the lock is HELD and before the index is read —
 * the ordering the whole compare-then-write rests on: a writer that reaches
 * the index there would be one the comparison could never see.
 * `betweenReadAndReplace` runs after the index was read and before it is
 * replaced.
 *
 * `beforePublishMode` runs once the lock is HELD and before the mode the index
 * must be published with is worked out — the ordering issue (2): a mode read
 * before the lock can be a mode the index no longer has.
 */
export const commitRefreshProbe: {
  beforePublishMode?: () => Promise<void>;
  beforeIndexRead?: () => Promise<void>;
  betweenReadAndReplace?: () => Promise<void>;
} = {};

const INDEX_REPLACE_ATTEMPTS = 5;

/** The part of `FileHandle` publishing needs; a test can stand it in. */
export interface IndexLockFile {
  write(buffer: Buffer, offset: number, length: number, position: number):
    Promise<{ bytesWritten: number }>;
  truncate(length: number): Promise<void>;
  stat(): Promise<{ size: number }>;
  sync(): Promise<void>;
}

/**
 * The lock file IS the next index, so it has to receive EVERY byte. `write()`
 * may write fewer bytes than it was asked to (a signal, a full disk, a pipe-ish
 * filesystem), and a short write that is then truncated and renamed replaces a
 * good index with a truncated one — atomically, which is the worst kind.
 *
 * So: write until the buffer is exhausted, refuse a write that makes no
 * progress, and read the published SIZE back before anything is renamed. The
 * fsync is not swallowed either — an I/O error here means the bytes are not on
 * disk, and publishing them would be a lie.
 */
export async function writeIndexBytes(handle: IndexLockFile, data: Buffer): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const { bytesWritten } = await handle.write(data, written, data.length - written, written);
    if (!(bytesWritten > 0)) {
      throw new Error(`the index could not be written (${written} of ${data.length} bytes)`);
    }
    written += bytesWritten;
  }
  // The lock was created empty, so this can only ever drop a tail some earlier
  // write left behind — never a byte of what was just written.
  await handle.truncate(data.length);
  const { size } = await handle.stat();
  if (size !== data.length) {
    throw new Error(`the index is ${size} bytes where ${data.length} were expected`);
  }
  await handle.sync();
}

/**
 * A rename is only durable once the DIRECTORY entry itself is on disk: without
 * this, a power loss after the fsync'd content was published can still bring
 * back the old index — or an empty one. Windows has no directory fsync and no
 * way to open a directory as a file, so there it is a no-op.
 *
 * KNOWN RESIDUAL (win32): because that fsync cannot be issued there, the
 * rename that publishes the index is durable only once the filesystem flushes
 * its own metadata. A power loss inside that window can still bring back the
 * previous index — the commit itself is safe (it is on the branch and in the
 * object store), and the repair is the same `git reset <commit> -- <paths>`
 * the refresh failure already prints.
 */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close().catch(() => {});
  }
}

/** git's own `PERM_GROUP` / `PERM_EVERYBODY` tweaks (path.c). */
const SHARED_GROUP = 0o660;
const SHARED_EVERYBODY = 0o664;
/** git's `PERM_UMASK`: leave the mode exactly as it is. */
const PERM_UMASK = 0;
/** The historical `0`/`1`/`2` spellings git still accepts. */
const OLD_PERM_GROUP = 1;
const OLD_PERM_EVERYBODY = 2;

/**
 * git's `die(_("bad boolean config value '%s' for '%s'"))`, verbatim — with
 * git's OWN spelling of the key. This die is reached through the config
 * machinery (`git_config_bool(var, value)`), which is handed the name the
 * parser has already lowercased, so native git prints `core.sharedrepository`
 * here and never the camelCase the config file was written in. Checked
 * against git 2.51: `fatal: bad boolean config value 'garbage' for
 * 'core.sharedrepository'`.
 */
function badSharedRepositoryBoolean(value: string): Error {
  return new Error(`fatal: bad boolean config value '${value}' for 'core.sharedrepository'`);
}

/**
 * C `strtol(value, &end, 8)`: leading blanks, an optional sign, octal digits.
 * `rest` is what `end` points at — empty means the WHOLE value was a number,
 * which is the test git makes before it decides the value is a boolean. A
 * value with no digits at all leaves `rest` as the untouched input, exactly as
 * C leaves `end == nptr`, so `""` parses as 0 with nothing left over.
 */
function strtolOctal(value: string): { value: number; rest: string } {
  const match = /^[ \t\n\r\f\v]*([+-]?)([0-7]+)/.exec(value);
  if (!match) return { value: 0, rest: value };
  const magnitude = Number.parseInt(match[2], 8);
  return {
    value: match[1] === '-' ? -magnitude : magnitude,
    rest: value.slice(match[0].length),
  };
}

/** git's `git_parse_int`: C base-0 digits with git's k/m/g unit suffix. */
function parseConfigInt(value: string): number | null {
  const match = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)\s*$/.exec(value);
  if (!match) return null;
  const digits = match[2];
  const magnitude = /^0[xX]/.test(digits)
    ? Number.parseInt(digits.slice(2), 16)
    : /^0[0-7]+$/.test(digits) ? Number.parseInt(digits, 8) : Number.parseInt(digits, 10);
  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[3].toLowerCase()] ?? 1;
  return (match[1] === '-' ? -magnitude : magnitude) * unit;
}

/**
 * git's `git_parse_maybe_bool`: the spellings are matched case-INSENSITIVELY
 * (`strcasecmp`), an empty value is false, and anything else that parses as a
 * number is true when non-zero. `null` is git's -1: not a boolean at all.
 */
function parseMaybeBool(value: string): boolean | null {
  const text = value.toLowerCase();
  if (text === '') return false;
  if (['true', 'yes', 'on'].includes(text)) return true;
  if (['false', 'no', 'off'].includes(text)) return false;
  const number = parseConfigInt(value);
  return number === null ? null : number !== 0;
}

/**
 * `core.sharedRepository` decoded as git's `git_config_perm` (path.c) decodes
 * it — the raw config value in, git's `shared_repository` out (negative for an
 * explicit filemode, which is SET rather than OR'd):
 *
 *   null (the BARE key, git's `value == NULL`) → PERM_GROUP;
 *   "umask"/"group"/"all"/"world"/"everybody"  → matched with `strcmp`, so
 *                                                CASE-SENSITIVELY: "Group" is
 *                                                not this branch;
 *   a value strtol(…, 8) consumes ENTIRELY     → 0 → umask, 1 → group,
 *                                                2 → everybody, anything else
 *                                                a filemode, zero padding and
 *                                                all ("000640" is 0640);
 *   anything left over after the octal parse   → git's BOOLEAN reading:
 *                                                true-ish → group, false-ish →
 *                                                umask, and a value that is no
 *                                                boolean is git's fatal error
 *                                                rather than a silent
 *                                                "unchanged" ("9" is not octal,
 *                                                but it IS a non-zero number,
 *                                                so git shares by group).
 *
 * An explicit filemode that does not keep the owner's read AND write is git's
 * own fatal config error, refused here the same way.
 */
export function sharedRepositoryPerm(shared: string | null): number {
  if (shared === null) return SHARED_GROUP;
  if (shared === 'umask') return PERM_UMASK;
  if (shared === 'group') return SHARED_GROUP;
  if (['all', 'world', 'everybody'].includes(shared)) return SHARED_EVERYBODY;
  const octal = strtolOctal(shared);
  if (octal.rest !== '') {
    const bool = parseMaybeBool(shared);
    if (bool === null) throw badSharedRepositoryBoolean(shared);
    return bool ? SHARED_GROUP : PERM_UMASK;
  }
  if (octal.value === PERM_UMASK) return PERM_UMASK;
  if (octal.value === OLD_PERM_GROUP) return SHARED_GROUP;
  if (octal.value === OLD_PERM_EVERYBODY) return SHARED_EVERYBODY;
  if ((octal.value & 0o600) !== 0o600) {
    // The other spelling, and deliberately so: this die is a LITERAL string in
    // git's path.c rather than a message about a parsed config key, so native
    // git prints it camelCase — checked against git 2.51, which answers
    // `fatal: problem with core.sharedRepository filemode value (0400).`. The
    // value is formatted git's way too (`0%.3o`): `044` prints as `0044`.
    throw new Error([
      'fatal: problem with core.sharedRepository filemode value ',
      `(0${(octal.value & 0o7777).toString(8).padStart(3, '0')}).\n`,
      'The owner of files must always have read and write permissions.',
    ].join(''));
  }
  // Others can never get a write bit out of an explicit filemode.
  return -(octal.value & 0o666);
}

/**
 * `core.sharedRepository` folded onto a file mode — git's own
 * `calc_shared_perm` (path.c), rule for rule, on the value `sharedRepositoryPerm`
 * decoded:
 *
 *   unset / umask / false / off / no / 0 → the mode is left exactly as it is;
 *   BARE key (`null`) / group / true /
 *   on / yes / 1                         → tweak 0660, OR'd on: the owner's
 *                                          read/write is mirrored into the
 *                                          group, nothing is taken away;
 *   all / world / everybody / 2          → tweak 0664, OR'd on: additionally a
 *                                          world READ, never a world write;
 *   explicit octal (0640, 000640, …)     → tweak (value & 0666), SET rather
 *                                          than OR'd — `mode = (mode & ~0777)
 *                                          | tweak` — so `0640` on a 0666
 *                                          index RESTRICTS it to 0640 instead
 *                                          of leaving it world-readable.
 *
 * Two adjustments then apply to every tweak, exactly as git makes them: a file
 * the owner cannot write hands nobody else a write bit (`tweak &= ~0222`), and
 * a file the owner can execute propagates execute wherever the tweak grants
 * read (`tweak |= (tweak & 0444) >> 2`).
 */
export function sharedRepositoryMode(mode: number, shared: string | null): number {
  const perm = sharedRepositoryPerm(shared);
  if (perm === PERM_UMASK) return mode;
  const forced = perm < 0;
  let tweak = forced ? -perm : perm;
  if (!(mode & 0o200)) tweak &= ~0o222;
  if (mode & 0o100) tweak |= (tweak & 0o444) >> 2;
  return forced ? (mode & ~0o777) | tweak : mode | tweak;
}

/**
 * `core.sharedRepository` exactly as git's config parser hands it to
 * `git_config_perm`: the last value set, `null` for the BARE form (a key
 * written with no `=`, which git reads as an implicit true — GROUP sharing,
 * not "unset"), and `undefined` when the key is not set at all.
 *
 * `--get` prints an empty line for BOTH the bare form and `key = `, and those
 * mean OPPOSITE things, so the boolean reading is what tells them apart:
 * `--bool` answers "true" for the bare key and "false" for an empty value.
 */
async function sharedRepositoryConfig(toplevel: string): Promise<string | null | undefined> {
  const probe = await runWithStatus(toplevel, ['config', '--get', 'core.sharedRepository']);
  if (probe.code === 1) return undefined;
  if (probe.code !== 0) {
    throw new Error('could not read core.sharedRepository: '
      + (probe.stderr || `git exited with code ${probe.code}`));
  }
  // Only the terminating newline is git's; the value's own bytes are kept.
  const raw = probe.stdout.replace(/\r?\n$/, '');
  if (raw !== '') return raw;
  const bool = await runWithStatus(
    toplevel,
    ['config', '--bool', '--get', 'core.sharedRepository'],
  );
  if (bool.code === 0 && bool.stdout.trim() === 'true') return null;
  if (bool.code === 0 && bool.stdout.trim() === 'false') return '';
  throw new Error('could not read core.sharedRepository: '
    + (bool.stderr || `git exited with code ${bool.code}`));
}

/** The mode to publish with, and the mode it was derived from. */
export interface IndexPublishMode {
  /** The mode the lock must carry, since the rename makes it the index's. */
  mode: number;
  /**
   * The permissions the index being replaced grants TODAY — the base `mode`
   * was computed FROM. It is not a read-back allowance: an index that is
   * already too permissive may not license republishing at that width (see
   * `applyPublishMode`); it is kept because it is the whole reason a
   * mode-emulating mount cannot false-fail — the bits such a mount fabricates
   * are reported for the index too, so they are already inside `mode`.
   */
  existing: number;
}

/**
 * The lock is published BY RENAME, so the lock's permissions become the
 * index's. Node's default (0o666 & umask) would silently strip the group write
 * bit a shared repository needs, so the mode is taken from the index being
 * replaced and adjusted by `core.sharedRepository` — exactly what git's own
 * lock file does. Windows has no POSIX mode to preserve.
 *
 * Nothing here is guessed: "there is no index yet" is the ONLY stat failure
 * that may fall back to a default, and `config --get` spends exit code 1 on
 * "not set" and every other non-zero code on a config it could not read.
 * Reading either fault as "unset" would publish the user's index with
 * permissions nobody chose.
 */
export async function indexPublishMode(
  toplevel: string,
  indexPath: string,
): Promise<IndexPublishMode | null> {
  if (process.platform === 'win32') return null;
  const info = await stat(indexPath).catch((reason: NodeJS.ErrnoException) => {
    if (reason?.code === 'ENOENT' || reason?.code === 'ENOTDIR') return null;
    throw reason;
  });
  const base = info ? info.mode & 0o7777 : 0o666 & ~currentUmask();
  const shared = await sharedRepositoryConfig(toplevel);
  return {
    mode: shared === undefined ? base : sharedRepositoryMode(base, shared),
    existing: base,
  };
}

function currentUmask(): number {
  try {
    return process.umask();
  } catch {
    return 0o022;
  }
}

/** The part of `FileHandle` the publish mode needs; a test can stand it in. */
export interface ModedLockFile {
  chmod(mode: number): Promise<void>;
  stat(): Promise<{ mode: number }>;
}

/**
 * The ONLY chmod failure that may be ignored: a filesystem with no POSIX
 * permission bits at all (ENOSYS/ENOTSUP/EOPNOTSUPP), where there is no mode to
 * get wrong in either direction. EPERM/EACCES/EINVAL/EROFS mean the file KEPT
 * some other mode, so publishing it would install an index with permissions
 * nobody asked for — possibly wider than the repository's own.
 */
export function chmodErrorIsIgnorable(code: string): boolean {
  return ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code);
}

/**
 * Bits the file grants that the required mode does not. A STRICTER mode can
 * only ever refuse access — git itself tightens permissions this way — while a
 * wider one exposes the index to somebody the repository excluded, so only
 * that direction is fatal.
 */
export function modeGrantsMoreThan(actual: number, required: number): boolean {
  return (actual & ~required & 0o7777) !== 0;
}

/**
 * Give the lock the mode the index must be published with, and PROVE it took:
 * the rename makes this mode the index's, so a chmod that failed or was
 * silently ignored must stop the publish instead of loosening the index.
 *
 * The read-back is measured against `mode` and NOTHING else. That single rule
 * is both halves of the problem, because `mode` is derived from the mode the
 * index itself reports:
 *
 *   unset / umask / false   `mode` IS what the index reports, so the synthetic
 *                           bits a mode-emulating mount (CIFS) fabricates are
 *                           already inside it — they are read back on the lock
 *                           because the mount reports them for every file, and
 *                           they pass. A bit beyond `mode` there is a width
 *                           neither the index nor the config ever granted.
 *   group / all / true      `mode` is that same reported mode with git's tweak
 *                           OR'd on, so `mode` can only be WIDER than the
 *                           index: "tolerate what the index already grants"
 *                           never had anything to add here.
 *   explicit filemode       `mode` is SET, so it may be STRICTER than the
 *                           index — that is the entire point of
 *                           `core.sharedRepository = 0640`. Tolerating the
 *                           index's own bits here would publish NEW index
 *                           content at exactly the width the config exists to
 *                           remove (a 0666 index, `0640` asked for, a chmod
 *                           that quietly did nothing), so it is fatal. The
 *                           cost is bounded: the commit is on the branch, the
 *                           refresh reports this and prints the `git reset`
 *                           repair, and the user's index keeps its old mode
 *                           with its OLD content — a width the repository
 *                           already had, not one this publish handed out.
 */
export async function applyPublishMode(
  handle: ModedLockFile,
  mode: number,
): Promise<void> {
  const wanted = (mode & 0o7777).toString(8);
  try {
    await handle.chmod(mode);
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException)?.code ?? '';
    if (!chmodErrorIsIgnorable(code)) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      throw new Error(`the index lock could not be given mode ${wanted}: ${detail}`);
    }
    // No permission bits on this filesystem: nothing to publish incorrectly.
    return;
  }
  const actual = (await handle.stat()).mode;
  if (modeGrantsMoreThan(actual, mode)) {
    throw new Error(
      `the index lock kept mode ${(actual & 0o7777).toString(8)} where ${wanted} was required`,
    );
  }
}

/**
 * Publish: `.git/index.lock` becomes `.git/index` in ONE rename, which both
 * installs the new index and releases the lock — git's own protocol. A reader
 * sees the old file or the new one, never a half-written one.
 */
async function replaceIndex(lockPath: string, indexPath: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(lockPath, indexPath);
      return;
    } catch (reason) {
      const code = (reason as NodeJS.ErrnoException)?.code ?? '';
      const busy = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      // Windows can refuse to replace a file another reader still holds open.
      // The lock stays ours until the rename lands, so retrying is safe.
      if (!busy || attempt >= INDEX_REPLACE_ATTEMPTS) throw reason;
      await new Promise((wait) => setTimeout(wait, 50 * attempt));
    }
  }
}

/**
 * The ONE write to the user's index, and only once the commit is on the branch:
 * the committed paths are set to what the commit recorded, exactly as `git
 * commit -- <paths>` left them, and every other entry keeps its staged content.
 *
 * Compare-then-write is a race unless nobody else may write in between, so the
 * whole step runs inside git's OWN lock, taken git's own way:
 *
 *   1. create `.git/index.lock` with O_CREAT|O_EXCL — the file's existence IS
 *      the lock, so every other git process now fails fast ("Unable to create
 *      '<repo>/.git/index.lock': File exists") instead of interleaving;
 *   2. work out the mode the index must be published with — UNDER the lock,
 *      because the rename installs it and a mode read earlier can belong to an
 *      index a competing writer has since replaced with a stricter one;
 *   3. read the index (`ls-files --stage`, a pure read) and compare it with the
 *      state the commit was built from;
 *   4. copy the index into the scratch directory and apply the refresh to the
 *      COPY through GIT_INDEX_FILE, so the repository's index is still the one
 *      we compared and git's own `reset` locks the copy, not this repository;
 *   5. write the copy into the lock file we hold and rename it onto
 *      `.git/index` — a single atomic replace that publishes the new index and
 *      releases the lock together;
 *   6. on any failure, delete the lock file we created (and only that one).
 *
 * Read and publish therefore sit inside one exclusive window: no writer can
 * land between them, so nothing staged can be observed and then overwritten.
 *
 * A path is refreshed only while its entry still is what it was when the commit
 * was built. Anything staged underneath us since (a hook that unset
 * GIT_INDEX_FILE, another process) is LEFT ALONE and reported: overwriting it
 * would silently demote someone else's staged content to an unstaged change.
 */
async function refreshCommittedPaths(
  repository: RepositoryIdentity,
  scratch: string,
  commit: string,
  changed: string[],
  committedFrom: Map<string, string>,
): Promise<void> {
  const indexPath = join(repository.gitDir, 'index');
  const lockPath = join(repository.gitDir, 'index.lock');
  let handle: FileHandle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException)?.code;
    const failure = reason instanceof Error ? reason.message : String(reason);
    throw refreshFailure(commit, changed, code === 'EEXIST'
      // Somebody else's lock: it is left exactly where it is.
      ? `another Git process took "${lockPath}" while this commit was being made`
        + '; wait for it to finish, or delete that file if no Git process is running'
      : `${lockPath} could not be created: ${failure}`);
  }
  let published = false;
  let closed = false;
  let moved: string[] = [];
  try {
    // Decided with the lock HELD: read before it, a writer that replaces the
    // index with a STRICTER one between the stat and the `open('wx')` would be
    // republished by our own rename with the older, wider permissions. A mode
    // that cannot be worked out is NOT a licence to publish the default one.
    await commitRefreshProbe.beforePublishMode?.();
    let publish: IndexPublishMode | null;
    try {
      publish = await indexPublishMode(repository.toplevel, indexPath);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      throw refreshFailure(
        commit,
        changed,
        `the permissions the index must be published with are unknown: ${detail}`,
      );
    }
    if (publish !== null) {
      // The rename makes this mode the index's, so a mode that did not take is
      // a failed publish, never a tolerated one.
      try {
        await applyPublishMode(handle, publish.mode);
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        throw refreshFailure(commit, changed, detail);
      }
    }
    // The lock is HELD from here on, so nothing can reach the index between
    // this read and the replace below.
    await commitRefreshProbe.beforeIndexRead?.();
    const current = await indexSnapshot(repository.toplevel);
    moved = changed.filter((path) =>
      (current.get(path) ?? '') !== (committedFrom.get(path) ?? ''));
    const refreshable = changed.filter((path) => !moved.includes(path));
    if (refreshable.length) {
      try {
        const staging = join(scratch, 'refresh.index');
        await copyFile(indexPath, staging).catch((reason: NodeJS.ErrnoException) => {
          // A repository with no index file yet simply starts from an empty one.
          if (reason?.code !== 'ENOENT') throw reason;
        });
        // `changed` is repository-root relative, so this runs at the root.
        await run(repository.toplevel, [
          'reset', '--quiet', commit, '--', ...refreshable.map(literalPathspec),
        ], staging);
        await commitRefreshProbe.betweenReadAndReplace?.();
        const updated = await readFile(staging);
        // Every byte, verified, and on disk — before anything is published.
        await writeIndexBytes(handle, updated);
        await handle.close();
        closed = true;
        await replaceIndex(lockPath, indexPath);
        published = true;
        // The rename is only durable once the directory entry is on disk too.
        await syncDirectory(repository.gitDir);
      } catch (reason) {
        throw refreshFailure(
          commit,
          refreshable,
          indexLockContention(repository.gitDir, reason).message,
        );
      }
    }
  } finally {
    if (!closed) await handle.close().catch(() => {});
    // Only ever the lock this call created: after the rename there is nothing
    // of ours left, and a lock we never took belongs to somebody else.
    if (!published) await rm(lockPath, { force: true }).catch(() => {});
  }
  if (moved.length) throw stagedUnderneathError(commit, moved);
}

/** A ref that moved underneath the commit, in words the dock can act on. */
function refMovedError(reason: unknown): Error {
  const failure = reason instanceof Error ? reason : new Error(String(reason));
  if (/but expected|reference already exists/i.test(failure.message)) {
    return new Error([
      'Another commit landed on this branch while this one was being prepared',
      '. Nothing was committed — refresh Source Control and commit again.',
    ].join(''));
  }
  if (/cannot lock ref|unable to (?:update|lock) ref/i.test(failure.message)) {
    return new Error([
      'Another Git process is updating this branch right now',
      '. Nothing was committed — wait for it to finish, then commit again.',
    ].join(''));
  }
  return failure;
}

// A killed process never runs `finally`, so every call sweeps what earlier ones
// could not: scratch directories named for a process that is gone. The owning
// pid is part of the name from the moment the directory exists, so liveness —
// and ONLY liveness — decides for a named directory. There is no age override:
// a commit parked in a slow filter or a hook for a day is still a commit, and
// pulling its index away would break it. What that leaves behind, at worst, is
// one directory in the OS temp folder owned by a recycled pid.
const SCRATCH_PREFIX = 'mixdog-commit-';
const SCRATCH_GRACE_MS = 60 * 60 * 1000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (reason) {
    // EPERM: the pid exists, it just is not ours to signal.
    return (reason as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

async function sweepScratchIndexes(): Promise<void> {
  const root = tmpdir();
  const names = await readdir(root).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const directory = join(root, name);
    const info = await stat(directory).catch(() => null);
    if (!info) continue;
    const owner = Number.parseInt(name.slice(SCRATCH_PREFIX.length).split('-')[0] ?? '', 10);
    const named = Number.isInteger(owner) && owner > 0;
    // A named directory belongs to a process: gone means nobody is using it.
    // An unnamed one (an older build, a foreign copy) only ages out.
    const orphaned = named ? !processAlive(owner) : now - info.mtimeMs > SCRATCH_GRACE_MS;
    if (!orphaned) continue;
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function commitThroughScratchIndex(
  cwd: string,
  repository: RepositoryIdentity,
  message: string,
  specs: string[],
  addable: string[],
): Promise<string> {
  // Config git validates before it runs anything, validated before we do too:
  // an unusable `commit.cleanup` must not cost a hook run.
  const cleanup = await commitCleanupMode(cwd);
  // Before a hook runs and before HEAD moves: a lock found only at the refresh
  // would leave a commit on the branch whose repair could not run.
  //
  // This sits ABOVE the hook-runner probe on purpose: the probe is itself a
  // `git hook run`, so a repository that defines a hook by the probe's name
  // would have that hook EXECUTED. Nothing of the user's may run until every
  // pre-flight rejection has passed.
  await assertIndexLockFree(repository.gitDir);
  // Hooks decide this commit, so their availability is settled before anything
  // is built — and a git that cannot run them says so instead of skipping them.
  const hooks = await hookRunnerAvailable(cwd);
  const present = await presentCommitHooks(cwd);
  if (!hooks) assertCommitHooksRunnable(hooks, present);
  // Only a repository that defines a hook running BEFORE the commit is watched
  // for index writes. Without one, an entry that changes while we work belongs
  // to somebody else — another window, a terminal — and is none of our
  // business; with one, an unattributable change is refused rather than
  // committed over. (`post-commit` runs after the ref moves and is covered by
  // the refresh guard instead.)
  const watched = hooks && present.some((name) => name !== 'post-commit');
  const head = (await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    .catch(() => '')).trim();
  const prefixes = selectionPrefixes(repository, cwd, specs);
  // The state we commit FROM, and the only honest baseline for the refresh:
  // anything staged for a selected path after this point — by a hook that
  // unset GIT_INDEX_FILE, by another window — is somebody else's work and must
  // survive the refresh instead of being demoted to an unstaged change.
  const indexBefore = await indexSnapshot(repository.toplevel);
  await sweepScratchIndexes().catch(() => {});
  const scratch = await mkdtemp(join(tmpdir(), `${SCRATCH_PREFIX}${process.pid}-`));
  // Outside the repository, and named for its owner: the lock git takes on it
  // is `commit.index.lock`, never the repository's `index.lock`.
  const indexFile = join(scratch, 'commit.index');
  try {
    await run(cwd, head ? ['read-tree', head] : ['read-tree', '--empty'], indexFile);
    if (addable.length) {
      // `--all` so a selected path deleted in the worktree records its removal,
      // `--force` so a deliberately selected ignored file is not skipped.
      await run(cwd, [
        'add', '--all', '--force', '--', ...addable.map(literalPathspec),
      ], indexFile);
    }
    await runCommitHook(cwd, indexFile, hooks, 'pre-commit');
    const cleaned = await cleanCommitMessage(
      cwd,
      cleanup,
      await messageThroughHooks(cwd, repository, indexFile, hooks, message),
    );
    const indexAfterHooks = await indexSnapshot(repository.toplevel);
    if (watched) assertHooksLeftIndexAlone(prefixes, indexBefore, indexAfterHooks);
    if (!cleaned.trim()) throw new TypeError('A commit message is required.');
    const tree = (await run(cwd, ['write-tree'], indexFile)).trim();
    const changed = await committedPaths(cwd, head, tree);
    if (!changed.length) {
      throw new Error([
        'Nothing to commit: the selected files already match the last commit',
        '. Refresh Source Control and try again.',
      ].join(''));
    }
    assertWithinSelection(prefixes, changed);
    // `commit-tree` signs only when asked, so `commit.gpgsign` is read here;
    // the key, format and identity stay git's own resolution. `--default`
    // answers "unset", and a MALFORMED value is left to fail exactly as it
    // fails for `git commit` ("bad boolean config value") instead of quietly
    // producing the unsigned commit nobody asked for.
    const signed = (await run(cwd, [
      'config', '--bool', '--default', 'false', '--get', 'commit.gpgsign',
    ])).trim() === 'true';
    const commit = (await runWithInput(cwd, [
      'commit-tree', tree, ...(signed ? ['-S'] : []), ...(head ? ['-p', head] : []),
    ], cleaned, indexFile)).trim();
    const subject = (cleaned.split('\n', 1)[0] ?? '').trim();
    // Updating HEAD (a symref) moves the branch and writes BOTH reflogs, in
    // git's own grammar. The old value is a compare-and-swap: a commit that
    // landed underneath us aborts instead of being overwritten, and `''`
    // demands that an unborn branch still be unborn.
    try {
      await run(cwd, [
        'update-ref',
        '-m', `commit${head ? '' : ' (initial)'}: ${subject}`,
        'HEAD', commit, head,
      ]);
    } catch (reason) {
      throw refMovedError(reason);
    }
    await runCommitHook(cwd, indexFile, hooks, 'post-commit', [], true);
    await refreshCommittedPaths(repository, scratch, commit, changed, indexBefore);
    const branch = (await run(cwd, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
    return `[${branch || 'detached HEAD'}${head ? '' : ' (root-commit)'} `
      + `${commit.slice(0, 7)}] ${subject}\n`;
  } finally {
    // The scratch index lives in the OS temp directory, so a failed cleanup
    // leaves nothing in the repository — and what a kill leaves behind is
    // swept by the next call.
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export async function gitCommitPaths(
  cwd: string,
  message: string,
  paths: string[],
): Promise<string> {
  // An all-whitespace message is the caller's rejection; anything else goes to
  // git EXACTLY as typed. `git commit -m` trims nothing — `commit.cleanup`
  // decides, and under `verbatim` it decides to change nothing at all.
  const raw = String(message ?? '');
  if (!raw.trim()) throw new TypeError('A commit message is required.');
  // The caller's strings are pathspecs, not display text: no trimming, no
  // separator rewriting — a mutated string could name a different real file.
  const requested = (Array.isArray(paths) ? paths : [])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (!requested.length) throw new TypeError('Select at least one file to commit.');
  for (const path of requested) assertCommitPath(path);
  // Identity, not spelling: a nested cwd or a symlinked path is the same
  // repository and must queue behind the same in-flight sequence.
  const repository = await repositoryIdentity(cwd);
  return withRepositorySequence(
    repository.gitDir,
    () => commitPaths(cwd, repository, raw, requested),
  );
}

async function commitPaths(
  cwd: string,
  repository: RepositoryIdentity,
  message: string,
  requested: string[],
): Promise<string> {
  const status = await gitStatus(cwd);
  if (!status.repository) throw new Error('This folder is not a Git repository.');
  const entries = new Map<string, GitFileEntry>();
  for (const file of status.files) {
    entries.set(file.path, file);
    // Renames are reported as new path + oldPath; accept either form.
    if (file.oldPath) entries.set(file.oldPath, file);
  }

  let candidates: string[] | null = null;
  const selected: { path: string; entry?: GitFileEntry }[] = [];
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  for (const raw of requested) {
    let match = '';
    if (entries.has(raw) || await pathIsInIndex(cwd, raw)) match = raw;
    if (!match) {
      candidates ??= await repositoryPaths(cwd, entries.keys());
      const found = matchRepositoryPath(candidates, raw);
      if (found.length > 1) {
        ambiguous.push(raw);
        continue;
      }
      if (found.length === 1) match = found[0];
    }
    // An ignored file the user selected on purpose is in neither the status
    // nor the index; accept it when it really lives inside this worktree.
    if (!match && await existsInsideWorktree(cwd, raw)) match = raw;
    if (!match) {
      unknown.push(raw);
      continue;
    }
    selected.push({ path: match, entry: entries.get(match) });
  }
  if (unknown.length) {
    throw new Error([
      `Not in this repository: ${unknown.slice(0, 10).join(', ')}`,
      '. Refresh Source Control and try again.',
    ].join(''));
  }
  if (ambiguous.length) {
    throw new Error([
      `More than one file matches ${ambiguous.slice(0, 10).join(', ')}`,
      '. Select it again from Source Control.',
    ].join(''));
  }
  const conflicted = selected
    .filter(({ entry }) => entry?.conflicted)
    .map(({ entry }) => entry?.path ?? '');
  if (conflicted.length) {
    throw new Error([
      `Resolve the conflict in ${conflicted.slice(0, 10).join(', ')}`,
      ' before committing it.',
    ].join(''));
  }
  if (status.operation) {
    throw new Error(
      `A ${status.operation} is in progress. Continue or abort it before committing files.`,
    );
  }

  const specs: string[] = [];
  const include = (path: string): void => {
    if (path && !specs.includes(path)) specs.push(path);
  };
  for (const { path, entry } of selected) {
    include(entry ? entry.path : path);
    // A rename is one change: commit both halves whichever form was passed,
    // otherwise the old path's deletion would be left staged behind.
    if (entry?.oldPath) include(entry.oldPath);
  }
  // What the scratch index can be asked to record: the worktree content of a
  // path that is there, or the removal of one HEAD still carries. A path that
  // is only a staged addition with no file behind it has nothing to record —
  // it is left exactly as it is, as `git commit -- <path>` left it.
  const addable: string[] = [];
  for (const spec of specs) {
    if (await existsInsideWorktree(cwd, spec) || await pathIsInHead(cwd, spec)) {
      addable.push(spec);
      continue;
    }
    if (await pathIsInIndex(cwd, spec)) continue;
    throw new Error([
      `Not in this repository: ${spec}`,
      '. Refresh Source Control and try again.',
    ].join(''));
  }
  return commitThroughScratchIndex(cwd, repository, message, specs, addable);
}

export function gitAmend(cwd: string, message = ''): Promise<string> {
  const trimmed = message.trim();
  return run(cwd, trimmed
    ? ['commit', '--amend', '-m', trimmed]
    : ['commit', '--amend', '--no-edit']);
}

export function gitUndoLastCommit(cwd: string): Promise<string> {
  // VS Code's Undo Last Commit keeps the commit's complete index intact.
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
  // VSCode "publish branch" grammar: a branch without an upstream publishes
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
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/authentication failed|could not read username|terminal prompts disabled|permission denied|publickey/i.test(message)) {
    return new Error('Git authentication is required. Sign in with your Git credential helper and retry.');
  }
  return reason instanceof Error ? reason : new Error(message);
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

const COMMIT_HASH_PATTERN = /^[0-9a-f]{4,64}$/i;
export function requiredCommitHash(value: unknown): string {
  const hash = typeof value === 'string' ? value.trim() : '';
  if (!COMMIT_HASH_PATTERN.test(hash)) throw new TypeError('A commit hash is required.');
  return hash;
}

// ── History context menu ───────────────────
// Every action below moves HEAD, the index or a ref — but GitHub Desktop does
// NOT gate them all alike, so neither do we:
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

/** `git reset` writes different amounts of state; the caller says which. */
export type GitResetMode = 'soft' | 'mixed' | 'hard';

export function requiredGitResetMode(value: unknown): GitResetMode {
  if (value === 'soft' || value === 'mixed' || value === 'hard') return value;
  throw new TypeError('Git reset mode is invalid.');
}

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
 * GitHub Desktop's "Check out commit": a detached HEAD at that commit. Local
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
 * GitHub Desktop splits on the ", " separator and tests each entry for the
 * `tag: ` prefix (app/src/lib/git/log.ts:178-184) precisely because a regex
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
