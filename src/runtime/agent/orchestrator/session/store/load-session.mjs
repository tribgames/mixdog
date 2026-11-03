/**
 * Public session read: decides which copy of a session speaks for its id —
 * the validated disk record, a queued/in-flight write payload, the live
 * snapshot, or the evidence-backed failed-save snapshot. Nothing here writes;
 * the precedence rules are the whole responsibility.
 */
import { sessionPath } from './session-paths.mjs';
import { _savePending } from './pending-saves.mjs';
import { _liveSessions, _droppedSaveIds, getFailedSaveSnapshot } from './live-state.mjs';
import { _readStoredSessionCached } from './load-cache.mjs';
import { _ensureLifecycleFields } from './serialize.mjs';
import { isSettledSessionStamp, sameSessionStamp, statSessionStamp } from './canonical-reader.mjs';

/** This process's in-memory copies of `id`, as resolveSessionCopy weighs them. */
export function sessionMemoryCopies(id) {
  return {
    pending: _savePending.get(id),
    live: _liveSessions.get(id),
    droppedSave: _droppedSaveIds.has(id),
    failedSave: () => getFailedSaveSnapshot(id),
  };
}

/** The in-memory copy that speaks for `id` over its readable record `stored`
 *  (a document or just its `{ id, generation }` header; null when there is no
 *  record), or null when the record does. */
export function inMemorySessionCopy(id, memory, stored) {
  // Read-your-writes: queued state is newer than the payload being written.
  const inMemory = (memory.pending?.queued || memory.pending?.payload)?.session;
  if (inMemory?.id === id) return inMemory;
  const live = memory.live;
  if (live?.id !== id) return null;
  // A higher disk generation means another process took ownership. A
  // dropped save is the exception: the live copy still contains unsaved
  // content, so a generation bump must not discard the only complete copy.
  const liveGen = typeof live.generation === 'number' ? live.generation : 0;
  const storedGen = stored && typeof stored.generation === 'number' ? stored.generation : 0;
  if (stored && storedGen > liveGen && !memory.droppedSave) return null;
  return live;
}

/**
 * Which copy speaks for `id`, loadSession's precedence as a pure decision:
 * `memory` from sessionMemoryCopies, `record` the disk read's `{ exists,
 * session }` (`session` null for an existing record that cannot be read).
 * Returns `{ session, from }`, `from` one of 'memory', 'failed-save',
 * 'unreadable', 'record' or 'absent'. Lifecycle fields and dropping a live
 * copy the record outranks are the caller's.
 */
export function resolveSessionCopy(id, memory, record) {
  if (record.exists && !record.session) {
    // An existing-but-unreadable file OWNS the identity: an externally
    // corrupted, foreign, ambiguous or half-written file from another
    // writer is REPORTED (null), never masked by whatever this process
    // happens to hold in memory.
    //
    // Exactly ONE exception, and it is evidence-based rather than
    // state-based: the snapshot whose OWN write to this path failed in
    // this process (getFailedSaveSnapshot). That failure proves the bytes
    // never landed, so this copy is strictly newer than the file and is
    // the only good same-process copy — hiding it would turn a surfaced
    // save failure into silent session loss for every public reader.
    // A generic pending payload / _liveSessions entry proves nothing about
    // disk and may NOT stand in: unrelated corruption stays visible.
    // Lifecycle and pending-ownership authorities do not come through
    // here at all (they read the durable record directly), so they keep
    // seeing 'unreadable' and failing closed.
    const recovered = memory.failedSave();
    return recovered?.id === id ? { session: recovered, from: 'failed-save' } : { session: null, from: 'unreadable' };
  }
  const inMemory = inMemorySessionCopy(id, memory, record.session);
  if (inMemory) return { session: inMemory, from: 'memory' };
  return record.session ? { session: record.session, from: 'record' } : { session: null, from: 'absent' };
}

export function loadSession(id) {
  const path = sessionPath(id);
  const memory = sessionMemoryCopies(id);
  // An existing file owns this identity. Its contents must validate before
  // fresher in-memory state is allowed to shadow it. The cache retains a
  // validated disk header, rather than a second transcript, when that header
  // proves the live/pending snapshot will be served.
  const disk = _readStoredSessionCached(id, path, {
    preferInMemory: (stored) => inMemorySessionCopy(id, memory, stored),
  });
  const { session, from } = resolveSessionCopy(id, memory, disk);
  // The record (or its absence) outranks a live snapshot that no longer speaks for the id.
  if ((from === 'record' || from === 'absent') && memory.live?.id === id) _liveSessions.delete(id);
  return session ? _ensureLifecycleFields(session) : null;
}

// `status` of loadSession(id), for the agent-status pulse: it reads every
// worker's status every two seconds, and an idle worker's whole transcript
// (released from the load cache's small document budget) was re-read and
// strictly re-parsed on every beat. The answer loadSession gave is reused only
// while the file keeps the exact settled full stamp it was read under and no
// in-memory copy (pending save, live snapshot, failed-save evidence) can speak
// for the id instead; anything else asks loadSession again.
const STATUS_CACHE_LIMIT = 4096;
const _statusByPath = new Map(); // path -> { stamp, status }

function _observeStamp(path) {
  try {
    return statSessionStamp(path);
  } catch {
    return null;
  }
}

export function loadSessionStatus(id) {
  const path = sessionPath(id);
  const inMemory = _savePending.has(id) || _liveSessions.has(id) || getFailedSaveSnapshot(id);
  const before = inMemory ? null : _observeStamp(path);
  const cached = before ? _statusByPath.get(path) : null;
  if (cached && sameSessionStamp(cached.stamp, before)) return cached.status;
  _statusByPath.delete(path);
  const status = loadSession(id)?.status ?? null;
  if (
    before &&
    isSettledSessionStamp(before) &&
    !_savePending.has(id) &&
    !_liveSessions.has(id) &&
    sameSessionStamp(before, _observeStamp(path))
  ) {
    if (_statusByPath.size >= STATUS_CACHE_LIMIT) _statusByPath.delete(_statusByPath.keys().next().value);
    _statusByPath.set(path, { stamp: before, status });
  }
  return status;
}
