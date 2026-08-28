/**
 * File-based session store.
 * Sessions are saved to disk so CLI and MCP server can share state,
 * and sessions survive server restarts (resume).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import * as fsp from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { getPluginData, loadConfig } from '../config.mjs';
import { isAgentOwner } from '../agent-owner.mjs';
import { renameWithRetrySync } from '../../../shared/atomic-file.mjs';
import { sanitizeContentForStoredHistory } from '../providers/media-normalization.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from './lifecycle-scan.mjs';
import { rotateBoundedLog, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../../../../lib/mixdog-debug.cjs';
import { resolveAgentTerminalReapMs } from '../../../../session-runtime/config-helpers.mjs';
import { getStoreDir, sessionPath, publishHeartbeat, deleteHeartbeat, deleteSessionPresence } from './store/paths-heartbeat.mjs';
import {
    guardedSaveOptions as _guardedSaveOptions,
    cancelSessionWrites as _cancelSessionWrites,
    isCancelledWrite as _isCancelledWrite,
    acquireWriteCommit as _acquireWriteCommit,
    releaseWriteCommit as _releaseWriteCommit,
    waitForWriteCommit as _waitForWriteCommit,
    publishLandedWriteEpoch as _publishLandedWriteEpoch,
    isStaleWriteEpoch as _isStaleWriteEpoch,
    WRITE_COMMIT_TIMEOUT as _WRITE_COMMIT_TIMEOUT,
    WRITE_COMMIT_STALE as _WRITE_COMMIT_STALE,
} from './store/write-guards.mjs';
import {
    SESSION_SUMMARY_INDEX_VERSION,
    summaryIndexPath,
    _sessionSummary,
    _normalizeSummaryIndex,
    _writeSummaryIndex,
    _upsertSessionSummary,
    _removeSessionSummary,
    _pruneSummaryIndexIds,
    _flushPendingSummaryOps,
    _hasUnsettledSummaryOps,
} from './store-summary-index.mjs';
// Facade re-export: summary-index API moved to store-summary-index.mjs; keep
// prior importers of store.mjs unchanged.
export {
    SESSION_SUMMARY_INDEX_VERSION,
    summaryIndexPath,
    _sessionSummary,
    _normalizeSummaryIndex,
    _writeSummaryIndex,
    _upsertSessionSummary,
    _removeSessionSummary,
} from './store-summary-index.mjs';
export {
    publishHeartbeat,
    deleteHeartbeat,
    publishSessionPresence,
    deleteSessionPresence,
    readSessionPresenceMtime,
    isSessionPresenceOwnerDead,
    readSessionHeartbeatOwnerPid,
    isSessionHeartbeatOwnerDead,
    isProcessAlive,
} from './store/paths-heartbeat.mjs';
import { _readStoredSessionCached } from './store/load-cache.mjs';
import { probePath, PROBE_PRESENT, PROBE_ABSENT } from './store/fs-probe.mjs';
// Every canonical commit now goes through _commitSessionWrite (fault-aware
// rename + scratch ownership), so the raw rename helper is no longer imported.
import { _sessionForDisk, _ensureLifecycleFields, _storedSessionFromFile } from './store/serialize.mjs';
import { _ensureSummaryCacheDataDir, _cachedSummaryRows, _setSummaryRowsCache, _cacheSessionSummary, _uncacheSessionSummary, _rollbackCachedSessionSummary, _queueSessionSummaryUpsert, _queueSessionSummaryRemoval, _queueSummaryIndexPrune, _scanStoredSessionSummaryRows, _summaryCacheVersions, _summaryCacheRemovals, _summaryRowsCache } from './store/summary-cache.mjs';
import { _lastSaveError, _liveSessions, _droppedSaveIds, setLiveSession, _clearLiveSession, LIVE_MEDIA_RETENTION_MS, _messagesCarryLiveMedia, getSessionSaveError, clearSessionSaveError, _recordSaveFailure, _recordSaveDrop, _clearSaveStateIfCurrent, _nextSaveEpoch, _acquireSessionIncarnation, _releaseSessionIncarnation, _isCurrentSessionIncarnation, _retireSessionIncarnation, _clearSessionSaveState, SAVE_OUTCOME_SAVED, SAVE_OUTCOME_DROPPED, SAVE_OUTCOME_STALE, hasSessionSaveFailure, getFailedSaveSnapshot, _recordLifecycleCommitFailure, clearSessionLifecycleCommitError } from './store/live-state.mjs';
import { _saveWorkerPending, _saveAsyncQueued, _saveAsyncInflight, _deferredSessionSaves, saveSessionAsync, saveSessionAsyncDeferred, _resetSaveWorkerBookkeeping } from './store/save-worker.mjs';
import { purgeSessionSaveBookkeeping as _purgeSessionSaveBookkeeping } from './store/save-worker.mjs';
import { _setLiveSessionPublisher, _setSessionWriteAuthorityCheck } from './store/save-worker.mjs';
import {
    _commitSessionWrite,
    _discardSaveTmp,
    _trackSaveTmp,
    _untrackSaveTmp,
    sweepOrphanSessionTmpFiles,
} from './store/save-fault.mjs';
export { setLiveSession, getSessionSaveError, clearSessionSaveError } from './store/live-state.mjs';
export { getSessionLifecycleCommitError, clearSessionLifecycleCommitError } from './store/live-state.mjs';
// Test-gated save-fault seam + scratch-file hygiene (see store/save-fault.mjs).
export { setSessionSaveFault, sweepOrphanSessionTmpFiles } from './store/save-fault.mjs';
export { saveSessionAsync, saveSessionAsyncDeferred } from './store/save-worker.mjs';
// Deferred-snapshot registration for modules that throttle their own saves
// (usage-metrics): merges into the canonical drain instead of a second exit
// flush path.
export { parkSessionSnapshotForDrain, unparkSessionSnapshotForDrain } from './store/save-worker.mjs';

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

function _publishLiveSession(session) {
    for (const listener of [..._liveSessionSubscribers]) {
        try { listener(session); } catch { /* observers never affect persistence */ }
    }
}

_setLiveSessionPublisher(_publishLiveSession);

function _runSessionPurgeHooks(id) {
    for (const hook of _sessionPurgeHooks) {
        try { hook(id); } catch { /* a cleanup hook never breaks delete */ }
    }
}





/** Module-level map tracking in-flight saves per session ID to prevent concurrent write corruption. */
const _savePending = new Map();

/**
 * Release a payload's incarnation reference exactly once. Payloads that are
 * coalesced away (replaced in a pending slot), dropped by a delete or retired
 * by the drain never reach _doSave*, so their reference is freed here.
 */
function _releasePayloadIncarnation(payload) {
    if (!payload?.incarnation) return;
    _releaseSessionIncarnation(payload.incarnation);
    payload.incarnation = null;
}

/** Drop every payload reference a pending slot still owns. */
function _releasePendingSlot(pending) {
    if (!pending) return;
    _releasePayloadIncarnation(pending.payload);
    _releasePayloadIncarnation(pending.queued);
}

/**
 * Surface an async save rejection. The id-wide error marker may only be
 * stamped while this payload still speaks for the id — after a hard delete (or
 * an id reuse) it belongs to another incarnation.
 */
function _recordAsyncSaveError(id, payload, err) {
    // DIAGNOSTIC ONLY. The authoritative marker (with its immutable failure
    // snapshot and incarnation check) is stamped inside _doSave; stamping a
    // second, unconditional one here is exactly how a delayed rejection used
    // to mark a hard-deleted or re-created id.
    process.stderr.write(`[session-store] save failed: ${err?.message}\n`);
}
// Disk mtime of the summary index at the last time it was read into (or
// refreshed as) the in-memory cache base — cross-process staleness detector.
let _summaryIndexMtimeSeen = 0;


/**
 * Cheap authoritative lifecycle read straight from disk (no live/pending
 * cache). Used by askSession's split-brain re-adoption: a new ask on a
 * non-closed session claims ownership by adopting the on-disk generation.
 * Returns null for BOTH true absence and an unreadable record; callers that
 * must tell those apart use readSessionLifecycleStateFromDisk below.
 */
