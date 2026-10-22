/**
 * Shared contracts for Lead-session git worktrees.
 *
 * Pure shapes, validators and constants every worktree scope builds on: the
 * session workspace record (kept separate from project identity), the managed
 * worktree registry entry, the owner record, the branch occupancy DTO, stable
 * error codes, the managed path layout and the per-root cleanup registry.
 * Nothing here touches git or the filesystem.
 */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isPlainObject } from '../object.mjs';
import { resolvePluginData } from '../plugin-paths.mjs';

/** Versioned directory under the data dir that holds every managed worktree. */
export const WORKTREE_STORE_DIR = 'worktrees-v1';
/** Default ref prefix for branches created for managed worktrees. */
export const DEFAULT_WORKTREE_BRANCH_PREFIX = 'mixdog/';

export const WORKSPACE_TRANSITION_STATES = Object.freeze(['idle', 'provisioning', 'switching', 'removing', 'recovery']);
const WORKTREE_ENTRY_STATES = Object.freeze(['creating', 'ready', 'deleting', 'recovery']);

/**
 * Stable error codes. Clients branch on `error.code`, never on message text.
 * @readonly
 */
export const WORKTREE_ERROR_CODES = Object.freeze({
  WORKTREE_BUSY_JOBS: 'WORKTREE_BUSY_JOBS',
  WORKTREE_BRANCH_OCCUPIED: 'WORKTREE_BRANCH_OCCUPIED',
  WORKTREE_DISK_INSUFFICIENT: 'WORKTREE_DISK_INSUFFICIENT',
  WORKTREE_LARGE_REPO_CONFIRM: 'WORKTREE_LARGE_REPO_CONFIRM',
  WORKTREE_DIRTY: 'WORKTREE_DIRTY',
  WORKTREE_DIRTY_CHOICE: 'WORKTREE_DIRTY_CHOICE',
  WORKTREE_FILE_RECOVERY: 'WORKTREE_FILE_RECOVERY',
  WORKTREE_UNMERGED: 'WORKTREE_UNMERGED',
  WORKTREE_MISSING: 'WORKTREE_MISSING',
  WORKTREE_UNSUPPORTED_REPO: 'WORKTREE_UNSUPPORTED_REPO',
  WORKTREE_REVISION_CONFLICT: 'WORKTREE_REVISION_CONFLICT',
  WORKTREE_NOT_IMPLEMENTED: 'WORKTREE_NOT_IMPLEMENTED',
  WORKTREE_CONFIRM_REQUIRED: 'WORKTREE_CONFIRM_REQUIRED',
  WORKTREE_TARGET_MISMATCH: 'WORKTREE_TARGET_MISMATCH',
  WORKTREE_PROJECT_MISMATCH: 'WORKTREE_PROJECT_MISMATCH',
  WORKTREE_PARTIAL_TRANSITION: 'WORKTREE_PARTIAL_TRANSITION',
  WORKTREE_PROJECT_UNKNOWN: 'WORKTREE_PROJECT_UNKNOWN',
  WORKTREE_REMOVAL_INCOMPLETE: 'WORKTREE_REMOVAL_INCOMPLETE',
  WORKTREE_PATH_UNSAFE: 'WORKTREE_PATH_UNSAFE',
  MERGE_CONFLICT: 'MERGE_CONFLICT',
  MERGE_TARGET_DIRTY: 'MERGE_TARGET_DIRTY',
  MERGE_FAILED: 'MERGE_FAILED',
});

/** @typedef {keyof typeof WORKTREE_ERROR_CODES} WorktreeErrorCode */

