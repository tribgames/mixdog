/**
 * Durable lifecycle reads for a session id: the canonical file's own record,
 * straight from disk, with no live/pending cache anywhere in the path. These
 * are the authority the ask/resume split-brain guards and the pending-message
 * lifecycle gate fail closed on, so they stay independent of every write
 * path and of the in-memory snapshot caches.
 */
import { readFileSync } from 'node:fs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../lifecycle-scan.mjs';
import { sessionPath } from './paths-heartbeat.mjs';

/**
 * Cheap authoritative lifecycle read straight from disk (no live/pending
 * cache). Used by askSession's split-brain re-adoption: a new ask on a
 * non-closed session claims ownership by adopting the on-disk generation.
 * Returns null for BOTH true absence and an unreadable record; callers that
 * must tell those apart use readSessionLifecycleStateFromDisk below.
 */
export function readSessionLifecycleFromDisk(id) {
  const state = readSessionLifecycleStateFromDisk(id);
  if (state.state !== 'open' && state.state !== 'closed') return null;
  return { generation: state.generation, closed: state.state === 'closed' };
}

/**
 * Same durable read, but with the outcome discriminated so a caller can fail
 * CLOSED on an unreadable/corrupt/foreign record while still allowing true
 * absence (a never-saved session):
 *   'absent'     — no such file (ENOENT/ENOTDIR)
 *   'open'       — durable record, not tombstoned (generation carried)
 *   'closed'     — durable tombstone (generation carried)
 *   'unreadable' — IO error, malformed JSON, an ambiguous record (duplicate
 *                  top-level `id`/lifecycle keys), or an identity that is not
 *                  EXACTLY this session: missing, empty, non-string or
 *                  foreign `id` all fail closed. Only a truly absent file is
 *                  'absent'; a malformed/identity-less legacy record is not.
 */
export function readSessionLifecycleStateFromDisk(id) {
  if (!id) return { state: 'unreadable', generation: 0 };
  let raw;
  try {
    raw = readFileSync(sessionPath(id), 'utf-8');
  } catch (err) {
    const code = err?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent', generation: 0 };
    return { state: 'unreadable', generation: 0 };
  }
  // ONE authority, no fallback: readTopLevelLifecycleRecord already IS the
  // strict parse, so a malformed/ambiguous document ends here. A JSON.parse
  // retry would resolve duplicate keys last-wins and defeat the check —
  // even (especially) when one of the duplicates matches the requested id.
  const onDisk = readTopLevelLifecycleRecord(raw);
  if (isLifecycleUnreadable(onDisk)) return { state: 'unreadable', generation: 0 };
  // Durable identity is MANDATORY: the record is this session's authority
  // only when its top-level `id` is a non-empty string exactly equal to the
  // requested id. Missing / empty / non-string identity is not "probably
  // ours" — it is an unowned or malformed record and fails closed exactly
  // like a foreign one. (A never-written session is reported 'absent'
  // above; that is the only backwards-compatible opening.)
  if (onDisk.id !== id) {
    return { state: 'unreadable', generation: 0 };
  }
  return {
    state: onDisk.closed === true ? 'closed' : 'open',
    generation: typeof onDisk.generation === 'number' ? onDisk.generation : 0,
  };
}
