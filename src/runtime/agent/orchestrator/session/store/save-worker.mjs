import { randomBytes } from 'node:crypto';
import { MessageChannel, Worker } from 'node:worker_threads';
import {
  guardedSaveOptions as _guardedSaveOptions,
  hasCommitWaiters,
  onCommitWaiter,
  rejectCommitWaiters,
  releaseExitedOwnerCommits,
  releaseSessionWriteControl,
} from './write-guards.mjs';
import { sessionPath } from './session-paths.mjs';
import { _ensureLifecycleFields } from './serialize.mjs';
import {
  _attemptEvidence,
  _buildWirePayload,
  _clearDeltaBaselines,
  _cloneOrNull,
  _dropDeltaBaseline,
  _invalidateDeltaBaseline,
} from './save-delta.mjs';
import {
  setLiveSession,
  _recordSaveFailure,
  _recordSaveDrop,
  _clearSaveStateIfCurrent,
  _nextSaveEpoch,
  _acquireSessionIncarnation,
  _releaseSessionIncarnation,
  _isCurrentSessionIncarnation,
  SAVE_OUTCOME_SAVED,
  SAVE_OUTCOME_DROPPED,
  SAVE_OUTCOME_STALE,
} from './live-state.mjs';
import {
  _cacheSessionSummary,
  _rollbackCachedSessionSummary,
  _queueSessionSummaryUpsertRow,
} from './summary-cache.mjs';
import { _sessionSummary } from '../store-summary-index.mjs';
import {
  serializeSessionSaveFault,
  sessionSaveFaultSyncKey,
  _onSessionSaveFaultChange,
  _sessionStoreTestMode,
  _discardSaveTmp,
} from './save-fault.mjs';
import { connectOwnCommitPeer } from './canonical-reader.mjs';
import { sessionWriterRefusal, refuseSessionWrite } from './session-writer-claim.mjs';
import { getPluginData } from '../../config.mjs';
import { captureTranscriptSnapshot, recordLandedTranscript } from './transcript-durability.mjs';

// ── Worker-thread async save ──────────────────────────────────────────────────
// Single long-lived Worker serializes all saveSessionAsync calls.
// The worker's message queue preserves generation-race ordering.
let _saveWorker = null;
// In-flight writes, keyed by reqId. Value: { id, session, opts, waiters:[{resolve,reject}] }.
// At most ONE entry per session id at a time (single-in-flight-per-id).
export const _saveWorkerPending = new Map();
// Latest-wins queued payload per session, keyed by id. Value: { session, opts, waiters:[] }.
// At most ONE queued write per id: a newer saveSessionAsync while a write is in
// flight overwrites session/opts here and appends its resolver to waiters, so
// every superseded caller resolves when this single queued write finally lands.
export const _saveAsyncQueued = new Map();
// id → reqId of the in-flight write for that id (enforces one-in-flight-per-id).
export const _saveAsyncInflight = new Map();
// Writes a retired worker may still be inside — commit lock held, scratch
// file on disk — until its 'exit' proves the thread gone (_recoverExitedWorker).
const _strandedWrites = new WeakMap(); // worker → [{ id, buffer, scratchPath }]
// The in-flight mark of an id whose last write is stranded in such a worker is
// `{ awaitingExitOf: worker }`: later saves of it queue behind the mark until
// that worker's locks are back, each answered within the hung bound.
const _awaitingExitOf = (id) => _saveAsyncInflight.get(id)?.awaitingExitOf ?? null;
let _saveWorkerReqId = 0;
let _saveWorkerRefCount = 0;
let _deferredSaveReqId = 0;
export const _deferredSessionSaves = new Map();

// The parent-side delta baseline and wire-payload builder live in save-delta.mjs.
export { _hasSessionSaveBaseline } from './save-delta.mjs';

/**
 * Release everything the save path retains for a session that went away: the
 * parent baseline AND the worker's reconstructed base (both would otherwise
 * live until the process exits). The worker message rides the same FIFO as
 * the writes, so a write already posted for `id` still lands first; the next
 * save for `id`, if any, simply goes out as a full snapshot.
 */
export function forgetSessionSaveBaseline(id, { releaseWriteControl = false } = {}) {
  if (!id) return false;
  const had = _dropDeltaBaseline(id);
  // Only when the session itself is gone (close/teardown/delete): a mid-life
  // forget (compaction) must keep the landed-epoch fence for in-flight writes.
  if (releaseWriteControl) releaseSessionWriteControl(String(id));
  if (_saveWorker) {
    try {
      _saveWorker.postMessage({ __forgetBase: String(id) });
    } catch {
      /* worker gone: its bases went with it */
    }
  }
  return had;
}

// ── Fault-state mirroring (parent → worker) ─────────────────────────────────
// The worker thread is long-lived and owns its own module instance of
// save-fault.mjs, which setSessionSaveFault() never reaches, so the parent
// pushes the authoritative state: on spawn, on every config change, and (as a
// cheap key compare) before every posted write. Clearing propagates the same
// way, which is what makes `setSessionSaveFault(null)` stop worker faults.
let _faultSyncedKey = null;

// ── Pre-admission authority (parent-side) ───────────────────────────────────
// store.mjs registers its strict canonical-record check here (an import would
// be circular). An async/worker save must pass it BEFORE any live snapshot or
// optimistic summary row is published: foreign/ambiguous records must never be
// cached as owned, not even transiently.
let _writeAuthorityCheck = null;
let _liveSessionPublisher = null;

export function _setSessionWriteAuthorityCheck(check) {
  _writeAuthorityCheck = typeof check === 'function' ? check : null;
}

export function _setLiveSessionPublisher(publish) {
  _liveSessionPublisher = typeof publish === 'function' ? publish : null;
}

function _publishAdmittedLiveSession(session) {
  try {
    _liveSessionPublisher?.(session);
  } catch {
    /* observers never affect persistence */
  }
}

