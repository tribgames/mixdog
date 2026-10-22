/**
 * The git tool's managed-worktree surface. Agents never create unmanaged
 * worktrees: `action: "worktree"` drives the Lead session's managed worktree
 * (the desktop branch menu's operations, same checks and refusals), and a raw
 * `git worktree …` command maps onto a managed operation instead of running:
 *
 *   add [-b <branch>] <path> [<commit-ish>]  → managed worktree for that branch; the session stays put
 *   add --detach <path> [<commit>]           → read-only snapshot, removed when the turn ends
 *   add <path> <commit> (not a branch)        → the same snapshot (git would detach there too)
 *   remove [-f] <path>                       → managed removal of that worktree (same guards)
 *   list                                     → managed worktrees (owners) plus unmanaged ones, flagged
 *   list --porcelain                         → raw git, unchanged (machine-readable truth)
 *   prune [-n]                               → managed prune (dry run: what it would remove)
 *   move | lock | unlock | repair            → refused: managed locations are fixed
 *
 * Every operation but `list` belongs to the Lead: the session runtime that
 * hosts the caller registers its host (shared/worktrees/tool-host.mjs); a
 * caller no host claims (a delegated worker) is refused.
 */
import { basename, resolve } from 'node:path';
import { isPlainObject } from '../../../../shared/object.mjs';
import { WORKTREE_REFUSAL_REASONS } from '../../../../shared/worktrees/contract.mjs';
import { firstLine, listWorktrees, runGit } from '../../../../shared/worktrees/git.mjs';
import { canonicalPath, samePath } from '../../../../shared/worktrees/paths.mjs';
import { worktreeToolHost } from '../../../../shared/worktrees/tool-host.mjs';

export const WORKTREE_TOOL_ACTIONS = Object.freeze(['enter', 'return', 'merge', 'remove', 'list', 'prune']);
const CARRY_CHOICES = ['leave', 'carry'];
// The input fields of action:"worktree" (confirm_large also answers a mapped `git worktree add`).
export const WORKTREE_INPUT_FIELDS = Object.freeze([
  'worktree_action',
  'session_id',
  'name',
  'branch',
  'create',
  'carry',
  'force',
]);

const ADD_BARE_FLAGS = new Set([
  '-q',
  '--quiet',
  '-f',
  '--force',
  '--lock',
  '--checkout',
  '--track',
  '--no-track',
  '--guess-remote',
  '--no-guess-remote',
]);
const FIXED_LOCATION_SUBCOMMANDS = new Set(['move', 'lock', 'unlock', 'repair']);

const fail = (message) => `error: ${message}`;
const okJson = (data) => JSON.stringify({ ok: true, ...data });

