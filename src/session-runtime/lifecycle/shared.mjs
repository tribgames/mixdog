/**
 * src/session-runtime/lifecycle/shared.mjs - predicates shared by the
 * lifecycle groups (teardown, session switching, inheritance).
 */
import { hasUserConversationMessage } from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Only truly-empty scratch sessions are tombstoned on close; non-empty
// sessions must survive exit resumable. liveTurnMessages holds the in-flight
// user prompt until turn commit — an active first-turn ask has its user
// message there, not yet in session.messages, so it must also be checked or a
// first-turn exit could still burn a real session.
export function isScratchConversation(messages, liveTurnMessages) {
  return !hasUserConversationMessage(messages) && !hasUserConversationMessage(liveTurnMessages);
}

export function isScratchSession(session) {
  return isScratchConversation(session?.messages, session?.liveTurnMessages);
}

export function createSurfaceSessionCloser(mgr) {
  return function closeSurfaceSession(session, reason, options) {
    if (!session?.id) return false;
    // A remote-attached session is only a viewer handle owned by this surface.
    // Closing it through the shared manager bumps the durable generation and
    // invalidates the real owner's in-flight turn. Viewer exits therefore
    // detach locally; only the process that owns the runtime may close it.
    if (session.remoteAttached === true) return true;
    return mgr.closeSession(session.id, reason, options);
  };
}
