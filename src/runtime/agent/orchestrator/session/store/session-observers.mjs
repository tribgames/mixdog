/**
 * External observer registries for the session store: the hard-delete purge
 * hooks and the in-process live-session publication seam. Both are pure
 * registries — they persist nothing and import no write path — so outside
 * code has exactly one place to attach to session events.
 */
import { _setLiveSessionPublisher } from './save-worker.mjs';

// ── Hard-delete purge hooks ─────────────────────────────────────────────────
// Owners of parked snapshots (usage-metrics) register a SYNCHRONOUS cleanup
// here. deleteSession runs them while it still holds the id's commit lock, so
// no timer retry and no exit-drain entry survives the unlink. Layering stays
// intact: the store never imports manager code.
const _sessionPurgeHooks = new Set();
const _liveSessionSubscribers = new Set();

export function registerSessionPurgeHook(hook) {
  if (typeof hook !== 'function') return () => {};
  _sessionPurgeHooks.add(hook);
  return () => _sessionPurgeHooks.delete(hook);
}

/** In-process session publication seam.
 *
 * The runtime worker uses this to project agent sessions through the daemon's
 * ordinary session-state lane. Persistence remains independent: subscribers
 * observe the same immutable session object that was admitted to the live
 * cache, before disk debounce or I/O can delay a visible pane. */
export function subscribeLiveSessions(listener) {
  if (typeof listener !== 'function') return () => {};
  _liveSessionSubscribers.add(listener);
  return () => _liveSessionSubscribers.delete(listener);
}

export function _publishLiveSession(session) {
  for (const listener of [..._liveSessionSubscribers]) {
    try {
      listener(session);
    } catch {
      /* observers never affect persistence */
    }
  }
}

_setLiveSessionPublisher(_publishLiveSession);

export function _runSessionPurgeHooks(id) {
  for (const hook of _sessionPurgeHooks) {
    try {
      hook(id);
    } catch {
      /* a cleanup hook never breaks delete */
    }
  }
}
