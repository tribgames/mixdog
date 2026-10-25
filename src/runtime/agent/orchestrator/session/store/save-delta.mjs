import { hash } from 'node:crypto';
import { _messagesForDisk, _sessionForDisk } from './serialize.mjs';
import { sensitiveValuesVersion } from '../sensitive-values.mjs';

// ── Delta handoff to the save worker ─────────────────────────────────────────
// Worker.postMessage structured-clones on the CALLER's thread, so a full-
// transcript payload per turn cost O(whole conversation) on the engine thread.
// Turns normally APPEND to the message list (the array is replaced but the
// settled message objects are reused by reference), so the parent tracks the
// exact refs last handed to the worker and, on a pure append, ships only the
// header + projected tail — O(turn). Any prefix change (compaction, clear,
// repair), a broken chain (failure/restart), or the periodic full resync
// falls back to a full snapshot. Lock-free and per-id: sessions stay fully
// parallel and the single worker's per-id FIFO preserves chain order.
//
// Unbounded by count (a count cap pushed every save past N concurrent
// sessions onto the full path): an entry lives until an invalidation, a hard
// delete or the session's runtime teardown (forgetSessionSaveBaseline).
//
// No deep copy of the transcript is kept here: the worker already holds the
// sent messages. Each sent message is identified by its live reference plus a
// fingerprint of the projection that was sent, taken once when it was first
// sent (and again on every periodic resync). Failure evidence is rebuilt from
// the references only while every fingerprint still matches — an in-place
// edit since the send makes the parent's evidence unprovable, and none is
// recorded (the worker's own reply carries the exact attempt when it can).
const _deltaBaseline = new Map(); // id → { refs: message[], prints: (string|null)[] | null, deltasSinceFull }
const DELTA_FULL_RESYNC_EVERY = 25;

export function _invalidateDeltaBaseline(id) {
  _deltaBaseline.delete(id);
}

/** Drop one id's baseline; true when it had one. */
export function _dropDeltaBaseline(id) {
  return _deltaBaseline.delete(id);
}

export function _clearDeltaBaselines() {
  _deltaBaseline.clear();
}

/** Read-only inspector: does the parent still hold a delta baseline for `id`? */
export function _hasSessionSaveBaseline(id) {
  return _deltaBaseline.has(id);
}

export function _cloneOrNull(value) {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

/** Fingerprint of one projected (disk-shape) message, or null when it has none. */
function _messagePrint(message) {
  try {
    return hash('sha1', JSON.stringify(message) ?? 'undefined', 'base64');
  } catch {
    return null;
  }
}

/**
 * Fingerprints for `diskMessages` (the disk projection of `live`). A message
 * whose live reference is unchanged since `prev` keeps the fingerprint taken
 * when it was first sent; only changed/new messages are fingerprinted.
 */
function _printMessages(live, diskMessages, prev) {
  const reuse = new Map();
  if (prev?.prints) {
    for (let index = 0; index < prev.refs.length; index += 1) reuse.set(prev.refs[index], prev.prints[index]);
  }
  return diskMessages.map((message, index) =>
    reuse.has(live[index]) ? reuse.get(live[index]) : _messagePrint(message)
  );
}

/**
 * What one attempt sent, without copying the transcript: a detached copy of
 * the (small) header, the live message references and their fingerprints.
 */
function _attemptRecord(header, refs, prints) {
  if (!prints) return null;
  const detached = _cloneOrNull({ ...header, messages: [] });
  return detached ? { header: detached, refs, prints } : null;
}

/**
 * Failure evidence for one attempt, rebuilt from its references only while
 * every message still projects to exactly what was sent; otherwise none.
 * (_recordSaveFailure detaches whatever it keeps.)
 */
export function _attemptEvidence(attempt) {
  if (!attempt) return null;
  const messages = _messagesForDisk(attempt.refs, attempt.header.id);
  for (let index = 0; index < messages.length; index += 1) {
    const print = attempt.prints[index];
    if (print === null || _messagePrint(messages[index]) !== print) return null;
  }
  return { ...attempt.header, messages };
}

function _isPureAppend(refs, live) {
  if (live.length < refs.length) return false;
  for (let index = 0; index < refs.length; index += 1) {
    if (live[index] !== refs[index]) return false;
  }
  return true;
}

export function _buildWirePayload(id, session, forceFull = false) {
  const live = Array.isArray(session.messages) ? session.messages : [];
  const base = forceFull ? null : _deltaBaseline.get(id);
  // A value marked sensitive since the baseline was sent must leave the
  // messages the worker already holds too: write the whole transcript again.
  const sensitive = sensitiveValuesVersion(id);
  const resyncDue = !base || base.deltasSinceFull >= DELTA_FULL_RESYNC_EVERY || base.sensitive !== sensitive;
  if (!resyncDue && _isPureAppend(base.refs, live)) {
    // Header: full disk projection with an empty message list (strips
    // transient aliases); tail: per-message projection of the appended
    // suffix only. Both use the same idempotent per-message projection
    // as a full send, so worker-side reconstruction is byte-identical.
    const header = _sessionForDisk({ ...session, messages: [] });
    const tailMessages = _messagesForDisk(live.slice(base.refs.length), id);
    // The EXACT payload the worker will reconstruct and write is the sent
    // baseline + this delta. Its evidence is fingerprint-checked against
    // what was sent, never a fresh projection of the mutable live session
    // (an in-place nested edit of an already-sent message is NOT part of a
    // reference-identity delta). Only the tail is fingerprinted.
    const prints = base.prints ? base.prints.concat(tailMessages.map(_messagePrint)) : null;
    const refs = live.slice();
    _deltaBaseline.set(id, { refs, deltasSinceFull: base.deltasSinceFull + 1, prints, sensitive });
    return {
      delta: { baseCount: base.refs.length, header, tailMessages },
      attempt: _attemptRecord(header, refs, prints),
    };
  }
  const full = _sessionForDisk(session);
  const diskMessages = Array.isArray(full.messages) ? full.messages : [];
  // A prefix change (compaction, edit, repair) keeps the fingerprints of
  // every unchanged message. The periodic resync, a forced full retry and a
  // missing baseline re-fingerprint everything, so in-place nested edits of
  // settled messages become provable evidence again at least every
  // DELTA_FULL_RESYNC_EVERY saves.
  const refs = live.slice();
  const prints = _printMessages(live, diskMessages, resyncDue ? null : base);
  _deltaBaseline.set(id, { refs, deltasSinceFull: 0, prints, sensitive });
  // (saveSessionAsync normalizes `messages` to an array before any post.)
  return { session: full, attempt: _attemptRecord(full, refs, prints) };
}
