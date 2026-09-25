/**
 * File-based session store.
 * Sessions are saved to disk so CLI and MCP server can share state,
 * and sessions survive server restarts (resume).
 */
import { writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { sessionPath } from './store/paths-heartbeat.mjs';
import {
  guardedSaveOptions as _guardedSaveOptions,
  cancelSessionWrites as _cancelSessionWrites,
  acquireWriteCommit as _acquireWriteCommit,
  releaseWriteCommit as _releaseWriteCommit,
  waitForWriteCommit as _waitForWriteCommit,
  publishLandedWriteEpoch as _publishLandedWriteEpoch,
  isStaleWriteEpoch as _isStaleWriteEpoch,
  WRITE_COMMIT_TIMEOUT as _WRITE_COMMIT_TIMEOUT,
  WRITE_COMMIT_STALE as _WRITE_COMMIT_STALE,
} from './store/write-guards.mjs';
import { _flushPendingSummaryOps } from './store-summary-index.mjs';
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
export {
  publishHeartbeat,
  deleteHeartbeat,
  publishSessionPresence,
  deleteSessionPresence,
  readSessionPresenceMtime,
  isSessionPresenceOwnerDead,
  readSessionHeartbeatOwnerPid,
  isSessionHeartbeatOwnerDead,
  isProcessAlive,
} from './store/paths-heartbeat.mjs';
import { _sessionForDisk, _ensureLifecycleFields } from './store/serialize.mjs';
import {
  _cacheSessionSummary,
  _rollbackCachedSessionSummary,
  _queueSessionSummaryUpsert,
} from './store/summary-cache.mjs';
import { _shouldDrop, _sessionWriteAuthorityRefusal } from './store/write-admission.mjs';
import {
  lifecycleOfSessionDocument as _lifecycleOfSessionDocument,
  stampSessionScratch as _stampSessionScratch,
  recordOwnSessionCommit as _recordOwnSessionCommit,
} from './store/canonical-reader.mjs';
// Durable lifecycle reads, heartbeat freshness and live-cache reclamation are
// owned by dedicated modules; re-exported so prior importers of store.mjs
// stay unchanged.
export { readSessionLifecycleFromDisk, readSessionLifecycleStateFromDisk } from './store/lifecycle-read.mjs';
export { readSessionHeartbeatMtime } from './store/liveness-veto.mjs';
export { evictLiveSession, evictIdleLiveSessions } from './store/live-cache-eviction.mjs';
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
} from './store/live-state.mjs';
import {
  _saveWorkerPending,
  _saveAsyncQueued,
  _deferredSessionSaves,
  _resetSaveWorkerBookkeeping,
} from './store/save-worker.mjs';
import { _publishLiveSession } from './store/session-observers.mjs';
import {
  _savePending,
  _debounceTimers,
  _clearDebounce,
  _releasePayloadIncarnation,
  _releasePendingSlot,
} from './store/pending-saves.mjs';
import {
  _commitSessionWrite,
  _discardSaveTmp,
  _trackSaveTmp,
  _untrackSaveTmp,
  sweepOrphanSessionTmpFiles,
} from './store/save-fault.mjs';
export { setLiveSession, getSessionSaveError, clearSessionSaveError } from './store/live-state.mjs';
export { getSessionLifecycleCommitError, clearSessionLifecycleCommitError } from './store/live-state.mjs';
// Test-gated save-fault seam + scratch-file hygiene (see store/save-fault.mjs).
export { setSessionSaveFault, sweepOrphanSessionTmpFiles } from './store/save-fault.mjs';
export { saveSessionAsync, saveSessionAsyncDeferred } from './store/save-worker.mjs';
// Deferred-snapshot registration for modules that throttle their own saves
// (usage-metrics): merges into the canonical drain instead of a second exit
// flush path.
export { parkSessionSnapshotForDrain, unparkSessionSnapshotForDrain } from './store/save-worker.mjs';

// Observer registries (hard-delete purge hooks + the in-process live-session
// publication seam) live in store/session-observers.mjs; re-exported here so
// prior importers of store.mjs stay unchanged.
export { registerSessionPurgeHook, subscribeLiveSessions } from './store/session-observers.mjs';
// Pending-write slots, debounce timers and their incarnation references live
// in store/pending-saves.mjs (imported above).