function _refuseUnownedWrite(session) {
  const id = session?.id;
  // Another process writes this session (or wrote it after this copy was
  // read); a copy this process already let go is a dropped no-op instead.
  const writerRefusal = sessionWriterRefusal(session);
  if (writerRefusal) return refuseSessionWrite(writerRefusal) ?? SAVE_OUTCOME_DROPPED;
  if (!_writeAuthorityCheck || !id) return null;
  let refusal = null;
  // A THROWN check is a refusal, never acceptance.
  try {
    refusal = _writeAuthorityCheck(id);
  } catch {
    refusal = 'unreadable';
  }
  if (!refusal) return null;
  const err = new Error(`[session-store] ${id}: refusing async save — canonical record is ${refusal}`);
  err.code = 'ESESSIONNOTOWNED';
  err.sessionAuthorityRefusal = refusal;
  return err;
}

function _syncFaultToWorker(worker, { force = false } = {}) {
  if (!worker) return;
  const key = sessionSaveFaultSyncKey();
  if (!force && key === _faultSyncedKey) return;
  try {
    worker.postMessage({ __fault: serializeSessionSaveFault() });
    _faultSyncedKey = key;
  } catch {
    /* worker died; respawn re-syncs (force) */
  }
}

// Config changes are pushed immediately so a fault set/cleared between saves
// is honoured by the worker's very next commit.
_onSessionSaveFaultChange(() => {
  if (_saveWorker) _syncFaultToWorker(_saveWorker, { force: true });
});

/**
 * Reject one settled worker write. The failure is RECORDED BEFORE the waiters
 * are rejected, so a caller's rejection handler already observes
 * getSessionSaveError(id) / the non-evictable live snapshot; and the
 * optimistic summary row is rolled back so a failed write never publishes.
 */
function _failWorkerWrite(
  id,
  summaryVersion,
  waiters,
  err,
  epoch = null,
  incarnation = null,
  session = null,
  known = null
) {
  // Currentness may be PRECOMPUTED by the caller: once the pending reference
  // is released, cap eviction can drop the token, and re-deriving here would
  // then misread a real failure as a stale post-delete outcome.
  const isCurrent = typeof known === 'boolean' ? known : _isCurrentSessionIncarnation(id, incarnation);
  if (!isCurrent) {
    // The session was hard-deleted (and possibly re-created) after this
    // write was posted: its failure is about a file that no longer exists.
    // Settle the callers ONCE and touch nothing — no marker, no delta
    // baseline: none of it belongs to this incarnation any more.
    for (const w of waiters) w.reject(err);
    return;
  }
  _invalidateDeltaBaseline(id);
  _rollbackCachedSessionSummary(id, summaryVersion);
  // The failed payload's own snapshot travels with the failure: it is the
  // only in-memory copy allowed to stand in for an unreadable canonical file.
  _recordSaveFailure(id, err, epoch, session);
  for (const w of waiters) w.reject(err);
}

/** Rebuild the worker-side error locally WITHOUT losing its code/marker. */
function _workerSaveError(message, code, injected) {
  const err = new Error(`[session-store] worker save failed: ${message}`);
  if (code) err.code = code;
  if (injected) err.injectedSaveFault = true;
  err.workerMessage = message;
  return err;
}

/**
 * Settle a reply whose session was hard-deleted after the write was posted.
 * Its outcome is about a file that no longer exists: settle every caller
 * exactly once, then touch NOTHING — no drop/failure marker, no summary
 * publish, no live pin, no delta baseline. The id may already belong to a NEW
 * incarnation, so only slots this very request still owns may be cleared.
 */
function _settleStaleIncarnationWrite(p, reqId, { ok, error, errorCode, injectedSaveFault }) {
  const { id, incarnation, waiters } = p;
  if (_saveAsyncInflight.get(id) === reqId) _saveAsyncInflight.delete(id);
  const stale = _saveAsyncQueued.get(id);
  if (stale && stale.incarnation === incarnation) {
    _saveAsyncQueued.delete(id);
    _releaseSessionIncarnation(stale.incarnation);
    for (const w of stale.waiters) w.resolve();
  }
  if (ok) for (const w of waiters) w.resolve();
  else for (const w of waiters) w.reject(_workerSaveError(error, errorCode, injectedSaveFault));
}

/**
 * The worker restarted or evicted this id's base mid-chain. Not a drop: retry
 * once as a FULL snapshot of the current live session (latest-wins
 * durability, same waiters). The queued slot stays queued and promotes after
 * the retry settles. Returns false when the retry could not be posted — its
 * failure is recorded here and the caller promotes the queued slot.
 */
function _retryFullAfterDeltaMiss(p, isCurrentIncarnation) {
  const { id, session, waiters, summaryVersion, epoch, revision, incarnation } = p;
  _invalidateDeltaBaseline(id);
  try {
    _postAsyncWrite(id, session, p.opts, waiters, summaryVersion, epoch, revision, {
      forceFull: true,
      retriedFull: true,
    });
    return true;
  } catch (err) {
    // The RETRY is its own attempt: only its projected payload may
    // stand as evidence. Falling back to the original delta
    // snapshot would publish bytes this failure never attempted.
    _failWorkerWrite(
      id,
      summaryVersion,
      waiters,
      err,
      epoch,
      incarnation,
      err?.attemptSnapshot ?? null,
      isCurrentIncarnation
    );
    return false;
  }
}

/**
 * Resolve/reject every caller whose payload this write represents (the
 * originating call plus any that coalesced onto it before it was posted). A
 * supersede never lands here as a rejection — only a real worker failure does.
 */
