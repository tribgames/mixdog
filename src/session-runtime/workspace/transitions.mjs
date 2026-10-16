/**
 * The Lead session workspace transition authority. Every workspace change of
 * the Lead this runtime hosts — entering its retained worktree (created lazily
 * on the first message of a worktree task), returning to a project-folder
 * branch, removing the worktree — goes through applyWorkspaceTransition: one
 * serialized, revisioned commit that retargets the runtime cwd (and the turn's
 * cwd override), stores the durable `workspace` record, re-roots the prompt
 * context of the Lead and its idle workers, and persists. Failures are typed
 * WorktreeErrors and leave the previous workspace intact.
 *
 * Git and registry work is delegated to the managed-worktree backend
 * (runtime/shared/worktrees/manager.mjs), loaded on first use.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  WORKTREE_CARRY_CHOICES,
  branchMenuEntries,
  isWorktreeBound,
  isWorktreeError,
  normalizeSessionWorkspace,
  worktreeError,
  worktreeNameError,
} from '../../runtime/shared/worktrees/contract.mjs';
import { normalizeWorktreeSettings } from '../../runtime/shared/worktrees/settings.mjs';
import * as maintenance from '../../runtime/shared/worktrees/maintenance.mjs';
import { inspectRepo, throwIfAborted } from '../../runtime/shared/worktrees/git.mjs';
import { isWithin, samePath } from '../../runtime/shared/worktrees/paths.mjs';
import { readGitHead } from '../../runtime/shared/worktrees/git-head.mjs';
import { sessionHasConversationMessages } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { buildWorkspacePromptContext } from '../../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import {
  promptContentText,
  refreshSessionWorkspaceContext,
} from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { AGENT_OWNER } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { _liveSessions } from '../../runtime/agent/orchestrator/session/store/live-state.mjs';
import { admitTurn, beginWorkspaceTransition, holdCheckoutFolder } from './admission-gate.mjs';
import { assertMergeTarget, createProjectBranchOps } from './project-branches.mjs';
import { assertRetainedFits, createTransitionSteps, undoAll } from './transition-steps.mjs';
import { readSessionWorkspace } from './workspace-state.mjs';

const ACTIVE_STAGES = new Set(['connecting', 'requesting', 'streaming', 'tool_running', 'running', 'cancelling']);
const BUSY_WORKER_STATES = new Set([...ACTIVE_STAGES, 'starting', 'spawning', 'queued', 'pending']);
const BUSY_JOB_STATES = new Set(['starting', 'spawning', 'queued', 'pending', 'running']);

const loadDefaultManager = () => import('../../runtime/shared/worktrees/manager.mjs');

/** Running background shell jobs owned by any of `sessionIds` (shell-jobs.mjs ownership). */
async function defaultOwnShellJobCount(sessionIds) {
  const { otherSessionBackgroundShellJobCount } = await import(
    '../../runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs'
  );
  return otherSessionBackgroundShellJobCount(new Set()) - otherSessionBackgroundShellJobCount(new Set(sessionIds));
}

const lower = (value) => String(value || '').toLowerCase();

const WORKTREE_BOUND_SWITCH =
  'The session works in a managed worktree; exit the worktree first (switch to a project-folder branch, or merge or remove the worktree) before moving it to another project.';

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
 * Creation-time intent: `{ mode: 'worktree', name }` asks for a worktree;
 * `{ mode: 'default' }` — an interactive Lead the user starts (TUI launch) —
 * follows the settings `newTaskDefault`; `{ mode: 'branch' }` or no intent
 * runs in the project folder. Desktop tasks carry their choice from the
 * renderer, and agents, schedules, webhooks and resumed sessions pass none,
 * so the default never applies to them.
 */
function creationIntent(worktree, settings) {
  if (worktree?.mode === 'worktree') {
    return { name: worktree.name ?? null, confirmLarge: false, explicit: true, sessionId: null, txId: null };
  }
  return worktree?.mode === 'default' && settings.newTaskDefault === 'worktree'
    ? { name: null, confirmLarge: false, explicit: false, sessionId: null, txId: null }
    : null;
}

