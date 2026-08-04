import { Worker } from 'worker_threads';
import { guardedSaveOptions as _guardedSaveOptions } from './write-guards.mjs';
import { _ensureLifecycleFields, _messagesForDisk, _sessionForDisk } from './serialize.mjs';
import { setLiveSession, _recordSaveFailure, _recordSaveDrop, _clearSaveStateIfCurrent, _nextSaveEpoch, _acquireSessionIncarnation, _releaseSessionIncarnation, _isCurrentSessionIncarnation, SAVE_OUTCOME_STALE } from './live-state.mjs';
import { _cacheSessionSummary, _rollbackCachedSessionSummary, _queueSessionSummaryUpsertRow } from './summary-cache.mjs';
import { _sessionSummary } from '../store-summary-index.mjs';
import {
    serializeSessionSaveFault,
    sessionSaveFaultSyncKey,
    _onSessionSaveFaultChange,
    _sessionStoreTestMode,
} from './save-fault.mjs';

// ── Worker-thread async save ──────────────────────────────────────────────────
// Single long-lived Worker serializes all saveSessionAsync calls.
// The worker's message queue preserves generation-race ordering.
let _saveWorker = null;
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
let _saveWorkerReqId = 0;
let _saveWorkerRefCount = 0;
let _deferredSaveReqId = 0;
export const _deferredSessionSaves = new Map();

// ── Delta handoff to the save worker ─────────────────────────────────────────
// Worker.postMessage structured-clones on the CALLER's thread, so a full-
// transcript payload per turn cost O(whole conversation) on the engine thread.
// Turns normally APPEND to the message list (the array is replaced but the
// settled message objects are reused by reference), so the parent tracks the
// exact refs last handed to the worker and, on a pure append, ships only the
// header + projected tail — O(turn). Any prefix change (compaction, clear,
// repair), a broken chain (failure/restart), or the periodic full resync
// falls back to a full snapshot. Lock-free and per-id: sessions stay fully
// parallel and the single worker's per-id FIFO preserves chain order.
const _deltaBaseline = new Map(); // id → { refs: message[], deltasSinceFull }
const DELTA_BASELINE_MAX = 8;
const DELTA_FULL_RESYNC_EVERY = 25;

function _touchDeltaBaseline(id, entry) {
    _deltaBaseline.delete(id);
    _deltaBaseline.set(id, entry);
    while (_deltaBaseline.size > DELTA_BASELINE_MAX) {
        const oldest = _deltaBaseline.keys().next().value;
        if (oldest === undefined) break;
        _deltaBaseline.delete(oldest);
    }
}

function _invalidateDeltaBaseline(id) {
    _deltaBaseline.delete(id);
}

function _immutableProjection(messages) {
    if (!Array.isArray(messages)) return null;
    // DEEP copy: the projected baseline must survive in-place nested edits of
    // messages that were already sent (a reference-identity delta never ships
    // those, so they may not appear in failure evidence either).
    try { return structuredClone(messages); } catch { return null; }
}

function _buildWirePayload(id, session, forceFull = false) {
    const live = Array.isArray(session.messages) ? session.messages : [];
    const base = forceFull ? null : _deltaBaseline.get(id);
    if (base && base.deltasSinceFull < DELTA_FULL_RESYNC_EVERY && live.length >= base.refs.length) {
        let pureAppend = true;
        for (let index = 0; index < base.refs.length; index += 1) {
            if (live[index] !== base.refs[index]) { pureAppend = false; break; }
        }
        if (pureAppend) {
            // Header: full disk projection with an empty message list (strips
            // transient aliases); tail: per-message projection of the appended
            // suffix only. Both use the same idempotent per-message projection
            // as a full send, so worker-side reconstruction is byte-identical.
            const header = _sessionForDisk({ ...session, messages: [] });
            const tailMessages = _messagesForDisk(live.slice(base.refs.length));
            // The EXACT payload the worker will reconstruct and write:
            // immutable projected baseline + this delta. Failure evidence must
            // be this, never a fresh projection of the mutable live session
            // (an in-place nested edit of an already-sent message is NOT part
            // of a reference-identity delta and must be absent here too).
            const projectedBase = Array.isArray(base.projected) && base.projected.length === base.refs.length
                ? base.projected
                : null;
            const clonedTail = _immutableProjection(tailMessages);
            const projected = projectedBase && clonedTail ? [...projectedBase, ...clonedTail] : null;
            _touchDeltaBaseline(id, {
                refs: live.slice(),
                deltasSinceFull: base.deltasSinceFull + 1,
                projected,
            });
            return {
                delta: { baseCount: base.refs.length, header, tailMessages },
                attempt: projected ? { ...header, messages: projected } : null,
            };
        }
    }
    const full = _sessionForDisk(session);
    _touchDeltaBaseline(id, {
        refs: live.slice(),
        deltasSinceFull: 0,
        // DEEP COPY: _sessionForDisk may return the live array (and the live
        // message objects) itself; later appends or in-place nested edits must
        // not reach this baseline.
        projected: _immutableProjection(full.messages) ?? [],
    });
    return { session: full, attempt: full };
}

