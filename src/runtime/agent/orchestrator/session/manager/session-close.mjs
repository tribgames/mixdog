// manager/session-close.mjs
// Session teardown extracted verbatim from manager.mjs. closeSession plants a
// disk tombstone (or bumps generation when tombstone=false), aborts the
// in-flight controller, tears down runtime/bash/dedup/offload/pending state,
// and defers the runtime-map clear. abortSessionTurn cancels the current turn
// without tombstoning.
import { loadSession, markSessionClosed, bumpSessionGeneration, getSessionLifecycleCommitError } from '../store.mjs';
import { clearReadDedupSession } from '../read-dedup.mjs';
import { SessionClosedError } from './session-errors.mjs';
import { _dropPendingMessageState } from './pending-messages.mjs';
import { _stopToolActivityHeartbeat, _getRuntimeEntry, _clearSessionRuntime } from './runtime-liveness.mjs';
import { clearTurnCheckpoint } from './turn-checkpoint.mjs';
import { releaseReadSnapshotScope } from '../../tools/builtin/snapshot-store.mjs';

/**
 * Close a session. Plants a `closed=true` tombstone on disk with a bumped
 * generation (so any racing saveSession() drops its write), aborts the
 * in-flight controller if one exists, and clears the in-memory runtime entry.
 *
 * IMPORTANT: we deliberately do NOT unlink the session file here. The tombstone
 * on disk is the authoritative signal that blocks resurrection — a late
 * saveSession() re-reads disk via _shouldDrop() and will find the tombstone.
 * If we delete the file, a late save sees no file, decides nothing to drop,
 * and recreates the session in its pre-close state.
 *
 * Long-term cleanup: `sweepTombstones()` below unlinks tombstones older than
 * TOMBSTONE_MAX_AGE_MS (1h — vastly longer than the microsecond in-flight race).
 */
export function closeSession(id, reason = 'manual', opts = {}) {
    // tombstone=false: detach runtime resources (heartbeat, bash shells,
    // controller abort, runtime-map clear) WITHOUT planting the disk
    // tombstone. Used for non-empty sessions on /resume-away, /new, and
    // TUI exit — previously every one of those paths unconditionally
    // tombstoned the outgoing session, which made it vanish from the
    // Resume list immediately and get hard-deleted by sweepTombstones()
    // after 24h even though it had real conversation content worth
    // resuming. Only truly-empty scratch sessions should still tombstone.
    const tombstone = opts.tombstone !== false;
    if (!id) return false;
    const entry = _getRuntimeEntry(id);
    // askSession owns the interruption tracker that can merge committed
    // iterations, the current partial response, and observed tool results into
    // one canonical transcript. Finalize that in-memory snapshot synchronously
    // BEFORE the lifecycle generation changes; once generation is bumped, the
    // normal cancellation cleanup save is intentionally rejected as stale.
    try { entry?.prepareCloseSnapshot?.(reason); } catch { /* best-effort */ }
    _stopToolActivityHeartbeat(id);
    // 1. Tombstone first — this wins the race against saveSession().
    //    Skipped when tombstone=false: no closed:true marker is planted, so
    //    the session file stays intact and resumeSession() will accept it.
    //    We still bump the on-disk generation via bumpSessionGeneration() —
    //    that alone is what protects the session from a late save race: any
    //    saveSession() still in flight from this detached turn (e.g. the
    //    cancel-cleanup save below) carries the OLD generation as its
    //    expectedGeneration, so _shouldDrop()'s ownership-counter rule drops
    //    it once disk generation moves past that. Without this bump the late
    //    write could silently overwrite the session after the user resumes
    //    it back (BL: burned-session late-save clobber).
    const newGen = tombstone ? markSessionClosed(id, reason) : bumpSessionGeneration(id, reason);
    // Durable lifecycle barrier check. `null` is ambiguous — it covers both a
    // legitimate veto (session gone, live owner, contended commit) and a
    // FAILED durable write. Only the latter publishes a lifecycle commit
    // error. When the barrier never landed there is no tombstone and no
    // generation bump on disk, so nothing fences a late save: tearing down
    // here would abort the provider and clear the crash checkpoint while the
    // session remains open and resumable on disk — the exact way a failed
    // close silently destroys a turn. Leave every runtime structure intact,
    // surface the cause, and report failure to the caller.
    // ANY nonnumeric result means the barrier is not on disk — a write
    // failure, a liveness/ownership veto, a contended commit lock, or a
    // missing record. The detail map only explains WHY when the cause was a
    // failed write; its absence is not evidence of success. Treating a
    // detail-less null as a close is what let a vetoed/failed close abort the
    // provider and drop the crash checkpoint while the session stayed open and
    // resumable on disk. Leave every runtime structure intact and report
    // failure in all of them.
    if (typeof newGen !== 'number') {
        const commitError = getSessionLifecycleCommitError(id);
        const detail = commitError
            ? `${commitError.message}${commitError.code ? ` (${commitError.code})` : ''}`
            : 'no durable barrier written (veto, contended commit, or missing record)';
        if (entry) {
            entry.lastError = `session close failed: ${detail}`;
            entry.closeBarrierError = commitError || { message: detail, code: null, reason, at: Date.now() };
        }
        try {
            process.stderr.write(
                `[agent-close] session=${id} reason=${reason} tombstone=${tombstone} `
                + `FAILED durable lifecycle barrier: ${detail}\n`,
            );
        } catch { /* best-effort */ }
        return false;
    }
    // prepareCloseSnapshot was folded into the synchronous generation write
    // above. Only now is it safe to remove the crash fallback.
    clearTurnCheckpoint(id);
    // 2. Mark runtime as closed so post-await validation in askSession fires.
    if (entry) {
        entry.closed = true;
        entry.closedReason = reason;
        if (typeof newGen === 'number') entry.generation = newGen;
        entry.stage = 'cancelling';
        entry.updatedAt = Date.now();
        // 3. Abort the in-flight controller. Providers that honour the signal
        //    unwind immediately; providers that don't will still be caught by
        //    the generation check after their await eventually returns.
        try { entry.controller?.abort(new SessionClosedError(id, `closeSession (reason=${reason})`, reason)); } catch { /* ignore */ }
    }
    try { globalThis.__mixdogCloseProviderConnectionsForSession?.(id, `session-close:${reason}`); } catch { /* ignore */ }
    // Diagnostic: one-line stderr so operators can distinguish the four close
    // pathways (request-abort / manual / idle-sweep / runner-crash). iterCount
    // is not currently tracked on runtime state; askStartedAt is — derive
    // duration from it when present.
    try {
        const askStartedAt = entry?.askStartedAt;
        const durationMs = (typeof askStartedAt === 'number') ? (Date.now() - askStartedAt) : null;
        const parts = [`session=${id}`, `reason=${reason}`, `tombstone=${tombstone}`];
        if (durationMs != null) parts.push(`duration=${durationMs}ms`);
        if (process.env.MIXDOG_DEBUG_SESSION_LOG) process.stderr.write(`[agent-close] ${parts.join(' ')}\n`);
    } catch { /* best-effort */ }
    // Drop session-scoped read dedup cache so the Map doesn't accumulate
    // entries across mcp-server lifetime.
    try { clearReadDedupSession(id); } catch { /* ignore */ }
    try { releaseReadSnapshotScope(id); } catch { /* ignore */ }
    // Artifact lifetime follows the durable transcript, not the live runtime.
    // Tombstone/explicit deletion cleanup removes it only after session data
    // itself is gone.
    // Drop the in-memory pending-message queue and any buffered-persist entry
    // for this session — otherwise both Maps accumulate one entry per closed
    // session for the life of the mcp-server.
    _dropPendingMessageState(id, { clearPersisted: tombstone });
    // 4. Defer runtime map clear to next tick so any settling askSession can
    //    observe `closed=true` / bumped generation before we yank the entry.
    //    Disk tombstone remains — that's what blocks resurrection.
    setImmediate(() => {
        _clearSessionRuntime(id);
    });
    return true;
}
export function abortSessionTurn(id, reason = 'turn-abort') {
    if (!id) return false;
    _stopToolActivityHeartbeat(id);
    const entry = _getRuntimeEntry(id);
    if (!entry || entry.closed) return false;
    entry.stage = 'cancelling';
    entry.closedReason = reason;
    entry.updatedAt = Date.now();
    try {
        entry.controller?.abort(new SessionClosedError(id, `abortSessionTurn (reason=${reason})`, reason));
    } catch { /* ignore */ }
    try { globalThis.__mixdogCloseProviderConnectionsForSession?.(id, `turn-abort:${reason}`); } catch { /* ignore */ }
    return true;
}

