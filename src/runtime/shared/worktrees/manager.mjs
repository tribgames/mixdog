/**
 * Managed git worktrees for Lead sessions.
 *
 * Automatic worktrees are created lazily from the project's current branch
 * on "<branchPrefix><slug>" at managedWorktreePath(). Explicit branch selection
 * reuses its checkout or creates one for that exact branch. Creator retention
 * and additional sessions' durable references protect shared checkouts. Every
 * mutation runs under withRepoLock (in-process git lock keyed by the common
 * git dir + cross-process file lock) and is recorded in the durable registry
 * (registry.mjs) before it touches anything:
 *
 *   creating → ready → deleting → (record removed)
 *        ↘ recovery (rollback in progress / interrupted)
 *
 * Creation is a transaction keyed by txId: a retry returns the same entry, a
 * failure rolls back exactly the resources the ledger proves this
 * transaction made, and an interrupted rollback leaves a `recovery` record
 * that reconcile/remove/retry finish. Deletion keeps a `deleting` record until
 * the checkout, registration, owner lease, git lock and root cleanups are all
 * gone, so a sharing violation yields a retryable partial result.
 *
 * Nothing outside a managed checkout is ever deleted: before any recursive
 * delete the record's path must be managedWorktreePath(repoCommonDir, id)
 * and its `.git` must link back to this repository (WORKTREE_PATH_UNSAFE).
 * A forced removal that drops unmerged commits keeps the branch tip
 * reachable at `refs/mixdog/removed/<id>` (returned as `recoveryRef`/`tip`;
 * `git branch <name> refs/mixdog/removed/<id>` restores it, `git update-ref
 * -d` forgets it).
 *
 * A snapshot (createSnapshotWorktree) is a read-only detached checkout in the
 * same store and registry, bound to no session and removed with the turn
 * that made it (or by the prune / startup reconcile once its holder is gone).
 */
import { existsSync } from 'node:fs';
import {
  assertRecoveryStoresClear,
  recoveryScopes,
  retainedRecoveryScopes,
  validateRecoveryScope,
} from './file-recovery.mjs';
import { lstat, mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  managedWorktreePath,
  managedWorktreeRoot,
  normalizeWorktreeOwner,
  runRootCleanups,
  runRootReleasers,
  WORKTREE_SNAPSHOT_KIND,
  worktreeBranchName,
  worktreeError,
  worktreeRefusal,
} from './contract.mjs';
import {
  assertCarryable,
  carryUncommittedChanges,
  dropRecoveryRef,
  restoreFromRecoveryRef,
  uncommittedChanges,
} from './carry.mjs';
import { freeBytesAt, requiredBytes, trackedCheckoutBytes } from './disk.mjs';
import {
  branchCommit,
  currentBranch,
  firstLine,
  gitStatusRunner,
  inspectRepo,
  isDiskFullError,
  listWorktrees,
  localBranches,
  parseStatusPaths,
  remoteDefaultBranches,
  runGit,
  throwIfAborted,
  validBranchName,
} from './git.mjs';
import {
  applyIncludes,
  coveredByIncludes,
  modifiedIncludeCopies,
  untrackedEnvFiles,
  planIncludes,
  readIncludeEntries,
  removeIncludeLinks,
  restoreIncludeLinks,
} from './include.mjs';
import { linkWorktreeDependencies } from './dependencies.mjs';
import { withRepoLock as withRepoMutationLock } from './lock.mjs';
import { holdWorkspaceActivityAsync } from './activity-gate.mjs';
import { withAdvisoryLocks } from '../../agent/orchestrator/tools/builtin/advisory-lock.mjs';
import { mergeBranchIntoCheckout, operationInProgress } from './merge.mjs';
import { readOwnerLease, removeOwnerLease, sameOwner, writeOwnerLease } from './owner.mjs';
import { canonicalPath, checkoutFolder, isWithin, pathKey, projectSubdirOf, samePath } from './paths.mjs';
import {
  deleteRecord,
  entryView,
  getRecord,
  insertRecord,
  putRecord,
  readRegistry,
  registryPath,
} from './registry.mjs';
import { normalizeWorktreeSettings } from './settings.mjs';
import { slugFromHint, uniqueSlug } from './slug.mjs';

const WORKTREE_ADD_TIMEOUT_MS = 30 * 60_000;
const REMOVE_RETRIES = 6;
const REMOVE_RETRY_DELAY_MS = 150;
// Entries a folder-only removal checks for unrecorded directory links.
const LINK_SCAN_LIMIT = 250_000;
// The session copies the project identity into each managed worktree; it is
// Mixdog metadata, not user data, so it alone never makes a worktree dirty.
const SESSION_PROJECT_ID_PATH = '.mixdog/project.id';
// Changed paths WORKTREE_DIRTY_CHOICE lists for the dialog's preview (the count is exact).
const DIRTY_CHOICE_PREVIEW = 50;

export { registerRootReleaser } from './contract.mjs';

/** The session execution root inside the record's checkout. */
function sessionRootOf(record) {
  return checkoutFolder(record.path, record.projectSubdir);
}

// ---------------------------------------------------------------------------
// Host configuration (settings source, free-space probe); tests override it.

/** pid probe (signal 0); EPERM means the process exists. */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

const DEFAULT_CONFIG = Object.freeze({ settings: null, freeBytes: freeBytesAt, processAlive });
let config = { ...DEFAULT_CONFIG };

/**
 * Override host hooks. `settings`: stored worktree settings object or a
 * function returning it (default: agent config `worktree`). `freeBytes(dir)`:
 * free-space probe. `processAlive(pid)`: lease holder liveness. Returns a
 * restore function.
 * @param {{ settings?: unknown, freeBytes?: (dir: string) => Promise<number>, processAlive?: (pid: number) => boolean }} overrides
 */
export function configureWorktreeManager(overrides = {}) {
  const previous = config;
  config = { ...config, ...overrides };
  return () => {
    config = previous;
  };
}

/** The effective worktree settings (configured source, else the agent config). */
export async function currentWorktreeSettings() {
  if (config.settings !== null && config.settings !== undefined) {
    const stored = typeof config.settings === 'function' ? await config.settings() : config.settings;
    return normalizeWorktreeSettings(stored);
  }
  try {
    const { readSection } = await import('../config.mjs');
    return normalizeWorktreeSettings(readSection('agent')?.worktree);
  } catch {
    return normalizeWorktreeSettings(null);
  }
}

// ---------------------------------------------------------------------------
// Helpers

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

/** A directory git can run in for this record's repository. */
function repoCwd(record) {
  return existsSync(record.projectPath) ? record.projectPath : record.repoCommonDir;
}

async function removeTree(path) {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: REMOVE_RETRY_DELAY_MS });
    return null;
  } catch (error) {
    return error;
  }
}

async function registrationFor(record) {
  const worktrees = await listWorktrees(repoCwd(record));
  return worktrees.find((worktree) => samePath(worktree.path, record.path)) || null;
}

/**
 * True only when `path` definitely does not exist (ENOENT/ENOTDIR). An
 * unreadable or unmounted location (EACCES, EIO, …) is not "gone".
 */
async function isGone(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
  }
}

/**
 * The repository's linked-worktree admin dirs (<common dir>/worktrees/<name>)
 * with the checkout each one's `gitdir` points at; unreadable ones are skipped.
 * @returns {Promise<Array<{ admin: string, worktreePath: string }>>}
 */
async function adminRegistrations(repoCommonDir) {
  const adminRoot = join(repoCommonDir, 'worktrees');
  let names;
  try {
    names = await readdir(adminRoot);
  } catch {
    return [];
  }
  const registrations = [];
  for (const name of names) {
    let gitdir;
    try {
      gitdir = firstLine(await readFile(join(adminRoot, name, 'gitdir'), 'utf8'));
    } catch {
      continue;
    }
    if (gitdir) registrations.push({ admin: join(adminRoot, name), worktreePath: dirname(gitdir) });
  }
  return registrations;
}

/**
 * Drop the git admin dir of a registration whose checkout is definitely gone
 * (targeted `git worktree prune`: unrelated stale registrations stay). A
 * `locked` registration is kept unless `allowLocked` (the record that owns it
 * is being deleted or rolled back).
 */
async function pruneRegistration(repoCommonDir, worktreePath, { allowLocked = false } = {}) {
  if (!(await isGone(worktreePath))) return false;
  let pruned = false;
  for (const registration of await adminRegistrations(repoCommonDir)) {
    if (!samePath(registration.worktreePath, worktreePath)) continue;
    if (!allowLocked && !(await isGone(join(registration.admin, 'locked')))) continue;
    await rm(registration.admin, { recursive: true, force: true });
    pruned = true;
  }
  return pruned;
}

/**
 * WORKTREE_PATH_UNSAFE unless `record.path` is exactly the managed path of
 * its id, inside the managed root, and (when present) its `.git` file links
 * back into this repository's worktree admin dir. A checkout whose `.git` is
 * already gone passes only while empty or after a recorded removal attempt
 * (a partly deleted folder).
 */
async function assertManagedCheckoutPath(record) {
  const unsafe = (reason) =>
    worktreeError('WORKTREE_PATH_UNSAFE', undefined, { entryId: record.id, path: record.path, reason });
  let expected;
  try {
    expected = managedWorktreePath(record.repoCommonDir, record.id);
  } catch {
    throw unsafe('invalid-id');
  }
  const root = managedWorktreeRoot(record.repoCommonDir);
  if (!samePath(record.path, expected) || samePath(record.path, root) || !isWithin(root, record.path)) {
    throw unsafe('outside-managed-root');
  }
  if (await isGone(record.path)) return;
  const dotGit = join(record.path, '.git');
  let info = null;
  try {
    info = await lstat(dotGit);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw unsafe('unreadable');
  }
  if (!info) {
    const attempted = !!record.deleting?.lastAttemptAt || !!record.recovery?.remaining || record.state === 'recovery';
    if (attempted || (await readdir(record.path)).length === 0) return;
    throw unsafe('no-back-link');
  }
  if (!info.isFile()) throw unsafe('not-a-linked-checkout');
  const gitdir = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim();
  const admin = join(record.repoCommonDir, 'worktrees');
  if (!gitdir || samePath(gitdir, admin) || !isWithin(admin, canonicalPath(gitdir))) {
    throw unsafe('foreign-back-link');
  }
}

/** Keep the tip of a branch whose unmerged commits a forced removal drops. */
async function keepRemovedTip(record) {
  const tip = await branchCommit(repoCwd(record), record.branch);
  if (!tip) return { tip: null, recoveryRef: null };
  const ref = `refs/mixdog/removed/${record.id}`;
  await runGit(repoCwd(record), ['update-ref', '-m', `mixdog: removed worktree ${record.id}`, ref, tip]);
  return { tip, recoveryRef: ref };
}

