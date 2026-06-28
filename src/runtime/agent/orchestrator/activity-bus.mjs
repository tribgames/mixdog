/**
 * activity-bus — tiny leaf module so orchestrator-layer code can signal
 * "session is actively doing something" without importing the channels
 * Scheduler instance (which would create a module cycle).
 *
 * channels/index.mjs registers a listener at boot that forwards into
 * scheduler.noteActivity(). Producers signal activity via setListener's
 * forwarded pings.
 *
 * Boot race: a ping that fires before channels boot registers the listener
 * is buffered (most-recent wins) and replayed on setListener. Only one
 * timestamp is buffered — "most recent activity was at T" is all
 * scheduler.mjs needs. All failures are swallowed — a ping is never
 * load-bearing.
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
