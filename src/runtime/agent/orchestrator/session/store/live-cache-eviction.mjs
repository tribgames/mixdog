/**
 * Reclamation of the same-process live-snapshot cache. Eviction is only ever
 * allowed against POSITIVE durability evidence (a readable canonical file, no
 * pending write, no dropped/failed save), so this owns the rules that decide
 * when disk may replace a snapshot — nothing about producing one.
 */
import {
  _liveSessions,
  _droppedSaveIds,
  LIVE_MEDIA_RETENTION_MS,
  _messagesCarryLiveMedia,
  hasSessionSaveFailure,
} from './live-state.mjs';
import { _summaryCacheVersions } from './summary-cache.mjs';
import { probePath, PROBE_PRESENT } from './fs-probe.mjs';
import { sessionPath } from './paths-heartbeat.mjs';
import { _hasPendingPersistence } from './pending-saves.mjs';
import { forgetSessionLoadCache } from './load-cache.mjs';

/**
 * Drop one session's same-process snapshot once its state is durable on disk.
 * No-op while any write for the id is still pending/in flight.
 */
export function evictLiveSession(id) {
  if (!id || _hasPendingPersistence(id)) return false;
  // An evicted session's parsed disk document goes with its snapshot.
  forgetSessionLoadCache(id);
  return _liveSessions.delete(id);
}

/**
 * Idle sweep for the same-process snapshot cache. _liveSessions previously
 * grew without bound — every clear-fork and every touched user session pinned
 * its FULL message array (image bytes included) for process lifetime, the
 * observed multi-GB RSS leak. Disk is the source of truth for anything not
 * actively owned by this process, so an entry is dropped when it (a) has no
 * live runtime owner, (b) has no pending persistence, and (c) already exists
 * on disk — loadSession then falls back to the session file. Media-carrying
 * snapshots get a grace TTL (see LIVE_MEDIA_RETENTION_MS) because eviction is
 * lossy for them; text-only snapshots evict losslessly right away.
 */
export function evictIdleLiveSessions(options = {}) {
  const isSessionLive = typeof options.isSessionLive === 'function' ? options.isSessionLive : null;
  const now = Date.now();
  let evicted = 0;
  for (const [id, session] of [..._liveSessions.entries()]) {
    if (isSessionLive?.(id)) continue;
    if (_hasPendingPersistence(id)) continue;
    // Durability proof for the eviction: only a POSITIVELY observed file
    // may replace the snapshot. An unreadable probe is not a durable copy.
    if (probePath(sessionPath(id)).state !== PROBE_PRESENT) continue;
    // A dropped last save means the disk copy is BEHIND this snapshot
    // (ownership split-brain). Evicting would lose the only complete
    // transcript; keep it until a save lands again (re-adoption).
    if (_droppedSaveIds.has(id)) continue;
    // Same reasoning for a save that FAILED at the commit edge (rename/IO
    // fault): the file on disk is the last-good copy from BEFORE the
    // failed write, so this snapshot is the only good state for the newest
    // turn. The presence probe above is satisfied by exactly that stale file, so
    // without this guard the idle sweep silently discards the newer
    // transcript. Pinned only until a save lands (clearSessionSaveError).
    if (hasSessionSaveFailure(id)) continue;
    if (_messagesCarryLiveMedia(session?.messages)) {
      const lastActive = Math.max(session?.updatedAt || 0, session?.lastUsedAt || 0);
      if (lastActive > 0 && now - lastActive <= LIVE_MEDIA_RETENTION_MS) continue;
    }
    _liveSessions.delete(id);
    forgetSessionLoadCache(id);
    // With no pending persistence the rollback-race version counter for
    // this id is dead weight — reclaim it too (it regrows from 1 on the
    // next save, which is safe precisely because nothing is in flight).
    _summaryCacheVersions.delete(id);
    evicted++;
  }
  return evicted;
}