/** Managed checkouts whose registration is stale (directory missing). */
async function staleManagedRegistrations(repoCommonDir) {
  const root = managedWorktreeRoot(repoCommonDir);
  const stale = [];
  for (const { worktreePath } of await adminRegistrations(repoCommonDir)) {
    if (!(await isGone(worktreePath))) continue;
    const rel = relative(pathKey(root), pathKey(worktreePath));
    if (rel && !rel.startsWith('..') && !rel.includes(sep)) stale.push(worktreePath);
  }
  return stale;
}

async function setResource(record, name, status) {
  record.resources = { ...record.resources, [name]: status };
  await putRecord(record);
}

async function recordInclude(record, ledger) {
  const includes = [...(record.resources.includes || [])];
  const index = includes.findIndex((item) => item.path === ledger.path);
  if (index >= 0) includes[index] = { ...ledger };
  else includes.push({ ...ledger });
  record.resources = { ...record.resources, includes };
  await putRecord(record);
}

async function unmergedCommitCount(record) {
  // A snapshot has no branch, so nothing of it can be unmerged.
  if (!record.branch) return 0;
  const cwd = repoCwd(record);
  const tip = await branchCommit(cwd, record.branch);
  if (!tip) return 0;
  const reference = (record.mergeTarget && (await branchCommit(cwd, record.mergeTarget))) || record.baseCommit;
  if (!reference) return 0;
  const result = await runGit(cwd, ['rev-list', '--count', tip, '--not', reference]);
  return Number(firstLine(result.stdout)) || 0;
}

/** Uncommitted/untracked paths plus modified include copies. */
async function dirtyPaths(record) {
  if (!existsSync(record.path)) return [];
  const includes = record.resources?.includes || [];
  const status = await runGit(record.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    readOnly: true,
  });
  const identity = record.projectSubdir
    ? `${record.projectSubdir}/${SESSION_PROJECT_ID_PATH}`
    : SESSION_PROJECT_ID_PATH;
  const dirty = parseStatusPaths(status.stdout).filter(
    (path) => path !== identity && !coveredByIncludes(includes, path)
  );
  return [...dirty, ...(await modifiedIncludeCopies(includes))];
}

async function deleteBranchIfFree(record) {
  if (record.existingBranch === true) return { deleted: false, reason: 'pre-existing' };
  const cwd = repoCwd(record);
  if (!(await branchCommit(cwd, record.branch))) return { deleted: false, reason: 'missing' };
  const holder = (await listWorktrees(cwd)).find((worktree) => worktree.branch === record.branch);
  if (holder) return { deleted: false, reason: 'checked-out', path: holder.path };
  const result = await runGit(cwd, ['branch', '-D', record.branch], { allowFailure: true });
  return result.code === 0 ? { deleted: true } : { deleted: false, reason: firstLine(result.stderr) };
}

/**
 * Remove the managed checkout and its registration. Returns the resources
 * still present (empty when everything is gone).
 */
async function removeCheckout(record) {
  await assertRecoveryStoresClear(record);
  await assertManagedCheckoutPath(record);
  // `git worktree remove --force` can descend through a junction on Windows
  // (fs.rm below does not: it unlinks links), so an unknown directory link
  // refuses this removal as it does the folder-only one.
  await assertNoUnrecordedDirectoryLinks(record);
  const remaining = [];
  for (const path of await removeIncludeLinks(record.resources?.includes)) remaining.push({ kind: 'link', path });
  if (remaining.length) return remaining;
  const cwd = repoCwd(record);
  if (existsSync(record.path)) {
    // A built-in fsmonitor daemon holds the folder open (Windows) until stopped.
    await runGit(record.path, ['fsmonitor--daemon', 'stop'], { allowFailure: true });
  }
  if (await registrationFor(record)) {
    await runGit(cwd, ['worktree', 'unlock', record.path], { allowFailure: true });
    if (existsSync(record.path)) {
      await runGit(cwd, ['worktree', 'remove', '--force', record.path], { allowFailure: true });
    }
  }
  if (existsSync(record.path)) {
    const error = await removeTree(record.path);
    if (existsSync(record.path)) {
      remaining.push({ kind: 'directory', path: record.path, error: error?.code || error?.message || 'busy' });
      return remaining;
    }
  }
  await pruneRegistration(record.repoCommonDir, record.path, { allowLocked: true });
  if (await registrationFor(record)) remaining.push({ kind: 'registration', path: record.path });
  return remaining;
}

/**
 * Refuse a checkout that holds a directory link the ledger does not know (a
 * junction or directory symlink made by the user or a build tool): `git
 * worktree remove` can descend through it on Windows and delete the target's
 * files. Refusing is chosen over unlinking: nothing the manager did not make
 * is ever touched, and the user removes the link (never its target) and
 * retries. The walk never follows a link, skips `.git` entries (the back link
 * file, nested repositories' internals) and is bounded: a checkout too large
 * to verify is refused as well. Recorded links are skipped (unlinked next).
 */
async function assertNoUnrecordedDirectoryLinks(record) {
  const key = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  const recorded = new Set(
    (record.resources?.includes || []).filter((item) => item.mode === 'link').map((item) => key(item.path))
  );
  const refuse = (message, details) =>
    worktreeError('WORKTREE_PATH_UNSAFE', message, { entryId: record.id, path: record.path, ...details });
  const found = [];
  const pending = [record.path];
  let scanned = 0;
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw refuse(
        `The worktree folder could not be checked for links (${error?.code || error?.message}); nothing was deleted.`,
        { reason: 'unreadable' }
      );
    }
    for (const entry of entries) {
      if (++scanned > LINK_SCAN_LIMIT) {
        throw refuse(
          `The worktree folder has more than ${LINK_SCAN_LIMIT} entries to check for links; nothing was deleted.`,
          { reason: 'too-many-entries' }
        );
      }
      if (entry.name.toLowerCase() === '.git') continue;
      const path = join(dir, entry.name);
      // A junction is a link here too (a reparse point), so it is never descended.
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isSymbolicLink() && !recorded.has(key(path)) && (await linksToDirectory(path))) {
        found.push(relative(record.path, path).split(sep).join('/'));
      }
    }
  }
  if (found.length) {
    throw refuse(
      `The worktree contains linked folders it did not create (${found.slice(0, 10).join(', ')}${found.length > 10 ? ', …' : ''}). ` +
        'Removing the folder could delete their targets: remove those links (not their targets) first; nothing was deleted.',
      { reason: 'unrecorded-links', links: found.slice(0, 50), count: found.length }
    );
  }
}

/** True when the link at `path` resolves to a directory (or cannot be ruled out). */
async function linksToDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    // Dangling: nothing to descend into.
    return error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR';
  }
}

/** Explicit folder-only cleanup never force-removes a checkout or user files. */
async function removeCheckoutSafely(record) {
  const registration = await registrationFor(record);
  if (!registration && !existsSync(record.path)) return [];
  await assertManagedCheckoutPath(record);
  await assertRecoveryStoresClear(record);
  await assertRemovable(record);
  if (await operationInProgress(gitStatusRunner, record.path)) {
    throw worktreeError('WORKTREE_DIRTY', 'Finish the Git operation before removing this worktree.');
  }
  const ownedLock = `mixdog session=${record.ownerSessionId}`;
  if (registration?.locked !== null && registration?.locked !== ownedLock) {
    throw worktreeError('WORKTREE_BUSY_JOBS', 'The worktree has an external Git lock.');
  }
  // `git worktree remove` descends through a directory junction on Windows
  // and would empty its target (a linked node_modules in the main checkout):
  // an unknown link refuses the removal, the recorded links go first, by unlink only.
  await assertNoUnrecordedDirectoryLinks(record);
  const includes = record.resources?.includes;
  if ((await removeIncludeLinks(includes)).length) {
    const failures = await restoreIncludeLinks(includes);
    throw withRollbackFailures(
      worktreeError('WORKTREE_BUSY_JOBS', 'A linked folder in the worktree could not be unlinked.'),
      failures.map((failure) => `${failure.path} (${failure.error})`)
    );
  }
  let unlocked = false;
  try {
    if (registration?.locked === ownedLock) {
      await runGit(repoCwd(record), ['worktree', 'unlock', record.path]);
      unlocked = true;
    }
    await runGit(repoCwd(record), ['worktree', 'remove', record.path]);
  } catch (error) {
    const failures = (await restoreIncludeLinks(includes)).map((failure) => `${failure.path} (${failure.error})`);
    if (unlocked && (await registrationFor(record))) {
      try {
        await runGit(repoCwd(record), ['worktree', 'lock', '--reason', ownedLock, record.path]);
      } catch (lockError) {
        failures.push(`worktree lock (${firstLine(lockError?.message) || lockError})`);
      }
    }
    throw withRollbackFailures(error, failures);
  }
  return [];
}

/** Report what a failed safe removal could not put back on its error (never swallowed). */
function withRollbackFailures(error, failures) {
  if (!failures.length) return error;
  error.rollbackFailures = failures;
  error.message = `${error.message} Not restored: ${failures.join(', ')}.`;
  return error;
}

/**
 * After the last worktree of a repository is gone, drop its now-empty store
 * folder (<dataDir>/worktrees-v1/<repoHash>/ and its .owners/). Runs under the
 * repository lock; never while the registry still has an entry of that
 * repository, and only removes empty directories (rmdir), so another
 * checkout or owner lease keeps them.
 */
async function pruneEmptyRepoRoot(repoCommonDir) {
  const key = pathKey(repoCommonDir);
  if (Object.values((await readRegistry()).entries).some((record) => pathKey(record.repoCommonDir) === key)) return;
  const root = managedWorktreeRoot(repoCommonDir);
  for (const dir of [join(root, '.owners'), root]) {
    try {
      await rmdir(dir);
    } catch (error) {
      // Missing, not empty, or held: it stays.
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EBUSY', 'EPERM', 'EACCES', 'ENOTDIR'].includes(error?.code)) throw error;
    }
  }
}

/**
 * Undo an incomplete creation using only the ledger's proof. The record moves
 * to `recovery` first, so an interruption stays attributable.
 * @returns {Promise<{ complete: boolean, remaining: object[] }>}
 */
