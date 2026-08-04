// Session listing, summary projection and stale-session sweeping. Extracted
// from store.mjs, which keeps the persistence half (save/load/close/delete).
// The two halves share the in-flight save map so an unpersisted session still
// shows up in listings; the cycle is import-only (calls happen at runtime).
import { readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { getPluginData, loadConfig } from '../../config.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../lifecycle-scan.mjs';
import { resolveAgentTerminalReapMs } from '../../../../../session-runtime/config-helpers.mjs';
import { getStoreDir, sessionPath } from './paths-heartbeat.mjs';
import { probePath, PROBE_PRESENT, PROBE_ABSENT } from './fs-probe.mjs';
import { isCancelledWrite as _isCancelledWrite } from './write-guards.mjs';
import {
    SESSION_SUMMARY_INDEX_VERSION,
    summaryIndexPath,
    _sessionSummary,
    _normalizeSummaryIndex,
    _writeSummaryIndex,
    _hasUnsettledSummaryOps,
} from '../store-summary-index.mjs';
import {
    _ensureSummaryCacheDataDir,
    _cachedSummaryRows,
    _setSummaryRowsCache,
    _queueSummaryIndexPrune,
    _scanStoredSessionSummaryRows,
    _queueSessionSummaryUpsert,
    _queueSessionSummaryRemoval,
    _summaryCacheRemovals,
    _summaryRowsCache,
} from './summary-cache.mjs';
import { _saveAsyncQueued, _saveWorkerPending } from './save-worker.mjs';
import { STORED_SESSION_UNREADABLE, _ensureLifecycleFields, _storedSessionFromFile } from './serialize.mjs';
import { _savePending, deleteSession, markSessionClosed } from '../store.mjs';

// Disk mtime of the summary index when the in-memory cache was last refreshed
// from it — the cross-process staleness detector.
let _summaryIndexMtimeSeen = 0;
let _summaryRebuildWorker = null;
let _summaryRebuildDataDir = '';

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
// Blank scratch sessions (zero user/assistant conversation) are reaped once
// idle this long — see the blank-scratch branch in sweepStaleSessions.
const BLANK_SCRATCH_MAX_AGE_MS = 60 * 60 * 1000; // 1h

/** Child-agent transcripts share their visible parent's retention boundary.
 * Presence (including a tombstone or unreadable file) preserves the child;
 * only proven parent absence releases it to ordinary cleanup. */
function retainedLinkedAgent(session) {
    if (!session || !isAgentOwner(session)) return false;
    const parentId = String(session.ownerSessionId || session.parentSessionId || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(parentId) || parentId === session.id) return false;
    return probePath(sessionPath(parentId)).state !== PROBE_ABSENT;
}


export function listStoredSessions(options = {}) {
    const dir = getStoreDir();
    // Only ENOENT/ENOTDIR is absence. An unreadable directory (EACCES/EIO) is
    // NOT "no sessions": listing yields nothing, but nothing may be treated as
    // deleted/absent on that basis either.
    if (probePath(dir).state !== PROBE_PRESENT) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessionsById = new Map();
    const invalidStorageIds = options._invalidStorageIds instanceof Set
        ? options._invalidStorageIds
        : new Set();
    for (const f of files) {
        const session = _storedSessionFromFile(dir, f);
        if (session && session !== STORED_SESSION_UNREADABLE) {
            sessionsById.set(session.id, session);
            continue;
        }
        // Present-but-unreadable owns its identity too: it may never be
        // replaced by a live/pending overlay, so it is marked invalid.
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

function scheduleSessionSummaryIndexRebuild() {
    const dataDir = getPluginData();
    if (_summaryRebuildWorker && _summaryRebuildDataDir === dataDir) return;
    if (_summaryRebuildWorker) {
        try { void _summaryRebuildWorker.terminate(); } catch { /* stale worker exits independently */ }
    }
    let worker;
    try {
        worker = new Worker(new URL('./summary-rebuild-worker.mjs', import.meta.url), {
            execArgv: [],
            workerData: { dataDir },
        });
    } catch {
        return;
    }
    _summaryRebuildWorker = worker;
    _summaryRebuildDataDir = dataDir;
    const clear = () => {
        if (_summaryRebuildWorker !== worker) return;
        _summaryRebuildWorker = null;
        _summaryRebuildDataDir = '';
    };
    worker.on('message', (message) => {
        if (message?.ok !== true || message.dataDir !== getPluginData() || !Array.isArray(message.rows)) return;
        try { _summaryIndexMtimeSeen = statSync(summaryIndexPath()).mtimeMs || 0; } catch { /* stat only */ }
        _setSummaryRowsCache(message.rows);
    });
    worker.on('error', clear);
    worker.on('exit', clear);
    worker.unref();
}

export function listStoredSessionSummaries(options = {}) {
    _ensureSummaryCacheDataDir();
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
    if (_summaryRowsCache !== null) {
        // A local session save has already updated the in-memory cache but its
        // non-blocking sidecar merge may still be queued/in flight. Re-reading
        // the older sidecar in that window would temporarily erase the new row.
        if (_hasUnsettledSummaryOps()) return _cachedSummaryRows().slice();
        // Cross-process freshness: another live process (terminal CLI owning a
        // session this surface only views) advances messageCount/updatedAt by
        // rewriting the summary index FILE — an in-memory cache that never
        // looks back at disk serves frozen rows forever (user: the unread dot
        // never fired for terminal-owned growth). One stat per call; when the
        // index advanced, re-read the cheap index JSON as the new cache base
        // (local optimistic overlays stay applied on top).
        let diskMtime = 0;
        try { diskMtime = statSync(summaryIndexPath()).mtimeMs || 0; } catch { /* no index yet */ }
        if (diskMtime <= _summaryIndexMtimeSeen) return _cachedSummaryRows().slice();
        try {
            const raw = JSON.parse(readFileSync(summaryIndexPath(), 'utf-8'));
            if (Number(raw?.version) === SESSION_SUMMARY_INDEX_VERSION) {
                _summaryIndexMtimeSeen = diskMtime;
                return _setSummaryRowsCache(_normalizeSummaryIndex(raw).rows).slice();
            }
        } catch { /* torn concurrent write — keep serving the cache; retry next call */ }
        return _cachedSummaryRows().slice();
    }

    let indexedRows = [];
    let p;
    let hasIndex = false;
    let indexUnreadable = false;
    try {
        p = summaryIndexPath();
        const probe = probePath(p);
        hasIndex = probe.state === PROBE_PRESENT;
        if (probe.state !== PROBE_PRESENT && probe.state !== PROBE_ABSENT) indexUnreadable = true;
        if (hasIndex) {
            let text;
            try {
                text = readFileSync(p, 'utf-8');
            } catch (err) {
                // Stat said PRESENT and the read failed: the sidecar is there
                // and we cannot have it. FAIL CLOSED — keep serving the cache,
                // never emit empty rows and never schedule a rebuild that
                // would overwrite a sidecar we could not read.
                const code = err?.code || 'EUNKNOWN';
                if (code !== 'ENOENT' && code !== 'ENOTDIR') indexUnreadable = true;
                throw err;
            }
            const raw = JSON.parse(text);
            hasIndex = Number(raw?.version) === SESSION_SUMMARY_INDEX_VERSION;
            if (hasIndex) indexedRows = _normalizeSummaryIndex(raw).rows;
            if (hasIndex) {
                try { _summaryIndexMtimeSeen = statSync(p).mtimeMs || 0; } catch { /* stat only */ }
            }
        }
    } catch { /* unreadable/malformed sidecar falls through to rebuild */ }

    if (indexUnreadable) {
        // Present-but-unreadable sidecar: retain authority. A COLD cache has
        // no rows yet (null) — return an empty result rather than crashing on
        // `.slice()`, and never rebuild/replace the sidecar we could not read.
        const cached = _cachedSummaryRows();
        return Array.isArray(cached) ? cached.slice() : [];
    }
    if (!p || !hasIndex) {
        scheduleSessionSummaryIndexRebuild();
        return _setSummaryRowsCache(indexedRows);
    }
    try {
        if (indexedRows.length > 0) return _setSummaryRowsCache(indexedRows);
        const dir = getStoreDir();
        const hasSessionFiles = probePath(dir).state === PROBE_PRESENT
            && readdirSync(dir).some((f) => f.endsWith('.json'));
        if (hasSessionFiles) scheduleSessionSummaryIndexRebuild();
        return _setSummaryRowsCache(indexedRows);
    } catch {
        scheduleSessionSummaryIndexRebuild();
        return _setSummaryRowsCache(indexedRows);
    }
}

/**
 * Raw directory scan — returns every parseable session file without any
 * TTL-based inline deletion. Callers (e.g. sweepTombstones) need to own the
 * unlink decision and log it themselves.
 */
export function getStoredSessionsRaw() {
    const dir = getStoreDir();
    if (probePath(dir).state !== PROBE_PRESENT) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const f of files) {
        const session = _storedSessionFromFile(dir, f, false);
        if (session && session !== STORED_SESSION_UNREADABLE) sessions.push(session);
    }
    return sessions;
}

/**
 * Background sweep: delete session files idle longer than ttlMs.
 * Returns { cleaned, remaining, details } for logging.
 */
function* sweepStaleSessionSteps(ttlMs, options = {}) {
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
    // An unreadable store dir is not an empty one: sweeping (deleting,
    // closing, pruning) on a probe we could not make is never allowed.
    if (probePath(dir).state !== PROBE_PRESENT)
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
        // Cooperative callers pause between records so large stores never hold
        // an interactive host's event loop for the full directory scan.
        yield undefined;
        try {
            if (!row?.id) continue;
            const jsonPath = sessionPath(row.id);
            const jsonProbe = probePath(jsonPath);
            // ONLY a proven-absent record may retire its summary row. An
            // EACCES/EIO probe means the file is very likely still there:
            // queueing a removal would delete the row of a live session.
            if (jsonProbe.state === PROBE_ABSENT) {
                _queueSessionSummaryRemoval(row.id);
                continue;
            }
            if (jsonProbe.state !== PROBE_PRESENT) {
                remaining++;
                continue;
            }
            let jsonMtime = jsonProbe.mtimeMs || 0;
            let heartbeatMtime = 0;
            const hbProbe = probePath(join(dir, `${row.id}.hb`));
            if (hbProbe.state === PROBE_PRESENT) heartbeatMtime = hbProbe.mtimeMs || 0;
            else if (hbProbe.state !== PROBE_ABSENT) {
                // Liveness sidecar unreadable: this record's freshness cannot
                // be judged, so it is not a sweep candidate at all.
                remaining++;
                continue;
            }
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
            // NOTHING ambiguous is ever swept. This loop deletes files, plants
            // tombstones and rewrites summary rows, so a record it cannot read
            // authoritatively (read fault, malformed JSON, duplicate top-level
            // id/closed/generation) is left EXACTLY as it is — not deleted, not
            // closed, not repaired, and never resolved by a last-wins
            // JSON.parse fallback or by the best-effort summary row (which may
            // describe a completely different generation of this id).
            if (raw == null) {
                remaining++;
                continue;
            }
            const record = readTopLevelLifecycleRecord(raw);
            if (isLifecycleUnreadable(record)) {
                remaining++;
                continue;
            }
            // OWNERSHIP: the record must name the id this row/file claims.
            // A foreign record (including a foreign TOMBSTONE that would look
            // perfectly mature) is preserved untouched — never deleted, never
            // closed, never upserted into the summary index under the wrong id.
            if (record.id !== row.id) {
                remaining++;
                continue;
            }
            // One strict parse for the whole record: every decision below reads
            // the SAME authoritative document (owner/status/timestamps/
            // messages), so there is no second, divergent parse of this file.
            const actual = record.doc;
            const diskClosed = record.closed === true || actual.status === 'closed';
            if (retainedLinkedAgent(actual)) {
                // Parent-owned agent transcripts are task history, not
                // ephemeral worker cache. This covers both new open sessions
                // and tombstones created by older Mixdog versions.
                remaining++;
                continue;
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
                if (!(row.closed === true || row.status === 'closed')) {
                    try { _queueSessionSummaryUpsert(actual); } catch { /* best-effort */ }
                }
                remaining++;
                continue;
            }
            // Parse the open record before its freshness gate: completed agents
            // use their provider's Advanced terminal duration rather than the
            // general sweep cadence. A short provider override must therefore
            // not be hidden behind the default 5-minute gate.
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
            // wrong session.
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
                // Blank-scratch exception to user-session permanence: a session
                // with ZERO user/assistant conversation (engine boot artifact,
                // force-killed window, crashed host) has nothing to preserve.
                // Relaunch storms otherwise pile hundreds of "(blank)" rows
                // that no sweep may touch. Reap once cold; liveness/heartbeat
                // vetoes inside deleteSession still protect an in-flight boot.
                const _msgsArr = Array.isArray(actual?.messages) ? actual.messages : null;
                const _convCount = _msgsArr
                    ? _msgsArr.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).length
                    : (Number(row.messageCount) || 0);
                const _blankLastActive = Math.max(effUpdatedAt, effLastHb, effCreatedAt, heartbeatMtime || 0);
                if (sweepIdle && _convCount === 0
                    && now - _blankLastActive > BLANK_SCRATCH_MAX_AGE_MS
                    && !(isSessionLive && isSessionLive(row.id))) {
                    try {
                        if (deleteSession(row.id, {
                            deferSummaryUpdate: true,
                            isSessionLive,
                            heartbeatSnapshotMtime: heartbeatMtime,
                            heartbeatFreshMs: BLANK_SCRATCH_MAX_AGE_MS,
                        })) {
                            openPruned++;
                            openPrunedDetails.push({ id: row.id, ageSeconds: Math.floor((now - _blankLastActive) / 1000) });
                            continue;
                        }
                    } catch { /* keep the row on failure */ }
                }
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
                const preCloseProbe = probePath(join(dir, `${row.id}.hb`));
                if (preCloseProbe.state === PROBE_PRESENT) preCloseHeartbeatMtime = preCloseProbe.mtimeMs || 0;
                else if (preCloseProbe.state !== PROBE_ABSENT) {
                    // Unknown liveness at the destructive edge: do not close.
                    remaining++;
                    continue;
                }
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
    // Orphan .hb/.own reap: a heartbeat/presence sidecar whose .json no longer
    // exists is dead weight once it is also stale (older than maxAge) — the
    // session JSON was swept/closed but the sidecar lingered (crashed owner or
    // pre-fix orphan). The staleness gate avoids nuking the sidecar of a
    // session mid-create whose .json write has not landed yet.
    try {
        for (const h of readdirSync(dir).filter(f => f.endsWith('.hb') || f.endsWith('.own'))) {
            yield undefined;
            // Only a PROVEN-absent session file makes its sidecar an orphan.
            if (!(probePath(join(dir, h.replace(/\.(hb|own)$/, '.json'))).state === PROBE_ABSENT)) continue;
            const sidecarProbe = probePath(join(dir, h));
            if (sidecarProbe.state !== PROBE_PRESENT) continue;
            const hbMtime = sidecarProbe.mtimeMs;
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

/** Synchronous compatibility surface for explicit maintenance commands/tests. */
export function sweepStaleSessions(ttlMs, options = {}) {
    const steps = sweepStaleSessionSteps(ttlMs, options);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

/**
 * Interactive-host sweep: preserve the exact synchronous lifecycle decisions
 * while yielding between records. A single large session remains atomic, but a
 * directory worth of reads/parses can no longer become one multi-second task.
 */
export async function sweepStaleSessionsCooperative(ttlMs, options = {}) {
    const cooperativeOptions = ttlMs && typeof ttlMs === 'object' ? ttlMs : options;
    const configuredSliceMs = Number(cooperativeOptions?.cooperativeSliceMs);
    const sliceMs = Number.isFinite(configuredSliceMs)
        ? Math.min(50, Math.max(0, configuredSliceMs))
        : 8;
    const steps = sweepStaleSessionSteps(ttlMs, options);
    let next = steps.next();
    while (!next.done) {
        const sliceStartedAt = performance.now();
        do {
            next = steps.next();
        } while (!next.done && performance.now() - sliceStartedAt < sliceMs);
        if (!next.done) {
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    return next.value;
}
