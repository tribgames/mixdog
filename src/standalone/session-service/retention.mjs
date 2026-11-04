/**
 * retention.mjs — when a daemon-owned session runtime may be reclaimed.
 *
 * A turn belongs to the DAEMON, not to whoever is watching it: closing the
 * desktop window or restarting the TUI must never interrupt work. A runtime
 * whose last view left is RETAINED while it is busy and evicted only after it
 * has been idle and unwatched for idleEvictMs: a deadline on the session idle
 * clock (./idle-clock.mjs), one exact timer per session, no sweep. With a view
 * release no longer destroying anything, that deadline is the ONLY reclaim
 * path besides shutdown. A watched-but-idle session keeps its runtime and
 * drops only the wire projection (snapshotCache / itemCache / fieldCache /
 * publishedSnapshot — a SECOND full copy of the transcript that used to be
 * pinned for the daemon's lifetime by merely leaving a tab open) once nothing
 * was published for projectionIdleMs (one timer per watched entry, restarted
 * by a view or a publish); the next change rebuilds it as one full frame.
 */
import { createBusyTracker } from './retention/busy.mjs';

/**
 * @param {object} deps
 * @param {Set<object>} deps.sessions
 * @param {() => boolean} deps.isClosed
 * @param {ReturnType<import('./idle-clock.mjs').createSessionIdleClock>} deps.idleClock
 * @param {(sessionId: string) => object|null} deps.sessionOwner  late-bound (projection)
 * @param {(entry: object) => string} deps.currentSessionId  late-bound (projection)
 * @param {(entry: object, reason: string, options?: object) => Promise<object>} deps.destroy  late-bound (entries)
 */
export function createSessionRetention({
  sessions,
  isClosed,
  idleClock,
  idleEvictMs,
  projectionIdleMs,
  sessionOwner,
  currentSessionId,
  destroy,
}) {
  // Session id -> the entry whose idle deadline came, disposed one per
  // event-loop turn; a restart of that session's clock takes it back out.
  const evictQueue = new Map();
  let evictDrain = null;
  const busy = createBusyTracker({
    sessions,
    currentSessionId,
    onBusyChange: (entry) => {
      idleStateChanged(entry);
      armProjectionRelease(entry);
    },
  });
  const { sessionBusy } = busy;

  /** Off the clock until a view leaves: watched, or never put on it. */
  function unwatchedRetained(entry) {
    return Boolean(
      entry && !entry.disposed && sessions.has(entry) && !(entry.subscribers?.size > 0) && entry.retainedAt
    );
  }

  // Re-evaluated when the entry's turn comes: a client may have come back, or
  // work may have started, since its deadline queued it (its busy change
  // starts the clock again).
  function evictable(entry) {
    return Boolean(entry) && unwatchedRetained(entry) && !sessionBusy(entry);
  }

  /** The entry on `id`'s clock: its owner, or a runtime that stopped reporting
   *  an address since it published `id` (it is no longer indexed, and nothing
   *  else would ever reclaim it). */
  function entryFor(id) {
    const owner = sessionOwner(id);
    if (owner) return owner;
    for (const entry of sessions) {
      if (!entry.disposed && !entry.indexedSessionId && entry.addressedSessionId === id) return entry;
    }
    return null;
  }

  idleClock.addDeadline({
    delayMs: idleEvictMs,
    tracks: (id) => unwatchedRetained(entryFor(id)),
    due: (id) => {
      if (isClosed()) return;
      evictQueue.set(id, entryFor(id));
      evictDrain ??= setImmediate(drainEvictions);
    },
    restarted: (id) => {
      evictQueue.delete(id);
      // The end of any work (a turn, a background task) restarts the clock:
      // a watched projection held back by that work goes on its own clock too.
      const entry = entryFor(id);
      if (entry) armProjectionRelease(entry);
    },
  });

  // One disposal per macrotask: a batch of idle sessions must never block the
  // loop for more than one session's synchronous teardown. Each next step is
  // a setImmediate queued from the previous one, i.e. the next loop iteration.
  function drainEvictions() {
    evictDrain = null;
    const [next] = evictQueue;
    if (!next) return;
    const [id, entry] = next;
    evictQueue.delete(id);
    if (!isClosed() && evictable(entry)) {
      // Eviction is a MEMORY reclaim, never a user teardown: the runtime's
      // agent workers and background jobs are daemon-owned work that must
      // survive the owner's idle eviction (observed: switching desktop tabs
      // evicted the Lead after 2 minutes and its teardown closed every idle
      // worker with reap time left — and cancelled running ones).
      void destroy(entry, 'idle and unwatched', { keepBackgroundWork: true });
    }
    if (evictQueue.size > 0 && !isClosed()) evictDrain = setImmediate(drainEvictions);
    else evictQueue.clear();
  }

  function clearProjectionRelease(entry) {
    if (!entry?.projectionTimer) return;
    clearTimeout(entry.projectionTimer);
    entry.projectionTimer = null;
  }

  /** A watched idle entry drops its projection once nothing was published for
   *  projectionIdleMs: armed by a view attaching, a publish and the end of
   *  work; work clears it. Due while a background task still runs, it waits
   *  the whole delay again. */
  function armProjectionRelease(entry, evenIfBusy = false) {
    clearProjectionRelease(entry);
    // Daemon-owned runtimes only: an agent-view projection is not reclaimed here.
    if (isClosed() || entry.disposed || !sessions.has(entry) || !(entry.subscribers?.size > 0)) return;
    // A streaming turn publishes per frame: its cached busy flag answers first.
    if (!evenIfBusy && (entry.busy === true || sessionBusy(entry))) return;
    entry.projectionTimer = setTimeout(() => {
      entry.projectionTimer = null;
      if (isClosed() || entry.disposed || !(entry.subscribers?.size > 0)) return;
      if (sessionBusy(entry)) armProjectionRelease(entry, true);
      else releaseProjection(entry);
    }, projectionIdleMs);
    entry.projectionTimer.unref?.();
  }

  function releaseProjection(entry) {
    if (!entry) return;
    clearProjectionRelease(entry);
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

  /** The entry's views or its place on the idle clock changed (a view came
   *  or went, it was retained or retired): its idle clock starts over. */
  function idleStateChanged(entry) {
    // The address the entry already owns; a retired runtime is not asked again.
    let id = entry?.indexedSessionId || entry?.addressedSessionId || '';
    if (!id && entry && !entry.disposed) {
      try {
        id = currentSessionId(entry);
      } catch {}
    }
    idleClock.refresh(id);
  }

  function stop() {
    if (evictDrain) clearImmediate(evictDrain);
    evictDrain = null;
    evictQueue.clear();
    for (const entry of sessions) clearProjectionRelease(entry);
  }

  /** Put an unwatched entry on the idle clock (callers name the budget). */
  function retainUnwatched(entry, _reason = 'headless session budget') {
    if (!entry || entry.disposed || (entry.subscribers?.size || 0) > 0) return;
    entry.headless = true;
    entry.retainedAt = Date.now();
    // No view remains to hold a window; the next one starts from the tail.
    entry.transcriptView = null;
    releaseProjection(entry);
    idleStateChanged(entry);
  }

  return {
    ...busy,
    entryFor,
    releaseProjection,
    armProjectionRelease,
    idleStateChanged,
    stop,
    retainUnwatched,
  };
}
