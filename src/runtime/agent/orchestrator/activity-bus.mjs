/**
 * activity-bus — tiny leaf module so orchestrator-layer code can signal
 * "session is actively doing something" without importing the channels
 * Scheduler instance (which would create a module cycle).
 *
 * channels/index.mjs registers a listener at boot that forwards into
 * scheduler.noteActivity(). ai-wrapped-dispatch (and any other
 * orchestrator-side producers) call notifyActivity() near the point
 * where work is kicked off.
 *
 * Boot race: if notifyActivity() fires before channels boot registers
 * the listener, we buffer the most-recent ping and replay it on
 * setListener. Only one timestamp is buffered — "most recent activity
 * was at T" is all scheduler.mjs needs.
 *
 * All failures are swallowed — an activity ping is never load-bearing.
 */

let _listener = null;
let _pendingPingAt = null;

export function setListener(fn) {
  _listener = typeof fn === 'function' ? fn : null;
  if (_listener && _pendingPingAt != null) {
    const ts = _pendingPingAt;
    _pendingPingAt = null;
    try { _listener(ts); } catch { /* best-effort */ }
  }
}

export function notifyActivity() {
  const ts = Date.now();
  if (_listener) {
    try { _listener(ts); } catch { /* best-effort */ }
    return;
  }
  _pendingPingAt = ts;  // buffer one, most recent wins
}