/** The desktop's byte size text (worktree-branch-model.ts formatByteSize). */
function formatByteSize(bytes) {
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

/** The runtime's own text after the last `<code>: ` prefix. */
function runtimeText(code, message) {
  const marker = `${code}: `;
  const index = message.lastIndexOf(marker);
  return (index >= 0 ? message.slice(index + marker.length) : message).trim();
}

/**
 * The desktop's wording of a typed failure (worktree-branch-model.ts
 * worktreeFailureText, English source strings); the runtime's message where
 * the desktop has none.
 */
function worktreeFailureText(code, message, details) {
  switch (code) {
    case 'WORKTREE_DISK_INSUFFICIENT': {
      const required = formatByteSize(Number(details.requiredBytes));
      const free = formatByteSize(Number(details.freeBytes));
      return required && free
        ? `Not enough free disk space to create the worktree (${required} needed, ${free} free).`
        : 'Not enough free disk space to create the worktree.';
    }
    case 'WORKTREE_FILE_RECOVERY':
      return 'Retained file recovery records block worktree removal, including force. Inspect and explicitly delete them first.';
    case 'WORKTREE_BUSY_JOBS':
      return (
        WORKTREE_REFUSAL_REASONS[details.reason] ??
        (details.reason === 'snapshot-held'
          ? message
          : 'Background tasks are still running. Wait for them or stop them, then try again.')
      );
    case 'WORKTREE_BRANCH_OCCUPIED':
      return typeof details.path === 'string' && details.path
        ? `This branch is already checked out in ${details.path}.`
        : 'This branch is already checked out in another worktree.';
    case 'WORKTREE_REMOVAL_INCOMPLETE':
      return 'The worktree could not be removed completely because a file is still in use. Close it and remove the worktree again.';
    case 'WORKTREE_PATH_UNSAFE':
      return 'The worktree folder is not a managed worktree of this project, so nothing was deleted.';
    case 'WORKTREE_MISSING':
      return 'The worktree folder is missing. Pick a project branch to continue.';
    case 'WORKTREE_REVISION_CONFLICT':
      return 'The workspace changed, so the menu was refreshed. Try again.';
    case 'WORKTREE_NOT_IMPLEMENTED':
      return 'Worktrees are not available yet.';
    case 'WORKTREE_UNSUPPORTED_REPO':
      return 'This folder does not support worktrees.';
    case 'WORKTREE_DIRTY': {
      // A refused carry names its own reason in the runtime's text.
      if (details.reason && details.reason !== 'project-dirty') return runtimeText(code, message);
      if (details.reason === 'project-dirty') {
        return 'The project folder has uncommitted changes. Commit or stash them before switching branches.';
      }
      return 'The worktree has uncommitted changes.';
    }
    case 'WORKTREE_PARTIAL_TRANSITION':
      return runtimeText(code, message);
    case 'WORKTREE_PROJECT_UNKNOWN':
      return 'Project is not available.';
    case 'WORKTREE_PROJECT_MISMATCH':
      return 'This session keeps a worktree of another project. Remove it before creating a new one here.';
    case 'WORKTREE_UNMERGED':
      return 'The worktree branch has commits that are not merged.';
    case 'MERGE_TARGET_DIRTY':
      return 'The branch to merge into has uncommitted changes. Commit or stash them first.';
    case 'WORKTREE_CONFIRM_REQUIRED':
      return 'Confirm the merge before it runs.';
    case 'WORKTREE_TARGET_MISMATCH':
      return 'The project folder switched to another branch. Check the target and merge again.';
    case 'MERGE_FAILED': {
      const reason = runtimeText(code, message);
      return reason ? `The merge failed: ${reason}` : 'The merge failed.';
    }
    case 'MERGE_CONFLICT': {
      const files = Array.isArray(details.files) ? details.files.map(String) : [];
      if (!files.length) return 'Nothing was merged because the branches conflict.';
      return `Nothing was merged. Conflicting files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}`;
    }
    default:
      return message;
  }
}

/** What the caller does next, for the refusals that need the user or a retry. */
function nextStep(code, details, { raw }) {
  switch (code) {
    case 'WORKTREE_DIRTY_CHOICE':
      return `Ask the user whether to leave the ${details.count ?? 'uncommitted'} uncommitted change(s) in the project folder or carry them into the worktree; then call again with carry:"leave" or carry:"carry".`;
    case 'WORKTREE_LARGE_REPO_CONFIRM': {
      const size = formatByteSize(Number(details.estimateBytes));
      return `Tell the user the worktree needs about ${size || 'a lot of disk space'} and ask to confirm; only on yes call again with confirm_large:true${raw ? ' (same command)' : ''}.`;
    }
    case 'WORKTREE_REVISION_CONFLICT':
      return 'The workspace changed meanwhile; call again (the workspace is read afresh).';
    case 'WORKTREE_BUSY_JOBS':
      return 'Nothing was changed; try again once the session and its workers are idle.';
    case 'MERGE_CONFLICT':
      return 'Nothing was merged or forced. Resolve the conflict in the worktree (merge the target branch into it there), or ask the user.';
    case 'WORKTREE_DIRTY':
    case 'WORKTREE_UNMERGED':
      return 'Nothing was removed. Commit or merge the work first; force only when the user explicitly asks to discard it.';
    default:
      return null;
  }
}

/** A failed operation for the model: typed failures as JSON with their details, others as text. */
function failureText(error, { raw = false } = {}) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = String(error?.message || error);
  if (!/^(?:WORKTREE|MERGE)_/.test(code)) return fail(message);
  const details = isPlainObject(error.details) ? error.details : {};
  const next = nextStep(code, details, { raw });
  return JSON.stringify({
    ok: false,
    code,
    error: worktreeFailureText(code, message, details),
    ...(Object.keys(details).length ? { details } : {}),
    ...(next ? { next } : {}),
  });
}

