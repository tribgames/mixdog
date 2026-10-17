/**
 * The steps of one Lead workspace transaction (transitions.mjs runs them
 * serialized): commit a new workspace, enter the retained or a new worktree,
 * move to a branch's checkout (the project folder, a linked checkout or a
 * managed worktree made for it), remove the retained worktree. Every save is
 * awaited (persistSession resolves once durable, rejects on failure). Every step
 * pushes the exact undo of what it changed onto the transaction `journal`;
 * the caller runs it (undoAll) when the transaction fails.
 */
import { existsSync, mkdirSync } from 'node:fs';
import {
  isWorktreeBound,
  isWorktreeError,
  nextRevision,
  normalizeSessionWorkspace,
  worktreeError,
} from '../../runtime/shared/worktrees/contract.mjs';
import { throwIfAborted } from '../../runtime/shared/worktrees/git.mjs';
import { checkoutFolder, projectSubdirOf, samePath } from '../../runtime/shared/worktrees/paths.mjs';
import { retainAdmittedTurnWorkspace, setWorkspaceCwdLock, workspaceCwdLock } from './admission-gate.mjs';
import { copyProjectIdentity } from './workspace-state.mjs';

// workspaceReroot: the staged working-folder change and its pending notice
// (prompt-utils stageWorkspaceReroot); a rollback drops the notice with it.
const PROMPT_FIELDS = ['bp3EnvironmentContext', 'bp3CoreContext', 'sessionStartMetaInjected', 'workspaceReroot'];

/** Everything a prompt refresh rewrites on `target`, restorable exactly. */
function snapshotPrompt(target) {
  const fields = PROMPT_FIELDS.map((name) => [name, Object.hasOwn(target, name), target[name]]);
  const messages = Array.isArray(target.messages) ? [...target.messages] : null;
  return () => {
    for (const [name, had, value] of fields) {
      if (had) target[name] = value;
      else delete target[name];
    }
    if (!messages) return;
    if (Array.isArray(target.messages)) target.messages.splice(0, target.messages.length, ...messages);
    else target.messages = messages;
  };
}

