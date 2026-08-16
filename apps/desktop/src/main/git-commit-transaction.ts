import {
  access,
  copyFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { run, runWithInput, runWithStatus, streamNulRecords } from './git-runner';

interface GitFileEntry {
  path: string;
  oldPath?: string;
  conflicted: boolean;
}

interface GitStatusResult {
  repository: boolean;
  operation: string;
  files: GitFileEntry[];
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

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
    () => run(cwd, ['hook', 'run', '--ignore-missing', 'mixdog-hook-probe'], undefined, true),
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
    ], indexFile, true);
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

export function createGitCommitPaths(
  gitStatus: (cwd: string) => Promise<GitStatusResult>,
) {
async function gitCommitPaths(
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

  return gitCommitPaths;
}