function compactWorkspace(workspace) {
  if (!workspace) return null;
  return {
    cwd: workspace.cwd,
    branch: workspace.branch ?? null,
    mergeTarget: workspace.mergeTarget ?? null,
    revision: workspace.revision,
    worktreeId: workspace.worktreeId ?? null,
  };
}

/** A workspace operation's result: its own fields, the workspace compacted. */
function transitionResult(fields, result) {
  const { workspace, revision: _revision, pending: _pending, ...rest } = isPlainObject(result) ? result : {};
  return okJson({ ...fields, ...rest, ...(workspace ? { workspace: compactWorkspace(workspace) } : {}) });
}

/** The Lead host of the caller; a caller none claims is no Lead. */
function leadHost(options, what) {
  const host = worktreeToolHost(options?.sessionId);
  if (!host) {
    throw new Error(`${what} belongs to the Lead session; delegated workers cannot create, change or remove worktrees`);
  }
  return host;
}

const runOn = (host, request, options) => host.run(request, { callerSessionId: options.sessionId });

/** The transaction id of one operation of this tool call (stable across a retry of the call). */
function txIdOf(options, discriminator) {
  const id = String(options?.toolCallId || '').trim();
  return id ? `${id}:${discriminator}` : '';
}

/** Repository facts in `cwd` from git itself (null outside a repository). */
async function repositoryAt(cwd) {
  const probe = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFailure: true });
  return probe.code === 0 ? { repoCommonDir: canonicalPath(firstLine(probe.stdout)) } : null;
}

async function localBranchExists(cwd, branch) {
  const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    allowFailure: true,
  });
  return result.code === 0;
}

