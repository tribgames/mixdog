/**
 * A project checkout's uncommitted changes and their move into a new managed
 * worktree (manager.mjs createManagedWorktree runs it under the repository
 * lock, before the include entries are copied).
 *
 * One scope everywhere: the WHOLE repository checkout (a Project in a
 * subfolder included) — detection, snapshot, apply and clear all cover every
 * tracked and untracked path of the checkout, because the worktree is a full
 * checkout too. Only an untracked session identity file
 * (<project>/.mixdog/project.id, Mixdog metadata) is left out. Ignored files
 * (dependencies, build output, env files) are never carried: they stay in
 * the project folder.
 *
 * A snapshot is two trees taken through a temporary copy of the index, so
 * the checkout is never touched while it is read: `index` (what is staged)
 * and `tree` (the working tree: tracked changes, deletions and untracked
 * files). The carry, in order:
 *   1. refuse what cannot move faithfully (assertCarryable: an operation in
 *      progress, unmerged entries, dirty submodules, nested repositories,
 *      filtered paths such as Git LFS, untracked files above the size limit);
 *   2. snapshot the project checkout and keep it at a named recovery ref
 *      (refs/mixdog/carry/<id>-<time>: a commit of the working tree whose
 *      first parent is HEAD and whose second parent is the commit of the index);
 *   3. write it into the fresh worktree and verify the worktree snapshots
 *      identically;
 *   4. re-snapshot the project checkout (unchanged since 2, else refuse), then
 *      clear it: `reset --hard` and delete exactly its untracked files; verify
 *      it is clean.
 * A failure restores the project checkout from the snapshot and reports
 * WORKTREE_DIRTY (reason `carry-failed`) with the kept ref. A success
 * returns the ref too: the caller drops it (dropRecoveryRef) only once the
 * whole session move is committed, and restores from it
 * (restoreFromRecoveryRef) if anything after the carry fails.
 *
 * Sessions are kept out by the caller (the project folder is held and must
 * be quiet), but a process outside Mixdog — an editor, a file watcher — can
 * still write between the final comparison and the clear; such a write is
 * not captured.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { worktreeError } from './contract.mjs';
import { firstLine, gitStatusRunner, runGit } from './git.mjs';
import { operationInProgress } from './merge.mjs';

const IDENTITY_PATH = '.mixdog/project.id';
const RECOVERY_REF_PREFIX = 'refs/mixdog/carry/';
/** Untracked files beyond these limits are refused rather than snapshotted. */
export const CARRY_UNTRACKED_MAX_BYTES = 256 * 1024 * 1024;
export const CARRY_UNTRACKED_MAX_FILES = 10_000;
const CHECK_ATTR_CHUNK = 200;
// Recovery commits are Mixdog's own, independent of the user's identity config.
const COMMIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'Mixdog',
  GIT_AUTHOR_EMAIL: 'mixdog@localhost',
  GIT_COMMITTER_NAME: 'Mixdog',
  GIT_COMMITTER_EMAIL: 'mixdog@localhost',
});

function identityPath(projectSubdir) {
  return projectSubdir ? `${projectSubdir}/${IDENTITY_PATH}` : IDENTITY_PATH;
}

/** The identity file's path when it is untracked (left out of every step), else null. */
async function untrackedIdentity(cwd, projectSubdir) {
  const path = identityPath(projectSubdir);
  const tracked = await runGit(cwd, ['ls-files', '-z', '--', `:(literal)${path}`], { readOnly: true });
  return tracked.stdout ? null : path;
}

/**
 * `git status --porcelain=v2 -z` rows: path, untracked, unmerged, submodule.
 * @returns {Array<{ path: string, untracked: boolean, unmerged: boolean, submodule: boolean }>}
 */
function parseStatusV2(raw) {
  const fields = String(raw || '').split('\0');
  const rows = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const kind = field[0];
    if (kind === '?') {
      rows.push({ path: field.slice(2), untracked: true, unmerged: false, submodule: false });
      continue;
    }
    // Leading fields before the path: 1 → 8, 2 → 9 (then the original path), u → 10.
    const lead = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : -1;
    if (lead < 0) continue;
    const parts = field.split(' ');
    rows.push({
      path: parts.slice(lead).join(' '),
      untracked: false,
      unmerged: kind === 'u',
      submodule: String(parts[2] || '').startsWith('S'),
    });
    if (kind === '2') index++;
  }
  return rows;
}

async function statusRows(topLevel, projectSubdir) {
  const status = await runGit(topLevel, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], {
    readOnly: true,
  });
  const identity = await untrackedIdentity(topLevel, projectSubdir);
  return parseStatusV2(status.stdout).filter((row) => !(row.untracked && row.path === identity));
}