// Stages that still own live provider/tool work. An entry in one of them is
// never unloaded — the caller's "this agent finished" belief lost a race.
const _UNLOAD_BLOCKED_STAGES = new Set([
    'connecting', 'requesting', 'streaming', 'tool_running', 'cancelling',
]);

/**
 * Runtime-only unload for a session whose work is DONE.
 *
 * Releases the heavy process-local runtime a finished agent still pins —
 * pooled provider connections, the read-dedup cache, and the liveness/metric
 * runtime entry — WITHOUT
 * touching lifecycle state. Deliberately NOT a close:
 *   - no markSessionClosed() tombstone and no bumpSessionGeneration(): the
 *     session file stays open and resumable, so a same-tag follow-up
 *     (`agent type=send`) resumes the SAME session with its full transcript
 *     instead of respawning a fresh one through tombstone absorption;
 *   - no controller abort: an unload never cancels work, it only reclaims
 *     what a settled turn left behind;
 *   - offload sidecars, the turn checkpoint and persisted pending messages
 *     are left intact — they are the follow-up turn's context, not runtime.
 * Terminal ownership stays with the caller's own reap path (agent-tool
 * scheduleReap → closeSession('terminal-reap')).
 *
 * Returns false (changing nothing) when the session is still in flight.
 */
export function unloadSessionRuntime(id, reason = 'runtime-unload') {
    if (!id) return false;
    const entry = _getRuntimeEntry(id);
    // Liveness veto: an unaborted controller or a non-settled stage means the
    // session still owns provider/tool work. Unloading under it would kill the
    // shells and connections of a running turn.
    //
    // `closed === true` is NOT an exemption. closeSession() flips closed and
    // sets stage='cancelling' while the provider call is still unwinding (it
    // defers _clearSessionRuntime to the next tick precisely because the turn
    // has not settled yet), and a close whose durable barrier failed leaves an
    // unaborted controller behind. Both are live work: veto and touch nothing.
    if (entry) {
        if (entry.controller && !entry.controller.signal?.aborted) return false;
        if (_UNLOAD_BLOCKED_STAGES.has(entry.stage)) return false;
    }
    _stopToolActivityHeartbeat(id);
    try { globalThis.__mixdogCloseProviderConnectionsForSession?.(id, `runtime-unload:${reason}`); } catch { /* ignore */ }
    // Pure caches — a resumed turn rebuilds them from the transcript/disk.
    try { clearReadDedupSession(id); } catch { /* ignore */ }
    try { releaseReadSnapshotScope(id); } catch { /* ignore */ }
    _clearSessionRuntime(id);
    if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
        try { process.stderr.write(`[agent-unload] session=${id} reason=${reason}\n`); } catch { /* best-effort */ }
    }
    return true;
}
