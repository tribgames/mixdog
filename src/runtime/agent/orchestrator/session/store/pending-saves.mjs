/**
 * Pending-write bookkeeping per session id: the coalescing slots every save
 * entry mode shares (`_savePending`), their debounce timers, the payload
 * incarnation references those slots own, and the "is a write still pending?"
 * question the eviction paths must answer before dropping a live snapshot.
 *
 * Owning this registry on its own gives the write pipeline, the lifecycle
 * barriers, the delete path and loadSession ONE source of truth for in-flight
 * persistence without importing one another.
 */
import { _releaseSessionIncarnation } from './live-state.mjs';
import { _saveAsyncQueued, _saveAsyncInflight, _deferredSessionSaves } from './save-worker.mjs';

/** Module-level map tracking in-flight saves per session ID to prevent concurrent write corruption. */
export const _savePending = new Map();

// ── 150 ms debounce window ────────────────────────────────────────────────────
// Multiple tool-result writes within a turn collapse to one tmp+rename per
// session. The timer is unref'd so it never keeps the process alive.
export const _debounceTimers = new Map(); // id → NodeJS.Timeout

export function _clearDebounce(id) {
  const t = _debounceTimers.get(id);
  if (t) {
    clearTimeout(t);
    _debounceTimers.delete(id);
  }
}

/**
 * Release a payload's incarnation reference exactly once. Payloads that are
 * coalesced away (replaced in a pending slot), dropped by a delete or retired
 * by the drain never reach _doSave*, so their reference is freed here.
 */
export function _releasePayloadIncarnation(payload) {
  if (!payload?.incarnation) return;
  _releaseSessionIncarnation(payload.incarnation);
  payload.incarnation = null;
}

/** Drop every payload reference a pending slot still owns. */
export function _releasePendingSlot(pending) {
  if (!pending) return;
  _releasePayloadIncarnation(pending.payload);
  _releasePayloadIncarnation(pending.queued);
}

/** True while any pending/in-flight persistence still references this id. */
export function _hasPendingPersistence(id) {
  if (_savePending.has(id) || _saveAsyncInflight.has(id) || _saveAsyncQueued.has(id)) return true;
  for (const [, pending] of _deferredSessionSaves) {
    if (pending?.session?.id === id) return true;
  }
  return false;
}