export function readSessionLifecycleFromDisk(id) {
    const state = readSessionLifecycleStateFromDisk(id);
    if (state.state !== 'open' && state.state !== 'closed') return null;
    return { generation: state.generation, closed: state.state === 'closed' };
}

/**
 * Same durable read, but with the outcome discriminated so a caller can fail
 * CLOSED on an unreadable/corrupt/foreign record while still allowing true
 * absence (a never-saved session):
 *   'absent'     — no such file (ENOENT/ENOTDIR)
 *   'open'       — durable record, not tombstoned (generation carried)
 *   'closed'     — durable tombstone (generation carried)
 *   'unreadable' — IO error, malformed JSON, an ambiguous record (duplicate
 *                  top-level `id`/lifecycle keys), or an identity that is not
 *                  EXACTLY this session: missing, empty, non-string or
 *                  foreign `id` all fail closed. Only a truly absent file is
 *                  'absent'; a malformed/identity-less legacy record is not.
 */
export function readSessionLifecycleStateFromDisk(id) {
    if (!id) return { state: 'unreadable', generation: 0 };
    let raw;
    try {
        raw = readFileSync(sessionPath(id), 'utf-8');
    } catch (err) {
        const code = err?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent', generation: 0 };
        return { state: 'unreadable', generation: 0 };
    }
    // ONE authority, no fallback: readTopLevelLifecycleRecord already IS the
    // strict parse, so a malformed/ambiguous document ends here. A JSON.parse
    // retry would resolve duplicate keys last-wins and defeat the check —
    // even (especially) when one of the duplicates matches the requested id.
    const onDisk = readTopLevelLifecycleRecord(raw);
    if (isLifecycleUnreadable(onDisk)) return { state: 'unreadable', generation: 0 };
    // Durable identity is MANDATORY: the record is this session's authority
    // only when its top-level `id` is a non-empty string exactly equal to the
    // requested id. Missing / empty / non-string identity is not "probably
    // ours" — it is an unowned or malformed record and fails closed exactly
    // like a foreign one. (A never-written session is reported 'absent'
    // above; that is the only backwards-compatible opening.)
    if (onDisk.id !== id) {
        return { state: 'unreadable', generation: 0 };
    }
    return {
        state: onDisk.closed === true ? 'closed' : 'open',
        generation: typeof onDisk.generation === 'number' ? onDisk.generation : 0,
    };
}

/**
 * Freshness of a session's `.hb` heartbeat sidecar (0 when absent). Used by
 * the fork-on-resume guard: a fresh heartbeat published by another process
 * means the session is actively being driven there RIGHT NOW.
 */
export function readSessionHeartbeatMtime(id) {
    if (!id) return 0;
    return _heartbeatMtime(id);
}


/** True while any pending/in-flight persistence still references this id. */
function _hasPendingPersistence(id) {
    if (_savePending.has(id) || _saveAsyncInflight.has(id) || _saveAsyncQueued.has(id)) return true;
    for (const [, pending] of _deferredSessionSaves) {
        if (pending?.session?.id === id) return true;
    }
    return false;
}

/**
 * Drop one session's same-process snapshot once its state is durable on disk.
 * No-op while any write for the id is still pending/in flight.
 */
export function evictLiveSession(id) {
    if (!id || _hasPendingPersistence(id)) return false;
    return _liveSessions.delete(id);
}


/**
 * Idle sweep for the same-process snapshot cache. _liveSessions previously
 * grew without bound — every clear-fork and every touched user session pinned
 * its FULL message array (image bytes included) for process lifetime, the
 * observed multi-GB RSS leak. Disk is the source of truth for anything not
 * actively owned by this process, so an entry is dropped when it (a) has no
 * live runtime owner, (b) has no pending persistence, and (c) already exists
 * on disk — loadSession then falls back to the session file. Media-carrying
 * snapshots get a grace TTL (see LIVE_MEDIA_RETENTION_MS) because eviction is
 * lossy for them; text-only snapshots evict losslessly right away.
 */
export function evictIdleLiveSessions(options = {}) {
    const isSessionLive = typeof options.isSessionLive === 'function' ? options.isSessionLive : null;
    const now = Date.now();
    let evicted = 0;
    for (const [id, session] of [..._liveSessions.entries()]) {
        if (isSessionLive && isSessionLive(id)) continue;
        if (_hasPendingPersistence(id)) continue;
        // Durability proof for the eviction: only a POSITIVELY observed file
        // may replace the snapshot. An unreadable probe is not a durable copy.
        if (probePath(sessionPath(id)).state !== PROBE_PRESENT) continue;
        // A dropped last save means the disk copy is BEHIND this snapshot
        // (ownership split-brain). Evicting would lose the only complete
        // transcript; keep it until a save lands again (re-adoption).
        if (_droppedSaveIds.has(id)) continue;
        // Same reasoning for a save that FAILED at the commit edge (rename/IO
        // fault): the file on disk is the last-good copy from BEFORE the
        // failed write, so this snapshot is the only good state for the newest
        // turn. `existsSync` above is satisfied by exactly that stale file, so
        // without this guard the idle sweep silently discards the newer
        // transcript. Pinned only until a save lands (clearSessionSaveError).
        if (hasSessionSaveFailure(id)) continue;
        if (_messagesCarryLiveMedia(session?.messages)) {
            const lastActive = Math.max(session?.updatedAt || 0, session?.lastUsedAt || 0);
            if (lastActive > 0 && now - lastActive <= LIVE_MEDIA_RETENTION_MS) continue;
        }
        _liveSessions.delete(id);
        // With no pending persistence the rollback-race version counter for
        // this id is dead weight — reclaim it too (it regrows from 1 on the
        // next save, which is safe precisely because nothing is in flight).
        _summaryCacheVersions.delete(id);
        evicted++;
    }
    return evicted;
}

const _deleteHeartbeat = deleteHeartbeat;

// ── 150 ms debounce window ────────────────────────────────────────────────────
// Multiple tool-result writes within a turn collapse to one tmp+rename per
// session. The timer is unref'd so it never keeps the process alive.
const _debounceTimers = new Map(); // id → NodeJS.Timeout
function _clearDebounce(id) {
    const t = _debounceTimers.get(id);
    if (t) { clearTimeout(t); _debounceTimers.delete(id); }
}

// Self-registered exit drain; bare 'exit' hook stays as idempotent backup. Use the more comprehensive
// drainSessionStore so debounce + scheduled + writing payloads all flush.
process.on('exit', drainSessionStore);

/**
 * Persist a session. `opts.expectedGeneration` guards against resurrecting a
 * session that was closed mid-flight: before the rename, we re-read the file
 * on disk and, if it's already marked closed with a >= generation, drop the
 * write. There is NO bypass of the canonical ownership check — the lifecycle
 * barriers (markSessionClosed / bumpSessionGeneration) write their tombstone
 * directly, under their own authority read, so no save path needs one.
 */
