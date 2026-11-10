// session-approval-wait.mjs
// Process-local transitions of a session turn blocked on the user's tool
// approval: `awaitingUser` is 'approval' when the first wait begins and null
// when the last one settles. Runtime liveness emits them; stores that persist
// the state for other processes (the agent worker index) listen. `turnAt` is
// the waiting turn's start (ms), so a persisted transition can be fenced to it.
const listeners = new Set();
const waiting = new Map(); // sessionId -> { turnAt } of every wait still open

export function onSessionApprovalWaitChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The waits open right now, for a listener that attaches after they began. */
export function currentSessionApprovalWaits() {
  return [...waiting].map(([sessionId, meta]) => ({ sessionId, ...meta }));
}

export function emitSessionApprovalWaitChange(sessionId, awaitingUser, { turnAt = 0 } = {}) {
  const meta = { turnAt: Number(turnAt) || 0 };
  if (awaitingUser) waiting.set(sessionId, meta);
  else waiting.delete(sessionId);
  for (const listener of [...listeners]) {
    try {
      listener(sessionId, awaitingUser, meta);
    } catch (error) {
      // A persistence failure never affects the approval itself.
      process.stderr.write(
        `[approval-wait] persisting session=${sessionId} awaitingUser=${awaitingUser || 'none'} failed: ${error?.message || error}\n`
      );
    }
  }
}
