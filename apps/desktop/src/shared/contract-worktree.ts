// Lead-session git worktrees: workspace and branch-occupancy DTOs, the
// capability names the branch chip menu calls, and their argument shapes.
// Mirrors src/runtime/shared/worktrees/contract.mjs and settings.mjs.
import type { DesktopGitBranch } from './contract-git';

export type DesktopWorkspaceTransitionState = 'idle' | 'provisioning' | 'switching' | 'removing' | 'recovery';

/** Where a Lead session executes. `projectPath` stays the registered Project
 *  even while `cwd` points into the session's managed worktree. */
export interface DesktopSessionWorkspace {
  projectPath: string;
  /** Canonical git common dir; null outside a git repository. */
  repoCommonDir: string | null;
  /** Execution root of the Lead and its agents. */
  cwd: string;
  /** Managed worktree id; null while running in the project folder. */
  worktreeId: string | null;
  branch: string | null;
  baseCommit: string | null;
  /** Branch a worktree merges into: the project folder's checked-out branch. */
  mergeTarget: string | null;
  /** Monotonic; pass it back as `expectedRevision` to detect a stale menu. */
  revision: number;
  transition: { state: DesktopWorkspaceTransitionState; txId: string | null };
}

export type DesktopBranchOccupancyKind = 'current' | 'session' | 'external' | 'free';

/** Who holds a branch: the project folder (`current`), a Lead session's
 *  managed worktree (`session`), an unmanaged worktree (`external`), or
 *  nobody (`free`). */
export interface DesktopBranchOccupancy {
  branch: string;
  kind: DesktopBranchOccupancyKind;
  sessionId?: string;
  path?: string;
}

export type DesktopWorktreeEntryState = 'creating' | 'ready' | 'deleting' | 'recovery';

/** The one worktree a Lead retains; reused when "Worktree" is picked again. */
export interface DesktopRetainedWorktree {
  id: string;
  branch: string;
  path: string;
  baseCommit: string | null;
  state: DesktopWorktreeEntryState;
  /** Creation notes: `submodules`, `include-missing:<path>`, `include-exists:<path>`, … */
  warnings?: string[];
}

/** Branch chip menu data for one session. */
export interface DesktopBranchMenu {
  workspace: DesktopSessionWorkspace;
  branches: DesktopGitBranch[];
  /** One row per local branch name in `branches`. */
  occupancy: DesktopBranchOccupancy[];
  retainedWorktree: DesktopRetainedWorktree | null;
  /** A session's "Worktree" choice waiting for its next send (lazy creation); null when none. */
  pendingWorktree?: { name: string | null } | null;
  /** Creation notes of the retained worktree (see DesktopRetainedWorktree.warnings). */
  warnings?: string[];
}

/** Pick a branch's existing checkout, or create its separate worktree. */
export interface DesktopSelectBranchInput {
  branch: string;
  /** Create `branch` in a separate worktree ("New branch"). */
  create?: boolean;
  expectedRevision?: number;
  /** Acknowledges WORKTREE_LARGE_REPO_CONFIRM (resend after the user agreed). */
  confirmLarge?: boolean;
}

/** Lazy intent: the worktree is created from the current branch when the
 *  session sends its first message, or reused when this Lead retains one. */
export interface DesktopRequestWorktreeInput {
  name?: string | null;
  expectedRevision?: number;
  /** Acknowledges WORKTREE_LARGE_REPO_CONFIRM (resend after the user agreed). */
  confirmLarge?: boolean;
  /** Create and enter the worktree now instead of at the next send. */
  provision?: boolean;
  /** Answers WORKTREE_DIRTY_CHOICE: `leave` keeps the project folder's
   *  uncommitted changes where they are (the worktree starts at the current
   *  commit); `carry` moves them into the worktree. */
  carryChanges?: 'leave' | 'carry';
}

/** A New Task's "Worktree" choice, sent with its first prompt: the host
 *  creates and enters the worktree before the prompt is submitted. */
export interface DesktopNewTaskWorktree {
  branch?: string;
  create?: boolean;
  /** Acknowledges WORKTREE_LARGE_REPO_CONFIRM (resend after the user agreed). */
  confirmLarge?: boolean;
}

/** Merge the session's worktree branch into the project folder's checked-out
 *  branch (--no-ff, after a merge-tree conflict preflight). */
export interface DesktopMergeWorkspaceInput {
  /** The user confirmed the merge into `target`. */
  confirmed: true;
  /** The target branch the user saw; a moved project folder rejects. */
  target: string;
  expectedRevision?: number;
  /** Merge and clean up: with autoCleanup on, the merged worktree is removed
   *  right after unless a session still uses it (the session is never moved).
   *  A cleanup that is refused or fails (in use, dirty, retained file
   *  recovery data, ...) keeps the worktree and is reported in `cleanup`;
   *  the merge itself still succeeded. */
  cleanup?: boolean;
}