async function rollbackCreation(record, cause) {
  record.state = 'recovery';
  record.recovery = {
    txId: record.txId,
    reason: cause ? String(cause.message || cause) : 'interrupted creation',
    at: Date.now(),
  };
  // The filesystem cleanup never waits on the registry: with a full disk this
  // write can fail too, and the checkout must still go.
  const remaining = [];
  await putRecord(record).catch((error) =>
    remaining.push({ kind: 'registry', error: String(error?.message || error) })
  );
  const resources = record.resources || {};
  try {
    if (resources.owner) await removeOwnerLease(record);
    if (resources.worktree) {
      const left = await removeCheckout(record);
      remaining.push(...left);
      if (
        !left.length &&
        record.existingBranch !== true &&
        !(record.exactBranch === true && resources.worktree !== 'created')
      ) {
        // The slug was free when this transaction reserved it, so a branch
        // still at the base commit is the one `worktree add -b` made. A
        // branch that moved holds someone's commits and is kept.
        const tip = await branchCommit(repoCwd(record), record.branch);
        if (tip && tip === record.baseCommit) {
          const result = await deleteBranchIfFree(record);
          if (!result.deleted) remaining.push({ kind: 'branch', branch: record.branch, reason: result.reason });
        } else if (tip) {
          remaining.push({ kind: 'branch', branch: record.branch, reason: 'moved' });
        }
      }
    }
  } catch (error) {
    remaining.push({ kind: 'error', error: String(error?.message || error) });
  }
  if (!remaining.some((item) => item.kind !== 'registry')) {
    try {
      await deleteRecord(record.id);
      await pruneEmptyRepoRoot(record.repoCommonDir);
      return { complete: true, remaining: [] };
    } catch (error) {
      remaining.push({ kind: 'registry', error: String(error?.message || error) });
    }
  }
  record.recovery = { ...record.recovery, remaining };
  await putRecord(record).catch(() => {});
  return { complete: false, remaining };
}

/** finishDeletion's folder step; what is left over goes to `remaining`. */
async function removeFolder(record, remaining) {
  await removeOwnerLease(record);
  const ctx = { reason: 'worktree-removed', entryId: record.id };
  const results = await runRootReleasers(record.path, ctx);
  for (const root of new Set([record.path, sessionRootOf(record)])) {
    results.push(...(await runRootCleanups(root, ctx)));
  }
  for (const result of results) {
    if (!result.ok) remaining.push({ kind: 'cleanup', name: result.name, error: result.error.message });
  }
  remaining.push(...(await (record.deleting?.safeOnly ? removeCheckoutSafely(record) : removeCheckout(record))));
}

/**
 * Finish (or resume) a decided deletion, in order: release the live handles
 * on the folder (desktop terminals), drop the caches keyed by it (the checkout
 * root and the session root of a subfolder Project), then `git worktree
 * remove` and delete the directory. A failed releaser or cleanup is reported
 * and retried with the deletion; it never keeps the checkout.
 */
async function finishDeletion(record) {
  await assertRecoveryStoresClear(record);
  const remaining = [];
  try {
    // A snapshot is deleted under the cross-process write lock the git tool
    // takes on the worktree it writes in (withGitWriteLocks: its advisory
    // lock), so no git write of another process runs while the folder goes.
    if (record.kind === WORKTREE_SNAPSHOT_KIND) {
      await withAdvisoryLocks([record.path], () => removeFolder(record, remaining));
    } else {
      await removeFolder(record, remaining);
    }
  } catch (error) {
    remaining.push({ kind: 'error', error: String(error?.message || error) });
  }
  if (remaining.length) {
    record.deleting = { ...record.deleting, remaining, lastAttemptAt: Date.now() };
    await putRecord(record);
    return { removed: false, retryable: true, remaining };
  }
  let branch = { deleted: false, reason: 'kept' };
  let kept = { tip: null, recoveryRef: null };
  const merged = (await unmergedCommitCount(record)) === 0;
  if (record.branch && !record.deleting?.preserveBranch && (record.deleting?.force || merged)) {
    // Forced past unmerged commits: the tip stays reachable before `branch -D`.
    if (!merged) kept = await keepRemovedTip(record);
    else kept.tip = await branchCommit(repoCwd(record), record.branch);
    branch = await deleteBranchIfFree(record);
  }
  await deleteRecord(record.id);
  await pruneEmptyRepoRoot(record.repoCommonDir);
  return {
    removed: true,
    branchDeleted: branch.deleted,
    ...(branch.deleted && kept.tip ? { tip: kept.tip } : {}),
    ...(kept.recoveryRef ? { recoveryRef: kept.recoveryRef } : {}),
  };
}

function findRecord(doc, predicate) {
  return Object.values(doc.entries).find(predicate) || null;
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Serialize managed mutations of one repository (in-process + cross-process).
 * @template T
 * @param {string} repoCommonDir
 * @param {() => Promise<T>|T} fn
 */
export function withRepoLock(repoCommonDir, fn) {
  return withRepoMutationLock(repoCommonDir, fn);
}

/** The worktree retained by `sessionId` (ready first), or null. */
export async function getSessionWorktree(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const records = Object.values((await readRegistry()).entries).filter((record) => record.ownerSessionId === sessionId);
  const record = records.find((item) => item.state === 'ready') || records[0];
  return record ? entryView(record) : null;
}

/** The managed worktree at `path` (canonical, case-insensitive on Windows), or null. */
export async function getWorktreeByPath(path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  const key = pathKey(path);
  const record = Object.values((await readRegistry()).entries).find((item) => pathKey(item.path) === key);
  return record ? entryView(record) : null;
}

/**
 * Resolve a branch to its checkout without switching any existing folder.
 * `startPoint` (with `create`): the new branch starts at that commit-ish
 * instead of the project folder's branch.
 */
export async function resolveBranchWorkspace({
  projectPath,
  branch,
  create = false,
  startPoint = null,
  sessionId,
  runtimeToken,
  txId,
  confirmLarge = false,
  signal,
} = {}) {
  requireText(branch, 'branch');
  if (startPoint !== null && create !== true) throw new TypeError('startPoint needs create.');
  const repo = await inspectRepo(projectPath, { signal });
  return withRepoLock(repo.repoCommonDir, async () => {
    if (!(await validBranchName(repo.projectPath, branch))) throw new TypeError('Invalid branch name.');
    const records = Object.values((await readRegistry()).entries);
    const transaction = records.find((record) => record.txId === txId);
    if (
      transaction &&
      (transaction.ownerSessionId !== sessionId ||
        transaction.branch !== branch ||
        !samePath(transaction.repoCommonDir, repo.repoCommonDir))
    ) {
      throw worktreeError('WORKTREE_REVISION_CONFLICT', 'This transaction belongs to another workspace.');
    }
    const retry =
      transaction ??
      (create
        ? records.find(
            (record) =>
              record.ownerSessionId === sessionId &&
              record.branch === branch &&
              record.exactBranch === true &&
              samePath(record.repoCommonDir, repo.repoCommonDir)
          )
        : null);
    if (retry?.state === 'ready') {
      if (!existsSync(retry.path)) throw worktreeError('WORKTREE_MISSING');
      await claimWorktreeOwner(retry.id, { sessionId, runtimeToken, pid: process.pid });
      return { path: retry.path, branch, entry: entryView(retry), repoCommonDir: repo.repoCommonDir };
    }
    const branches = await localBranches(repo.projectPath, { signal });
    if (create && branches.includes(branch))
      throw worktreeError('WORKTREE_REVISION_CONFLICT', 'Branch already exists.');
    if (!create && !branches.includes(branch)) throw worktreeError('WORKTREE_MISSING', 'Branch does not exist.');
    const holder = (await listWorktrees(repo.projectPath)).find((item) => item.branch === branch && !item.prunable);
    if (holder) {
      if (!existsSync(holder.path)) throw worktreeError('WORKTREE_MISSING');
      const entry = await getWorktreeByPath(holder.path);
      const claim = entry ? await claimWorktreeOwner(entry.id, { sessionId, runtimeToken, pid: process.pid }) : null;
      return {
        path: holder.path,
        branch,
        entry,
        referenceAdded: claim?.referenceAdded === true,
        repoCommonDir: repo.repoCommonDir,
      };
    }
    // Checked out in a managed worktree, the branch a remote declares its
    // default would stay locked away from the project folder.
    if (!create && (await remoteDefaultBranches(repo.projectPath)).includes(branch)) {
      throw worktreeError('WORKTREE_DEFAULT_BRANCH', undefined, { branch });
    }
    const entry = await createManagedWorktree({
      projectPath,
      sessionId,
      runtimeToken,
      txId,
      branch,
      existingBranch: !create,
      baseBranch: create ? repo.currentBranch : branch,
      startCommit: startPoint,
      nameHint: branch,
      confirmLarge,
      signal,
    });
    return { path: entry.path, branch, entry, created: true, repoCommonDir: repo.repoCommonDir };
  });
}

/** Remove only a deleted session's shared references, never its neighbours'. */
export async function forgetSharedWorktreeSession(sessionId) {
  for (const record of Object.values((await readRegistry()).entries)) {
    if (!record.sharedSessionIds?.includes(sessionId)) continue;
    await withRepoLock(record.repoCommonDir, async () => {
      const current = await getRecord(record.id);
      if (!current) return;
      current.sharedSessionIds = (current.sharedSessionIds ?? []).filter((id) => id !== sessionId);
      const leases = { ...current.sharedLeases };
      delete leases[sessionId];
      current.sharedLeases = leases;
      await putRecord(current);
    });
  }
}

/** The managed worktree whose checkout is `path` or contains it (a subfolder Project's session root), or null. */
export async function findWorktreeContaining(path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  const record = Object.values((await readRegistry()).entries).find((item) => isWithin(item.path, path));
  return record ? entryView(record) : null;
}

/** File-host seam, not a user capability. Persist the host-owned scope before
 * preparing a byte journal, and hold the same repository lock as every removal
 * through the operation. The descriptor survives daemon exit/startup reconcile.
 * @template T
 * @param {string} root
 * @param {string} directory
 * @param {'write'|'restore'|'inspect'|'discard'} action
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withWorktreeRecoveryStore(root, directory, action, run) {
  const entry = await findWorktreeContaining(root);
  if (!entry) {
    // A managed checkout can disappear between host authorization and this
    // lookup. Its reserved namespace must never become an ordinary project.
    // Retain a lexical check as well, so a replacement link cannot escape it.
    const store = dirname(registryPath());
    const lexicalKey = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
    const requested = lexicalKey(root);
    if (
      isWithin(store, root) ||
      [store, canonicalPath(store)].some(
        (path) => requested === lexicalKey(path) || requested.startsWith(lexicalKey(path) + sep)
      )
    )
      throw worktreeError('WORKTREE_MISSING', undefined, { path: root });
    return run();
  }
  return withRepoLock(entry.repoCommonDir, async () => {
    const record = await getRecord(entry.id);
    if (!record || ((action === 'write' || action === 'restore') && record.state !== 'ready'))
      throw worktreeError('WORKTREE_MISSING', undefined, { entryId: entry.id });
    const scope = validateRecoveryScope(record, { root, directory });
    let scopes = recoveryScopes(record);
    if (!scopes.some((item) => item.root === root && item.directory === directory)) {
      if (scopes.length >= 64) scopes = await retainedRecoveryScopes(record);
      if (scopes.length >= 64) throw worktreeError('WORKTREE_FILE_RECOVERY');
      record.editorRecoveryStores = [...scopes, scope];
      await putRecord(record);
    }
    return run();
  });
}

/** Mark an entry disposable: startup reconcile may remove it once clean and merged. */
export async function markWorktreeDisposable(entryId, disposable = true) {
  const record = await getRecord(entryId);
  if (!record) throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
  return withRepoLock(record.repoCommonDir, async () => {
    const current = await getRecord(entryId);
    if (!current) throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
    current.disposable = disposable === true;
    await putRecord(current);
    return entryView(current);
  });
}

/**
 * Before a creation (under the repository lock): the entry this transaction
 * or session already has ready (its lease re-written), else null once every
 * unfinished earlier attempt of the session in this repository is completed.
 * WORKTREE_REVISION_CONFLICT for another session's transaction, a ready
 * worktree of another repository, or an attempt that is still being cleaned up.
 */
async function settleSessionAttempts({ txId, owner, repoCommonDir, multiple = false }) {
  const doc = await readRegistry();
  const sameRepo = (record) => samePath(record.repoCommonDir, repoCommonDir);

  const prior = findRecord(doc, (record) => record.txId === txId);
  if (prior?.state === 'ready') {
    if (prior.ownerSessionId !== owner.sessionId) {
      throw worktreeError('WORKTREE_REVISION_CONFLICT', 'This transaction belongs to another session.', { txId });
    }
    await writeOwnerLease(prior, owner);
    return entryView(prior);
  }

  for (const record of Object.values(doc.entries).filter((item) => item.ownerSessionId === owner.sessionId)) {
    if (multiple && record.txId !== txId) continue;
    if (record.state === 'ready') {
      if (!sameRepo(record)) {
        throw worktreeError(
          'WORKTREE_REVISION_CONFLICT',
          'This session already retains a worktree of another repository.',
          { entryId: record.id }
        );
      }
      await writeOwnerLease(record, owner);
      return entryView(record);
    }
    if (!sameRepo(record)) continue;
    // An earlier attempt of this session never finished (or its removal
    // was interrupted): complete that first, then create.
    const outcome =
      record.state === 'deleting'
        ? await finishDeletion(record)
        : await rollbackCreation(record).then((result) => ({
            removed: result.complete,
            remaining: result.remaining,
          }));
    if (!outcome.removed) {
      throw worktreeError(
        'WORKTREE_REVISION_CONFLICT',
        'A previous worktree of this session is still being cleaned up; try again.',
        { entryId: record.id, remaining: outcome.remaining }
      );
    }
  }
  return null;
}

/**
 * A full disk during `worktree add` or an include copy is the same refusal
 * the preflight gives, with the sizes the user needs.
 */
async function diskFullFailure(error, { needed, root }) {
  return worktreeError('WORKTREE_DISK_INSUFFICIENT', undefined, {
    requiredBytes: needed,
    freeBytes: await config.freeBytes(root).catch(() => null),
    path: root,
    reason:
      `${error.stderr || ''}\n${error.message || ''}`
        .split(/\r?\n/)
        .find((line) => /space|ENOSPC|disk/i.test(line))
        ?.trim() || firstLine(error.message),
  });
}

/**
 * The size preflight of every managed checkout of `baseCommit`:
 * WORKTREE_DISK_INSUFFICIENT when it cannot fit, WORKTREE_LARGE_REPO_CONFIRM
 * (`details: { estimateBytes, thresholdBytes }`) above the warning size until
 * `confirmLarge`. `extraBytes`: include copies on top of the tracked files.
 */
async function assertCheckoutFits({ repo, baseCommit, extraBytes = 0, settings, confirmLarge, signal }) {
  const tracked = await trackedCheckoutBytes(repo.topLevel, baseCommit, { signal });
  const contentBytes = tracked.bytes + extraBytes;
  const root = managedWorktreeRoot(repo.repoCommonDir);
  const needed = requiredBytes(contentBytes);
  const free = await config.freeBytes(root);
  if (free < needed) {
    throw worktreeError('WORKTREE_DISK_INSUFFICIENT', undefined, {
      requiredBytes: needed,
      freeBytes: free,
      path: root,
    });
  }
  if (settings.sizeWarnBytes > 0 && contentBytes > settings.sizeWarnBytes && confirmLarge !== true) {
    throw worktreeError('WORKTREE_LARGE_REPO_CONFIRM', undefined, {
      estimateBytes: contentBytes,
      thresholdBytes: settings.sizeWarnBytes,
    });
  }
  return { tracked, root, needed };
}

/** The full id of commit-ish `value` in `cwd`; TypeError when it names no commit. */
async function resolveCommit(cwd, value, signal) {
  const name = String(value ?? '').trim();
  if (!name || name.startsWith('-')) throw new TypeError('A commit is required.');
  const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], {
    signal,
    allowFailure: true,
  });
  if (result.code !== 0) throw new TypeError(`Commit ${name} does not exist.`);
  return firstLine(result.stdout);
}