/** Full commit id of commit-ish `value` resolved in `cwd`, or null. */
async function commitIn(cwd, value) {
  if (!value || value.startsWith('-')) return null;
  const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`], { allowFailure: true });
  return result.code === 0 ? firstLine(result.stdout) : null;
}

/**
 * Managed rows (the owners) of the repository at `cwd` (every repository
 * outside one) plus the repository's other git worktrees: the main checkout
 * and unmanaged ones, flagged.
 */
async function listRows(options, cwd) {
  const host = worktreeToolHost(options?.sessionId);
  const managed = host
    ? await runOn(host, { op: 'list' }, options)
    : await (await import('../../../../shared/worktrees/manager.mjs')).listManagedWorktrees();
  const repo = await repositoryAt(cwd);
  const ours = repo ? managed.filter((row) => samePath(row.repoCommonDir, repo.repoCommonDir)) : managed;
  const rows = ours.map((row) => ({
    id: row.id,
    path: row.path,
    branch: row.branch ?? null,
    ...(row.kind === 'snapshot'
      ? { snapshot: true, commit: row.baseCommit, holderSessionId: row.holderSessionId ?? null }
      : { ownerSessionId: row.ownerSessionId ?? null, mergeTarget: row.mergeTarget ?? null }),
    state: row.state,
    ...(typeof row.ownerLive === 'boolean' ? { ownerLive: row.ownerLive } : {}),
    ...(host && typeof row.removable === 'boolean' ? { removable: row.removable } : {}),
  }));
  if (!repo) return { worktrees: rows };
  // git lists the main working tree first.
  const [main, ...linked] = await listWorktrees(cwd);
  const unmanaged = linked
    .filter((worktree) => !ours.some((row) => samePath(row.path, worktree.path)))
    .map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch,
      ...(worktree.detached ? { head: worktree.head } : {}),
      unmanaged: true,
      ...(worktree.prunable ? { prunable: true } : {}),
    }));
  return { worktrees: [{ path: main.path, branch: main.branch, main: true }, ...rows, ...unmanaged] };
}

/**
 * `git worktree add`: a managed worktree for a branch (the session does not
 * move), or a read-only snapshot for a detached commit. The path argument is
 * never used; the result names the managed path.
 */
async function rawAdd(plan, input, options) {
  let branch = null;
  let reset = false;
  let detach = false;
  const positional = [];
  const args = plan.args.slice(1);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (value === '-b' || value === '-B') {
      branch = args[++index];
      reset = value === '-B';
      if (!branch) throw new Error(`git worktree add: ${value} requires a branch name`);
      continue;
    }
    if (value === '--reason') {
      index++;
      continue;
    }
    if (value.startsWith('--reason=')) continue;
    if (value === '--detach' || value === '-d') {
      detach = true;
      continue;
    }
    if (value === '--orphan' || value === '--no-checkout') {
      throw new Error(`git worktree add: ${value} is not supported for managed worktrees`);
    }
    if (ADD_BARE_FLAGS.has(value)) continue;
    if (value.startsWith('-')) throw new Error(`git worktree add: option ${value} is not supported for managed worktrees`);
    positional.push(value);
  }
  const [path, commitish = null] = positional;
  if (!path || positional.length > 2) throw new Error('git worktree add requires <path> [<commit-ish>]');
  if (detach && branch) throw new Error('git worktree add: --detach excludes -b/-B');
  const host = leadHost(options, 'git worktree add');
  const repo = await repositoryAt(plan.cwd);
  if (!repo) throw new Error(`git worktree add: ${plan.cwd} is not a git repository`);
  const confirmLarge = input.confirm_large === true;
  const txId = txIdOf(options, plan.command);
  const mapped = { mapped: plan.command, requestedPath: resolve(plan.cwd, path) };
  // A detached checkout, or a commit-ish that names no local branch: a snapshot.
  const snapshotCommit = detach
    ? (commitish ?? 'HEAD')
    : !branch && commitish && !(await localBranchExists(plan.cwd, commitish))
      ? commitish
      : null;
  if (snapshotCommit) {
    const commit = await commitIn(plan.cwd, snapshotCommit);
    if (!commit) throw new Error(`git worktree add: ${snapshotCommit} is not a commit`);
    const entry = await runOn(
      host,
      { op: 'snapshot', commit, confirmLarge, txId, repoCommonDir: repo.repoCommonDir },
      options
    );
    return okJson({
      ...mapped,
      snapshot: true,
      path: entry.path,
      commit: entry.baseCommit,
      worktreeId: entry.id,
      note: 'Managed read-only snapshot at the path above (not the one requested); it is removed when this turn ends, and changes made in it are discarded. The session did not move.',
    });
  }
  let create;
  let startPoint = null;
  if (branch) {
    const exists = await localBranchExists(plan.cwd, branch);
    if (exists) {
      throw new Error(
        reset
          ? `git worktree add: -B would reset the existing branch ${branch}; managed worktrees never reset a branch (omit -B to check it out as it is)`
          : `git worktree add: a branch named '${branch}' already exists (omit -b to check it out)`
      );
    }
    create = true;
    startPoint = await commitIn(plan.cwd, commitish ?? 'HEAD');
    if (!startPoint) throw new Error(`git worktree add: ${commitish} is not a commit`);
  } else {
    // git's convenience: no branch named, so the branch is the commit-ish
    // (an existing local branch) or the path's last segment.
    branch = commitish ?? basename(resolve(plan.cwd, path));
    create = !(await localBranchExists(plan.cwd, branch));
    if (create) startPoint = await commitIn(plan.cwd, 'HEAD');
  }
  const added = await runOn(
    host,
    { op: 'add', branch, create, startPoint, confirmLarge, txId, repoCommonDir: repo.repoCommonDir },
    options
  );
  return okJson({
    ...mapped,
    ...added,
    note: `Managed worktree at the path above (not the one requested), retained by this session. The session did not move; worktree_action:"enter" with branch:"${branch}" moves it there.`,
  });
}

async function rawRemove(plan, options) {
  let force = false;
  const positional = [];
  for (const value of plan.args.slice(1)) {
    if (value === '-f' || value === '--force') force = true;
    else if (value.startsWith('-')) throw new Error(`git worktree remove: option ${value} is not supported`);
    else positional.push(value);
  }
  if (positional.length !== 1) throw new Error('git worktree remove requires exactly one <path>');
  const host = leadHost(options, 'git worktree remove');
  const path = resolve(plan.cwd, positional[0]);
  const result = await runOn(host, { op: 'remove-path', path, force }, options);
  return transitionResult({ mapped: plan.command, path }, result);
}

/** `git worktree prune` arguments, all validated before anything runs. */
function parsePruneArgs(args) {
  let dryRun = false;
  for (const value of args) {
    if (value === '-n' || value === '--dry-run') dryRun = true;
    else if (value === '-v' || value === '--verbose') continue;
    else if (value.startsWith('-')) {
      throw new Error(
        `git worktree prune: option ${value} is not supported (managed prune takes -n/--dry-run and -v/--verbose)`
      );
    } else throw new Error(`git worktree prune: unexpected argument ${value}`);
  }
  return { dryRun };
}

/**
 * The prune and its dry run share one scope: the repository of the command's
 * directory (every repository outside one), so the preview names exactly what
 * the real prune may touch.
 */
async function rawPrune(plan, options) {
  const { dryRun } = parsePruneArgs(plan.args.slice(1));
  const host = leadHost(options, 'git worktree prune');
  if (dryRun) {
    const { worktrees } = await listRows(options, plan.cwd);
    return okJson({ mapped: plan.command, dryRun: true, wouldRemove: worktrees.filter((row) => row.removable) });
  }
  const repo = await repositoryAt(plan.cwd);
  return okJson({
    mapped: plan.command,
    ...(await runOn(host, { op: 'prune', repoCommonDir: repo?.repoCommonDir ?? null }, options)),
  });
}

const WORKTREE_HELP = Object.freeze({
  add: 'git worktree add [-b <branch>] [--detach] <path> [<commit-ish>]: a managed worktree for the branch (the session stays put), or a read-only snapshot for a detached commit.',
  remove: 'git worktree remove [-f] <path>: the managed removal of that worktree.',
  list: 'git worktree list [-v]: managed worktrees plus the repository\'s other worktrees. --porcelain stays raw git.',
  prune: 'git worktree prune [-n|--dry-run] [-v]: the managed prune of this repository (clean, merged worktrees no session retains); -n only lists what it would remove.',
});

/** -h/--help before any `--` (the help answers instead of the operation running). */
function wantsHelp(args) {
  const end = args.indexOf('--');
  return (end < 0 ? args : args.slice(0, end)).some((value) => value === '-h' || value === '--help');
}

/** `git worktree list` takes no managed option beyond -v; the rest is validated, not ignored. */
function checkListArgs(args) {
  for (const value of args) {
    if (value === '-v' || value === '--verbose') continue;
    throw new Error(`git worktree list: ${value.startsWith('-') ? `option ${value} is not supported` : `unexpected argument ${value}`}`);
  }
}

/**
 * A raw `git worktree …` command as its managed operation: `{ text, failed }`,
 * or null for the one form that still runs as git (`list --porcelain`).
 */
export async function executeRawWorktree(plan, input, options = {}) {
  const sub = String(plan.args[0] || '');
  if (WORKTREE_HELP[sub] && wantsHelp(plan.args.slice(1))) {
    return { text: okJson({ mapped: plan.command, help: WORKTREE_HELP[sub] }), failed: false };
  }
  if (sub === 'list' && plan.args.includes('--porcelain')) return null;
  try {
    if (sub === 'list') checkListArgs(plan.args.slice(1));
    if (sub === 'list') return { text: okJson({ mapped: plan.command, ...(await listRows(options, plan.cwd)) }), failed: false };
    if (sub === 'add') return { text: await rawAdd(plan, input, options), failed: false };
    if (sub === 'remove') return { text: await rawRemove(plan, options), failed: false };
    if (sub === 'prune') return { text: await rawPrune(plan, options), failed: false };
    if (FIXED_LOCATION_SUBCOMMANDS.has(sub)) {
      return {
        text: fail(
          `git worktree ${sub} is refused: Mixdog-managed worktrees stay at their fixed, locked locations. Use git worktree list/remove/prune or action:"worktree"`
        ),
        failed: true,
      };
    }
    return {
      text: fail(`git worktree ${sub || '(no subcommand)'} is not supported; use add, remove, list, prune or action:"worktree"`),
      failed: true,
    };
  } catch (error) {
    return { text: failureText(error, { raw: true }), failed: true };
  }
}

/** Validation of action:"worktree" input; the problem text, or null. */
function worktreeInputError(input) {
  const action = input.worktree_action;
  if (!WORKTREE_TOOL_ACTIONS.includes(action)) {
    return `git action:worktree requires worktree_action: ${WORKTREE_TOOL_ACTIONS.join(', ')}`;
  }
  for (const field of ['command', 'diff_id', 'change_ids', 'include_stage_ids', 'output_limit']) {
    if (input[field] !== undefined) return `git action:worktree does not take ${field}`;
  }
  const only = (field, allowed) =>
    input[field] !== undefined && !allowed.includes(action)
      ? `${field} applies to worktree_action ${allowed.join(', ')}, not ${action}`
      : null;
  const misplaced =
    only('session_id', ['enter', 'return', 'merge', 'remove']) ||
    only('name', ['enter']) ||
    only('branch', ['enter']) ||
    only('create', ['enter']) ||
    only('carry', ['enter']) ||
    only('confirm_large', ['enter']) ||
    only('force', ['remove']);
  if (misplaced) return misplaced;
  if (input.session_id !== undefined && (typeof input.session_id !== 'string' || !input.session_id.trim())) {
    return 'session_id must be a session id';
  }
  if (input.create !== undefined && !input.branch) return 'create needs branch';
  if (input.branch !== undefined && (typeof input.branch !== 'string' || !input.branch.trim())) {
    return 'branch must be a branch name';
  }
  if (input.branch && (input.name !== undefined || input.carry !== undefined)) {
    return 'branch excludes name and carry (the branch names the worktree; changes stay in the project folder)';
  }
  if (input.carry !== undefined && !CARRY_CHOICES.includes(input.carry)) return 'carry must be leave or carry';
  return null;
}

/** action:"worktree": one managed-worktree operation of the caller's (or `session_id`'s) session. */
export async function executeWorktreeAction(input, workDir, options = {}) {
  const problem = worktreeInputError(input);
  if (problem) return fail(problem);
  const action = input.worktree_action;
  try {
    if (action === 'list') return okJson({ worktree_action: action, ...(await listRows(options, resolve(workDir || process.cwd()))) });
    const host = leadHost(options, `git worktree_action ${action}`);
    const sessionId = input.session_id?.trim() || null;
    const request = {
      op: action,
      ...(sessionId ? { sessionId } : {}),
      ...(action === 'enter'
        ? {
            name: input.name,
            branch: input.branch?.trim() || null,
            create: input.create === true,
            carry: input.carry,
            confirmLarge: input.confirm_large === true,
          }
        : {}),
      ...(action === 'remove' ? { force: input.force === true } : {}),
      ...(action === 'prune' ? { repoCommonDir: (await repositoryAt(resolve(workDir || process.cwd())))?.repoCommonDir ?? null } : {}),
      txId: txIdOf(options, action),
    };
    const result = await runOn(host, request, options);
    if (action === 'prune') return okJson({ worktree_action: action, ...result });
    return transitionResult({ worktree_action: action, ...(sessionId ? { sessionId } : {}) }, result);
  } catch (error) {
    return failureText(error);
  }
}
