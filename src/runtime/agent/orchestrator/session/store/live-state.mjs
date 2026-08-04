import { sanitizeContentForStoredHistory } from '../../providers/media-normalization.mjs';

export const _lastSaveError = new Map(); // id -> { message, at }

/** Same-process authoritative session snapshots (createSession → loadSession / askSession). */
export const _liveSessions = new Map();

// Session ids whose most recent save attempt was DROPPED by the ownership
// guard (_shouldDrop: disk generation moved past the caller's expected
// generation) or failed outright. For these ids the local live snapshot is
// AHEAD of disk — the on-disk transcript froze at the last landed save — so
// it must not be evicted (data loss) nor shadowed by the stale disk copy.
export const _droppedSaveIds = new Set();

// ── Save identity (epoch) ───────────────────────────────────────────────────
// Every save ATTEMPT takes a monotonically increasing epoch when it is issued.
// A failure/drop records the epoch of the state that never landed, so only a
// save at least that new may clear the id-wide error/drop markers. Without it
// an OLDER worker write landing after a NEWER sync/async failure cleared the
// markers, un-pinning (and then evicting) the only copy of the newest turn.
let _saveEpochSeq = 0;
const _failureEpochs = new Map(); // id -> epoch of the newest failed/dropped save
// The EXACT snapshot whose own save failed in this process, per id. This is
// the only evidence that may let an in-memory object stand in for an
// unreadable canonical file (see loadSession's read-after-failure contract):
// "some live/pending object exists for this id" proves nothing about disk,
// while "THIS object's write to disk failed" proves the bytes never landed
// and that this copy is strictly newer than whatever the file holds. Lives
// exactly as long as _lastSaveError (cleared by the next landed save).
// Stored as an IMMUTABLE point-in-time clone (see _failedSaveClone), never the
// live reference.
const _failedSaveSnapshots = new Map(); // id -> frozen-in-time session copy

export function _nextSaveEpoch() {
    return ++_saveEpochSeq;
}

// ── Save outcomes ───────────────────────────────────────────────────────────
// A refused write is NOT one thing: an ownership/cancellation drop means this
// process holds state disk does not (pin it, flag the split-brain), while a
// stale-epoch refusal means a strictly NEWER write already landed — nothing
// was lost, so no marker may move and the snapshot stays immediately
// evictable. Every save path reports which one happened.
export const SAVE_OUTCOME_SAVED = 'saved';
export const SAVE_OUTCOME_DROPPED = 'dropped';
export const SAVE_OUTCOME_STALE = 'stale';

// ── Session incarnations ────────────────────────────────────────────────────
// Work (worker write, queued payload, parked snapshot, in-process save) is
// stamped with the OBJECT identifying the id's current incarnation. A
// successful hard delete retires that object; a re-created id mints a brand
// new one. Identity comparison — not a counter — is what makes this exact:
// no wrap, no reset, no reuse, so pre-delete work can never look current
// again, however many deletes happen and however often an id is reused.
//
// Entries are pinned while work references them; the (generous) cap only ever
// evicts UNREFERENCED entries, and an evicted entry can at worst make some
// later settlement inert — never make stale work current.
let _incarnationSeq = 0;
const _sessionIncarnations = new Map(); // id -> { id, token, refs }
const SESSION_INCARNATION_MAX = 4096;

function _evictSessionIncarnations() {
    if (_sessionIncarnations.size <= SESSION_INCARNATION_MAX) return;
    for (const [key, incarnation] of _sessionIncarnations) {
        if (_sessionIncarnations.size <= SESSION_INCARNATION_MAX) break;
        if (incarnation.refs > 0) continue; // still referenced by outstanding work
        _sessionIncarnations.delete(key);
    }
}

// Strict diagnostics: a release without a matching acquire is a BUG, not a
// clamp. Tests assert this stays zero instead of relying on the clamp.
let _incarnationReleaseUnderflows = 0;

export function _sessionIncarnationStats() {
    return {
        size: _sessionIncarnations.size,
        max: SESSION_INCARNATION_MAX,
        releaseUnderflows: _incarnationReleaseUnderflows,
    };
}

