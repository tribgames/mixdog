// One reap timer per settled Lead row: fires at the row's reapAt and removes
// the row only when it still carries that same deadline.
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
    const delay = Math.max(0, (Date.parse(reapAt) || 0) - Date.now());
    const handle = setTimeout(() => {
      reapTimers.delete(sessionId);
      removeRow(sessionId, reapAt);
    }, delay);
    handle.unref?.();
    reapTimers.set(sessionId, handle);
  }

  return { cancel, schedule };
}
