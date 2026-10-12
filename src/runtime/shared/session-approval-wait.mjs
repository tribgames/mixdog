// session-approval-wait.mjs
// Process-local transitions of a session turn blocked on the user's tool
// approval: `awaitingUser` is 'approval' when the first wait begins and null
// when the last one settles. Runtime liveness emits them; stores that persist
// the state for other processes (the agent worker index) listen.
const listeners = new Set();

export function onSessionApprovalWaitChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitSessionApprovalWaitChange(sessionId, awaitingUser) {
  for (const listener of [...listeners]) {
    try {
      listener(sessionId, awaitingUser);
    } catch {
      /* a persistence failure never affects the approval itself */
    }
  }
}
