import { markPendingGoalReminder } from '../runtime/agent/orchestrator/runtime-core/goal-reminder.mjs';
import { adoptLegacyGoalTasks, todoContextBlock } from '../runtime/agent/orchestrator/runtime-core/todo-list.mjs';
import { SAVE_OUTCOME_SAVED } from '../runtime/agent/orchestrator/session/store/live-state.mjs';

export function createGoalFacadeApi({
  agentStatusState,
  createCurrentSession,
  getSession,
  getSessionId,
  goalRuntime,
  persistSession,
}) {
  const markGoalReminder = (reason = '') => {
    try {
      const pending = markPendingGoalReminder(getSession(), reason);
      // Compaction, an objective change, or a paused-state notice all mean the
      // delivered continuation rules are gone or no longer frame the work, so
      // the next continuation carries them in full again.
      const sessionId = getSessionId();
      if (sessionId) goalRuntime.resetContinuationRules(sessionId);
      return pending;
    } catch {
      return null;
    }
  };
  // A Goal record written before the todo list still carries its tasks: the
  // session's list adopts them, and only once that session is saved does the
  // record let them go. A failed save keeps them on the record, so the next
  // load adopts again (items already listed are skipped, never duplicated).
  const adopting = new Map();
  const adoptLegacyTasks = (sessionId) => {
    if (adopting.has(sessionId)) return adopting.get(sessionId);
    const tasks = goalRuntime.legacyTasks?.(sessionId) || [];
    if (!tasks.length) return null;
    const session = getSession();
    if (session?.id !== sessionId) return null;
    adoptLegacyGoalTasks(session, tasks);
    const adoption = (async () => {
      try {
        // Only an explicit committed write lets the record go: a dropped or
        // stale save resolves too, without the list on disk.
        if ((await persistSession(session)) !== SAVE_OUTCOME_SAVED) return;
        await goalRuntime.clearLegacyTasks(sessionId);
      } catch {
        // Kept on the record; retried on the next load.
      } finally {
        adopting.delete(sessionId);
      }
    })();
    adopting.set(sessionId, adoption);
    return adoption;
  };
  return {
    goalStatus() {
      const sessionId = getSessionId();
      if (!sessionId) return null;
      adoptLegacyTasks(sessionId);
      return goalRuntime.snapshot(sessionId);
    },
    async goalControl(args = {}) {
      let sessionId = getSessionId();
      if (!sessionId) {
        await createCurrentSession('goal');
        sessionId = getSessionId();
      }
      if (!sessionId) throw new Error('goal: session could not be created');
      const result = await goalRuntime.control(sessionId, args);
      if (result?.action === 'edit') markGoalReminder('objective-updated');
      return result;
    },
    markGoalReminder,
    /** Settles once a legacy Goal record's tasks are adopted and saved (or kept after a failed save). */
    adoptLegacyGoalTasks(sessionId = getSessionId()) {
      return Promise.resolve(sessionId ? adoptLegacyTasks(sessionId) : null);
    },
    goalContinuation() {
      const sessionId = getSessionId();
      if (!sessionId) return { run: false, reason: 'missing-session', goal: null };
      adoptLegacyTasks(sessionId);
      return goalRuntime.continuation(sessionId, {
        agentStatus: agentStatusState(),
        todo: todoContextBlock(getSession(), 'Todo list for this Goal (exact wordings):', { whole: true }),
      });
    },
    goalTurnStarted() {
      const sessionId = getSessionId();
      return sessionId ? goalRuntime.startTurn(sessionId) : null;
    },
    goalTurnSettled(detail = {}) {
      const sessionId = getSessionId();
      return sessionId ? goalRuntime.settleTurn(sessionId, detail) : null;
    },
    reactivateUsageLimitedGoal(goalId, options) {
      const sessionId = getSessionId();
      return sessionId ? goalRuntime.reactivateUsageLimited(sessionId, goalId, options) : null;
    },
    archiveCompletedGoalOnUserInput() {
      const sessionId = getSessionId();
      return sessionId ? goalRuntime.archiveCompletedOnUserInput(sessionId) : null;
    },
    onGoalStatusChange(listener) {
      return goalRuntime.subscribe(listener);
    },
  };
}
