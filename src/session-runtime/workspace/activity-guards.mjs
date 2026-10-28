/**
 * The activity checks every workspace change runs first: whether the hosted
 * Lead (its turn, workers and background shells) is idle, and whether other
 * sessions work in a shared checkout — then holding that checkout so new
 * turns there wait until the change settles (admission gate).
 */
import { worktreeError, worktreeRefusal } from '../../runtime/shared/worktrees/contract.mjs';
import { isWithin } from '../../runtime/shared/worktrees/paths.mjs';
import {
  holdWorkspaceActivity,
  isExternalCheckout,
  releaseAll,
} from '../../runtime/shared/worktrees/activity-gate.mjs';
import { AGENT_OWNER } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { holdCheckoutFolder } from './admission-gate.mjs';

const ACTIVE_STAGES = new Set(['connecting', 'requesting', 'streaming', 'tool_running', 'running', 'cancelling']);
const BUSY_WORKER_STATES = new Set([...ACTIVE_STAGES, 'starting', 'spawning', 'queued', 'pending']);
const BUSY_JOB_STATES = new Set(['starting', 'spawning', 'queued', 'pending', 'running']);

const lower = (value) => String(value || '').toLowerCase();

/** @param {object} deps The activity sources of createWorkspaceTransitions. */
export function createActivityGuards({
  getActiveTurnCount,
  agentStatusState,
  countOwnShellJobs,
  listLiveSessions,
  sessionManager,
  listWorkspaceConsumers,
  listWorkspaceJobs,
}) {
  function isSessionActive(session) {
    const runtime = sessionManager?.getSessionRuntime?.(session.id);
    if (runtime?.controller?.signal && !runtime.controller.signal.aborted) return true;
    return ACTIVE_STAGES.has(lower(runtime?.stage || session.status));
  }

  const workersOf = (session) =>
    listLiveSessions().filter(
      (candidate) =>
        candidate?.id &&
        candidate.id !== session.id &&
        candidate.owner === AGENT_OWNER &&
        candidate.closed !== true &&
        (candidate.ownerSessionId === session.id || candidate.parentSessionId === session.id)
    );

  /**
   * WORKTREE_BUSY_JOBS while this Lead has a turn, workers or background
   * shells running (`shellJobs: false` tolerates background shells).
   */
  async function assertLeadIdle(session, { ownTurn = false, shellJobs: checkShellJobs = true } = {}) {
    if (!ownTurn && getActiveTurnCount() > 0) {
      throw worktreeError('WORKTREE_BUSY_JOBS', 'The session is running a turn; wait for it to finish.', {
        reason: 'turn',
      });
    }
    const status = agentStatusState?.() || {};
    const workers = Array.isArray(status.agentWorkers) ? status.agentWorkers : [];
    const jobs = Array.isArray(status.agentJobs) ? status.agentJobs : [];
    const busyWorkers = workers.filter(
      (row) => BUSY_WORKER_STATES.has(lower(row?.status)) || BUSY_WORKER_STATES.has(lower(row?.stage))
    ).length;
    const busyJobs = jobs.filter((row) => BUSY_JOB_STATES.has(lower(row?.status))).length;
    if (busyWorkers || busyJobs) {
      throw worktreeError('WORKTREE_BUSY_JOBS', undefined, { reason: 'workers', workers: busyWorkers, jobs: busyJobs });
    }
    if (!checkShellJobs) return;
    const ids = new Set([session.id, ...workers.map((row) => row?.sessionId).filter(Boolean)]);
    for (const worker of workersOf(session)) ids.add(worker.id);
    const shellJobs = await countOwnShellJobs([...ids]);
    if (shellJobs > 0) throw worktreeError('WORKTREE_BUSY_JOBS', undefined, { reason: 'shell-jobs', shellJobs });
  }

  /**
   * A checkout or merge in the shared checkout `folder` refuses while another
   * session (not this Lead's own workers) works there, then holds the folder
   * until the returned release: other sessions' turns that arrive meanwhile
   * wait (admission gate). `sessionId` null: a session-less (draft) change.
   * @returns {() => void}
   */
  function holdProjectFolder(sessionId, folder, { hold = true } = {}) {
    const users = listLiveSessions().filter(
      (candidate) =>
        candidate?.id &&
        candidate.id !== sessionId &&
        candidate.closed !== true &&
        (!sessionId || (candidate.ownerSessionId !== sessionId && candidate.parentSessionId !== sessionId)) &&
        typeof candidate.cwd === 'string' &&
        isWithin(folder, candidate.cwd) &&
        isSessionActive(candidate)
    );
    if (users.length) throw worktreeRefusal('folder-in-use', { sessions: users.map((candidate) => candidate.id) });
    return holdCheckoutFolder(sessionId, folder, { hold });
  }

  /** Run `fn` holding the checkout `folder` (holdProjectFolder); released when it settles. */
  async function withProjectFolder(sessionId, folder, fn) {
    const release = holdProjectFolder(sessionId, folder);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Before a carry clears the shared checkout `folder` (held by the caller,
   * so no new turn starts there): WORKTREE_BUSY_JOBS while any other session
   * working in it — idle or not, this Lead's workers included — owns a
   * running background shell (holdProjectFolder already refused running
   * turns and agents there, assertLeadIdle this Lead's own). Processes
   * outside Mixdog (editors, watchers) cannot be excluded.
   */
  async function assertCheckoutQuiet(session, folder) {
    const sharing = listLiveSessions()
      .filter(
        (candidate) =>
          candidate?.id &&
          candidate.id !== session.id &&
          candidate.closed !== true &&
          typeof candidate.cwd === 'string' &&
          isWithin(folder, candidate.cwd)
      )
      .map((candidate) => candidate.id);
    if (!sharing.length) return;
    const shellJobs = await countOwnShellJobs(sharing);
    if (shellJobs > 0) throw worktreeRefusal('folder-shell-jobs', { shellJobs });
  }

  /**
   * The shared admission of every merge and folder cleanup (manageProjectBranch):
   * refuses while a session or worker runs in an affected folder, or a
   * background command does; `removing` refuses while any session still uses
   * one. Then holds the folders — Mixdog checkouts only; an external checkout
   * takes no lease from this profile — so new Mixdog work there waits until `run`
   * settles. `actor`: the session acting on its own checkout, whose own turn
   * and workers its caller already checked (assertLeadIdle).
   */
  async function withManagementFolders(folders, removing, run, { actor = null } = {}) {
    const release = [];
    try {
      for (const folder of [...new Set(folders)].sort()) {
        release.push(holdProjectFolder(actor, folder, { hold: !isExternalCheckout(folder) }));
      }
      release.push(holdWorkspaceActivity(folders, { sessionId: actor }));
      const stored = await listWorkspaceConsumers();
      const consumers = new Map(stored.map((session) => [session.id, session]));
      for (const session of listLiveSessions()) if (session?.closed !== true) consumers.set(session.id, session);
      const affected = [...consumers.values()].filter((session) =>
        folders.some((folder) => session.cwd && isWithin(folder, session.cwd))
      );
      const blocking = removing
        ? affected
        : affected.filter(
            (session) =>
              !(actor && [session.id, session.ownerSessionId, session.parentSessionId].includes(actor)) &&
              isSessionActive(session)
          );
      if (blocking.length) throw worktreeRefusal('folder-in-use', { sessions: blocking.map((session) => session.id) });
      const jobs = await listWorkspaceJobs();
      if (jobs.some((job) => !job.terminal && folders.some((folder) => isWithin(folder, job.cwd)))) {
        throw worktreeRefusal('folder-shell-jobs');
      }
      if ((await countOwnShellJobs(affected.map((session) => session.id))) > 0) {
        throw worktreeRefusal('folder-shell-jobs');
      }
      return await run([...consumers.keys()]);
    } finally {
      releaseAll(release);
    }
  }

  return { workersOf, assertLeadIdle, withProjectFolder, assertCheckoutQuiet, withManagementFolders };
}
