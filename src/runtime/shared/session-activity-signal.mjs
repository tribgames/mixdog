// session-activity-signal.mjs
// Process-local "a session's activity state may have changed" pulse: a turn
// started or settled, a task wait began or ended, a background task was
// handed off or finished. Status surfaces that project activity from the
// runtime map (the Agents pool) listen and re-read at once instead of waiting
// for their next store event. Import-free leaf.
const listeners = new Set();

export function onSessionActivityChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitSessionActivityChange(sessionId = '') {
  emit(listeners, sessionId);
}

// A live session started or stopped showing an approval card waiting on the
// user (its runtime state's `toolApproval`): the session catalog, which
// stamps that on each row, listens and re-reads.
const approvalCardListeners = new Set();

export function onSessionApprovalCardChange(listener) {
  if (typeof listener !== 'function') return () => {};
  approvalCardListeners.add(listener);
  return () => approvalCardListeners.delete(listener);
}

export function emitSessionApprovalCardChange(sessionId = '') {
  emit(approvalCardListeners, sessionId);
}

function emit(targets, sessionId) {
  for (const listener of [...targets]) {
    try {
      listener(String(sessionId || ''));
    } catch {
      /* a listener's failure never affects the transition */
    }
  }
}
