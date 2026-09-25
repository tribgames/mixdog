/**
 * retention.mjs — when a daemon-owned session runtime may be reclaimed.
 *
 * A turn belongs to the DAEMON, not to whoever is watching it: closing the
 * desktop window or restarting the TUI must never interrupt work. A runtime
 * whose last view left is RETAINED while it is busy and evicted only after it
 * has been idle and unwatched for idleEvictMs. With a view release no longer
 * destroying anything, the sweep here is the ONLY reclaim path besides
 * shutdown. A watched-but-idle session keeps its runtime and drops only the
 * wire projection (snapshotCache / itemCache / fieldCache / publishedSnapshot
 * — a SECOND full copy of the transcript that used to be pinned for the
 * daemon's lifetime by merely leaving a tab open); the next change rebuilds
 * it as one full frame.
 */
import { createBusyTracker } from './retention/busy.mjs';

/**
 * @param {object} deps
 * @param {Set<object>} deps.sessions
 * @param {() => boolean} deps.isClosed
 * @param {(entry: object) => string} deps.currentSessionId  late-bound (projection)
 * @param {(entry: object, reason: string, options?: object) => Promise<object>} deps.destroy  late-bound (entries)
 */
export function createSessionRetention({
  sessions,
  isClosed,
  idleEvictMs,
  evictSweepMs,
  projectionIdleMs,
  currentSessionId,
  destroy,
}) {
  let evictTimer = null;
  const busy = createBusyTracker({ sessions, currentSessionId });
  const { sessionBusy } = busy;

  function releaseProjection(entry) {
    if (!entry) return;
    entry.snapshotSource = null;
    entry.snapshotCache = null;
    entry.fieldCache?.clear?.();
    entry.itemCache?.clear?.();
    entry.fieldCache = null;
    entry.itemCache = null;
    entry.publishedSnapshot = null;
    entry.publishedSessionId = '';
    // The window survives (its views are still attached); its cached windowed
    // snapshot is one more copy of the released projection.
    if (entry.transcriptView) entry.transcriptView.cache = null;
  }

  function startEvictionSweep() {
    if (evictTimer || isClosed()) return;
    evictTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of [...sessions]) {
        // A client came back to it: watched session RUNTIMES are never
        // reclaimed. Their projection still is — an idle watched session keeps
        // the runtime and drops only the wire clone of its transcript, which
        // the next publish rebuilds as a full frame.
        if (entry.subscribers?.size > 0) {
          entry.retainedAt = null;
          if (!sessionBusy(entry) && now - (entry.lastPublishedAt || 0) >= projectionIdleMs) {
            releaseProjection(entry);
          }
          continue;
        }
        if (!entry.retainedAt) continue;
        if (sessionBusy(entry)) {
          entry.retainedAt = now;
          continue;
        }
        if (now - entry.retainedAt < idleEvictMs) continue;
        // Eviction is a MEMORY reclaim, never a user teardown: the runtime's
        // agent workers and background jobs are daemon-owned work that must
        // survive the owner's idle eviction (observed: switching desktop tabs
        // evicted the Lead after 2 minutes and its teardown closed every idle
        // worker with reap time left — and cancelled running ones).
        void destroy(entry, 'idle and unwatched', { keepBackgroundWork: true });
      }
      stopEvictionSweepIfIdle();
    }, evictSweepMs);
    evictTimer.unref?.();
  }

  function stopEvictionSweepIfIdle() {
    if (!evictTimer) return;
    for (const entry of sessions) {
      if (entry.disposed) continue;
      const watchers = entry.subscribers?.size || 0;
      if (entry.retainedAt && watchers === 0) return;
      // A watched session holding a projection still has memory to reclaim.
      if (watchers > 0 && (entry.snapshotCache || entry.publishedSnapshot)) return;
    }
    stopSweep();
  }

  function stopSweep() {
    if (!evictTimer) return;
    clearInterval(evictTimer);
    evictTimer = null;
  }

  /** Put an unwatched entry on the idle clock (callers name the budget). */
  function retainUnwatched(entry, _reason = 'headless session budget') {
    if (!entry || entry.disposed || (entry.subscribers?.size || 0) > 0) return;
    entry.headless = true;
    entry.retainedAt = Date.now();
    // No view remains to hold a window; the next one starts from the tail.
    entry.transcriptView = null;
    releaseProjection(entry);
    startEvictionSweep();
  }

  return {
    ...busy,
    releaseProjection,
    startEvictionSweep,
    stopEvictionSweepIfIdle,
    stopSweep,
    sweepActive: () => evictTimer !== null,
    retainUnwatched,
  };
}
