/**
 * Session store. Each session is its append-only log `<id>.log.jsonl`
 * (store/session-log-format.mjs), written by this process's recorder for the
 * session while it holds the session's writer claim (store/session-writers.mjs);
 * a session still in its legacy `<id>.json` is read from it and gets its log
 * at its first write. A save records the difference from what the log holds
 * and resolves once those records are fsynced.
 */
import { _flushPendingSummaryOps, _sessionSummary } from './store-summary-index.mjs';
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
import { TRANSIENT_SESSION_KEYS, _ensureLifecycleFields } from './store/serialize.mjs';
import { captureTranscriptSnapshot, recordLandedTranscript } from './store/transcript-durability.mjs';
import {
  _cacheSessionSummary,
  _queueSessionSummaryUpsertRow,
  _rollbackCachedSessionSummary,
} from './store/summary-cache.mjs';
import {
  sessionWriterRefusal,
  refuseSessionWrite,
  releaseHeldSessionWriters,
  releaseIdleSessionWriterClaim,
  releaseSessionWriter,
} from './store/session-writer-claim.mjs';
import {
  acceptSessionCopy,
  flushAllRecordersSync,
  recorderFor,
  redactSessionFiles,
  redactSessionFilesSync,
  redactionDue,
} from './store/session-writers.mjs';
import { deleteAhead, inSessionOrder, startWaitingSaves } from './store/session-sequence.mjs';
import { SESSION_LOG_ERRORS } from './store/session-log-writer.mjs';
import {
  hasPendingSessionWrite,
  schedulePendingWrite,
  takeAllPendingWrites,
  takePendingWrite,
} from './store/pending-writes.mjs';
// Durable lifecycle reads and live-cache reclamation are owned by dedicated
// modules; re-exported so prior importers of store.mjs stay unchanged.
export { readSessionLifecycleFromDisk, readSessionLifecycleStateFromDisk } from './store/lifecycle-read.mjs';
export { evictLiveSession, evictIdleLiveSessions } from './store/live-cache-eviction.mjs';
import { evictLiveSession } from './store/live-cache-eviction.mjs';
import {
  setLiveSession,
  _droppedSaveIds,
  hasSessionSaveFailure,
  _recordSaveFailure,
  _recordSaveDrop,
  _recordSaveLanded,
  isSessionWriteFenced,
  SAVE_OUTCOME_SAVED,
  SAVE_OUTCOME_DROPPED,
} from './store/live-state.mjs';
import { _publishLiveSession } from './store/session-observers.mjs';
export { setLiveSession, getSessionSaveError, clearSessionSaveError } from './store/live-state.mjs';
export { getSessionLifecycleCommitError, clearSessionLifecycleCommitError } from './store/live-state.mjs';
export { hasPendingSessionWrite } from './store/pending-writes.mjs';

// Observer registries (hard-delete purge hooks + the in-process live-session
// publication seam) live in store/session-observers.mjs; re-exported here so
// prior importers of store.mjs stay unchanged.
export { registerSessionPurgeHook, subscribeLiveSessions } from './store/session-observers.mjs';

// Ahead of every other exit hook: the drain writes as the sessions' writer and
// then lets the writer locks go, before any later hook may remove the folders
// that hold them (a held lock file cannot be deleted on Windows).
process.prependListener('exit', drainSessionStore);

/**
 * Idle unload (codex `thread_unload_delay`): give up `id`'s writer lock while
 * the session sits idle here, so another Mixdog process may open it. Kept
 * (false) while a write of it is outstanding or its last save dropped or
 * failed — this process's copy is then the only complete one. Its in-memory
 * copy goes with the lock, so the next resume or turn takes the lock again and
 * reads the record. An operation in the session's order (session-sequence.mjs):
 * it never lets go in the middle of a close, a detach or a delete. Resolves
 * whether the lock went.
 */
export function releaseIdleSessionWriter(id) {
  if (!id) return Promise.resolve(false);
  return inSessionOrder(id, 'release', () => {
    if (hasPendingSessionWrite(id) || _droppedSaveIds.has(id) || hasSessionSaveFailure(id)) return false;
    const released = releaseIdleSessionWriterClaim(id);
    if (!released) return false;
    evictLiveSession(id);
    return released;
  });
}

// The writer claim and the session's recorder: an error (the refusal
// reported) when another process holds the claim, this copy is older than
// the log, or the record cannot be opened or converted; `dropped` for a copy
// issued before this process closed or detached the session: it writes
// nothing and gives back the claim it took, like a stale generation.
function _recorderOrRefusal(session) {
  const id = session.id;
  const { refusal, fresh } = sessionWriterRefusal(id);
  if (refusal) return { error: refuseSessionWrite(refusal) };
  try {
    return { recorder: recorderFor(session, { claimedNow: fresh }) };
  } catch (err) {
    if (fresh) void releaseSessionWriter(id);
    if (err?.code === SESSION_LOG_ERRORS.RELEASED) {
      _recordSaveDrop(id);
      return { dropped: true };
    }
    process.stderr.write(`[session-store] ${id}: ${err?.message || err}\n`);
    _recordSaveFailure(id, err);
    return { error: err };
  }
}

