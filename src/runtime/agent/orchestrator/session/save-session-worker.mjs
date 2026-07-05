/**
 * Worker-thread counterpart to store.mjs saveSessionAsync.
 * Receives { session, opts, reqId } messages, calls _saveSessionSync,
 * and replies { ok, error?, reqId }.
 * Single-threaded message queue serializes all writes — generation
 * race protection is preserved by ordering.
 */
import { parentPort } from 'worker_threads';
import { _saveSessionSync } from './store.mjs';

parentPort.on('message', ({ session, opts, reqId }) => {
    try {
        _saveSessionSync(session, opts);
        parentPort.postMessage({ ok: true, reqId });
    } catch (err) {
        parentPort.postMessage({ ok: false, error: err?.message ?? String(err), reqId });
    }
});