function _settleLandedWrite(
  p,
  { ok, saved, outcome, error, errorCode, injectedSaveFault, attempted },
  isCurrentIncarnation
) {
  const { id, attempt, summaryVersion, summaryRow, waiters, epoch, incarnation } = p;
  if (!ok) {
    _failWorkerWrite(
      id,
      summaryVersion,
      waiters,
      _workerSaveError(error, errorCode, injectedSaveFault),
      epoch,
      incarnation,
      // The worker's own copy of what it attempted is exact; the parent's
      // rebuild is the fallback.
      attempted ?? _attemptEvidence(attempt),
      isCurrentIncarnation
    );
    return;
  }
  // A close/delete may have completed while the worker was writing.
  // Do not let this older completion put an open row back in the
  // process-local cache after its tombstone/removal.
  if (saved) {
    // Publish the IMMUTABLE row captured when this payload was
    // built — never a row re-derived from the live session, which
    // may already carry a newer (unwritten, possibly failing) turn.
    _queueSessionSummaryUpsertRow(summaryRow, summaryVersion);
    recordLandedTranscript(p.session, p.transcript, epoch);
    // ONLY a landed write proves durability, so this is the only
    // place the save-failure flag may be cleared — and only when
    // THIS payload is at least as new as the newest failed/dropped
    // one. An older worker write finishing after a newer
    // failure carries stale content and must leave the markers (and
    // therefore the live pin) exactly where they are.
    _clearSaveStateIfCurrent(id, epoch);
  } else if (outcome === SAVE_OUTCOME_STALE) {
    // A strictly NEWER write for this id already landed: disk is
    // AHEAD of this payload, not behind it. Nothing was lost, so
    // no drop marker, no save error and no live pin — the snapshot
    // stays immediately evictable. Only the optimistic summary row
    // for these bytes is rolled back.
    _invalidateDeltaBaseline(id);
    _rollbackCachedSessionSummary(id, summaryVersion);
  } else {
    // The worker's _shouldDrop declined the write: disk ownership
    // moved past this snapshot — flag the split-brain so eviction
    // and disk-over-live arbitration keep the richer local copy.
    // Nothing was written, so an earlier save failure for this id
    // STAYS recorded (clearing it here would un-pin the only good
    // in-memory transcript for an id whose disk copy is behind).
    _invalidateDeltaBaseline(id);
    _rollbackCachedSessionSummary(id, summaryVersion);
    _recordSaveDrop(id, epoch);
  }
  // Callers that act only on a durable write (e.g. a migration deleting its
  // source) read this outcome; every other resolution leaves it undefined.
  const settled = saved
    ? SAVE_OUTCOME_SAVED
    : outcome === SAVE_OUTCOME_STALE
      ? SAVE_OUTCOME_STALE
      : SAVE_OUTCOME_DROPPED;
  for (const w of waiters) w.resolve(settled);
}

/**
 * Promote the latest-wins queued payload (if any) into the now-free in-flight
 * slot for this id. Runs regardless of the settled outcome: the queued write
 * is a newer, independent payload and must still be attempted so its
 * (possibly superseded) waiters resolve when it lands.
 */
function _promoteQueuedWrite(id) {
  const q = _saveAsyncQueued.get(id);
  if (!q) return;
  _saveAsyncQueued.delete(id);
  // The promotion KEEPS the queued reference through projection, the
  // post and any immediate failure settlement: releasing first would
  // let cap eviction drop the token and make a real current failure
  // look like a stale post-delete outcome (no marker, no live pin).
  const queuedCurrent = _isCurrentSessionIncarnation(id, q.incarnation);
  try {
    _postAsyncWrite(id, q.session, q.opts, q.waiters, q.summaryVersion, q.epoch, q.revision);
  } catch (err) {
    // Evidence is this promotion's OWN projected attempt when it
    // got that far, never the queued (unprojected) live session.
    _failWorkerWrite(
      id,
      q.summaryVersion,
      q.waiters,
      err,
      q.epoch,
      q.incarnation,
      err?.attemptSnapshot ?? null,
      queuedCurrent
    );
  } finally {
    _releaseSessionIncarnation(q.incarnation);
  }
}

// ── Idle release ────────────────────────────────────────────────────────────
// An idle save worker still holds its isolate heap (tens of MB of garbage
// from the transcripts it parsed) and every delta base. Once no write has been
// in flight for SAVE_WORKER_IDLE_MS the thread is terminated; the next save
// spawns a fresh one (new own-commit channel) and every id goes out full once.
// Only a worker with nothing posted and nothing queued is released, so no
// write can be lost or reordered.
const SAVE_WORKER_IDLE_MS = 30_000;
let _saveWorkerIdleMs = SAVE_WORKER_IDLE_MS;
let _idleReleaseTimer = null;

function _scheduleIdleRelease(worker) {
  if (_idleReleaseTimer) clearTimeout(_idleReleaseTimer);
  _idleReleaseTimer = setTimeout(() => {
    _idleReleaseTimer = null;
    _releaseIdleWorker(worker);
  }, _saveWorkerIdleMs);
  _idleReleaseTimer.unref?.();
}

function _releaseIdleWorker(worker) {
  if (worker !== _saveWorker || _saveWorkerPending.size > 0 || _saveAsyncQueued.size > 0) return;
  _saveWorker = null;
  _faultSyncedKey = null;
  // Its delta bases go with it: the parent baselines would only miss.
  _clearDeltaBaselines();
  // Adopts the worker's last commit stamps, then closes the channel.
  connectOwnCommitPeer(null);
  worker.terminate().catch(() => {});
}

// ── Hung-worker watchdog ────────────────────────────────────────────────────
// While a write is outstanding the worker must show progress — start its next
// write or settle the current one — within SAVE_WORKER_HUNG_MS. The worker
// runs writes one at a time, so the clock measures a single write (or the
// spawn before the first), never the whole queue. A healthy multi-MB write
// with fsync takes milliseconds to a few seconds even on a loaded disk; the
// bound is the supervisor's daemon freeze limit (DAEMON_FREEZE_LIMIT_MS,
// 120 s), past which the daemon itself would be replaced as frozen. A worker
// silent that long is hung: it is terminated and every outstanding save
// rejects with ESAVEWORKERHUNG, recorded as a save failure (live snapshot
// pinned), so the next save writes the current state through a fresh worker.
// The same clock runs for a retired worker whose 'exit' is still due (Node
// does not bound termination: a blocking syscall can delay it indefinitely)
// while saves queue behind its stranded writes or a close, detach, delete or
// writer release waits on a commit lock it holds; its progress is that exit.
// Those waits fail with ESAVEWORKERHUNG when it expires, the session stays
// dirty, and the commit lock stays held until the exit really arrives.
const SAVE_WORKER_HUNG_MS = 120_000;
let _saveWorkerHungMs = SAVE_WORKER_HUNG_MS;
const _progressTimers = new Map(); // worker → its running no-progress clock
const _workerThreadIds = new WeakMap(); // worker → its thread id, read at spawn
const _strandedByThread = new Map(); // thread id → retired worker not yet exited