/** Stamp for a new unit of work; keeps the incarnation alive until released. */
export function _acquireSessionIncarnation(id) {
    if (!id) return null;
    let incarnation = _sessionIncarnations.get(id);
    if (incarnation) _sessionIncarnations.delete(id);
    else incarnation = { id, token: ++_incarnationSeq, refs: 0 };
    incarnation.refs += 1;
    _sessionIncarnations.set(id, incarnation); // LRU touch
    _evictSessionIncarnations();
    return incarnation;
}

export function _releaseSessionIncarnation(incarnation) {
    if (!incarnation) return;
    if (incarnation.refs > 0) incarnation.refs -= 1;
    else _incarnationReleaseUnderflows += 1; // double release — surfaced, not hidden
    // The cap is enforced on RELEASE too: a token that just became
    // unreferenced is exactly the one eviction is allowed to reclaim.
    if (incarnation.refs === 0) _evictSessionIncarnations();
}

/** Diagnostics/tests: outstanding references to an id's incarnation. */
export function _sessionIncarnationRefs(id) {
    const incarnation = id && _sessionIncarnations.get(id);
    return incarnation ? incarnation.refs : 0;
}

/** False once the id was hard-deleted (or re-created) after this stamp. */
export function _isCurrentSessionIncarnation(id, incarnation) {
    if (!incarnation) return true; // unstamped work keeps its legacy behavior
    return _sessionIncarnations.get(id) === incarnation;
}

/**
 * Retire an id's incarnation on a SUCCESSFUL hard delete. The object is
 * dropped from the registry and never handed out again: outstanding work that
 * still holds it is permanently non-current, and a re-created id gets a fresh
 * object of its own.
 */
export function _retireSessionIncarnation(id) {
    if (id) _sessionIncarnations.delete(id);
}

/** Clear every save marker for an id (successful hard delete). */
export function _clearSessionSaveState(id) {
    if (!id) return;
    _lastSaveError.delete(id);
    _failureEpochs.delete(id);
    // The recovery evidence dies with the file it was evidence ABOUT: a
    // re-created id must never inherit the deleted incarnation's snapshot
    // (that would resurrect a deleted transcript as the "only good copy").
    _failedSaveSnapshots.delete(id);
    _droppedSaveIds.delete(id);
}

function _markFailureEpoch(id, epoch) {
    // An unknown epoch is treated as "newest": callers without an identity
    // must never weaken the marker.
    const value = Number.isFinite(epoch) ? epoch : _nextSaveEpoch();
    const previous = _failureEpochs.get(id);
    if (previous === undefined || value > previous) _failureEpochs.set(id, value);
}

export function setLiveSession(session) {
    if (!session?.id) return;
    _liveSessions.set(session.id, session);
}

export function _clearLiveSession(id) {
    if (id) _liveSessions.delete(id);
}

// Live snapshots that still carry raw media bytes (images are placeholder'd
// in the persisted JSON) stay resident for this long after their last use so
// multi-turn image recognition keeps working across an idle gap. Beyond the
// TTL the memory cost wins and the snapshot is reclaimed like any other.
export const LIVE_MEDIA_RETENTION_MS = 60 * 60 * 1000; // 1h

export function _messagesCarryLiveMedia(messages) {
    if (!Array.isArray(messages)) return false;
    for (const m of messages) {
        if (!m || typeof m !== 'object') continue;
        if (sanitizeContentForStoredHistory(m.content) !== m.content) return true;
    }
    return false;
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
    _failureEpochs.delete(id);
    _failedSaveSnapshots.delete(id);
}

/**
 * Record a failed atomic save. The disk copy is now BEHIND this process's live
 * snapshot, so the id is flagged on BOTH channels:
 *  - _lastSaveError: surfaced to callers (getSessionSaveError) and used by the
 *    idle sweep / loadSession to keep the only-good in-memory state readable.
 *  - _droppedSaveIds: the existing "disk is behind the snapshot" marker, so a
 *    stale/lower-generation disk record cannot shadow the live transcript.
 * Both are cleared by the next successful save (clearSessionSaveError +
 * _droppedSaveIds.delete in the store's commit path).
 */