export function saveSession(session, opts) {
    _ensureLifecycleFields(session);
    const id = session.id;
    // PRE-ADMISSION for EVERY entry mode (sync, immediate, debounced): a
    // foreign/ambiguous/unreadable canonical record is never cached as locally
    // owned, not even transiently, so this runs BEFORE setLiveSession and the
    // optimistic summary row. True absence stays creatable.
    const refusal = _sessionWriteAuthorityRefusal(id);
    // A refused record publishes NOTHING: no live snapshot, no optimistic
    // summary row. The write itself still travels the normal path, where the
    // strict under-lock admission refuses it and produces the established
    // outcome/markers — only the local "owned" caches are never touched.
    if (!refusal) {
        setLiveSession(session);
        _publishLiveSession(session);
    }
    const summaryVersion = refusal ? null : _cacheSessionSummary(session);
    // Identity of THIS attempt: only a landed save at least this new may clear
    // the id's failure/drop markers (see live-state _clearSaveStateIfCurrent),
    // and a write older than what already landed may not commit at all (the
    // epoch travels inside the write guard, so the worker realm sees it too).
    const epoch = _nextSaveEpoch();
    // Incarnation of the id at ISSUE time: a hard delete (or a re-created id)
    // makes this payload's markers inert on settlement.
    const incarnation = _acquireSessionIncarnation(id);
    const payload = {
        session,
        opts: _guardedSaveOptions(id, opts, epoch),
        summaryVersion,
        epoch,
        // `incarnation` is the releasable OWNERSHIP reference; `settlement` is
        // the immutable identity a late settlement proves membership with.
        incarnation,
        settlement: incarnation,
    };
    // Synchronous durability path — explicit flush (tombstones, drain hooks).
    // createSession uses async debounced save + _liveSessions for same-process
    // read-your-writes; sync remains for callers that require immediate disk.
    if (opts?.sync) {
        try {
            if (_doSaveSync(payload) !== SAVE_OUTCOME_SAVED) _rollbackCachedSessionSummary(id, summaryVersion);
        } catch (err) {
            _rollbackCachedSessionSummary(id, summaryVersion);
            throw err;
        }
        return;
    }
    // Immediate-flush override: tombstone plants and explicit flushes skip the
    // debounce so close-session writes are always durable.
    if (opts?.immediate) {
        _clearDebounce(id);
        const pending = _savePending.get(id);
        if (pending) {
            if (pending.writing) {
                _releasePayloadIncarnation(pending.queued);
                _savePending.set(id, { ...pending, queued: payload });
            } else {
                _releasePayloadIncarnation(pending.payload);
                _savePending.set(id, { ...pending, payload });
                _flushScheduled(id);
            }
        } else {
            _savePending.set(id, { writing: true, payload });
            _doSave(payload).then((outcome) => {
                if (outcome !== SAVE_OUTCOME_SAVED) _rollbackCachedSessionSummary(id, summaryVersion);
            }).catch(err => {
                _rollbackCachedSessionSummary(id, summaryVersion);
                _recordAsyncSaveError(id, payload, err);
            });
        }
        return;
    }
    const pending = _savePending.get(id);
    if (pending) {
        if (pending.writing) {
            // Write in flight — overwrite the queued slot. Multiple async
            // saves for the same id while one is on disk collapse into a
            // single follow-up write.
            _releasePayloadIncarnation(pending.queued);
            _savePending.set(id, { ...pending, queued: payload });
        } else if (pending.scheduled) {
            // setImmediate already scheduled — coalesce into the same tick
            // by overwriting the pending payload with the latest state.
            _releasePayloadIncarnation(pending.payload);
            _savePending.set(id, { scheduled: true, payload });
        } else if (pending.debouncing) {
            // 150 ms debounce window active — overwrite payload, timer keeps running.
            _releasePayloadIncarnation(pending.payload);
            _savePending.set(id, { debouncing: true, payload });
        }
        return;
    }
    // First save for this id — open a 150 ms debounce window.  Any additional
    // calls within the window overwrite the payload; only one tmp+rename fires.
    // The setImmediate inside the timeout body provides the original coalescing
    // guarantee within the same event-loop tick at the moment the timer fires.
    _savePending.set(id, { debouncing: true, payload });
    const t = setTimeout(() => {
        _debounceTimers.delete(id);
        const cur = _savePending.get(id);
        if (!cur || !cur.debouncing) return; // already handled (writing/queued)
        _savePending.set(id, { scheduled: true, payload: cur.payload });
        setImmediate(() => _flushScheduled(id));
    }, 150);
    if (t.unref) t.unref();
    _debounceTimers.set(id, t);
}

function _flushScheduled(id) {
    const cur = _savePending.get(id);
    if (!cur || !cur.scheduled) return;
    _savePending.set(id, { writing: true, payload: cur.payload });
    _doSave(cur.payload).then((outcome) => {
        if (outcome !== SAVE_OUTCOME_SAVED) _rollbackCachedSessionSummary(id, cur.payload.summaryVersion);
    }).catch(err => {
        _rollbackCachedSessionSummary(id, cur.payload.summaryVersion);
        _recordAsyncSaveError(id, cur.payload, err);
    });
}


/**
 * Exported for save-session-worker — not part of the public API.
 * External callers should use saveSession / saveSessionAsync.
 * Returns a SAVE_OUTCOME_* reason, never a bare boolean: the worker relays it
 * so the parent can tell an ownership drop from a stale-epoch refusal.
 */
export function _saveSessionSync(session, opts, options = {}) {
    _ensureLifecycleFields(session);
    // The worker realm mints no identity of its own: the authoritative epoch
    // arrives with the guard the parent stamped.
    const guardEpoch = opts?._sessionWriteGuard?.epoch;
    return _doSaveSync({
        session,
        opts: opts || null,
        // A caller that already owns the snapshot's identity (the exit drain)
        // passes it through; minting a fresh epoch there would make an OLD
        // snapshot look like the newest attempt and let it clear markers.
        epoch: Number.isFinite(options.epoch)
            ? options.epoch
            : (Number.isFinite(guardEpoch) ? guardEpoch : _nextSaveEpoch()),
        commitTimeoutMs: options.commitTimeoutMs,
        // Own reference to the id's current incarnation (released by
        // _doSaveSync): a hard delete during this write makes its markers
        // inert without affecting anybody else's stamp.
        incarnation: _acquireSessionIncarnation(session.id),
    });
}

function _doSaveSync(payload) {
    const { session, opts, summaryVersion = null, epoch = null, commitTimeoutMs = null, incarnation = null } = payload;
    const id = session.id;
    // Settlement identity is IMMUTABLE and separate from the (releasable)
    // ownership reference: purging may null the ref, but a late settlement
    // must still be able to prove which incarnation it belonged to.
    const settlement = payload.settlement ?? incarnation;
    const mayMutate = () => _isCurrentSessionIncarnation(id, settlement);
    // EVERY exit — stale, drop, refusal, success, throw — releases the
    // ownership reference exactly once through this finally.
    try {
    // A newer write for this id already landed: committing these bytes would
    // REVERT durable history. Refuse before any scratch file is written and
    // before any marker is touched (no failure, no drop — nothing was lost).
    if (_isStaleWriteEpoch(opts)) return SAVE_OUTCOME_STALE;
    if (_shouldDrop(id, opts)) {
        if (mayMutate()) _recordSaveDrop(id, epoch);
        return SAVE_OUTCOME_DROPPED;
    }
    const target = sessionPath(id);
    const tmp = _trackSaveTmp(target + '.' + randomBytes(6).toString('hex') + '.tmp');
    // The EXACT bytes this attempt tried to commit; failure evidence is
    // rebuilt from them, never re-read from the later mutable live session.
    let attempted = null;
    try {
        attempted = JSON.stringify(_sessionForDisk(session));
        writeFileSync(tmp, attempted, 'utf-8');
        if (_shouldDrop(id, opts)) {
            _discardSaveTmp(tmp);
            if (mayMutate()) _recordSaveDrop(id, epoch);
            return SAVE_OUTCOME_DROPPED;
        }
        const commitControl = _acquireWriteCommit(opts, { timeoutMs: commitTimeoutMs });
        if (commitControl === _WRITE_COMMIT_STALE) {
            // The newer write landed while we waited for the lock.
            _discardSaveTmp(tmp);
            return SAVE_OUTCOME_STALE;
        }
        if (commitControl === _WRITE_COMMIT_TIMEOUT) {
            // Bounded acquisition (exit drain): another realm still holds the
            // rename lock. Surface it as a save failure — canonical file is
            // untouched, the live snapshot stays pinned — instead of blocking
            // process exit on an unbounded wait.
            const busy = new Error(`[session-store] ${id}: commit lock busy after ${commitTimeoutMs}ms`);
            busy.code = 'ECOMMITBUSY';
            throw busy;
        }
        if (commitControl === false || _shouldDrop(id, opts)) {
            _discardSaveTmp(tmp);
            _releaseWriteCommit(commitControl);
            if (mayMutate()) _recordSaveDrop(id, epoch);
            return SAVE_OUTCOME_DROPPED;
        }
        try {
            _commitSessionWrite(tmp, target, id);
            _publishLandedWriteEpoch(opts, epoch);
            _untrackSaveTmp(tmp);
            if (mayMutate()) {
                _queueSessionSummaryUpsert(session, summaryVersion);
                _clearSaveStateIfCurrent(id, epoch);
            }
        } finally {
            _releaseWriteCommit(commitControl);
        }
        return SAVE_OUTCOME_SAVED;
    } catch (err) {
        // The canonical file was never renamed over, so it still holds the
        // last-good session JSON. Flag the id (live snapshot becomes the only
        // good copy of the newest turn), reclaim the scratch file, and rethrow
        // so the caller SEES the failure instead of a silent no-op.
        _discardSaveTmp(tmp);
        // The snapshot is recorded WITH the failure: it is the evidence that
        // lets loadSession serve this exact copy while the canonical file is
        // unreadable (and nothing else may).
        if (mayMutate()) _recordSaveFailure(id, err, epoch, _snapshotFromAttempt(attempted, id));
        throw err;
    }
    } finally {
        _releasePayloadIncarnation(payload);
    }
}

