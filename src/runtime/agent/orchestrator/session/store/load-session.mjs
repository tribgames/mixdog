/**
 * Public session read: decides which copy of a session speaks for its id —
 * the record (its log, or its legacy json), a debounced copy not yet
 * recorded, or the live snapshot. Nothing here writes; the precedence rules
 * are the whole responsibility.
 */
import { _liveSessions, _droppedSaveIds, hasSessionSaveFailure, _clearLiveSession } from './live-state.mjs';
import { _readStoredSessionCached } from './load-cache.mjs';
import { _ensureLifecycleFields } from './serialize.mjs';
import { pendingSessionCopy } from './pending-writes.mjs';
import { sessionRecordStampSync } from './session-log-reader.mjs';
import { sessionLogRecordPath, sessionRecordPath } from './session-paths.mjs';
import { isSettledRecordStamp } from './session-record.mjs';

/** This process's in-memory copies of `id`, as resolveSessionCopy weighs them. */
export function sessionMemoryCopies(id) {
  return {
    pending: pendingSessionCopy(id),
    live: _liveSessions.get(id),
    droppedSave: _droppedSaveIds.has(id),
    failedSave: hasSessionSaveFailure(id),
  };
}

/** The in-memory copy that speaks for `id` over its readable record `stored`
 *  (a document or just its `{ id, generation }` header; null when there is no
 *  record), or null when the record does. */
export function inMemorySessionCopy(id, memory, stored) {
  // Read-your-writes: a debounced copy is newer than the record.
  if (memory.pending?.id === id) return memory.pending;
  const live = memory.live;
  if (live?.id !== id) return null;
  // A higher record generation means another process took ownership. A
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
 * 'unreadable', 'record' or 'absent'.
 */
export function resolveSessionCopy(id, memory, record) {
  if (record.exists && !record.session) {
    // An existing-but-unreadable record OWNS the identity: it is REPORTED
    // (null), never masked by whatever this process holds in memory — except
    // the live copy of a session whose own save failed here: its records are
    // still queued (they land with the next write), so it is the newest copy.
    const live = memory.live;
    return memory.failedSave && live?.id === id
      ? { session: live, from: 'failed-save' }
      : { session: null, from: 'unreadable' };
  }
  const inMemory = inMemorySessionCopy(id, memory, record.session);
  if (inMemory) return { session: inMemory, from: 'memory' };
  return record.session ? { session: record.session, from: 'record' } : { session: null, from: 'absent' };
}

export function loadSession(id, { headerOnly = false } = {}) {
  const memory = sessionMemoryCopies(id);
  // An existing record owns this identity. It must read as this session's
  // before fresher in-memory state is allowed to shadow it; the cache keeps
  // only its header when that header proves the in-memory copy is served. A
  // session this process is writing is vouched for by its recorder, a batch
  // being written included (SessionLogRecorder.knownGeneration), so its log
  // is not read to serve the copy held here.
  const disk = _readStoredSessionCached(id, {
    preferInMemory: (stored) => inMemorySessionCopy(id, memory, stored),
    headerOnly,
  });
  const { session, from } = resolveSessionCopy(id, memory, disk);
  // The record (or its absence) outranks a live snapshot that no longer speaks for the id.
  if ((from === 'record' || from === 'absent') && memory.live?.id === id) _clearLiveSession(id);
  return session ? _ensureLifecycleFields(session) : null;
}

// `status` of loadSession(id), for the agent-status pulse: it reads every
// worker's status every two seconds. The answer is reused only while the
// record keeps the exact settled stamp it was read under and no in-memory
// copy can speak for the id instead; anything else asks loadSession again.
const STATUS_CACHE_LIMIT = 4096;
const _statusById = new Map(); // id -> { stamp, status }

function _observeStamp(id) {
  try {
    return sessionRecordStampSync({ jsonPath: sessionRecordPath(id), logPath: sessionLogRecordPath(id) });
  } catch {
    return null;
  }
}

export function loadSessionStatus(id) {
  const inMemory = () => pendingSessionCopy(id) !== null || _liveSessions.has(id);
  const before = inMemory() ? null : _observeStamp(id);
  const cached = before ? _statusById.get(id) : null;
  if (cached && cached.stamp === before) return cached.status;
  _statusById.delete(id);
  // Its status is a field of the record's header: a log is not replayed whole for it.
  const status = loadSession(id, { headerOnly: true })?.status ?? null;
  if (before && isSettledRecordStamp(before) && !inMemory() && before === _observeStamp(id)) {
    if (_statusById.size >= STATUS_CACHE_LIMIT) _statusById.delete(_statusById.keys().next().value);
    _statusById.set(id, { stamp: before, status });
  }
  return status;
}