/** A snapshot is in use while its holder session is live, or its lease holder runs in another process. */
async function snapshotHolderLive(record, live) {
  if (record.holderSessionId && live.has(record.holderSessionId)) return true;
  const lease = await readOwnerLease(record);
  return !!lease && lease.pid !== process.pid && leaseProcessAlive(lease);
}

/**
 * `carryChanges` decides the project folder's uncommitted changes (tracked
 * and untracked, ignored excluded), judged under the repository lock:
 * omitted/null leaves them unexamined; `ask` refuses with
 * WORKTREE_DIRTY_CHOICE (`details: { count, paths }`, paths capped) while
 * there are any; `leave` keeps them in the project folder; `carry` moves
 * them into the new worktree (carry.mjs: whole checkout, ignored files stay)
 * — refused (WORKTREE_DIRTY) during a merge, rebase or cherry-pick, with
 * unmerged entries, dirty submodules, filtered (LFS) paths or oversized
 * untracked files. The result's `changes` (`{ mode: 'carried'|'left',
 * count, recoveryRef? }`) reports what happened to them; a carried move's
 * `recoveryRef` stays until dropCarryRecoveryRef / restoreCarriedChanges.
 * `startCommit` (a new exact `branch` only) starts the branch at that
 * commit-ish instead of the base branch's tip.
 * @param {{ projectPath: string, sessionId: string, runtimeToken: string, baseBranch?: string|null,
 *   nameHint?: string, confirmLarge?: boolean, txId: string, signal?: AbortSignal,
 *   carryChanges?: 'ask'|'leave'|'carry'|null, branch?: string|null, existingBranch?: boolean,
 *   startCommit?: string|null }} input
 */
