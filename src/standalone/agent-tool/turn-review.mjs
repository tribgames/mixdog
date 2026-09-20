import { beginAgentTurnReview, completeAgentTurnReview } from '../../runtime/shared/turn-snapshot.mjs';
import { clean } from './helpers.mjs';

// Collects the latest uiDiff a worker turn produced and hands it to the
// owner's turn review when the turn completes.
export function createTurnReviewCollector(session, tag, agent, notifyContext = {}) {
  const ownerSessionId = clean(
    notifyContext?.callerSessionId ||
      notifyContext?.sessionId ||
      notifyContext?.routingSessionId ||
      session?.parentSessionId ||
      notifyContext?.ownerSessionId ||
      session?.ownerSessionId
  );
  const handle = beginAgentTurnReview(ownerSessionId, session?.id, { tag, agent });
  let latestPatch = null;
  return {
    onToolResult(message) {
      if (Object.hasOwn(message || {}, 'uiDiff') && typeof message.uiDiff === 'string') {
        latestPatch = message.uiDiff;
      }
    },
    complete() {
      completeAgentTurnReview(handle, latestPatch === null ? [] : [latestPatch]);
    },
  };
}