/**
 * Surface an async save rejection. The id-wide error marker may only be
 * stamped while this payload still speaks for the id — after a hard delete (or
 * an id reuse) it belongs to another incarnation.
 */
function _recordAsyncSaveError(err) {
  // DIAGNOSTIC ONLY. The authoritative marker (with its immutable failure
  // snapshot and incarnation check) is stamped inside _doSave; stamping a
  // second, unconditional one here is exactly how a delayed rejection used
  // to mark a hard-deleted or re-created id.
  process.stderr.write(`[session-store] save failed: ${err?.message}\n`);
}

/** Start the async write of `payload`; a write that does not land rolls back
 *  the optimistic summary row it cached. */
function _startAsyncSave(id, payload) {
  _doSave(payload)
    .then((outcome) => {
      if (outcome !== SAVE_OUTCOME_SAVED) _rollbackCachedSessionSummary(id, payload.summaryVersion);
    })
    .catch((err) => {
      _rollbackCachedSessionSummary(id, payload.summaryVersion);
      _recordAsyncSaveError(err);
    });
}

// Self-registered exit drain; bare 'exit' hook stays as idempotent backup. Use the more comprehensive
// drainSessionStore so debounce + scheduled + writing payloads all flush.
process.on('exit', drainSessionStore);

/**
 * Persist a session. `opts.expectedGeneration` guards against resurrecting a
 * session that was closed mid-flight: before the rename, we re-read the file
 * on disk and, if it's already marked closed with a >= generation, drop the
 * write. There is NO bypass of the canonical ownership check — the lifecycle
 * barriers (markSessionClosed / bumpSessionGeneration) write their tombstone
 * directly, under their own authority read, so no save path needs one.
 */
export function saveSession(session, opts) {
  _ensureLifecycleFields(session);
  const id = session.id;
  // PRE-ADMISSION for EVERY entry mode (sync, immediate, debounced): a
  // foreign/ambiguous/unreadable canonical record is never cached as locally
  // owned, not even transiently, so this runs BEFORE setLiveSession and the
  // optimistic summary row. True absence stays creatable.
  const refusal = _sessionWriteAuthorityRefusal(id);
  // A refused record publishes NOTHING: no live snapshot, no optimistic
  // summary row. The write itself still travels the normal path, where the
  // strict under-lock admission refuses it and produces the established
  // outcome/markers — only the local "owned" caches are never touched.
  if (!refusal) {
    setLiveSession(session);
    _publishLiveSession(session);
  }
  const summaryVersion = refusal ? null : _cacheSessionSummary(session);
  // Identity of THIS attempt: only a landed save at least this new may clear
  // the id's failure/drop markers (see live-state _clearSaveStateIfCurrent),
  // and a write older than what already landed may not commit at all (the
  // epoch travels inside the write guard, so the worker realm sees it too).
  const epoch = _nextSaveEpoch();
  // Incarnation of the id at ISSUE time: a hard delete (or a re-created id)
  // makes this payload's markers inert on settlement.
  const incarnation = _acquireSessionIncarnation(id);
  const payload = {
    session,
    opts: _guardedSaveOptions(id, opts, epoch),
    summaryVersion,
    epoch,
    // `incarnation` is the releasable OWNERSHIP reference; `settlement` is
    // the immutable identity a late settlement proves membership with.
    incarnation,
    settlement: incarnation,
  };
  // Synchronous durability path — explicit flush (tombstones, drain hooks).
  // createSession uses async debounced save + _liveSessions for same-process
  // read-your-writes; sync remains for callers that require immediate disk.
  if (opts?.sync) {
    try {
      if (_doSaveSync(payload) !== SAVE_OUTCOME_SAVED) _rollbackCachedSessionSummary(id, summaryVersion);
    } catch (err) {
      _rollbackCachedSessionSummary(id, summaryVersion);
      throw err;
    }
    return;
  }
  // Immediate-flush override: tombstone plants and explicit flushes skip the
  // debounce so close-session writes are always durable.
  if (opts?.immediate) _saveImmediate(id, payload);
  else _saveDebounced(id, payload);
}