// A wait on a commit lock a retired, unexited worker holds runs on its clock.
onCommitWaiter((ownerThreadId) => {
  const worker = _strandedByThread.get(ownerThreadId);
  if (worker && !_progressTimers.has(worker)) _watchWorkerProgress(worker);
});

function _clearProgressWatch(worker) {
  clearTimeout(_progressTimers.get(worker));
  _progressTimers.delete(worker);
}

/** Ids whose saves queue behind `worker`'s stranded writes. */
function _idsAwaitingExitOf(worker) {
  return (_strandedWrites.get(worker) ?? [])
    .map(({ id }) => id)
    .filter((id) => _awaitingExitOf(id) === worker && _saveAsyncQueued.has(id));
}

/** (Re)start `worker`'s progress clock while anything waits on it: posted
 *  writes for the live worker; for a retired one, queued saves and waits on
 *  the commit locks it holds. */
function _watchWorkerProgress(worker) {
  _clearProgressWatch(worker);
  const waitedOn =
    worker === _saveWorker
      ? _saveWorkerPending.size > 0
      : _idsAwaitingExitOf(worker).length > 0 || hasCommitWaiters(_workerThreadIds.get(worker));
  if (!waitedOn) return;
  const timer = setTimeout(() => _onNoProgress(worker), _saveWorkerHungMs);
  timer.unref?.();
  _progressTimers.set(worker, timer);
}

function _onNoProgress(worker) {
  _progressTimers.delete(worker);
  const err = new Error(
    worker === _saveWorker
      ? `[session-store] save worker made no progress for ${_saveWorkerHungMs}ms and was terminated; the session stays unsaved until its next save`
      : `[session-store] a save worker terminated inside its commit has not exited after ${_saveWorkerHungMs}ms; the session's commit lock stays held and the session stays unsaved until a later save`
  );
  err.code = 'ESAVEWORKERHUNG';
  if (worker === _saveWorker) {
    _retireWorkerBookkeeping(err);
    worker.terminate().catch(() => {});
    return;
  }
  for (const id of _idsAwaitingExitOf(worker)) {
    const q = _saveAsyncQueued.get(id);
    _saveAsyncQueued.delete(id);
    _failWorkerWrite(id, q.summaryVersion, q.waiters, err, q.epoch, q.incarnation, null);
    _releaseSessionIncarnation(q.incarnation);
  }
  rejectCommitWaiters(_workerThreadIds.get(worker), err);
}

/** TEST-ONLY, gated: the live worker instance (or null), and the idle delay. */
export function _saveWorkerForTest() {
  return _sessionStoreTestMode() ? _saveWorker : null;
}

/** TEST-ONLY, gated: the hung-worker bound (non-finite restores the default). */
export function _setSaveWorkerHungMsForTest(ms) {
  if (!_sessionStoreTestMode()) return false;
  _saveWorkerHungMs = Number.isFinite(ms) && ms > 0 ? ms : SAVE_WORKER_HUNG_MS;
  return true;
}

export function _setSaveWorkerIdleMsForTest(ms) {
  if (!_sessionStoreTestMode()) return false;
  _saveWorkerIdleMs = Number.isFinite(ms) && ms >= 0 ? ms : SAVE_WORKER_IDLE_MS;
  return true;
}

/** One settled write reply from the live worker instance. */
function _onWorkerReply(worker, reply) {
  const { reqId } = reply;
  const p = _saveWorkerPending.get(reqId);
  if (!p) return;
  _saveWorkerPending.delete(reqId);
  // Drop the ref AFTER pending was registered ref-up'd so the worker
  // becomes unref'd again once all in-flight writes settle.
  // Never let the count go negative (a drain may have retired the
  // bookkeeping while this write was still in the worker's queue),
  // otherwise the `=== 0` unref below can never fire again and the
  // process stays alive on a ref'd worker.
  if (_saveWorkerRefCount > 0) _saveWorkerRefCount--;
  if (_saveWorkerRefCount === 0) worker.unref();
  const { id, incarnation } = p;
  const isCurrentIncarnation = _isCurrentSessionIncarnation(id, incarnation);
  // NOTE: the reference is released in the finally below, AFTER every
  // marker decision, so release-time eviction cannot change the verdict.
  try {
    if (!isCurrentIncarnation) {
      _settleStaleIncarnationWrite(p, reqId, reply);
      return;
    }
    _saveAsyncInflight.delete(id);
    if (reply.ok && reply.deltaMiss && !p.retriedFull) {
      if (_retryFullAfterDeltaMiss(p, isCurrentIncarnation)) return;
    } else {
      // (A deltaMiss on a retried FULL is unreachable — the worker only
      // misses on delta payloads.)
      _settleLandedWrite(p, reply, isCurrentIncarnation);
    }
    _promoteQueuedWrite(id);
  } finally {
    _releaseSessionIncarnation(incarnation);
    if (_saveWorkerPending.size === 0 && _saveAsyncQueued.size === 0 && worker === _saveWorker) {
      _scheduleIdleRelease(worker);
    }
  }
}

/**
 * Retire the shared bookkeeping of a worker that died or was detached: every
 * in-flight and queued write is settled as failed (failure recorded first,
 * live snapshot pinned) and its incarnation reference released; the module
 * pointer is cleared so the next save spawns a replacement that re-syncs the
 * fault state.
 */