// Admission shared by every save entry: the delete fence, the writer claim
// and the recorder come first, so a refused copy is never published as owned;
// then the live snapshot and the optimistic summary row.
function _admit(session) {
  _ensureLifecycleFields(session);
  const id = session.id;
  if (isSessionWriteFenced(id)) {
    _recordSaveDrop(id);
    return { dropped: true };
  }
  const opened = _recorderOrRefusal(session);
  if (opened.error || opened.dropped) return opened;
  setLiveSession(session);
  _publishLiveSession(session);
  return { summaryVersion: _cacheSessionSummary(session) };
}

// The record's lifecycle outranks a copy issued for an older ownership: a
// tombstone at least as new as `expectedGeneration`, or a generation past it
// (detached and taken over since), drops the save. The recorder's state is
// the record (queued records included): no other writer can change it.
function _dropsAgainst(recorder, opts) {
  const expected = typeof opts?.expectedGeneration === 'number' ? opts.expectedGeneration : null;
  if (expected === null) return false;
  const recorded = recorder.recordedHeader('generation');
  const generation = typeof recorded === 'number' ? recorded : 0;
  if (recorder.recordedHeader('closed') === true) return generation >= expected;
  return generation > expected;
}

/** The write of an admitted copy: its records, fsynced. */
async function _write(session, opts, summaryVersion) {
  const id = session.id;
  const rollback = () => _rollbackCachedSessionSummary(id, summaryVersion);
  if (isSessionWriteFenced(id)) {
    _recordSaveDrop(id);
    rollback();
    return SAVE_OUTCOME_DROPPED;
  }
  const opened = _recorderOrRefusal(session);
  if (opened.error) {
    rollback();
    throw opened.error;
  }
  if (opened.dropped) {
    rollback();
    return SAVE_OUTCOME_DROPPED;
  }
  const { recorder } = opened;
  if (_dropsAgainst(recorder, opts)) {
    _recordSaveDrop(id);
    rollback();
    return SAVE_OUTCOME_DROPPED;
  }
  // A copy accepted behind a delete: its transcript was fixed at acceptance,
  // and its landing is the caller's session's (_acceptBehindDelete).
  const accepted = _acceptedCopies.get(session);
  const transcript = accepted?.transcript ?? captureTranscriptSnapshot(session);
  const row = _sessionSummary(session);
  try {
    // A value marked sensitive since the files were last written must leave
    // every stored copy, not only the records still to come.
    if (redactionDue(id)) await redactSessionFiles(recorder, session);
    else await recorder.record(session, { compacted: opts?.compacted === true });
  } catch (err) {
    rollback();
    // Deleted while it was in flight: the delete outranks it, like a fence.
    if (err?.code === SESSION_LOG_ERRORS.DISCARDED) {
      _recordSaveDrop(id);
      return SAVE_OUTCOME_DROPPED;
    }
    _recordSaveFailure(id, err);
    throw err;
  }
  // The recorder wrote its log only after proving the json beside it still
  // leaves the log the record: its base's legacy is the row's log proof.
  _queueSessionSummaryUpsertRow(row, summaryVersion, { logLegacy: recorder.legacy ?? null });
  recordLandedTranscript(accepted?.original ?? session, transcript);
  _recordSaveLanded(id);
  return SAVE_OUTCOME_SAVED;
}

function _startWrite(session, opts, summaryVersion) {
  _write(session, opts, summaryVersion).catch((err) => {
    process.stderr.write(`[session-store] save failed: ${err?.message}\n`);
  });
}

/**
 * Persist a session: debounced (150 ms) unless `opts.immediate`.
 * `opts.expectedGeneration` drops the write when the record's lifecycle moved
 * past it (see _dropsAgainst); `opts.compacted` writes the transcript as a
 * replacement history. Behind a delete of the session it waits in the
 * session's order and is made once the delete ended.
 */
export function saveSession(session, opts) {
  if (deleteAhead(session?.id)) {
    const accepted = _acceptBehindDelete(session, opts);
    void inSessionOrder(session.id, 'save', () => _saveSessionNow(accepted.copy, accepted.opts));
    return;
  }
  _saveSessionNow(session, opts);
}

// Saves accepted behind a delete: copy → { original, transcript }.
const _acceptedCopies = new WeakMap();

/**
 * What a save that waits behind a delete means, fixed when it is accepted,
 * as the recorder's _accept fixes an operation: only its admission and write
 * wait. The copy holds the message list as it is now (a recorded message is
 * replaced, never edited, so membership is the whole of it), every stored
 * header value as the JSON it is recorded as, the transient keys as they are
 * (never recorded), and the options. It is judged by the caller's session's
 * binding (session-writers.mjs acceptSessionCopy); its transcript is captured
 * now and its landing recorded on the caller's session.
 */