/**
 * Build the exact payload the worker will persist BEFORE Worker.postMessage
 * structured-clones it on the caller's thread. Inline image/document bytes and
 * transient live-turn aliases are disk-ineligible already; removing them here
 * prevents a multi-megabyte duplicate allocation and long clone pause while
 * preserving canonical text/tool history byte-for-byte.
 */
export function _sessionPayloadForSaveWorker(session) {
    return _sessionForDisk(session);
}

// ── Fault-state mirroring (parent → worker) ─────────────────────────────────
// The worker thread is long-lived and owns its own module instance of
// save-fault.mjs, which setSessionSaveFault() never reaches, so the parent
// pushes the authoritative state: on spawn, on every config change, and (as a
// cheap key compare) before every posted write. Clearing propagates the same
// way, which is what makes `setSessionSaveFault(null)` stop worker faults.
let _faultSyncedKey = null;

// ── Pre-admission authority (parent-side) ───────────────────────────────────
// store.mjs registers its strict canonical-record check here (an import would
// be circular). An async/worker save must pass it BEFORE any live snapshot or
// optimistic summary row is published: foreign/ambiguous records must never be
// cached as owned, not even transiently.
let _writeAuthorityCheck = null;

export function _setSessionWriteAuthorityCheck(check) {
    _writeAuthorityCheck = typeof check === 'function' ? check : null;
}

function _refuseUnownedWrite(id) {
    if (!_writeAuthorityCheck || !id) return null;
    let refusal = null;
    // A THROWN check is a refusal, never acceptance.
    try { refusal = _writeAuthorityCheck(id); } catch { refusal = 'unreadable'; }
    if (!refusal) return null;
    const err = new Error(`[session-store] ${id}: refusing async save — canonical record is ${refusal}`);
    err.code = 'ESESSIONNOTOWNED';
    err.sessionAuthorityRefusal = refusal;
    return err;
}

function _syncFaultToWorker(worker, { force = false } = {}) {
    if (!worker) return;
    const key = sessionSaveFaultSyncKey();
    if (!force && key === _faultSyncedKey) return;
    try {
        worker.postMessage({ __fault: serializeSessionSaveFault() });
        _faultSyncedKey = key;
    } catch { /* worker died; respawn re-syncs (force) */ }
}

// Config changes are pushed immediately so a fault set/cleared between saves
// is honoured by the worker's very next commit.
_onSessionSaveFaultChange(() => {
    if (_saveWorker) _syncFaultToWorker(_saveWorker, { force: true });
});

/**
 * Reject one settled worker write. The failure is RECORDED BEFORE the waiters
 * are rejected, so a caller's rejection handler already observes
 * getSessionSaveError(id) / the non-evictable live snapshot; and the
 * optimistic summary row is rolled back so a failed write never publishes.
 */
function _failWorkerWrite(id, summaryVersion, waiters, err, epoch = null, incarnation = null, session = null, known = null) {
    // Currentness may be PRECOMPUTED by the caller: once the pending reference
    // is released, cap eviction can drop the token, and re-deriving here would
    // then misread a real failure as a stale post-delete outcome.
    const isCurrent = typeof known === 'boolean'
        ? known
        : _isCurrentSessionIncarnation(id, incarnation);
    if (!isCurrent) {
        // The session was hard-deleted (and possibly re-created) after this
        // write was posted: its failure is about a file that no longer exists.
        // Settle the callers ONCE and touch nothing — no marker, no delta
        // baseline: none of it belongs to this incarnation any more.
        for (const w of waiters) w.reject(err);
        return;
    }
    _invalidateDeltaBaseline(id);
    _rollbackCachedSessionSummary(id, summaryVersion);
    // The failed payload's own snapshot travels with the failure: it is the
    // only in-memory copy allowed to stand in for an unreadable canonical file.
    _recordSaveFailure(id, err, epoch, session);
    for (const w of waiters) w.reject(err);
}

