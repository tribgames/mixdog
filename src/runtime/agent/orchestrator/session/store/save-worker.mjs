import { Worker } from 'worker_threads';
import { guardedSaveOptions as _guardedSaveOptions } from './write-guards.mjs';
import { _ensureLifecycleFields } from './serialize.mjs';
import { setLiveSession, _droppedSaveIds, clearSessionSaveError } from './live-state.mjs';
import { _cacheSessionSummary, _rollbackCachedSessionSummary, _queueSessionSummaryUpsert } from './summary-cache.mjs';

// ── Worker-thread async save ──────────────────────────────────────────────────
// Single long-lived Worker serializes all saveSessionAsync calls.
// The worker's message queue preserves generation-race ordering.
export let _saveWorker = null;
// In-flight writes, keyed by reqId. Value: { id, session, opts, waiters:[{resolve,reject}] }.
// At most ONE entry per session id at a time (single-in-flight-per-id).
export let _saveWorkerPending = new Map();
// Latest-wins queued payload per session, keyed by id. Value: { session, opts, waiters:[] }.
// At most ONE queued write per id: a newer saveSessionAsync while a write is in
// flight overwrites session/opts here and appends its resolver to waiters, so
// every superseded caller resolves when this single queued write finally lands.
export let _saveAsyncQueued = new Map();
// id → reqId of the in-flight write for that id (enforces one-in-flight-per-id).
export let _saveAsyncInflight = new Map();
export let _saveWorkerReqId = 0;
export let _saveWorkerRefCount = 0;
export let _deferredSaveReqId = 0;
export const _deferredSessionSaves = new Map();

export function _getOrSpawnWorker() {
    if (_saveWorker) return _saveWorker;
    _saveWorker = new Worker(new URL('../save-session-worker.mjs', import.meta.url), {
        execArgv: [],
    });
    // Worker logs arrive as `{ __log }` messages, NOT via piped stdio
    // (stdout:true/stderr:true): once the parent starts reading a worker's
    // piped stdio, the underlying MessagePort stays ref'd for the worker's
    // lifetime regardless of worker.unref(), so every process that ever
    // saved a session could no longer exit (test runners hung after
    // completion). The worker overrides its own process.stdout/stderr.write
    // to forward through this channel, which keeps stray prints off the TUI
    // frame (routed through the parent's guardable stderr) without holding
    // the event loop.
    _saveWorker.on('message', ({ __log, ok, saved, error, reqId }) => {
        if (__log !== undefined) {
            try { process.stderr.write(String(__log)); } catch { /* best-effort */ }
            return;
        }
        const p = _saveWorkerPending.get(reqId);
        if (!p) return;
        _saveWorkerPending.delete(reqId);
        // Drop the ref AFTER pending was registered ref-up'd so the worker
        // becomes unref'd again once all in-flight writes settle. _saveWorker
        // null-check covers the error/exit race where the worker died first.
        if (--_saveWorkerRefCount === 0 && _saveWorker) _saveWorker.unref();
        const { id, session, summaryVersion, waiters } = p;
        _saveAsyncInflight.delete(id);
        // Resolve/reject every caller whose payload this write represents
        // (the originating call plus any that coalesced onto it before it was
        // posted). A supersede never lands here as a rejection — only a real
        // worker failure does.
        if (ok) {
            // A close/delete may have completed while the worker was writing.
            // Do not let this older completion put an open row back in the
            // process-local cache after its tombstone/removal.
            if (saved) {
                _queueSessionSummaryUpsert(session, summaryVersion);
                _droppedSaveIds.delete(id);
            } else {
                // The worker's _shouldDrop declined the write: disk ownership
                // moved past this snapshot — flag the split-brain so eviction
                // and disk-over-live arbitration keep the richer local copy.
                _rollbackCachedSessionSummary(id, summaryVersion);
                _droppedSaveIds.add(id);
            }
            clearSessionSaveError(id);
            for (const w of waiters) w.resolve();
        }
        else {
            const e = new Error(`[session-store] worker save failed: ${error}`);
            for (const w of waiters) w.reject(e);
        }
        // Promote the latest-wins queued payload (if any) into the now-free
        // in-flight slot for this id. Runs regardless of ok: the queued write
        // is a newer, independent payload and must still be attempted so its
        // (possibly superseded) waiters resolve when it lands.
        const q = _saveAsyncQueued.get(id);
        if (q) {
            _saveAsyncQueued.delete(id);
            try {
                _postAsyncWrite(id, q.session, q.opts, q.waiters, q.summaryVersion);
            } catch (err) {
                _rollbackCachedSessionSummary(id, q.summaryVersion);
                for (const w of q.waiters) w.reject(err);
            }
        }
    });
    _saveWorker.on('error', (err) => {
        for (const [, p] of _saveWorkerPending) {
            _rollbackCachedSessionSummary(p.id, p.summaryVersion);
            for (const w of p.waiters) w.reject(err);
        }
        _saveWorkerPending.clear();
        for (const [id, q] of _saveAsyncQueued) {
            _rollbackCachedSessionSummary(id, q.summaryVersion);
            for (const w of q.waiters) w.reject(err);
        }
        _saveAsyncQueued.clear();
        _saveAsyncInflight.clear();
        _saveWorkerRefCount = 0;
        _saveWorker = null;
    });
    _saveWorker.on('exit', (code) => {
        // Reject pending resolvers on ANY exit (code 0 included) so an idle
        // worker that races a pending postMessage cannot leak resolvers. The
        // map is empty on the normal idle-exit path so the loop is a no-op,
        // but it remains safe for the race window where exit fires after
        // saveSessionAsync registered a resolver but before the worker
        // received the message.
        const err = new Error(`[session-store] save worker exited with code ${code}`);
        for (const [, p] of _saveWorkerPending) {
            _rollbackCachedSessionSummary(p.id, p.summaryVersion);
            for (const w of p.waiters) w.reject(err);
        }
        _saveWorkerPending.clear();
        for (const [id, q] of _saveAsyncQueued) {
            _rollbackCachedSessionSummary(id, q.summaryVersion);
            for (const w of q.waiters) w.reject(err);
        }
        _saveAsyncQueued.clear();
        _saveAsyncInflight.clear();
        _saveWorkerRefCount = 0;
        _saveWorker = null;
    });
    _saveWorker.unref(); // don't keep process alive
    return _saveWorker;
}

