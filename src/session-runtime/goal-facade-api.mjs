import { markPendingGoalReminder } from './goal-reminder.mjs';

export function createGoalFacadeApi({ agentStatusState, createCurrentSession, getSession, getSessionId, goalRuntime }) {
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
  return {
    goalStatus() {
      const sessionId = getSessionId();
      return sessionId ? goalRuntime.snapshot(sessionId) : null;
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
    goalContinuation() {
      const sessionId = getSessionId();
      if (!sessionId) return { run: false, reason: 'missing-session', goal: null };
      return goalRuntime.continuation(sessionId, { agentStatus: agentStatusState() });
    },
    goalTurnStarted() {
      const sessionId = getSessionId();
      return sessionId ? goalRuntime.startTurn(sessionId) : null;
    },
    goalTurnSettled(detail = {}) {
      const sessionId = getSessionId();
      return sessionId ? goalRuntime.settleTurn(sessionId, detail) : null;
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