/** Rebuild the worker-side error locally WITHOUT losing its code/marker. */
function _workerSaveError(message, code, injected) {
    const err = new Error(`[session-store] worker save failed: ${message}`);
    if (code) err.code = code;
    if (injected) err.injectedSaveFault = true;
    err.workerMessage = message;
    return err;
}

function _getOrSpawnWorker() {
    if (_saveWorker) return _saveWorker;
    // Every handler below is bound to THIS instance: a worker that already
    // died (its error/exit events can arrive after a replacement is live, and
    // 'exit' always follows 'error') must never settle, reject or ref-count
    // the pending writes of the worker that replaced it.
    const worker = new Worker(new URL('../save-session-worker.mjs', import.meta.url), {
        execArgv: [],
    });
    _saveWorker = worker;
    // Push current fault state before any write can be posted: the worker's
    // own realm has no other source for it.
    _faultSyncedKey = null;
    _syncFaultToWorker(worker, { force: true });
    // Worker logs arrive as `{ __log }` messages, NOT via piped stdio
    // (stdout:true/stderr:true): once the parent starts reading a worker's
    // piped stdio, the underlying MessagePort stays ref'd for the worker's
    // lifetime regardless of worker.unref(), so every process that ever
    // saved a session could no longer exit (test runners hung after
    // completion). The worker overrides its own process.stdout/stderr.write
    // to forward through this channel, which keeps stray prints off the TUI
    // frame (routed through the parent's guardable stderr) without holding
    // the event loop.
    worker.on('message', ({ __log, ok, saved, outcome, deltaMiss, error, errorCode, injectedSaveFault, reqId }) => {
        if (__log !== undefined) {
            try { process.stderr.write(String(__log)); } catch { /* best-effort */ }
            return;
        }
        if (worker !== _saveWorker) return; // stale instance: not our bookkeeping
        const p = _saveWorkerPending.get(reqId);
        if (!p) return;
        _saveWorkerPending.delete(reqId);
        // Drop the ref AFTER pending was registered ref-up'd so the worker
        // becomes unref'd again once all in-flight writes settle.
        // Never let the count go negative (a drain may have retired the
        // bookkeeping while this write was still in the worker's queue),
        // otherwise the `=== 0` unref below can never fire again and the
        // process stays alive on a ref'd worker.
        if (_saveWorkerRefCount > 0) _saveWorkerRefCount--;
        if (_saveWorkerRefCount === 0) worker.unref();
        const { id, session, attemptSnapshot, summaryVersion, summaryRow, waiters, epoch, revision, incarnation } = p;
        const isCurrentIncarnation = _isCurrentSessionIncarnation(id, incarnation);
        // NOTE: the reference is released in the finally below, AFTER every
        // marker decision, so release-time eviction cannot change the verdict.
        try {
        if (!isCurrentIncarnation) {
            // Hard delete landed after this write was posted. Its outcome is
            // about a file that no longer exists: settle every caller exactly
            // once, then touch NOTHING — no drop/failure marker, no summary
            // publish, no live pin, no delta baseline. The id may already
            // belong to a NEW incarnation, so only slots this very request
            // still owns may be cleared.
            if (_saveAsyncInflight.get(id) === reqId) _saveAsyncInflight.delete(id);
            const stale = _saveAsyncQueued.get(id);
            if (stale && stale.incarnation === incarnation) {
                _saveAsyncQueued.delete(id);
                _releaseSessionIncarnation(stale.incarnation);
                for (const w of stale.waiters) w.resolve();
            }
            if (ok) for (const w of waiters) w.resolve();
            else for (const w of waiters) w.reject(_workerSaveError(error, errorCode, injectedSaveFault));
            return;
        }
        _saveAsyncInflight.delete(id);
        if (ok && deltaMiss && !p.retriedFull) {
            // The worker restarted or evicted this id's base mid-chain. Not a
            // drop: retry once as a FULL snapshot of the current live session
            // (latest-wins durability, same waiters). The queued slot stays
            // queued and promotes after the retry settles.
            _invalidateDeltaBaseline(id);
            try {
                _postAsyncWrite(id, session, p.opts, waiters, summaryVersion, epoch, revision, {
                    forceFull: true,
                    retriedFull: true,
                });
                return;
            } catch (err) {
                // The RETRY is its own attempt: only its projected payload may
                // stand as evidence. Falling back to the original delta
                // snapshot would publish bytes this failure never attempted.
                _failWorkerWrite(id, summaryVersion, waiters, err, epoch, incarnation, err?.attemptSnapshot ?? null, isCurrentIncarnation);
            }
        }
        // Resolve/reject every caller whose payload this write represents
        // (the originating call plus any that coalesced onto it before it was
        // posted). A supersede never lands here as a rejection — only a real
        // worker failure does. (A deltaMiss on a retried FULL is unreachable —
        // the worker only misses on delta payloads.)
        else if (ok) {
            // A close/delete may have completed while the worker was writing.
            // Do not let this older completion put an open row back in the
            // process-local cache after its tombstone/removal.
            if (saved) {
                // Publish the IMMUTABLE row captured when this payload was
                // built — never a row re-derived from the live session, which
                // may already carry a newer (unwritten, possibly failing) turn.
                _queueSessionSummaryUpsertRow(summaryRow, summaryVersion);
                // ONLY a landed write proves durability, so this is the only
                // place the save-failure flag may be cleared — and only when
                // THIS payload is at least as new as the newest failed/dropped
                // one. An older worker write finishing after a newer sync/async
                // failure carries stale content and must leave the markers (and
                // therefore the live pin) exactly where they are.
                _clearSaveStateIfCurrent(id, epoch);
            } else if (outcome === SAVE_OUTCOME_STALE) {
                // A strictly NEWER write for this id already landed: disk is
                // AHEAD of this payload, not behind it. Nothing was lost, so
                // no drop marker, no save error and no live pin — the snapshot
                // stays immediately evictable. Only the optimistic summary row
                // for these bytes is rolled back.
                _invalidateDeltaBaseline(id);
                _rollbackCachedSessionSummary(id, summaryVersion);
            } else {
                // The worker's _shouldDrop declined the write: disk ownership
                // moved past this snapshot — flag the split-brain so eviction
                // and disk-over-live arbitration keep the richer local copy.
                // Nothing was written, so an earlier save failure for this id
                // STAYS recorded (clearing it here would un-pin the only good
                // in-memory transcript for an id whose disk copy is behind).
                _invalidateDeltaBaseline(id);
                _rollbackCachedSessionSummary(id, summaryVersion);
                _recordSaveDrop(id, epoch);
            }
            for (const w of waiters) w.resolve();
        }
        else {
            _failWorkerWrite(id, summaryVersion, waiters, _workerSaveError(error, errorCode, injectedSaveFault), epoch, incarnation, attemptSnapshot, isCurrentIncarnation);
        }
        // Promote the latest-wins queued payload (if any) into the now-free
        // in-flight slot for this id. Runs regardless of ok: the queued write
        // is a newer, independent payload and must still be attempted so its
        // (possibly superseded) waiters resolve when it lands.
        const q = _saveAsyncQueued.get(id);
        if (q) {
            _saveAsyncQueued.delete(id);
            // The promotion KEEPS the queued reference through projection, the
            // post and any immediate failure settlement: releasing first would
            // let cap eviction drop the token and make a real current failure
            // look like a stale post-delete outcome (no marker, no live pin).
            const queuedCurrent = _isCurrentSessionIncarnation(id, q.incarnation);
            try {
                _postAsyncWrite(id, q.session, q.opts, q.waiters, q.summaryVersion, q.epoch, q.revision);
            } catch (err) {
                // Evidence is this promotion's OWN projected attempt when it
                // got that far, never the queued (unprojected) live session.
                _failWorkerWrite(id, q.summaryVersion, q.waiters, err, q.epoch, q.incarnation, err?.attemptSnapshot ?? null, queuedCurrent);
            } finally {
                _releaseSessionIncarnation(q.incarnation);
            }
        }
        } finally {
            _releaseSessionIncarnation(incarnation);
        }
    });
    worker.on('error', (err) => {
        if (worker !== _saveWorker) return; // a replacement owns the maps now
        _deltaBaseline.clear();
        for (const [, p] of _saveWorkerPending) {
            _failWorkerWrite(p.id, p.summaryVersion, p.waiters, err, p.epoch, p.incarnation, p.attemptSnapshot);
            _releaseSessionIncarnation(p.incarnation);
        }
        _saveWorkerPending.clear();
        for (const [id, q] of _saveAsyncQueued) {
            // A queued payload was never projected or posted: it is settled and the
            // operational error is recorded, but it may NEVER stand as recovery
            // evidence (that must be an attempted, immutable payload).
            _failWorkerWrite(id, q.summaryVersion, q.waiters, err, q.epoch, q.incarnation, null);
            _releaseSessionIncarnation(q.incarnation);
        }
        _saveAsyncQueued.clear();
        _saveAsyncInflight.clear();
        _saveWorkerRefCount = 0;
        _faultSyncedKey = null;
        _saveWorker = null;
    });
    worker.on('exit', (code) => {
        // 'exit' ALWAYS follows 'error' (which already nulled _saveWorker) and
        // can arrive after a replacement spawned: only the current instance may
        // retire the shared bookkeeping.
        if (worker !== _saveWorker) return;
        _deltaBaseline.clear();
        // Reject pending resolvers on ANY exit (code 0 included) so an idle
        // worker that races a pending postMessage cannot leak resolvers. The
        // map is empty on the normal idle-exit path so the loop is a no-op,
        // but it remains safe for the race window where exit fires after
        // saveSessionAsync registered a resolver but before the worker
        // received the message.
        const err = new Error(`[session-store] save worker exited with code ${code}`);
        for (const [, p] of _saveWorkerPending) {
            _failWorkerWrite(p.id, p.summaryVersion, p.waiters, err, p.epoch, p.incarnation, p.attemptSnapshot);
            _releaseSessionIncarnation(p.incarnation);
        }
        _saveWorkerPending.clear();
        for (const [id, q] of _saveAsyncQueued) {
            // A queued payload was never projected or posted: it is settled and the
            // operational error is recorded, but it may NEVER stand as recovery
            // evidence (that must be an attempted, immutable payload).
            _failWorkerWrite(id, q.summaryVersion, q.waiters, err, q.epoch, q.incarnation, null);
            _releaseSessionIncarnation(q.incarnation);
        }
        _saveAsyncQueued.clear();
        _saveAsyncInflight.clear();
        _saveWorkerRefCount = 0;
        _faultSyncedKey = null;
        _saveWorker = null;
    });
    worker.unref(); // don't keep process alive
    return worker;
}

