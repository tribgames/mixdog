/**
 * Durable lifecycle barriers: the tombstone (markSessionClosed) and the
 * non-tombstoning detach bump (bumpSessionGeneration). Each records its
 * lifecycle fields in the session's log as the session's writer and resolves
 * the new generation once that record is fsynced; both fence late saves
 * through the generation counter (store.mjs _dropsAgainst), checked against
 * the recorder's own state, so no disk re-read and no lock is involved.
 */
import { join } from 'node:path';
import { getPluginData } from '../../config.mjs';
import { PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../../../../../lib/mixdog-debug.cjs';
import { createAsyncLogAppender } from '../../../../shared/async-log-appender.mjs';
import {
  _droppedSaveIds,
  _clearLiveSession,
  clearSessionSaveError,
  _recordSaveFailure,
  _recordLifecycleCommitFailure,
  clearSessionLifecycleCommitError,
} from './live-state.mjs';
import { _uncacheSessionSummary, _queueSessionSummaryUpsert } from './summary-cache.mjs';
import { takePendingWrite } from './pending-writes.mjs';
import { _runtimeLivenessVeto } from './liveness-veto.mjs';
import { loadSession } from './load-session.mjs';
import { claimSessionWriter, releaseSessionWriter, sessionWriterRefusalError } from './session-writer-claim.mjs';
import { abandonRecorder, endTenureAtBarrier, recorderFor } from './session-writers.mjs';
import { inSessionOrder } from './session-sequence.mjs';
import { sessionRecordStampSync } from './session-log-reader.mjs';
import { sessionLogRecordPath, sessionRecordPath } from './session-paths.mjs';
import { ABSENT_RECORD_STAMP } from './session-record.mjs';

// Cancellation truth, single rule: an UNCONFIRMED stop outranks a confirmed
// one, in either direction (already recorded, or requested by this close). A
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
// stop must be recorded instead of the default confirmed `cancelled`, and a
// later re-stamp must never downgrade it.
function _cancelStatusFields(base, reason, requested, closeTime) {
  if (!_CANCEL_CLOSE_REASON.test(String(reason || '').trim()) && !_cleanCancelStatus(requested)) return {};
  return {
    cancelStatus: _mergeCancelStatus(base.cancelStatus, requested),
    cancelledAt: base.cancelledAt || closeTime,
  };
}

// Structured close metric. Single emission point because every close path
// funnels through markSessionClosed.
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
 * pending copy in memory — fenced nothing because there is nothing to fence.
 * It returns null (no generation exists); a caller passing `options.outcome`
 * learns the record was legitimately gone rather than vetoed or failed.
 */
function _recordPresent(id) {
  try {
    return (
      sessionRecordStampSync({ jsonPath: sessionRecordPath(id), logPath: sessionLogRecordPath(id) }) !==
      ABSENT_RECORD_STAMP
    );
  } catch {
    // Not even stat-able: there, and not readable.
    return true;
  }
}

function _recordAbsent(options) {
  if (options?.outcome && typeof options.outcome === 'object') options.outcome.absent = true;
  return null;
}

/**
 * Run `barrier(existing, recorder)` as the session's writer: another process
 * holding the claim refuses it (recorded like a failed commit). A landed
 * barrier ends this process's tenure, so the claim is given up; one that did
 * not land leaves a claim this process already held in place.
 */
function _asSessionWriter(id, reason, action, options, barrier) {
  // One operation in the session's order (session-sequence.mjs): behind a
  // delete accepted before it, it runs on what that delete left — an absent
  // session reads as absent, an intact one is closed or detached as usual.
  return inSessionOrder(id, 'barrier', () => _asSessionWriterNow(id, reason, action, options, barrier));
}

async function _asSessionWriterNow(id, reason, action, options, barrier) {
  let claim;
  try {
    claim = claimSessionWriter(id);
  } catch (error) {
    _recordLifecycleCommitFailure(id, sessionWriterRefusalError({ id, reason: 'unclaimable', cause: error }), reason);
    return null;
  }
  if (!claim.held) {
    const err = sessionWriterRefusalError({ id, reason: 'claimed', path: claim.path });
    err.message = `${err.message} — refusing to ${action}`;
    _recordLifecycleCommitFailure(id, err, reason);
    return null;
  }
  let result = null;
  try {
    result = await _runBarrier(id, reason, options, barrier);
  } finally {
    // Resolved only once the lock is gone: another process may open the
    // session the moment a close or detach reports success.
    if (typeof result === 'number' || claim.fresh) await releaseSessionWriter(id);
  }
  return result;
}

async function _runBarrier(id, reason, options, barrier) {
  // The newest copy: a debounced one is folded in (its slot goes, so it
  // cannot land after the barrier).
  const existing = loadSession(id);
  takePendingWrite(id);
  if (!existing) {
    // A record that is there and holds no session of this id (corrupt, or
    // another session's) owns the identity: the barrier refuses, it is not
    // an absent record.
    if (!_recordPresent(id)) return _recordAbsent(options);
    const err = new Error(`[session-store] ${id}: the record is not readable as this session; refusing to ${reason}`);
    err.code = 'ELIFECYCLEUNREADABLE';
    process.stderr.write(`[session-store] lifecycle barrier failed session=${id} reason=${reason}: ${err.message}\n`);
    _recordLifecycleCommitFailure(id, err, reason);
    return null;
  }
  let recorder;
  try {
    recorder = recorderFor(existing);
  } catch (err) {
    _recordSaveFailure(id, err);
    _recordLifecycleCommitFailure(id, err, reason);
    return null;
  }
  _uncacheSessionSummary(id);
  let landed;
  try {
    landed = barrier(existing, recorder);
    await landed.write;
  } catch (err) {
    // The barrier did NOT land: no tombstone, no generation bump fencing a
    // late save. Its records must never ride a later batch, so the recorder
    // goes with them and the log is cut back to what was acknowledged; the
    // next write reopens it there. The live snapshot stays pinned (its
    // unrecorded turns are that write's) and the cause is published so
    // closeSession refuses to report success.
    await abandonRecorder(id, err);
    _recordSaveFailure(id, err);
    _recordLifecycleCommitFailure(id, err, reason);
    return null;
  }
  endTenureAtBarrier(id);
  clearSessionSaveError(id);
  _clearLiveSession(id);
  _queueSessionSummaryUpsert(landed.record);
  _droppedSaveIds.delete(id);
  return landed.generation;
}

/**
 * Mark a session closed with a bumped generation. Resolves the new
 * generation, or null when vetoed, refused, failed or absent
 * (`options.outcome.absent`).
 */
export function markSessionClosed(id, reason = 'manual', options = {}) {
  return markSessionClosedAttempt(id, reason, options);
}

/** markSessionClosed under the name closeSession uses. */
export async function markSessionClosedAttempt(id, reason = 'manual', options = {}) {
  // Only a fresh failure from THIS call may be observed by closeSession's
  // durable-barrier check — a veto must not surface a stale error.
  clearSessionLifecycleCommitError(id);
  if (_runtimeLivenessVeto(id, options)) return null;
  return _asSessionWriter(id, reason, 'close', options, (existing, recorder) => {
    // Re-close idempotence: an already-recorded tombstone keeps its ORIGINAL
    // close time (updatedAt) and generation, and its transcript: only the
    // lifecycle fields are recorded, so a stale open in-memory copy can never
    // clobber the tombstone's content (the tombstone sweep matures it).
    const alreadyClosed = recorder.recordedHeader('closed') === true || recorder.recordedHeader('status') === 'closed';
    if (alreadyClosed) {
      const recordedGeneration = recorder.recordedHeader('generation');
      const generation = typeof recordedGeneration === 'number' ? recordedGeneration : 0;
      const recordedUpdatedAt = recorder.recordedHeader('updatedAt');
      const closeTime = typeof recordedUpdatedAt === 'number' && recordedUpdatedAt > 0 ? recordedUpdatedAt : Date.now();
      const base = {
        cancelStatus: recorder.recordedHeader('cancelStatus'),
        cancelledAt: recorder.recordedHeader('cancelledAt'),
      };
      const fields = {
        closed: true,
        status: 'closed',
        ...(reason === 'desktop-session-delete' ? { closedReason: reason } : {}),
        ..._cancelStatusFields(base, reason, options.cancelStatus, closeTime),
      };
      const write = recorder.recordFields(fields);
      return { write, generation, record: { ...existing, ...fields, generation, updatedAt: closeTime } };
    }
    const closeTime = Date.now();
    const generation = (typeof existing.generation === 'number' ? existing.generation : 0) + 1;
    const tombstone = {
      ...existing,
      closed: true,
      closedReason: reason,
      status: 'closed',
      generation,
      updatedAt: closeTime,
      ..._cancelStatusFields(existing, reason, options.cancelStatus, closeTime),
    };
    const write = recorder.record(tombstone).then((ack) => {
      _logSessionCloseMetric(id, existing, closeTime, reason);
      return ack;
    });
    return { write, generation, record: tombstone };
  });
}

/**
 * Bump a session's generation WITHOUT a closed:true tombstone: the runtime is
 * detached but the record stays resumable. Any save still in flight from the
 * detached turn carries the OLD generation as its `expectedGeneration`, so
 * the bump alone drops it. `options.ownerClose` (the agent tool's owner
 * close) also stamps `ownerClosedAt`. Resolves the new generation, or null.
 */
export function bumpSessionGeneration(id, reason = 'detach', options = {}) {
  return bumpSessionGenerationAttempt(id, reason, options);
}

/** bumpSessionGeneration under the name closeSession uses. */
export async function bumpSessionGenerationAttempt(id, reason = 'detach', options = {}) {
  clearSessionLifecycleCommitError(id);
  return _asSessionWriter(id, reason, 'detach', options, (existing, recorder) => {
    const generation = (typeof existing.generation === 'number' ? existing.generation : 0) + 1;
    const now = Date.now();
    const detached = {
      ...existing,
      generation,
      updatedAt: now,
      detachedReason: reason,
      // The agent's owner closed it: the record keeps that for its lifetime
      // (agent-reap-state.mjs ownerClosedSinceLastTurn).
      ...(options.ownerClose === true ? { ownerClosedAt: now } : {}),
    };
    return { write: recorder.record(detached), generation, record: detached };
  });
}

/** Stamp the agent owner's close (`ownerClosedAt`) on a session record that
 *  stays open: bumpSessionGeneration with `ownerClose`. */
export function markSessionOwnerClosed(id, reason = 'cli-agent-close', options = {}) {
  return bumpSessionGeneration(id, reason, { ...options, ownerClose: true });
}
