// What must land in a session's transcript right before its next turn's
// prompt, whoever starts that turn: the daemon registers one prelude
// (agent-home-delivery.mjs postBeforeAgentTurn) and the prompt queue's drain
// (tui/session/session-flow/drain.mjs) awaits it before presenting a batch.

let prelude = null;

/** Register `fn(sessionId)` (null or a promise per turn); a non-function clears it. */
export function setSessionTurnPrelude(fn) {
  prelude = typeof fn === 'function' ? fn : null;
}

/** The prelude's work before a turn of `sessionId`: a promise, or null when
 *  there is none (no await, so a turn with nothing owed starts as before). */
export function sessionTurnPrelude(sessionId) {
  if (!prelude || !sessionId) return null;
  return prelude(String(sessionId)) || null;
}