export async function createManagedWorktree({
  projectPath,
  sessionId,
  runtimeToken,
  baseBranch = null,
  nameHint = '',
  confirmLarge = false,
  txId,
  signal,
  carryChanges = null,
  branch: requestedBranch = null,
  existingBranch = false,
  startCommit = null,
} = {}) {
  requireText(projectPath, 'projectPath');
  requireText(txId, 'txId');
  if (startCommit !== null && (existingBranch || requestedBranch === null)) {
    throw new TypeError('startCommit applies to a new exact branch only.');
  }
  if (![null, 'ask', 'leave', 'carry'].includes(carryChanges)) {
    throw new TypeError('carryChanges must be ask, leave or carry.');
  }
  const owner = normalizeWorktreeOwner({ sessionId, runtimeToken, pid: process.pid });
  throwIfAborted(signal);
  const repo = await inspectRepo(projectPath, { signal });
  return withRepoLock(repo.repoCommonDir, async () => {
    const existing = await settleSessionAttempts({
      txId,
      owner,
      repoCommonDir: repo.repoCommonDir,
      multiple: requestedBranch !== null,
    });
    if (existing) return existing;
    throwIfAborted(signal);

    const projectSubdir = projectSubdirOf(repo.topLevel, repo.projectPath);
    // A carry is judged by the same status read that counts the changes.
    let pendingChanges = [];
    if (carryChanges === 'carry') pendingChanges = await assertCarryable(repo.topLevel, projectSubdir);
    else if (carryChanges) pendingChanges = await uncommittedChanges(repo.topLevel, projectSubdir);
    if (pendingChanges.length && carryChanges === 'ask') {
      throw worktreeError('WORKTREE_DIRTY_CHOICE', undefined, {
        count: pendingChanges.length,
        paths: pendingChanges.slice(0, DIRTY_CHOICE_PREVIEW),
      });
    }

    const settings = await currentWorktreeSettings();
    let baseCommit = repo.headCommit;
    let mergeTarget = repo.currentBranch;
    if (baseBranch) {
      baseCommit = await branchCommit(repo.projectPath, baseBranch, { signal });
      if (!baseCommit) {
        throw worktreeError('WORKTREE_UNSUPPORTED_REPO', `Base branch ${baseBranch} does not exist.`, { baseBranch });
      }
      mergeTarget = baseBranch;
    }
    // A new branch at an explicit start point (`git worktree add -b <b> <path> <commit-ish>`).
    if (startCommit) baseCommit = await resolveCommit(repo.projectPath, startCommit, signal);

    // The main checkout's local env files come along on their own;
    // `.worktreeinclude` applies on top.
    const includePlan = await planIncludes(repo.topLevel, await readIncludeEntries(repo.topLevel), {
      envFiles: await untrackedEnvFiles(repo.topLevel),
    });
    const { tracked, root, needed } = await assertCheckoutFits({
      repo,
      baseCommit,
      extraBytes: includePlan.copyBytes,
      settings,
      confirmLarge,
      signal,
    });
    throwIfAborted(signal);

    const branches = new Set(
      (await localBranches(repo.projectPath, { signal, prefix: settings.branchPrefix })).map((name) =>
        name.toLowerCase()
      )
    );
    const base = slugFromHint(nameHint);
    const reserve = async () => {
      let reserved = null;
      for (let attempt = 0; attempt < 5 && !reserved; attempt++) {
        reserved = await reserveName();
      }
      if (!reserved) throw worktreeError('WORKTREE_REVISION_CONFLICT', 'Could not reserve a worktree name; try again.');
      return reserved;
    };
    const addCheckout = (target) =>
      runGit(
        repo.projectPath,
        existingBranch
          ? ['worktree', 'add', target.path, target.branch]
          : ['worktree', 'add', '-b', target.branch, target.path, baseCommit],
        {
          signal,
          timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
        }
      );
    let record = await reserve();
    let carried = null;

    try {
      await mkdir(root, { recursive: true });
      await setResource(record, 'worktree', 'pending');
      try {
        await addCheckout(record);
      } catch (error) {
        if (requestedBranch) throw error;
        // Another process took the branch name (or folder) after the
        // reservation: git refused before making anything, so reserve the
        // next free name once and try again.
        // ("already exists", or a ref directory/file clash: "… exists; cannot create …").
        if (!/already exists|exists; cannot create/i.test(`${error?.stderr || ''}${error?.message || ''}`)) throw error;
        branches.add(record.branch.toLowerCase());
        record.resources = { ...record.resources, worktree: null };
        await deleteRecord(record.id);
        record = await reserve();
        await setResource(record, 'worktree', 'pending');
        await addCheckout(record);
      }
      await setResource(record, 'worktree', 'created');
      throwIfAborted(signal);
      await setResource(record, 'lock', 'pending');
      await runGit(repo.projectPath, [
        'worktree',
        'lock',
        '--reason',
        `mixdog session=${owner.sessionId}`,
        record.path,
      ]);
      await setResource(record, 'lock', 'created');
      await setResource(record, 'owner', 'pending');
      await writeOwnerLease(record, owner);
      await setResource(record, 'owner', 'created');
      // Carried before the include entries are copied, so an include never
      // stands in the way of a carried file; the status is read again here,
      // right before acting.
      let changes = pendingChanges.length ? { mode: 'left', count: pendingChanges.length } : null;
      if (carryChanges === 'carry') {
        carried = await carryUncommittedChanges({
          topLevel: repo.topLevel,
          projectSubdir,
          worktreePath: record.path,
          baseCommit,
          label: record.id,
        });
        // The recovery ref stays until the caller has committed the move
        // (dropCarryRecoveryRef) or put the changes back (restoreCarriedChanges).
        changes = carried.count ? { mode: 'carried', count: carried.count, recoveryRef: carried.recoveryRef } : null;
      }
      const applied = await applyIncludes(includePlan, record.path, (ledger) => recordInclude(record, ledger));
      throwIfAborted(signal);
      // After the includes: one that already brought a node_modules wins.
      const linkedDependencies = await linkWorktreeDependencies({
        mainDir: repo.projectPath,
        worktreeDir: projectSubdir ? join(record.path, ...projectSubdir.split('/')) : record.path,
        worktreeRel: projectSubdir,
        signal,
        record: (ledger) => recordInclude(record, ledger),
      });
      throwIfAborted(signal);
      record.warnings = [...record.warnings, ...applied.warnings];
      const made = (record.resources.includes || []).filter((item) => item.status === 'created');
      const rels = (predicate) => made.filter(predicate).map((item) => item.rel);
      // What creation did, for the agent's note at the first turn there (transitions.mjs).
      const prepared = {
        root: repo.topLevel,
        copied: rels((item) => item.mode === 'copy'),
        linked: rels((item) => item.mode === 'link' && !item.dependency),
        dependencies: linkedDependencies,
        skipped: [...includePlan.warnings, ...applied.warnings],
      };
      // Whichever path made it (a worktree task, a branch selection, `git
      // worktree add`), the first turn a session runs here prepares its
      // dependencies (claimWorktreeSetup).
      record.setup = { pending: true, prepared };
      record.state = 'ready';
      await putRecord(record);
      return { ...entryView(record), prepared, ...(changes ? { changes } : {}) };
    } catch (error) {
      // Carried already: the changes go back to the project folder before the
      // worktree that holds them is rolled back (the recovery ref keeps them
      // either way).
      let carryRestore = null;
      if (carried?.recoveryRef) {
        carryRestore = await restoreFromRecoveryRef(repo.topLevel, projectSubdir, carried.recoveryRef)
          .then(() => ({ restored: true, recoveryRef: carried.recoveryRef }))
          .catch((restoreError) => ({
            restored: false,
            recoveryRef: carried.recoveryRef,
            error: String(restoreError?.message || restoreError),
          }));
      }
      const rollback = await rollbackCreation(record, error);
      const failure = isDiskFullError(error) ? await diskFullFailure(error, { needed, root }) : error;
      if (!rollback.complete) failure.rollback = rollback;
      if (carryRestore) failure.carryRestore = carryRestore;
      throw failure;
    }

    async function reserveName() {
      const ids = new Set(Object.keys((await readRegistry()).entries).map((id) => id.toLowerCase()));
      const slug = uniqueSlug(
        base,
        (candidate) =>
          ids.has(candidate.toLowerCase()) ||
          branches.has(`${settings.branchPrefix}${candidate}`.toLowerCase()) ||
          existsSync(join(root, candidate))
      );
      const branch = requestedBranch ?? worktreeBranchName(slug, settings.branchPrefix);
      if (!(await validBranchName(repo.projectPath, branch))) {
        throw worktreeError('WORKTREE_UNSUPPORTED_REPO', `Branch name ${branch} is not valid.`, { branch });
      }
      const candidate = {
        id: slug,
        txId,
        repoCommonDir: repo.repoCommonDir,
        projectPath: repo.projectPath,
        projectSubdir: projectSubdirOf(repo.topLevel, repo.projectPath),
        path: managedWorktreePath(repo.repoCommonDir, slug),
        branch,
        baseCommit,
        // An existing branch has no base it branched from: it merges where a
        // merge first takes it (recorded then), and until that its own work is
        // what it gained here since baseCommit.
        mergeTarget: existingBranch ? null : mergeTarget,
        createdAt: Date.now(),
        ownerSessionId: owner.sessionId,
        existingBranch,
        exactBranch: requestedBranch !== null,
        state: 'creating',
        disposable: false,
        warnings: [...(tracked.submodules ? ['submodules'] : []), ...includePlan.warnings],
        resources: { worktree: null, lock: null, owner: null, includes: [] },
        deleting: null,
        recovery: null,
      };
      return (await insertRecord(candidate)) ? candidate : null;
    }
  });
}

/**
 * A read-only snapshot: a detached checkout of `commit` (any commit-ish of
 * the repository) in the managed store, bound to no session. Its record
 * (`kind: 'snapshot'`, `branch` and `ownerSessionId` null) names the session
 * whose turn made it (`holderSessionId`, with an owner lease); it is removed
 * when that turn settles (removeSessionSnapshots), when the session is
 * deleted, and by the manual prune / startup reconcile once its holder is
 * gone. No include copies, dependency links or carried changes: a snapshot
 * only shows the commit. `txId` makes a retry return the same snapshot.
 * @param {{ projectPath: string, sessionId: string, runtimeToken: string, commit?: string,
 *   txId: string, confirmLarge?: boolean, signal?: AbortSignal }} input
 */
export async function createSnapshotWorktree({
  projectPath,
  sessionId,
  runtimeToken,
  commit = 'HEAD',
  txId,
  confirmLarge = false,
  signal,
} = {}) {
  requireText(projectPath, 'projectPath');
  requireText(txId, 'txId');
  const holder = normalizeWorktreeOwner({ sessionId, runtimeToken, pid: process.pid });
  throwIfAborted(signal);
  const repo = await inspectRepo(projectPath, { signal });
  return withRepoLock(repo.repoCommonDir, async () => {
    const prior = findRecord(await readRegistry(), (record) => record.txId === txId);
    if (prior) {
      if (prior.kind !== WORKTREE_SNAPSHOT_KIND || prior.holderSessionId !== holder.sessionId) {
        throw worktreeError('WORKTREE_REVISION_CONFLICT', 'This transaction belongs to another workspace.', { txId });
      }
      if (prior.state === 'ready') return entryView(prior);
      const rollback = await rollbackCreation(prior);
      if (!rollback.complete) {
        throw worktreeError('WORKTREE_REVISION_CONFLICT', 'A previous snapshot is still being cleaned up; try again.', {
          entryId: prior.id,
          remaining: rollback.remaining,
        });
      }
    }
    const baseCommit = await resolveCommit(repo.projectPath, commit, signal);
    const settings = await currentWorktreeSettings();
    const { tracked, root, needed } = await assertCheckoutFits({ repo, baseCommit, settings, confirmLarge, signal });
    throwIfAborted(signal);
    let record = null;
    for (let attempt = 0; attempt < 5 && !record; attempt++) {
      const ids = new Set(Object.keys((await readRegistry()).entries).map((id) => id.toLowerCase()));
      const slug = uniqueSlug(
        `snapshot-${baseCommit.slice(0, 8)}`,
        (candidate) => ids.has(candidate.toLowerCase()) || existsSync(join(root, candidate))
      );
      const candidate = {
        id: slug,
        txId,
        kind: WORKTREE_SNAPSHOT_KIND,
        repoCommonDir: repo.repoCommonDir,
        projectPath: repo.projectPath,
        projectSubdir: projectSubdirOf(repo.topLevel, repo.projectPath),
        path: managedWorktreePath(repo.repoCommonDir, slug),
        branch: null,
        baseCommit,
        mergeTarget: null,
        createdAt: Date.now(),
        ownerSessionId: null,
        holderSessionId: holder.sessionId,
        // No branch of its own: nothing is ever deleted from refs/heads.
        existingBranch: true,
        exactBranch: false,
        state: 'creating',
        disposable: true,
        warnings: tracked.submodules ? ['submodules'] : [],
        resources: { worktree: null, lock: null, owner: null, includes: [] },
        deleting: null,
        recovery: null,
      };
      if (await insertRecord(candidate)) record = candidate;
    }
    if (!record) throw worktreeError('WORKTREE_REVISION_CONFLICT', 'Could not reserve a worktree name; try again.');
    try {
      await mkdir(root, { recursive: true });
      await setResource(record, 'worktree', 'pending');
      await runGit(repo.projectPath, ['worktree', 'add', '--detach', record.path, baseCommit], {
        signal,
        timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
      });
      await setResource(record, 'worktree', 'created');
      throwIfAborted(signal);
      await setResource(record, 'lock', 'pending');
      await runGit(repo.projectPath, [
        'worktree',
        'lock',
        '--reason',
        `mixdog snapshot session=${holder.sessionId}`,
        record.path,
      ]);
      await setResource(record, 'lock', 'created');
      await setResource(record, 'owner', 'pending');
      await writeOwnerLease(record, holder);
      await setResource(record, 'owner', 'created');
      record.state = 'ready';
      await putRecord(record);
      return entryView(record);
    } catch (error) {
      const rollback = await rollbackCreation(record, error);
      const failure = isDiskFullError(error) ? await diskFullFailure(error, { needed, root }) : error;
      if (!rollback.complete) failure.rollback = rollback;
      throw failure;
    }
  });
}

