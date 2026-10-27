/**
 * The Lead's managed-worktree operations behind the `git` tool
 * (`action: "worktree"` and the mapped `git worktree …` commands), over the
 * same workspace authority the desktop branch menu drives:
 *
 * - The caller's own session runs through this runtime's workspace API with
 *   `ownTurn` (the calling turn is tolerated; workers, background shells and
 *   other sessions in an affected folder are not).
 * - Another session runs through session control (the daemon's
 *   `session.configure` lane): no `ownTurn`, so a target with a running turn,
 *   workers or background shells refuses (WORKTREE_BUSY_JOBS).
 *
 * Every failure keeps its typed WorktreeError (code, details); interactive
 * refusals (WORKTREE_DIRTY_CHOICE, WORKTREE_LARGE_REPO_CONFIRM) carry what the
 * caller needs to ask the user before it calls again.
 */
import { worktreeError, worktreeNameError } from '../../runtime/shared/worktrees/contract.mjs';
import { samePath } from '../../runtime/shared/worktrees/paths.mjs';
import { assertWorktreeMutationAllowed, worktreeCallerScope } from '../services/worktree-access.mjs';

const loadManager = () => import('../../runtime/shared/worktrees/manager.mjs');

/**
 * @param {object} deps
 * @param {() => any} deps.getSession The Lead session this runtime hosts (its trusted caller scope).
 * @param {() => any} deps.getWorkspaceApi The runtime's workspace transitions (late-bound).
 * @param {((args: object, context: object) => Promise<any>)|null} [deps.executeSessionControl] Cross-session lane.
 * @param {object|null} [deps.manager] Managed-worktree backend override (tests).
 */
