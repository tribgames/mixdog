/**
 * The serialized moves of the hosted Lead: every workspace transition (enter
 * a worktree, run in a branch's checkout, remove the retained worktree) and
 * the Project switch. Each one is admitted against turns and other workspace
 * changes, checks the Lead is idle, and journals its steps so a failure puts
 * back exactly what already moved. Also the input checks the workspace API
 * shares (worktree name, target, expected revision).
 */
import {
  isWorktreeBound,
  normalizeSessionWorkspace,
  worktreeError,
  worktreeNameError,
} from '../../runtime/shared/worktrees/contract.mjs';
import { throwIfAborted } from '../../runtime/shared/worktrees/git.mjs';
import { beginWorkspaceTransition } from './admission-gate.mjs';
import { undoAll } from './transition-steps.mjs';
import { readSessionWorkspace } from './workspace-state.mjs';

const WORKTREE_BOUND_SWITCH =
  'The session works in a managed worktree; exit the worktree first (switch to a project-folder branch, or merge or remove the worktree) before moving it to another project.';

/** The in-flight marker state of each transition kind. */
const TRANSITION_STATE = { worktree: 'provisioning', branch: 'switching', 'remove-worktree': 'removing' };

export function validName(name) {
  if (name === undefined || name === null) return null;
  const error = worktreeNameError(name);
  if (error) throw new TypeError(`worktree name is invalid: ${error}`);
  return name;
}

function normalizeTarget(target) {
  const kind = target?.kind;
  if (kind === 'worktree') return { kind, name: validName(target.name) };
  if (kind === 'branch') {
    if (typeof target.branch !== 'string' || !target.branch.trim()) {
      throw new TypeError('workspace target branch must be a non-empty string.');
    }
    return { kind, branch: target.branch.trim(), create: target.create === true };
  }
  if (kind === 'remove-worktree') return { kind, force: target.force === true };
  throw new TypeError('workspace target kind must be branch, worktree or remove-worktree.');
}

export function validRevision(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('expectedRevision must be a non-negative integer.');
  }
  return value;
}

/** WORKTREE_REVISION_CONFLICT when the caller expected another workspace revision. */
export function assertRevision(revision, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    throw worktreeError('WORKTREE_REVISION_CONFLICT', undefined, { expectedRevision, revision });
  }
}

/**
 * @param {object} deps The session view (hostedSession, currentWorkspace),
 *   assertLeadIdle, the transition `steps` and the host's cwd hooks.
 */
export function createTransitionRunner({
  getSession,
  hostedSession,
  currentWorkspace,
  assertLeadIdle,
  steps,
  newTxId,
  applyResolvedCwd,
  getCurrentCwd,
}) {
  async function transition(session, target, options = {}) {
    throwIfAborted(options.signal);
    const previous = currentWorkspace(session);
    assertRevision(previous.revision, options.expectedRevision);
    const txId = String(options.txId || '').trim() || newTxId();
    const leave = beginWorkspaceTransition(session.id, txId);
    const hadRecord = Object.hasOwn(session, 'workspace');
    const stored = session.workspace;
    const marker = normalizeSessionWorkspace({
      ...previous,
      transition: { state: TRANSITION_STATE[target.kind], txId },
    });
    session.workspace = marker;
    const restore = () => {
      if (hadRecord) session.workspace = stored;
      else delete session.workspace;
    };
    const journal = [];
    try {
      await assertLeadIdle(session, { ownTurn: options.ownTurn === true });
      const run = { signal: options.signal, txId, journal };
      // A new checkout gets its dependencies prepared at the start of the
      // first turn a session runs there (runPendingSetup, from its registry entry).
      if (target.kind === 'worktree') {
        return await steps.enterWorktree(session, previous, {
          ...run,
          name: target.name,
          nameHint: options.nameHint,
          confirmLarge: options.confirmLarge,
          changes: options.changes,
        });
      }
      if (target.kind === 'branch') {
        return await steps.enterProjectBranch(session, previous, {
          ...run,
          branch: target.branch,
          create: target.create,
          confirmLarge: options.confirmLarge,
        });
      }
      return await steps.removeRetainedWorktree(session, previous, { ...run, force: target.force });
    } catch (error) {
      // Whatever already moved (cwd, record, prompts, worker roots, lease)
      // goes back exactly; the previous workspace stays authoritative.
      await undoAll(journal, error);
      throw error;
    } finally {
      if (session.workspace === marker) restore();
      leave();
    }
  }

  /**
   * The one entry of every transition. `ownTurn` (internal: the Lead's own
   * tool call) tolerates the calling turn; `txId` keys the creation.
   */
  async function runTransition(sessionRef, target, options = {}, { ownTurn = false, txId = '' } = {}) {
    const session = hostedSession(sessionRef);
    return transition(session, normalizeTarget(target), {
      expectedRevision: validRevision(options.expectedRevision),
      confirmLarge: options.confirmLarge === true,
      signal: options.signal,
      ownTurn: ownTurn === true,
      txId,
    });
  }

  async function removeWorktree({ force = false, expectedRevision } = {}, { ownTurn = false } = {}) {
    const expected = validRevision(expectedRevision);
    const session = hostedSession(null);
    return transition(
      session,
      { kind: 'remove-worktree', force: force === true },
      { ownTurn: ownTurn === true, expectedRevision: expected }
    );
  }

  /**
   * Move the hosted Lead to another Project folder (session set-project, the
   * desktop/remote setCwd): the one authority for a Project switch, admitted
   * like a workspace transition. Refused while a turn runs (`ownTurn`: the
   * Lead's own tool call tolerates its calling turn), while workers run, and
   * while the session works in a managed worktree. Serialized with turns and
   * other workspace changes; the prompt refresh of the Lead and its idle
   * workers completes (or rolls the switch back) before it resolves. Without
   * a session (a draft) only the runtime cwd and the selection move.
   * `classifyByMembership` (the desktop/remote move): a folder outside every
   * registered Project is classified as a task (cwd-apply).
   * @returns {Promise<string>} the runtime cwd after the switch
   */
  async function switchProject(cwd, { ownTurn = false, classifyByMembership = false } = {}) {
    const selection = { classifyByMembership: classifyByMembership === true };
    const session = getSession();
    if (!session?.id) {
      applyResolvedCwd(cwd, { persistProjectSelection: true, ...selection });
      return getCurrentCwd();
    }
    const leave = beginWorkspaceTransition(session.id, `project:${newTxId()}`);
    const journal = [];
    try {
      await assertLeadIdle(session, { ownTurn: ownTurn === true, shellJobs: false });
      if (isWorktreeBound(readSessionWorkspace(session))) throw new Error(WORKTREE_BOUND_SWITCH);
      await steps.switchProject(session, cwd, journal, selection);
      return getCurrentCwd();
    } catch (error) {
      await undoAll(journal, error);
      throw error;
    } finally {
      leave();
    }
  }

  return { transition, runTransition, removeWorktree, switchProject };
}
