/**
 * Worker-thread counterpart to store.mjs saveSessionAsync.
 * Receives { session, opts, reqId } messages, calls _saveSessionSync,
 * and replies { ok, error?, reqId }.
 * Single-threaded message queue serializes all writes — generation
 * race protection is preserved by ordering.
 */
// Must stay the first import: it redirects stdout/stderr before store.mjs
// and its imports evaluate (see save-session-worker-stdio.mjs).
import './save-session-worker-stdio.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import { _saveSessionSync } from './store.mjs';
import { applySessionSaveFault, _sessionStoreTestMode } from './store/save-fault.mjs';
import { SAVE_OUTCOME_SAVED } from './store/live-state.mjs';
import { connectOwnCommitPeer } from './store/canonical-reader.mjs';

// Commit stamps are exchanged with the parent realm the moment they are
// recorded, so neither side re-reads a file the other just wrote.
connectOwnCommitPeer(workerData?.ownCommitPort ?? null);

// Per-id base transcripts for the parent's delta handoff (save-worker.mjs
// _buildWirePayload): a delta message carries only header + appended tail and
// is reconstructed against the messages written by this worker's previous
// save for that id. Unbounded by count, mirroring the parent baseline: the
// parent releases an id with `{ __forgetBase }` (runtime teardown, hard
// delete). A missing base answers deltaMiss and the parent retries full.
const _baseMessages = new Map(); // id → last successfully written messages (disk shape)

function _rememberBase(id, messages) {
  _baseMessages.set(id, messages);
}

parentPort.on('message', (message) => {
  // Authoritative fault state pushed by the parent realm. It arrives before
  // any write that may be affected by it, and `null` clears (the worker's
  // inherited env snapshot must never outlive the parent's config).
  if (message && Object.hasOwn(message, '__fault')) {
    applySessionSaveFault(message.__fault);
    return;
  }
  // The parent forgot this id (session went away): release its base.
  if (message && Object.hasOwn(message, '__forgetBase')) {
    if (message.__forgetBase) _baseMessages.delete(message.__forgetBase);
    return;
  }
  // TEST-ONLY, STRUCTURALLY GATED: forget the delta base of ONE id so the
  // next delta for it legitimately misses. Nothing else in this realm (or in
  // the parent's baseline) is touched, and the worker keeps running.
  if (message && Object.hasOwn(message, '__evictBase')) {
    if (_sessionStoreTestMode() && message.__evictBase) _baseMessages.delete(message.__evictBase);
    return;
  }
  // TEST-ONLY, STRUCTURALLY GATED inspector: report whether this realm still
  // holds a delta base for one id. Read-only; nothing is mutated.
  if (message && Object.hasOwn(message, '__baseProbe')) {
    if (_sessionStoreTestMode()) {
      parentPort.postMessage({
        __baseProbeResult: { id: message.__baseProbe, hasBase: _baseMessages.has(message.__baseProbe) },
      });
    }
    return;
  }
  const { session, delta, id, opts, reqId } = message || {};
  let full = session;
  try {
    const sessionId = id ?? session?.id;
    if (!full && delta) {
      const base = _baseMessages.get(sessionId);
      // baseCount pins the exact chain position: the single-worker FIFO
      // guarantees per-id ordering, so a length mismatch can only mean a
      // broken chain (restart/eviction) — never silently reconstruct.
      if (!base || base.length !== delta.baseCount) {
        parentPort.postMessage({ ok: true, saved: false, deltaMiss: true, reqId });
        return;
      }
      full = { ...delta.header, messages: [...base, ...delta.tailMessages] };
    }
    // The parent publishes this write's summary row when the reply lands.
    const outcome = _saveSessionSync(full, opts, { publishSummary: false });
    const saved = outcome === SAVE_OUTCOME_SAVED;
    if (saved) _rememberBase(sessionId, full.messages);
    else _baseMessages.delete(sessionId);
    // `outcome` tells the parent WHY a write did not land: an
    // ownership/cancellation drop and a stale-epoch refusal have opposite
    // consequences for live-state markers.
    parentPort.postMessage({ ok: true, saved, outcome, reqId });
  } catch (err) {
    // Preserve the original failure identity across the thread boundary:
    // the parent rebuilds an Error carrying the same code/injection marker
    // so callers can branch on it exactly as in the sync path.
    const failure = {
      ok: false,
      error: err?.message ?? String(err),
      errorCode: err?.code ?? null,
      injectedSaveFault: err?.injectedSaveFault === true,
      reqId,
    };
    // The exact payload this realm attempted is the parent's failure
    // evidence (the parent keeps no copy of the transcript).
    try {
      parentPort.postMessage(full ? { ...failure, attempted: full } : failure);
    } catch {
      parentPort.postMessage(failure);
    }
  }
});