const DEFAULT_ERROR_MESSAGES = Object.freeze({
  WORKTREE_BUSY_JOBS: 'The session has running jobs; wait for them or stop them before changing its workspace.',
  WORKTREE_BRANCH_OCCUPIED: 'The branch is checked out in another worktree.',
  WORKTREE_DISK_INSUFFICIENT: 'Not enough free disk space to create the worktree.',
  WORKTREE_LARGE_REPO_CONFIRM: 'The repository is large; confirm before creating a worktree.',
  WORKTREE_DIRTY: 'The worktree has uncommitted changes.',
  WORKTREE_DIRTY_CHOICE:
    'The project folder has uncommitted changes; choose whether to leave them there or carry them into the worktree.',
  WORKTREE_FILE_RECOVERY:
    'Retained file recovery records block worktree removal, including force. Inspect and explicitly delete them first.',
  WORKTREE_UNMERGED: 'The worktree branch has commits that are not merged.',
  WORKTREE_MISSING: 'The managed worktree no longer exists.',
  WORKTREE_UNSUPPORTED_REPO: 'This repository does not support managed worktrees.',
  WORKTREE_REVISION_CONFLICT: 'The session workspace changed; reload and try again.',
  WORKTREE_NOT_IMPLEMENTED: 'Worktree support is not implemented yet.',
  WORKTREE_CONFIRM_REQUIRED: 'A merge requires explicit confirmation.',
  WORKTREE_TARGET_MISMATCH: 'The project folder is not on the branch the merge was confirmed for.',
  WORKTREE_PROJECT_MISMATCH: 'The retained worktree belongs to another project or repository.',
  WORKTREE_PARTIAL_TRANSITION: 'The branch change failed part-way; the project folder stayed on the new branch.',
  WORKTREE_PROJECT_UNKNOWN: 'Project is not available.',
  WORKTREE_REMOVAL_INCOMPLETE:
    'The worktree was only partly removed (a file or folder is still in use); remove it again to finish.',
  WORKTREE_PATH_UNSAFE: 'The worktree folder is not a managed checkout of this repository; nothing was deleted.',
  MERGE_CONFLICT: 'The merge would conflict.',
  MERGE_TARGET_DIRTY: 'The merge target has uncommitted changes.',
  MERGE_FAILED: 'The merge failed; the project folder is unchanged.',
});

