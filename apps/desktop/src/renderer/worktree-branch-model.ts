// Branch chip / source-control picker model for Lead-session worktrees:
// typed-error decoding, branch rows with their occupancy marks, chip state,
// the draft "Worktree" intent store and the menu placement rule.
import { useSyncExternalStore } from 'react';
import type {
  DesktopBranchMenu,
  DesktopBranchOccupancy,
  DesktopGitBranch,
  DesktopNewTaskWorktree,
  DesktopSessionWorkspace,
  DesktopWorktreeCapability,
  DesktopWorktreeErrorCode,
} from '../shared/contract';
import { DESKTOP_WORKTREE_ERROR_CODES } from '../shared/contract';
import { t } from './i18n';

export interface WorktreeFailure {
  code: DesktopWorktreeErrorCode | null;
  message: string;
  details: Record<string, unknown>;
}

const CODE_PATTERN = new RegExp(`\\b(${DESKTOP_WORKTREE_ERROR_CODES.join('|')})\\b`, 'u');
/** main/worktree-validation.ts WORKTREE_DETAILS_MARKER. */
const DETAILS_MARKER = '\n[worktree-details] ';

/** Typed failures keep `code`/`details` locally; across IPC only the message
 *  survives, so the code is also read out of the text and the details out of
 *  the JSON trailer the main process appends. */
export function worktreeFailure(error: unknown): WorktreeFailure {
  const record = (error && typeof error === 'object' ? error : {}) as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const raw = String(record.message ?? error ?? '');
  const marker = raw.indexOf(DETAILS_MARKER);
  const message = marker >= 0 ? raw.slice(0, marker) : raw;
  let trailed: unknown = null;
  if (marker >= 0) {
    try {
      trailed = JSON.parse(raw.slice(marker + DETAILS_MARKER.length));
    } catch {
      trailed = null;
    }
  }
  const declared = typeof record.code === 'string' ? record.code : (message.match(CODE_PATTERN)?.[1] ?? '');
  const code = (DESKTOP_WORKTREE_ERROR_CODES as readonly string[]).includes(declared)
    ? (declared as DesktopWorktreeErrorCode)
    : null;
  const source = record.details && typeof record.details === 'object' ? record.details : trailed;
  const details = source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
  return { code, message, details };
}

