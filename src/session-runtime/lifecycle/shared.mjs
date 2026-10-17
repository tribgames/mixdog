/**
 * src/session-runtime/lifecycle/shared.mjs - predicates shared by the
 * lifecycle groups (teardown, session switching, inheritance).
 */
import { hasUserConversationMessage } from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';

export { SESSION_ID_PATTERN } from '../../runtime/agent/orchestrator/runtime-core/session-id.mjs';

// Only truly-empty scratch sessions are tombstoned on close; non-empty
// sessions must survive exit resumable. liveTurnMessages holds the in-flight
// user prompt until turn commit — an active first-turn ask has its user
// message there, not yet in session.messages, so it must also be checked or a
// first-turn exit could still burn a real session.
export function isScratchConversation(messages, liveTurnMessages) {
  return [messages, liveTurnMessages].every(
    (items) =>
      !hasUserConversationMessage(items) &&
      !(Array.isArray(items) && items.some((message) => message?.meta?.transcript?.completion))
  );
}

export function isScratchSession(session) {
  return isScratchConversation(session?.messages, session?.liveTurnMessages);
}

export function createSurfaceSessionCloser(mgr) {
  return function closeSurfaceSession(session, reason, options) {
    if (!session?.id) return false;
    return mgr.closeSession(session.id, reason, options);
  };
}