function _acceptBehindDelete(session, opts) {
  _ensureLifecycleFields(session);
  const transcript = captureTranscriptSnapshot(session);
  const copy = {};
  for (const key of Object.keys(session)) {
    const value = session[key];
    if (key === 'messages') copy.messages = Array.isArray(value) ? value.slice() : value;
    else if (TRANSIENT_SESSION_KEYS.includes(key)) copy[key] = value;
    else {
      const json = JSON.stringify(value);
      copy[key] = json === undefined ? value : JSON.parse(json);
    }
  }
  _acceptedCopies.set(copy, { original: session, transcript });
  acceptSessionCopy(copy, session);
  return { copy, opts: opts ? { ...opts } : opts };
}

function _saveSessionNow(session, opts) {
  const admitted = _admit(session);
  if (admitted.dropped || admitted.error) return;
  const id = session.id;
  if (opts?.immediate) {
    takePendingWrite(id);
    _startWrite(session, opts, admitted.summaryVersion);
    return;
  }
  schedulePendingWrite(id, session, opts, admitted.summaryVersion, (slot) =>
    _startWrite(slot.session, slot.opts, slot.summaryVersion)
  );
}

/**
 * A save that resolves SAVE_OUTCOME_SAVED once its records are fsynced (or
 * DROPPED), and rejects when the write failed or the writer claim refused it.
 * It supersedes a debounced copy still waiting (the newest save is the one
 * that lands, as in v1.4.5). Behind a delete it waits as saveSession does.
 */
export function saveSessionAsync(session, opts) {
  if (deleteAhead(session?.id)) {
    const accepted = _acceptBehindDelete(session, opts);
    return inSessionOrder(session.id, 'save', () => _saveSessionAsyncNow(accepted.copy, accepted.opts));
  }
  return _saveSessionAsyncNow(session, opts);
}

function _saveSessionAsyncNow(session, opts) {
  const admitted = _admit(session);
  if (admitted.dropped) return Promise.resolve(SAVE_OUTCOME_DROPPED);
  if (admitted.error) return Promise.reject(admitted.error);
  takePendingWrite(session.id);
  return _write(session, opts, admitted.summaryVersion);
}

/** saveSessionAsync under the name callers that need the durable outcome use. */
export const saveSessionDurably = saveSessionAsync;

/**
 * Process exit: the saves waiting behind a delete are made, every debounced
 * copy is recorded, then every recorder writes what it holds synchronously
 * (an in-flight batch included), and the writer locks go.
 */
export function drainSessionStore() {
  startWaitingSaves();
  for (const slot of takeAllPendingWrites()) {
    try {
      const opened = _recorderOrRefusal(slot.session);
      if (opened.recorder && !_dropsAgainst(opened.recorder, slot.opts)) {
        opened.recorder.record(slot.session).catch(() => {});
        // As a save would (_write): a value marked since leaves the files,
        // here synchronously (the save above is written first).
        if (redactionDue(slot.session.id)) redactSessionFilesSync(opened.recorder, slot.session);
      }
    } catch (err) {
      process.stderr.write(`[session-store] drain save failed: ${err?.message}\n`);
    }
  }
  flushAllRecordersSync();
  // Summary-index ops queued by the writes: one last sync flush before exit
  // (losing them is acceptable — the index self-heals).
  try {
    _flushPendingSummaryOps({ sync: true });
  } catch {
    /* best-effort */
  }
  releaseHeldSessionWriters();
}

// Durable lifecycle barriers (tombstone + detach generation bump) live in
// store/lifecycle-barriers.mjs; re-exported so prior importers of store.mjs
// stay unchanged.
export {
  markSessionClosed,
  bumpSessionGeneration,
  markSessionClosedAttempt,
  bumpSessionGenerationAttempt,
} from './store/lifecycle-barriers.mjs';
// Session reads live in store/load-session.mjs, same facade contract.
export { loadSession, loadSessionStatus } from './store/load-session.mjs';

// Hard delete + owned-agent enumeration live in store/session-delete.mjs;
// re-exported here so prior importers of store.mjs stay unchanged.
export { deleteSession, listOwnedAgentSessionIds } from './store/session-delete.mjs';
export { fenceSessionWrites } from './store/live-state.mjs';

// Listing / summaries live in store/listing.mjs and the stale sweep in
// store/sweep/stale-sweep.mjs; re-exported here so importers keep one
// session-store entry point.
export { listStoredSessions, listStoredSessionSummaries, getStoredSessionsRaw } from './store/listing.mjs';
export { sweepStaleSessions, sweepStaleSessionsCooperative } from './store/sweep/stale-sweep.mjs';
export { applySubAgentRetention } from './store/sweep/sub-agent-retention.mjs';
