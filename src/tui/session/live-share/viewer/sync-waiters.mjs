/**
 * live-share/viewer/sync-waiters.mjs - callers waiting for the owner's atomic
 * full frame of one session, plus the throttled desync-recovery request.
 */
import { frameLine } from '../wire.mjs';

// Desync-recovery `sync` requests are throttled so a corrupt stream cannot
// make the owner serialize full transcripts every frame.
const SYNC_REQUEST_MIN_INTERVAL_MS = 500;

export function createSyncWaiters() {
  const waiters = new Set();
  let lastSyncRequestAt = 0;

  /** Resolve every waiter on `id` with `synced`. */
  function settle(id, synced) {
    for (const waiter of waiters) {
      if (waiter.id === id) waiter.finish(synced);
    }
  }

  /** A promise that settles when `id` is fully synced, or false on timeout. */
  function wait(id, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { id, timer: null, finish: null };
      waiter.finish = (synced) => {
        if (!waiters.delete(waiter)) return;
        if (waiter.timer) clearTimeout(waiter.timer);
        resolve(synced === true);
      };
      waiters.add(waiter);
      waiter.timer = setTimeout(() => waiter.finish(false), Math.max(1, Number(timeoutMs) || 750));
      waiter.timer.unref?.();
    });
  }

  function requestSync(socket) {
    const now = Date.now();
    if (now - lastSyncRequestAt < SYNC_REQUEST_MIN_INTERVAL_MS) return;
    lastSyncRequestAt = now;
    try {
      socket.write(frameLine({ t: 'sync' }));
    } catch {
      /* close handles */
    }
  }

  function failAll() {
    for (const waiter of waiters) waiter.finish(false);
  }

  return { settle, wait, requestSync, failAll };
}
