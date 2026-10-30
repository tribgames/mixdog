// store/transcript-durability.mjs
// What a session's canonical record durably holds, as evidence for the turn
// checkpoints (manager/turn-checkpoint.mjs) — never inferred from in-memory
// freshness.
//
//   transcriptEpoch  persisted. Names one append-only lineage of the
//                    transcript: a record of epoch E with `length` messages
//                    agrees with every other record of E on their common
//                    prefix. A history rewrite (compaction, a prefix edit,
//                    a recovery splice) mints a new epoch.
//   turnCoverage     persisted. The token of the last turn whose finalized
//                    transcript this record carries, so a checkpoint the
//                    record already covers is deleted, never replayed.
//
// A landed save records, per session object, the exact epoch, coverage and
// message references it serialized (captured when the bytes were built, so a
// coalesced or later-built write reports what it actually wrote). Only that
// record proves what is on disk; a settled promise or an idle queue does not.
import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { sessionPath } from './session-paths.mjs';
import { _storedSessionFromFile, STORED_SESSION_UNREADABLE } from './serialize.mjs';

const _landed = new WeakMap(); // session → { epoch, coverage, refs, saveEpoch }
const _snapshotHooks = new WeakMap(); // session → () => void

export function mintTranscriptEpoch() {
  return randomUUID();
}

/** Run `hook` before every serialization of `session` (the turn checkpoint
 *  journals a history rewrite, under a new epoch, before any record carries
 *  it). Returns the unregister function. */
export function setTranscriptSnapshotHook(session, hook) {
  _snapshotHooks.set(session, hook);
  return () => {
    if (_snapshotHooks.get(session) === hook) _snapshotHooks.delete(session);
  };
}

/** The transcript identity a save of `session` is about to serialize. */
export function captureTranscriptSnapshot(session) {
  _snapshotHooks.get(session)?.();
  return {
    epoch: typeof session.transcriptEpoch === 'string' ? session.transcriptEpoch : null,
    coverage: typeof session.turnCoverage === 'string' ? session.turnCoverage : null,
    refs: Array.isArray(session.messages) ? session.messages.slice() : [],
  };
}

/** A save of `snapshot` (issued under `saveEpoch`) landed on disk. */
export function recordLandedTranscript(session, snapshot, saveEpoch) {
  if (!session || !snapshot) return;
  const current = _landed.get(session);
  const issued = Number.isFinite(saveEpoch) ? saveEpoch : 0;
  if (current && current.saveEpoch > issued) return;
  _landed.set(session, { ...snapshot, saveEpoch: issued });
}

export function landedTranscript(session) {
  return (session && _landed.get(session)) || null;
}

/** Whether the last landed save of `session` holds exactly its transcript. */
export function landedTranscriptMatches(session) {
  const landed = landedTranscript(session);
  const messages = Array.isArray(session?.messages) ? session.messages : null;
  if (!landed || !messages || landed.epoch !== session.transcriptEpoch) return false;
  if (landed.refs.length !== messages.length) return false;
  return landed.refs.every((message, index) => message === messages[index]);
}

/** The durable transcript a turn opening now would be taken against
 *  (`{ epoch, refs }`), or null when no landed save holds `session`'s
 *  current transcript exactly. */
export function durableTranscriptBase(session) {
  if (!landedTranscriptMatches(session)) return null;
  const landed = landedTranscript(session);
  return { epoch: landed.epoch, refs: landed.refs };
}

/** The canonical record of `id` as it is on disk (never a cached or live
 *  copy), or null when it is absent, unreadable or not this session's. */
export function readDurableSessionRecord(id) {
  const path = sessionPath(id);
  const record = _storedSessionFromFile(dirname(path), basename(path));
  return record && record !== STORED_SESSION_UNREADABLE ? record : null;
}
