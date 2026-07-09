// manager/session-close.mjs
// Session teardown extracted verbatim from manager.mjs. closeSession plants a
// disk tombstone (or bumps generation when tombstone=false), aborts the
// in-flight controller, tears down runtime/bash/dedup/offload/pending state,
// and defers the runtime-map clear. abortSessionTurn cancels the current turn
// without tombstoning.
import { loadSession, markSessionClosed, bumpSessionGeneration } from '../store.mjs';
import { clearReadDedupSession } from '../read-dedup.mjs';
import { clearOffloadSession } from '../tool-result-offload.mjs';
import { SessionClosedError } from './session-errors.mjs';
import { _dropPendingMessageState } from './pending-messages.mjs';
import { _stopToolActivityHeartbeat, _getRuntimeEntry, _clearSessionRuntime } from './runtime-liveness.mjs';
import { _closeBashSessionLazy } from './runtime-loaders.mjs';

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
    _stopToolActivityHeartbeat(id);
    // Prefer in-memory runtime session — allBashSessionIds may not be persisted
    // yet for shells opened in the current turn (BL-bash-disk-sync).
    const inMemory = _getRuntimeEntry(id)?.session;
    const persisted = inMemory || loadSession(id);
    const bashSessionId = persisted?.implicitBashSessionId || null;
    // Collect all persistent bash shells created during this session.
    const allBashIds = Array.isArray(persisted?.allBashSessionIds)
        ? persisted.allBashSessionIds.filter(Boolean)
        : (bashSessionId ? [bashSessionId] : []);
    // Deduplicate: allBashIds already covers implicitBashSessionId, but guard
    // against old session records that only have implicitBashSessionId.
    if (bashSessionId && !allBashIds.includes(bashSessionId)) allBashIds.push(bashSessionId);
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
    // 2. Mark runtime as closed so post-await validation in askSession fires.
    const entry = _getRuntimeEntry(id);
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
    for (const bsid of allBashIds) {
        try { _closeBashSessionLazy(bsid, `agent-close:${id}`); } catch { /* ignore */ }
    }
    // Drop session-scoped read dedup cache so the Map doesn't accumulate
    // entries across mcp-server lifetime.
    try { clearReadDedupSession(id); } catch { /* ignore */ }
    // Drop offload sidecars + module-level counter for this session so a
    // long-running mcp-server doesn't leak disk (tool-results/<id>/*.txt)
    // or Map entries across session lifetime. Fire-and-forget — close path
    // should not await disk IO; errors are swallowed inside.
    try { clearOffloadSession(id); } catch { /* ignore */ }
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
    return true;
}