function _retireWorkerBookkeeping(err) {
  const worker = _saveWorker;
  _clearProgressWatch(worker);
  _saveWorker = null;
  _faultSyncedKey = null;
  _clearDeltaBaselines();
  const stranded = [..._saveWorkerPending.values()].map((p) => ({
    id: p.id,
    buffer: p.opts?._sessionWriteGuard?.buffer,
    scratchPath: p.scratchPath,
  }));
  for (const [, p] of _saveWorkerPending) {
    _failWorkerWrite(p.id, p.summaryVersion, p.waiters, err, p.epoch, p.incarnation, _attemptEvidence(p.attempt));
    _releaseSessionIncarnation(p.incarnation);
  }
  _saveWorkerPending.clear();
  for (const [id, q] of _saveAsyncQueued) {
    // A queued payload was never projected or posted: it is settled and the
    // operational error is recorded, but it may NEVER stand as recovery
    // evidence (that must be an attempted, immutable payload).
    _failWorkerWrite(id, q.summaryVersion, q.waiters, err, q.epoch, q.incarnation, null);
    _releaseSessionIncarnation(q.incarnation);
  }
  _saveAsyncQueued.clear();
  // An earlier retired worker's marks stay until that worker has exited.
  for (const id of _saveAsyncInflight.keys()) {
    if (!_awaitingExitOf(id)) _saveAsyncInflight.delete(id);
  }
  _saveWorkerRefCount = 0;
  if (worker && stranded.length > 0) {
    _strandedWrites.set(worker, stranded);
    _strandedByThread.set(_workerThreadIds.get(worker), worker);
    for (const { id } of stranded) _saveAsyncInflight.set(id, { awaitingExitOf: worker });
    // Waits already on its commit locks now run on its clock.
    _watchWorkerProgress(worker);
  }
}

/**
 * The retired `worker` has exited, so nothing runs in it any more: free the
 * commit locks its stranded writes still hold — only words naming that very
 * thread — and their scratch files, then post what queued behind each mark.
 */
function _recoverExitedWorker(worker) {
  const stranded = _strandedWrites.get(worker);
  if (!stranded) return;
  const ownerThreadId = _workerThreadIds.get(worker);
  _strandedWrites.delete(worker);
  _strandedByThread.delete(ownerThreadId);
  _clearProgressWatch(worker);
  releaseExitedOwnerCommits(
    stranded.map(({ buffer }) => buffer).filter(Boolean),
    ownerThreadId
  );
  for (const { id, scratchPath } of stranded) {
    _discardSaveTmp(scratchPath);
    if (_awaitingExitOf(id) !== worker) continue;
    _saveAsyncInflight.delete(id);
    _promoteQueuedWrite(id);
  }
}

function _getOrSpawnWorker() {
  if (_saveWorker) return _saveWorker;
  // Every handler below is bound to THIS instance: a worker that already
  // died (its error/exit events can arrive after a replacement is live, and
  // 'exit' always follows 'error') must never settle, reject or ref-count
  // the pending writes of the worker that replaced it.
  // Own-commit stamps flow both ways on this channel, synchronously absorbed
  // by each realm's next ownership check (canonical-reader.mjs).
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL('../save-session-worker.mjs', import.meta.url), {
    execArgv: [],
    workerData: { ownCommitPort: port2 },
    transferList: [port2],
  });
  // Read now: the id is gone once the thread is.
  _workerThreadIds.set(worker, worker.threadId);
  connectOwnCommitPeer(port1);
  _saveWorker = worker;
  // Push current fault state before any write can be posted: the worker's
  // own realm has no other source for it.
  _faultSyncedKey = null;
  _syncFaultToWorker(worker, { force: true });
  // Worker logs arrive as `{ __log }` messages, NOT via piped stdio
  // (stdout:true/stderr:true): once the parent starts reading a worker's
  // piped stdio, the underlying MessagePort stays ref'd for the worker's
  // lifetime regardless of worker.unref(), so every process that ever
  // saved a session could no longer exit (test runners hung after
  // completion). The worker overrides its own process.stdout/stderr.write
  // to forward through this channel, which keeps stray prints off the TUI
  // frame (routed through the parent's guardable stderr) without holding
  // the event loop.
  worker.on('message', (message) => {
    if (message.__log !== undefined) {
      try {
        process.stderr.write(String(message.__log));
      } catch {
        /* best-effort */
      }
      return;
    }
    if (worker !== _saveWorker) return; // stale instance: not our bookkeeping
    // A write started (`__start`) or settled: progress either way.
    if (message.__start === undefined) _onWorkerReply(worker, message);
    _watchWorkerProgress(worker);
  });
  worker.on('error', (err) => {
    if (worker !== _saveWorker) return; // a replacement owns the maps now
    _retireWorkerBookkeeping(err);
  });
  worker.on('exit', (code) => {
    // 'exit' ALWAYS follows 'error' (which already nulled _saveWorker) and
    // can arrive after a replacement spawned: only the current instance may
    // retire the shared bookkeeping.
    // Reject pending resolvers on ANY exit (code 0 included) so an idle
    // worker that races a pending postMessage cannot leak resolvers. The
    // map is empty on the normal idle-exit path so the loop is a no-op,
    // but it remains safe for the race window where exit fires after
    // saveSessionAsync registered a resolver but before the worker
    // received the message.
    if (worker === _saveWorker) {
      _retireWorkerBookkeeping(new Error(`[session-store] save worker exited with code ${code}`));
    }
    _recoverExitedWorker(worker);
  });
  worker.unref(); // don't keep process alive
  return worker;
}

/**
 * Post one in-flight write for `id` to the worker and register it as the
 * single in-flight entry for that id. Callers guarantee no write is already
 * in flight for `id`. Throws (after cleaning its own map entries) if the
 * worker postMessage fails so the caller can reject the affected waiters.
 */
