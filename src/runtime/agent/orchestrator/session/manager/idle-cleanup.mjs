// manager/idle-cleanup.mjs
// Periodic idle-session + tombstone sweep extracted verbatim from manager.mjs.
// Drives sweepStaleSessions on an unref'd interval; closeSession is imported
// from session-close.mjs (one-way dependency, no cycle).
import { sweepStaleSessions, evictIdleLiveSessions } from '../store.mjs';
import { sweepOrphanedPendingMessages } from './pending-messages.mjs';
import {
    _getRuntimeEntry,
    _clearSessionRuntime,
    _sweepTerminalSessionRuntimes,
} from './runtime-liveness.mjs';
import { _closeBashSessionLazy } from './runtime-loaders.mjs';
import { nonNegativeIntEnv } from './env-utils.mjs';

// --- Periodic idle session cleanup ---
const CLEANUP_INTERVAL_MS = nonNegativeIntEnv('MIXDOG_SESSION_CLEANUP_INTERVAL_MS', 5 * 60 * 1000); // check every 5 minutes
const CLEANUP_INITIAL_DELAY_MS = nonNegativeIntEnv('MIXDOG_SESSION_CLEANUP_INITIAL_DELAY_MS', CLEANUP_INTERVAL_MS > 0 ? CLEANUP_INTERVAL_MS : 0);
const CLEANUP_SLOW_LOG_MS = nonNegativeIntEnv('MIXDOG_SESSION_CLEANUP_SLOW_LOG_MS', 250);
// Tombstone unlink TTL. The guarded resurrection race (temp-write→rename inside
// _doSave) resolves in microseconds, so 1h is still vastly longer than any
// realistic in-flight ask race — while short enough that matured tombstones are
// reclaimed promptly instead of accumulating for a full day.
const TOMBSTONE_MAX_AGE_MS = 60 * 60 * 1000; // 1h
let _cleanupTimer = null;
let _cleanupInitialTimer = null;

// A session is "live" when it still owns a non-closed runtime entry. Passed to
// the retention cap so the active/current and any in-flight session is never
// pruned by the open-session max-age/max-count bounds.
function _isSessionLive(id) {
    const entry = _getRuntimeEntry(id);
    return !!(entry && entry.closed !== true);
}

function _previewIds(items, limit = 5) {
    const ids = (items || []).slice(0, limit).map((item) => item.id).filter(Boolean);
    if (ids.length === 0) return '';
    const more = items.length > limit ? `, +${items.length - limit} more` : '';
    return ` (${ids.join(', ')}${more})`;
}

const IN_FLIGHT_STAGES = new Set(['connecting', 'requesting', 'streaming', 'tool_running', 'cancelling']);

export function _finalizeSweptSessionRuntime(detail) {
    if (!detail?.id) return false;
    const rtEntry = _getRuntimeEntry(detail.id);
    // The store scan and this runtime cleanup are not atomic. If the session
    // became active after the scan, leave its controller and runtime untouched;
    // a later idle cycle can reconsider it after the work settles.
    if (rtEntry && (
        (rtEntry.controller && !rtEntry.controller.signal?.aborted)
        || IN_FLIGHT_STAGES.has(rtEntry.stage)
    )) return false;
    _clearSessionRuntime(detail.id);
    if (detail.bashSessionId) {
        try { _closeBashSessionLazy(detail.bashSessionId, `idle-sweep:${detail.id}`); } catch { /* ignore */ }
    }
    return true;
}

// Informational sweep telemetry is debug-gated: unconditional stderr writes
// land inside the interactive TUI and corrupt the composer/status line.
// Genuine sweep errors (catch paths) stay unconditional.
const _sweepLog = (line) => {
    if (process.env.MIXDOG_DEBUG_SESSION_LOG) process.stderr.write(line);
};

