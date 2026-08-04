/**
 * Worker-thread counterpart to store.mjs saveSessionAsync.
 * Receives { session, opts, reqId } messages, calls _saveSessionSync,
 * and replies { ok, error?, reqId }.
 * Single-threaded message queue serializes all writes — generation
 * race protection is preserved by ordering.
 */
import { parentPort } from 'worker_threads';

// Route every stray stdout/stderr print through the parent as a `{ __log }`
// message instead of worker stdio. Piped worker stdio (stdout:true) keeps the
// parent's event loop alive for the worker's lifetime once read, and default
// (copied) stdio bypasses the TUI's process.stderr.write guard and prints
// over the terminal frame. postMessage does neither: the parent writes the
// text through its own guarded stderr.
function _forwardWrite(chunk, encoding, callback) {
    try { parentPort.postMessage({ __log: typeof chunk === 'string' ? chunk : String(chunk) }); } catch { /* best-effort */ }
    const cb = typeof encoding === 'function' ? encoding : callback;
    if (typeof cb === 'function') cb();
    return true;
}
try {
    process.stdout.write = _forwardWrite;
    process.stderr.write = _forwardWrite;
} catch { /* best-effort: worker still functions with default stdio */ }

import { _saveSessionSync } from './store.mjs';
import { applySessionSaveFault, _sessionStoreTestMode } from './store/save-fault.mjs';
import { SAVE_OUTCOME_SAVED } from './store/live-state.mjs';

// Per-id base transcripts for the parent's delta handoff (save-worker.mjs
// _buildWirePayload): a delta message carries only header + appended tail and
// is reconstructed against the messages written by this worker's previous
// save for that id. Bounded LRU — an evicted id answers deltaMiss and the
// parent retries with a full snapshot.
const _baseMessages = new Map(); // id → last successfully written messages (disk shape)
const BASE_MESSAGES_MAX = 8;

function _rememberBase(id, messages) {
    _baseMessages.delete(id);
    _baseMessages.set(id, messages);
    while (_baseMessages.size > BASE_MESSAGES_MAX) {
        const oldest = _baseMessages.keys().next().value;
        if (oldest === undefined) break;
        _baseMessages.delete(oldest);
    }
}

parentPort.on('message', (message) => {
    // Authoritative fault state pushed by the parent realm. It arrives before
    // any write that may be affected by it, and `null` clears (the worker's
    // inherited env snapshot must never outlive the parent's config).
    if (message && Object.prototype.hasOwnProperty.call(message, '__fault')) {
        applySessionSaveFault(message.__fault);
        return;
    }
    // TEST-ONLY, STRUCTURALLY GATED: forget the delta base of ONE id so the
    // next delta for it legitimately misses. Nothing else in this realm (or in
    // the parent's baseline) is touched, and the worker keeps running.
    if (message && Object.prototype.hasOwnProperty.call(message, '__evictBase')) {
        if (_sessionStoreTestMode() && message.__evictBase) _baseMessages.delete(message.__evictBase);
        return;
    }
    // TEST-ONLY, STRUCTURALLY GATED inspector: report whether this realm still
    // holds a delta base for one id. Read-only; nothing is mutated.
    if (message && Object.prototype.hasOwnProperty.call(message, '__baseProbe')) {
        if (_sessionStoreTestMode()) {
            parentPort.postMessage({
                __baseProbeResult: { id: message.__baseProbe, hasBase: _baseMessages.has(message.__baseProbe) },
            });
        }
        return;
    }
    const { session, delta, id, opts, reqId } = message || {};
    try {
        let full = session;
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
        const outcome = _saveSessionSync(full, opts);
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
        parentPort.postMessage({
            ok: false,
            error: err?.message ?? String(err),
            errorCode: err?.code ?? null,
            injectedSaveFault: err?.injectedSaveFault === true,
            reqId,
        });
    }
});