/**
 * Post one in-flight write for `id` to the worker and register it as the
 * single in-flight entry for that id. Callers guarantee no write is already
 * in flight for `id`. Throws (after cleaning its own map entries) if the
 * worker postMessage fails so the caller can reject the affected waiters.
 */
function _postAsyncWrite(id, session, opts, waiters, summaryVersion, epoch, revision = 0, { forceFull = false, retriedFull = false } = {}) {
    const reqId = ++_saveWorkerReqId;
    // The wire payload is built at POST time from the live session: N calls
    // coalesced behind one in-flight write project ONCE (newest state), and a
    // pure-append turn ships only the tail (see _buildWirePayload).
    const wire = _buildWirePayload(id, session, forceFull);
    // Snapshot the summary metadata for exactly these bytes, at exactly this
    // moment. The pending entry then holds immutable payload data even though
    // `session` remains the live object the exit drain needs.
    const summaryRow = _sessionSummary(session);
    // IMMUTABLE failure evidence for exactly this attempt: the message list is
    // copied now, so a later mutation of the live session cannot change what a
    // failed settlement records.
    // DEEP, immutable copy of the EXACT projected payload posted to the
    // worker (disk-ineligible data already stripped). Mutating any nested
    // message/tool/media field afterwards cannot change this evidence.
    let attemptSnapshot = null;
    try {
        attemptSnapshot = wire.attempt ? structuredClone(wire.attempt) : null;
    } catch {
        attemptSnapshot = null; // unclonable payload records no evidence at all
    }
    _saveWorkerPending.set(reqId, {
        id,
        session,
        attemptSnapshot,
        opts,
        summaryVersion,
        summaryRow,
        waiters,
        retriedFull,
        epoch,
        revision,
        // Incarnation observed at POST time. Settlement compares OBJECT
        // IDENTITY, so a hard delete — and any later reuse of the id — is
        // detected exactly, with no counter to wrap, reset or collide.
        incarnation: _acquireSessionIncarnation(id),
    });
    _saveAsyncInflight.set(id, reqId);
    try {
        const w = _getOrSpawnWorker();
        // Cheap key compare; posts only when the fault config/env moved.
        _syncFaultToWorker(w);
        const { attempt: _attempt, ...wireForPost } = wire;
        w.postMessage({ ...wireForPost, id, opts, reqId });
        // Ref AFTER successful postMessage so a queue/throw failure path does
        // not leave the worker held alive with no pending message. Paired with
        // the unref in the message handler when count hits 0.
        if (++_saveWorkerRefCount === 1) w.ref();
    } catch (err) {
        // Projection SUCCEEDED but posting failed: carry the exact projected
        // attempt with the error so the caller records immutable evidence
        // instead of the mutable live session. When projection/clone itself
        // failed there is no attempted payload, so no evidence is recorded.
        if (attemptSnapshot && err && typeof err === 'object' && err.attemptSnapshot === undefined) {
            try { err.attemptSnapshot = attemptSnapshot; } catch { /* frozen error */ }
        }
        // This entry never reaches the message handler, so its incarnation
        // reference is freed here.
        const orphan = _saveWorkerPending.get(reqId);
        _releaseSessionIncarnation(orphan?.incarnation);
        _saveWorkerPending.delete(reqId);
        _saveAsyncInflight.delete(id);
        _invalidateDeltaBaseline(id);
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
export function saveSessionAsync(session, opts, options = {}) {
    const id = session.id;
    let summaryVersion = null;
    let safeOpts = null;
    // Identity of THIS attempt (see live-state _clearSaveStateIfCurrent): the
    // content handed over here, not the moment the worker happens to finish.
    // A deferred save promotes with the epoch it was ISSUED with, so the wait
    // for its check phase cannot make an older snapshot look newer.
    const epoch = Number.isFinite(options.epoch) ? options.epoch : _nextSaveEpoch();
    // Payload revision WITHIN that identity (see parkSessionSnapshotForDrain):
    // the drain uses it to rank this exact payload against a parked snapshot
    // sharing the same epoch.
    const revision = Number.isFinite(options.revision) ? options.revision : 0;
    // PRE-ADMISSION: strict canonical authority BEFORE anything is published.
    // A refusal publishes no live snapshot and no optimistic summary row, so a
    // foreign/ambiguous record is never cached as owned even transiently.
    const unowned = _refuseUnownedWrite(id);
    if (unowned) return Promise.reject(unowned);
    try {
        _ensureLifecycleFields(session);
        // Pin the live snapshot BEFORE anything can fail: every failure below
        // leaves this process's memory as the only copy of the newest turn.
        setLiveSession(session);
        summaryVersion = _cacheSessionSummary(session);
        // The guard carries this snapshot's epoch across the thread boundary,
        // so the worker's own commit is fenced against a newer landed write.
        safeOpts = opts?._sessionWriteGuard ? opts : _guardedSaveOptions(id, opts, epoch);
    } catch (err) {
        // Setup/guard failure is a save failure like any other: record it
        // before the caller can observe the rejection.
        _failWorkerWrite(id, summaryVersion, [], err, epoch, null, err?.attemptSnapshot ?? null);
        return Promise.reject(err);
    }
    // Projection/clone now happen at POST time (see _postAsyncWrite): pending
    // entries hold the LIVE session reference — same object listings and the
    // exit drain already consume — so superseded saves never pay a projection.
    return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        if (_saveAsyncInflight.has(id)) {
            // A write is already on disk for this id — coalesce into the single
            // latest-wins queued slot. Existing queued waiters carry over so a
            // superseded caller resolves when THIS newer write lands (never
            // hang, never reject on supersede).
            const q = _saveAsyncQueued.get(id);
            if (q) {
                q.session = session;
                q.opts = safeOpts;
                q.summaryVersion = summaryVersion;
                q.epoch = epoch;
                q.revision = revision;
                q.waiters.push(waiter);
            } else {
                _saveAsyncQueued.set(id, {
                    session,
                    opts: safeOpts,
                    summaryVersion,
                    epoch,
                    revision,
                    incarnation: _acquireSessionIncarnation(id),
                    waiters: [waiter],
                });
            }
            return;
        }
        // Idle for this id — post immediately as the in-flight write. The
        // in-flight entry persists {session, opts} so drainSessionStore can
        // sync-flush outstanding writes if process exit interrupts the queue.
        try {
            _postAsyncWrite(id, session, safeOpts, [waiter], summaryVersion, epoch, revision);
        } catch (err) {
            // Payload-build / spawn / postMessage-clone failure. Record the
            // save failure (live snapshot pinned + non-evictable) BEFORE the
            // waiter is rejected, exactly like a settled worker failure.
            _failWorkerWrite(id, summaryVersion, [waiter], err, epoch, null, err?.attemptSnapshot ?? null);
        }
    });
}