/**
 * Post one in-flight write for `id` to the worker and register it as the
 * single in-flight entry for that id. Callers guarantee no write is already
 * in flight for `id`. Throws (after cleaning its own map entries) if the
 * worker postMessage fails so the caller can reject the affected waiters.
 */
export function _postAsyncWrite(id, session, opts, waiters, summaryVersion) {
    const reqId = ++_saveWorkerReqId;
    _saveWorkerPending.set(reqId, {
        id,
        session,
        opts,
        summaryVersion,
        waiters,
    });
    _saveAsyncInflight.set(id, reqId);
    try {
        const w = _getOrSpawnWorker();
        w.postMessage({ session, opts, reqId });
        // Ref AFTER successful postMessage so a queue/throw failure path does
        // not leave the worker held alive with no pending message. Paired with
        // the unref in the message handler when count hits 0.
        if (++_saveWorkerRefCount === 1) w.ref();
    } catch (err) {
        _saveWorkerPending.delete(reqId);
        _saveAsyncInflight.delete(id);
        throw err;
    }
}

/**
 * Async save via a dedicated Worker thread.
 * Errors surface as thrown Errors — callers must not silently swallow them.
 *
 * Per-session latest-wins coalescing: for a given id there is at most one
 * write in flight plus one queued follow-up. N rapid saves for the same id in
 * a turn collapse to (in-flight + one queued-latest), keeping the single
 * worker's backlog bounded. Per-id write ORDERING is preserved (a queued write
 * is only posted once the prior in-flight write for that id settles); different
 * ids interleave freely as before.
 */
export function saveSessionAsync(session, opts) {
    _ensureLifecycleFields(session);
    setLiveSession(session);
    const id = session.id;
    const summaryVersion = _cacheSessionSummary(session);
    const safeOpts = opts?._sessionWriteGuard ? opts : _guardedSaveOptions(id, opts);
    // The Worker `postMessage` below structured-clones the whole session on the
    // main thread. `session.liveTurnMessages` (live working transcript) and
    // `session.toolApprovalHook` (askOpts.onToolApproval callback) are transient
    // in-flight aliases askSession sets for the turn duration; both carry
    // non-cloneable values (a function, and raw messages that can hold functions),
    // which makes structuredClone throw "could not be cloned" for every mid-turn
    // iteration save. The worker strips both via _sessionForDisk anyway, so drop
    // them from the cloned payload here WITHOUT mutating the live session object.
    const clonePayload = (session && typeof session === 'object'
        && (Object.prototype.hasOwnProperty.call(session, 'liveTurnMessages')
            || Object.prototype.hasOwnProperty.call(session, 'toolApprovalHook')))
        ? (() => { const { liveTurnMessages: _dropLTM, toolApprovalHook: _dropTAH, ...rest } = session; return rest; })()
        : session;
    return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        if (_saveAsyncInflight.has(id)) {
            // A write is already on disk for this id — coalesce into the single
            // latest-wins queued slot. Existing queued waiters carry over so a
            // superseded caller resolves when THIS newer write lands (never
            // hang, never reject on supersede).
            const q = _saveAsyncQueued.get(id);
            if (q) {
                q.session = clonePayload;
                q.opts = safeOpts;
                q.summaryVersion = summaryVersion;
                q.waiters.push(waiter);
            } else {
                _saveAsyncQueued.set(id, {
                    session: clonePayload,
                    opts: safeOpts,
                    summaryVersion,
                    waiters: [waiter],
                });
            }
            return;
        }
        // Idle for this id — post immediately as the in-flight write. The
        // in-flight entry persists {session, opts} so drainSessionStore can
        // sync-flush outstanding writes if process exit interrupts the queue.
        try {
            _postAsyncWrite(id, clonePayload, safeOpts, [waiter], summaryVersion);
        } catch (err) {
            _rollbackCachedSessionSummary(id, summaryVersion);
            reject(err);
        }
    });
}

/**
 * Register a save for the exit drain now, but yield one check phase before
 * Worker.postMessage performs its main-thread structured clone.
 */
export function saveSessionAsyncDeferred(session, opts) {
    _ensureLifecycleFields(session);
    setLiveSession(session);
    _cacheSessionSummary(session);
    const reqId = ++_deferredSaveReqId;
    return new Promise((resolve, reject) => {
        _deferredSessionSaves.set(reqId, {
            session,
            opts: _guardedSaveOptions(session.id, opts),
            resolve,
            reject,
        });
        setImmediate(() => {
            const pending = _deferredSessionSaves.get(reqId);
            if (!pending) return;
            _deferredSessionSaves.delete(reqId);
            saveSessionAsync(pending.session, pending.opts).then(resolve, reject);
        });
    });
}

export function _resetSaveWorkerBookkeeping() {
    _saveWorkerPending.clear();
    _saveAsyncQueued.clear();
    _saveAsyncInflight.clear();
    _saveWorkerRefCount = 0;
}
