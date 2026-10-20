/**
 * src/session-runtime/lifecycle/shared.mjs - predicates shared by the
 * lifecycle groups (teardown, session switching, inheritance).
 */
import { hasUserConversationMessage } from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { isAgentHomeSessionId } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { isRoomThreadSessionId } from '../../runtime/agent/orchestrator/session/agent-room.mjs';

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

/** An agent's home thread is never scratch: a blank one is tombstoned on no
 *  close, so its fixed id stays open for the next visit. Neither is a group
 *  room's log or member session (agent-room.mjs), whose ids are fixed too. */
export function isScratchSession(session) {
  if (isAgentHomeSessionId(session?.id) || isRoomThreadSessionId(session?.id)) return false;
  return isScratchConversation(session?.messages, session?.liveTurnMessages);
}

/** `nonBlocking`: the closer returns the manager's closeSessionAsync promise
 *  (when it has one), whose barrier never sleeps the event loop. */
export function createSurfaceSessionCloser(mgr, nonBlocking = false) {
  return function closeSurfaceSession(session, reason, options) {
    if (!session?.id) return false;
    return closeManagedSession(mgr, session.id, reason, options, nonBlocking);
  };
}

/** Await a switch path's close of the outgoing session. A close whose durable
 *  barrier failed leaves the session open, so the switch must not proceed. */
export async function closeOutgoingSession(closeSurfaceSession, session, reason, options) {
  if ((await closeSurfaceSession(session, reason, options)) === false) {
    throw new Error(`session close failed (reason=${reason}); the current session is kept`);
  }
}

/** The manager's close: closeSessionAsync when asked for and available,
 *  else its closeSession, unchanged. */
export function closeManagedSession(mgr, id, reason, options, nonBlocking = true) {
  if (nonBlocking && typeof mgr.closeSessionAsync === 'function') return mgr.closeSessionAsync(id, reason, options);
  return mgr.closeSession(id, reason, options);
}