export function createWorktreeToolHost({
  getSession,
  getWorkspaceApi,
  executeSessionControl = null,
  manager = null,
}) {
  const backend = () => (manager ? Promise.resolve(manager) : loadManager());

  function workspaceApi() {
    const api = getWorkspaceApi();
    if (!api) throw new Error('git worktree: managed worktrees are unavailable in this runtime');
    return api;
  }

  /**
   * The workspace lane of `sessionId`: the caller's own (null/equal) or
   * another session's, which carries the caller's trusted `scope` for the
   * daemon to check again.
   */
  function laneFor(sessionId, callerSessionId, scope) {
    if (!sessionId || sessionId === callerSessionId) {
      const api = workspaceApi();
      return {
        own: true,
        menu: () => api.getBranchMenu(),
        call: (method, input) => api[method](input, { ownTurn: true }),
      };
    }
    if (typeof executeSessionControl !== 'function') {
      throw new Error("git worktree: another session's workspace is unavailable in this runtime");
    }
    const control = (method, input) =>
      executeSessionControl(
        { action: 'worktree', session_id: sessionId, method, ...(input ? { input } : {}) },
        { callerSessionId, callerScope: scope }
      );
    return { own: false, menu: () => control('getBranchMenu'), call: control };
  }

  async function enter(lane, request) {
    if (request.branch) {
      return lane.call('selectBranch', {
        branch: request.branch,
        create: request.create === true,
        confirmLarge: request.confirmLarge === true,
        txId: request.txId,
      });
    }
    // A valid slug names the worktree; any other text is a hint the slug is made from.
    const name = typeof request.name === 'string' ? request.name.trim() : '';
    const slug = name && !worktreeNameError(name) ? name : null;
    return lane.call('requestWorktree', {
      provision: true,
      name: slug,
      prompt: slug ? '' : name,
      ...(request.carry ? { carryChanges: request.carry } : {}),
      confirmLarge: request.confirmLarge === true,
      txId: request.txId,
    });
  }

  /** Back to the project folder (the branch checked out there); the worktree stays retained. */
  async function back(lane, request) {
    const menu = await lane.menu();
    const workspace = menu.workspace;
    if (!workspace.worktreeId && samePath(workspace.cwd, workspace.projectPath)) {
      return { revision: workspace.revision, workspace, unchanged: true };
    }
    const projectBranch = menu.occupancy.find((row) => row.kind === 'current')?.branch ?? null;
    if (!projectBranch) {
      throw worktreeError(
        'WORKTREE_UNSUPPORTED_REPO',
        'The project folder has no checked-out branch to return to (detached HEAD).'
      );
    }
    return lane.call('selectBranch', { branch: projectBranch, expectedRevision: workspace.revision, txId: request.txId });
  }

  /** The desktop's "merge": into the confirmed merge target, then the cleanup autoCleanup allows. */
  async function merge(lane) {
    const { workspace } = await lane.menu();
    return lane.call('mergeWorkspace', {
      confirmed: true,
      target: workspace.mergeTarget ?? null,
      expectedRevision: workspace.revision,
      cleanup: true,
    });
  }

  /**
   * The listed worktree matching `predicate` whose owner is gone and that the
   * list reports removable, or null: no owner lane can remove it.
   */
  async function orphan(predicate) {
    const rows = await workspaceApi().listWorktrees();
    return rows.find((row) => predicate(row) && row.ownerLive === false && row.removable === true) ?? null;
  }

  /**
   * `git worktree remove <path>`: the managed removal of whichever owner
   * holds it — this session's snapshot, or the worktree a session retains
   * (its own lane: the same guards as the desktop's removal).
   */
  async function removePath(request, callerSessionId, scope) {
    const entry = await (await backend()).getWorktreeByPath(request.path);
    if (!entry) {
      throw new Error(
        `git worktree remove: ${request.path} is not a Mixdog-managed worktree; unmanaged worktrees are not removed through the git tool`
      );
    }
    if (entry.kind === 'snapshot') return workspaceApi().removeSnapshot({ path: entry.path, force: request.force });
    if (entry.ownerSessionId !== callerSessionId && (await orphan((row) => row.id === entry.id))) {
      return workspaceApi().removeOrphanWorktree({ entryId: entry.id, force: request.force === true });
    }
    if (!entry.ownerSessionId) {
      throw new Error(
        `git worktree remove: no session retains ${entry.path}; git worktree prune removes it once it is clean and merged`
      );
    }
    const lane = laneFor(entry.ownerSessionId, callerSessionId, scope);
    const menu = await lane.menu();
    if (menu.retainedWorktree?.id !== entry.id) {
      throw new Error(
        `git worktree remove: ${entry.path} is not the current worktree of session ${entry.ownerSessionId}; enter it (worktree_action enter, branch ${entry.branch}) first, then remove it`
      );
    }
    return lane.call('removeWorktree', { force: request.force === true, expectedRevision: menu.workspace.revision });
  }

  /**
   * @param {{ op: string } & Record<string, any>} request
   * @param {{ callerSessionId: string }} context
   */
  async function run(request, { callerSessionId }) {
    // Trusted state of the calling Lead, never model input: every operation
    // but `list` needs an attended conversation.
    const scope = worktreeCallerScope(getSession());
    if (request.op !== 'list') assertWorktreeMutationAllowed(scope, `git worktree ${request.op}`);
    const lane = () => laneFor(request.sessionId, callerSessionId, scope);
    switch (request.op) {
      case 'enter':
        return enter(lane(), request);
      case 'return':
        return back(lane(), request);
      case 'merge':
        return merge(lane());
      case 'remove': {
        const force = request.force === true;
        if (request.sessionId && request.sessionId !== callerSessionId) {
          const gone = await orphan((row) => row.ownerSessionId === request.sessionId);
          if (gone) return workspaceApi().removeOrphanWorktree({ entryId: gone.id, force });
        }
        return lane().call('removeWorktree', { force });
      }
      case 'list':
        return workspaceApi().listWorktrees({ includeSnapshots: true });
      case 'prune':
        return workspaceApi().pruneWorktrees({ repoCommonDir: request.repoCommonDir ?? null });
      case 'add':
        return workspaceApi().addBranchWorktree({
          branch: request.branch,
          create: request.create === true,
          startPoint: request.startPoint ?? null,
          confirmLarge: request.confirmLarge === true,
          txId: request.txId,
          repoCommonDir: request.repoCommonDir ?? null,
        });
      case 'snapshot':
        return workspaceApi().createSnapshot({
          commit: request.commit,
          confirmLarge: request.confirmLarge === true,
          txId: request.txId,
          repoCommonDir: request.repoCommonDir ?? null,
        });
      case 'remove-path':
        return removePath(request, callerSessionId, scope);
      default:
        throw new TypeError(`git worktree: unknown operation ${request.op}`);
    }
  }

  return { run };
}
