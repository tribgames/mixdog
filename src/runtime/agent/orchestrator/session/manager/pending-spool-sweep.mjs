// Spool hygiene: eviction of stale/orphaned session queues from the shared
// pending-message file, plus the boot-time sweep the lead process schedules.
// Retention policy only — it never delivers, claims or acknowledges anything.
import { loadSession } from '../store.mjs';
import {
  isTuiSteeringPendingKey,
  normalizePendingStore,
  pendingWarn,
  setSpoolQueue,
  updateSpool,
} from './pending-spool-file.mjs';

const PENDING_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_ORPHAN_GRACE_MS = 60 * 60 * 1000;

function shouldEvictPendingSession(sessionId, ttlMs, entryTouchedAt, now = Date.now()) {
  if (isTuiSteeringPendingKey(sessionId)) {
    const entryTouch = Number(entryTouchedAt) || 0;
    if (entryTouch <= 0) return false;
    return now - entryTouch > ttlMs;
  }
  const session = loadSession(sessionId);
  if (session) {
    const touched = Math.max(
      Number(session.updatedAt) || 0,
      Number(session.lastHeartbeatAt) || 0,
      Number(session.createdAt) || 0
    );
    return touched > 0 && now - touched > ttlMs;
  }
  const entryTouch = Number(entryTouchedAt) || 0;
  return entryTouch > 0 && now - entryTouch > PENDING_ORPHAN_GRACE_MS;
}

export async function sweepOrphanedPendingMessages({ ttlMs = PENDING_ORPHAN_TTL_MS } = {}) {
  const now = Date.now();
  const removed = [];
  try {
    await updateSpool((raw) => {
      const next = normalizePendingStore(raw);
      const ids = Object.keys(next.sessions);
      if (ids.length === 0) return undefined;
      for (const sid of ids) {
        const entryTouchedAt = next.sessionTouchedAt?.[sid];
        if (shouldEvictPendingSession(sid, ttlMs, entryTouchedAt, now)) {
          setSpoolQueue(next, sid, []);
          removed.push(sid);
        }
      }
      if (removed.length === 0) return undefined;
      next.updatedAt = now;
      return next;
    });
  } catch (err) {
    pendingWarn(`[session] pending-message sweep failed: ${err?.message || err}\n`);
    return 0;
  }
  if (removed.length > 0) {
    pendingWarn(
      `[session] pending-message sweep: removed ${removed.length} stale/orphan queue(s) (ttl=${Math.round(ttlMs / 86400000)}d) (${removed.slice(0, 5).join(', ')}${removed.length > 5 ? `, +${removed.length - 5} more` : ''})\n`
    );
  }
  return removed.length;
}

setImmediate(() => {
  // Spool hygiene belongs to the lead/daemon process. Channel workers share
  // the same spool file; a boot-time SYNC sweep in every child contends on
  // the cross-process lock against the lead's writes for zero
  // benefit — the lead already sweeps.
  if (process.env.MIXDOG_WORKER_MODE === '1') return;
  void sweepOrphanedPendingMessages().catch(() => {});
});
