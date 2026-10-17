// Argument shapes of the Lead worktree capabilities (contract-worktree.ts).
// Shape only: names, refs and repository state are checked by the runtime.
import {
  DESKTOP_WORKTREE_CAPABILITIES,
  DESKTOP_WORKTREE_ERROR_CODES,
  DESKTOP_WORKTREE_NEW_TASK_DEFAULTS,
  type DesktopCapability,
  type DesktopWorktreeCapability,
} from '../shared/contract';

const WORKTREE_ERROR_CODE_SET = new Set<string>(DESKTOP_WORKTREE_ERROR_CODES);

/** Separates a coded message from its JSON details (worktree-branch-model reads it back). */
export const WORKTREE_DETAILS_MARKER = '\n[worktree-details] ';
const MAX_DETAILS_TEXT = 4096;

/** A typed worktree failure whose `code` and `details` survive a message-only
 *  hop (Electron IPC, the remote relay): the code leads the message and the
 *  details (sizes, holder path, …) trail it as JSON, as the renderer's
 *  worktreeFailure() reads them. Other errors pass through unchanged. */
export function worktreeErrorWithCode(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (!(error instanceof Error) || typeof code !== 'string' || !WORKTREE_ERROR_CODE_SET.has(code)) return error;
  const details = (error as { details?: unknown }).details;
  let trailer = '';
  if (details && typeof details === 'object' && !error.message.includes(WORKTREE_DETAILS_MARKER)) {
    try {
      const text = JSON.stringify(details);
      if (text.length <= MAX_DETAILS_TEXT) trailer = `${WORKTREE_DETAILS_MARKER}${text}`;
    } catch {
      /* details that do not serialize stay local */
    }
  }
  const leads = new RegExp(`\\b${code}\\b`, 'u').test(error.message);
  if (leads && !trailer) return error;
  const coded = new Error(`${leads ? '' : `${code}: `}${error.message}${trailer}`) as Error & {
    code: string;
    details?: unknown;
  };
  coded.name = error.name;
  coded.code = code;
  if (details !== undefined) coded.details = details;
  return coded;
}

/** Arity per capability, merged into the IPC arity table. */
export const WORKTREE_CAPABILITY_ARITY = {
  inspectProjectBranch: [1, 1],
  manageProjectBranch: [1, 1],
  getBranchMenu: [0, 0],
  getProjectBranchMenu: [1, 1],
  selectBranch: [1, 1],
  selectProjectBranch: [1, 1],
  mergeProjectBranch: [1, 1],
  requestWorktree: [0, 1],
  mergeWorkspace: [1, 1],
  removeWorktree: [0, 1],
  listWorktrees: [0, 0],
  pruneWorktrees: [0, 0],
  getWorktreeSettings: [0, 0],
  setWorktreeSettings: [1, 1],
} as const satisfies Record<DesktopWorktreeCapability, readonly [number, number]>;

const WORKTREE_CAPABILITY_SET = new Set<string>(DESKTOP_WORKTREE_CAPABILITIES);
const MAX_REF_LENGTH = 255;
const MAX_PATH_LENGTH = 4096;

function objectArg(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function allowKeys(input: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new TypeError(`${name} contains an unsupported field.`);
  }
}

function refText(value: unknown, name: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_REF_LENGTH) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
}

function projectPathText(value: unknown, name: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PATH_LENGTH) {
    throw new TypeError(`${name} must be a non-empty path.`);
  }
}

/** A commit object id (4–64 hex): never a ref name or an option. */
function commitIdText(value: unknown, name: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{4,64}$/i.test(value)) {
    throw new TypeError(`${name} must be a commit id.`);
  }
}

function optionalRevision(input: Record<string, unknown>, name: string): void {
  const revision = input.expectedRevision;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || (revision as number) < 0)) {
    throw new TypeError(`${name}.expectedRevision must be a non-negative integer.`);
  }
}

function optionalBoolean(input: Record<string, unknown>, key: string, name: string): void {
  if (input[key] !== undefined && typeof input[key] !== 'boolean') {
    throw new TypeError(`${name}.${key} must be a boolean.`);
  }
}

/** Session-less capabilities whose `projectPath` must name a registered Project. */
export function isProjectScopedCapability(capability: string): boolean {
  return (
    capability === 'getProjectBranchMenu' ||
    capability === 'selectProjectBranch' ||
    capability === 'mergeProjectBranch' ||
    capability === 'inspectProjectBranch' ||
    capability === 'manageProjectBranch'
  );
}

export function isWorktreeCapability(capability: DesktopCapability): capability is DesktopWorktreeCapability {
  return WORKTREE_CAPABILITY_SET.has(capability);
}