/**
 * Register a save for the exit drain now, but yield one check phase before
 * Worker.postMessage performs its main-thread structured clone.
 */
export function saveSessionAsyncDeferred(session, opts) {
    const reqId = ++_deferredSaveReqId;
    // Issued NOW: this identity travels through the deferred map, the promoted
    // async save and the exit drain unchanged.
    const epoch = _nextSaveEpoch();
    return new Promise((resolve, reject) => {
        const unowned = _refuseUnownedWrite(session?.id);
        if (unowned) {
            reject(unowned);
            return;
        }
        try {
            _ensureLifecycleFields(session);
            setLiveSession(session);
            _cacheSessionSummary(session);
        } catch (err) {
            _failWorkerWrite(session?.id, null, [], err, epoch, null, err?.attemptSnapshot ?? null);
            reject(err);
            return;
        }
        _deferredSessionSaves.set(reqId, {
            session,
            opts: _guardedSaveOptions(session.id, opts, epoch),
            epoch,
            revision: 0,
            // Deferred payloads are incarnation-stamped like every other unit
            // of work: a hard delete retires them with the id.
            incarnation: _acquireSessionIncarnation(session.id),
            resolve,
            reject,
        });
        setImmediate(() => {
            const pending = _deferredSessionSaves.get(reqId);
            if (!pending) return;
            _deferredSessionSaves.delete(reqId);
            // The promoted save takes its own stamp.
            _releaseSessionIncarnation(pending.incarnation);
            try {
                saveSessionAsync(pending.session, pending.opts, { epoch: pending.epoch }).then(resolve, reject);
            } catch (err) {
                _failWorkerWrite(session?.id, null, [], err, epoch, null, err?.attemptSnapshot ?? null);
                reject(err);
            }
        });
    });
}