function validName(name) {
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

function validRevision(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('expectedRevision must be a non-negative integer.');
  }
  return value;
}

/** WORKTREE_REVISION_CONFLICT when the caller expected another workspace revision. */
function assertRevision(revision, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    throw worktreeError('WORKTREE_REVISION_CONFLICT', undefined, { expectedRevision, revision });
  }
}

/** The in-flight marker state of each transition kind. */
const TRANSITION_STATE = { worktree: 'provisioning', branch: 'switching', 'remove-worktree': 'removing' };

/**
 * @param {object} deps
 * @param {() => any} deps.getSession The Lead session this runtime hosts.
 * @param {() => string} deps.getCurrentCwd
 * @param {(cwd: string, options?: { persistProjectSelection?: boolean }) => unknown} deps.applyResolvedCwd Retargets rt cwd, session.cwd and the cwd override (and, persisting, the Project selection).
 * @param {(desktopSession: any) => unknown} [deps.setDesktopSession] Restores the runtime's desktop metadata on a rollback.
 * @param {(session: any) => unknown} deps.persistSession
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
  runtimeToken = randomUUID(),
  newTxId = randomUUID,
}) {
  const worktreeSettings = () => normalizeWorktreeSettings(getConfig?.()?.worktree);
  let pendingIntent = creationIntent(initialIntent, worktreeSettings());
  let managerPromise = null;
  const backend = () => {
    if (manager) return Promise.resolve(manager);
    managerPromise ||= loadManager();
    return managerPromise;
  };

  function hostedSession(sessionRef) {
    const session = getSession();
    const requested = String(sessionRef?.sessionId || '').trim();
    if (!session?.id || (requested && requested !== session.id)) {
      throw new Error(`workspace: session ${requested || '(none)'} is not hosted by this runtime.`);
    }
    return session;
  }

  async function ensureSession() {
    if (!getSession()?.id && typeof createCurrentSession === 'function') await createCurrentSession('workspace');
    return hostedSession(null);
  }

  function projectPathOf(session) {
    const desktop = getDesktopSession?.() || session?.desktopSession;
    if (desktop?.classification === 'project' && desktop.projectPath) return desktop.projectPath;
    return session?.cwd || getCurrentCwd();
  }

  /** The stored record, or the project-folder workspace (revision 0) of a session that never moved. */
  function currentWorkspace(session) {
    const stored = readSessionWorkspace(session);
    if (stored) return stored;
    const projectPath = projectPathOf(session);
    return normalizeSessionWorkspace({ projectPath, cwd: getCurrentCwd() || projectPath, revision: 0 });
  }

  let liveWorkspace = null;

  /**
   * The workspace the session publishes: a worktree-bound record as stored; a
   * project-folder session (never moved, back from a worktree, or carrying a
   * transition stub) with the folder's checked-out branch / detached commit and
   * repoCommonDir read straight from HEAD — no git process. Null outside a git
   * repository for a session without a record. Identity-stable while equal.
   */
  function getLiveWorkspace() {
    const session = getSession();
    const stored = readSessionWorkspace(session);
    if (isWorktreeBound(stored)) return session.workspace;
    let base;
    try {
      base = stored ?? currentWorkspace(session);
    } catch {
      return session?.workspace ?? null;
    }
    const head = readGitHead(base.cwd);
    if (!head) return session?.workspace ?? null;
    const next = {
      ...base,
      repoCommonDir: head.repoCommonDir,
      branch: head.branch,
      baseCommit: head.branch ? base.baseCommit : head.commit,
    };
    if (!liveWorkspace || !isDeepStrictEqual(liveWorkspace, next)) liveWorkspace = next;
    return liveWorkspace;
  }

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
  function holdProjectFolder(sessionId, folder) {
    const users = listLiveSessions().filter(
      (candidate) =>
        candidate?.id &&
        candidate.id !== sessionId &&
        candidate.closed !== true &&
        candidate.remoteAttached !== true &&
        (!sessionId || (candidate.ownerSessionId !== sessionId && candidate.parentSessionId !== sessionId)) &&
        typeof candidate.cwd === 'string' &&
        isWithin(folder, candidate.cwd) &&
        isSessionActive(candidate)
    );
    if (users.length) {
      throw worktreeError('WORKTREE_BUSY_JOBS', 'Other sessions are working in the project folder.', {
        reason: 'folder-in-use',
        sessions: users.map((candidate) => candidate.id),
      });
    }
    return holdCheckoutFolder(sessionId, folder);
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
    if (shellJobs > 0) {
      throw worktreeError(
        'WORKTREE_BUSY_JOBS',
        'Background shells of other sessions are running in the project folder; carrying the changes needs it quiet.',
        { reason: 'folder-shell-jobs', shellJobs }
      );
    }
  }

  const steps = createTransitionSteps({
    assertCheckoutQuiet,
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
    workersOf,
    withProjectFolder,
  });
  const projectBranches = createProjectBranchOps({
    backend,
    inspectProject,
    findRegisteredProject,
    withProjectFolder,
  });

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

  /** @type {import('../../runtime/shared/worktrees/contract.mjs').ApplyWorkspaceTransition} */
  async function applyWorkspaceTransition(sessionRef, target, options = {}) {
    const session = hostedSession(sessionRef);
    return transition(session, normalizeTarget(target), {
      expectedRevision: validRevision(options.expectedRevision),
      confirmLarge: options.confirmLarge === true,
      signal: options.signal,
    });
  }

  /** The pending worktree intent that applies to `session`'s next turn, if any. */
  function intentFor(session) {
    const intent = pendingIntent;
    if (!intent) return null;
    if (isWorktreeBound(readSessionWorkspace(session))) {
      pendingIntent = null;
      return null;
    }
    if (intent.sessionId) return intent.sessionId === session.id ? intent : null;
    // A creation-time intent belongs to a new task: never to a resumed
    // conversation this runtime opened instead.
    const started =
      sessionHasConversationMessages(session) || sessionHasConversationMessages({ messages: session.liveTurnMessages });
    return started ? null : intent;
  }

  /**
   * Create and enter the worktree `intent` asks for now: its txId is fixed on
   * first use (`submissionId`, else a fresh one) so a retry reuses the same
   * worktree, and the prompt text names an unnamed one. A settled intent is
   * consumed.
   */
  async function provisionIntent(session, intent, submissionId, prompt, options) {
    intent.txId ||= String(submissionId || '').trim() || newTxId();
    const result = await transition(
      session,
      { kind: 'worktree', name: intent.name },
      { txId: intent.txId, nameHint: promptContentText(prompt), confirmLarge: intent.confirmLarge, ...options }
    );
    if (pendingIntent === intent) pendingIntent = null;
    return result;
  }

  /**
   * Turn-start workspace gate, run after the session exists and before the
   * user row, the review snapshot, hooks, the provider and any worker spawn.
   * A session in recovery refuses the turn; a pending worktree intent is
   * provisioned now (txId = the first submission id, reused by retries; an
   * unnamed worktree takes its slug from the first message).
   */
  async function prepareTurnWorkspace({ submissionId = '', prompt = '', signal, confirmLarge = false } = {}) {
    const session = getSession();
    if (!session?.id) return null;
    const stored = readSessionWorkspace(session);
    if (stored?.transition.state === 'recovery') {
      throw worktreeError(
        'WORKTREE_MISSING',
        'The worktree for this session no longer exists; pick a branch or remove the worktree to continue.',
        { worktreeId: stored.worktreeId, path: stored.cwd }
      );
    }
    const intent = intentFor(session);
    if (!intent) return null;
    try {
      return await provisionIntent(session, intent, submissionId, prompt, {
        confirmLarge: intent.confirmLarge || confirmLarge === true,
        signal,
        ownTurn: true,
      });
    } catch (error) {
      // The settings default never blocks a task outside a git repository.
      if (!intent.explicit && isWorktreeError(error, 'WORKTREE_UNSUPPORTED_REPO')) {
        if (pendingIntent === intent) pendingIntent = null;
        return null;
      }
      throw error;
    }
  }

  async function getBranchMenu() {
    const session = getSession();
    const workspace = session?.id
      ? currentWorkspace(session)
      : normalizeSessionWorkspace({ projectPath: projectPathOf(null), cwd: getCurrentCwd(), revision: 0 });
    const menu = await (await backend()).listBranchOccupancy({
      projectPath: workspace.projectPath,
      sessionId: session?.id || null,
    });
    // A session in the project folder (never moved, or back from a worktree)
    // is on whatever that folder has checked out now.
    // Its repository is the project's (a never-moved session has no stored
    // record), and a detached checkout shows branch null with the commit in
    // baseCommit — never mistaken for "not a repository".
    let view = workspace;
    if (!isWorktreeBound(workspace)) {
      const project = await inspectProject(workspace.projectPath);
      const checkedOut = project.currentBranch ?? null;
      view = {
        ...workspace,
        repoCommonDir: project.repoCommonDir ?? workspace.repoCommonDir,
        branch: checkedOut,
        baseCommit: checkedOut ? workspace.baseCommit : (project.headCommit ?? null),
      };
    }
    return {
      workspace: view,
      pendingWorktree: pendingIntent ? { name: pendingIntent.name } : null,
      branches: branchMenuEntries(menu.branches, menu.occupancy),
      occupancy: menu.occupancy,
      retainedWorktree: menu.retainedWorktree ?? null,
      // Creation notes of the retained worktree (submodules, include entries).
      warnings: Array.isArray(menu.retainedWorktree?.warnings) ? [...menu.retainedWorktree.warnings] : [],
    };
  }

  /** The maintenance scope here: every live session of this process counts as a live owner. */
  async function maintenanceScope() {
    const liveSessionIds = [
      ...new Set([getSession()?.id, ...listLiveSessions().map((candidate) => candidate?.id)].filter(Boolean)),
    ];
    return { liveSessionIds, listSessionIds: listStoredSessionIds, manager: await backend() };
  }

  /** Every managed worktree with who retains it (the manual list). */
  async function listWorktrees() {
    return maintenance.listWorktreesWithRetention(await maintenanceScope());
  }

  /** The manual prune: clean, merged worktrees no stored or live session retains. */
  async function pruneWorktrees() {
    return maintenance.pruneWorktrees(await maintenanceScope());
  }

  /** After `sessionId` was deleted: autoCleanup removes its clean, merged worktree. */
  async function cleanupDeletedSession(sessionId) {
    return maintenance.cleanupDeletedSessionWorktree(sessionId, {
      manager: await backend(),
      autoCleanup: worktreeSettings().autoCleanup,
    });
  }

  /** Turn admission (see admission-gate admitTurn); resolves the release. */
  function admitTurnWorkspace({ signal } = {}) {
    return admitTurn({ sessionId: getSession()?.id || '', cwd: () => getCurrentCwd() || '', signal });
  }

  async function selectBranch({ branch, create = false, expectedRevision, confirmLarge = false } = {}) {
    const session = await ensureSession();
    const retained = await (await backend()).getSessionWorktree(session.id);
    const target =
      retained && retained.branch === branch && create !== true
        ? { kind: 'worktree' }
        : { kind: 'branch', branch, create: create === true };
    const result = await applyWorkspaceTransition({ sessionId: session.id }, target, {
      expectedRevision,
      confirmLarge,
    });
    pendingIntent = null;
    return result;
  }

  /**
   * "워크트리": re-enter the retained worktree now, or arm the lazy creation
   * for the next message (confirmLarge acknowledges WORKTREE_LARGE_REPO_CONFIRM).
   *
   * `provision` (a New Task's first send, before its prompt is submitted)
   * creates and enters the worktree right away instead: `prompt` names it
   * like the lazy path would and `txId` (the submission id) makes a resend
   * reuse it. Typed failures (large repository, disk, busy) therefore reach
   * the sender while its draft is still unsent, and the turn that follows
   * finds the session already bound.
   *
   * A provisioning that creates a new worktree decides the project folder's
   * uncommitted changes (tracked and untracked): none → it proceeds; without
   * `carryChanges` it refuses with WORKTREE_DIRTY_CHOICE (`details.count`);
   * `leave` starts the worktree at HEAD and leaves them; `carry` moves them
   * into it (the result's `changes` reports which). Re-entering a retained
   * worktree never touches them.
   */
  async function requestWorktree({
    name = null,
    confirmLarge = false,
    provision = false,
    carryChanges,
    prompt = '',
    txId = '',
    expectedRevision,
  } = {}) {
    const nameHint = validName(name);
    const expected = validRevision(expectedRevision);
    if (carryChanges !== undefined && carryChanges !== null && !WORKTREE_CARRY_CHOICES.includes(carryChanges)) {
      throw new TypeError(`carryChanges must be one of ${WORKTREE_CARRY_CHOICES.join(', ')}.`);
    }
    const session = provision === true ? await ensureSession() : getSession();
    // No session yet: the menu it was read from had revision 0.
    const current = session?.id ? currentWorkspace(session) : null;
    assertRevision(current?.revision ?? 0, expected);
    if (current) {
      if (isWorktreeBound(current)) return { revision: current.revision, workspace: current, pending: false };
      if (await (await backend()).getSessionWorktree(session.id)) {
        const entered = await applyWorkspaceTransition(
          { sessionId: session.id },
          { kind: 'worktree' },
          { expectedRevision: expected }
        );
        return { ...entered, pending: false };
      }
    }
    const priorIntent = pendingIntent;
    pendingIntent = {
      name: nameHint ?? pendingIntent?.name ?? null,
      confirmLarge: confirmLarge === true || pendingIntent?.confirmLarge === true,
      explicit: true,
      sessionId: session?.id || getReservedSessionId?.() || null,
      txId: pendingIntent?.txId ?? null,
    };
    if (provision === true) {
      const intent = pendingIntent;
      try {
        return {
          ...(await provisionIntent(session, intent, txId, prompt, {
            expectedRevision: expected,
            changes: carryChanges ?? 'ask',
          })),
          pending: false,
        };
      } catch (error) {
        // A refused move (uncommitted changes to decide, busy, …) is never
        // re-armed for the next turn, where nobody could answer it.
        if (pendingIntent === intent) pendingIntent = priorIntent;
        throw error;
      }
    }
    const workspace = session?.id ? currentWorkspace(session) : null;
    return { revision: workspace?.revision ?? 0, workspace, pending: true };
  }

  /**
   * Merge the retained worktree into the project folder's checked-out branch.
   * `ownTurn` (internal: the Lead's own tool call) tolerates the calling turn.
   */
  async function mergeWorkspace(
    { confirmed = false, target = null, cleanup = false, expectedRevision } = {},
    { ownTurn = false } = {}
  ) {
    if (confirmed !== true) {
      throw worktreeError('WORKTREE_CONFIRM_REQUIRED', 'mergeWorkspace requires confirmed: true.');
    }
    const expected = validRevision(expectedRevision);
    const session = hostedSession(null);
    const merged = await mergeRetainedWorktree(session, { target, ownTurn, expectedRevision: expected });
    if (cleanup !== true || merged.merged !== true) return merged;
    // "Merge and clean up": with autoCleanup on, the merged worktree goes now
    // (a dirty one stays, reported); off, nothing is removed automatically.
    // The merge is committed: a failed or refused cleanup (dirty, retained
    // file recovery data, ...) is a cleanup notice, never a merge failure.
    if (worktreeSettings().autoCleanup !== true) {
      return {
        ...merged,
        cleanup: { removed: false, reason: 'auto-cleanup-off', message: 'Auto cleanup is off; the worktree is kept.' },
      };
    }
    try {
      const removed = await removeWorktree({ force: false }, { ownTurn });
      return { ...merged, cleanup: removed.removed, revision: removed.revision, workspace: removed.workspace };
    } catch (error) {
      // The merge stands: a refused or incomplete cleanup (dirty, unmerged,
      // retained file recovery data, partly removed, …) is reported, never
      // thrown, with the workspace as it is now (an incomplete removal already
      // returned to the project folder).
      const workspace = currentWorkspace(session);
      const code = typeof error?.code === 'string' ? error.code : '';
      return {
        ...merged,
        cleanup: {
          removed: false,
          reason: code || 'WORKTREE_CLEANUP_FAILED',
          ...(code ? { code } : {}),
          message: String(error?.message || error),
        },
        revision: workspace.revision,
        workspace,
      };
    }
  }

  /**
   * The merge itself. The retained worktree must belong to this session's
   * Project (same repository and Project folder — a Project switch may have
   * left it behind): its recorded project folder is the destination that is
   * guarded, compared with the confirmed target and merged into.
   */
  async function mergeRetainedWorktree(session, { target, ownTurn, expectedRevision }) {
    const workspace = currentWorkspace(session);
    assertRevision(workspace.revision, expectedRevision);
    const leave = beginWorkspaceTransition(session.id, `merge:${newTxId()}`);
    try {
      await assertLeadIdle(session, { ownTurn: ownTurn === true });
      const backendApi = await backend();
      const entry = await backendApi.getSessionWorktree(session.id);
      if (!entry) throw worktreeError('WORKTREE_MISSING', 'This session has no worktree to merge.');
      const project = await inspectProject(workspace.projectPath);
      assertRetainedFits(entry, project, workspace.projectPath);
      if (!samePath(entry.projectPath, workspace.projectPath)) {
        throw worktreeError('WORKTREE_PROJECT_MISMATCH', undefined, {
          worktreeId: entry.id,
          worktreeProject: entry.projectPath,
          projectPath: workspace.projectPath,
        });
      }
      assertMergeTarget(project.currentBranch, target);
      return await withProjectFolder(session.id, project.topLevel || workspace.projectPath, () =>
        backendApi.mergeWorktreeIntoProject({
          entryId: entry.id,
          target: project.currentBranch,
          confirmed: true,
          projectPath: entry.projectPath,
        })
      );
    } finally {
      leave();
    }
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

  async function removeWorktree({ force = false, expectedRevision } = {}, { ownTurn = false } = {}) {
    const expected = validRevision(expectedRevision);
    const session = hostedSession(null);
    return transition(
      session,
      { kind: 'remove-worktree', force: force === true },
      { ownTurn: ownTurn === true, expectedRevision: expected }
    );
  }

  return {
    applyWorkspaceTransition,
    prepareTurnWorkspace,
    admitTurnWorkspace,
    /** The durable workspace record of the hosted session (null: project folder, never moved). */
    getWorkspace: () => getSession()?.workspace ?? null,
    /** What the session snapshot publishes (see getLiveWorkspace). */
    getLiveWorkspace,
    getBranchMenu,
    getProjectBranchMenu: projectBranches.getProjectBranchMenu,
    selectBranch,
    selectProjectBranch: projectBranches.selectProjectBranch,
    mergeProjectBranch: projectBranches.mergeProjectBranch,
    requestWorktree,
    mergeWorkspace,
    removeWorktree,
    switchProject,
    listWorktrees,
    pruneWorktrees,
    cleanupDeletedSession,
  };
}