function _saveImmediate(id, payload) {
  _clearDebounce(id);
  const pending = _savePending.get(id);
  if (!pending) {
    _savePending.set(id, { writing: true, payload });
    _startAsyncSave(id, payload);
  } else if (pending.writing) {
    _releasePayloadIncarnation(pending.queued);
    _savePending.set(id, { ...pending, queued: payload });
  } else {
    _releasePayloadIncarnation(pending.payload);
    _savePending.set(id, { ...pending, payload });
    _flushScheduled(id);
  }
}

function _saveDebounced(id, payload) {
  const pending = _savePending.get(id);
  if (pending) {
    if (pending.writing) {
      // Write in flight — overwrite the queued slot. Multiple async
      // saves for the same id while one is on disk collapse into a
      // single follow-up write.
      _releasePayloadIncarnation(pending.queued);
      _savePending.set(id, { ...pending, queued: payload });
    } else if (pending.scheduled) {
      // setImmediate already scheduled — coalesce into the same tick
      // by overwriting the pending payload with the latest state.
      _releasePayloadIncarnation(pending.payload);
      _savePending.set(id, { scheduled: true, payload });
    } else if (pending.debouncing) {
      // 150 ms debounce window active — overwrite payload, timer keeps running.
      _releasePayloadIncarnation(pending.payload);
      _savePending.set(id, { debouncing: true, payload });
    }
    return;
  }
  // First save for this id — open a 150 ms debounce window.  Any additional
  // calls within the window overwrite the payload; only one tmp+rename fires.
  // The setImmediate inside the timeout body provides the original coalescing
  // guarantee within the same event-loop tick at the moment the timer fires.
  _savePending.set(id, { debouncing: true, payload });
  const t = setTimeout(() => {
    _debounceTimers.delete(id);
    const cur = _savePending.get(id);
    if (!cur?.debouncing) return; // already handled (writing/queued)
    _savePending.set(id, { scheduled: true, payload: cur.payload });
    setImmediate(() => _flushScheduled(id));
  }, 150);
  if (t.unref) t.unref();
  _debounceTimers.set(id, t);
}

function _flushScheduled(id) {
  const cur = _savePending.get(id);
  if (!cur?.scheduled) return;
  _savePending.set(id, { writing: true, payload: cur.payload });
  _startAsyncSave(id, cur.payload);
}

/**
 * Exported for save-session-worker — not part of the public API.
 * External callers should use saveSession / saveSessionAsync.
 * Returns a SAVE_OUTCOME_* reason, never a bare boolean: the worker relays it
 * so the parent can tell an ownership drop from a stale-epoch refusal.
 */
export function _saveSessionSync(session, opts, options = {}) {
  _ensureLifecycleFields(session);
  // The worker realm mints no identity of its own: the authoritative epoch
  // arrives with the guard the parent stamped.
  const guardEpoch = opts?._sessionWriteGuard?.epoch;
  return _doSaveSync({
    session,
    opts: opts || null,
    // A caller that already owns the snapshot's identity (the exit drain)
    // passes it through; minting a fresh epoch there would make an OLD
    // snapshot look like the newest attempt and let it clear markers.
    epoch: [options.epoch, guardEpoch].find(Number.isFinite) ?? _nextSaveEpoch(),
    commitTimeoutMs: options.commitTimeoutMs,
    // The save worker realm passes false: its parent publishes the row it
    // captured for this payload when the write lands (save-worker.mjs
    // _settleLandedWrite). Publishing here too flushed the index a second
    // time from the worker thread, after its reply told the parent the save
    // was done and where no parent drain or settle can see it.
    publishSummary: options.publishSummary !== false,
    // Own reference to the id's current incarnation (released by
    // _doSaveSync): a hard delete during this write makes its markers
    // inert without affecting anybody else's stamp.
    incarnation: _acquireSessionIncarnation(session.id),
  });
}

