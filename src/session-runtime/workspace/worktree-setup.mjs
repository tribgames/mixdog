/**
 * The one-time preparation of a session's new worktree at the first turn it
 * runs there (frozen dependency installs), with its progress for viewers and
 * the compact note the agent gets with that turn.
 */
import { isWorktreeBound } from '../../runtime/shared/worktrees/contract.mjs';
import { throwIfAborted } from '../../runtime/shared/worktrees/git.mjs';
import { worktreePreparationNote } from '../../runtime/shared/worktrees/preparation-report.mjs';
import { readSessionWorkspace } from './workspace-state.mjs';

/** The dependency installs a new worktree folder still needs (dependencies.mjs). */
export async function defaultPlanWorktreeSetup(input) {
  const { planDependencySetup } = await import('../../runtime/shared/worktrees/dependencies.mjs');
  return planDependencySetup(input);
}

export async function defaultRunWorktreeSetup(input) {
  const { runWorktreeSetupCommands } = await import('../../runtime/shared/worktrees/setup-commands.mjs');
  return runWorktreeSetupCommands(input);
}

/** @param {object} deps The `backend()` loader, `newTxId` and the setup planner and runner. */
export function createWorktreeSetup({ backend, newTxId, planWorktreeSetup, runWorktreeSetup }) {
  const setupListeners = new Set();

  /**
   * Prepare the session's new worktree, once, under the turn (its admission
   * keeps the folder from being merged or removed; its signal — the Stop
   * button — cancels): the frozen installs the links made at creation did
   * not cover. While an install runs, every onWorktreeSetup listener gets its
   * one-line progress; nothing else reaches the user. The agent gets one
   * compact note with this turn (`session.pendingSetupNotice`): the main
   * checkout, what was copied, linked and installed, what failed (with the
   * output tail) and what was skipped. A failure or timeout is in the note
   * and the turn goes on; a cancel aborts the turn like any other stop. The
   * worktree stays either way. The setup belongs to the worktree it was made
   * for, whichever path made it (a worktree task, a branch selection, `git
   * worktree add`): its registry entry keeps it pending (manager
   * claimWorktreeSetup) until the first turn a session runs there, never in
   * another folder.
   */
  async function runPendingSetup(session, signal) {
    const here = readSessionWorkspace(session);
    if (!isWorktreeBound(here)) return;
    const claimed = await (await backend()).claimWorktreeSetup(here.worktreeId);
    if (!claimed) return;
    const id = newTxId();
    const report = {
      root: claimed.prepared?.root || here.projectPath,
      prepared: claimed.prepared,
      dependencyNotes: [],
      installs: null,
      notes: [],
    };
    const emit = (event) => {
      for (const listener of setupListeners) {
        try {
          listener({ ...event, id, sessionId: session.id, cwd: here.cwd });
        } catch {
          /* a viewer's failure never stops the setup */
        }
      }
    };
    try {
      const plan = await planWorktreeSetup({ worktreeDir: here.cwd, mainDir: here.projectPath, signal });
      report.dependencyNotes = plan.notes;
      if (plan.commands.length) {
        report.installs = await runWorktreeSetup({ commands: plan.commands, signal, onProgress: emit });
      }
    } catch (error) {
      if (!signal?.aborted) report.notes.push(`Dependencies could not be prepared: ${error?.message || error}`);
    }
    session.pendingSetupNotice = { revision: Date.now(), content: worktreePreparationNote(report) };
    throwIfAborted(signal);
  }

  /** Subscribe to worktree setup progress; returns the unsubscribe. */
  function onWorktreeSetup(listener) {
    if (typeof listener !== 'function') return () => {};
    setupListeners.add(listener);
    return () => setupListeners.delete(listener);
  }

  return { runPendingSetup, onWorktreeSetup };
}