/** Throws TypeError when `args` (already arity-checked) do not fit `capability`. */
export function validateWorktreeCapabilityArgs(capability: DesktopWorktreeCapability, args: unknown[]): void {
  switch (capability) {
    case 'inspectProjectBranch': {
      const input = objectArg(args[0], 'inspectProjectBranch input');
      allowKeys(input, ['projectPath', 'branch'], 'inspectProjectBranch input');
      projectPathText(input.projectPath, 'projectPath');
      refText(input.branch, 'branch');
      return;
    }
    case 'manageProjectBranch': {
      const input = objectArg(args[0], 'manageProjectBranch input');
      allowKeys(
        input,
        ['projectPath', 'branch', 'action', 'commit', 'target', 'targetCommit', 'confirmed'],
        'manageProjectBranch input'
      );
      projectPathText(input.projectPath, 'projectPath');
      refText(input.branch, 'branch');
      commitIdText(input.commit, 'commit');
      if (!['merge', 'remove-worktree', 'delete-branch'].includes(String(input.action)) || input.confirmed !== true) {
        throw new TypeError('A supported branch action and explicit confirmation are required.');
      }
      if (input.action !== 'remove-worktree') {
        refText(input.target, 'target');
        commitIdText(input.targetCommit, 'targetCommit');
      }
      return;
    }
    case 'selectBranch': {
      const input = objectArg(args[0], 'selectBranch input');
      allowKeys(input, ['branch', 'create', 'expectedRevision', 'confirmLarge'], 'selectBranch input');
      refText(input.branch, 'selectBranch input.branch');
      optionalBoolean(input, 'create', 'selectBranch input');
      optionalBoolean(input, 'confirmLarge', 'selectBranch input');
      optionalRevision(input, 'selectBranch input');
      return;
    }
    case 'getProjectBranchMenu': {
      const input = objectArg(args[0], 'getProjectBranchMenu input');
      allowKeys(input, ['projectPath'], 'getProjectBranchMenu input');
      projectPathText(input.projectPath, 'getProjectBranchMenu input.projectPath');
      return;
    }
    case 'selectProjectBranch': {
      const input = objectArg(args[0], 'selectProjectBranch input');
      allowKeys(
        input,
        ['projectPath', 'branch', 'create', 'remote', 'startPoint', 'detach'],
        'selectProjectBranch input'
      );
      projectPathText(input.projectPath, 'selectProjectBranch input.projectPath');
      if (input.detach !== undefined) {
        commitIdText(input.detach, 'selectProjectBranch input.detach');
        if (['branch', 'create', 'remote', 'startPoint'].some((key) => input[key] !== undefined)) {
          throw new TypeError('selectProjectBranch input.detach excludes branch, create, remote and startPoint.');
        }
        return;
      }
      refText(input.branch, 'selectProjectBranch input.branch');
      optionalBoolean(input, 'create', 'selectProjectBranch input');
      optionalBoolean(input, 'remote', 'selectProjectBranch input');
      if (input.create === true && input.remote === true) {
        throw new TypeError('selectProjectBranch input cannot both create and check out a remote branch.');
      }
      if (input.startPoint !== undefined) {
        commitIdText(input.startPoint, 'selectProjectBranch input.startPoint');
        if (input.create !== true) throw new TypeError('selectProjectBranch input.startPoint needs create: true.');
      }
      return;
    }
    case 'mergeProjectBranch': {
      const input = objectArg(args[0], 'mergeProjectBranch input');
      allowKeys(input, ['projectPath', 'branch', 'target'], 'mergeProjectBranch input');
      projectPathText(input.projectPath, 'mergeProjectBranch input.projectPath');
      refText(input.branch, 'mergeProjectBranch input.branch');
      refText(input.target, 'mergeProjectBranch input.target');
      return;
    }
    case 'requestWorktree': {
      if (args[0] === undefined) return;
      const input = objectArg(args[0], 'requestWorktree input');
      allowKeys(
        input,
        ['name', 'expectedRevision', 'confirmLarge', 'provision', 'carryChanges'],
        'requestWorktree input'
      );
      if (input.name !== undefined && input.name !== null) refText(input.name, 'requestWorktree input.name');
      optionalBoolean(input, 'confirmLarge', 'requestWorktree input');
      optionalBoolean(input, 'provision', 'requestWorktree input');
      if (input.carryChanges !== undefined && input.carryChanges !== 'leave' && input.carryChanges !== 'carry') {
        throw new TypeError('requestWorktree input.carryChanges must be leave or carry.');
      }
      optionalRevision(input, 'requestWorktree input');
      return;
    }
    case 'mergeWorkspace': {
      const input = objectArg(args[0], 'mergeWorkspace input');
      allowKeys(input, ['confirmed', 'target', 'expectedRevision', 'cleanup'], 'mergeWorkspace input');
      if (input.confirmed !== true) throw new TypeError('mergeWorkspace requires confirmed: true.');
      refText(input.target, 'mergeWorkspace input.target');
      optionalRevision(input, 'mergeWorkspace input');
      optionalBoolean(input, 'cleanup', 'mergeWorkspace input');
      return;
    }
    case 'removeWorktree': {
      if (args[0] === undefined) return;
      const input = objectArg(args[0], 'removeWorktree input');
      allowKeys(input, ['force', 'expectedRevision'], 'removeWorktree input');
      optionalBoolean(input, 'force', 'removeWorktree input');
      optionalRevision(input, 'removeWorktree input');
      return;
    }
    case 'setWorktreeSettings': {
      const input = objectArg(args[0], 'worktree settings');
      allowKeys(input, ['newTaskDefault', 'branchPrefix', 'sizeWarnBytes', 'autoCleanup'], 'worktree settings');
      if (!Object.keys(input).length) throw new TypeError('worktree settings require at least one setting.');
      if (
        input.newTaskDefault !== undefined &&
        !(DESKTOP_WORKTREE_NEW_TASK_DEFAULTS as readonly unknown[]).includes(input.newTaskDefault)
      ) {
        throw new TypeError('worktree settings newTaskDefault must be branch or worktree.');
      }
      if (input.branchPrefix !== undefined) refText(input.branchPrefix, 'worktree settings branchPrefix');
      if (
        input.sizeWarnBytes !== undefined &&
        (!Number.isSafeInteger(input.sizeWarnBytes) || (input.sizeWarnBytes as number) < 0)
      ) {
        throw new TypeError('worktree settings sizeWarnBytes must be a non-negative integer.');
      }
      optionalBoolean(input, 'autoCleanup', 'worktree settings');
      return;
    }
    case 'getBranchMenu':
    case 'getWorktreeSettings':
    case 'listWorktrees':
    case 'pruneWorktrees':
      return;
  }
}