export interface DesktopRemoveWorktreeInput {
  /** Delete despite uncommitted or unmerged work (after explicit confirmation). */
  force?: boolean;
  expectedRevision?: number;
}

export interface DesktopWorkspaceTransitionResult {
  revision: number;
  workspace: DesktopSessionWorkspace;
  /** Creation notes when a worktree was created or entered. */
  warnings?: string[];
}

/** mergeWorkspace's answer: a conflicting preflight changes nothing and
 *  returns `merged: false` with the files; a cleanup that ran adds the
 *  workspace as it is now (the session never moves). */
export interface DesktopMergeWorkspaceResult {
  merged: boolean;
  target: string;
  /** The merge commit created on `target` (its HEAD when already up to date). */
  commit: string | null;
  upToDate?: boolean;
  conflicts?: string[];
  revision?: number;
  workspace?: DesktopSessionWorkspace;
  /** The cleanup after a successful merge: `removed: false` keeps the
   *  worktree (a refusal such as WORKTREE_DIRTY in `code`); the merge stands. */
  cleanup?: { removed: boolean; code?: string; message?: string };
}

export const DESKTOP_WORKTREE_NEW_TASK_DEFAULTS = ['branch', 'worktree'] as const;

export interface DesktopWorktreeSettings {
  /** `branch` (default): new tasks use the current branch; `worktree`: a new worktree. */
  newTaskDefault: (typeof DESKTOP_WORKTREE_NEW_TASK_DEFAULTS)[number];
  /** Ref prefix ending with "/"; default "mixdog/". */
  branchPrefix: string;
  /** Repository size that asks for confirmation first; 0 never asks. Default 2 GiB. */
  sizeWarnBytes: number;
  /** Remove clean, merged worktrees when their task ends. Default true. */
  autoCleanup: boolean;
}

/** Stable `error.code` values (runtime WORKTREE_ERROR_CODES). */
export const DESKTOP_WORKTREE_ERROR_CODES = [
  'WORKTREE_BUSY_JOBS',
  'WORKTREE_BRANCH_OCCUPIED',
  /** An existing branch a remote declares its default: never opened in a
   *  managed worktree (the project folder could not switch to it). */
  'WORKTREE_DEFAULT_BRANCH',
  'WORKTREE_DISK_INSUFFICIENT',
  'WORKTREE_LARGE_REPO_CONFIRM',
  'WORKTREE_DIRTY',
  /** requestWorktree with `provision` found uncommitted project-folder files
   *  (`details.count`): resend with `carryChanges`. */
  'WORKTREE_DIRTY_CHOICE',
  'WORKTREE_FILE_RECOVERY',
  'WORKTREE_UNMERGED',
  'WORKTREE_MISSING',
  'WORKTREE_UNSUPPORTED_REPO',
  'WORKTREE_REVISION_CONFLICT',
  'WORKTREE_NOT_IMPLEMENTED',
  'WORKTREE_CONFIRM_REQUIRED',
  'WORKTREE_TARGET_MISMATCH',
  'WORKTREE_PROJECT_MISMATCH',
  'WORKTREE_PARTIAL_TRANSITION',
  'WORKTREE_PROJECT_UNKNOWN',
  'WORKTREE_REMOVAL_INCOMPLETE',
  'WORKTREE_PATH_UNSAFE',
  'MERGE_CONFLICT',
  'MERGE_TARGET_DIRTY',
  'MERGE_FAILED',
] as const;

export type DesktopWorktreeErrorCode = (typeof DESKTOP_WORKTREE_ERROR_CODES)[number];

/** `details.reason` of a WORKTREE_BUSY_JOBS refusal whose meaning every
 *  surface shares (runtime WORKTREE_REFUSAL_REASONS). */
export const DESKTOP_WORKTREE_REFUSAL_REASONS = [
  'workspace-retained',
  'workspace-lease',
  'folder-in-use',
  'folder-shell-jobs',
  'workspace-admission-unreadable',
] as const;

export type DesktopWorktreeRefusalReason = (typeof DESKTOP_WORKTREE_REFUSAL_REASONS)[number];

/** A Project's branch menu before any session exists (a New Task draft, the
 *  source-control dock): the real occupancy of the project folder. */
export interface DesktopProjectBranchMenuInput {
  projectPath: string;
}

/** Check out (or create) a branch in a Project's folder without a session,
 *  through the same guarded path as a session's selectBranch. */