/** Run a failed transaction's undo steps newest first; every step runs. */
export async function undoAll(journal, error) {
  const failures = [];
  for (const undo of journal.reverse()) {
    try {
      await undo();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length && error && typeof error === 'object') error.rollbackErrors = failures;
}

/**
 * WORKTREE_PROJECT_MISMATCH unless the retained `entry` was created for the
 * same repository and the same Project folder inside it (a Project switch may
 * have left it behind).
 */
export function assertRetainedFits(entry, project, projectPath) {
  const subdir = projectSubdirOf(project.topLevel, project.projectPath || projectPath);
  if (samePath(entry.repoCommonDir, project.repoCommonDir) && (entry.projectSubdir || '') === subdir) return;
  throw worktreeError('WORKTREE_PROJECT_MISMATCH', undefined, {
    worktreeId: entry.id,
    worktreeProject: entry.projectPath,
    projectPath,
  });
}

/**
 * WORKTREE_REMOVAL_INCOMPLETE: the deletion started (the record stays
 * `deleting`) but something in the folder is still held. The session keeps
 * the project folder — never a cwd that may already be deleted — and
 * removeWorktree again resumes the deletion.
 */
function incompleteRemoval(journal, entry, result, outcome) {
  journal.length = 0;
  return worktreeError('WORKTREE_REMOVAL_INCOMPLETE', undefined, {
    entryId: entry.id,
    path: entry.path,
    retryable: outcome?.retryable !== false,
    remaining: Array.isArray(outcome?.remaining) ? outcome.remaining : [],
    ...(outcome?.reason ? { reason: outcome.reason } : {}),
    revision: result.revision,
  });
}

/**
 * @param {object} deps The host hooks of createWorkspaceTransitions plus its
 *   `backend()` loader, `workersOf(session)` and `withProjectFolder`.
 */
export function createTransitionSteps({
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
  assertCheckoutQuiet = async () => {},
}) {
  const owner = (sessionId) => ({ sessionId, runtimeToken, pid: process.pid });
  const moveLeadRow = (sessionId, cwd) => {
    try {
      updateLeadWorkerCwd(sessionId, cwd);
    } catch {
      /* the Lead pool must never break a transition */
    }
  };

  /** Point this Lead's idle workers at the new root so a reused worker never keeps an old workspace. */
  async function retargetWorkers(session, cwd, journal, move = null) {
    for (const worker of workersOf(session)) {
      if (samePath(worker.cwd || '', cwd)) continue;
      const priorCwd = worker.cwd;
      const restorePrompt = snapshotPrompt(worker);
      journal.push(async () => {
        worker.cwd = priorCwd;
        restorePrompt();
        worker.updatedAt = Date.now();
        await persistSession(worker);
      });
      worker.cwd = cwd;
      await refreshWorkspaceContext(worker, cwd, move);
      worker.updatedAt = Date.now();
      await persistSession(worker);
    }
  }

  /**
   * Apply the new workspace: runtime cwd, record, worker lock, prompt context
   * of the Lead and its idle workers, persistence. Journals the exact undo
   * (cwd, record, lock, prompts, worker roots) for a transaction that fails
   * after this point. `move` ({ from, changes }: a move out of the project
   * folder into a worktree) extends the prompt's working-folder notice.
   */
  async function commit(session, previous, fields, journal, move = null) {
    const next = normalizeSessionWorkspace({
      ...fields,
      revision: nextRevision(previous),
      transition: { state: 'idle', txId: null },
    });
    const prior = {
      cwd: getCurrentCwd(),
      sessionCwd: session.cwd,
      workspace: session.workspace,
      lock: workspaceCwdLock([session.id]),
      prompt: snapshotPrompt(session),
    };
    // The in-memory state goes back first; the save of it is awaited last, so
    // a failing rollback save still leaves this process on the old workspace.
    journal.push(async () => {
      applyResolvedCwd(prior.cwd);
      session.cwd = prior.sessionCwd;
      session.workspace = prior.workspace;
      setWorkspaceCwdLock(session.id, prior.lock);
      prior.prompt();
      session.updatedAt = Date.now();
      moveLeadRow(session.id, prior.sessionCwd || prior.cwd);
      invalidateCaches();
      await persistSession(session);
    });
    retainAdmittedTurnWorkspace(session.id, next.cwd);
    applyResolvedCwd(next.cwd);
    session.cwd = next.cwd;
    session.workspace = next;
    moveLeadRow(session.id, next.cwd);
    setWorkspaceCwdLock(session.id, isWorktreeBound(next) ? next.cwd : null);
    await refreshWorkspaceContext(session, next.cwd, move);
    await retargetWorkers(session, next.cwd, journal, move);
    session.updatedAt = Date.now();
    // Awaited: a failed save fails the transaction (and its journal undoes it).
    await persistSession(session);
    invalidateCaches();
    return { revision: next.revision, workspace: next };
  }

  /**
   * A Project switch (session set-project, the desktop/remote setCwd): the
   * runtime cwd, session.cwd, workspace record and desktop classification
   * move together (applyResolvedCwd with persistProjectSelection), then the
   * prompt context of the Lead and its idle workers follows, awaited, before
   * the switch completes. Journals the exact undo, so a failed refresh puts
   * everything back and the failure reaches the caller.
   */
  async function switchProject(session, cwd, journal, { classifyByMembership = false } = {}) {
    const sessionFields = ['cwd', 'workspace', 'desktopSession'].map((name) => [
      name,
      Object.hasOwn(session, name),
      session[name],
    ]);
    const prior = {
      cwd: getCurrentCwd(),
      desktop: getDesktopSession(),
      lock: workspaceCwdLock([session.id]),
      prompt: snapshotPrompt(session),
    };
    journal.push(async () => {
      applyResolvedCwd(prior.cwd);
      for (const [name, had, value] of sessionFields) {
        if (had) session[name] = value;
        else delete session[name];
      }
      setDesktopSession(prior.desktop);
      setWorkspaceCwdLock(session.id, prior.lock);
      prior.prompt();
      session.updatedAt = Date.now();
      moveLeadRow(session.id, session.cwd || prior.cwd);
      invalidateCaches();
      await persistSession(session);
    });
    const changed = !samePath(prior.cwd || '', cwd);
    if (changed) retainAdmittedTurnWorkspace(session.id, cwd);
    applyResolvedCwd(cwd, { persistProjectSelection: true, classifyByMembership });
    if (changed) {
      moveLeadRow(session.id, cwd);
      await refreshWorkspaceContext(session, cwd);
      await retargetWorkers(session, cwd, journal);
      session.updatedAt = Date.now();
      // Awaited: a failed save fails the switch (and its journal undoes it).
      await persistSession(session);
    }
    invalidateCaches();
    return { cwd: getCurrentCwd(), workspace: session.workspace ?? null };
  }

  async function releaseOwner(backendApi, entryId, sessionId, options) {
    try {
      await backendApi.releaseWorktreeOwner(entryId, owner(sessionId), options);
    } catch (error) {
      // A worktree that vanished has no owner left to release.
      if (!isWorktreeError(error, 'WORKTREE_MISSING')) throw error;
    }
  }

  /**
   * `changes` (a new worktree only): the project folder's uncommitted
   * changes — `ask` refuses with WORKTREE_DIRTY_CHOICE while there are any,
   * `leave` keeps them there, `carry` moves them into the worktree while the
   * project folder is held (refused while other sessions work in it);
   * omitted, they are not examined (lazy provisioning).
   */
  async function enterWorktree(session, previous, { name, nameHint, confirmLarge, changes, signal, txId, journal }) {
    const backendApi = await backend();
    const projectPath = previous.projectPath;
    const project = await inspectProject(projectPath, { signal });
    let entry = await backendApi.getSessionWorktree(session.id);
    const created = !entry;
    if (entry) {
      if (!existsSync(entry.path)) {
        throw worktreeError('WORKTREE_MISSING', undefined, { worktreeId: entry.id, path: entry.path });
      }
      if (isWorktreeBound(previous) && previous.worktreeId === entry.id) {
        return { revision: previous.revision, workspace: previous };
      }
      assertRetainedFits(entry, project, projectPath);
      await backendApi.claimWorktreeOwner(entry.id, owner(session.id));
      journal.push(() => releaseOwner(backendApi, entry.id, session.id));
    } else {
      // The backend resolves the base branch commit (from the project
      // folder's checked-out branch), sizes and creates the checkout; the
      // txId makes a retried or duplicate send return the same worktree.
      const create = () =>
        backendApi.createManagedWorktree({
          projectPath,
          sessionId: session.id,
          runtimeToken,
          baseBranch: project.currentBranch,
          nameHint: name ?? nameHint ?? '',
          confirmLarge: confirmLarge === true,
          txId,
          signal,
          carryChanges: changes ?? null,
        });
      // A carry clears the project folder: it is held, and every session
      // sharing it must be quiet (no turn, agents or background shells).
      entry =
        changes === 'carry'
          ? await withProjectFolder(session.id, project.topLevel || projectPath, async () => {
              await assertCheckoutQuiet(session, project.topLevel || projectPath);
              return create();
            })
          : await create();
      const recoveryRef = entry.changes?.recoveryRef;
      if (recoveryRef) {
        // Anything that fails before the move is committed and durably saved
        // puts the changes back into the project folder and drops the
        // worktree made for them; a restore that is refused keeps both (and
        // the recovery ref).
        const created = entry;
        journal.push(async () => {
          await backendApi.restoreCarriedChanges({ projectPath, recoveryRef });
          await backendApi.removeManagedWorktree({ entryId: created.id, force: true });
          await backendApi.dropCarryRecoveryRef({ projectPath, recoveryRef });
        });
      }
    }
    // Cancelled after the worktree exists: it stays retained (same txId on
    // retry), the session does not move.
    throwIfAborted(signal);
    // A Project registered below the repository root runs in the same
    // subfolder of the worktree (and returns to its own folder on the way back).
    const cwd = checkoutFolder(entry.path, projectSubdirOf(project.topLevel, project.projectPath || projectPath));
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
    copyProjectIdentity(projectPath, cwd);
    const entered = await commit(
      session,
      previous,
      {
        projectPath,
        repoCommonDir: entry.repoCommonDir || project.repoCommonDir,
        cwd,
        worktreeId: entry.id,
        branch: entry.branch,
        baseCommit: entry.baseCommit,
        mergeTarget: project.currentBranch,
      },
      journal,
      // The tail notice: what happened to the uncommitted changes, and how
      // the project-folder paths of the conversation so far map to the worktree.
      isWorktreeBound(previous) ? null : { from: previous.cwd, changes: entry.changes?.mode ?? null }
    );
    // The move is committed and its save has landed (commit awaits the
    // durable save and throws on failure): the carried changes' recovery ref
    // has done its job (a failure to drop it only leaves a spare ref).
    if (entry.changes?.recoveryRef) {
      await backendApi.dropCarryRecoveryRef({ projectPath, recoveryRef: entry.changes.recoveryRef }).catch(() => {});
    }
    // Creation notes (submodules, include entries missing or already present).
    // `created`: a new checkout, whose first-turn preparation still awaits
    // (`prepared`: what creation did and what the turn still has to run).
    return {
      ...entered,
      ...(created
        ? {
            created: {
              prepared: entry.prepared ?? null,
              root: entry.prepared?.root || project.topLevel || projectPath,
            },
          }
        : {}),
      warnings: Array.isArray(entry.warnings) ? [...entry.warnings] : [],
      ...(entry.changes ? { changes: { mode: entry.changes.mode, count: entry.changes.count } } : {}),
    };
  }

  async function enterProjectBranch(session, previous, { branch, create, signal, journal, txId, confirmLarge }) {
    const backendApi = await backend();
    const projectPath = previous.projectPath;
    const project = await inspectProject(projectPath, { signal });
    const resolved = await backendApi.resolveBranchWorkspace({
      projectPath,
      branch,
      create,
      sessionId: session.id,
      runtimeToken,
      txId,
      confirmLarge,
      signal,
    });
    const entry = resolved.entry;
    if (entry)
      journal.push(() =>
        releaseOwner(backendApi, entry.id, session.id, {
          forgetReference: resolved.referenceAdded === true,
        })
      );
    if (entry) assertRetainedFits(entry, project, projectPath);
    throwIfAborted(signal);
    const cwd = checkoutFolder(resolved.path, projectSubdirOf(project.topLevel, project.projectPath || projectPath));
    if (!existsSync(cwd)) throw worktreeError('WORKTREE_MISSING', 'The selected branch has no project subfolder.');
    if (entry) copyProjectIdentity(projectPath, cwd);
    const result = await commit(
      session,
      previous,
      {
        projectPath,
        repoCommonDir: resolved.repoCommonDir,
        cwd,
        branch,
        worktreeId: entry?.id ?? null,
        baseCommit: entry?.baseCommit ?? null,
        mergeTarget: project.currentBranch,
      },
      journal,
      { from: previous.cwd, changes: 'left' }
    );
    if (previous.worktreeId && previous.worktreeId !== entry?.id) {
      journal.push(() => backendApi.claimWorktreeOwner(previous.worktreeId, owner(session.id)));
      await releaseOwner(backendApi, previous.worktreeId, session.id, { forgetReference: true });
    }
    // A managed worktree made for the branch: its first-turn preparation awaits.
    if (resolved.created === true && entry) {
      return {
        ...result,
        created: { prepared: entry.prepared ?? null, root: entry.prepared?.root || project.topLevel || projectPath },
      };
    }
    return result;
  }

  /**
   * Validate the removal first (a dirty or unmerged worktree without `force`
   * refuses with the session untouched), then return the session to its
   * project folder, release the live lease and remove. A removal that still
   * fails puts the session back exactly (the transaction journal).
   */
  async function removeRetainedWorktree(session, previous, { force, signal, journal }) {
    const backendApi = await backend();
    const entry = previous.worktreeId
      ? await backendApi.findWorktreeContaining(previous.cwd)
      : samePath(previous.cwd, previous.projectPath)
        ? await backendApi.getSessionWorktree(session.id)
        : null;
    if (entry)
      await backendApi.assertWorktreeRemovable({ entryId: entry.id, force: force === true, sessionId: session.id });
    let result = { revision: previous.revision, workspace: previous };
    if (isWorktreeBound(previous)) {
      const project = await inspectProject(previous.projectPath, { signal });
      result = await commit(
        session,
        previous,
        {
          projectPath: previous.projectPath,
          repoCommonDir: project.repoCommonDir,
          cwd: previous.projectPath,
          branch: project.currentBranch,
        },
        journal
      );
      if (entry) {
        await releaseOwner(backendApi, entry.id, session.id);
        journal.push(() => backendApi.claimWorktreeOwner(entry.id, owner(session.id)));
      }
    }
    if (!entry) return { ...result, removed: null };
    let removed;
    try {
      removed = await backendApi.removeManagedWorktree({
        entryId: entry.id,
        force: force === true,
        sessionId: session.id,
      });
    } catch (error) {
      // Refused before anything was deleted: the journal puts the session back.
      // Once the checkout may be (partly) gone, the session stays in the
      // project folder and the removal is reported incomplete.
      const now = await backendApi.getSessionWorktree(session.id).catch(() => entry);
      if (now?.id === entry.id && now.state === 'ready' && existsSync(entry.path)) throw error;
      throw incompleteRemoval(journal, entry, result, { reason: String(error?.message || error) });
    }
    if (removed?.removed !== true) throw incompleteRemoval(journal, entry, result, removed);
    return { ...result, removed };
  }

  return { enterWorktree, enterProjectBranch, removeRetainedWorktree, switchProject };
}
