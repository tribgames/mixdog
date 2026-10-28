/**
 * The Lead session workspace transition authority. Every workspace change of
 * the Lead this runtime hosts — entering its retained worktree (created lazily
 * on the first message of a worktree task), selecting a branch (it runs where
 * that branch is checked out — the project folder, a linked checkout, or a
 * managed worktree made for it — and no existing folder is switched),
 * removing the worktree — goes through applyWorkspaceTransition: one
 * serialized, revisioned commit that retargets the runtime cwd (and the turn's
 * cwd override), stores the durable `workspace` record, re-roots the prompt
 * context of the Lead and its idle workers, and persists, awaiting each save
 * before it reports success. Failures are typed WorktreeErrors and leave the
 * previous workspace intact.
 *
 * Git and registry work is delegated to the managed-worktree backend
 * (runtime/shared/worktrees/manager.mjs), loaded on first use.
 */
import { randomUUID } from 'node:crypto';
import { normalizeWorktreeSettings } from '../../runtime/shared/worktrees/settings.mjs';
import * as maintenance from '../../runtime/shared/worktrees/maintenance.mjs';
import { inspectRepo } from '../../runtime/shared/worktrees/git.mjs';
import { samePath } from '../../runtime/shared/worktrees/paths.mjs';
import {
  clearReadDedupSession,
  resetReadStateAfterCompaction,
} from '../../runtime/agent/orchestrator/session/cache/read-cache.mjs';
import { buildWorkspacePromptContext } from '../../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import { refreshSessionWorkspaceContext } from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { AGENT_OWNER } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { _liveSessions } from '../../runtime/agent/orchestrator/session/store/live-state.mjs';
import { createActivityGuards } from './activity-guards.mjs';
import { createProjectBranchOps } from './project-branches.mjs';
import { createSessionWorkspaceView } from './session-view.mjs';
import { createSideCheckouts } from './side-checkouts.mjs';
import { createTransitionRunner } from './transition-runner.mjs';
import { createTransitionSteps } from './transition-steps.mjs';
import { createWorkspaceMerge } from './workspace-merge.mjs';
import { createWorktreeIntents, creationIntent } from './worktree-intents.mjs';
import { createWorktreeMaintenance } from './worktree-maintenance.mjs';
import { createWorktreeSetup, defaultPlanWorktreeSetup, defaultRunWorktreeSetup } from './worktree-setup.mjs';

const loadDefaultManager = () => import('../../runtime/shared/worktrees/manager.mjs');

/** Running background shell jobs owned by any of `sessionIds` (shell-jobs.mjs ownership). */
async function defaultOwnShellJobCount(sessionIds) {
  const { otherSessionBackgroundShellJobCount } = await import(
    '../../runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs'
  );
  return otherSessionBackgroundShellJobCount(new Set()) - otherSessionBackgroundShellJobCount(new Set(sessionIds));
}

/** The registered Project (projects.json) at `path`, or null. */
async function defaultRegisteredProject(path) {
  const { listProjectsStrict } = await import('../../runtime/shared/projects.mjs');
  return listProjectsStrict().find((entry) => samePath(entry.path, path))?.path ?? null;
}

/**
 * Re-root one session's prompt at `cwd`: environment facts and instruction
 * files for every session, project memory for the Lead only (workers never
 * carried it). A session with a conversation keeps its system prompt (cache
 * intact) and gets a tail notice instead (refreshSessionWorkspaceContext);
 * `move` ({ from, changes }: the session left the project folder `from` for
 * a worktree) adds the uncommitted-changes and path lines to that notice.
 */
export async function refreshWorkspacePrompt(session, cwd, { loadCoreMemoryContext, move = null } = {}) {
  // A new checkout invalidates observed-file snapshots as well as read/search
  // results. Conversation text remains historical evidence, not a file cache.
  clearReadDedupSession(session?.id);
  resetReadStateAfterCompaction(session?.id);
  const { environmentContext, instructionFilesContext } = buildWorkspacePromptContext(session, cwd);
  const coreMemoryContext =
    session?.owner === AGENT_OWNER || typeof loadCoreMemoryContext !== 'function'
      ? undefined
      : await loadCoreMemoryContext();
  return refreshSessionWorkspaceContext(session, {
    cwd,
    environmentContext,
    coreMemoryContext,
    instructionFilesContext,
    ...(move ? { move } : {}),
  });
}

