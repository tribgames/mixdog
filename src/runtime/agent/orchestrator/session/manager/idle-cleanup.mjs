// manager/idle-cleanup.mjs
// Periodic idle-session + tombstone sweep extracted verbatim from manager.mjs.
// Drives sweepStaleSessions on an unref'd interval; closeSession is imported
// from session-close.mjs (one-way dependency, no cycle).
import { sweepStaleSessions } from '../store.mjs';
import { sweepOrphanedPendingMessages } from './pending-messages.mjs';
import { _getRuntimeEntry, _clearSessionRuntime, _runtimeEntries } from './runtime-liveness.mjs';
import { _closeBashSessionLazy } from './runtime-loaders.mjs';
import { closeSession } from './session-close.mjs';
import { nonNegativeIntEnv } from './env-utils.mjs';

// --- Periodic idle session cleanup ---
const CLEANUP_INTERVAL_MS = nonNegativeIntEnv('MIXDOG_SESSION_CLEANUP_INTERVAL_MS', 5 * 60 * 1000); // check every 5 minutes
const CLEANUP_INITIAL_DELAY_MS = nonNegativeIntEnv('MIXDOG_SESSION_CLEANUP_INITIAL_DELAY_MS', CLEANUP_INTERVAL_MS > 0 ? CLEANUP_INTERVAL_MS : 0);
const CLEANUP_SLOW_LOG_MS = nonNegativeIntEnv('MIXDOG_SESSION_CLEANUP_SLOW_LOG_MS', 250);
const TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — far longer than any realistic ask race window
let _cleanupTimer = null;
let _cleanupInitialTimer = null;

function _previewIds(items, limit = 5) {
    const ids = (items || []).slice(0, limit).map((item) => item.id).filter(Boolean);
    if (ids.length === 0) return '';
    const more = items.length > limit ? `, +${items.length - limit} more` : '';
    return ` (${ids.join(', ')}${more})`;
}

function sweepIdleSessions({ includeTombstones = true } = {}) {
    const startedAt = Date.now();
    try {
        const result = sweepStaleSessions({
            tombstoneMaxAgeMs: includeTombstones ? TOMBSTONE_MAX_AGE_MS : 0,
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
                // Skip entries with an active in-flight controller — aborting
                // them via closeSession() is the safe path; clearing the runtime
                // without signalling the controller leaves orphan provider work.
                const rtEntry = _getRuntimeEntry(d.id);
                if (rtEntry && rtEntry.controller && !rtEntry.controller.signal?.aborted) {
                    try { closeSession(d.id, 'idle-sweep'); } catch { /* ignore */ }
                } else {
                    _clearSessionRuntime(d.id);
                    if (d.bashSessionId) {
                        try { _closeBashSessionLazy(d.bashSessionId, `idle-sweep:${d.id}`); } catch { /* ignore */ }
                    }
                }
                process.stderr.write(`[agent-session] idle cleanup: closed ${d.id} (idle ${d.idleMinutes}m, owner=${d.owner})\n`);
            }
            process.stderr.write(`[agent-session] idle sweep: cleaned ${cleaned} session(s), ${remaining} remaining\n`);
        }
        if (tombstonesCleaned > 0) {
            for (const d of tombstoneDetails) {
                if (d?.id) _clearSessionRuntime(d.id);
            }
            process.stderr.write(`[session-sweep] unlinked ${tombstonesCleaned} tombstone(s)${_previewIds(tombstoneDetails)}\n`);
        }
        if (tombstoneErrors.length > 0) {
            const first = tombstoneErrors[0];
            process.stderr.write(`[session-sweep] tombstone unlink failed for ${tombstoneErrors.length} session(s): ${first?.id || 'unknown'} ${first?.message || ''}\n`);
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed >= CLEANUP_SLOW_LOG_MS) {
            process.stderr.write(`[session-sweep] cleanup took ${elapsed}ms (idle=${cleaned}, tombstones=${tombstonesCleaned}, remaining=${remaining})\n`);
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
 * 24h is vastly safe. After the TTL expires we reclaim the disk slot.
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
        });
        for (const d of tombstoneDetails) {
            if (d?.id) _clearSessionRuntime(d.id);
        }
        if (tombstonesCleaned > 0) {
            process.stderr.write(`[session-sweep] unlinked ${tombstonesCleaned} tombstone(s)${_previewIds(tombstoneDetails)}\n`);
        }
        if (tombstoneErrors.length > 0) {
            const first = tombstoneErrors[0];
            process.stderr.write(`[session-sweep] tombstone unlink failed for ${tombstoneErrors.length} session(s): ${first?.id || 'unknown'} ${first?.message || ''}\n`);
        }
        return tombstonesCleaned;
    } catch (e) {
        process.stderr.write(`[session-sweep] tombstone sweep error: ${e && e.message || e}\n`);
        return 0;
    }
}

function hasActiveRuntimeWork() {
    for (const [, entry] of _runtimeEntries()) {
        if (!entry || entry.closed === true) continue;
        if (entry.controller && !entry.controller.signal?.aborted) return true;
        if (['connecting', 'requesting', 'streaming', 'tool_running', 'cancelling'].includes(entry.stage)) return true;
    }
    return false;
}

function _runCleanupCycle() {
    if (hasActiveRuntimeWork()) return;
    sweepOrphanedPendingMessages();
    sweepIdleSessions({ includeTombstones: true });
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
