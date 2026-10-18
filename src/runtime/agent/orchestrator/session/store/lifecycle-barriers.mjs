/**
 * Durable lifecycle barriers: the tombstone plant (markSessionClosed) and the
 * non-tombstoning detach bump (bumpSessionGeneration). Both rewrite the
 * canonical record under their OWN authority read and the commit lock, so
 * they bypass the save queue entirely — that is why they live apart from the
 * write pipeline — and both fence late saves through the generation counter.
 */
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getPluginData } from '../../config.mjs';
import { PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../../../../../lib/mixdog-debug.cjs';
import { createAsyncLogAppender } from '../../../../shared/async-log-appender.mjs';
import { sessionPath } from './session-paths.mjs';
import {
  readCanonicalSessionRecord as _readCanonicalRecord,
  CANONICAL_RECORD_UNREADABLE as LIFECYCLE_AMBIGUOUS,
  stampSessionScratch as _stampSessionScratch,
  lifecycleOfSessionDocument as _lifecycleOfSessionDocument,
} from './canonical-reader.mjs';
import {
  guardedSaveOptions as _guardedSaveOptions,
  cancelSessionWrites as _cancelSessionWrites,
  acquireWriteCommit as _acquireWriteCommit,
  releaseWriteCommit as _releaseWriteCommit,
} from './write-guards.mjs';
import { _sessionForDisk } from './serialize.mjs';
import {
  _commitSessionWrite,
  _commitSessionWriteAttempt,
  _discardSaveTmp,
  _trackSaveTmp,
  _untrackSaveTmp,
} from './save-fault.mjs';
import { sleep } from '../../../../shared/sleep.mjs';
import {
  _droppedSaveIds,
  _clearLiveSession,
  clearSessionSaveError,
  _recordSaveFailure,
  _recordLifecycleCommitFailure,
  clearSessionLifecycleCommitError,
} from './live-state.mjs';
import { _uncacheSessionSummary, _queueSessionSummaryUpsert } from './summary-cache.mjs';
import { _savePending, _clearDebounce } from './pending-saves.mjs';
import { _runtimeLivenessVeto } from './liveness-veto.mjs';
import { loadSession } from './load-session.mjs';

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

// Agent cancel/close must survive the worker-index drop: the pool summary
// reads cancelStatus even when the row is already gone. `requested` is the
// close path's OWN answer about the kill (see closeSession): an unconfirmed
// stop must reach disk instead of the default confirmed `cancelled`, and a
// later re-stamp must never downgrade it.
function _cancelStatusFields(base, reason, requested, closeTime) {
  if (!_CANCEL_CLOSE_REASON.test(String(reason || '').trim()) && !_cleanCancelStatus(requested)) return {};
  return {
    cancelStatus: _mergeCancelStatus(base.cancelStatus, requested),
    cancelledAt: base.cancelledAt || closeTime,
  };
}

/**
 * Durable authority for a lifecycle barrier, read under the commit lock
 * BEFORE any disruption. The barrier rewrites the canonical file, so the bytes
 * it is derived from must be provably ours: a duplicate/ambiguous/foreign/
 * identity-less record is NEVER re-serialized through a lenient parse or
 * replaced from live memory. The barrier is refused and the cause surfaced,
 * exactly like a failed commit (closeSession must not report a close that
 * never fenced anything). Returns LIFECYCLE_AMBIGUOUS on refusal, else the
 * record (null when absent).
 *
 * `lifecycleOnly` is for a barrier that derives nothing from the disk document
 * (the detach bump rewrites `loadSession`'s copy): the verdict then comes from
 * this realm's own-commit stamp when the canonical file is exactly our last
 * rename, and otherwise from the same strict read of the current bytes. Never
 * from the settled-stamp cache — this is a final write authority, exactly like
 * _shouldDrop.
 */
function _readLifecycleAuthority(id, reason, action, lifecycleOnly = false) {
  const authority = lifecycleOnly
    ? _readCanonicalRecord(sessionPath(id), true, { ownCommitsOnly: true })
    : _readCanonicalRecord(sessionPath(id));
  if (authority === LIFECYCLE_AMBIGUOUS || (authority && authority.id !== id)) {
    const err = new Error(`[session-store] ${id}: refusing to ${action} — canonical record is unreadable or foreign`);
    err.code = 'ELIFECYCLEUNREADABLE';
    _recordLifecycleCommitFailure(id, err, reason);
    return LIFECYCLE_AMBIGUOUS;
  }
  return authority;
}

/** Commit a barrier record, bypassing the save queue + guard. False when it did not land.
 *  `attempt` (a number) commits with ONE rename of the retry schedule: a
 *  retryable refusal with attempts left discards the scratch file, records
 *  nothing and returns a retry ({ retryInMs }) instead of sleeping. */
function _writeLifecycleRecord(id, record, existing, reason, attempt = null) {
  const target = sessionPath(id);
  const tmp = _trackSaveTmp(`${target}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const disk = _sessionForDisk(record);
    writeFileSync(tmp, JSON.stringify(disk), 'utf-8');
    const scratch = _stampSessionScratch(tmp);
    if (attempt === null) _commitSessionWrite(tmp, target, id);
    else {
      const retryInMs = _commitSessionWriteAttempt(tmp, target, id, attempt);
      if (retryInMs !== null) {
        _discardSaveTmp(tmp);
        return { retryInMs };
      }
    }
    // Read-only lifecycle checks (pending-message gates right after a close/
    // detach) reuse what this barrier wrote; write authority still re-reads.
    _readCanonicalRecord.rememberOwnBarrier(target, scratch, _lifecycleOfSessionDocument(disk));
    _untrackSaveTmp(tmp);
    return true;
  } catch (err) {
    // The durable lifecycle barrier did NOT land: no tombstone, no
    // generation bump, nothing fencing a late save. Same contract as a
    // failed session save — reclaim the scratch file, pin the live
    // snapshot (non-evictable, not shadowed by the stale disk copy) and
    // publish the cause so closeSession refuses to report success.
    _discardSaveTmp(tmp);
    _recordSaveFailure(id, err, null, existing);
    _recordLifecycleCommitFailure(id, err, reason);
    return false;
  }
}

// Structured close metric. Single emission point because every close path
// funnels through markSessionClosed. lifeMs = updatedAt-createdAt straddles
// the tombstone (updatedAt was just set to Date.now()), so it reflects the
// session's full lifetime including the close turn.
const closeMetricLog = createAsyncLogAppender({ maxBytes: PLUGIN_LOG_MAX_BYTES, keepBytes: PLUGIN_LOG_KEEP_BYTES });

/** Resolves once every queued session-close metric line is written. */
export function flushSessionCloseMetrics() {
  return closeMetricLog.flush();
}

function _logSessionCloseMetric(id, existing, closedAt, reason) {
  try {
    const dataDir = getPluginData();
    if (!dataDir) return;
    const ts = new Date().toISOString();
    const lifeMs = typeof existing.createdAt === 'number' && existing.createdAt > 0 ? closedAt - existing.createdAt : 0;
    const agent = existing.agent || '-';
    const owner = existing.owner || '-';
    // Queued, not written inline: a close must not pay a stat + append (and
    // an occasional rewrite) on the caller's thread. `flushSessionCloseMetrics`
    // lets a caller that tears the data dir down wait for the write.
    closeMetricLog.append(
      join(dataDir, 'tool-events.log'),
      `[${ts}] [session-close] owner=${owner} agent=${agent} reason=${reason} lifeMs=${lifeMs} id=${id}\n`
    );
  } catch {
    /* logger never breaks the close path */
  }
}

/**
 * A barrier that found no record at all — nothing on disk and no live or
 * pending copy in memory — fenced nothing because there is nothing to fence:
 * its pending writes were already cancelled under the commit lock. It still
 * returns null (no generation exists), but a caller passing `options.outcome`
 * learns that the record was legitimately gone rather than vetoed, contended
 * or failed.
 */
function _recordAbsent(options) {
  if (options?.outcome && typeof options.outcome === 'object') options.outcome.absent = true;
  return null;
}

/**
 * Atomically mark a session closed on disk with a bumped generation.
 * Returns the new generation, or null if the session file doesn't exist.
 * `options.outcome` (an object) gets `absent: true` when no record existed.
 * Used by closeSession() to plant a tombstone that races against in-flight
 * saveSession() calls.
 */
export function markSessionClosed(id, reason = 'manual', options = {}) {
  return _markSessionClosed(id, reason, options, null);
}

function _markSessionClosed(id, reason, options, attempt) {
  // Only a fresh failure from THIS attempt may be observed by closeSession's
  // durable-barrier check — a veto must not surface a stale error.
  clearSessionLifecycleCommitError(id);
  // Caller-provided probes may re-enter the store, so evaluate them before
  // taking the non-reentrant Atomics commit lock. A veto must also precede
  // pending-save cancellation so debounce durability remains intact.
  if (_runtimeLivenessVeto(id, options)) return null;
  const closeGuard = _guardedSaveOptions(id);
  const commitControl = _acquireWriteCommit(closeGuard);
  if (commitControl === false) return null;
  try {
    const authority = _readLifecycleAuthority(id, reason, 'close');
    if (authority === LIFECYCLE_AMBIGUOUS) return null;
    // Only a committed close may disrupt pending persistence.
    _clearDebounce(id);
    _cancelSessionWrites(id);
    _uncacheSessionSummary(id);
    const existing = loadSession(id);
    if (!existing) return _recordAbsent(options);
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
    const alreadyClosed = onDisk ? onDisk.closed === true || onDisk.status === 'closed' : existing.closed === true;
    // When the on-disk copy is already closed, base the (idempotent) tombstone
    // rewrite on IT rather than on `existing`, so a stale open in-memory
    // payload can never clobber the persisted tombstone's content/fields.
    const base = alreadyClosed && onDisk ? onDisk : existing;
    const closeTime =
      alreadyClosed && typeof base.updatedAt === 'number' && base.updatedAt > 0 ? base.updatedAt : Date.now();
    const newGen = (typeof base.generation === 'number' ? base.generation : 0) + (alreadyClosed ? 0 : 1);
    const tombstone = {
      ...base,
      closed: true,
      closedReason: alreadyClosed && reason !== 'desktop-session-delete' ? base.closedReason || reason : reason,
      status: 'closed',
      generation: newGen,
      updatedAt: closeTime,
      ..._cancelStatusFields(base, reason, options.cancelStatus, closeTime),
    };
    const wrote = _writeLifecycleRecord(id, tombstone, existing, reason, attempt);
    if (wrote !== true) return wrote || null;
    _savePending.delete(id);
    clearSessionSaveError(id);
    _clearLiveSession(id);
    _queueSessionSummaryUpsert(tombstone);
    _droppedSaveIds.delete(id);
    // Emit the close metric only on the FIRST close — a re-close of an
    // already-tombstoned session is a no-op idempotent write and must not
    // spam the close log or double-count lifetimes.
    if (!alreadyClosed) _logSessionCloseMetric(id, existing, tombstone.updatedAt, reason);
    return newGen;
  } finally {
    _releaseWriteCommit(commitControl);
  }
}

/**
 * Bump a session's generation WITHOUT planting a closed:true tombstone.
 * Used by closeSession(id, reason, { tombstone: false }) — the runtime side
 * (bash shells, controller, in-memory entry) is detached, but the
 * session file itself stays valid/resumable. The generation bump alone is
 * what protects it from a late save race: any saveSession() still in flight
 * from the detached turn was issued with the OLD generation as its
 * `expectedGeneration`, so once we bump the on-disk generation here, that
 * late write's own _shouldDrop() check (generation-as-ownership-counter
 * rule, see store/write-admission.mjs) sees disk generation > expected and drops itself instead
 * of clobbering whatever the resumed session writes next.
 * Returns the new generation, or null if the session file doesn't exist.
 */
export function bumpSessionGeneration(id, reason = 'detach', options = {}) {
  return _bumpSessionGeneration(id, reason, options, null);
}

function _bumpSessionGeneration(id, reason, options, attempt) {
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
    // Same durable authority as the tombstone barrier, but only its verdict
    // is consumed here: bytes this realm renamed into place (own-commit
    // stamp) are not re-read and re-parsed; anything else is read strictly.
    if (_readLifecycleAuthority(id, reason, 'detach', true) === LIFECYCLE_AMBIGUOUS) return null;
    // Only a VALIDATED barrier may disrupt pending persistence: on an
    // ambiguous/foreign refusal above the debounced save stays scheduled
    // and usable.
    _clearDebounce(id);
    _cancelSessionWrites(id);
    _uncacheSessionSummary(id);
    const existing = loadSession(id);
    if (!existing) return _recordAbsent(options);
    const newGen = (typeof existing.generation === 'number' ? existing.generation : 0) + 1;
    const detached = { ...existing, generation: newGen, updatedAt: Date.now(), detachedReason: reason };
    const wrote = _writeLifecycleRecord(id, detached, existing, reason, attempt);
    if (wrote !== true) return wrote || null;
    _savePending.delete(id);
    clearSessionSaveError(id);
    _clearLiveSession(id);
    _queueSessionSummaryUpsert(detached);
    _droppedSaveIds.delete(id);
    return newGen;
  } finally {
    _releaseWriteCommit(commitControl);
  }
}

// ── Non-blocking barriers ────────────────────────────────────────────────────
// The synchronous barriers above wait out a refused rename (Windows EPERM/
// EBUSY while a scanner holds the file) with sleepSync INSIDE the commit lock,
// freezing the whole daemon for up to the full backoff schedule (4.6 s seen).
// An attempt instead runs the complete barrier — authority read, cancellation,
// record built from the current copy, ONE rename — under the commit lock and,
// when the rename is refused with attempts left, returns a retry
// ({ retryInMs }) having recorded nothing. The lock is released between
// attempts; the next attempt re-reads everything, so a save that landed in
// between is folded into the barrier instead of overwriting it. Same backoff
// schedule and the same final error as the synchronous barrier.

/** Whether a barrier attempt asked to be retried after `retryInMs`. */
export function isLifecycleRetry(result) {
  return typeof result?.retryInMs === 'number';
}

/** Attempt `attempt` of markSessionClosed (see isLifecycleRetry). */
export function markSessionClosedAttempt(id, reason = 'manual', options = {}, attempt = 0) {
  return _markSessionClosed(id, reason, options, attempt);
}

/** Attempt `attempt` of bumpSessionGeneration (see isLifecycleRetry). */
export function bumpSessionGenerationAttempt(id, reason = 'detach', options = {}, attempt = 0) {
  return _bumpSessionGeneration(id, reason, options, attempt);
}

async function _runBarrierAttempts(run) {
  for (let attempt = 0; ; attempt++) {
    const result = run(attempt);
    if (!isLifecycleRetry(result)) return result;
    await sleep(result.retryInMs);
  }
}

/** markSessionClosed without ever blocking the event loop on a rename retry. */
export function markSessionClosedAsync(id, reason = 'manual', options = {}) {
  return _runBarrierAttempts((attempt) => _markSessionClosed(id, reason, options, attempt));
}