/**
 * Uncommitted paths of the whole checkout at `topLevel`: staged, unstaged
 * and untracked (every file); ignored files and an untracked identity file
 * excluded.
 * @returns {Promise<string[]>}
 */
export async function uncommittedChanges(topLevel, projectSubdir = '') {
  return (await statusRows(topLevel, projectSubdir)).map((row) => row.path);
}

/** Untracked (not ignored) files of the checkout, identity file excluded; nested repositories end in "/". */
async function untrackedFiles(topLevel, projectSubdir) {
  const listed = await runGit(topLevel, ['ls-files', '--others', '--exclude-standard', '-z'], { readOnly: true });
  const identity = await untrackedIdentity(topLevel, projectSubdir);
  return listed.stdout.split('\0').filter((path) => path && path !== identity);
}

function carryRefusal(message, details) {
  return worktreeError(
    'WORKTREE_DIRTY',
    `${message} Leave the changes in the project folder instead, or fix this and retry.`,
    details
  );
}

/** Paths among `paths` with a clean/smudge filter (Git LFS and custom filters). */
async function filteredPaths(topLevel, paths) {
  const filtered = [];
  for (let start = 0; start < paths.length; start += CHECK_ATTR_CHUNK) {
    const chunk = paths.slice(start, start + CHECK_ATTR_CHUNK);
    const result = await runGit(topLevel, ['check-attr', '-z', 'filter', '--', ...chunk], { readOnly: true });
    const fields = result.stdout.split('\0');
    for (let index = 0; index + 2 < fields.length; index += 3) {
      if (!['unspecified', 'unset'].includes(fields[index + 2])) filtered.push(fields[index]);
    }
  }
  return filtered;
}

/**
 * WORKTREE_DIRTY (with a `reason`) when the checkout's changes cannot be
 * carried faithfully: a merge, rebase, cherry-pick or revert in progress;
 * unmerged index entries; a submodule with changes; an untracked nested
 * repository; a changed path under a clean/smudge filter (Git LFS); untracked
 * files above CARRY_UNTRACKED_MAX_FILES / CARRY_UNTRACKED_MAX_BYTES.
 */
export async function assertCarryable(topLevel, projectSubdir = '') {
  const operation = await operationInProgress(gitStatusRunner, topLevel);
  if (operation) {
    throw carryRefusal(`A ${operation} is in progress in the project folder; finish or abort it first.`, {
      reason: 'operation-in-progress',
      operation,
    });
  }
  const rows = await statusRows(topLevel, projectSubdir);
  if (rows.some((row) => row.unmerged)) {
    throw carryRefusal('The project folder has unresolved merge conflicts; resolve them first.', {
      reason: 'unmerged-paths',
    });
  }
  const submodules = rows.filter((row) => row.submodule).map((row) => row.path);
  if (submodules.length) {
    throw carryRefusal('Submodules with changes cannot be carried; commit or reset them first.', {
      reason: 'dirty-submodules',
      paths: submodules.slice(0, 50),
    });
  }
  const untracked = await untrackedFiles(topLevel, projectSubdir);
  const nested = untracked.filter((path) => path.endsWith('/'));
  if (nested.length) {
    throw carryRefusal('The project folder has untracked nested repositories, which cannot be carried.', {
      reason: 'nested-repository',
      paths: nested.slice(0, 50),
    });
  }
  if (untracked.length > CARRY_UNTRACKED_MAX_FILES) {
    throw carryRefusal(
      `The project folder has ${untracked.length} untracked files (limit ${CARRY_UNTRACKED_MAX_FILES}); ` +
        'add generated output to .gitignore first.',
      { reason: 'too-large', files: untracked.length, maxFiles: CARRY_UNTRACKED_MAX_FILES }
    );
  }
  let bytes = 0;
  for (const rel of untracked) {
    bytes += (await lstat(join(topLevel, ...rel.split('/'))).catch(() => null))?.size ?? 0;
    if (bytes > CARRY_UNTRACKED_MAX_BYTES) {
      throw carryRefusal(
        `The project folder's untracked files exceed ${Math.round(CARRY_UNTRACKED_MAX_BYTES / 1048576)} MB; ` +
          'add large or generated files to .gitignore first.',
        { reason: 'too-large', maxBytes: CARRY_UNTRACKED_MAX_BYTES }
      );
    }
  }
  const filtered = await filteredPaths(
    topLevel,
    rows.map((row) => row.path)
  );
  if (filtered.length) {
    throw carryRefusal('Changed files use a git filter (such as Git LFS), which a carry cannot reproduce exactly.', {
      reason: 'filtered-paths',
      paths: filtered.slice(0, 50),
    });
  }
}

