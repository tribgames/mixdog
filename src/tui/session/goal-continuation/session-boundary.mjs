/**
 * src/tui/session/goal-continuation/session-boundary.mjs - a session boundary
 * (resume, new session, context switch) changes which Goal is current, so the
 * continuation queued for the previous session is dropped and the current
 * session's Goal is re-read and re-armed once the boundary settles.
 */
const SESSION_BOUNDARY_METHODS = ['resume', 'newSession', 'switchContext'];

export function rearmGoalContinuationOnSessionBoundaries({ api, bag }) {
  for (const method of SESSION_BOUNDARY_METHODS) {
    if (typeof api[method] !== 'function') continue;
    const base = api[method].bind(api);
    api[method] = async (...args) => {
      const result = await base(...args);
      bag.cancelQueuedGoalContinuations?.();
      bag.refreshGoalState?.();
      bag.scheduleGoalContinuation?.();
      return result;
    };
  }
}