function _doSaveSync(payload) {
  const {
    session,
    opts,
    summaryVersion = null,
    epoch = null,
    commitTimeoutMs = null,
    incarnation = null,
    publishSummary = true,
  } = payload;
  const id = session.id;
  // Settlement identity is IMMUTABLE and separate from the (releasable)
  // ownership reference: purging may null the ref, but a late settlement
  // must still be able to prove which incarnation it belonged to.
  const settlement = payload.settlement ?? incarnation;
  const mayMutate = () => _isCurrentSessionIncarnation(id, settlement);
  // EVERY exit — stale, drop, refusal, success, throw — releases the
  // ownership reference exactly once through this finally.
  try {
    // A newer write for this id already landed: committing these bytes would
    // REVERT durable history. Refuse before any scratch file is written and
    // before any marker is touched (no failure, no drop — nothing was lost).
    if (_isStaleWriteEpoch(opts)) return SAVE_OUTCOME_STALE;
    if (_shouldDrop(id, opts)) {
      if (mayMutate()) _recordSaveDrop(id, epoch);
      return SAVE_OUTCOME_DROPPED;
    }
    const target = sessionPath(id);
    const tmp = _trackSaveTmp(`${target}.${randomBytes(6).toString('hex')}.tmp`);
    // The EXACT bytes this attempt tried to commit; failure evidence is
    // rebuilt from them, never re-read from the later mutable live session.
    let attempted = null;
    try {
      const disk = _sessionForDisk(session);
      attempted = JSON.stringify(disk);
      // The lifecycle these exact bytes carry, recorded with the commit stamp.
      const lifecycle = _lifecycleOfSessionDocument(disk);
      writeFileSync(tmp, attempted, 'utf-8');
      if (_shouldDrop(id, opts)) {
        _discardSaveTmp(tmp);
        if (mayMutate()) _recordSaveDrop(id, epoch);
        return SAVE_OUTCOME_DROPPED;
      }
      const commitControl = _acquireWriteCommit(opts, { timeoutMs: commitTimeoutMs });
      if (commitControl === _WRITE_COMMIT_STALE) {
        // The newer write landed while we waited for the lock.
        _discardSaveTmp(tmp);
        return SAVE_OUTCOME_STALE;
      }
      if (commitControl === _WRITE_COMMIT_TIMEOUT) {
        // Bounded acquisition (exit drain): another realm still holds the
        // rename lock. Surface it as a save failure — canonical file is
        // untouched, the live snapshot stays pinned — instead of blocking
        // process exit on an unbounded wait.
        const busy = new Error(`[session-store] ${id}: commit lock busy after ${commitTimeoutMs}ms`);
        busy.code = 'ECOMMITBUSY';
        throw busy;
      }
      if (commitControl === false || _shouldDrop(id, opts)) {
        _discardSaveTmp(tmp);
        _releaseWriteCommit(commitControl);
        if (mayMutate()) _recordSaveDrop(id, epoch);
        return SAVE_OUTCOME_DROPPED;
      }
      try {
        const scratch = _stampSessionScratch(tmp);
        _commitSessionWrite(tmp, target, id);
        _recordOwnSessionCommit(target, scratch, lifecycle);
        _publishLandedWriteEpoch(opts, epoch);
        _untrackSaveTmp(tmp);
        if (mayMutate()) {
          if (publishSummary) _queueSessionSummaryUpsert(session, summaryVersion);
          _clearSaveStateIfCurrent(id, epoch);
        }
      } finally {
        _releaseWriteCommit(commitControl);
      }
      return SAVE_OUTCOME_SAVED;
    } catch (err) {
      // The canonical file was never renamed over, so it still holds the
      // last-good session JSON. Flag the id (live snapshot becomes the only
      // good copy of the newest turn), reclaim the scratch file, and rethrow
      // so the caller SEES the failure instead of a silent no-op.
      _discardSaveTmp(tmp);
      // The snapshot is recorded WITH the failure: it is the evidence that
      // lets loadSession serve this exact copy while the canonical file is
      // unreadable (and nothing else may).
      if (mayMutate()) _recordSaveFailure(id, err, epoch, _snapshotFromAttempt(attempted, id));
      throw err;
    }
  } finally {
    _releasePayloadIncarnation(payload);
  }
}

/**
 * Rebuild failure evidence from the EXACT bytes an attempt tried to commit.
 * Never the live session: by settlement time that object may already carry a
 * newer (unattempted) turn, which must not be published as the recovery copy.
 */