/**
 * Hold a snapshot's folder against its consumers on every deletion attempt,
 * a resumed (`deleting`) one included: WORKTREE_BUSY_JOBS (`folder-in-use`)
 * while any process's turn (a worker running there) or command (a background
 * shell, a git tool call) holds a workspace lease inside it; otherwise no new
 * one is admitted there until the returned release. A folder no longer a
 * checkout admits no consumer (activity-gate tracks git checkouts only).
 */
async function holdSnapshotFolder(record) {
  if (!existsSync(join(record.path, '.git'))) return () => {};
  const release = await holdWorkspaceActivityAsync([record.path]);
  // Settles once the removal was attempted. It fails only when workspace
  // admission stopped (reported there), which keeps the folder held.
  return () => release().catch(() => {});
}

/** A refusal that only says "something still runs there" (retry once it ends). */
function snapshotInUse(error) {
  return (
    error?.code === 'WORKTREE_BUSY_JOBS' &&
    ['folder-in-use', 'workspace-admission-unreadable'].includes(error.details?.reason)
  );
}

/**
 * Remove snapshot `entryId` once nothing runs in it (removeManagedWorktree
 * holds its folder); changes made in it only with `force`.
 */
export async function removeSnapshotWorktree({ entryId, force = false, expected = null } = {}) {
  if (!expected) {
    const record = await getRecord(entryId);
    if (record?.kind !== WORKTREE_SNAPSHOT_KIND) throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
  }
  // With `expected`, removeManagedWorktree checks identity (kind included) and skips a stale selection.
  return removeManagedWorktree({ entryId, force, expected });
}

/**
 * Remove the snapshots `sessionId` holds (`txIds`: only the ones those
 * creation transactions made — a settled turn's; an id alone could name a
 * later snapshot reusing a freed slug), changes and all: snapshots are
 * read-only by contract.
 * One a worker or background shell still runs in is kept with reason
 * `in-use` (its caller retries after they end); any other failure stays for
 * the prune / startup reconcile.
 * @param {string} sessionId
 * @param {{ txIds?: string[]|null }} [options]
 * @returns {Promise<{ removed: string[], kept: Array<{ id: string, txId: string, reason?: 'in-use', error?: string, remaining?: object[] }> }>}
 */
export async function removeSessionSnapshots(sessionId, { txIds = null } = {}) {
  const report = { removed: [], kept: [] };
  if (typeof sessionId !== 'string' || !sessionId) return report;
  const only = txIds ? new Set(txIds) : null;
  const held = Object.values((await readRegistry()).entries).filter(
    (record) =>
      record.kind === WORKTREE_SNAPSHOT_KIND && record.holderSessionId === sessionId && (!only || only.has(record.txId))
  );
  for (const record of held) {
    const row = { id: record.id, txId: record.txId };
    try {
      const result = await removeSnapshotWorktree({
        entryId: record.id,
        force: true,
        expected: { kind: record.kind, txId: record.txId, holderSessionId: record.holderSessionId },
      });
      // Skipped: the record is no longer the snapshot selected above (its slug was reused).
      if (result.skipped) continue;
      if (result.removed) report.removed.push(record.id);
      else report.kept.push({ ...row, remaining: result.remaining });
    } catch (error) {
      report.kept.push(
        snapshotInUse(error) ? { ...row, reason: 'in-use' } : { ...row, error: String(error?.message || error) }
      );
    }
  }
  return report;
}

/**
 * The first turn a session runs in managed worktree `entryId` claims its
 * dependency preparation, once: `{ prepared }` (what creation did) while it
 * is still pending, else null. Claimed before it runs, so a failed or
 * cancelled preparation is never repeated.
 */
export async function claimWorktreeSetup(entryId) {
  const record = await getRecord(entryId);
  if (!record?.setup?.pending) return null;
  return withRepoLock(record.repoCommonDir, async () => {
    const current = await getRecord(entryId);
    if (current?.state !== 'ready' || !current.setup?.pending) return null;
    current.setup = { ...current.setup, pending: false, claimedAt: Date.now() };
    await putRecord(current);
    return { prepared: current.setup.prepared ?? null };
  });
}

/**
 * After a carry whose session move failed: put the changes kept at
 * `recoveryRef` back into the project folder (refused, ref kept, when the
 * folder changed meanwhile). The ref stays; drop it with dropCarryRecoveryRef.
 * @param {{ projectPath: string, recoveryRef: string }} input
 */
export async function restoreCarriedChanges({ projectPath, recoveryRef } = {}) {
  requireText(projectPath, 'projectPath');
  const repo = await inspectRepo(projectPath);
  return withRepoLock(repo.repoCommonDir, () =>
    restoreFromRecoveryRef(repo.topLevel, projectSubdirOf(repo.topLevel, repo.projectPath), recoveryRef)
  );
}

/**
 * Forget a carry's recovery ref once the session move it protected is committed.
 * @param {{ projectPath: string, recoveryRef: string }} input
 */
export async function dropCarryRecoveryRef({ projectPath, recoveryRef } = {}) {
  requireText(projectPath, 'projectPath');
  const repo = await inspectRepo(projectPath);
  return withRepoLock(repo.repoCommonDir, () => dropRecoveryRef(repo.topLevel, recoveryRef));
}

/**
 * Claim the live lease of a retained worktree for one runtime of its session.
 * @param {string} entryId
 * @param {{ sessionId: string, runtimeToken: string, pid?: number|null }} owner
 */
export async function claimWorktreeOwner(entryId, owner) {
  const claimant = normalizeWorktreeOwner(owner);
  const record = await getRecord(entryId);
  if (!record) throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
  return withRepoLock(record.repoCommonDir, async () => {
    const current = await getRecord(entryId);
    if (current?.state !== 'ready') throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
    if (current.ownerSessionId && current.ownerSessionId !== claimant.sessionId) {
      const references = new Set(current.sharedSessionIds ?? []);
      const referenceAdded = !references.has(claimant.sessionId);
      references.add(claimant.sessionId);
      current.sharedSessionIds = [...references];
      const previous = current.sharedLeases?.[claimant.sessionId] ?? null;
      const lease = { ...claimant, entryId, claimedAt: Date.now() };
      current.sharedLeases = { ...current.sharedLeases, [claimant.sessionId]: lease };
      current.disposable = false;
      await putRecord(current);
      return {
        entry: entryView(current),
        lease,
        referenceAdded,
        replaced: previous && !sameOwner(previous, claimant) ? previous : null,
      };
    }
    if (!current.ownerSessionId) {
      const other = findRecord(
        await readRegistry(),
        (item) => item.ownerSessionId === claimant.sessionId && item.id !== entryId
      );
      if (other) {
        throw worktreeError('WORKTREE_REVISION_CONFLICT', 'The session already retains another worktree.', {
          entryId: other.id,
        });
      }
      current.ownerSessionId = claimant.sessionId;
      await putRecord(current);
    }
    const previous = await readOwnerLease(current);
    const lease = await writeOwnerLease(current, claimant);
    return { entry: entryView(current), lease, replaced: previous && !sameOwner(previous, claimant) ? previous : null };
  });
}

/**
 * Release the live lease when (and only when) it is held by exactly `owner`.
 * Durable ownership (the session retaining the worktree) is unchanged.
 */
export async function releaseWorktreeOwner(entryId, owner, { forgetReference = false } = {}) {
  const claimant = normalizeWorktreeOwner(owner);
  const record = await getRecord(entryId);
  if (!record) return { released: false };
  return withRepoLock(record.repoCommonDir, async () => {
    const current = await getRecord(entryId);
    if (!current) return { released: false };
    const shared = current.sharedLeases?.[claimant.sessionId];
    if (sameOwner(shared, claimant)) {
      const leases = { ...current.sharedLeases };
      delete leases[claimant.sessionId];
      current.sharedLeases = leases;
      if (forgetReference)
        current.sharedSessionIds = (current.sharedSessionIds ?? []).filter((id) => id !== claimant.sessionId);
      await putRecord(current);
      return { released: true };
    }
    const lease = await readOwnerLease(current);
    if (!sameOwner(lease, claimant)) return { released: false };
    await removeOwnerLease(current);
    return { released: true };
  });
}

/**
 * Local branches of the project and who holds each.
 * @param {{ projectPath: string, sessionId?: string }} input
 */
export async function listBranchOccupancy({ projectPath, sessionId } = {}) {
  requireText(projectPath, 'projectPath');
  const repo = await inspectRepo(projectPath);
  const [branches, worktrees, doc] = await Promise.all([
    localBranches(repo.projectPath),
    listWorktrees(repo.projectPath),
    readRegistry(),
  ]);
  const managed = Object.values(doc.entries).filter((record) => samePath(record.repoCommonDir, repo.repoCommonDir));
  const occupancy = branches.map((branch) => {
    // A prunable registration (its folder is gone) holds nothing.
    const holder = worktrees.find((worktree) => worktree.branch === branch && !worktree.prunable);
    if (!holder) return { branch, kind: 'free' };
    if (samePath(holder.path, repo.topLevel)) return { branch, kind: 'current', path: holder.path };
    const record = managed.find((item) => samePath(item.path, holder.path));
    if (record?.ownerSessionId) return { branch, kind: 'session', sessionId: record.ownerSessionId, path: holder.path };
    return { branch, kind: 'external', path: holder.path };
  });
  const retained = sessionId
    ? managed.find((record) => record.ownerSessionId === sessionId && record.state === 'ready')
    : null;
  return { branches, occupancy, retainedWorktree: retained ? entryView(retained) : null };
}

/**
 * The full id of the commit an object id (4–64 hex) names. Object names
 * only (`--disambiguate`): a branch or tag spelled like a hex id never
 * shadows the commit, and nothing parses as an option.
 */
async function commitById(cwd, value) {
  const id = String(value).trim();
  if (!/^[0-9a-f]{4,64}$/i.test(id)) throw new TypeError('A commit id is required.');
  const listed = await runGit(cwd, ['rev-parse', `--disambiguate=${id}`], { allowFailure: true });
  const commits = new Set();
  for (const candidate of String(listed.stdout).split(/\s+/).filter(Boolean)) {
    const peeled = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
      allowFailure: true,
    });
    if (peeled.code === 0) commits.add(firstLine(peeled.stdout));
  }
  if (commits.size !== 1) {
    throw new TypeError(commits.size ? `Commit ${id} is ambiguous.` : `Commit ${id} does not exist.`);
  }
  return [...commits][0];
}