function formatByteSize(bytes: number): string {
  if (!(bytes > 0)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function largeRepoPrompt(failure: WorktreeFailure): string {
  const size = formatByteSize(
    Number(failure.details.estimateBytes ?? failure.details.sizeBytes ?? failure.details.bytes)
  );
  return size
    ? t('A worktree needs about {{size}}. Create it anyway?', { size })
    : t('A worktree needs a lot of disk space. Create it anyway?');
}

/** Why the project folder's uncommitted changes could not be brought into the
 *  worktree (carry.mjs assertCarryable and the carry itself). */
function carryRefusalText(failure: WorktreeFailure): string {
  const details = failure.details;
  switch (details.reason) {
    case 'operation-in-progress':
      switch (details.operation) {
        case 'merge':
          return t(
            'A merge is in progress in the project folder. Finish or abort it, or leave the changes in the project folder.'
          );
        case 'rebase':
          return t(
            'A rebase is in progress in the project folder. Finish or abort it, or leave the changes in the project folder.'
          );
        case 'cherry-pick':
          return t(
            'A cherry-pick is in progress in the project folder. Finish or abort it, or leave the changes in the project folder.'
          );
        case 'revert':
          return t(
            'A revert is in progress in the project folder. Finish or abort it, or leave the changes in the project folder.'
          );
        case 'bisect':
          return t(
            'A bisect is in progress in the project folder. Finish or abort it, or leave the changes in the project folder.'
          );
        default:
          return t(
            'A Git operation is in progress in the project folder. Finish or abort it, or leave the changes in the project folder.'
          );
      }
    case 'unmerged-paths':
      return t(
        'The project folder has unresolved merge conflicts. Resolve them, or leave the changes in the project folder.'
      );
    case 'dirty-submodules':
      return t(
        "Submodules with changes can't be brought along. Commit or reset them, or leave the changes in the project folder."
      );
    case 'nested-repository':
      return t(
        "Untracked nested repositories can't be brought along. Leave the changes in the project folder instead."
      );
    case 'too-large': {
      const files = Number(details.files);
      const maxFiles = Number(details.maxFiles);
      if (files > 0 && maxFiles > 0) {
        return t(
          'Too many untracked files to bring along ({{files}}, limit {{limit}}). Add generated output to .gitignore, or leave the changes in the project folder.',
          { files, limit: maxFiles }
        );
      }
      const size = formatByteSize(Number(details.maxBytes));
      return size
        ? t(
            'The untracked files are too large to bring along (over {{size}}). Add large files to .gitignore, or leave the changes in the project folder.',
            { size }
          )
        : t('The untracked files are too large to bring along. Leave the changes in the project folder instead.');
    }
    case 'sparse-checkout':
    case 'skip-worktree':
    case 'assume-unchanged':
      return t(
        "Files hidden from Git (sparse checkout, skip-worktree or assume-unchanged) can't be brought along. Leave the changes in the project folder instead."
      );
    case 'intent-to-add':
      return t(
        "Files added with intent to add (git add -N) can't be brought along. Stage or unstage them, or leave the changes in the project folder."
      );
    case 'filtered-paths':
      return t(
        "Files that use a Git filter (such as Git LFS) can't be brought along exactly. Leave the changes in the project folder instead."
      );
    case 'head-moved':
    case 'carry-failed':
    case 'carry-restore-refused':
    case 'carry-restore-failed':
      // The runtime's text names the recovery ref that holds the changes.
      return runtimeText(failure) || carryRefusedText();
    default:
      return carryRefusedText();
  }
}

function carryRefusedText(): string {
  return t(
    "The changes couldn't be brought into the worktree. Leave them in the project folder instead, or try again."
  );
}

/** User-facing text for a typed failure; untyped failures keep their message.
 *  `checkout`: the failure answers a branch switch in the project folder, so
 *  WORKTREE_DIRTY means the project folder (it carries no details over IPC).
 *  `carry`: the request brought the uncommitted changes along, so a
 *  WORKTREE_DIRTY without a known reason is a refused carry. */
export function worktreeFailureText(
  failure: WorktreeFailure,
  { checkout = false, carry = false }: { checkout?: boolean; carry?: boolean } = {}
): string {
  switch (failure.code) {
    case 'WORKTREE_DISK_INSUFFICIENT': {
      const required = formatByteSize(Number(failure.details.requiredBytes));
      const free = formatByteSize(Number(failure.details.freeBytes));
      return required && free
        ? t('Not enough free disk space to create the worktree ({{required}} needed, {{free}} free).', {
            required,
            free,
          })
        : t('Not enough free disk space to create the worktree.');
    }
    case 'WORKTREE_FILE_RECOVERY':
      return t('Retained file recovery records block worktree removal, including force. Inspect and explicitly delete them first.');
    case 'WORKTREE_BUSY_JOBS':
      return failure.details.reason === 'folder-shell-jobs'
        ? t(
            'Background shells of other sessions are running in the project folder. Wait for them or stop them before bringing changes along.'
          )
        : t('Background tasks are still running. Wait for them or stop them, then try again.');
    case 'WORKTREE_BRANCH_OCCUPIED': {
      const path = typeof failure.details.path === 'string' ? failure.details.path : '';
      return path
        ? t('This branch is already checked out in {{path}}.', { path })
        : t('This branch is already checked out in another worktree.');
    }
    case 'WORKTREE_REMOVAL_INCOMPLETE':
      return t(
        'The worktree could not be removed completely because a file is still in use. Close it and remove the worktree again.'
      );
    case 'WORKTREE_PATH_UNSAFE':
      return t('The worktree folder is not a managed checkout of this project, so nothing was deleted.');
    case 'WORKTREE_MISSING':
      return t('The worktree folder is missing. Pick a project branch to continue.');
    case 'WORKTREE_REVISION_CONFLICT':
      return t('The workspace changed, so the menu was refreshed. Try again.');
    case 'WORKTREE_NOT_IMPLEMENTED':
      return t('Worktrees are not available yet.');
    case 'WORKTREE_UNSUPPORTED_REPO':
      return t('This folder does not support worktrees.');
    case 'WORKTREE_DIRTY': {
      const reason = failure.details.reason;
      if (reason && reason !== 'project-dirty') return carryRefusalText(failure);
      if (carry && !reason) return carryRefusedText();
      if (checkout || reason === 'project-dirty') {
        return t('The project folder has uncommitted changes. Commit or stash them before switching branches.');
      }
      // Only a worktree removal is refused without a reason.
      return t('The worktree has uncommitted changes.');
    }
    case 'WORKTREE_PARTIAL_TRANSITION':
      // The runtime's text names the branch the project folder is actually on.
      return runtimeText(failure);
    case 'WORKTREE_PROJECT_UNKNOWN':
      return t('Project is not available.');
    case 'WORKTREE_PROJECT_MISMATCH':
      return t('This session keeps a worktree of another project. Remove it before creating a new one here.');
    case 'WORKTREE_UNMERGED':
      return t('The worktree branch has commits that are not merged.');
    case 'MERGE_TARGET_DIRTY':
      return t('The branch to merge into has uncommitted changes. Commit or stash them first.');
    case 'WORKTREE_CONFIRM_REQUIRED':
      return t('Confirm the merge before it runs.');
    case 'WORKTREE_TARGET_MISMATCH':
      return t('The project folder switched to another branch. Check the target and merge again.');
    case 'MERGE_FAILED': {
      // The runtime's own text names the git failure and whether it was aborted.
      const reason = runtimeText(failure);
      return reason ? t('The merge failed: {{reason}}', { reason }) : t('The merge failed.');
    }
    case 'MERGE_CONFLICT': {
      const files = Array.isArray(failure.details.files) ? failure.details.files.map(String) : [];
      if (!files.length) return t('Nothing was merged because the branches conflict.');
      const listed = files.slice(0, 5).join(', ') + (files.length > 5 ? ', …' : '');
      return t('Nothing was merged. Conflicting files: {{files}}', { files: listed });
    }
    default:
      return failure.message;
  }
}

/** The runtime's own text after the last `<code>: ` prefix, trimmed. */
function runtimeText(failure: WorktreeFailure): string {
  const marker = `${failure.code}: `;
  const index = failure.message.lastIndexOf(marker);
  return (index >= 0 ? failure.message.slice(index + marker.length) : failure.message).trim();
}

/** `project`: the project folder's checked-out branch, marked while the
 *  session works in its worktree. */
export type BranchMark = 'current' | 'inUse' | 'external' | 'project' | '';

export interface BranchRow {
  name: string;
  mark: BranchMark;
  /** Owning session when another Mixdog session holds the branch. */
  sessionId?: string;
  /** Where an external worktree holds the branch. */
  path?: string;
  /** This Lead's own retained worktree branch: picking it reuses the worktree. */
  retained: boolean;
  disabled: boolean;
}

export function branchRows(menu: DesktopBranchMenu, ownSessionId: string, query: string): BranchRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const occupancy = new Map<string, DesktopBranchOccupancy>(menu.occupancy.map((row) => [row.branch, row]));
  const seen = new Set<string>();
  const rows: BranchRow[] = [];
  for (const branch of menu.branches as DesktopGitBranch[]) {
    if (branch.remote || seen.has(branch.name)) continue;
    seen.add(branch.name);
    if (needle && !branch.name.toLocaleLowerCase().includes(needle)) continue;
    const held = occupancy.get(branch.name);
    const row: BranchRow = { name: branch.name, mark: '', retained: false, disabled: false };
    if (branch.name === menu.workspace.branch) row.mark = 'current';
    else if (held?.kind === 'current' && menu.workspace.worktreeId) row.mark = 'project';
    else if (held?.kind === 'session' && held.sessionId && held.sessionId !== ownSessionId) {
      row.mark = 'inUse';
      row.sessionId = held.sessionId;
    } else if (held?.kind === 'session') row.retained = true;
    else if (held?.kind === 'external') {
      row.mark = 'external';
      row.path = held.path;
      row.disabled = true;
    }
    rows.push(row);
  }
  // The session's own branch leads; the rest keep their order.
  const current = rows.findIndex((row) => row.mark === 'current');
  if (current > 0) rows.unshift(...rows.splice(current, 1));
  return rows;
}

export type BranchChipState =
  | { kind: 'branch'; label: string }
  | { kind: 'intent'; label: string }
  | { kind: 'worktree'; label: string };

export function branchChipState(workspace: DesktopSessionWorkspace | null, intent: boolean): BranchChipState {
  if (workspace?.worktreeId) return { kind: 'worktree', label: workspace.branch || t('Worktree') };
  if (intent) return { kind: 'intent', label: t('Worktree') };
  return { kind: 'branch', label: workspace?.branch || t('Branch') };
}

// ── "Worktree" intent ────────────────────────────────────────────────────
// Lazy: the worktree is created at the first send, so a New Task only
// remembers the choice. The send path reads it with takeWorktreeIntent.
const intents = new Map<string, boolean>();
const listeners = new Set<() => void>();

function emitIntent() {
  for (const listener of listeners) listener();
}

export function setWorktreeIntent(key: string, intent: boolean) {
  if ((intents.get(key) ?? false) === intent) return;
  if (intent) intents.set(key, true);
  else intents.delete(key);
  emitIntent();
}

export function getWorktreeIntent(key: string): boolean {
  return intents.get(key) ?? false;
}

/** Reads and clears the intent for `key` (the draft id of the sending New Task). */
export function takeWorktreeIntent(key: string): boolean {
  const intent = getWorktreeIntent(key);
  setWorktreeIntent(key, false);
  return intent;
}

/** A New Task's first send. `send` submits the draft; with a "Worktree"
 *  choice it carries `worktree` and the host creates and enters the worktree
 *  before the prompt goes out. A large repository asks once and resends with
 *  `confirmLarge`; any other typed refusal (disk, busy, …) rejects with its
 *  readable text. Resolves null when the user declines (nothing was sent). */
export async function submitDraftWithWorktree<T>(
  send: (worktree: DesktopNewTaskWorktree | undefined) => Promise<T>,
  worktree: boolean,
  confirm: (message: string) => boolean = (message) => window.confirm(message)
): Promise<T | null> {
  if (!worktree) return send(undefined);
  try {
    try {
      return await send({});
    } catch (reason) {
      const failure = worktreeFailure(reason);
      if (failure.code !== 'WORKTREE_LARGE_REPO_CONFIRM') throw reason;
      if (!confirm(largeRepoPrompt(failure))) return null;
      return await send({ confirmLarge: true });
    }
  } catch (reason) {
    const failure = worktreeFailure(reason);
    throw failure.code ? new Error(worktreeFailureText(failure)) : reason;
  }
}

/** A New Task's first send with the draft `key`'s "Worktree" choice: the
 *  choice is taken for the send and given back unless a session was started
 *  (the host refuses to start one that is not bound to its worktree), so a
 *  failure at any step before the turn (model resolution, provisioning,
 *  refusal) never drops it. */
export async function sendDraftWithWorktreeIntent<T extends { accepted?: unknown; sessionId?: unknown }>(
  key: string,
  send: (worktree: DesktopNewTaskWorktree | undefined) => Promise<T>,
  confirm?: (message: string) => boolean
): Promise<T | null> {
  const worktree = takeWorktreeIntent(key);
  let started = false;
  try {
    const result = await submitDraftWithWorktree(send, worktree, confirm);
    started = result?.accepted === true && Boolean(result.sessionId);
    return result;
  } finally {
    if (worktree && !started) setWorktreeIntent(key, true);
  }
}

export function useWorktreeIntent(key: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getWorktreeIntent(key),
    () => false
  );
}