function _snapshotFromAttempt(attemptedJson, id) {
  if (typeof attemptedJson !== 'string') return null;
  try {
    const parsed = JSON.parse(attemptedJson);
    return parsed && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

// ONE absolute budget for the WHOLE drain: the commit-lock waits and the
// bounded commit acquisitions of every id share it, so exit cost cannot scale
// with the number of contended sessions. Exit must never hang on a stuck
// writer; an id left unflushed is recorded + live-pinned instead.
const DRAIN_BUDGET_MS = 400;

/**
 * Sync-flush every pending save on exit.
 *
 * Ordering contract (each step depends on the previous one):
 *   1. collect the NEWEST payload per id across debounce/pending, the worker's
 *      in-flight + latest-wins queued slots and the deferred snapshots, ranked
 *      by the SAVE EPOCH each snapshot was issued with (never by which slot it
 *      happens to sit in: a deferred snapshot can be older than a later sync
 *      or async attempt);
 *   2. CANCEL every one of those ids, invalidating the write guards those
 *      async payloads carry — a worker write still in the queue drops itself
 *      (_shouldDrop) and one already past that check is refused under the lock
 *      by _acquireWriteCommit;
 *   3. retire commits already in progress within the shared deadline;
 *   4. sync-write the newest payload per id with a FRESH guard, under its OWN
 *      epoch and the remaining budget.
 * So no older worker write can rename over the newest state afterwards, and
 * no step can block process exit indefinitely.
 */
export function drainSessionStore() {
  for (const t of _debounceTimers.values()) clearTimeout(t);
  _debounceTimers.clear();
  const newest = _collectNewestDrainPayloads();
  // ── 2/3. cancel, then retire in-flight commits inside ONE deadline ─────
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  for (const id of newest.keys()) _cancelSessionWrites(id);
  for (const id of newest.keys()) {
    const budget = remainingMs();
    if (budget === 0) break; // deadline spent: no further lock waits
    _waitForWriteCommit(id, { timeoutMs: budget });
  }
  // ── 4. write the newest state per id under a FRESH (uncancelled) guard ──
  for (const [id, entry] of newest) {
    try {
      // The commit shares the SAME deadline and keeps the snapshot's own
      // epoch. Once the deadline is spent the budget is 0: an UNCONTENDED
      // id still commits (no wait is needed for a free lock), a contended
      // one is refused immediately — never another lock wait. A refused
      // write fails loudly (recorded + live-pinned) and exit proceeds.
      // The guard carries the snapshot's OWN epoch, so a payload older
      // than what already LANDED is refused instead of reverting disk.
      _saveSessionSync(entry.session, _guardedSaveOptions(id, entry.opts, entry.epoch), {
        epoch: entry.epoch,
        commitTimeoutMs: remainingMs(),
      });
      entry.ok = true;
    } catch (err) {
      process.stderr.write(`[session-store] drain save failed: ${err?.message}\n`);
    }
  }
  for (const [, pending] of _savePending) _releasePendingSlot(pending);
  _savePending.clear();
  _settleDrainedWaiters(newest);
  // Also unrefs the worker for writes retired above, so a superseded write
  // can never keep the process alive.
  _resetSaveWorkerBookkeeping();
  // Summary-index ops queued by the writes above: one last best-effort sync
  // flush before exit (losing them is acceptable — the index self-heals).
  try {
    _flushPendingSummaryOps({ sync: true });
  } catch {
    /* best-effort */
  }
  // Last retry of the scratch files THIS realm minted and failed to unlink.
  // `drain` walks the WHOLE registry in bounded chunks (bounded total
  // attempts, one attempt per path) so more than one chunk of orphans cannot
  // survive exit; registry-only, nothing in sessions/ is scanned.
  try {
    sweepOrphanSessionTmpFiles({ drain: true });
  } catch {
    /* best-effort */
  }
}

/** Drain step 1: the newest payload per id, by SAVE EPOCH. */
function _collectNewestDrainPayloads() {
  const newest = new Map(); // id → { session, opts, epoch, revision, ok }
  // Ranked by (epoch, revision). The revision breaks ties WITHIN one
  // issuance identity: an in-flight worker payload and a parked snapshot can
  // share an epoch while the park already holds a NEWER distinct payload
  // (the ref was replaced behind the write). Map/source order must never
  // decide that, and minting a newer epoch here would hand an old snapshot
  // fresh write authority.
  const record = (id, session, opts, epoch, revision) => {
    if (!id || !session) return;
    const issued = Number.isFinite(epoch) ? epoch : 0;
    const rev = Number.isFinite(revision) ? revision : 0;
    const current = newest.get(id);
    if (current && (current.epoch > issued || (current.epoch === issued && current.revision >= rev))) return;
    newest.set(id, { session, opts: opts || null, epoch: issued, revision: rev, ok: false });
  };
  for (const [id, pending] of _savePending) {
    // Both slots are candidates; the payload's own epoch decides, so a
    // `queued` follow-up wins because it is NEWER, not because of its slot.
    record(id, pending.payload?.session, pending.payload?.opts, pending.payload?.epoch, 0);
    record(id, pending.queued?.session, pending.queued?.opts, pending.queued?.epoch, 0);
  }
  for (const [, pending] of _saveWorkerPending)
    record(pending.id, pending.session, pending.opts, pending.epoch, pending.revision);
  for (const [id, q] of _saveAsyncQueued) record(id, q.session, q.opts, q.epoch, q.revision);
  for (const [, pending] of _deferredSessionSaves)
    record(pending.session?.id, pending.session, pending.opts, pending.epoch, pending.revision);
  return newest;
}

/**
 * Settle every async waiter: the drain already wrote their newest state,
 * so the promise result is informational (the caller is at process exit).
 * The marker makes this settlement TERMINAL for its owner: the drain took
 * ownership of durability for these ids and cleared their deferred
 * handles, so a receiver must not re-park or retry (that would mint a
 * fresh epoch and could overwrite a save that lands after the drain).
 */
function _settleDrainedWaiters(newest) {
  const _drainErr = new Error('[session-store] drain: worker-queue interrupted by process exit');
  _drainErr.code = 'ESESSIONSTOREDRAINED';
  _drainErr.sessionStoreDrained = true;
  for (const [, pending] of _saveWorkerPending) {
    for (const w of pending.waiters) {
      try {
        w.reject(_drainErr);
      } catch {
        /* best-effort */
      }
    }
    // This map is cleared below, so its references are freed here (the
    // worker-side reset then sees an empty map).
    _releaseSessionIncarnation(pending.incarnation);
  }
  for (const [, q] of _saveAsyncQueued) {
    for (const w of q.waiters) {
      try {
        w.reject(_drainErr);
      } catch {
        /* best-effort */
      }
    }
  }
  for (const [, pending] of _deferredSessionSaves) {
    const entry = newest.get(pending.session?.id);
    if (entry?.ok) pending.resolve();
    else pending.reject(_drainErr);
    _releaseSessionIncarnation(pending.incarnation);
  }
  _deferredSessionSaves.clear();
  _saveWorkerPending.clear();
}

/**
 * Promote the queued follow-up of the slot THIS payload owns. A stale
 * completion (hard-deleted id, bookkeeping already re-created by a new
 * incarnation) must never promote or clear somebody else's queue, so the slot
 * is matched by payload identity — never by id alone.
 */
function _drainQueue(id, payload = null) {
  const pending = _savePending.get(id);
  if (!pending) return;
  if (payload && pending.payload !== payload && pending.queued !== payload) return;
  if (pending.queued) {
    const next = pending.queued;
    _releasePayloadIncarnation(pending.payload === next ? null : pending.payload);
    _savePending.set(id, { writing: true, payload: next });
    _startAsyncSave(id, next);
  } else {
    _releasePendingSlot(pending);
    _savePending.delete(id);
  }
}

async function _doSave(payload) {
  const { session, opts, summaryVersion = null, epoch = null, incarnation = null } = payload;
  const id = session.id;
  // Same fences as the sync path, on the IMMUTABLE settlement identity: a
  // delayed failure/drop for a hard-deleted (or re-created) id moves nothing.
  const settlement = payload.settlement ?? incarnation;
  const mayMutate = () => _isCurrentSessionIncarnation(id, settlement);
  // Same freshness fence as the sync path (see _doSaveSync).
  if (_isStaleWriteEpoch(opts)) {
    _releasePayloadIncarnation(payload);
    _drainQueue(id, payload);
    return SAVE_OUTCOME_STALE;
  }
  // First check: upfront, before any disk I/O. Cheap short-circuit when a
  // tombstone is already on disk when the caller arrives.
  if (_shouldDrop(id, opts)) {
    if (mayMutate()) _recordSaveDrop(id, epoch);
    _releasePayloadIncarnation(payload);
    _drainQueue(id, payload);
    return SAVE_OUTCOME_DROPPED;
  }
  const target = sessionPath(id);
  const tmp = _trackSaveTmp(`${target}.${randomBytes(6).toString('hex')}.tmp`);
  // Serialized BEFORE the first await: failure evidence is this exact
  // payload, never the live session as it looks at settlement time.
  let attempted = null;
  try {
    const disk = _sessionForDisk(session);
    attempted = JSON.stringify(disk);
    // Captured before the await: the lifecycle of exactly these bytes.
    const lifecycle = _lifecycleOfSessionDocument(disk);
    await fsp.writeFile(tmp, attempted, 'utf-8');
    // Second check: between the temp write and the rename, closeSession()
    // may have planted a tombstone. Re-check on disk; if a newer tombstone
    // now exists, discard our temp file rather than let rename clobber it.
    if (_shouldDrop(id, opts)) {
      _discardSaveTmp(tmp);
      process.stderr.write(`[session-store] ${id}: dropped stale save (tombstone planted during write)\n`);
      if (mayMutate()) _recordSaveDrop(id, epoch);
      _releasePayloadIncarnation(payload);
      _drainQueue(id, payload);
      return SAVE_OUTCOME_DROPPED;
    }
    const commitControl = _acquireWriteCommit(opts);
    if (commitControl === _WRITE_COMMIT_STALE) {
      _discardSaveTmp(tmp);
      _releasePayloadIncarnation(payload);
      _drainQueue(id, payload);
      return SAVE_OUTCOME_STALE;
    }
    if (commitControl === false || _shouldDrop(id, opts)) {
      _discardSaveTmp(tmp);
      _releaseWriteCommit(commitControl);
      if (mayMutate()) _recordSaveDrop(id, epoch);
      _releasePayloadIncarnation(payload);
      _drainQueue(id, payload);
      return SAVE_OUTCOME_DROPPED;
    }
    try {
      const scratch = _stampSessionScratch(tmp);
      _commitSessionWrite(tmp, target, id);
      _recordOwnSessionCommit(target, scratch, lifecycle);
      _publishLandedWriteEpoch(opts, epoch);
      _untrackSaveTmp(tmp);
      if (mayMutate()) {
        _queueSessionSummaryUpsert(session, summaryVersion);
        _clearSaveStateIfCurrent(id, epoch);
      }
    } finally {
      _releaseWriteCommit(commitControl);
    }
    _releasePayloadIncarnation(payload);
    _drainQueue(id, payload);
    return SAVE_OUTCOME_SAVED;
  } catch (err) {
    _discardSaveTmp(tmp);
    if (mayMutate()) {
      _recordSaveFailure(id, err, epoch, _snapshotFromAttempt(attempted, id));
      // Only OUR slot may be cleared: after a delete the id's pending
      // bookkeeping can already belong to a new incarnation.
      const pending = _savePending.get(id);
      if (pending && (pending.payload === payload || pending.queued === payload)) {
        _releasePendingSlot(pending);
        _savePending.delete(id);
      }
    }
    _releasePayloadIncarnation(payload);
    throw err;
  }
}

// Durable lifecycle barriers (tombstone plant + detach generation bump) live
// in store/lifecycle-barriers.mjs; re-exported so prior importers of
// store.mjs stay unchanged.
export { markSessionClosed, bumpSessionGeneration } from './store/lifecycle-barriers.mjs';
// Session reads live in store/load-session.mjs, same facade contract.
export { loadSession } from './store/load-session.mjs';

// Hard delete + owned-agent enumeration live in store/session-delete.mjs;
// re-exported here so prior importers of store.mjs stay unchanged.
export { deleteSession, listOwnedAgentSessionIds } from './store/session-delete.mjs';

// Listing / summaries / stale sweeping live in store/listing.mjs; re-exported
// here so importers keep one session-store entry point.
export {
  listStoredSessions,
  listStoredSessionSummaries,
  getStoredSessionsRaw,
  sweepStaleSessions,
  sweepStaleSessionsCooperative,
} from './store/listing.mjs';
export { _savePending } from './store/pending-saves.mjs';