/** Detached checkout of a commit id in the project folder (see checkoutProjectBranch). */
async function detachProjectFolder(projectPath, commitId) {
  const repo = await inspectRepo(projectPath);
  return withRepoLock(repo.repoCommonDir, async () => {
    const commit = await commitById(repo.projectPath, commitId);
    const head = firstLine((await runGit(repo.projectPath, ['rev-parse', 'HEAD'])).stdout);
    if (head === commit && !(await currentBranch(repo.projectPath))) {
      return { branch: null, changed: false, commit, detached: true };
    }
    await assertProjectFolderClean(repo);
    await runGit(repo.projectPath, ['switch', '--detach', commit]);
    return { branch: null, changed: true, commit, detached: true };
  });
}

/**
 * WORKTREE_DIRTY (reason `project-dirty`) while the project folder has
 * uncommitted tracked changes. No carry: `git switch` keeps compatible
 * uncommitted changes, which would silently move them onto the other commit.
 */
async function assertProjectFolderClean(repo) {
  const status = await runGit(repo.topLevel, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], {
    readOnly: true,
  });
  const dirty = parseStatusPaths(status.stdout);
  if (dirty.length) {
    throw worktreeError(
      'WORKTREE_DIRTY',
      'The project folder has uncommitted changes; commit or stash them before switching branches.',
      { reason: 'project-dirty', files: dirty.slice(0, 50), count: dirty.length }
    );
  }
}

/**
 * Coordinated checkout in the project folder. Refuses a branch that is
 * checked out in any other worktree (WORKTREE_BRANCH_OCCUPIED) and a project
 * folder with uncommitted tracked changes (WORKTREE_DIRTY, reason
 * `project-dirty`): nothing is carried to the other branch.
 *
 * `remote`: `branch` is a remote-tracking branch ("origin/x"); its local
 * branch ("x") is checked out, created to track the remote branch when it
 * does not exist yet.
 *
 * `startPoint` (with `create`): the new branch starts at that commit (a
 * history entry) instead of the checked-out one.
 *
 * `detach` (alone, no branch): check out that commit id detached (a history
 * entry), resolved by object id only; same lock and no-carry refusal.
 * @param {{ projectPath: string, branch?: string, create?: boolean, remote?: boolean, startPoint?: string|null, detach?: string|null }} input
 * @returns {Promise<{ branch: string|null, changed: boolean, commit: string, tracking?: string, detached?: true }>}
 */