export function _resetSaveWorkerBookkeeping() {
    // Release any worker ref still held by writes we are retiring: dropping
    // the maps without unref'ing leaves the process pinned alive by a worker
    // whose completion message will never find its pending entry.
    if (_saveWorkerRefCount > 0 && _saveWorker) {
        try { _saveWorker.unref(); } catch { /* worker already gone */ }
    }
    // Retiring the maps also retires their incarnation references.
    for (const [, p] of _saveWorkerPending) _releaseSessionIncarnation(p.incarnation);
    for (const [, q] of _saveAsyncQueued) _releaseSessionIncarnation(q.incarnation);
    _saveWorkerPending.clear();
    _saveAsyncQueued.clear();
    _saveAsyncInflight.clear();
    _saveWorkerRefCount = 0;
    _deltaBaseline.clear();
}

const _noopSettle = () => {};

/**
 * Park a still-deferred snapshot in the SAME map the exit drain already walks
 * (`_deferredSessionSaves`). A module that throttles its own saves therefore
 * needs no second exit-flush path: the drain picks the snapshot up ranked by
 * its issuance epoch, under a fresh cancellation guard, the shared commit
 * lock, the ownership (`expectedGeneration`) check, the landed-epoch fence and
 * the one global drain deadline.
 *
 * Re-parking the same session PRESERVES the epoch and the guarded options it
 * was first deferred with — parking never mints fresh write authority, and the
 * original `expectedGeneration` keeps a later lifecycle barrier authoritative.
 * The returned handle carries those guarded options so the owner can run its
 * OWN save (and every retry of it) under exactly this identity.
 */
