import { contentCarriesLiveMedia } from '../../providers/media-normalization.mjs';
import { publishSessionPersistence } from './session-persistence-events.mjs';
import { raiseDesktopNotice } from '../../../../shared/desktop-notice-host.mjs';

const _lastSaveError = new Map(); // id -> { message, at }

/** Same-process authoritative session snapshots (createSession → loadSession / askSession). */
export const _liveSessions = new Map();

// Session ids whose most recent save was DROPPED (the record's generation
// moved past the caller's expected one) or failed. For these ids the live
// snapshot is AHEAD of the record, so it must not be evicted (data loss) nor
// shadowed by the record.
export const _droppedSaveIds = new Set();

// ── Save outcomes ───────────────────────────────────────────────────────────
// SAVED: the records are fsynced in the log. DROPPED: the record's ownership
// moved past this copy (pinned, split-brain flagged).
export const SAVE_OUTCOME_SAVED = 'saved';
export const SAVE_OUTCOME_DROPPED = 'dropped';

// ── Delete fence ────────────────────────────────────────────────────────────
// An explicitly deleted session may still own a running turn whose later
// saves would otherwise create the record again. The fence is the id-level
// refusal every save consults. Only explicit user deletes fence (ids are
// never reused); the cap only ever forgets the oldest, long-settled entries.
const SESSION_DELETE_FENCE_MAX = 4096;
const _deleteFence = new Set();

export function fenceSessionWrites(id) {
  if (!id) return;
  _deleteFence.delete(id);
  _deleteFence.add(id);
  if (_deleteFence.size > SESSION_DELETE_FENCE_MAX) {
    _deleteFence.delete(_deleteFence.values().next().value);
  }
}

export function isSessionWriteFenced(id) {
  return _deleteFence.has(id);
}

/** Clear every save marker for an id (a landed save, a barrier, a delete). */
export function _clearSessionSaveState(id) {
  if (!id) return;
  _lastSaveError.delete(id);
  _droppedSaveIds.delete(id);
}

export function setLiveSession(session) {
  if (!session?.id) return;
  _liveSessions.set(session.id, session);
}

export function _clearLiveSession(id) {
  if (id) _liveSessions.delete(id);
}

// Live snapshots that still carry inline media bytes (the stored record holds
// content-addressed refs, or a placeholder for media the store refused) stay
// resident for this long after their last use so multi-turn image recognition
// keeps working across an idle gap. Beyond the TTL the memory cost wins and the
// snapshot is reclaimed like any other.
export const LIVE_MEDIA_RETENTION_MS = Math.max(
  60_000,
  Number(process.env.MIXDOG_LIVE_MEDIA_RETENTION_MS) || 10 * 60 * 1000
); // 10m default — raw image bytes are the most expensive thing we retain

export function _messagesCarryLiveMedia(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (contentCarriesLiveMedia(m.content)) return true;
  }
  return false;
}

/**
 * Returns the last save error for a session id, or null if no error has occurred.
 * Shape: { message: string, at: number } | null
 */
export function getSessionSaveError(id) {
  return _lastSaveError.get(id) ?? null;
}

export function clearSessionSaveError(id) {
  _lastSaveError.delete(id);
}

/**
 * Record a failed save. The record is now BEHIND this process's live
 * snapshot (its records stay queued and land with the next write), so the id
 * is flagged on both channels: _lastSaveError (getSessionSaveError, the
 * desktop notice) and _droppedSaveIds (no eviction, no shadowing). The next
 * landed save clears both.
 */
export function _recordSaveFailure(id, err) {
  if (!id) return;
  // The only notice of a transcript the disk no longer keeps up with; told
  // once per run, whichever session it was.
  raiseDesktopNotice('conversation-save', 'conversation-save-failed');
  _lastSaveError.set(id, { message: err?.message ?? String(err), at: Date.now() });
  _droppedSaveIds.add(id);
}

/** Record an ownership-DROPPED save (nothing was written). */
export function _recordSaveDrop(id) {
  if (id) _droppedSaveIds.add(id);
}

/** A save landed: every earlier record of the id landed with it (the log
 *  acknowledges in order), so the markers go. */
export function _recordSaveLanded(id) {
  if (!id) return;
  _clearSessionSaveState(id);
  publishSessionPersistence(id, 'landed');
}

/** True while this process's last save attempt for `id` failed. */
export function hasSessionSaveFailure(id) {
  return !!id && _lastSaveError.has(id);
}

// ── Lifecycle (tombstone/detach) commit failures ────────────────────────────
// markSessionClosed/bumpSessionGeneration return null for BOTH a legitimate
// veto and a genuine durable-write failure. closeSession must react very
// differently to the two: a failed lifecycle barrier means NOTHING was fenced
// in the record. This map is the disambiguator — set only on a real failure,
// cleared when the barrier lands.
const _lifecycleCommitErrors = new Map(); // id -> { message, at, code, reason }

export function _recordLifecycleCommitFailure(id, err, reason = null) {
  if (!id) return;
  _lifecycleCommitErrors.set(id, {
    message: err?.message ?? String(err),
    code: err?.code ?? null,
    reason,
    at: Date.now(),
  });
}

export function getSessionLifecycleCommitError(id) {
  return _lifecycleCommitErrors.get(id) ?? null;
}

export function clearSessionLifecycleCommitError(id) {
  _lifecycleCommitErrors.delete(id);
}
