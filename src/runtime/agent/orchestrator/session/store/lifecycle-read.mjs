/**
 * Durable lifecycle reads for a session id: the record's own lifecycle,
 * straight from disk through the legacy seam (the log's header, or the
 * legacy json), with no live/pending cache anywhere in the path. These are
 * the authority the ask/resume split-brain guards and the pending-message
 * lifecycle gate fail closed on.
 */
import { resolveSessionRecordSync, sessionRecordStampSync } from './session-log-reader.mjs';
import { sessionLogRecordPath, sessionRecordPath } from './session-paths.mjs';
import { loadLegacySession } from './legacy-session.mjs';
import { isSettledRecordStamp } from './session-record.mjs';

/**
 * Cheap authoritative lifecycle read straight from disk (no live/pending
 * cache). Returns null for BOTH true absence and an unreadable record;
 * callers that must tell those apart use readSessionLifecycleStateFromDisk.
 */
export function readSessionLifecycleFromDisk(id) {
  const state = readSessionLifecycleStateFromDisk(id);
  if (state.state !== 'open' && state.state !== 'closed') return null;
  return { generation: state.generation, closed: state.state === 'closed' };
}

// Verdicts read under a settled record stamp, reused while it is unchanged.
const LIFECYCLE_CACHE_LIMIT = 256;
const _verdicts = new Map(); // id → { stamp, value }

function lifecycleOf(outcome, id) {
  if (outcome.kind === 'absent') return { state: 'absent', generation: 0 };
  const session = outcome.kind === 'log' || outcome.kind === 'orphan' ? { ...outcome.log.header, id: outcome.log.sessionId } : outcome.session;
  // Durable identity is MANDATORY: missing / empty / foreign identity fails
  // closed exactly like an unreadable record.
  if (!session || session.id !== id) return { state: 'unreadable', generation: 0 };
  const closed = session.closed;
  const generation = session.generation;
  if (closed !== undefined && typeof closed !== 'boolean') return { state: 'unreadable', generation: 0 };
  if (generation !== undefined && (typeof generation !== 'number' || !Number.isFinite(generation))) {
    return { state: 'unreadable', generation: 0 };
  }
  return { state: closed === true ? 'closed' : 'open', generation: typeof generation === 'number' ? generation : 0 };
}

/**
 * Same durable read, with the outcome discriminated so a caller can fail
 * CLOSED on an unreadable record while still allowing true absence:
 *   'absent'     — neither the log nor the json exists
 *   'open'       — record not tombstoned (generation carried)
 *   'closed'     — tombstone (generation carried)
 *   'unreadable' — IO error, an invalid log, malformed/ambiguous json, or an
 *                  identity that is not EXACTLY this session.
 */
export function readSessionLifecycleStateFromDisk(id) {
  if (!id) return { state: 'unreadable', generation: 0 };
  const files = { jsonPath: sessionRecordPath(id), logPath: sessionLogRecordPath(id) };
  let stamp = null;
  try {
    stamp = sessionRecordStampSync(files);
  } catch {
    stamp = null;
  }
  const cached = stamp ? _verdicts.get(id) : null;
  if (cached && cached.stamp === stamp) return cached.value;
  let value;
  try {
    value = lifecycleOf(resolveSessionRecordSync({ ...files, loadLegacy: loadLegacySession, messages: false }), id);
  } catch (err) {
    value =
      err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? { state: 'absent', generation: 0 } : { state: 'unreadable', generation: 0 };
  }
  _verdicts.delete(id);
  let after = null;
  try {
    after = sessionRecordStampSync(files);
  } catch {
    after = null;
  }
  if (stamp && after === stamp && isSettledRecordStamp(stamp)) {
    _verdicts.set(id, { stamp, value });
    while (_verdicts.size > LIFECYCLE_CACHE_LIMIT) _verdicts.delete(_verdicts.keys().next().value);
  }
  return value;
}
