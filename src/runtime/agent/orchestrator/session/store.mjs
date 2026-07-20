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
import { scanTopLevelLifecycle } from './lifecycle-scan.mjs';
import { rotateBoundedLog, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../../../../lib/mixdog-debug.cjs';
import { resolveAgentTerminalReapMs } from '../../../../session-runtime/config-helpers.mjs';
import { getStoreDir, sessionPath, publishHeartbeat, deleteHeartbeat } from './store/paths-heartbeat.mjs';
import {
    guardedSaveOptions as _guardedSaveOptions,
    cancelSessionWrites as _cancelSessionWrites,
    isCancelledWrite as _isCancelledWrite,
    acquireWriteCommit as _acquireWriteCommit,
    releaseWriteCommit as _releaseWriteCommit,
    waitForWriteCommit as _waitForWriteCommit,
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
export { publishHeartbeat, deleteHeartbeat } from './store/paths-heartbeat.mjs';

const _lastSaveError = new Map(); // id -> { message, at }

// Listing is much hotter than writing, especially while the desktop session
// browser is open. Keep the compact sidecar in memory after the first read;
// local durability mutations update this cache synchronously, while an
// explicit refresh remains the authoritative cross-process/disk reconciliation
// path. Pending overlays cover a write that lands before the first listing.
let _summaryRowsCache = null;
const _summaryCacheUpserts = new Map();
const _summaryCacheRemovals = new Set();
const _summaryCacheVersions = new Map();
let _summaryCacheDataDir = null;

function _ensureSummaryCacheDataDir() {
    const dataDir = getPluginData();
    if (_summaryCacheDataDir === dataDir) return;
    _summaryCacheDataDir = dataDir;
    _summaryRowsCache = null;
    _summaryScanCache.clear();
    _summaryCacheUpserts.clear();
    _summaryCacheRemovals.clear();
    _summaryCacheVersions.clear();
}

function _summaryRowsWithLocalMutations(rows, { discardLocalMutations = false } = {}) {
    if (discardLocalMutations) {
        _summaryCacheUpserts.clear();
        _summaryCacheRemovals.clear();
    }
    const byId = new Map(_normalizeSummaryIndex({ rows }).rows.map((row) => [row.id, row]));
    for (const id of _summaryCacheRemovals) byId.delete(id);
    for (const [id, row] of _summaryCacheUpserts) byId.set(id, row);
    return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function _setSummaryRowsCache(rows, options) {
    if (options?.discardLocalMutations === true) {
        _summaryCacheUpserts.clear();
        _summaryCacheRemovals.clear();
    }
    _summaryRowsCache = _normalizeSummaryIndex({ rows }).rows;
    return _summaryRowsWithLocalMutations(_summaryRowsCache);
}

function _cachedSummaryRows() {
    return _summaryRowsCache === null ? null : _summaryRowsWithLocalMutations(_summaryRowsCache);
}

function _setCachedBaseSummary(row) {
    if (!row || _summaryRowsCache === null) return;
    const byId = new Map(_summaryRowsCache.map((existing) => [existing.id, existing]));
    byId.set(row.id, row);
    _summaryRowsCache = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function _removeCachedBaseSummary(id) {
    if (_summaryRowsCache === null) return;
    _summaryRowsCache = _summaryRowsCache.filter((row) => row.id !== id);
}

function _cacheSessionSummary(session) {
    _ensureSummaryCacheDataDir();
    const row = _sessionSummary(session);
    if (!row) return;
    _summaryCacheVersions.set(row.id, (_summaryCacheVersions.get(row.id) || 0) + 1);
    _summaryCacheRemovals.delete(row.id);
    _summaryCacheUpserts.set(row.id, row);
    return _summaryCacheVersions.get(row.id);
}

function _uncacheSessionSummary(id) {
    _ensureSummaryCacheDataDir();
    if (!id) return;
    _summaryCacheVersions.set(id, (_summaryCacheVersions.get(id) || 0) + 1);
    _summaryCacheUpserts.delete(id);
    _summaryCacheRemovals.add(id);
    _removeCachedBaseSummary(id);
}

function _rollbackCachedSessionSummary(id, version) {
    if ((_summaryCacheVersions.get(id) || 0) !== version) return;
    _summaryCacheUpserts.delete(id);
}

function _queueSessionSummaryUpsert(session, version = null) {
    const row = _sessionSummary(session);
    if (!row) return;
    _setCachedBaseSummary(row);
    if (version === null || (_summaryCacheVersions.get(row.id) || 0) === version) {
        _summaryCacheUpserts.delete(row.id);
        _summaryCacheRemovals.delete(row.id);
    }
    _upsertSessionSummary(session);
}

function _queueSessionSummaryRemoval(id) {
    _uncacheSessionSummary(id);
    _removeSessionSummary(id);
}

function _queueSummaryIndexPrune(ids) {
    for (const id of ids) _uncacheSessionSummary(id);
    _pruneSummaryIndexIds(ids);
}

// The live in-memory session (and every model request)
// retains attached image bytes across turns so multi-turn recognition works.
// The persisted session JSON, however, replaces image content with a short
// text placeholder at serialization time — keeping session files small without
// starving the model of the image mid-conversation. Returns the same object
// reference when nothing changed (no-image sessions pay only a shallow scan).
function _sessionForDisk(session) {
    // Strip transient in-flight aliases askSession sets for the turn duration:
    //  - liveTurnMessages: live working transcript (so contextStatus() can
    //    estimate live context growth) — a duplicate of the working transcript
    //    that must never be serialized (mid-turn saves would bloat the file and
    //    persist a non-canonical message array).
    //  - toolApprovalHook: the askOpts.onToolApproval callback wired for the
    //    turn — a function that must never be serialized.
    const hasTransient = session && typeof session === 'object'
        && (Object.prototype.hasOwnProperty.call(session, 'liveTurnMessages')
            || Object.prototype.hasOwnProperty.call(session, 'toolApprovalHook'));
    const messages = Array.isArray(session?.messages) ? session.messages : null;
    if (!messages || messages.length === 0) {
        if (!hasTransient) return session;
        const { liveTurnMessages: _dropLTM, toolApprovalHook: _dropTAH, ...rest } = session;
        return rest;
    }
    let changed = false;
    const out = messages.map((m) => {
        if (!m || typeof m !== 'object') return m;
        const content = sanitizeContentForStoredHistory(m.content);
        if (content !== m.content) { changed = true; return { ...m, content }; }
        return m;
    });
    if (!changed) {
        if (!hasTransient) return session;
        const { liveTurnMessages: _dropLTM, toolApprovalHook: _dropTAH, ...rest } = session;
        return rest;
    }
    const { liveTurnMessages: _dropLTM, toolApprovalHook: _dropTAH, ...rest } = session;
    return { ...rest, messages: out };
}

function _renameWithRetrySync(tmp, target) {
    return renameWithRetrySync(tmp, target);
}

/**
 * Ensure generation/closed defaults on every session object.
 * Older persisted sessions predate these fields; we normalise at load and save.
 */
function _ensureLifecycleFields(session) {
    if (typeof session.generation !== 'number') session.generation = 0;
    if (typeof session.closed !== 'boolean') session.closed = false;
    if (!Array.isArray(session.messages)) session.messages = [];
    if (!Array.isArray(session.tools)) session.tools = [];
    return session;
}

/** Module-level map tracking in-flight saves per session ID to prevent concurrent write corruption. */
const _savePending = new Map();

/** Same-process authoritative session snapshots (createSession → loadSession / askSession). */
const _liveSessions = new Map();

export function setLiveSession(session) {
    if (!session?.id) return;
    _liveSessions.set(session.id, session);
}

function _clearLiveSession(id) {
    if (id) _liveSessions.delete(id);
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

// Live snapshots that still carry raw media bytes (images are placeholder'd
// in the persisted JSON) stay resident for this long after their last use so
// multi-turn image recognition keeps working across an idle gap. Beyond the
// TTL the memory cost wins and the snapshot is reclaimed like any other.
const LIVE_MEDIA_RETENTION_MS = 60 * 60 * 1000; // 1h

function _messagesCarryLiveMedia(messages) {
    if (!Array.isArray(messages)) return false;
    for (const m of messages) {
        if (!m || typeof m !== 'object') continue;
        if (sanitizeContentForStoredHistory(m.content) !== m.content) return true;
    }
    return false;
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
        if (!existsSync(sessionPath(id))) continue;
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
 * write. `opts.allowClosed=true` is used by `markSessionClosed` itself when
 * writing the tombstone.
 */
export function saveSession(session, opts) {
    _ensureLifecycleFields(session);
    const id = session.id;
    setLiveSession(session);
    const summaryVersion = _cacheSessionSummary(session);
    const payload = { session, opts: _guardedSaveOptions(id, opts), summaryVersion };
    // Synchronous durability path — explicit flush (tombstones, drain hooks).
    // createSession uses async debounced save + _liveSessions for same-process
    // read-your-writes; sync remains for callers that require immediate disk.
    if (opts?.sync) {
        try {
            if (!_doSaveSync(payload)) _rollbackCachedSessionSummary(id, summaryVersion);
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
                _savePending.set(id, { ...pending, queued: payload });
            } else {
                _savePending.set(id, { ...pending, payload });
                _flushScheduled(id);
            }
        } else {
            _savePending.set(id, { writing: true, payload });
            _doSave(payload).then((saved) => {
                if (!saved) _rollbackCachedSessionSummary(id, summaryVersion);
            }).catch(err => {
                _rollbackCachedSessionSummary(id, summaryVersion);
                process.stderr.write(`[session-store] save failed: ${err?.message}\n`);
                _lastSaveError.set(id, { message: err?.message ?? String(err), at: Date.now() });
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
            _savePending.set(id, { ...pending, queued: payload });
        } else if (pending.scheduled) {
            // setImmediate already scheduled — coalesce into the same tick
            // by overwriting the pending payload with the latest state.
            _savePending.set(id, { scheduled: true, payload });
        } else if (pending.debouncing) {
            // 150 ms debounce window active — overwrite payload, timer keeps running.
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
    _doSave(cur.payload).then((saved) => {
        if (!saved) _rollbackCachedSessionSummary(id, cur.payload.summaryVersion);
    }).catch(err => {
        _rollbackCachedSessionSummary(id, cur.payload.summaryVersion);
        process.stderr.write(`[session-store] save failed: ${err?.message}\n`);
        _lastSaveError.set(id, { message: err?.message ?? String(err), at: Date.now() });
    });
}

// ── Worker-thread async save ──────────────────────────────────────────────────
// Single long-lived Worker serializes all saveSessionAsync calls.
// The worker's message queue preserves generation-race ordering.
let _saveWorker = null;
// In-flight writes, keyed by reqId. Value: { id, session, opts, waiters:[{resolve,reject}] }.
// At most ONE entry per session id at a time (single-in-flight-per-id).
let _saveWorkerPending = new Map();
// Latest-wins queued payload per session, keyed by id. Value: { session, opts, waiters:[] }.
// At most ONE queued write per id: a newer saveSessionAsync while a write is in
// flight overwrites session/opts here and appends its resolver to waiters, so
// every superseded caller resolves when this single queued write finally lands.
let _saveAsyncQueued = new Map();
// id → reqId of the in-flight write for that id (enforces one-in-flight-per-id).
let _saveAsyncInflight = new Map();
let _saveWorkerReqId = 0;
let _saveWorkerRefCount = 0;
let _deferredSaveReqId = 0;
const _deferredSessionSaves = new Map();

function _getOrSpawnWorker() {
    if (_saveWorker) return _saveWorker;
    _saveWorker = new Worker(new URL('./save-session-worker.mjs', import.meta.url), {
        execArgv: [],
        // Worker-thread stdout/stderr default to COPYING into the process's
        // real fds, bypassing the TUI's process.stderr.write guard and
        // printing over the terminal frame. Capture both and route through the
        // parent's (guardable) stderr stream instead.
        stdout: true,
        stderr: true,
    });
    _saveWorker.stdout?.on('data', (chunk) => { try { process.stderr.write(chunk); } catch { /* best-effort */ } });
    _saveWorker.stderr?.on('data', (chunk) => { try { process.stderr.write(chunk); } catch { /* best-effort */ } });
    _saveWorker.on('message', ({ ok, saved, error, reqId }) => {
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
            if (saved) _queueSessionSummaryUpsert(session, summaryVersion);
            else _rollbackCachedSessionSummary(id, summaryVersion);
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
function _postAsyncWrite(id, session, opts, waiters, summaryVersion) {
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

/**
 * Exported for save-session-worker — not part of the public API.
 * External callers should use saveSession / saveSessionAsync.
 */
export function _saveSessionSync(session, opts) {
    _ensureLifecycleFields(session);
    return _doSaveSync({ session, opts: opts || null });
}

function _doSaveSync(payload) {
    const { session, opts, summaryVersion = null } = payload;
    const id = session.id;
    if (_shouldDrop(id, opts)) return false;
    const target = sessionPath(id);
    const tmp = target + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        writeFileSync(tmp, JSON.stringify(_sessionForDisk(session)), 'utf-8');
        if (_shouldDrop(id, opts)) {
            try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
            return false;
        }
        const commitControl = _acquireWriteCommit(opts);
        if (commitControl === false || _shouldDrop(id, opts)) {
            try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
            _releaseWriteCommit(commitControl);
            return false;
        }
        try {
            _renameWithRetrySync(tmp, target);
            _queueSessionSummaryUpsert(session, summaryVersion);
            clearSessionSaveError(id);
        } finally {
            _releaseWriteCommit(commitControl);
        }
        return true;
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
        throw err;
    }
}

function _shouldDrop(id, opts) {
    if (_isCancelledWrite(opts)) return true;
    if (!opts || opts.allowClosed) return false;
    const expected = typeof opts.expectedGeneration === 'number' ? opts.expectedGeneration : null;
    if (expected === null) return false;
    // Re-read current tombstone state from disk. If the session is closed with
    // a generation >= expected, our write is stale — drop it.
    const target = sessionPath(id);
    if (!existsSync(target)) return false;
    try {
        const raw = readFileSync(target, 'utf-8');
        // Tombstone check only needs top-level `closed`/`generation`. A plain
        // substring/regex pre-check is unsafe on its own: a message body can
        // contain literal text like `{"closed":true}` (tool result, pasted
        // JSON) which would spoof the guard if trusted directly. Instead of
        // JSON.parse'ing the whole document on every guarded save (expensive:
        // allocates the entire messages array just to read two scalars),
        // scanTopLevelLifecycle walks the raw text with bracket-depth +
        // string-escape awareness and only *interprets* key/value pairs at
        // depth 1 — nested "closed"/"generation" inside messages are skipped
        // by depth counting, never parsed, so they cannot be mistaken for the
        // real top-level fields. Falls back to a full parse only if the scan
        // reports malformed/truncated JSON (should not happen for files we
        // wrote ourselves, but stay correct over clever).
        let onDisk = scanTopLevelLifecycle(raw);
        if (onDisk === null) onDisk = JSON.parse(raw);
        const diskGen = typeof onDisk.generation === 'number' ? onDisk.generation : 0;
        if (onDisk.closed === true) return diskGen >= expected;
        // Not closed, but `generation` also doubles as an ownership counter:
        // normal in-place saves (updateSession/appendMessage/etc.) never bump
        // it, only closeSession()-family calls do (markSessionClosed and its
        // non-tombstoning sibling bumpSessionGeneration). So if disk
        // generation is strictly greater than what this write expected,
        // ownership moved on (session was detached-closed and possibly
        // resumed) after our turn started — drop the stale write rather than
        // let it clobber whatever happened after the handoff.
        return diskGen > expected;
    } catch {
        return false;
    }
}

/** Sync-flush every pending save on exit; per-entry catch matches _flushScheduled. */
export function drainSessionStore() {
    for (const t of _debounceTimers.values()) clearTimeout(t);
    _debounceTimers.clear();
    for (const [, pending] of _savePending) {
        if (!pending.payload) continue;
        try {
            _doSaveSync(pending.payload);
        } catch (err) {
            process.stderr.write(`[session-store] drain save failed: ${err?.message}\n`);
        }
    }
    _savePending.clear();
    // Invalidate older worker writes for sessions whose newer terminal snapshot
    // is deferred, then wait out any commit already holding the write guard.
    for (const [, pending] of _deferredSessionSaves) {
        _cancelSessionWrites(pending.session.id);
        _waitForWriteCommit(pending.session.id);
        pending.opts = _guardedSaveOptions(pending.session.id, pending.opts);
    }
    // Summary-index ops queued by the deferred/no-wait flush path: give them
    // one last best-effort flush before exit (still zero-wait; losing them is
    // acceptable — the index self-heals on next rebuild).
    try { _flushPendingSummaryOps({ sync: true }); } catch { /* best-effort */ }
    // Outstanding worker-queue writes: process exit may interrupt the worker
    // thread before it processes its message queue, so each pending payload
    // is sync-flushed directly here. The Promise is then rejected so the
    // caller's await site does not leak unresolved (caller is at process
    // exit so the rejection is informational, not actionable).
    const _drainErr = new Error('[session-store] drain: worker-queue interrupted by process exit');
    // Flush in-flight writes FIRST, then the latest-wins queued payloads, so
    // for any id with both an in-flight and a queued write the queued (newest)
    // state is written LAST and wins on disk — no lost last write.
    for (const [, pending] of _saveWorkerPending) {
        if (pending.session) {
            try {
                _saveSessionSync(pending.session, pending.opts);
            } catch (err) {
                process.stderr.write(`[session-store] drain worker-queue save failed: ${err?.message}\n`);
            }
        }
        for (const w of pending.waiters) {
            try { w.reject(_drainErr); } catch { /* best-effort */ }
        }
    }
    for (const [, q] of _saveAsyncQueued) {
        try {
            _saveSessionSync(q.session, q.opts);
        } catch (err) {
            process.stderr.write(`[session-store] drain worker-queue save failed: ${err?.message}\n`);
        }
        for (const w of q.waiters) {
            try { w.reject(_drainErr); } catch { /* best-effort */ }
        }
    }
    // Terminal/deferred snapshots are newest and must be written LAST.
    for (const [, pending] of _deferredSessionSaves) {
        try {
            _saveSessionSync(pending.session, pending.opts);
            pending.resolve();
        } catch (err) {
            pending.reject(err);
            process.stderr.write(`[session-store] drain deferred save failed: ${err?.message}\n`);
        }
    }
    _deferredSessionSaves.clear();
    _saveWorkerPending.clear();
    _saveAsyncQueued.clear();
    _saveAsyncInflight.clear();
    _saveWorkerRefCount = 0;
}

function _drainQueue(id) {
    const pending = _savePending.get(id);
    if (pending && pending.queued) {
        const next = pending.queued;
        _savePending.set(id, { writing: true, payload: next });
        _doSave(next).then((saved) => {
            if (!saved) _rollbackCachedSessionSummary(id, next.summaryVersion);
        }).catch(err => {
            _rollbackCachedSessionSummary(id, next.summaryVersion);
            process.stderr.write(`[session-store] save failed: ${err?.message}\n`);
            _lastSaveError.set(id, { message: err?.message ?? String(err), at: Date.now() });
        });
    } else {
        _savePending.delete(id);
    }
}

async function _doSave(payload) {
    const { session, opts, summaryVersion = null } = payload;
    const id = session.id;
    // First check: upfront, before any disk I/O. Cheap short-circuit when a
    // tombstone is already on disk when the caller arrives.
    if (_shouldDrop(id, opts)) {
        _drainQueue(id);
        return false;
    }
    const target = sessionPath(id);
    const tmp = target + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        await fsp.writeFile(tmp, JSON.stringify(_sessionForDisk(session)), 'utf-8');
        // Second check: between the temp write and the rename, closeSession()
        // may have planted a tombstone. Re-check on disk; if a newer tombstone
        // now exists, discard our temp file rather than let rename clobber it.
        if (_shouldDrop(id, opts)) {
            try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
            process.stderr.write(`[session-store] ${id}: dropped stale save (tombstone planted during write)\n`);
            _drainQueue(id);
            return false;
        }
        const commitControl = _acquireWriteCommit(opts);
        if (commitControl === false || _shouldDrop(id, opts)) {
            try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
            _releaseWriteCommit(commitControl);
            _drainQueue(id);
            return false;
        }
        try {
            _renameWithRetrySync(tmp, target);
            _queueSessionSummaryUpsert(session, summaryVersion);
            clearSessionSaveError(id);
        } finally {
            _releaseWriteCommit(commitControl);
        }
        _drainQueue(id);
        return true;
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
        _savePending.delete(id);
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

export function markSessionClosed(id, reason = 'manual', options = {}) {
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
    // from the ON-DISK JSON, read cache-bypassing — NOT from loadSession(),
    // which can serve a stale in-memory OPEN payload (a pending debounced save
    // or a _liveSessions entry) after a late save. Deciding off that stale open
    // copy would make a re-close of an already-tombstoned session look like a
    // FIRST close and reset updatedAt+generation, resurrecting the exact
    // immortality refresh this guard prevents. The disk file is the
    // authoritative tombstone state.
    let onDisk = null;
    try { onDisk = JSON.parse(readFileSync(sessionPath(id), 'utf-8')); }
    catch { onDisk = null; }
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
    const tombstone = { ...base, closed: true, closedReason: alreadyClosed ? (base.closedReason || reason) : reason, status: 'closed', generation: newGen, updatedAt: closeTime };
    // Bypass the queue + guard — this IS the tombstone write.
    const target = sessionPath(id);
    const tmp = target + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        writeFileSync(tmp, JSON.stringify(_sessionForDisk(tombstone)), 'utf-8');
        _renameWithRetrySync(tmp, target);
    } catch {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        return null;
    }
    _savePending.delete(id);
    clearSessionSaveError(id);
    _clearLiveSession(id);
    // Preserve a sidecar published strictly after the sweep's scan snapshot.
    _deleteHeartbeatUnlessNewer(id, options);
    _queueSessionSummaryUpsert(tombstone);
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
    _clearDebounce(id);
    _cancelSessionWrites(id);
    _uncacheSessionSummary(id);
    const existing = loadSession(id);
    if (!existing) return null;
    const newGen = (typeof existing.generation === 'number' ? existing.generation : 0) + 1;
    const detached = { ...existing, generation: newGen, updatedAt: Date.now(), detachedReason: reason };
    const target = sessionPath(id);
    const tmp = target + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        writeFileSync(tmp, JSON.stringify(_sessionForDisk(detached)), 'utf-8');
        _renameWithRetrySync(tmp, target);
    } catch {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        return null;
    }
    _savePending.delete(id);
    clearSessionSaveError(id);
    _clearLiveSession(id);
    _deleteHeartbeat(id);
    _queueSessionSummaryUpsert(detached);
    return newGen;
}

export function loadSession(id) {
    const path = sessionPath(id);
    let stored = null;
    if (existsSync(path)) {
        try {
            stored = JSON.parse(readFileSync(path, 'utf-8'));
            // An existing file owns this identity. Its contents must validate
            // before fresher in-memory state is allowed to shadow it.
            if (stored?.id !== id) return null;
        } catch {
            return null;
        }
    }
    // Read-your-writes: if a save is pending (debouncing, scheduled, or queued
    // behind an in-flight write) return that payload instead of stale disk state.
    // The most-recently-queued slot is checked first (queued > payload).
    const pending = _savePending.get(id);
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
        if (stored && storedGen > liveGen) {
            _liveSessions.delete(id);
        } else {
            return _ensureLifecycleFields(live);
        }
    }
    return stored ? _ensureLifecycleFields(stored) : null;
}

/**
 * Returns the last save error for a session id, or null if no error has occurred.
 * Shape: { message: string, at: number } | null
 */
export function getSessionSaveError(id) {
    return _lastSaveError.get(id) ?? null;
}

export function clearSessionSaveError(id) {
    _lastSaveError.delete(id);
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
    _cancelSessionWrites(id);
    _clearDebounce(id);
    _savePending.delete(id);
    const path = sessionPath(id);
    let removed = false;
    if (existsSync(path)) {
        try {
            unlinkSync(path);
            removed = true;
        }
        catch { /* fall through to .hb cleanup */ }
    }
    // Preserve a sidecar published strictly after the sweep's scan snapshot.
    _deleteHeartbeatUnlessNewer(id, options);
    _clearLiveSession(id);
    if (removed || !existsSync(path)) clearSessionSaveError(id);
    // deferSummaryUpdate: bulk callers (tombstone sweep) remove thousands of
    // rows — a per-id _removeSessionSummary would parse+rewrite the multi-MB
    // summary index once PER DELETION. They batch the index update themselves.
    if (options.deferSummaryUpdate === true) _uncacheSessionSummary(id);
    else _queueSessionSummaryRemoval(id);
    return removed;
    } finally {
        _releaseWriteCommit(commitControl);
    }
}
const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes idle — aligned with Anthropic 5m messages tier and OpenAI in-memory cache window
const AGENT_TERMINAL_STATUSES = new Set(['idle', 'done', 'error']);
// Hard wall-clock ceiling for sessions stuck in status='running'. The
// stream-watchdog should abort stalled streams within ~120s, but if it misses
// one (process crash, watchdog not started, provider never returned), this
// backstop reclaims the file so the sweep doesn't leak zombies indefinitely.
const RUNNING_STALL_MS = 10 * 60 * 1000;
// Retention cap for resumable OPEN (non-tombstone) sessions. Lead/user resume
// closes sessions with { tombstone:false } — the runtime detaches but the
// session JSON stays open/resumable and is never lifecycle-closed, so without
// a cap the sessions/ dir grows without bound (observed 782 open files). The
// sweep prunes open sessions past EITHER bound: older than 14d, or beyond the
// newest 300 (oldest first). The cap targets ONLY ephemeral agent/ownerless
// sessions — explicit USER-owned conversations are never auto-pruned (deleting
// a user's history, including the current foreground session which is idle
// during a gated sweep, is unacceptable). A session with a live runtime entry
// (options.isSessionLive) is additionally protected as defense-in-depth.
const RESUMABLE_OPEN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const RESUMABLE_OPEN_MAX_COUNT = 300;

function _storedSessionFromFile(dir, filename, ensureLifecycle = true) {
    if (!filename.endsWith('.json')) return null;
    const storageId = filename.slice(0, -5);
    if (!storageId || !/^[A-Za-z0-9_-]+$/.test(storageId)) return null;
    try {
        const session = JSON.parse(readFileSync(join(dir, filename), 'utf-8'));
        if (session?.id !== storageId) return null;
        return ensureLifecycle ? _ensureLifecycleFields(session) : session;
    } catch {
        return null;
    }
}

export function listStoredSessions(options = {}) {
    const dir = getStoreDir();
    if (!existsSync(dir))
        return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessionsById = new Map();
    const invalidStorageIds = options._invalidStorageIds instanceof Set
        ? options._invalidStorageIds
        : new Set();
    for (const f of files) {
        const session = _storedSessionFromFile(dir, f);
        if (session) {
            sessionsById.set(session.id, session);
            continue;
        }
        const storageId = f.slice(0, -5);
        if (/^[A-Za-z0-9_-]+$/.test(storageId)) invalidStorageIds.add(storageId);
    }
    const stored = [...sessionsById.values()];
    return options.includeLive === true
        ? _withUnpersistedSessions(stored, invalidStorageIds)
        : stored.sort((a, b) => b.updatedAt - a.updatedAt);
}

function _withUnpersistedSessions(stored, invalidStorageIds = new Set()) {
    const sessionsById = new Map(stored.map((session) => [session.id, session]));
    const addIfUnpersisted = (id, session, opts) => {
        // A valid on-disk record is authoritative for refresh/resume. In
        // particular, a long-lived runtime object must never replace a
        // tombstone or changed desktop authorization metadata. Only active
        // local writes with no disk record get read-your-writes visibility.
        if (sessionsById.has(id) || invalidStorageIds.has(id) || _isCancelledWrite(opts)) return;
        if (session?.id === id) sessionsById.set(id, _ensureLifecycleFields(session));
    };
    for (const [id, pending] of _savePending) {
        const payload = pending.queued || pending.payload;
        addIfUnpersisted(id, payload?.session, payload?.opts);
    }
    for (const [, pending] of _saveWorkerPending) {
        addIfUnpersisted(pending.id, pending.session, pending.opts);
    }
    for (const [id, pending] of _saveAsyncQueued) {
        addIfUnpersisted(id, pending.session, pending.opts);
    }
    return [...sessionsById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Incremental storage scan ────────────────────────────────────────────────
// refreshFromStorage used to re-parse EVERY session JSON (full transcripts,
// multi-MB files) on each desktop sidebar refresh. A summary only changes when
// its file changes, so key a per-file row cache on (mtimeMs, size): unchanged
// files reuse the cached row, changed/new files re-parse, vanished files drop
// out. Storage stays the truth source — the sidecar index is never trusted.
const _summaryScanCache = new Map(); // filename → { mtimeMs, size, row|null }

function _scanStoredSessionSummaryRows() {
    const dir = getStoreDir();
    if (!existsSync(dir)) {
        const changed = _summaryScanCache.size > 0;
        _summaryScanCache.clear();
        return { rows: [], invalidStorageIds: new Set(), changed };
    }
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const present = new Set(files);
    let changed = false;
    for (const key of [..._summaryScanCache.keys()]) {
        if (!present.has(key)) {
            _summaryScanCache.delete(key);
            changed = true;
        }
    }
    const rows = [];
    const invalidStorageIds = new Set();
    const markInvalid = (filename) => {
        const storageId = filename.slice(0, -5);
        if (/^[A-Za-z0-9_-]+$/.test(storageId)) invalidStorageIds.add(storageId);
    };
    for (const f of files) {
        let fileStat = null;
        try { fileStat = statSync(join(dir, f)); } catch { /* deleted mid-scan */ }
        if (!fileStat) {
            if (_summaryScanCache.delete(f)) changed = true;
            continue;
        }
        const cached = _summaryScanCache.get(f);
        if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
            if (cached.row) rows.push(cached.row);
            else markInvalid(f);
            continue;
        }
        const session = _storedSessionFromFile(dir, f);
        const row = session ? _sessionSummary(session) : null;
        _summaryScanCache.set(f, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, row });
        changed = true;
        if (row) rows.push(row);
        else markInvalid(f);
    }
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { rows, invalidStorageIds, changed };
}

// Summary-level twin of _withUnpersistedSessions: overlay queued/in-flight
// saves that have no disk record yet (read-your-writes for brand-new sessions).
function _overlayUnpersistedSummaryRows(rows, invalidStorageIds = new Set()) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const addIfUnpersisted = (id, session, opts) => {
        if (!id || byId.has(id) || invalidStorageIds.has(id) || _isCancelledWrite(opts)) return;
        if (session?.id !== id) return;
        const row = _sessionSummary(_ensureLifecycleFields(session));
        if (row) byId.set(id, row);
    };
    for (const [id, pending] of _savePending) {
        const payload = pending.queued || pending.payload;
        addIfUnpersisted(id, payload?.session, payload?.opts);
    }
    for (const [, pending] of _saveWorkerPending) addIfUnpersisted(pending.id, pending.session, pending.opts);
    for (const [id, pending] of _saveAsyncQueued) addIfUnpersisted(id, pending.session, pending.opts);
    return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function rebuildSessionSummaryIndex() {
    _ensureSummaryCacheDataDir();
    const { rows } = _scanStoredSessionSummaryRows();
    return _setSummaryRowsCache(_writeSummaryIndex(rows));
}

export function listStoredSessionSummaries(options = {}) {
    _ensureSummaryCacheDataDir();
    const rebuildIfMissing = options.rebuildIfMissing !== false;
    // This is intentionally the only path that rescans every session JSON:
    // callers use it as an on-demand authoritative refresh (including resume
    // authorization), so it must not trust either the cache or sidecar.
    if (options.refreshFromStorage === true) {
        try {
            const { rows: persistedRows, invalidStorageIds, changed } = _scanStoredSessionSummaryRows();
            const rows = _overlayUnpersistedSummaryRows(persistedRows, invalidStorageIds);
            // Unchanged scans skip the sidecar rewrite — refresh is called on
            // every sidebar poll/push and must not grind a multi-MB atomic
            // write when no session actually changed.
            if (changed) {
                try { _writeSummaryIndex(persistedRows); } catch { /* sidecar remains best-effort */ }
            }
            // A direct scan settles deletion state too; retain only active
            // optimistic write overlays, never a stale local removal.
            _summaryCacheRemovals.clear();
            _setSummaryRowsCache(persistedRows);
            return rows;
        } catch {
            // A refresh is an authorization boundary for desktop resume. If
            // authoritative storage cannot be enumerated, stale cached/sidecar
            // rows must not be treated as proof that a session is available.
            return [];
        }
    }
    if (_summaryRowsCache !== null) return _cachedSummaryRows().slice();

    let indexedRows = [];
    let p;
    let hasIndex = false;
    try {
        p = summaryIndexPath();
        hasIndex = existsSync(p);
        if (hasIndex) {
            const raw = JSON.parse(readFileSync(p, 'utf-8'));
            hasIndex = Number(raw?.version) === SESSION_SUMMARY_INDEX_VERSION;
            if (hasIndex) indexedRows = _normalizeSummaryIndex(raw).rows;
        }
    } catch { /* unreadable/malformed sidecar falls through to rebuild */ }

    if (!p || !hasIndex) {
        try { return rebuildIfMissing ? rebuildSessionSummaryIndex() : _setSummaryRowsCache([]); }
        catch { return _setSummaryRowsCache(indexedRows); }
    }
    try {
        if (indexedRows.length > 0) return _setSummaryRowsCache(indexedRows);
        const dir = getStoreDir();
        const hasSessionFiles = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json'));
        return hasSessionFiles && rebuildIfMissing ? rebuildSessionSummaryIndex() : _setSummaryRowsCache(indexedRows);
    } catch {
        try { return rebuildIfMissing ? rebuildSessionSummaryIndex() : _setSummaryRowsCache(indexedRows); }
        catch { return _setSummaryRowsCache(indexedRows); }
    }
}

/**
 * Raw directory scan — returns every parseable session file without any
 * TTL-based inline deletion. Callers (e.g. sweepTombstones) need to own the
 * unlink decision and log it themselves.
 */
export function getStoredSessionsRaw() {
    const dir = getStoreDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const f of files) {
        const session = _storedSessionFromFile(dir, f, false);
        if (session) sessions.push(session);
    }
    return sessions;
}

/**
 * Background sweep: delete session files idle longer than ttlMs.
 * Returns { cleaned, remaining, details } for logging.
 */
export function sweepStaleSessions(ttlMs, options = {}) {
    if (ttlMs && typeof ttlMs === 'object') {
        options = ttlMs;
        ttlMs = options.ttlMs;
    }
    const maxAge = ttlMs || DEFAULT_SESSION_TTL_MS;
    const sweepIdle = options.sweepIdle !== false;
    let terminalReapConfig = null;
    try { terminalReapConfig = loadConfig({ secrets: false }); } catch { /* built-ins remain available */ }
    const tombstoneMaxAgeMs = Number(options.tombstoneMaxAgeMs);
    const sweepTombstones = Number.isFinite(tombstoneMaxAgeMs) && tombstoneMaxAgeMs > 0;
    // Retention cap for resumable open sessions runs only on the idle sweep
    // (never on a tombstone-only pass). isSessionLive protects the current /
    // actively-running sessions from being pruned by the retention cap.
    const isSessionLive = typeof options.isSessionLive === 'function' ? options.isSessionLive : null;
    const retainOpen = sweepIdle && options.retainOpenSessions !== false;
    const _optAge = Number(options.openMaxAgeMs);
    const _optCount = Number(options.openMaxCount);
    const openMaxAgeMs = Number.isFinite(_optAge) && _optAge > 0 ? _optAge : RESUMABLE_OPEN_MAX_AGE_MS;
    const openMaxCount = Number.isFinite(_optCount) && _optCount >= 0 ? _optCount : RESUMABLE_OPEN_MAX_COUNT;
    const dir = getStoreDir();
    if (!existsSync(dir))
        return { cleaned: 0, remaining: 0, details: [], tombstonesCleaned: 0, tombstoneDetails: [], tombstoneErrors: [] };
    // Reconcile the index-derived candidate set with a direct directory scan:
    // the summary index is a best-effort sidecar that can lag far behind disk
    // (thousands of on-disk .json files may be absent from a smaller index).
    // Any such orphan closed+mature tombstone would otherwise be unreachable by
    // this sweep and accumulate forever. Union the index rows with every
    // on-disk .json id, deduped by id; synthetic { id } rows are sufficient
    // because the loop below re-reads all lifecycle truth from disk. This stays
    // sweep-local and does NOT change listStoredSessionSummaries for other
    // callers. Steady-state cost is one readdirSync plus cheap per-orphan reads.
    const indexRows = listStoredSessionSummaries();
    const summaries = indexRows;
    try {
        const seen = new Set();
        for (const row of indexRows) { if (row?.id) seen.add(row.id); }
        for (const f of readdirSync(dir)) {
            if (!f.endsWith('.json')) continue;
            const id = f.slice(0, -5);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            summaries.push({ id });
        }
    } catch { /* dir scan failure — fall back to index rows only */ }
    const now = Date.now();
    let cleaned = 0;
    let remaining = 0;
    let tombstonesCleaned = 0;
    const details = [];
    const tombstoneDetails = [];
    const tombstoneErrors = [];
    // Retention-cap bookkeeping: collect surviving open (non-tombstone)
    // sessions here, then prune oldest-first after the main loop.
    const openCandidates = [];
    let openPruned = 0;
    const openPrunedDetails = [];
    for (const row of summaries) {
        try {
            if (!row?.id) continue;
            const jsonPath = sessionPath(row.id);
            if (!existsSync(jsonPath)) {
                _queueSessionSummaryRemoval(row.id);
                continue;
            }
            let jsonMtime = 0;
            let heartbeatMtime = 0;
            try { jsonMtime = statSync(jsonPath).mtimeMs || 0; } catch {}
            try {
                const hbPath = join(dir, `${row.id}.hb`);
                if (existsSync(hbPath)) heartbeatMtime = statSync(hbPath).mtimeMs || 0;
            } catch { /* .hb unavailable — fall back to JSON fields */ }
            // Truth source: the summary index is a deferred/best-effort sidecar,
            // so a row can still claim status='idle'/open while the session JSON
            // was already tombstoned. Read the real session JSON BEFORE the
            // freshness gate so closed-ness is decided from AUTHORITATIVE on-disk
            // state — otherwise idle-sweep re-closes an already-closed session via
            // markSessionClosed (which, pre-fix, reset the tombstone age every
            // 5-min cycle → immortality loop).
            let raw = null;
            try { raw = readFileSync(jsonPath, 'utf-8'); }
            catch { /* racing unlink / transient read failure */ }
            let actual = null;
            let diskClosed;
            if (raw == null) {
                diskClosed = (row.closed === true || row.status === 'closed');
            } else {
                // Cheap top-level scan avoids allocating the whole messages array
                // just to read the closed flag for the (common) fresh open
                // session the gate will skip; full-parse only when the scan can't
                // resolve the top-level flag.
                const scan = scanTopLevelLifecycle(raw);
                if (scan && typeof scan.closed === 'boolean') {
                    diskClosed = scan.closed;
                } else {
                    try { actual = JSON.parse(raw); } catch { actual = null; }
                    diskClosed = actual
                        ? (actual.closed === true || actual.status === 'closed')
                        : (row.closed === true || row.status === 'closed');
                }
            }
            if (diskClosed) {
                // A shared store can be tombstoned by another process while
                // this process still owns an in-flight controller for the same
                // id. Exclude it before unlinking: clearing only the local
                // runtime after deletion is too late because its eventual save
                // would see no tombstone and could resurrect the session.
                if (isSessionLive && isSessionLive(row.id)) {
                    remaining++;
                    continue;
                }
                // Closed sessions are EXEMPT from the freshness gate: a tombstone
                // whose file/hb mtime keeps getting bumped would otherwise stay
                // perpetually "fresh" and never mature. Maturity is governed ONLY
                // by the ORIGINAL close time (disk updatedAt, not row.updatedAt
                // which a stale row may carry from before the close).
                if (!actual && raw != null) { try { actual = JSON.parse(raw); } catch { actual = null; } }
                const closedAt = Number(actual?.updatedAt ?? row.updatedAt);
                const age = now - closedAt;
                if (sweepTombstones && Number.isFinite(closedAt) && age >= tombstoneMaxAgeMs) {
                    try {
                        if (deleteSession(row.id, { deferSummaryUpdate: true })) {
                            tombstonesCleaned++;
                            tombstoneDetails.push({ id: row.id, ageSeconds: Math.floor(age / 1000) });
                            continue;
                        }
                    } catch (err) {
                        tombstoneErrors.push({ id: row.id, message: err?.message || String(err) });
                        remaining++;
                        continue;
                    }
                }
                // Repair a stale summary row that still claimed the session was
                // open: reflect the real closed state so the next sweep sees the
                // correct closed=true/updatedAt and never re-closes it.
                if (actual && !(row.closed === true || row.status === 'closed')) {
                    try { _queueSessionSummaryUpsert(actual); } catch { /* best-effort */ }
                }
                remaining++;
                continue;
            }
            // Parse the open record before its freshness gate: completed agents
            // use their provider's Advanced terminal duration rather than the
            // general sweep cadence. A short provider override must therefore
            // not be hidden behind the default 5-minute gate.
            if (!actual && raw != null) { try { actual = JSON.parse(raw); } catch { actual = null; } }
            const gateOwner = (actual && typeof actual.owner === 'string' && actual.owner.length > 0)
                ? actual.owner : row.owner;
            const gateStatus = (actual && typeof actual.status === 'string') ? actual.status : row.status;
            const gateProvider = (actual && typeof actual.provider === 'string') ? actual.provider : row.provider;
            const isCompletedAgentForGate = isAgentOwner({ owner: gateOwner })
                && AGENT_TERMINAL_STATUSES.has(gateStatus);
            const terminalReapMsForGate = isCompletedAgentForGate
                ? resolveAgentTerminalReapMs(terminalReapConfig, gateProvider)
                : null;
            if (isCompletedAgentForGate && terminalReapMsForGate == null) {
                remaining++;
                continue;
            }
            // Freshness gate — OPEN sessions only (closed sessions handled and
            // `continue`d above). Recently-touched open sessions are skipped
            // cheaply here.
            const freshnessGateMs = sweepIdle
                ? (terminalReapMsForGate ?? maxAge)
                : (sweepTombstones ? tombstoneMaxAgeMs : 0);
            const newestKnown = Math.max(row.updatedAt || 0, row.lastHeartbeatAt || 0, row.createdAt || 0, jsonMtime, heartbeatMtime);
            if (freshnessGateMs > 0 && newestKnown > 0 && now - newestKnown <= freshnessGateMs) {
                // Fresh agent/legacy sessions survive idle close but still
                // participate in the resumable-open retention cap. The cap
                // performs its own commit-edge liveness veto before deletion.
                if (retainOpen && sweepIdle
                    && (!(typeof gateOwner === 'string' && gateOwner.length > 0)
                        || isAgentOwner({ owner: gateOwner }))) {
                    openCandidates.push({
                        id: row.id,
                        lastActive: newestKnown,
                        heartbeatSnapshotMtime: heartbeatMtime,
                        heartbeatFreshMs: terminalReapMsForGate ?? maxAge,
                    });
                }
                remaining++;
                continue;
            }
            // Prefer the AUTHORITATIVE on-disk JSON over the best-effort (and
            // possibly stale) summary row for every open/idle liveness and
            // ownership decision below — a stale row must not close or prune the
            // wrong session. Full-parse here if the cheap scan skipped it.
            if (!actual && raw != null) { try { actual = JSON.parse(raw); } catch { actual = null; } }
            const effOwner = (actual && typeof actual.owner === 'string' && actual.owner.length > 0)
                ? actual.owner : row.owner;
            const ownerRef = { owner: effOwner };
            const effStatus = (actual && typeof actual.status === 'string') ? actual.status : row.status;
            const effUpdatedAt = Number(actual?.updatedAt) > 0 ? Number(actual.updatedAt) : (row.updatedAt || 0);
            const effLastHb = Number(actual?.lastHeartbeatAt) > 0 ? Number(actual.lastHeartbeatAt) : (row.lastHeartbeatAt || 0);
            const effCreatedAt = Number(actual?.createdAt) > 0 ? Number(actual.createdAt) : (row.createdAt || 0);
            const effBashId = (actual && actual.implicitBashSessionId) || row.implicitBashSessionId || null;
            const effProvider = (actual && typeof actual.provider === 'string') ? actual.provider : row.provider;
            // Sweep agent-owned and ownerless (legacy) sessions; skip explicit
            // user sessions before touching heartbeat sidecars. USER-owned
            // conversations are NEVER added to the retention-cap candidate set —
            // the cap must not auto-delete user history (nor the current
            // foreground session, which is idle during a gated sweep). Only the
            // ephemeral agent/ownerless sessions below feed the cap.
            if (typeof effOwner === 'string' && effOwner.length > 0 && !isAgentOwner(ownerRef)) {
                remaining++;
                continue;
            }
            if (!sweepIdle) {
                remaining++;
                continue;
            }
            // The manager may sweep while unrelated sessions are active. Protect
            // this specific locally-current/in-flight session regardless of stale
            // on-disk timestamps; its controller/heartbeat owner decides when it
            // is safe to become an idle-sweep candidate.
            if (isSessionLive && isSessionLive(row.id)) {
                remaining++;
                continue;
            }
            // Prefer .hb sidecar mtime — updated at tight cadence (≤5s) without
            // serialising the full JSON, so it reflects true liveness more
            // accurately than the JSON timestamp fields.
            let lastActive = effLastHb || effUpdatedAt || effCreatedAt || 0;
            if (heartbeatMtime) lastActive = Math.max(lastActive, heartbeatMtime);
            // Running sessions are normally reaped by the stream-watchdog
            // within ~120s. Skip them here unless they've been silent past
            // RUNNING_STALL_MS, at which point they are treated as zombies.
            if (effStatus === 'running' && now - lastActive <= RUNNING_STALL_MS) {
                remaining++;
                continue;
            }
            const isCompletedAgent = isAgentOwner(ownerRef)
                && AGENT_TERMINAL_STATUSES.has(effStatus);
            const terminalReapMs = isCompletedAgent ? terminalReapMsForGate : null;
            const sessionMaxAge = terminalReapMs ?? maxAge;
            if (now - lastActive > sessionMaxAge) {
                // Close is destructive and the earlier heartbeat stat can race a
                // different process publishing fresh liveness. Re-check both
                // local runtime ownership and the sidecar at the commit edge.
                if (isSessionLive && isSessionLive(row.id)) {
                    remaining++;
                    continue;
                }
                let preCloseHeartbeatMtime = 0;
                try {
                    const hbPath = join(dir, `${row.id}.hb`);
                    if (existsSync(hbPath)) preCloseHeartbeatMtime = statSync(hbPath).mtimeMs || 0;
                } catch { /* sidecar unavailable — retain scan-time gates */ }
                if (preCloseHeartbeatMtime > 0 && now - preCloseHeartbeatMtime <= sessionMaxAge) {
                    remaining++;
                    continue;
                }
                let closeResult = null;
                try {
                    closeResult = markSessionClosed(row.id, 'idle-sweep', {
                        isSessionLive,
                        heartbeatSnapshotMtime: heartbeatMtime,
                        heartbeatFreshMs: sessionMaxAge,
                    });
                }
                catch (err) {
                    process.stderr.write(`[session-store] idle-sweep close failed for ${row.id}: ${err?.message}\n`);
                    continue;
                }
                if (closeResult == null) {
                    remaining++;
                    continue;
                }
                cleaned++;
                details.push({
                    id: row.id,
                    owner: effOwner || 'unknown',
                    idleMinutes: Math.round((now - lastActive) / 60000),
                    bashSessionId: effBashId,
                });
            } else {
                if (retainOpen) openCandidates.push({
                    id: row.id,
                    lastActive,
                    heartbeatSnapshotMtime: heartbeatMtime,
                    heartbeatFreshMs: sessionMaxAge,
                });
                remaining++;
            }
        }
        catch { /* skip corrupt */ }
    }
    // ── Retention cap: prune resumable open (non-tombstone) sessions ──────────
    // Newest-first: keep the most recent openMaxCount, prune anything older than
    // openMaxAgeMs OR beyond the count. Live/current sessions (isSessionLive)
    // are never pruned but still occupy a kept slot.
    if (retainOpen && openCandidates.length > 0) {
        openCandidates.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
        let kept = 0;
        for (const c of openCandidates) {
            if (isSessionLive && isSessionLive(c.id)) { kept++; continue; }
            const tooOld = openMaxAgeMs > 0 && now - (c.lastActive || 0) > openMaxAgeMs;
            const overCount = kept >= openMaxCount;
            if (!tooOld && !overCount) { kept++; continue; }
            try {
                if (deleteSession(c.id, {
                    deferSummaryUpdate: true,
                    isSessionLive,
                    heartbeatSnapshotMtime: c.heartbeatSnapshotMtime,
                    heartbeatFreshMs: c.heartbeatFreshMs,
                })) {
                    openPruned++;
                    openPrunedDetails.push({ id: c.id, ageSeconds: Math.floor((now - (c.lastActive || 0)) / 1000) });
                    if (remaining > 0) remaining--;
                } else {
                    kept++;
                }
            } catch { kept++; }
        }
    }
    // Orphan .hb reap: a heartbeat sidecar whose .json no longer exists is dead
    // weight once it is also stale (older than maxAge) — the session JSON was
    // swept/closed but the .hb lingered (a pre-fix orphaned heartbeat). The
    // staleness gate avoids nuking the .hb of a session mid-create whose .json
    // write has not landed yet.
    try {
        for (const h of readdirSync(dir).filter(f => f.endsWith('.hb'))) {
            if (existsSync(join(dir, h.replace(/\.hb$/, '.json')))) continue;
            let hbMtime = 0;
            try { hbMtime = statSync(join(dir, h)).mtimeMs; } catch { continue; }
            if (now - hbMtime > maxAge) {
                try { unlinkSync(join(dir, h)); cleaned++; } catch { /* ignore */ }
            }
        }
    } catch { /* dir scan failure — non-fatal */ }
    // Batched summary-index prune for deferred tombstone deletions: one
    // read-modify-write for the whole sweep instead of one per deleted id
    // (the index is multi-MB at scale; per-id rewrites made large sweeps
    // quadratic and stalled boot for seconds).
    if (tombstoneDetails.length > 0 || openPrunedDetails.length > 0) {
        try {
            const deletedIds = new Set([...tombstoneDetails, ...openPrunedDetails].map((d) => d.id));
            _queueSummaryIndexPrune(deletedIds);
        } catch { /* summary index is best-effort */ }
    }
    return { cleaned, remaining, details, tombstonesCleaned, tombstoneDetails, tombstoneErrors, openPruned, openPrunedDetails };
}