export interface DesktopSelectProjectBranchInput {
  /** A registered Project (checked by the host and again by the runtime). */
  projectPath: string;
  /** Required unless `detach` is given. */
  branch?: string;
  /** Check out this commit id (4–64 hex, a history entry) detached instead
   *  of a branch; excludes `branch`, `create`, `remote` and `startPoint`. */
  detach?: string;
  create?: boolean;
  /** `branch` names a remote-tracking branch ("origin/x"): check out its
   *  local branch, creating it to track the remote branch when missing. */
  remote?: boolean;
  /** With `create`: the commit id (4–64 hex) the new branch starts at (a
   *  history entry). A ref spelled like the id never shadows it. */
  startPoint?: string;
}

export interface DesktopSelectProjectBranchResult {
  /** The local branch now checked out; null after a detached checkout. */
  branch: string | null;
  changed: boolean;
  commit?: string;
  /** Set by a `detach` checkout. */
  detached?: true;
  /** The remote branch a newly created local branch tracks. */
  tracking?: string;
}

/** Merge a local branch into a Project folder's checked-out branch without a
 *  session (the source-control dock), through the runtime's guarded path. */
export interface DesktopMergeProjectBranchInput {
  /** A registered Project (checked by the host and again by the runtime). */
  projectPath: string;
  /** The local branch to merge. */
  branch: string;
  /** The checked-out branch the user confirmed; a moved folder rejects. */
  target: string;
}

export interface DesktopMergeProjectBranchResult {
  merged: boolean;
  commit: string | null;
  target: string;
  upToDate?: boolean;
  /** Set when the preflight found conflicts; nothing changed. */
  conflicts?: string[];
}

/** One row of listWorktrees: a managed worktree and who keeps it. */
export interface DesktopManagedWorktreeRow extends DesktopRetainedWorktree {
  projectPath: string;
  ownerSessionId: string | null;
  /** Its session is still in the session store (never pruned). */
  retained: boolean;
  /** A live session or a running process holds it. */
  ownerLive: boolean;
  /** What pruneWorktrees would remove once clean and merged, with no retained recovery data. */
  removable: boolean;
}

/** Session capabilities of the feature. Arguments, in order:
 *  getBranchMenu() → DesktopBranchMenu
 *  getProjectBranchMenu(DesktopProjectBranchMenuInput) → DesktopBranchMenu (no session)
 *  selectBranch(DesktopSelectBranchInput) → DesktopWorkspaceTransitionResult
 *  selectProjectBranch(DesktopSelectProjectBranchInput) → DesktopSelectProjectBranchResult (no session)
 *  mergeProjectBranch(DesktopMergeProjectBranchInput) → DesktopMergeProjectBranchResult (no session)
 *  requestWorktree(DesktopRequestWorktreeInput?) → DesktopWorkspaceTransitionResult
 *  mergeWorkspace(DesktopMergeWorkspaceInput) → DesktopMergeWorkspaceResult
 *  removeWorktree(DesktopRemoveWorktreeInput?) → DesktopWorkspaceTransitionResult
 *    (WORKTREE_REMOVAL_INCOMPLETE: partly removed; call again to finish)
 *  listWorktrees() → DesktopManagedWorktreeRow[]
 *  pruneWorktrees() → reconcile report (removes clean, merged worktrees no session retains)
 *  getWorktreeSettings() → DesktopWorktreeSettings
 *  setWorktreeSettings(Partial<DesktopWorktreeSettings>) → DesktopWorktreeSettings */
export const DESKTOP_WORKTREE_CAPABILITIES = [
  'inspectProjectBranch',
  'manageProjectBranch',
  'getBranchMenu',
  'getProjectBranchMenu',
  'selectBranch',
  'selectProjectBranch',
  'mergeProjectBranch',
  'requestWorktree',
  'mergeWorkspace',
  'removeWorktree',
  'listWorktrees',
  'pruneWorktrees',
  'getWorktreeSettings',
  'setWorktreeSettings',
] as const;

export const DESKTOP_WORKTREE_READ_CAPABILITIES = [
  'inspectProjectBranch',
  'getBranchMenu',
  'getProjectBranchMenu',
  'listWorktrees',
  'getWorktreeSettings',
] as const;

export interface DesktopBranchActionState {
  branch: string;
  commit: string;
  target: string | null;
  targetCommit: string | null;
  path: string | null;
  worktreeId: string | null;
  kind: 'project' | 'managed' | 'external' | 'free';
}

export type DesktopBranchManagementAction = 'merge' | 'remove-worktree' | 'delete-branch';

export type DesktopWorktreeCapability = (typeof DESKTOP_WORKTREE_CAPABILITIES)[number];