export function parkSessionSnapshotForDrain(session, opts, handle = null) {
    const id = session?.id;
    if (!id) return null;
    const parked = handle?.key === undefined ? null : _deferredSessionSaves.get(handle.key);
    if (parked && parked.session?.id === id) {
        if (parked.session !== session) {
            // A DISTINCT newer payload under the same issuance identity: bump
            // the revision so the drain can rank it above an in-flight write
            // that was posted from the previous ref.
            parked.session = session;
            parked.revision += 1;
            handle.revision = parked.revision;
        }
        return handle;
    }
    const epoch = _nextSaveEpoch();
    const key = ++_deferredSaveReqId;
    const guarded = _guardedSaveOptions(id, opts, epoch);
    _deferredSessionSaves.set(key, {
        session,
        opts: guarded,
        epoch,
        revision: 0,
        incarnation: _acquireSessionIncarnation(id),
        resolve: _noopSettle,
        reject: _noopSettle,
    });
    return { key, epoch, revision: 0, opts: guarded };
}

/** Drop a parked snapshot once its own save path took over (or on close). */
export function unparkSessionSnapshotForDrain(handle) {
    if (handle?.key === undefined) return;
    const parked = _deferredSessionSaves.get(handle.key);
    if (parked) _releaseSessionIncarnation(parked.incarnation);
    _deferredSessionSaves.delete(handle.key);
}

/**
 * Hard delete: drop ALL save bookkeeping owned by the retired incarnation —
 * deferred/parked snapshots, the in-flight slot and the latest-wins queued
 * follow-up — so nothing (the exit drain included) can re-create the file, and
 * so a RE-CREATED id starts from an empty slot instead of queueing behind a
 * dead write. Settled as resolved: the session is gone, so the write is moot
 * (rejecting would strand unhandled rejections on finished callers).
 * Returns how many entries were purged.
 */