/**
 * Point-in-time COPY of the exact payload whose save failed.
 *
 * Never the live reference: the caller keeps mutating that object (the next
 * turn appends messages, status flips, the turn hook is re-attached), and a
 * fallback read must reproduce what the failed write actually attempted —
 * not a later state that was never offered to disk and is not backed by any
 * failure evidence. The JSON round-trip detaches every nested container and
 * drops functions/symbols (turn hooks), so no later mutation can reach it.
 * An unclonable payload (circular ref) records NO evidence: readers then
 * report the unreadable file instead of masking it.
 */
function _failedSaveClone(session) {
    try {
        const clone = JSON.parse(JSON.stringify(session));
        return clone && typeof clone === 'object' && !Array.isArray(clone) ? clone : null;
    } catch {
        return null;
    }
}

export function _recordSaveFailure(id, err, epoch = null, session = null) {
    if (!id) return;
    _lastSaveError.set(id, { message: err?.message ?? String(err), at: Date.now() });
    _droppedSaveIds.add(id);
    _markFailureEpoch(id, epoch);
    // Only a snapshot that IS this id's failed payload is retained; a caller
    // without one records no recovery evidence at all (readers then report the
    // unreadable file instead of masking it).
    if (session && session.id === id) {
        const clone = _failedSaveClone(session);
        if (clone && clone.id === id) _failedSaveSnapshots.set(id, clone);
    }
}

/**
 * The in-memory snapshot whose own save failed for `id`, or null.
 * Deliberately NOT "the live session for id": it is the narrow proof that a
 * same-process copy is newer than the canonical file.
 */
export function getFailedSaveSnapshot(id) {
    if (!id) return null;
    const snapshot = _failedSaveSnapshots.get(id);
    if (!snapshot) return null;
    // Hand out a COPY as well: a reader that mutates what it got back (every
    // session consumer does) must not be able to edit the stored evidence.
    return _failedSaveClone(snapshot);
}

/**
 * Record an ownership-DROPPED save (nothing was written, disk moved past this
 * snapshot). Same identity rule as a failure: an older landed write may not
 * clear it.
 */
export function _recordSaveDrop(id, epoch = null) {
    if (!id) return;
    _droppedSaveIds.add(id);
    _markFailureEpoch(id, epoch);
}

/**
 * Clear the id's failure/drop markers on behalf of a LANDED save — but only
 * when that save is at least as new as the newest recorded failure/drop.
 * Returns whether the markers were cleared.
 */
export function _clearSaveStateIfCurrent(id, epoch = null) {
    if (!id) return false;
    const marked = _failureEpochs.get(id);
    if (marked !== undefined && Number.isFinite(epoch) && epoch < marked) return false;
    _failureEpochs.delete(id);
    _lastSaveError.delete(id);
    _failedSaveSnapshots.delete(id);
    _droppedSaveIds.delete(id);
    return true;
}

/** True while this process's last save attempt for `id` failed. */
export function hasSessionSaveFailure(id) {
    return !!id && _lastSaveError.has(id);
}

// ── Lifecycle (tombstone/detach) commit failures ────────────────────────────
// markSessionClosed/bumpSessionGeneration return null for BOTH a legitimate
// veto (session gone, liveness veto, contended commit lock) and a genuine
// durable-write failure. closeSession must react very differently to the two:
// a failed lifecycle barrier means NOTHING was fenced on disk, so tearing the
// runtime down would strand a live turn behind an un-planted tombstone. This
// map is the disambiguator — set only on a real commit failure, cleared when
// the barrier lands.
const _lifecycleCommitErrors = new Map(); // id -> { message, at, code, reason }

export function _recordLifecycleCommitFailure(id, err, reason = null) {
    if (!id) return;
    _lifecycleCommitErrors.set(id, {
        message: err?.message ?? String(err),
        code: err?.code ?? null,
        reason,
        at: Date.now(),
    });
}

export function getSessionLifecycleCommitError(id) {
    return _lifecycleCommitErrors.get(id) ?? null;
}

export function clearSessionLifecycleCommitError(id) {
    _lifecycleCommitErrors.delete(id);
}
