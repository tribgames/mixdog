// session-calls/turn-gate.mjs
// The service's turn starts per session (a submit's intake, an approval that
// resumes a turn, a materialization for a Goal or quota resume) against the
// desktop's idle-only delete: the delete closes a session to new starts only
// while none is being admitted, and a start refuses while it is closed.
import { SessionClosedError } from '../../../runtime/agent/orchestrator/session/manager/session-errors.mjs';

export function createSessionTurnGate() {
  const starting = new Map(); // sessionId -> admissions in flight
  const fenced = new Set();
  return {
    /** Admit a turn start of `sessionId`; the returned release ends it. */
    enter(sessionId) {
      if (fenced.has(sessionId)) {
        throw new SessionClosedError(sessionId, 'session is being deleted', 'auto-retention-delete');
      }
      starting.set(sessionId, (starting.get(sessionId) || 0) + 1);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        const count = (starting.get(sessionId) || 1) - 1;
        if (count > 0) starting.set(sessionId, count);
        else starting.delete(sessionId);
      };
    },
    /** Close `sessionId` to turn starts; null while one is being admitted. */
    fence(sessionId) {
      if (starting.has(sessionId) || fenced.has(sessionId)) return null;
      fenced.add(sessionId);
      return () => fenced.delete(sessionId);
    },
  };
}