/**
 * Rebuild failure evidence from the EXACT bytes an attempt tried to commit.
 * Never the live session: by settlement time that object may already carry a
 * newer (unattempted) turn, which must not be published as the recovery copy.
 */
function _snapshotFromAttempt(attemptedJson, id) {
    if (typeof attemptedJson !== 'string') return null;
    try {
        const parsed = JSON.parse(attemptedJson);
        return parsed && parsed.id === id ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Write admission for ONE save attempt. Consulted upfront, after the scratch
 * write and again while the commit lock is held, so the final verdict is
 * taken under the lock, immediately before the rename.
 *
 * OWNERSHIP FIRST, freshness second. Every save — guarded or not — must find
 * OUR record (or nothing) at the canonical path:
 *   absent                        → this write creates the file;
 *   ambiguous/unreadable          → refuse (never "open at generation 0");
 *   foreign / identity-less id    → refuse, with or without a generation
 *                                   guard: an ordinary appendMessage save
 *                                   must not rename over another session's
 *                                   record just because it carries no
 *                                   expectedGeneration;
 *   ours                          → apply the generation rules below.
 * NOTHING is exempt. The old `allowClosed` opt-out is gone: it existed for a
 * tombstone plant that has not gone through this path in a long time (the
 * barriers write the canonical file themselves), and any surviving caller of
 * it would have been able to skip the absent-vs-owned-vs-ambiguous check
 * entirely — the exact hole this guard exists to close.
 */
function _shouldDrop(id, opts) {
    if (_isCancelledWrite(opts)) return true;
    const expected = typeof opts?.expectedGeneration === 'number' ? opts.expectedGeneration : null;
    const target = sessionPath(id);
    let record;
    try {
        record = _readCanonicalRecord(target);
    } catch {
        // The guard could not establish WHAT is on disk. Refusing the write is
        // the only safe verdict: the alternative renames over a record whose
        // ownership/tombstone state is unknown.
        return true;
    }
    // Ambiguous/corrupt record (duplicate top-level lifecycle keys, malformed
    // JSON, unreadable file that nonetheless exists). It must NEVER be read as
    // "open at generation 0" — that is precisely the fail-open that lets a
    // late save resurrect a session over an ambiguous tombstone. Drop.
    if (record === LIFECYCLE_AMBIGUOUS) return true;
    if (!record) return false; // no file on disk → this save creates it
    // Durable identity is mandatory, exactly as for every other authority
    // read: a record naming another session (or naming none at all) is not
    // ours to overwrite.
    if (record.id !== id) return true;
    if (expected === null) return false; // unguarded save over our own record
    const generation = typeof record.generation === 'number' ? record.generation : 0;
    // Closed with a generation at least as new as ours: our write is stale.
    if (record.closed === true) return generation >= expected;
    // Not closed, but `generation` also doubles as an ownership counter:
    // normal in-place saves (updateSession/appendMessage/etc.) never bump
    // it, only closeSession()-family calls do (markSessionClosed and its
    // non-tombstoning sibling bumpSessionGeneration). So if disk
    // generation is strictly greater than what this write expected,
    // ownership moved on (session was detached-closed and possibly
    // resumed) after our turn started — drop the stale write rather than
    // let it clobber whatever happened after the handoff.
    return generation > expected;
}

// ── Lifecycle read for the ownership guard ───────────────────────────────────
// _shouldDrop consults this up to three times per save (upfront, post-temp
// write, in-commit) and every consult re-reads the file, deliberately: this is
// the input to a DROP decision, and the only cheap identity a memo could key
// on (mtimeMs + size) does NOT move for a same-size rewrite inside one clock
// tick — a generation bump such as 1 → 2 — so a cached lifecycle could hide
// the very ownership move this guard exists to detect.
//
// Three distinct outcomes, never collapsed: `null` = no file (write freely),
// LIFECYCLE_AMBIGUOUS = a file exists but its bytes cannot be trusted (refuse
// the write), otherwise the strict record itself ({ doc, id, closed,
// generation }) — the single disk authority shared by the save guard and the
// lifecycle barriers.
const LIFECYCLE_AMBIGUOUS = Symbol('lifecycle-ambiguous');

function _readCanonicalRecord(target) {
    let raw;
    try {
        raw = readFileSync(target, 'utf-8');
    } catch (err) {
        const code = err?.code;
        // Absence is the ONLY benign read failure. An EACCES/EBUSY/EIO file
        // that exists but cannot be read is ambiguous, not "no tombstone".
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        return LIFECYCLE_AMBIGUOUS;
    }
    // AUTHORITATIVE by construction: a message body can contain literal text
    // like `{"closed":true}` (tool result, pasted JSON) and a duplicate
    // top-level key would be silently last-wins under a plain JSON.parse.
    // readTopLevelLifecycleRecord is the single strict authority; there is no
    // parse fallback to differ from.
    const onDisk = readTopLevelLifecycleRecord(raw);
    if (isLifecycleUnreadable(onDisk)) return LIFECYCLE_AMBIGUOUS;
    return onDisk;
}

// ONE absolute budget for the WHOLE drain: the commit-lock waits and the
// bounded commit acquisitions of every id share it, so exit cost cannot scale
// with the number of contended sessions. Exit must never hang on a stuck
// writer; an id left unflushed is recorded + live-pinned instead.
// Pre-admission authority for the async/worker path (registered here because
// save-worker.mjs cannot import this module back). A refusal keeps the caller
// from publishing ANY owned state — no live snapshot, no optimistic summary.
function _sessionWriteAuthorityRefusal(id) {
    if (!id) return null;
    let authority;
    try {
        authority = _readCanonicalRecord(sessionPath(id));
    } catch {
        // A THROWN authority check is never acceptance: fail closed.
        return 'unreadable';
    }
    if (authority === LIFECYCLE_AMBIGUOUS) return 'ambiguous';
    if (authority && authority.id !== id) return 'foreign';
    return null; // absent (creatable) or ours
}

_setSessionWriteAuthorityCheck(_sessionWriteAuthorityRefusal);

const DRAIN_BUDGET_MS = 400;

/**
 * Sync-flush every pending save on exit.
 *
 * Ordering contract (each step depends on the previous one):
 *   1. collect the NEWEST payload per id across debounce/pending, the worker's
 *      in-flight + latest-wins queued slots and the deferred snapshots, ranked
 *      by the SAVE EPOCH each snapshot was issued with (never by which slot it
 *      happens to sit in: a deferred snapshot can be older than a later sync
 *      or async attempt);
 *   2. CANCEL every one of those ids, invalidating the write guards those
 *      async payloads carry — a worker write still in the queue drops itself
 *      (_shouldDrop) and one already past that check is refused under the lock
 *      by _acquireWriteCommit;
 *   3. retire commits already in progress within the shared deadline;
 *   4. sync-write the newest payload per id with a FRESH guard, under its OWN
 *      epoch and the remaining budget.
 * So no older worker write can rename over the newest state afterwards, and
 * no step can block process exit indefinitely.
 */
export function drainSessionStore() {
    for (const t of _debounceTimers.values()) clearTimeout(t);
    _debounceTimers.clear();
    // ── 1. newest payload per id, by SAVE EPOCH ────────────────────────────
    const newest = new Map(); // id → { session, opts, epoch, revision, ok }
    // Ranked by (epoch, revision). The revision breaks ties WITHIN one
    // issuance identity: an in-flight worker payload and a parked snapshot can
    // share an epoch while the park already holds a NEWER distinct payload
    // (the ref was replaced behind the write). Map/source order must never
    // decide that, and minting a newer epoch here would hand an old snapshot
    // fresh write authority.
    const record = (id, session, opts, epoch, revision) => {
        if (!id || !session) return;
        const issued = Number.isFinite(epoch) ? epoch : 0;
        const rev = Number.isFinite(revision) ? revision : 0;
        const current = newest.get(id);
        if (current && (current.epoch > issued || (current.epoch === issued && current.revision >= rev))) return;
        newest.set(id, { session, opts: opts || null, epoch: issued, revision: rev, ok: false });
    };
    for (const [id, pending] of _savePending) {
        // Both slots are candidates; the payload's own epoch decides, so a
        // `queued` follow-up wins because it is NEWER, not because of its slot.
        record(id, pending.payload?.session, pending.payload?.opts, pending.payload?.epoch, 0);
        record(id, pending.queued?.session, pending.queued?.opts, pending.queued?.epoch, 0);
    }
    for (const [, pending] of _saveWorkerPending) record(pending.id, pending.session, pending.opts, pending.epoch, pending.revision);
    for (const [id, q] of _saveAsyncQueued) record(id, q.session, q.opts, q.epoch, q.revision);
    for (const [, pending] of _deferredSessionSaves) record(pending.session?.id, pending.session, pending.opts, pending.epoch, pending.revision);
    // ── 2/3. cancel, then retire in-flight commits inside ONE deadline ─────
    const deadline = Date.now() + DRAIN_BUDGET_MS;
    const remainingMs = () => Math.max(0, deadline - Date.now());
    for (const id of newest.keys()) _cancelSessionWrites(id);
    for (const id of newest.keys()) {
        const budget = remainingMs();
        if (budget === 0) break; // deadline spent: no further lock waits
        _waitForWriteCommit(id, { timeoutMs: budget });
    }
    // ── 4. write the newest state per id under a FRESH (uncancelled) guard ──
    for (const [id, entry] of newest) {
        try {
            // The commit shares the SAME deadline and keeps the snapshot's own
            // epoch. Once the deadline is spent the budget is 0: an UNCONTENDED
            // id still commits (no wait is needed for a free lock), a contended
            // one is refused immediately — never another lock wait. A refused
            // write fails loudly (recorded + live-pinned) and exit proceeds.
            // The guard carries the snapshot's OWN epoch, so a payload older
            // than what already LANDED is refused instead of reverting disk.
            _saveSessionSync(entry.session, _guardedSaveOptions(id, entry.opts, entry.epoch), {
                epoch: entry.epoch,
                commitTimeoutMs: remainingMs(),
            });
            entry.ok = true;
        } catch (err) {
            process.stderr.write(`[session-store] drain save failed: ${err?.message}\n`);
        }
    }
    for (const [, pending] of _savePending) _releasePendingSlot(pending);
    _savePending.clear();
    // Settle every async waiter: the drain already wrote their newest state,
    // so the promise result is informational (the caller is at process exit).
    // The marker makes this settlement TERMINAL for its owner: the drain took
    // ownership of durability for these ids and cleared their deferred
    // handles, so a receiver must not re-park or retry (that would mint a
    // fresh epoch and could overwrite a save that lands after the drain).
    const _drainErr = new Error('[session-store] drain: worker-queue interrupted by process exit');
    _drainErr.code = 'ESESSIONSTOREDRAINED';
    _drainErr.sessionStoreDrained = true;
    for (const [, pending] of _saveWorkerPending) {
        for (const w of pending.waiters) {
            try { w.reject(_drainErr); } catch { /* best-effort */ }
        }
        // This map is cleared below, so its references are freed here (the
        // worker-side reset then sees an empty map).
        _releaseSessionIncarnation(pending.incarnation);
    }
    for (const [, q] of _saveAsyncQueued) {
        for (const w of q.waiters) {
            try { w.reject(_drainErr); } catch { /* best-effort */ }
        }
    }
    for (const [, pending] of _deferredSessionSaves) {
        const entry = newest.get(pending.session?.id);
        if (entry?.ok) pending.resolve();
        else pending.reject(_drainErr);
        _releaseSessionIncarnation(pending.incarnation);
    }
    _deferredSessionSaves.clear();
    _saveWorkerPending.clear();
    // Also unrefs the worker for writes retired above, so a superseded write
    // can never keep the process alive.
    _resetSaveWorkerBookkeeping();
    // Summary-index ops queued by the writes above: one last best-effort sync
    // flush before exit (losing them is acceptable — the index self-heals).
    try { _flushPendingSummaryOps({ sync: true }); } catch { /* best-effort */ }
    // Last retry of the scratch files THIS realm minted and failed to unlink.
    // `drain` walks the WHOLE registry in bounded chunks (bounded total
    // attempts, one attempt per path) so more than one chunk of orphans cannot
    // survive exit; registry-only, nothing in sessions/ is scanned.
    try { sweepOrphanSessionTmpFiles({ drain: true }); } catch { /* best-effort */ }
}

/**
 * Promote the queued follow-up of the slot THIS payload owns. A stale
 * completion (hard-deleted id, bookkeeping already re-created by a new
 * incarnation) must never promote or clear somebody else's queue, so the slot
 * is matched by payload identity — never by id alone.
 */
function _drainQueue(id, payload = null) {
    const pending = _savePending.get(id);
    if (!pending) return;
    if (payload && pending.payload !== payload && pending.queued !== payload) return;
    if (pending.queued) {
        const next = pending.queued;
        _releasePayloadIncarnation(pending.payload === next ? null : pending.payload);
        _savePending.set(id, { writing: true, payload: next });
        _doSave(next).then((outcome) => {
            if (outcome !== SAVE_OUTCOME_SAVED) _rollbackCachedSessionSummary(id, next.summaryVersion);
        }).catch(err => {
            _rollbackCachedSessionSummary(id, next.summaryVersion);
            _recordAsyncSaveError(id, next, err);
        });
    } else {
        _releasePendingSlot(pending);
        _savePending.delete(id);
    }
}

async function _doSave(payload) {
    const { session, opts, summaryVersion = null, epoch = null, incarnation = null } = payload;
    const id = session.id;
    // Same fences as the sync path, on the IMMUTABLE settlement identity: a
    // delayed failure/drop for a hard-deleted (or re-created) id moves nothing.
    const settlement = payload.settlement ?? incarnation;
    const mayMutate = () => _isCurrentSessionIncarnation(id, settlement);
    // Same freshness fence as the sync path (see _doSaveSync).
    if (_isStaleWriteEpoch(opts)) {
        _releasePayloadIncarnation(payload);
        _drainQueue(id, payload);
        return SAVE_OUTCOME_STALE;
    }
    // First check: upfront, before any disk I/O. Cheap short-circuit when a
    // tombstone is already on disk when the caller arrives.
    if (_shouldDrop(id, opts)) {
        if (mayMutate()) _recordSaveDrop(id, epoch);
        _releasePayloadIncarnation(payload);
        _drainQueue(id, payload);
        return SAVE_OUTCOME_DROPPED;
    }
    const target = sessionPath(id);
    const tmp = _trackSaveTmp(target + '.' + randomBytes(6).toString('hex') + '.tmp');
    // Serialized BEFORE the first await: failure evidence is this exact
    // payload, never the live session as it looks at settlement time.
    let attempted = null;
    try {
        attempted = JSON.stringify(_sessionForDisk(session));
        await fsp.writeFile(tmp, attempted, 'utf-8');
        // Second check: between the temp write and the rename, closeSession()
        // may have planted a tombstone. Re-check on disk; if a newer tombstone
        // now exists, discard our temp file rather than let rename clobber it.
        if (_shouldDrop(id, opts)) {
            _discardSaveTmp(tmp);
            process.stderr.write(`[session-store] ${id}: dropped stale save (tombstone planted during write)\n`);
            if (mayMutate()) _recordSaveDrop(id, epoch);
            _releasePayloadIncarnation(payload);
            _drainQueue(id, payload);
            return SAVE_OUTCOME_DROPPED;
        }
        const commitControl = _acquireWriteCommit(opts);
        if (commitControl === _WRITE_COMMIT_STALE) {
            _discardSaveTmp(tmp);
            _releasePayloadIncarnation(payload);
            _drainQueue(id, payload);
            return SAVE_OUTCOME_STALE;
        }
        if (commitControl === false || _shouldDrop(id, opts)) {
            _discardSaveTmp(tmp);
            _releaseWriteCommit(commitControl);
            if (mayMutate()) _recordSaveDrop(id, epoch);
            _releasePayloadIncarnation(payload);
            _drainQueue(id, payload);
            return SAVE_OUTCOME_DROPPED;
        }
        try {
            _commitSessionWrite(tmp, target, id);
            _publishLandedWriteEpoch(opts, epoch);
            _untrackSaveTmp(tmp);
            if (mayMutate()) {
                _queueSessionSummaryUpsert(session, summaryVersion);
                _clearSaveStateIfCurrent(id, epoch);
            }
        } finally {
            _releaseWriteCommit(commitControl);
        }
        _releasePayloadIncarnation(payload);
        _drainQueue(id, payload);
        return SAVE_OUTCOME_SAVED;
    } catch (err) {
        _discardSaveTmp(tmp);
        if (mayMutate()) {
            _recordSaveFailure(id, err, epoch, _snapshotFromAttempt(attempted, id));
            // Only OUR slot may be cleared: after a delete the id's pending
            // bookkeeping can already belong to a new incarnation.
            const pending = _savePending.get(id);
            if (pending && (pending.payload === payload || pending.queued === payload)) {
                _releasePendingSlot(pending);
                _savePending.delete(id);
            }
        }
        _releasePayloadIncarnation(payload);
        throw err;
    }
}

/**
 * Atomically mark a session closed on disk with a bumped generation.
 * Returns the new generation, or null if the session file doesn't exist.
 * Used by closeSession() to plant a tombstone that races against in-flight
 * saveSession() calls.
 */
function _heartbeatMtime(id) {
    try {
        const path = join(getStoreDir(), `${id}.hb`);
        return existsSync(path) ? (statSync(path).mtimeMs || 0) : 0;
    } catch {
        return 0;
    }
}

function _runtimeLivenessVeto(id, options = {}) {
    return typeof options.isSessionLive === 'function' && options.isSessionLive(id);
}

function _heartbeatLivenessVeto(id, options = {}) {
    const heartbeatMtime = _heartbeatMtime(id);
    if (!(heartbeatMtime > 0)) return false;
    const hasHeartbeatSnapshot = Object.prototype.hasOwnProperty.call(options, 'heartbeatSnapshotMtime');
    const snapshotMtime = Number(options.heartbeatSnapshotMtime) || 0;
    if (hasHeartbeatSnapshot && heartbeatMtime > snapshotMtime) return true;
    const freshMs = Number(options.heartbeatFreshMs);
    return Number.isFinite(freshMs) && freshMs > 0 && Date.now() - heartbeatMtime <= freshMs;
}

function _deleteHeartbeatUnlessNewer(id, options = {}) {
    const hasHeartbeatSnapshot = Object.prototype.hasOwnProperty.call(options, 'heartbeatSnapshotMtime');
    const snapshotMtime = Number(options.heartbeatSnapshotMtime) || 0;
    if (!hasHeartbeatSnapshot || _heartbeatMtime(id) <= snapshotMtime) {
        _deleteHeartbeat(id);
    }
}

// Cancellation truth, single rule: an UNCONFIRMED stop outranks a confirmed
// one, in either direction (already on disk, or requested by this close). A
// cancel whose kill was never proven must never be rewritten as a success —
// not by a re-close, not by an idle sweep, not by a later tombstone rewrite.
const _CANCEL_CLOSE_REASON = /^(?:cli-agent-close(?:-all)?|agent-task-cancel)$/i;
const _CANCEL_UNCONFIRMED_STATUS = /^cancel[-_\s]?(?:unconfirmed|pending)$/i;

function _cleanCancelStatus(value) {
    return String(value || '').trim();
}

function _mergeCancelStatus(existing, requested) {
    const prev = _cleanCancelStatus(existing);
    const next = _cleanCancelStatus(requested);
    if (_CANCEL_UNCONFIRMED_STATUS.test(next) || _CANCEL_UNCONFIRMED_STATUS.test(prev)) return 'cancel-unconfirmed';
    return next || prev || 'cancelled';
}

export function markSessionClosed(id, reason = 'manual', options = {}) {
    // Only a fresh failure from THIS attempt may be observed by closeSession's
    // durable-barrier check — a veto must not surface a stale error.
    clearSessionLifecycleCommitError(id);
    // Caller-provided probes may re-enter the store, so evaluate them before
    // taking the non-reentrant Atomics commit lock. A veto must also precede
    // pending-save cancellation so debounce durability remains intact.
    if (_runtimeLivenessVeto(id, options) || _heartbeatLivenessVeto(id, options)) return null;
    const closeGuard = _guardedSaveOptions(id);
    const commitControl = _acquireWriteCommit(closeGuard);
    if (commitControl === false) return null;
    try {
    // Cross-process heartbeat revival after full-TTL silence is accepted as a
    // best-effort race: the tombstone resurrection guard is the authoritative
    // post-race arbiter. Re-stat here, but never invoke caller code under lock.
    if (_heartbeatLivenessVeto(id, options)) return null;
    // ── Durable authority, read under the commit lock, BEFORE any disruption ──
    // The tombstone rewrites the canonical file, so the bytes it is derived
    // from must be provably ours. A duplicate/ambiguous/foreign/identity-less
    // record is NEVER re-serialized through a lenient parse or replaced from
    // live memory: refuse the barrier and surface the cause, exactly like a
    // failed commit (closeSession must not report a close that never fenced
    // anything).
    const authority = _readCanonicalRecord(sessionPath(id));
    if (authority === LIFECYCLE_AMBIGUOUS || (authority && authority.id !== id)) {
        const err = new Error(`[session-store] ${id}: refusing to close — canonical record is unreadable or foreign`);
        err.code = 'ELIFECYCLEUNREADABLE';
        _recordLifecycleCommitFailure(id, err, reason);
        return null;
    }
    // Only a committed close may disrupt pending persistence.
    _clearDebounce(id);
    _cancelSessionWrites(id);
    _uncacheSessionSummary(id);
    const existing = loadSession(id);
    if (!existing) return null;
    // Re-close idempotence: a session that is ALREADY tombstoned keeps its
    // ORIGINAL close time (updatedAt) and generation. The old code refreshed
    // updatedAt=Date.now() on every call, so the 5-min idle sweep re-closing a
    // stale summary row reset the tombstone age each cycle — tombstones never
    // matured past the sweep threshold (immortality loop). Preserving the
    // original close time lets the age accumulate so the tombstone sweep can
    // reclaim it.
    //
    // The alreadyClosed / original-close-time / generation decision MUST come
    // from the ON-DISK record, read cache-bypassing — NOT from loadSession(),
    // which can serve a stale in-memory OPEN payload (a pending debounced save
    // or a _liveSessions entry) after a late save. Deciding off that stale open
    // copy would make a re-close of an already-tombstoned session look like a
    // FIRST close and reset updatedAt+generation, resurrecting the exact
    // immortality refresh this guard prevents. The disk file is the
    // authoritative tombstone state.
    const onDisk = authority ? authority.doc : null;
    const alreadyClosed = onDisk
        ? (onDisk.closed === true || onDisk.status === 'closed')
        : (existing.closed === true);
    // When the on-disk copy is already closed, base the (idempotent) tombstone
    // rewrite on IT rather than on `existing`, so a stale open in-memory
    // payload can never clobber the persisted tombstone's content/fields.
    const base = (alreadyClosed && onDisk) ? onDisk : existing;
    const closeTime = (alreadyClosed && typeof base.updatedAt === 'number' && base.updatedAt > 0)
        ? base.updatedAt
        : Date.now();
    const newGen = (typeof base.generation === 'number' ? base.generation : 0) + (alreadyClosed ? 0 : 1);
    const tombstone = {
        ...base,
        closed: true,
        closedReason: alreadyClosed ? (base.closedReason || reason) : reason,
        status: 'closed',
        generation: newGen,
        updatedAt: closeTime,
        // Agent cancel/close must survive the worker-index drop: the pool
        // summary reads cancelStatus even when the row is already gone.
        // `options.cancelStatus` is the close path's OWN answer about the kill
        // (see closeSession): an unconfirmed stop must reach disk instead of the
        // default confirmed `cancelled`, and a later re-stamp must never
        // downgrade it.
        ...((_CANCEL_CLOSE_REASON.test(String(reason || '').trim()) || _cleanCancelStatus(options.cancelStatus))
            ? {
                cancelStatus: _mergeCancelStatus(base.cancelStatus, options.cancelStatus),
                cancelledAt: base.cancelledAt || closeTime,
            }
            : {}),
    };
    // Bypass the queue + guard — this IS the tombstone write.
    const target = sessionPath(id);
    const tmp = _trackSaveTmp(target + '.' + randomBytes(6).toString('hex') + '.tmp');
    try {
        writeFileSync(tmp, JSON.stringify(_sessionForDisk(tombstone)), 'utf-8');
        _commitSessionWrite(tmp, target, id);
        _untrackSaveTmp(tmp);
    } catch (err) {
        // The durable lifecycle barrier did NOT land: no tombstone, no
        // generation bump, nothing fencing a late save. Same contract as a
        // failed session save — reclaim the scratch file, pin the live
        // snapshot (non-evictable, not shadowed by the stale disk copy) and
        // publish the cause so closeSession refuses to report success.
        _discardSaveTmp(tmp);
        _recordSaveFailure(id, err, null, existing);
        _recordLifecycleCommitFailure(id, err, reason);
        return null;
    }
    _savePending.delete(id);
    clearSessionSaveError(id);
    _clearLiveSession(id);
    // Preserve a sidecar published strictly after the sweep's scan snapshot.
    _deleteHeartbeatUnlessNewer(id, options);
    _queueSessionSummaryUpsert(tombstone);
    _droppedSaveIds.delete(id);
    // Structured close metric. Single emission point because every close
    // path funnels through markSessionClosed. lifeMs = updatedAt-createdAt
    // straddles the tombstone (updatedAt was just set to Date.now()), so
    // it reflects the session's full lifetime including the close turn.
    try {
        const _dataDir = getPluginData();
        // Emit the close metric only on the FIRST close — a re-close of an
        // already-tombstoned session is a no-op idempotent write and must not
        // spam the close log or double-count lifetimes.
        if (_dataDir && !alreadyClosed) {
            const _ts = new Date().toISOString();
            const _lifeMs = (typeof existing.createdAt === 'number' && existing.createdAt > 0)
                ? (tombstone.updatedAt - existing.createdAt)
                : 0;
            const _agent = existing.agent || '-';
            const _owner = existing.owner || '-';
            const _toolEventsPath = join(_dataDir, 'tool-events.log');
            rotateBoundedLog(_toolEventsPath, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES);
            void fsp.appendFile(
                _toolEventsPath,
                `[${_ts}] [session-close] owner=${_owner} agent=${_agent} reason=${reason} lifeMs=${_lifeMs} id=${id}\n`,
            ).catch(() => {});
        }
    } catch { /* logger never breaks the close path */ }
    return newGen;
    } finally {
        _releaseWriteCommit(commitControl);
    }
}

/**
 * Bump a session's generation WITHOUT planting a closed:true tombstone.
 * Used by closeSession(id, reason, { tombstone: false }) — the runtime side
 * (heartbeat, bash shells, controller, in-memory entry) is detached, but the
 * session file itself stays valid/resumable. The generation bump alone is
 * what protects it from a late save race: any saveSession() still in flight
 * from the detached turn was issued with the OLD generation as its
 * `expectedGeneration`, so once we bump the on-disk generation here, that
 * late write's own _shouldDrop() check (generation-as-ownership-counter
 * rule, see below) sees disk generation > expected and drops itself instead
 * of clobbering whatever the resumed session writes next.
 * Returns the new generation, or null if the session file doesn't exist.
 */
export function bumpSessionGeneration(id, reason = 'detach') {
    clearSessionLifecycleCommitError(id);
    // The detach barrier is a canonical write and MUST take the same commit
    // lock as markSessionClosed. Cancellation alone is not a barrier: a writer
    // that already passed its cancellation check can still be holding (or
    // about to take) the rename lock, and would then land AFTER the generation
    // bump — exactly the late-save clobber this function exists to prevent.
    // Holding the lock serialises it before us; taking it after cancellation
    // makes _acquireWriteCommit refuse it (it re-checks cancellation while
    // holding the lock).
    const detachGuard = _guardedSaveOptions(id);
    const commitControl = _acquireWriteCommit(detachGuard);
    if (commitControl === false) return null;
    try {
        // Same durable authority as the tombstone barrier: the detach write
        // replaces the canonical file, so unreadable/ambiguous/foreign bytes
        // are refused (and surfaced) instead of rewritten from memory.
        const authority = _readCanonicalRecord(sessionPath(id));
        if (authority === LIFECYCLE_AMBIGUOUS || (authority && authority.id !== id)) {
            const err = new Error(`[session-store] ${id}: refusing to detach — canonical record is unreadable or foreign`);
            err.code = 'ELIFECYCLEUNREADABLE';
            _recordLifecycleCommitFailure(id, err, reason);
            return null;
        }
        // Only a VALIDATED barrier may disrupt pending persistence: on an
        // ambiguous/foreign refusal above the debounced save stays scheduled
        // and usable.
        _clearDebounce(id);
        _cancelSessionWrites(id);
        _uncacheSessionSummary(id);
        const existing = loadSession(id);
        if (!existing) return null;
        const newGen = (typeof existing.generation === 'number' ? existing.generation : 0) + 1;
        const detached = { ...existing, generation: newGen, updatedAt: Date.now(), detachedReason: reason };
        const target = sessionPath(id);
        const tmp = _trackSaveTmp(target + '.' + randomBytes(6).toString('hex') + '.tmp');
        try {
            writeFileSync(tmp, JSON.stringify(_sessionForDisk(detached)), 'utf-8');
            _commitSessionWrite(tmp, target, id);
            _untrackSaveTmp(tmp);
        } catch (err) {
            // Detach barrier failed — identical contract to the tombstone path.
            _discardSaveTmp(tmp);
            _recordSaveFailure(id, err, null, existing);
            _recordLifecycleCommitFailure(id, err, reason);
            return null;
        }
        _savePending.delete(id);
        clearSessionSaveError(id);
        _clearLiveSession(id);
        _deleteHeartbeat(id);
        _queueSessionSummaryUpsert(detached);
        _droppedSaveIds.delete(id);
        return newGen;
    } finally {
        _releaseWriteCommit(commitControl);
    }
}

export function loadSession(id) {
    const path = sessionPath(id);
    // An existing file owns this identity. Its contents must validate before
    // fresher in-memory state is allowed to shadow it. Unchanged atomic files
    // reuse their recent parsed object instead of reparsing the full transcript.
    const disk = _readStoredSessionCached(id, path);
    // Read-your-writes: if a save is pending (debouncing, scheduled, or queued
    // behind an in-flight write) return that payload instead of stale disk state.
    // The most-recently-queued slot is checked first (queued > payload).
    const pending = _savePending.get(id);
    if (disk.exists && !disk.session) {
        // An existing-but-unreadable file OWNS the identity: an externally
        // corrupted, foreign, ambiguous or half-written file from another
        // writer is REPORTED (null), never masked by whatever this process
        // happens to hold in memory.
        //
        // Exactly ONE exception, and it is evidence-based rather than
        // state-based: the snapshot whose OWN write to this path failed in
        // this process (getFailedSaveSnapshot). That failure proves the bytes
        // never landed, so this copy is strictly newer than the file and is
        // the only good same-process copy — hiding it would turn a surfaced
        // save failure into silent session loss for every public reader.
        // A generic pending payload / _liveSessions entry proves nothing about
        // disk and may NOT stand in: unrelated corruption stays visible.
        // Lifecycle and pending-ownership authorities do not come through
        // here at all (they read the durable record directly), so they keep
        // seeing 'unreadable' and failing closed.
        const recovered = getFailedSaveSnapshot(id);
        if (recovered?.id === id) return _ensureLifecycleFields(recovered);
        return null;
    }
    const stored = disk.session;
    if (pending) {
        const inMemory = (pending.queued || pending.payload)?.session;
        if (inMemory?.id === id) return _ensureLifecycleFields(inMemory);
    }
    const live = _liveSessions.get(id);
    if (live?.id === id) {
        // Terminal ↔ desktop interop: `generation` only moves on close/detach
        // (markSessionClosed / bumpSessionGeneration). A disk record with a
        // HIGHER generation means another process took ownership of this
        // session after our snapshot was cached — the local copy is stale and
        // must not shadow the newer on-disk transcript (its late saves would
        // be dropped by _shouldDrop's ownership rule anyway).
        const liveGen = typeof live.generation === 'number' ? live.generation : 0;
        const storedGen = stored && typeof stored.generation === 'number' ? stored.generation : 0;
        // A flagged dropped save means the generation moved WITHOUT newer
        // content landing (detach re-persists stale content) — the local
        // snapshot is the only complete transcript, so it keeps winning.
        if (stored && storedGen > liveGen && !_droppedSaveIds.has(id)) {
            _liveSessions.delete(id);
        } else {
            return _ensureLifecycleFields(live);
        }
    }
    return stored ? _ensureLifecycleFields(stored) : null;
}

/** Strictly enumerate child-agent session files linked to one visible parent.
 * Used only by explicit parent deletion; ordinary close/context switches keep
 * the relationship intact. */
export function listOwnedAgentSessionIds(ownerSessionId) {
    const ownerId = String(ownerSessionId || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(ownerId)) return [];
    const dir = getStoreDir();
    if (probePath(dir).state !== PROBE_PRESENT) return [];
    let files;
    try {
        files = readdirSync(dir).filter((file) => file.endsWith('.json'));
    } catch {
        return [];
    }
    const ids = [];
    for (const file of files) {
        const candidateId = file.slice(0, -5);
        if (!candidateId || candidateId === ownerId || !/^[A-Za-z0-9_-]+$/.test(candidateId)) continue;
        try {
            const record = readTopLevelLifecycleRecord(readFileSync(join(dir, file), 'utf8'));
            if (isLifecycleUnreadable(record) || record.id !== candidateId) continue;
            const session = record.doc;
            if (!isAgentOwner(session)) continue;
            const linkedOwner = String(session.ownerSessionId || session.parentSessionId || '').trim();
            if (linkedOwner === ownerId) ids.push(candidateId);
        } catch { /* unreadable/vanished records are never deletion targets */ }
    }
    return ids;
}


export function deleteSession(id, options = {}) {
    // Keep caller probes and all vetoes ahead of the non-reentrant lock and
    // ahead of pending-save disruption, matching markSessionClosed().
    if (_runtimeLivenessVeto(id, options) || _heartbeatLivenessVeto(id, options)) return false;
    const deleteGuard = _guardedSaveOptions(id);
    const commitControl = _acquireWriteCommit(deleteGuard);
    if (commitControl === false) return false;
    try {
    // Cross-process revival after full-TTL silence remains best-effort; the
    // tombstone resurrection guard is authoritative. Only re-stat .hb here.
    if (_heartbeatLivenessVeto(id, options)) return false;
    // ── 1. unlink FIRST, still holding the commit lock ─────────────────────
    // A failed unlink is NOT a delete: the canonical bytes are still there, so
    // nothing may be purged, cancelled or closed — every pending write, parked
    // snapshot and metrics timer stays usable and persistable.
    const path = sessionPath(id);
    const probe = probePath(path);
    // An unreadable probe is NOT absence: purging markers/pending state while
    // the canonical bytes survive would strand a live session behind a file
    // nobody owns any more. Nothing was deleted, so report exactly that.
    if (probe.state !== PROBE_PRESENT && probe.state !== PROBE_ABSENT) return false;
    // CONTRACT: an ABSENT canonical record is a SUCCESSFUL (idempotent)
    // delete — the session does not exist once this call returns, so the id's
    // local state is purged and `true` is reported. `false` is reserved for
    // "nothing was deleted AND nothing was mutated": a liveness veto, a
    // contended commit lock, an unreadable probe, ambiguous/foreign bytes, or
    // a failed unlink.
    let removed = false; // diagnostics only: whether canonical bytes were unlinked
    if (probe.state === PROBE_PRESENT) {
        // STRICT OWNERSHIP AT THE COMMIT EDGE. The bytes are re-read here,
        // under the same commit lock, immediately before the unlink — not
        // inferred from the earlier stat, and not from any cache: between the
        // probe and this read another process can rename a different session's
        // record (or a torn write) onto this path, and an unlink is
        // irreversible. Ambiguous/foreign bytes are therefore never deleted.
        const record = _readCanonicalRecord(path);
        if (record === LIFECYCLE_AMBIGUOUS) return false;
        if (record !== null) {
            if (record.id !== id) return false;
            try {
                unlinkSync(path);
                removed = true;
            } catch {
                return false; // canonical file survives → nothing was deleted
            }
        }
        // record === null: the file vanished inside this window — fall through
        // to the absent contract (nothing removed, local state still purged).
    }
    // ── 2. finalize UNDER THE SAME LOCK ────────────────────────────────────
    // The file is gone. Cancellation + purge happen before the lock is
    // released, so a writer waiting for the lock is refused by its own
    // cancellation re-check instead of renaming the file back, and no parked
    // snapshot, timer or deferred entry survives to resurrect it.
    // Retire the id's incarnation: every write, queued payload and parked
    // snapshot stamped BEFORE this point becomes permanently non-current, so
    // its settlement moves no marker and touches no bookkeeping — and a
    // re-created id gets a brand new incarnation of its own.
    _retireSessionIncarnation(id);
    _cancelSessionWrites(id);
    _clearDebounce(id);
    _releasePendingSlot(_savePending.get(id));
    _savePending.delete(id);
    _purgeSessionSaveBookkeeping(id);
    _runSessionPurgeHooks(id);
    // Preserve a sidecar published strictly after the sweep's scan snapshot.
    _deleteHeartbeatUnlessNewer(id, options);
    deleteSessionPresence(id);
    _clearLiveSession(id);
    // The file is gone: every marker of the retired incarnation goes with it
    // (save error + failed-snapshot evidence, split-brain drop flag, lifecycle
    // commit error), so a re-created id starts clean.
    _clearSessionSaveState(id);
    clearSessionLifecycleCommitError(id);
    // deferSummaryUpdate: bulk callers (tombstone sweep) remove thousands of
    // rows — a per-id _removeSessionSummary would parse+rewrite the multi-MB
    // summary index once PER DELETION. They batch the index update themselves.
    if (options.deferSummaryUpdate === true) _uncacheSessionSummary(id);
    else _queueSessionSummaryRemoval(id);
    // Both PRESENT-and-unlinked and ABSENT reach here: the session is gone.
    return true;
    } finally {
        _releaseWriteCommit(commitControl);
    }
}

// Listing / summaries / stale sweeping live in store/listing.mjs; re-exported
// here so importers keep one session-store entry point.
export {
    listStoredSessions,
    listStoredSessionSummaries,
    getStoredSessionsRaw,
    sweepStaleSessions,
    sweepStaleSessionsCooperative,
} from './store/listing.mjs';
export { _savePending };