function sweepIdleSessions({ includeTombstones = true, sweepIdle = true } = {}) {
    const startedAt = Date.now();
    try {
        const result = sweepStaleSessions({
            sweepIdle,
            tombstoneMaxAgeMs: includeTombstones ? TOMBSTONE_MAX_AGE_MS : 0,
            isSessionLive: _isSessionLive,
        });
        const {
            cleaned,
            remaining,
            details,
            tombstonesCleaned = 0,
            tombstoneDetails = [],
            tombstoneErrors = [],
        } = result;
        if (cleaned > 0) {
            for (const d of details) {
                if (!_finalizeSweptSessionRuntime(d)) continue;
                _sweepLog(`[agent-session] idle cleanup: closed ${d.id} (idle ${d.idleMinutes}m, owner=${d.owner})\n`);
            }
            _sweepLog(`[agent-session] idle sweep: cleaned ${cleaned} session(s), ${remaining} remaining\n`);
        }
        if (tombstonesCleaned > 0) {
            for (const d of tombstoneDetails) {
                if (d?.id && !_isSessionLive(d.id)) _clearSessionRuntime(d.id);
            }
            _sweepLog(`[session-sweep] unlinked ${tombstonesCleaned} tombstone(s)${_previewIds(tombstoneDetails)}\n`);
        }
        if (tombstoneErrors.length > 0) {
            const first = tombstoneErrors[0];
            _sweepLog(`[session-sweep] tombstone unlink failed for ${tombstoneErrors.length} session(s): ${first?.id || 'unknown'} ${first?.message || ''}\n`);
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed >= CLEANUP_SLOW_LOG_MS) {
            _sweepLog(`[session-sweep] cleanup took ${elapsed}ms (idle=${cleaned}, tombstones=${tombstonesCleaned}, remaining=${remaining})\n`);
        }
    } catch (e) {
        process.stderr.write(`[agent-session] idle sweep error: ${e && e.message || e}\n`);
    }
}

/**
 * Unlink tombstone session files (closed=true) older than TOMBSTONE_MAX_AGE_MS.
 *
 * Rationale: closeSession() leaves the tombstone on disk as the authoritative
 * resurrection-blocker for racing saveSession() calls. That race resolves in
 * microseconds (the window inside _doSave between temp write and rename), so
 * 1h is vastly safe. After the TTL expires we reclaim the disk slot.
 *
 * Uses `getStoredSessionsRaw()` rather than `listStoredSessions()` because the
 * latter's inline 30-min idle cleanup would race-unlink tombstones before we
 * get to log them — we want to own the unlink decision and stderr line here.
 */
export function sweepTombstones() {
    try {
        const { tombstonesCleaned = 0, tombstoneDetails = [], tombstoneErrors = [] } = sweepStaleSessions({
            sweepIdle: false,
            tombstoneMaxAgeMs: TOMBSTONE_MAX_AGE_MS,
            isSessionLive: _isSessionLive,
        });
        for (const d of tombstoneDetails) {
            if (d?.id && !_isSessionLive(d.id)) _clearSessionRuntime(d.id);
        }
        if (tombstonesCleaned > 0) {
            _sweepLog(`[session-sweep] unlinked ${tombstonesCleaned} tombstone(s)${_previewIds(tombstoneDetails)}\n`);
        }
        if (tombstoneErrors.length > 0) {
            const first = tombstoneErrors[0];
            _sweepLog(`[session-sweep] tombstone unlink failed for ${tombstoneErrors.length} session(s): ${first?.id || 'unknown'} ${first?.message || ''}\n`);
        }
        return tombstonesCleaned;
    } catch (e) {
        process.stderr.write(`[session-sweep] tombstone sweep error: ${e && e.message || e}\n`);
        return 0;
    }
}

export function _runCleanupCycle() {
    // Drain every settled runtime entry on each pass, not just the one or two
    // sessions whose on-disk idle TTL happened to expire in this interval.
    _sweepTerminalSessionRuntimes();
    sweepOrphanedPendingMessages();
    sweepIdleSessions({ includeTombstones: true });
    // Reclaim same-process session snapshots whose state is durable on disk
    // (memory-leak guard: _liveSessions used to grow for process lifetime).
    try { evictIdleLiveSessions({ isSessionLive: _isSessionLive }); } catch { /* best-effort */ }
}

function _startCleanupInterval() {
    if (_cleanupTimer) return;
    if (CLEANUP_INTERVAL_MS <= 0) return;
    _cleanupTimer = setInterval(_runCleanupCycle, CLEANUP_INTERVAL_MS);
    if (_cleanupTimer.unref) _cleanupTimer.unref(); // don't block process exit
}

export function startIdleCleanup() {
    if (_cleanupTimer || _cleanupInitialTimer) return;
    if (CLEANUP_INITIAL_DELAY_MS <= 0) {
        _runCleanupCycle();
        _startCleanupInterval();
        return;
    }
    _cleanupInitialTimer = setTimeout(() => {
        _cleanupInitialTimer = null;
        _runCleanupCycle();
        _startCleanupInterval();
    }, CLEANUP_INITIAL_DELAY_MS);
    if (_cleanupInitialTimer.unref) _cleanupInitialTimer.unref();
}

export function stopIdleCleanup() {
    if (_cleanupInitialTimer) {
        clearTimeout(_cleanupInitialTimer);
        _cleanupInitialTimer = null;
    }
    if (_cleanupTimer) {
        clearInterval(_cleanupTimer);
        _cleanupTimer = null;
    }
}
