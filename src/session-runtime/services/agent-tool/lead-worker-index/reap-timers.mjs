// One reap timer per settled Lead row: fires at the row's reapAt — never
// before the row has been listed in the Agents pane for its full visibility
// window — and removes the row only when it still carries that same deadline.
import { AGENT_PANE_VISIBLE_MS } from '../../../../runtime/shared/agent-reap-state.mjs';
import { clean } from '../helpers.mjs';

export function createLeadReapTimers({ removeRow }) {
  const reapTimers = new Map();

  function cancel(sessionId) {
    const handle = reapTimers.get(sessionId);
    if (!handle) return false;
    clearTimeout(handle);
    reapTimers.delete(sessionId);
    return true;
  }

  function schedule(row) {
    const sessionId = clean(row?.sessionId);
    const reapAt = clean(row?.reapAt);
    if (!sessionId || !reapAt) return;
    cancel(sessionId);
    // The provider reap window may be shorter than the pane window; deleting
    // the row then would drop a finished Lead the pane still has to show.
    const finishedMs = Date.parse(clean(row.finishedAt)) || Date.parse(clean(row.updatedAt)) || 0;
    const deadline = Math.max(Date.parse(reapAt) || 0, finishedMs + AGENT_PANE_VISIBLE_MS);
    const delay = Math.max(0, deadline - Date.now());
    const handle = setTimeout(() => {
      reapTimers.delete(sessionId);
      removeRow(sessionId, reapAt);
    }, delay);
    handle.unref?.();
    reapTimers.set(sessionId, handle);
  }

  function cancelAll() {
    for (const handle of reapTimers.values()) clearTimeout(handle);
    reapTimers.clear();
  }

  return { cancel, cancelAll, schedule };
}