// ── Placement ────────────────────────────────────────────────────────────
const BRANCH_MENU_WIDTH = 280;
const BRANCH_MENU_MAX_HEIGHT = 320;
const MENU_GAP = 2;
const EDGE = 8;

/** Same rule as OpenSelect's composer context pills: left-aligned to the chip,
 *  opened ABOVE it with a 2px gap, falling below only when above cannot fit. */
export function branchMenuPosition(
  anchor: HTMLElement
): { left: number; maxHeight: number } & ({ bottom: number; top?: undefined } | { top: number; bottom?: undefined }) {
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const visible = {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
    bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
  };
  const sheet = anchor.closest<HTMLElement>('.pane-leaf, .workspace, .session-sidebar')?.getBoundingClientRect();
  const bounds =
    sheet && sheet.width > 0 && sheet.height > 0
      ? {
          left: Math.max(sheet.left, visible.left),
          top: Math.max(sheet.top, visible.top),
          right: Math.min(sheet.right, visible.right),
          bottom: Math.min(sheet.bottom, visible.bottom),
        }
      : visible;
  const width = Math.min(BRANCH_MENU_WIDTH, Math.max(0, bounds.right - bounds.left - EDGE * 2));
  const left = Math.max(bounds.left + EDGE, Math.min(bounds.right - width - EDGE, rect.left));
  const spaceAbove = rect.top - bounds.top - EDGE;
  const spaceBelow = bounds.bottom - rect.bottom - EDGE;
  const above = spaceAbove >= BRANCH_MENU_MAX_HEIGHT || spaceAbove > spaceBelow;
  const maxHeight = Math.max(0, Math.min(BRANCH_MENU_MAX_HEIGHT, (above ? spaceAbove : spaceBelow) - MENU_GAP));
  if (above) {
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    return { left, maxHeight, bottom: Math.max(EDGE, layoutHeight - rect.top + MENU_GAP) };
  }
  return { left, maxHeight, top: Math.min(bounds.bottom - EDGE, rect.bottom + MENU_GAP) };
}

export type WorktreeInvoker = <T>(
  capability: DesktopWorktreeCapability,
  args?: unknown[],
  sessionId?: string
) => Promise<T>;

/** Calls one worktree session capability and returns its value. */
export const invokeWorktree: WorktreeInvoker = async (capability, args = [], sessionId = '') => {
  const result = await window.mixdogDesktop.invokeCapability<never>({
    capability,
    args,
    ...(sessionId ? { sessionId } : {}),
  });
  return result.value as never;
};