/**
 * The workspace methods every external caller (the runtime facade: desktop
 * IPC, the daemon's `session.configure` lane, remote views) reaches: exactly
 * the public input, so internal options (`ownTurn`, the calling-turn
 * allowance of the Lead's own tool call) and the git tool's snapshot listing
 * stay with in-process callers of the workspace API itself.
 */
export function publicWorkspaceMethods(api) {
  return {
    selectBranch: (input) => api.selectBranch(input),
    requestWorktree: (input) => api.requestWorktree(input),
    mergeWorkspace: (input) => api.mergeWorkspace(input),
    removeWorktree: (input) => api.removeWorktree(input),
    listWorktrees: () => api.listWorktrees(),
    pruneWorktrees: () => api.pruneWorktrees(),
  };
}

/**
 * @param {object} deps
 * @param {() => any} deps.getSession The Lead session this runtime hosts.
 * @param {() => string} deps.getCurrentCwd
 * @param {(cwd: string, options?: { persistProjectSelection?: boolean }) => unknown} deps.applyResolvedCwd Retargets rt cwd, session.cwd and the cwd override (and, persisting, the Project selection).
 * @param {(desktopSession: any) => unknown} [deps.setDesktopSession] Restores the runtime's desktop metadata on a rollback.
 * @param {(session: any) => Promise<unknown>|unknown} deps.persistSession Durable save: resolves once the session is on disk, rejects (throws) when it is not.
 * @param {(session: any, cwd: string, move?: { from: string, changes: 'carried'|'left'|null }|null) => Promise<unknown>} deps.refreshWorkspaceContext
 * @param {() => number} deps.getActiveTurnCount
 * @param {() => { agentWorkers?: any[], agentJobs?: any[] }} deps.agentStatusState
 * @param {(sessionId: string, cwd: string) => unknown} [deps.updateLeadWorkerCwd] Moves the Lead's pool row (lead-workers.json).
 */
