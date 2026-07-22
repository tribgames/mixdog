import { sanitizeContentForStoredHistory } from '../../providers/media-normalization.mjs';

export const _lastSaveError = new Map(); // id -> { message, at }

/** Same-process authoritative session snapshots (createSession → loadSession / askSession). */
export const _liveSessions = new Map();

// Session ids whose most recent save attempt was DROPPED by the ownership
// guard (_shouldDrop: disk generation moved past the caller's expected
// generation) or failed outright. For these ids the local live snapshot is
// AHEAD of disk — the on-disk transcript froze at the last landed save — so
// it must not be evicted (data loss) nor shadowed by the stale disk copy.
export const _droppedSaveIds = new Set();

export function setLiveSession(session) {
    if (!session?.id) return;
    _liveSessions.set(session.id, session);
}

export function _clearLiveSession(id) {
    if (id) _liveSessions.delete(id);
}

// Live snapshots that still carry raw media bytes (images are placeholder'd
// in the persisted JSON) stay resident for this long after their last use so
// multi-turn image recognition keeps working across an idle gap. Beyond the
// TTL the memory cost wins and the snapshot is reclaimed like any other.
export const LIVE_MEDIA_RETENTION_MS = 60 * 60 * 1000; // 1h

export function _messagesCarryLiveMedia(messages) {
    if (!Array.isArray(messages)) return false;
    for (const m of messages) {
        if (!m || typeof m !== 'object') continue;
        if (sanitizeContentForStoredHistory(m.content) !== m.content) return true;
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
