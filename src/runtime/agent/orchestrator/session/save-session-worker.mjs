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

parentPort.on('message', ({ session, opts, reqId }) => {
    try {
        const saved = _saveSessionSync(session, opts);
        parentPort.postMessage({ ok: true, saved, reqId });
    } catch (err) {
        parentPort.postMessage({ ok: false, error: err?.message ?? String(err), reqId });
    }
});