/** Typed worktree failure; `code` is one of WORKTREE_ERROR_CODES. */
export class WorktreeError extends Error {
  /**
   * @param {WorktreeErrorCode} code
   * @param {string} [message]
   * @param {Record<string, unknown>} [details] JSON-safe context (paths, branch, counts).
   */
  constructor(code, message, details) {
    super(message || DEFAULT_ERROR_MESSAGES[code] || code);
    this.name = 'WorktreeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Build a typed worktree error. Unknown codes are a programming error.
 * @param {WorktreeErrorCode} code
 * @param {string} [message]
 * @param {Record<string, unknown>} [details]
 * @returns {WorktreeError}
 */
export function worktreeError(code, message, details) {
  if (!Object.hasOwn(WORKTREE_ERROR_CODES, code)) throw new TypeError(`Unknown worktree error code "${code}".`);
  return new WorktreeError(code, message, details);
}

/**
 * Why a workspace management action (merge, folder cleanup, branch deletion,
 * checkout) was refused because something still uses an affected folder. Every
 * surface shows the same meaning: the runtime throws exactly this text (TUI,
 * remote) and the desktop translates the same English source string.
 * @readonly
 */
export const WORKTREE_REFUSAL_REASONS = Object.freeze({
  'workspace-retained': 'Sessions still retain this folder. Close or remove those sessions before cleaning it up.',
  'workspace-lease': 'A runtime still holds this folder. Stop its work and release the workspace first.',
  'folder-in-use': 'Sessions or workers still use an affected folder. Finish or move them before continuing.',
  'folder-shell-jobs': 'Background commands still use an affected folder. Wait for them or stop them first.',
  'workspace-admission-unreadable': 'Workspace activity cannot be verified. Nothing was changed.',
});

/**
 * WORKTREE_BUSY_JOBS with the shared text of `reason` (WORKTREE_REFUSAL_REASONS).
 * @param {keyof typeof WORKTREE_REFUSAL_REASONS} reason
 * @param {Record<string, unknown>} [details]
 */
export function worktreeRefusal(reason, details = {}) {
  if (!Object.hasOwn(WORKTREE_REFUSAL_REASONS, reason)) throw new TypeError(`Unknown refusal reason "${reason}".`);
  return worktreeError('WORKTREE_BUSY_JOBS', WORKTREE_REFUSAL_REASONS[reason], { ...details, reason });
}

/**
 * @param {unknown} error
 * @param {WorktreeErrorCode} [code] When given, also require this code.
 * @returns {boolean}
 */
export function isWorktreeError(error, code) {
  const actual = /** @type {{code?: unknown}} */ (error)?.code;
  if (typeof actual !== 'string' || !Object.hasOwn(WORKTREE_ERROR_CODES, actual)) return false;
  return code === undefined || actual === code;
}

// ---------------------------------------------------------------------------
// Field validators

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function nullableText(value, name) {
  return value === undefined || value === null ? null : text(value, name);
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw new TypeError(`${name} must be one of ${allowed.join(', ')}.`);
  return value;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function nullableCommit(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a full lowercase commit id.`);
  }
  return value;
}

function record(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

// ---------------------------------------------------------------------------
// Session workspace

/**
 * @typedef {'idle'|'provisioning'|'switching'|'removing'|'recovery'} WorkspaceTransitionState
 * @typedef {{ state: WorkspaceTransitionState, txId: string|null }} WorkspaceTransition
 *   `txId` is null exactly when `state` is idle.
 */

/**
 * Where a Lead session executes. Project identity (`projectPath`) stays the
 * registered Project even while `cwd` points into a managed worktree.
 * @typedef {object} SessionWorkspace
 * @property {string} projectPath Registered Project root.
 * @property {string|null} repoCommonDir Canonical git common dir; null outside a git repository.
 * @property {string} cwd Execution root for the Lead and its agents.
 * @property {string|null} worktreeId Managed worktree id; null when running in the project folder.
 * @property {string|null} branch Checked-out branch at `cwd`; null when detached or not a repository.
 * @property {string|null} baseCommit Commit the worktree branch was created from.
 * @property {string|null} mergeTarget Branch the worktree merges into (the project folder's branch).
 * @property {number} revision Monotonic; advances on every committed workspace change.
 * @property {WorkspaceTransition} transition In-flight transition marker.
 */

/**
 * Validate and normalize a session workspace record. Throws TypeError on any
 * invalid field or broken invariant; returns a fresh plain object.
 * @param {unknown} input
 * @returns {SessionWorkspace}
 */
export function normalizeSessionWorkspace(input) {
  const value = record(input, 'workspace');
  const transitionInput = value.transition === undefined ? { state: 'idle', txId: null } : value.transition;
  const transitionRecord = record(transitionInput, 'workspace.transition');
  const state = oneOf(transitionRecord.state, WORKSPACE_TRANSITION_STATES, 'workspace.transition.state');
  const txId = nullableText(transitionRecord.txId, 'workspace.transition.txId');
  if ((state === 'idle') !== (txId === null)) {
    throw new TypeError('workspace.transition.txId must be null exactly when the state is idle.');
  }
  const revision = value.revision === undefined ? 0 : value.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('workspace.revision must be a non-negative integer.');
  }
  const workspace = {
    projectPath: text(value.projectPath, 'workspace.projectPath'),
    repoCommonDir: nullableText(value.repoCommonDir, 'workspace.repoCommonDir'),
    cwd: text(value.cwd, 'workspace.cwd'),
    worktreeId: nullableText(value.worktreeId, 'workspace.worktreeId'),
    branch: nullableText(value.branch, 'workspace.branch'),
    baseCommit: nullableCommit(value.baseCommit, 'workspace.baseCommit'),
    mergeTarget: nullableText(value.mergeTarget, 'workspace.mergeTarget'),
    revision,
    transition: { state, txId },
  };
  if (workspace.worktreeId !== null && (workspace.repoCommonDir === null || workspace.branch === null)) {
    throw new TypeError('A worktree-bound workspace requires repoCommonDir and branch.');
  }
  return workspace;
}

/**
 * The project-folder workspace a new Lead session starts in.
 * @param {{ projectPath: string, cwd?: string, repoCommonDir?: string|null, branch?: string|null }} input
 * @returns {SessionWorkspace}
 */
export function projectWorkspace({ projectPath, cwd = projectPath, repoCommonDir = null, branch = null }) {
  return normalizeSessionWorkspace({ projectPath, cwd, repoCommonDir, branch, revision: 0 });
}

/** @param {SessionWorkspace|null|undefined} workspace */
export function isWorktreeBound(workspace) {
  return typeof workspace?.worktreeId === 'string' && workspace.worktreeId.length > 0;
}

/** @param {SessionWorkspace} workspace @returns {number} The revision a committed change must carry. */
export function nextRevision(workspace) {
  const revision = workspace?.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('workspace.revision is invalid.');
  return revision + 1;
}

// ---------------------------------------------------------------------------
// Managed worktree registry entry and owner

/**
 * @typedef {'creating'|'ready'|'deleting'|'recovery'} WorktreeEntryState
 * @typedef {object} WorktreeEntry
 * @property {string} id Slug, unique per repository.
 * @property {string} repoCommonDir
 * @property {string} projectPath
 * @property {string} path Absolute worktree folder (see managedWorktreePath).
 * @property {string|null} branch Full branch name, e.g. "mixdog/fix-login"; null only for a snapshot.
 * @property {string|null} baseCommit
 * @property {number} createdAt Epoch milliseconds.
 * @property {string|null} ownerSessionId Lead session that retains it; null once released (and for a snapshot).
 * @property {WorktreeEntryState} state
 * @property {'snapshot'} [kind] A read-only detached checkout of `baseCommit`
 *   (WORKTREE_SNAPSHOT_KIND): no branch, bound to no session, removed with
 *   the turn that made it.
 */

/** `kind` of a managed read-only snapshot: a detached checkout no session works in. */
export const WORKTREE_SNAPSHOT_KIND = 'snapshot';

/**
 * @param {unknown} input
 * @returns {WorktreeEntry}
 */
export function normalizeWorktreeEntry(input) {
  const value = record(input, 'worktree');
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw new TypeError('worktree.createdAt must be epoch milliseconds.');
  }
  const id = text(value.id, 'worktree.id');
  const idError = worktreeNameError(id);
  if (idError) throw new TypeError(`worktree.id is invalid: ${idError}`);
  const snapshot = value.kind === WORKTREE_SNAPSHOT_KIND;
  return {
    id,
    repoCommonDir: text(value.repoCommonDir, 'worktree.repoCommonDir'),
    projectPath: text(value.projectPath, 'worktree.projectPath'),
    path: text(value.path, 'worktree.path'),
    branch: snapshot ? nullableText(value.branch, 'worktree.branch') : text(value.branch, 'worktree.branch'),
    baseCommit: nullableCommit(value.baseCommit, 'worktree.baseCommit'),
    createdAt: value.createdAt,
    ownerSessionId: nullableText(value.ownerSessionId, 'worktree.ownerSessionId'),
    state: oneOf(value.state, WORKTREE_ENTRY_STATES, 'worktree.state'),
    ...(snapshot ? { kind: WORKTREE_SNAPSHOT_KIND } : {}),
  };
}

/**
 * Session-scoped ownership: a restarted runtime of the same session keeps the
 * worktree; `runtimeToken` tells a live owner from a stale one and `pid` is a
 * liveness hint only.
 * @typedef {{ sessionId: string, runtimeToken: string, pid: number|null }} WorktreeOwner
 */

/**
 * @param {unknown} input
 * @returns {WorktreeOwner}
 */
export function normalizeWorktreeOwner(input) {
  const value = record(input, 'owner');
  const pid = value.pid === undefined || value.pid === null ? null : value.pid;
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) {
    throw new TypeError('owner.pid must be a positive integer or null.');
  }
  return {
    sessionId: text(value.sessionId, 'owner.sessionId'),
    runtimeToken: text(value.runtimeToken, 'owner.runtimeToken'),
    pid,
  };
}

// ---------------------------------------------------------------------------
// Branch occupancy

/**
 * Who holds a branch. `current`: checked out in the project folder; `session`:
 * a managed worktree retained by `sessionId`; `external`: another worktree not
 * managed by Mixdog; `free`: not checked out anywhere.
 * @typedef {'current'|'session'|'external'|'free'} BranchOccupancyKind
 * @typedef {{ branch: string, kind: BranchOccupancyKind, sessionId?: string, path?: string }} BranchOccupancy
 */

/**
 * The branch menu's rows (the desktop DesktopGitBranch shape) for the local
 * branch names the manager lists: `current` marks the branch checked out in
 * the project folder; managed lists hold local branches only.
 * @param {string[]} names
 * @param {BranchOccupancy[]} occupancy
 * @returns {Array<{ name: string, current: boolean, remote: false, upstream: string }>}
 */
export function branchMenuEntries(names, occupancy) {
  const current = new Set(occupancy.filter((row) => row.kind === 'current').map((row) => row.branch));
  return names.map((name) => ({ name, current: current.has(name), remote: false, upstream: '' }));
}

// ---------------------------------------------------------------------------
// Names and managed paths

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORKTREE_NAME_MAX_LENGTH = 64;

/**
 * Why `name` cannot be a worktree slug (folder name and branch suffix), or
 * null when it can.
 * @param {unknown} name
 * @returns {string|null}
 */
export function worktreeNameError(name) {
  if (typeof name !== 'string' || !name) return 'a name is required';
  if (name.length > WORKTREE_NAME_MAX_LENGTH) return `at most ${WORKTREE_NAME_MAX_LENGTH} characters`;
  if (!NAME_PATTERN.test(name)) return 'use letters, digits, ".", "_" or "-", starting with a letter or digit';
  if (name.includes('..') || name.endsWith('.') || name.toLowerCase().endsWith('.lock')) {
    return 'not a valid git branch component';
  }
  return null;
}

/**
 * Stable short hash of a canonical git common dir. Case-insensitive on
 * Windows, where the same repository may be spelled with different casing.
 * @param {string} repoCommonDir
 * @param {NodeJS.Platform} [platform]
 * @returns {string} 16 lowercase hex characters.
 */
export function repoHash(repoCommonDir, platform = process.platform) {
  let key = resolve(text(repoCommonDir, 'repoCommonDir')).replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32') key = key.toLowerCase();
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * <dataDir>/worktrees-v1/<repoHash> — the root that holds one repository's
 * managed worktrees and the unit runRootCleanups operates on.
 * @param {string} repoCommonDir
 * @param {{ dataDir?: string, platform?: NodeJS.Platform }} [options]
 */
export function managedWorktreeRoot(repoCommonDir, { dataDir = resolvePluginData(), platform } = {}) {
  return join(dataDir, WORKTREE_STORE_DIR, repoHash(repoCommonDir, platform));
}

/**
 * <dataDir>/worktrees-v1/<repoHash>/<slug>
 * @param {string} repoCommonDir
 * @param {string} slug
 * @param {{ dataDir?: string, platform?: NodeJS.Platform }} [options]
 */
export function managedWorktreePath(repoCommonDir, slug, options) {
  const error = worktreeNameError(slug);
  if (error) throw new TypeError(`worktree name is invalid: ${error}`);
  return join(managedWorktreeRoot(repoCommonDir, options), slug);
}

/**
 * @param {string} slug
 * @param {string} [prefix]
 * @returns {string} e.g. "mixdog/fix-login"
 */
export function worktreeBranchName(slug, prefix = DEFAULT_WORKTREE_BRANCH_PREFIX) {
  const error = worktreeNameError(slug);
  if (error) throw new TypeError(`worktree name is invalid: ${error}`);
  return `${prefix}${slug}`;
}

// ---------------------------------------------------------------------------
// Root cleanup registry

/**
 * Cleanup a module performs for one managed root (or a worktree path inside
 * it) when that root is removed: caches, indexes, snapshots keyed by path.
 * @callback RootCleanup
 * @param {string} root Absolute path being removed.
 * @param {{ signal?: AbortSignal, reason?: string } & Record<string, unknown>} ctx
 * @returns {Promise<unknown>|unknown} JSON-safe result for diagnostics.
 */

/**
 * @typedef {{ name: string, ok: true, result: unknown } | { name: string, ok: false, error: { code: string|null, message: string } }} RootCleanupResult
 */

/** A fresh, independent registry (tests and isolated hosts). */
export function createRootCleanupRegistry() {
  /** @type {Map<string, RootCleanup>} */
  const cleanups = new Map();
  return {
    /**
     * @param {string} name Unique module name.
     * @param {RootCleanup} cleanup
     * @returns {() => void} Unregister.
     */
    register(name, cleanup) {
      text(name, 'cleanup name');
      if (typeof cleanup !== 'function') throw new TypeError('cleanup must be a function.');
      if (cleanups.has(name)) throw new TypeError(`Root cleanup "${name}" is already registered.`);
      cleanups.set(name, cleanup);
      return () => {
        if (cleanups.get(name) === cleanup) cleanups.delete(name);
      };
    },
    /**
     * Run every registered cleanup in registration order. One failure never
     * stops the rest; each module reports its own result.
     * @param {string} root
     * @param {Record<string, unknown>} [ctx]
     * @returns {Promise<RootCleanupResult[]>}
     */
    async run(root, ctx = {}) {
      text(root, 'root');
      const results = [];
      for (const [name, cleanup] of [...cleanups]) {
        try {
          results.push({ name, ok: true, result: (await cleanup(root, ctx)) ?? null });
        } catch (error) {
          results.push({
            name,
            ok: false,
            error: {
              code: typeof error?.code === 'string' ? error.code : null,
              message: String(error?.message || error),
            },
          });
        }
      }
      return results;
    },
    /** @returns {string[]} */
    names() {
      return [...cleanups.keys()];
    },
  };
}

const processRootCleanups = createRootCleanupRegistry();

/**
 * Register a process-wide cleanup for removed worktree roots.
 * @param {string} name
 * @param {RootCleanup} cleanup
 * @returns {() => void} Unregister.
 */
export function registerRootCleanup(name, cleanup) {
  return processRootCleanups.register(name, cleanup);
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} [ctx]
 * @returns {Promise<RootCleanupResult[]>}
 */
export function runRootCleanups(root, ctx) {
  return processRootCleanups.run(root, ctx);
}

const processRootReleasers = createRootCleanupRegistry();

/**
 * Register a process-wide releaser: it drops live handles that keep a root
 * open (desktop terminals started there). Releasers run before the root
 * cleanups and before the checkout is removed.
 * @param {string} name
 * @param {RootCleanup} releaser
 * @returns {() => void} Unregister.
 */
export function registerRootReleaser(name, releaser) {
  return processRootReleasers.register(name, releaser);
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} [ctx]
 * @returns {Promise<RootCleanupResult[]>}
 */
export function runRootReleasers(root, ctx) {
  return processRootReleasers.run(root, ctx);
}

// ---------------------------------------------------------------------------
// Transition API (interface only; implemented by the workspace transition scope)

/**
 * Where a transition moves the session.
 * @typedef {{ kind: 'branch', branch: string, create?: boolean }
 *   | { kind: 'worktree', name?: string|null }
 *   | { kind: 'remove-worktree', force?: boolean }} WorkspaceTransitionTarget
 *   `branch`: run in the project folder on `branch` (the worktree stays retained);
 *   `create: true` first creates `branch` from the project folder's current branch;
 *   `worktree`: run in this Lead's retained worktree, creating it (optionally named) on first use;
 *   `remove-worktree`: delete the retained worktree after dirty/unmerged checks.
 */

/**
 * What happens to the project folder's uncommitted changes (tracked and
 * untracked, ignored files excluded) when a session moves into a new
 * worktree: `leave` keeps them in the project folder (the worktree starts at
 * its HEAD); `carry` moves them into the worktree.
 * @typedef {'leave'|'carry'} WorktreeCarryChoice
 */
export const WORKTREE_CARRY_CHOICES = Object.freeze(['leave', 'carry']);

/**
 * requestWorktree input.
 * @typedef {object} RequestWorktreeInput
 * @property {string|null} [name]
 * @property {number} [expectedRevision]
 * @property {boolean} [confirmLarge] Acknowledges WORKTREE_LARGE_REPO_CONFIRM.
 * @property {boolean} [provision] Create and enter the worktree now (the session moves) instead of at the next send.
 * @property {WorktreeCarryChoice} [carryChanges] Answers WORKTREE_DIRTY_CHOICE (`details: { count, paths }`,
 *   `paths` capped to a preview), which a provisioning request without it raises while the project checkout has
 *   uncommitted changes. Scope is the whole repository checkout; ignored files (dependencies, build output, env
 *   files) are never carried and stay in the project folder.
 */

/**
 * mergeWorkspace's `cleanup` after a successful merge: `removed: false` keeps
 * the worktree and reports why (`code` of the refusal, e.g. WORKTREE_DIRTY,
 * WORKTREE_UNMERGED, WORKTREE_REMOVAL_INCOMPLETE); the merge stands.
 * @typedef {{ removed: boolean, code?: string, message?: string }} MergeCleanupResult
 */

/**
 * @typedef {object} WorkspaceTransitionOptions
 * @property {number} [expectedRevision] Reject with WORKTREE_REVISION_CONFLICT when the session moved on.
 * @property {boolean} [confirmLarge] Acknowledges WORKTREE_LARGE_REPO_CONFIRM.
 * @property {AbortSignal} [signal]
 */

/**
 * Serialized, revisioned workspace change for one Lead session. Fails with a
 * WorktreeError (WORKTREE_BUSY_JOBS, WORKTREE_BRANCH_OCCUPIED, ...) and leaves
 * the previous workspace intact on failure.
 * @callback ApplyWorkspaceTransition
 * @param {{ sessionId: string }} sessionRef
 * @param {WorkspaceTransitionTarget} target
 * @param {WorkspaceTransitionOptions} [options]
 * @returns {Promise<{ revision: number, workspace: SessionWorkspace }>}
 */
