/**
 * src/session-runtime/turn/side-question-ops.mjs - /btw side questions on the
 * runtime's current session. They run beside an in-progress turn and touch no
 * session state (see orchestrator/session/side-question.mjs).
 */
import { askSideQuestion, cancelSideQuestion } from '../../runtime/agent/orchestrator/session/side-question.mjs';

export function createSideQuestionOps({ getSession, getReservedSessionId }) {
  const sessionId = () => getSession()?.id || getReservedSessionId?.() || '';
  return {
    /** @returns {Promise<{ text: string }>} */
    askSide: (question) => askSideQuestion(sessionId(), question),
    /** Abort the side question of `targetSessionId` (the session it was
     *  asked in), or of the current session when omitted. */
    cancelSide: (targetSessionId) => {
      cancelSideQuestion(typeof targetSessionId === 'string' && targetSessionId ? targetSessionId : sessionId());
    },
  };
}