export function purgeSessionSaveBookkeeping(id) {
    if (!id) return 0;
    let purged = 0;
    for (const [key, pending] of [..._deferredSessionSaves]) {
        if (pending?.session?.id !== id) continue;
        _deferredSessionSaves.delete(key);
        _releaseSessionIncarnation(pending.incarnation);
        purged += 1;
        try { pending.resolve(); } catch { /* best-effort */ }
    }
    // The in-flight slot and the queued follow-up belong to the retired
    // incarnation: their replies settle inert, so free the slots now.
    _saveAsyncInflight.delete(id);
    const queued = _saveAsyncQueued.get(id);
    if (queued) {
        _saveAsyncQueued.delete(id);
        _releaseSessionIncarnation(queued.incarnation);
        purged += 1;
        for (const w of queued.waiters) {
            try { w.resolve(); } catch { /* best-effort */ }
        }
    }
    _invalidateDeltaBaseline(id);
    return purged;
}

/**
 * TEST-ONLY, STRUCTURALLY GATED to the store's fault-injection test mode:
 * detach the live save worker exactly as its own 'error' handler would (module
 * pointer cleared, instance and its handlers left intact) and return it. That
 * is the real shape of the race — the next save spawns a replacement while the
 * detached instance can still emit its late 'exit'/'error'. Returns null when
 * the gate is absent, so production cannot reach it.
 *
 * Detaching with work in flight settles that work exactly like the 'error'
 * path: every waiter is rejected (failure recorded first, live snapshot
 * pinned), the queued slots are settled the same way and the worker ref is
 * released, so no promise and no ref-count can be orphaned.
 */
export function _detachSaveWorkerForTest() {
    if (!_sessionStoreTestMode()) return null;
    const worker = _saveWorker;
    if (!worker) return null;
    _saveWorker = null;
    _faultSyncedKey = null;
    const detached = new Error('[session-store] save worker detached before this write settled');
    for (const [, p] of _saveWorkerPending) {
        _failWorkerWrite(p.id, p.summaryVersion, p.waiters, detached, p.epoch, p.incarnation, p.attemptSnapshot);
        _releaseSessionIncarnation(p.incarnation);
    }
    _saveWorkerPending.clear();
    for (const [id, q] of _saveAsyncQueued) {
        _failWorkerWrite(id, q.summaryVersion, q.waiters, detached, q.epoch, q.incarnation, null);
        _releaseSessionIncarnation(q.incarnation);
    }
    _saveAsyncQueued.clear();
    _saveAsyncInflight.clear();
    if (_saveWorkerRefCount > 0) {
        try { worker.unref(); } catch { /* worker already gone */ }
    }
    _saveWorkerRefCount = 0;
    _deltaBaseline.clear();
    return worker;
}

/**
 * TEST-ONLY, STRUCTURALLY GATED to the store's fault-injection test mode:
 * make the LIVE worker forget one id's delta base, leaving the worker instance
 * and the parent's delta baseline untouched. The next delta for that id then
 * legitimately answers `deltaMiss`, which is the only way to exercise the
 * parent's full-retry path deterministically.
 */
export function _evictWorkerDeltaBaseForTest(id) {
    if (!_sessionStoreTestMode() || !id || !_saveWorker) return false;
    try {
        _saveWorker.postMessage({ __evictBase: String(id) });
        return true;
    } catch {
        return false;
    }
}

/**
 * TEST-ONLY, STRUCTURALLY GATED read-only inspector: does the live worker
 * still hold a delta base for `id`? Used to prove that the eviction seam
 * touches exactly one id (and never clears the whole base map).
 */
export function _probeWorkerDeltaBaseForTest(id, { timeoutMs = 2000 } = {}) {
    if (!_sessionStoreTestMode() || !id || !_saveWorker) return Promise.resolve(null);
    const worker = _saveWorker;
    return new Promise((resolve) => {
        let timer = null;
        const onMessage = (message) => {
            const result = message?.__baseProbeResult;
            if (!result || result.id !== id) return;
            worker.off('message', onMessage);
            if (timer) clearTimeout(timer);
            resolve(result.hasBase === true);
        };
        worker.on('message', onMessage);
        timer = setTimeout(() => {
            worker.off('message', onMessage);
            resolve(null);
        }, timeoutMs);
        // Deliberately NOT unref'd: the probe must settle even when nothing
        // else keeps the loop alive (an unref'd timer would strand it).
        try {
            worker.postMessage({ __baseProbe: String(id) });
        } catch {
            worker.off('message', onMessage);
            if (timer) clearTimeout(timer);
            resolve(null);
        }
    });
}