/** { head, index, tree } of the checkout at `cwd`, read through a temporary index. */
async function snapshot(cwd, projectSubdir) {
  const head = firstLine((await runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout);
  const indexFile = firstLine(
    (await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout
  );
  const temp = `${indexFile}.mixdog-carry-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: temp };
  try {
    if (existsSync(indexFile)) await copyFile(indexFile, temp);
    else await runGit(cwd, ['read-tree', head], { env });
    const index = firstLine((await runGit(cwd, ['write-tree'], { env })).stdout);
    // An untracked identity file is left out; when it is also ignored `add`
    // skips it anyway, and naming an ignored path (even as an exclude) makes
    // `add` refuse.
    const identity = await untrackedIdentity(cwd, projectSubdir);
    const ignored =
      identity &&
      (await runGit(cwd, ['check-ignore', '-q', '--', identity], { env, allowFailure: true })).code === 0;
    const pathspec = identity && !ignored ? ['--', '.', `:(exclude,literal)${identity}`] : ['--', '.'];
    await runGit(cwd, ['add', '--all', ...pathspec], { env });
    const tree = firstLine((await runGit(cwd, ['write-tree'], { env })).stdout);
    return { head, index, tree };
  } finally {
    await rm(temp, { force: true });
    await rm(`${temp}.lock`, { force: true });
  }
}

const sameSnapshot = (left, right) =>
  !!left && !!right && left.head === right.head && left.index === right.index && left.tree === right.tree;

async function keepRecoveryRef(cwd, snap, label) {
  const commit = async (tree, parents, message) =>
    firstLine(
      (
        await runGit(cwd, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message], {
          env: COMMIT_ENV,
        })
      ).stdout
    );
  const indexCommit = await commit(snap.index, [snap.head], `mixdog: staged changes carried into worktree ${label}`);
  const stateCommit = await commit(
    snap.tree,
    [snap.head, indexCommit],
    `mixdog: uncommitted changes (untracked included) carried into worktree ${label}`
  );
  const ref = `${RECOVERY_REF_PREFIX}${label}-${Date.now()}`;
  await runGit(cwd, ['update-ref', '-m', `mixdog: carry into worktree ${label}`, ref, stateCommit]);
  return ref;
}

/** Make the checkout at `cwd` (index and files) exactly `snap`; HEAD stays. */
async function writeSnapshot(cwd, snap, { reset = false } = {}) {
  await runGit(cwd, reset ? ['read-tree', '--reset', '-u', snap.tree] : ['read-tree', '-u', '-m', snap.head, snap.tree]);
  await runGit(cwd, ['read-tree', snap.index]);
  await runGit(cwd, ['update-index', '-q', '--refresh'], { allowFailure: true });
}

/** Restore `snap` into the project checkout; true once it snapshots exactly as `snap`. */
async function restoreSnapshot(topLevel, projectSubdir, snap) {
  let failure = null;
  try {
    await writeSnapshot(topLevel, snap, { reset: true });
  } catch (error) {
    failure = error;
  }
  // A clear that failed before changing anything needs no restore at all.
  if (sameSnapshot(await snapshot(topLevel, projectSubdir).catch(() => null), snap)) return null;
  return failure || new Error('the project folder does not match the snapshot after the restore');
}

/** Tracked files back to HEAD, then exactly `untracked` deleted (and the folders they leave empty). */
async function clearCheckout(topLevel, untracked) {
  await runGit(topLevel, ['reset', '--hard', '--quiet', 'HEAD']);
  const folders = new Set();
  for (const rel of untracked) {
    const path = join(topLevel, ...rel.split('/'));
    await rm(path, { force: true });
    for (let dir = dirname(path); dir.length > topLevel.length && dir.startsWith(topLevel); dir = dirname(dir)) {
      folders.add(dir);
    }
  }
  for (const dir of [...folders].sort((a, b) => b.length - a.length)) {
    await rmdir(dir).catch(() => {});
  }
}

function recoveryHint(ref) {
  return `"git read-tree --reset -u ${ref}" then "git read-tree ${ref}^2" (the staged state)`;
}

/**
 * Move the uncommitted changes of the project checkout at `topLevel` into
 * the fresh worktree at `worktreePath` (a checkout of `baseCommit`).
 * Nothing to move resolves `{ count: 0, recoveryRef: null }` without
 * touching either. On success the recovery ref is kept for the caller.
 * @param {{ topLevel: string, projectSubdir?: string, worktreePath: string, baseCommit: string, label: string }} input
 * @returns {Promise<{ count: number, recoveryRef: string|null }>}
 */
export async function carryUncommittedChanges({ topLevel, projectSubdir = '', worktreePath, baseCommit, label }) {
  const files = await uncommittedChanges(topLevel, projectSubdir);
  if (!files.length) return { count: 0, recoveryRef: null };
  // Checked again right before acting.
  await assertCarryable(topLevel, projectSubdir);
  const snap = await snapshot(topLevel, projectSubdir);
  if (snap.head !== baseCommit) {
    throw carryRefusal('The project folder moved to another commit while the worktree was created.', {
      reason: 'head-moved',
      head: snap.head,
      baseCommit,
    });
  }
  const recoveryRef = await keepRecoveryRef(topLevel, snap, label);
  let touched = false;
  try {
    await writeSnapshot(worktreePath, snap);
    if (!sameSnapshot(await snapshot(worktreePath, projectSubdir), snap)) {
      throw new Error('the worktree does not match the project folder after the changes were applied');
    }
    const untracked = await untrackedFiles(topLevel, projectSubdir);
    if (!sameSnapshot(await snapshot(topLevel, projectSubdir), snap)) {
      throw new Error('the project folder changed while its changes were being moved');
    }
    touched = true;
    await clearCheckout(topLevel, untracked);
    const left = await uncommittedChanges(topLevel, projectSubdir);
    if (left.length) throw new Error(`${left.length} changed path(s) could not be cleared from the project folder`);
  } catch (cause) {
    const restoreError = touched ? await restoreSnapshot(topLevel, projectSubdir, snap) : null;
    const reason = String(cause?.message || cause);
    throw worktreeError(
      'WORKTREE_DIRTY',
      restoreError
        ? `Moving the uncommitted changes into the worktree failed (${reason}) and the project folder could not be ` +
            `restored; recover them in the project folder with ${recoveryHint(recoveryRef)}.`
        : `Moving the uncommitted changes into the worktree failed (${reason}); the project folder still has them ` +
            `(a copy is kept at ${recoveryRef}).`,
      {
        reason: 'carry-failed',
        recoveryRef,
        restored: !restoreError,
        count: files.length,
        cause: reason,
        ...(restoreError ? { restoreError: String(restoreError.message || restoreError) } : {}),
      }
    );
  }
  return { count: files.length, recoveryRef };
}

function assertRecoveryRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(RECOVERY_REF_PREFIX) || ref.includes('..')) {
    throw new TypeError('recoveryRef must be a mixdog carry ref.');
  }
}

/**
 * Put the changes kept at `recoveryRef` back into the project checkout
 * after a carry whose session move failed later. Only a checkout still
 * clean and on the ref's base commit is restored (nothing there can be
 * overwritten); otherwise WORKTREE_DIRTY (reason `carry-restore-refused`)
 * and the ref stays. A restored checkout keeps the ref (dropRecoveryRef).
 */
export async function restoreFromRecoveryRef(topLevel, projectSubdir, recoveryRef) {
  assertRecoveryRef(recoveryRef);
  const rev = async (spec) => firstLine((await runGit(topLevel, ['rev-parse', '--verify', spec])).stdout);
  const snap = {
    head: await rev(`${recoveryRef}^1`),
    index: await rev(`${recoveryRef}^2^{tree}`),
    tree: await rev(`${recoveryRef}^{tree}`),
  };
  const head = await rev('HEAD^{commit}');
  const dirty = await uncommittedChanges(topLevel, projectSubdir);
  if (head !== snap.head || dirty.length) {
    throw worktreeError(
      'WORKTREE_DIRTY',
      `The carried changes could not be put back: the project folder changed meanwhile. Recover them with ${recoveryHint(recoveryRef)}.`,
      { reason: 'carry-restore-refused', recoveryRef, count: dirty.length }
    );
  }
  const failure = await restoreSnapshot(topLevel, projectSubdir, snap);
  if (failure) {
    throw worktreeError(
      'WORKTREE_DIRTY',
      `The carried changes could not be put back (${failure.message || failure}). Recover them with ${recoveryHint(recoveryRef)}.`,
      { reason: 'carry-restore-failed', recoveryRef }
    );
  }
  return { restored: true, recoveryRef };
}

/** Forget a carry's recovery ref once the move it protected is committed. */
export async function dropRecoveryRef(topLevel, recoveryRef) {
  assertRecoveryRef(recoveryRef);
  await runGit(topLevel, ['update-ref', '-d', recoveryRef], { allowFailure: true });
}