function _postAsyncWrite(
  id,
  session,
  opts,
  waiters,
  summaryVersion,
  epoch,
  revision = 0,
  { forceFull = false, retriedFull = false } = {}
) {
  const reqId = ++_saveWorkerReqId;
  // Before the bytes are built: what this write will prove durable once it
  // lands (store/transcript-durability.mjs).
  const transcript = captureTranscriptSnapshot(session);
  // The wire payload is built at POST time from the live session: N calls
  // coalesced behind one in-flight write project ONCE (newest state), and a
  // pure-append turn ships only the tail (see _buildWirePayload).
  const wire = _buildWirePayload(id, session, forceFull);
  // Snapshot the summary metadata for exactly these bytes, at exactly this
  // moment. The pending entry then holds immutable payload data even though
  // `session` remains the live object the exit drain needs.
  const summaryRow = _sessionSummary(session);
  // What this attempt posted (detached header + message references and
  // their sent fingerprints): failure evidence is rebuilt from it only while
  // it still provably matches the posted payload, so a later mutation of any
  // nested message/tool/media field in the live session can never be
  // recorded as what a failed settlement attempted.
  const attempt = wire.attempt;
  // Named here, so a worker terminated mid-write leaves no scratch file the
  // parent cannot find (_recoverExitedWorker).
  const scratch = randomBytes(6).toString('hex');
  _saveWorkerPending.set(reqId, {
    id,
    session,
    transcript,
    attempt,
    scratchPath: `${sessionPath(id)}.${scratch}.tmp`,
    opts,
    summaryVersion,
    summaryRow,
    waiters,
    retriedFull,
    epoch,
    revision,
    // Incarnation observed at POST time. Settlement compares OBJECT
    // IDENTITY, so a hard delete — and any later reuse of the id — is
    // detected exactly, with no counter to wrap, reset or collide.
    incarnation: _acquireSessionIncarnation(id),
  });
  _saveAsyncInflight.set(id, reqId);
  try {
    const w = _getOrSpawnWorker();
    // Cheap key compare; posts only when the fault config/env moved.
    _syncFaultToWorker(w);
    const { attempt: _attempt, ...wireForPost } = wire;
    // The worker's process.env is a copy taken at spawn, so a data dir that
    // moved since (a pristine headless run per page) would otherwise keep
    // receiving writes in the first run's removed directory. The dir current
    // at POST time travels with the write: a write still queued in the worker
    // when the env flips lands where its own session lives.
    w.postMessage({ ...wireForPost, id, opts, reqId, scratch, dataDir: getPluginData() });
    // Ref AFTER successful postMessage so a queue/throw failure path does
    // not leave the worker held alive with no pending message. Paired with
    // the unref in the message handler when count hits 0.
    if (++_saveWorkerRefCount === 1) w.ref();
    // A post is not progress: it starts the clock only when none is running.
    if (!_progressTimers.has(w)) _watchWorkerProgress(w);
  } catch (err) {
    // Projection SUCCEEDED but posting failed: carry the exact projected
    // attempt with the error so the caller records immutable evidence
    // instead of the mutable live session. When projection/clone itself
    // failed there is no attempted payload, so no evidence is recorded.
    // Only a payload that could have been cloned was attempted at all.
    const attemptSnapshot = err && typeof err === 'object' ? _cloneOrNull(_attemptEvidence(attempt)) : null;
    if (attemptSnapshot && err.attemptSnapshot === undefined) {
      try {
        err.attemptSnapshot = attemptSnapshot;
      } catch {
        /* frozen error */
      }
    }
    // This entry never reaches the message handler, so its incarnation
    // reference is freed here.
    const orphan = _saveWorkerPending.get(reqId);
    _releaseSessionIncarnation(orphan?.incarnation);
    _saveWorkerPending.delete(reqId);
    _saveAsyncInflight.delete(id);
    _invalidateDeltaBaseline(id);
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
export function saveSessionAsync(session, opts, options = {}) {
  const id = session.id;
  let summaryVersion = null;
  let safeOpts = null;
  // Identity of THIS attempt (see live-state _clearSaveStateIfCurrent): the
  // content handed over here, not the moment the worker happens to finish.
  // A deferred save promotes with the epoch it was ISSUED with, so the wait
  // for its check phase cannot make an older snapshot look newer.
  const epoch = Number.isFinite(options.epoch) ? options.epoch : _nextSaveEpoch();
  // Payload revision WITHIN that identity (see parkSessionSnapshotForDrain):
  // the drain uses it to rank this exact payload against a parked snapshot
  // sharing the same epoch.
  const revision = Number.isFinite(options.revision) ? options.revision : 0;
  // PRE-ADMISSION: strict canonical authority BEFORE anything is published.
  // A refusal publishes no live snapshot and no optimistic summary row, so a
  // foreign/ambiguous record is never cached as owned even transiently.
  const unowned = _refuseUnownedWrite(session);
  if (unowned === SAVE_OUTCOME_DROPPED) return Promise.resolve(unowned);
  if (unowned) return Promise.reject(unowned);
  try {
    _ensureLifecycleFields(session);
    // Pin the live snapshot BEFORE anything can fail: every failure below
    // leaves this process's memory as the only copy of the newest turn.
    setLiveSession(session);
    if (options.publishLive !== false) _publishAdmittedLiveSession(session);
    summaryVersion = _cacheSessionSummary(session);
    // The guard carries this snapshot's epoch across the thread boundary,
    // so the worker's own commit is fenced against a newer landed write.
    safeOpts = opts?._sessionWriteGuard ? opts : _guardedSaveOptions(id, opts, epoch);
  } catch (err) {
    // Setup/guard failure is a save failure like any other: record it
    // before the caller can observe the rejection.
    _failWorkerWrite(id, summaryVersion, [], err, epoch, null, err?.attemptSnapshot ?? null);
    return Promise.reject(err);
  }
  return writeAdmittedSave(id, session, safeOpts, summaryVersion, epoch, revision);
}

/**
 * Hand an ADMITTED save (live snapshot published, summary row cached, guard
 * stamped with `epoch`) to the worker: projection and the whole-record
 * serialization happen there, and a pure append ships only its tail. Resolves
 * the SAVE_OUTCOME_* once the worker settled it — SAVED after the rename —
 * and rejects on a failed write, with the same coalescing as saveSessionAsync.
 */
export function writeAdmittedSave(id, session, safeOpts, summaryVersion, epoch, revision = 0) {
  // Projection/clone now happen at POST time (see _postAsyncWrite): pending
  // entries hold the LIVE session reference — same object listings and the
  // exit drain already consume — so superseded saves never pay a projection.
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    if (_saveAsyncInflight.has(id)) {
      // A write is already on disk for this id — coalesce into the single
      // latest-wins queued slot. Existing queued waiters carry over so a
      // superseded caller resolves when THIS newer write lands (never
      // hang, never reject on supersede).
      const q = _saveAsyncQueued.get(id);
      if (q) {
        q.session = session;
        q.opts = safeOpts;
        q.summaryVersion = summaryVersion;
        q.epoch = epoch;
        q.revision = revision;
        q.waiters.push(waiter);
      } else {
        _saveAsyncQueued.set(id, {
          session,
          opts: safeOpts,
          summaryVersion,
          epoch,
          revision,
          incarnation: _acquireSessionIncarnation(id),
          waiters: [waiter],
        });
      }
      // Queued behind a retired worker's stranded write: answered within the
      // hung bound even if that worker never exits.
      const stranded = _awaitingExitOf(id);
      if (stranded && !_progressTimers.has(stranded)) _watchWorkerProgress(stranded);
      return;
    }
    // Idle for this id — post immediately as the in-flight write. The
    // in-flight entry persists {session, opts} so drainSessionStore can
    // sync-flush outstanding writes if process exit interrupts the queue.
    try {
      _postAsyncWrite(id, session, safeOpts, [waiter], summaryVersion, epoch, revision);
    } catch (err) {
      // Payload-build / spawn / postMessage-clone failure. Record the
      // save failure (live snapshot pinned + non-evictable) BEFORE the
      // waiter is rejected, exactly like a settled worker failure.
      _failWorkerWrite(id, summaryVersion, [waiter], err, epoch, null, err?.attemptSnapshot ?? null);
    }
  });
}

