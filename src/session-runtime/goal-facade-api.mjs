import { markPendingGoalReminder } from './goal-reminder.mjs';

export function createGoalFacadeApi({
  agentStatusState,
  createCurrentSession,
  getSession,
  getSessionId,
  goalRuntime,
}) {
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
      if (result?.action === 'edit') {
        try { markPendingGoalReminder(getSession(), 'objective-updated'); } catch {}
      }
      return result;
    },
    markGoalReminder(reason = '') {
      try { return markPendingGoalReminder(getSession(), reason); } catch { return null; }
    },
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