export function createWorkspaceTransitions({
  getSession,
  getReservedSessionId = () => null,
  getCurrentCwd,
  getDesktopSession = () => null,
  setDesktopSession = () => {},
  getConfig = () => null,
  createCurrentSession = null,
  applyResolvedCwd,
  persistSession,
  refreshWorkspaceContext,
  invalidateCaches = () => {},
  getActiveTurnCount,
  agentStatusState,
  updateLeadWorkerCwd = () => {},
  initialIntent = undefined,
  manager = null,
  loadManager = loadDefaultManager,
  countOwnShellJobs = defaultOwnShellJobCount,
  listLiveSessions = () => [..._liveSessions.values()],
  sessionManager = null,
  inspectProject = inspectRepo,
  findRegisteredProject = defaultRegisteredProject,
  listStoredSessionIds = maintenance.storedSessionIds,
  listWorkspaceConsumers = maintenance.storedWorkspaceConsumers,
  listWorkspaceJobs = async () => {
    const { listShellJobRecords } = await import(
      '../../runtime/agent/orchestrator/tools/builtin/lib/shell-job-records.mjs'
    );
    return listShellJobRecords({ strict: true });
  },
  runtimeToken = randomUUID(),
  newTxId = randomUUID,
  planWorktreeSetup = defaultPlanWorktreeSetup,
  runWorktreeSetup = defaultRunWorktreeSetup,
  snapshotRetryMs = 2_000,
  snapshotRetryLimit = 20,
}) {
  const worktreeSettings = () => normalizeWorktreeSettings(getConfig?.()?.worktree);
  const initialPending = creationIntent(initialIntent, worktreeSettings());
  let managerPromise = null;
  const backend = () => {
    if (manager) return Promise.resolve(manager);
    managerPromise ||= loadManager();
    return managerPromise;
  };

  const view = createSessionWorkspaceView({
    getSession,
    getCurrentCwd,
    getDesktopSession,
    createCurrentSession,
    inspectProject,
    backend,
    pendingWorktree: () => intents.pendingWorktree(),
  });
  const { hostedSession, ensureSession, currentWorkspace } = view;
  const guards = createActivityGuards({
    getActiveTurnCount,
    agentStatusState,
    countOwnShellJobs,
    listLiveSessions,
    sessionManager,
    listWorkspaceConsumers,
    listWorkspaceJobs,
  });
  const { assertLeadIdle, withProjectFolder, withManagementFolders } = guards;
  const steps = createTransitionSteps({
    assertCheckoutQuiet: guards.assertCheckoutQuiet,
    backend,
    inspectProject,
    runtimeToken,
    getCurrentCwd,
    getDesktopSession,
    setDesktopSession,
    applyResolvedCwd,
    persistSession,
    refreshWorkspaceContext,
    invalidateCaches,
    updateLeadWorkerCwd,
    workersOf: guards.workersOf,
    withProjectFolder,
  });
  const projectBranches = createProjectBranchOps({
    backend,
    inspectProject,
    findRegisteredProject,
    withProjectFolder,
    withManagementFolders,
  });
  const runner = createTransitionRunner({
    getSession,
    hostedSession,
    currentWorkspace,
    assertLeadIdle,
    steps,
    newTxId,
    applyResolvedCwd,
    getCurrentCwd,
  });
  const setup = createWorktreeSetup({ backend, newTxId, planWorktreeSetup, runWorktreeSetup });
  const intents = createWorktreeIntents({
    initial: initialPending,
    getSession,
    getReservedSessionId,
    ensureSession,
    currentWorkspace,
    backend,
    transition: runner.transition,
    runTransition: runner.runTransition,
    runPendingSetup: setup.runPendingSetup,
    newTxId,
  });
  const checkouts = createSideCheckouts({
    getSession,
    getCurrentCwd,
    hostedSession,
    sessionProject: view.sessionProject,
    backend,
    runtimeToken,
    newTxId,
    snapshotRetryMs,
    snapshotRetryLimit,
  });
  const worktrees = createWorktreeMaintenance({
    getSession,
    listLiveSessions,
    listStoredSessionIds,
    backend,
    withManagementFolders,
    cancelSnapshotCleanups: checkouts.cancelSnapshotCleanups,
    worktreeSettings,
  });
  const merge = createWorkspaceMerge({
    hostedSession,
    currentWorkspace,
    assertLeadIdle,
    inspectProject,
    backend,
    withManagementFolders,
    removeWorktree: runner.removeWorktree,
    worktreeSettings,
    newTxId,
  });

  /** @type {import('../../runtime/shared/worktrees/contract.mjs').ApplyWorkspaceTransition} */
  async function applyWorkspaceTransition(sessionRef, target, options = {}) {
    return runner.runTransition(sessionRef, target, options);
  }

  return {
    applyWorkspaceTransition,
    prepareTurnWorkspace: intents.prepareTurnWorkspace,
    admitTurnWorkspace: checkouts.admitTurnWorkspace,
    /** The durable workspace record of the hosted session (null: project folder, never moved). */
    getWorkspace: () => getSession()?.workspace ?? null,
    /** What the session snapshot publishes (see getLiveWorkspace). */
    getLiveWorkspace: view.getLiveWorkspace,
    getBranchMenu: view.getBranchMenu,
    getProjectBranchMenu: projectBranches.getProjectBranchMenu,
    selectBranch: intents.selectBranch,
    selectProjectBranch: projectBranches.selectProjectBranch,
    mergeProjectBranch: projectBranches.mergeProjectBranch,
    inspectProjectBranch: projectBranches.inspectProjectBranch,
    manageProjectBranch: projectBranches.manageProjectBranch,
    requestWorktree: intents.requestWorktree,
    mergeWorkspace: merge.mergeWorkspace,
    removeWorktree: runner.removeWorktree,
    addBranchWorktree: checkouts.addBranchWorktree,
    createSnapshot: checkouts.createSnapshot,
    removeSnapshot: checkouts.removeSnapshot,
    switchProject: runner.switchProject,
    listWorktrees: worktrees.listWorktrees,
    pruneWorktrees: worktrees.pruneWorktrees,
    removeOrphanWorktree: worktrees.removeOrphanWorktree,
    cleanupDeletedSession: worktrees.cleanupDeletedSession,
    onWorktreeSetup: setup.onWorktreeSetup,
    dispose: checkouts.dispose,
  };
}
