import { clean } from './helpers.mjs';
import { isTerminalWorkerStatus } from './worker-rows.mjs';

// A tag with a lingering worker-index / role trace but no live session in
// this terminal (finished worker still inside the reap grace window).
export function createTerminalTrace({ registry }) {
  function terminalWorkerRowForTag(tag, context = {}) {
    const value = clean(tag);
    if (!value) return null;
    return (
      registry.readWorkerRows(context).find((row) => {
        if (clean(row.tag) !== value) return false;
        if (!isTerminalWorkerStatus(row.status || row.stage)) return false;
        if (registry.getLiveSession(clean(row.sessionId))) return false;
        return true;
      }) || null
    );
  }

  function hasTerminalTrace(tag, context = {}) {
    const value = clean(tag);
    if (!value || value.startsWith('sess_')) return false;
    if (registry.resolveTag(value, context, { excludeTerminalTraces: true })) return false; // live -> reuse, not trace
    return Boolean(terminalWorkerRowForTag(value, context));
  }

  function reapTerminalTraceForTag(tag, context = {}) {
    const value = clean(tag);
    if (!value || value.startsWith('sess_')) return false;
    const row = terminalWorkerRowForTag(value, context);
    if (!row) return false;
    registry.refreshTagsFromSessions({ context });
    const sessionId = clean(row.sessionId);
    if (sessionId) registry.cancelReap(sessionId);
    registry.forgetTerminalSession(value, sessionId);
    return true;
  }

  return { hasTerminalTrace, reapTerminalTraceForTag };
}