/**
 * Register a save for the exit drain now, but yield one check phase before
 * Worker.postMessage performs its main-thread structured clone.
 */
export function saveSessionAsyncDeferred(session, opts) {
  const reqId = ++_deferredSaveReqId;
  // Issued NOW: this identity travels through the deferred map, the promoted
  // async save and the exit drain unchanged.
  const epoch = _nextSaveEpoch();
  return new Promise((resolve, reject) => {
    const unowned = _refuseUnownedWrite(session);
    if (unowned === SAVE_OUTCOME_DROPPED) {
      resolve(unowned);
      return;
    }
    if (unowned) {
      reject(unowned);
      return;
    }
    try {
      _ensureLifecycleFields(session);
      setLiveSession(session);
      _publishAdmittedLiveSession(session);
      _cacheSessionSummary(session);
    } catch (err) {
      _failWorkerWrite(session?.id, null, [], err, epoch, null, err?.attemptSnapshot ?? null);
      reject(err);
      return;
    }
    _deferredSessionSaves.set(reqId, {
      session,
      opts: _guardedSaveOptions(session.id, opts, epoch),
      epoch,
      revision: 0,
      // Deferred payloads are incarnation-stamped like every other unit
      // of work: a hard delete retires them with the id.
      incarnation: _acquireSessionIncarnation(session.id),
      resolve,
      reject,
    });
    setImmediate(() => {
      const pending = _deferredSessionSaves.get(reqId);
      if (!pending) return;
      _deferredSessionSaves.delete(reqId);
      // The promoted save takes its own stamp.
      _releaseSessionIncarnation(pending.incarnation);
      try {
        saveSessionAsync(pending.session, pending.opts, {
          epoch: pending.epoch,
          publishLive: false,
        }).then(resolve, reject);
      } catch (err) {
        _failWorkerWrite(session?.id, null, [], err, epoch, null, err?.attemptSnapshot ?? null);
        reject(err);
      }
    });
  });
}

export function _resetSaveWorkerBookkeeping() {
  // Release any worker ref still held by writes we are retiring: dropping
  // the maps without unref'ing leaves the process pinned alive by a worker
  // whose completion message will never find its pending entry.
  if (_saveWorkerRefCount > 0 && _saveWorker) {
    try {
      _saveWorker.unref();
    } catch {
      /* worker already gone */
    }
  }
  // Retiring the maps also retires their incarnation references.
  for (const [, p] of _saveWorkerPending) _releaseSessionIncarnation(p.incarnation);
  for (const [, q] of _saveAsyncQueued) _releaseSessionIncarnation(q.incarnation);
  _saveWorkerPending.clear();
  _saveAsyncQueued.clear();
  _saveAsyncInflight.clear();
  _saveWorkerRefCount = 0;
  for (const timer of _progressTimers.values()) clearTimeout(timer);
  _progressTimers.clear();
  _clearDeltaBaselines();
}

const _noopSettle = () => {};

/**
 * Park a still-deferred snapshot in the SAME map the exit drain already walks
 * (`_deferredSessionSaves`). A module that throttles its own saves therefore
 * needs no second exit-flush path: the drain picks the snapshot up ranked by
 * its issuance epoch, under a fresh cancellation guard, the shared commit
 * lock, the ownership (`expectedGeneration`) check, the landed-epoch fence and
 * the one global drain deadline.
 *
 * Re-parking the same session PRESERVES the epoch and the guarded options it
 * was first deferred with — parking never mints fresh write authority, and the
 * original `expectedGeneration` keeps a later lifecycle barrier authoritative.
 * The returned handle carries those guarded options so the owner can run its
 * OWN save (and every retry of it) under exactly this identity.
 */