export async function checkoutProjectBranch({
  projectPath,
  branch: requested,
  create = false,
  remote = false,
  startPoint = null,
  detach = null,
} = {}) {
  requireText(projectPath, 'projectPath');
  if (detach !== null) {
    if (requested !== undefined || create || remote || startPoint !== null) {
      throw new TypeError('detach excludes branch, create, remote and startPoint.');
    }
    return detachProjectFolder(projectPath, detach);
  }
  requireText(requested, 'branch');
  if (create && remote) throw new TypeError('create and remote are exclusive.');
  if (startPoint !== null && (!create || typeof startPoint !== 'string' || !startPoint.trim())) {
    throw new TypeError('startPoint needs create and a commit.');
  }
  const repo = await inspectRepo(projectPath);
  return withRepoLock(repo.repoCommonDir, async () => {
    let branch = requested;
    let tracking = null;
    let start = null;
    if (startPoint !== null) start = await commitById(repo.projectPath, startPoint);
    if (remote) {
      const ref = `refs/remotes/${requested}^{commit}`;
      const tip = await runGit(repo.projectPath, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
      if (tip.code !== 0) throw new TypeError(`Remote branch ${requested} does not exist.`);
      branch = requested.replace(/^[^/]+\//, '');
      if (!(await branchCommit(repo.projectPath, branch))) tracking = requested;
    }
    if (!(await validBranchName(repo.projectPath, branch))) throw new TypeError(`Branch name ${branch} is not valid.`);
    const current = await currentBranch(repo.projectPath);
    if (current === branch && !create) return { branch, changed: false, commit: repo.headCommit };
    let holder = (await listWorktrees(repo.projectPath)).find(
      (worktree) => worktree.branch === branch && !samePath(worktree.path, repo.topLevel)
    );
    // A stale (prunable) unmanaged registration: drop exactly that one and go on.
    if (holder?.prunable && !(await getWorktreeByPath(holder.path))) {
      if (await pruneRegistration(repo.repoCommonDir, holder.path)) holder = null;
    }
    if (holder) {
      const record = await getWorktreeByPath(holder.path);
      throw worktreeError('WORKTREE_BRANCH_OCCUPIED', `Branch ${branch} is checked out in ${holder.path}.`, {
        branch,
        path: holder.path,
        kind: record?.ownerSessionId ? 'session' : 'external',
        ...(record?.ownerSessionId ? { sessionId: record.ownerSessionId } : {}),
      });
    }
    await assertProjectFolderClean(repo);
    let args = ['switch', branch];
    if (create) args = ['switch', '-c', branch, ...(start ? [start] : [])];
    else if (tracking) args = ['switch', '-c', branch, '--track', tracking];
    await runGit(repo.projectPath, args);
    const head = await runGit(repo.projectPath, ['rev-parse', 'HEAD']);
    return { branch, changed: true, commit: firstLine(head.stdout), ...(tracking ? { tracking } : {}) };
  });
}

/**
 * Merge a worktree's branch into the project folder's checked-out `target`.
 * `projectPath` (when given) is the destination the caller guarded and the
 * user confirmed: a record of another Project folder is WORKTREE_PROJECT_MISMATCH.
 * @param {{ entryId: string, target: string, confirmed: boolean, projectPath?: string }} input
 * @returns {Promise<{ merged: boolean, commit: string|null, conflicts?: string[], upToDate?: boolean, target: string }>}
 */
export async function mergeWorktreeIntoProject({ entryId, target, confirmed, projectPath } = {}) {
  requireText(target, 'target');
  const record = await getRecord(entryId);
  if (record?.state !== 'ready') throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
  return withRepoLock(record.repoCommonDir, async () => {
    const current = await getRecord(entryId);
    if (current?.state !== 'ready') throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
    if (projectPath !== undefined && !samePath(current.projectPath, projectPath)) {
      throw worktreeError('WORKTREE_PROJECT_MISMATCH', undefined, {
        worktreeId: current.id,
        worktreeProject: current.projectPath,
        projectPath,
      });
    }
    const result = await mergeBranchIntoCheckout({
      git: gitStatusRunner,
      cwd: current.projectPath,
      source: current.branch,
      target,
      confirmed,
    });
    if (result.merged && current.mergeTarget !== target) {
      current.mergeTarget = target;
      await putRecord(current);
    }
    return result;
  });
}

/**
 * Merge any local branch `source` into the project folder's checked-out
 * `target` (the source-control dock), under the repository lock, with the
 * same preflight/--no-ff backend as a worktree merge. `target` is the branch
 * the user confirmed: the folder on another branch is WORKTREE_TARGET_MISMATCH.
 * @param {{ projectPath: string, source: string, target: string, confirmed: boolean }} input
 */
export async function mergeBranchIntoProject({ projectPath, source, target, confirmed } = {}) {
  requireText(projectPath, 'projectPath');
  requireText(source, 'source');
  requireText(target, 'target');
  const repo = await inspectRepo(projectPath);
  return withRepoLock(repo.repoCommonDir, () =>
    mergeBranchIntoCheckout({ git: gitStatusRunner, cwd: repo.projectPath, source, target, confirmed })
  );
}

/** WORKTREE_DIRTY / WORKTREE_UNMERGED for a ready worktree removal would refuse. */
async function assertRemovable(record) {
  const dirty = await dirtyPaths(record);
  if (dirty.length) {
    throw worktreeError('WORKTREE_DIRTY', undefined, {
      entryId: record.id,
      files: dirty.slice(0, 50),
      count: dirty.length,
    });
  }
  const unmerged = await unmergedCommitCount(record);
  if (unmerged > 0) {
    throw worktreeError('WORKTREE_UNMERGED', undefined, {
      entryId: record.id,
      branch: record.branch,
      mergeTarget: record.mergeTarget,
      commits: unmerged,
    });
  }
}

/** User changes, excluding the manager's own project identity and unchanged include copies. */
export async function managedWorktreeDirtyPaths(entryId) {
  const record = await getRecord(entryId);
  if (!record) throw worktreeError('WORKTREE_MISSING');
  return dirtyPaths(record);
}

// Durable references protect sleeping sessions as well as running runtimes.
// Force may discard files, never another session's workspace.
function assertNotShared(record, sessionId = record.ownerSessionId) {
  const others = new Set(record.sharedSessionIds ?? []);
  if (record.ownerSessionId) others.add(record.ownerSessionId);
  if (sessionId) others.delete(sessionId);
  if (others.size) {
    throw worktreeError('WORKTREE_BUSY_JOBS', 'Other sessions retain this worktree; its folder must be kept.', {
      reason: 'workspace-shared',
      sessions: [...others],
    });
  }
}

/**
 * The refusal removeManagedWorktree would raise, checked before anything
 * moves (a session leaves its worktree only for a removal that can proceed).
 * Unknown entries are WORKTREE_MISSING. Recovery records block even `force`
 * and non-ready entries; ordinary dirty/unmerged checks apply only to ready ones.
 * @param {{ entryId: string, force?: boolean }} input
 */
export async function assertWorktreeRemovable({ entryId, force = false, sessionId } = {}) {
  const record = await getRecord(entryId);
  if (!record) throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
  assertNotShared(record, sessionId);
  await assertRecoveryStoresClear(record);
  if (record.state !== 'ready') return;
  await assertManagedCheckoutPath(record);
  if (!force) await assertRemovable(record);
}

/**
 * Remove a managed worktree. Refuses dirty (incl. untracked and modified
 * include copies) or unmerged worktrees unless `force`. Retained file recovery
 * data blocks removal regardless of force.
 * `expected` ({ kind, txId, holderSessionId }) pins the record the caller
 * selected: one that no longer matches under the repository lock (removed,
 * its slug reused) is left alone and reported `{ removed: false, skipped: true }`.
 * @param {{ entryId: string, force?: boolean, expected?: { kind?: string, txId?: string, holderSessionId?: string }|null }} input
 * @returns {Promise<{ removed: boolean, skipped?: boolean, retryable?: boolean, remaining?: object[], branchDeleted?: boolean }>}
 */
export async function removeManagedWorktree({
  entryId,
  force = false,
  sessionId,
  preserveBranch = false,
  safeOnly = false,
  expected = null,
} = {}) {
  const skipped = { removed: false, skipped: true };
  const matches = (record) =>
    !expected ||
    (record.kind === expected.kind &&
      record.txId === expected.txId &&
      record.holderSessionId === expected.holderSessionId);
  const record = await getRecord(entryId);
  if (!record) {
    if (expected) return skipped;
    throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
  }
  return withRepoLock(record.repoCommonDir, async () => {
    const current = await getRecord(entryId);
    if (!current || !matches(current)) {
      if (!current && !expected) throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
      return skipped;
    }
    return removeLocked(current, { force, sessionId, preserveBranch, safeOnly });
  });
}

/** The removal of `current`, under its repository lock. */
async function removeLocked(current, { force, sessionId, preserveBranch = false, safeOnly = false }) {
  assertNotShared(current, sessionId);
  if (current.state === 'creating' || current.state === 'recovery') {
    const rollback = await rollbackCreation(current);
    return rollback.complete ? { removed: true } : { removed: false, retryable: true, remaining: rollback.remaining };
  }
  // Every deletion attempt of a snapshot, a resumed one included, waits
  // for (refuses on) its consumers.
  const release = current.kind === WORKTREE_SNAPSHOT_KIND ? await holdSnapshotFolder(current) : () => {};
  try {
    return await decideAndFinishDeletion(current, { force, preserveBranch, safeOnly });
  } finally {
    await release();
  }
}

/**
 * Remove a worktree whose owner is gone, on an explicit request: under the
 * repository lock its retention is read again right before anything moves,
 * so an owner that came back (a live session, a running lease holder) or a
 * session the store still keeps it for refuses (WORKTREE_BUSY_JOBS). Then
 * the ordinary removal guards apply (dirty or unmerged work needs `force`).
 * @param {{ entryId: string, force?: boolean, liveSessionIds?: string[], retainedSessionIds?: string[] }} input
 */
export async function removeOrphanedWorktree({
  entryId,
  force = false,
  liveSessionIds = [],
  retainedSessionIds = [],
} = {}) {
  const record = await getRecord(entryId);
  if (!record) throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
  return withRepoLock(record.repoCommonDir, async () => {
    const current = await getRecord(entryId);
    if (!current || current.kind === WORKTREE_SNAPSHOT_KIND) {
      throw worktreeError('WORKTREE_MISSING', undefined, { entryId });
    }
    const { ownerLive, removable } = await retentionOf(current, new Set(liveSessionIds), new Set(retainedSessionIds));
    if (ownerLive) throw worktreeRefusal('workspace-lease', { entryId });
    if (!removable) {
      // Retained recovery data names itself; otherwise sessions still keep it.
      await assertRecoveryStoresClear(current);
      throw worktreeRefusal('workspace-retained', {
        entryId,
        sessions: [current.ownerSessionId, ...(current.sharedSessionIds ?? [])].filter(Boolean),
      });
    }
    return removeLocked(current, { force });
  });
}

/** Mark a ready worktree `deleting` (after its guards), then finish the deletion. */
async function decideAndFinishDeletion(current, { force, preserveBranch, safeOnly }) {
  if (current.state === 'ready') {
    await assertRecoveryStoresClear(current);
    await assertManagedCheckoutPath(current);
    if (!force) await assertRemovable(current);
    current.state = 'deleting';
    current.deleting = { force: force === true, preserveBranch, safeOnly, startedAt: Date.now(), remaining: [] };
    await putRecord(current);
  }
  return finishDeletion(current);
}

/** A lease whose recorded process still runs. */
function leaseProcessAlive(lease) {
  return !!lease?.pid && config.processAlive(lease.pid);
}

/**
 * Every managed worktree with who keeps it: `retained` (its session is in
 * `retainedSessionIds`, i.e. still in the session store), `ownerLive` (a
 * live session or a running lease holder), and `removable` (what a prune
 * would remove: neither, or disposable and not live, with no retained recovery data).
 * @param {{ liveSessionIds?: string[], retainedSessionIds?: string[] }} input
 */
export async function listManagedWorktrees({ liveSessionIds = [], retainedSessionIds = [] } = {}) {
  const live = new Set(liveSessionIds);
  const retained = new Set(retainedSessionIds);
  const rows = [];
  for (const record of Object.values((await readRegistry()).entries)) {
    const { ownerLive, retained: isRetained, removable } = await retentionOf(record, live, retained);
    rows.push({
      ...entryView(record),
      projectPath: record.projectPath,
      retained: isRetained,
      ownerLive,
      removable,
    });
  }
  return rows;
}

/** Who keeps `record` (listManagedWorktrees): `live` and `retained` are session id sets. */
async function retentionOf(record, live, retained) {
  const snapshot = record.kind === WORKTREE_SNAPSHOT_KIND;
  const ownerLive = snapshot
    ? await snapshotHolderLive(record, live)
    : (!!record.ownerSessionId && live.has(record.ownerSessionId)) || leaseProcessAlive(await readOwnerLease(record));
  const isRetained = !!record.ownerSessionId && retained.has(record.ownerSessionId);
  // A snapshot outlives no holder: the prune removes it, changes and all.
  let removable = snapshot
    ? !ownerLive
    : !record.sharedSessionIds?.length &&
      (record.state !== 'ready' || (!ownerLive && (record.disposable === true || !isRetained)));
  if (removable) {
    try {
      await assertRecoveryStoresClear(record);
    } catch (error) {
      if (error?.code !== 'WORKTREE_FILE_RECOVERY') throw error;
      removable = false;
    }
  }
  return { ownerLive, retained: isRetained, removable };
}

/**
 * Conservative reconcile (daemon startup, and the manual prune). Always:
 * resumes interrupted deletions, rolls back interrupted creations of no
 * retained session, releases leases of owners that are neither live nor
 * running, prunes stale managed registrations. `removeOrphans` (the
 * autoCleanup setting at startup; true for a manual prune) also removes
 * clean, merged worktrees that no stored session retains (or that a deleted
 * session left marked disposable) and whose owner is not live — never one a
 * session in the store still references. A snapshot whose holder is neither
 * live nor running in another process is removed in either mode.
 * `repoCommonDir` limits the whole reconcile to that repository.
 * @param {{ liveSessionIds?: string[], retainedSessionIds?: string[], removeOrphans?: boolean, repoCommonDir?: string|null }} input
 */
export async function reconcileManagedWorktrees({
  liveSessionIds = [],
  retainedSessionIds = [],
  removeOrphans = false,
  repoCommonDir: onlyRepo = null,
} = {}) {
  const live = new Set(liveSessionIds);
  const retained = new Set(retainedSessionIds);
  const report = { removed: [], recovered: [], kept: [], leasesReleased: [], pruned: [], missing: [], errors: [] };
  const reportDeletion = (record, result) => {
    if (result.removed) report.removed.push(record.id);
    else report.kept.push({ id: record.id, reason: 'deleting', remaining: result.remaining });
  };
  const byRepo = new Map();
  for (const record of Object.values((await readRegistry()).entries)) {
    const key = pathKey(record.repoCommonDir);
    if (onlyRepo && key !== pathKey(onlyRepo)) continue;
    if (!byRepo.has(key)) byRepo.set(key, record.repoCommonDir);
  }
  for (const [key, repoCommonDir] of byRepo) {
    if (!existsSync(repoCommonDir)) {
      report.errors.push({ repoCommonDir, error: 'repository missing' });
      continue;
    }
    try {
      await withRepoLock(repoCommonDir, async () => {
        const records = Object.values((await readRegistry()).entries).filter(
          (record) => pathKey(record.repoCommonDir) === key
        );
        for (const record of records) {
          const isRetained = !!record.ownerSessionId && retained.has(record.ownerSessionId);
          try {
            if (record.sharedSessionIds?.length) {
              report.kept.push({ id: record.id, reason: 'shared' });
              continue;
            }
            if (record.state === 'creating' || record.state === 'recovery') {
              if (isRetained) {
                report.kept.push({ id: record.id, reason: 'retained' });
                continue;
              }
              // Holding the repository lock proves no creator is still running.
              const result = await rollbackCreation(record);
              if (result.complete) report.recovered.push(record.id);
              else report.kept.push({ id: record.id, reason: 'recovery', remaining: result.remaining });
              continue;
            }
            if (record.state === 'deleting' && record.kind === WORKTREE_SNAPSHOT_KIND) {
              // An unfinished snapshot deletion: whatever entered the
              // surviving folder since still keeps it.
              let release;
              try {
                release = await holdSnapshotFolder(record);
              } catch (error) {
                if (!snapshotInUse(error)) throw error;
                report.kept.push({ id: record.id, reason: 'snapshot-in-use' });
                continue;
              }
              try {
                reportDeletion(record, await finishDeletion(record));
              } finally {
                await release();
              }
              continue;
            }
            if (record.state === 'deleting') {
              // A decided deletion: its session already left the folder.
              reportDeletion(record, await finishDeletion(record));
              continue;
            }
            if (record.kind === WORKTREE_SNAPSHOT_KIND) {
              // Read-only and turn-scoped: once its holder is gone it goes,
              // whatever autoCleanup says and whatever was changed in it.
              // A worker or background shell still running in it keeps it too.
              let release = null;
              if (!(await snapshotHolderLive(record, live))) {
                try {
                  release = await holdSnapshotFolder(record);
                } catch (error) {
                  if (!snapshotInUse(error)) throw error;
                }
              }
              if (!release) {
                report.kept.push({ id: record.id, reason: 'snapshot-in-use' });
                continue;
              }
              try {
                await assertRecoveryStoresClear(record);
                record.state = 'deleting';
                record.deleting = { force: true, startedAt: Date.now(), remaining: [] };
                await putRecord(record);
                reportDeletion(record, await finishDeletion(record));
              } finally {
                await release();
              }
              continue;
            }
            const lease = await readOwnerLease(record);
            const ownerLive = (!!record.ownerSessionId && live.has(record.ownerSessionId)) || leaseProcessAlive(lease);
            if (!ownerLive && lease) {
              await removeOwnerLease(record);
              report.leasesReleased.push(record.id);
            }
            if (!existsSync(record.path)) report.missing.push(record.id);
            if (removeOrphans === true && !ownerLive && (record.disposable === true || !isRetained)) {
              const dirty = await dirtyPaths(record);
              const unmerged = await unmergedCommitCount(record);
              if (dirty.length || unmerged > 0) {
                report.kept.push({ id: record.id, reason: dirty.length ? 'dirty' : 'unmerged' });
                continue;
              }
              await assertRecoveryStoresClear(record);
              record.state = 'deleting';
              record.deleting = { force: false, startedAt: Date.now(), remaining: [] };
              await putRecord(record);
              reportDeletion(record, await finishDeletion(record));
            }
          } catch (error) {
            report.errors.push({ id: record.id, error: String(error?.message || error) });
          }
        }
        for (const stale of await staleManagedRegistrations(repoCommonDir)) {
          if (await pruneRegistration(repoCommonDir, stale)) report.pruned.push(canonicalPath(stale));
        }
      });
    } catch (error) {
      report.errors.push({ repoCommonDir, error: String(error?.message || error) });
    }
  }
  return report;
}
