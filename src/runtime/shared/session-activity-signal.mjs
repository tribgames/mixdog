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
  for (const listener of [...listeners]) {
    try {
      listener(String(sessionId || ''));
    } catch {
      /* a listener's failure never affects the transition */
    }
  }
}