export function parkSessionSnapshotForDrain(session, opts, handle = null) {
  const id = session?.id;
  if (!id) return null;
  const parked = handle?.key === undefined ? null : _deferredSessionSaves.get(handle.key);
  if (parked && parked.session?.id === id) {
    if (parked.session !== session) {
      // A DISTINCT newer payload under the same issuance identity: bump
      // the revision so the drain can rank it above an in-flight write
      // that was posted from the previous ref.
      parked.session = session;
      parked.revision += 1;
      handle.revision = parked.revision;
    }
    return handle;
  }
  const epoch = _nextSaveEpoch();
  const key = ++_deferredSaveReqId;
  const guarded = _guardedSaveOptions(id, opts, epoch);
  _deferredSessionSaves.set(key, {
    session,
    opts: guarded,
    epoch,
    revision: 0,
    incarnation: _acquireSessionIncarnation(id),
    resolve: _noopSettle,
    reject: _noopSettle,
  });
  return { key, epoch, revision: 0, opts: guarded };
}

/** Drop a parked snapshot once its own save path took over (or on close). */
export function unparkSessionSnapshotForDrain(handle) {
  if (handle?.key === undefined) return;
  const parked = _deferredSessionSaves.get(handle.key);
  if (parked) _releaseSessionIncarnation(parked.incarnation);
  _deferredSessionSaves.delete(handle.key);
}

/**
 * Hard delete: drop ALL save bookkeeping owned by the retired incarnation —
 * deferred/parked snapshots, the in-flight slot and the latest-wins queued
 * follow-up — so nothing (the exit drain included) can re-create the file, and
 * so a RE-CREATED id starts from an empty slot instead of queueing behind a
 * dead write. Settled as resolved: the session is gone, so the write is moot
 * (rejecting would strand unhandled rejections on finished callers).
 * Returns how many entries were purged.
 */
export function purgeSessionSaveBookkeeping(id) {
  if (!id) return 0;
  let purged = 0;
  for (const [key, pending] of [..._deferredSessionSaves]) {
    if (pending?.session?.id !== id) continue;
    _deferredSessionSaves.delete(key);
    _releaseSessionIncarnation(pending.incarnation);
    purged += 1;
    try {
      pending.resolve();
    } catch {
      /* best-effort */
    }
  }
  // The in-flight slot and the queued follow-up belong to the retired
  // incarnation: their replies settle inert, so free the slots now.
  _saveAsyncInflight.delete(id);
  const queued = _saveAsyncQueued.get(id);
  if (queued) {
    _saveAsyncQueued.delete(id);
    _releaseSessionIncarnation(queued.incarnation);
    purged += 1;
    for (const w of queued.waiters) {
      try {
        w.resolve();
      } catch {
        /* best-effort */
      }
    }
  }
  // Also frees the worker-side base: a deleted id never saves again.
  forgetSessionSaveBaseline(id, { releaseWriteControl: true });
  return purged;
}

/**
 * TEST-ONLY, STRUCTURALLY GATED to the store's fault-injection test mode:
 * detach the live save worker exactly as its own 'error' handler would (module
 * pointer cleared, instance and its handlers left intact) and return it. That
 * is the real shape of the race — the next save spawns a replacement while the
 * detached instance can still emit its late 'exit'/'error'. Returns null when
 * the gate is absent, so production cannot reach it.
 *
 * Detaching with work in flight settles that work exactly like the 'error'
 * path: every waiter is rejected (failure recorded first, live snapshot
 * pinned), the queued slots are settled the same way and the worker ref is
 * released, so no promise and no ref-count can be orphaned.
 */
export function _detachSaveWorkerForTest() {
  if (!_sessionStoreTestMode()) return null;
  const worker = _saveWorker;
  if (!worker) return null;
  // The detached instance stays alive, so the ref its in-flight writes held
  // is dropped here (a dead worker's own handlers have nothing to unref).
  if (_saveWorkerRefCount > 0) {
    try {
      worker.unref();
    } catch {
      /* worker already gone */
    }
  }
  _retireWorkerBookkeeping(new Error('[session-store] save worker detached before this write settled'));
  return worker;
}

/**
 * TEST-ONLY, STRUCTURALLY GATED to the store's fault-injection test mode:
 * make the LIVE worker forget one id's delta base, leaving the worker instance
 * and the parent's delta baseline untouched. The next delta for that id then
 * legitimately answers `deltaMiss`, which is the only way to exercise the
 * parent's full-retry path deterministically.
 */
export function _evictWorkerDeltaBaseForTest(id) {
  if (!_sessionStoreTestMode() || !id || !_saveWorker) return false;
  try {
    _saveWorker.postMessage({ __evictBase: String(id) });
    return true;
  } catch {
    return false;
  }
}

/**
 * TEST-ONLY, STRUCTURALLY GATED read-only inspector: does the live worker
 * still hold a delta base for `id`? Used to prove that the eviction seam
 * touches exactly one id (and never clears the whole base map).
 */
export function _probeWorkerDeltaBaseForTest(id, { timeoutMs = 2000 } = {}) {
  if (!_sessionStoreTestMode() || !id || !_saveWorker) return Promise.resolve(null);
  const worker = _saveWorker;
  return new Promise((resolve) => {
    let timer = null;
    const onMessage = (message) => {
      const result = message?.__baseProbeResult;
      if (!result || result.id !== id) return;
      worker.off('message', onMessage);
      if (timer) clearTimeout(timer);
      resolve(result.hasBase === true);
    };
    worker.on('message', onMessage);
    timer = setTimeout(() => {
      worker.off('message', onMessage);
      resolve(null);
    }, timeoutMs);
    // Deliberately NOT unref'd: the probe must settle even when nothing
    // else keeps the loop alive (an unref'd timer would strand it).
    try {
      worker.postMessage({ __baseProbe: String(id) });
    } catch {
      worker.off('message', onMessage);
      if (timer) clearTimeout(timer);
      resolve(null);
    }
  });
}
