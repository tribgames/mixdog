/**
 * src/tui/session/live-share/retry.mjs - bounded exponential retry timer for
 * pipe opens, keyed by the session id the pending retry belongs to.
 */
export function createRetryTimer({ minMs, maxMs, shouldStart, start }) {
  let timer = null;
  let id = '';
  let delayMs = minMs;

  function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
    id = '';
  }

  function schedule(target) {
    const next = String(target || '');
    if (!next || timer || !shouldStart(next)) return;
    const delay = delayMs;
    delayMs = Math.min(maxMs, Math.max(minMs, delayMs * 2));
    id = next;
    timer = setTimeout(() => {
      timer = null;
      id = '';
      if (shouldStart(next)) start(next);
    }, delay);
    timer.unref?.();
  }

  return {
    id: () => id,
    pending: () => Boolean(timer),
    clear,
    reset: () => {
      delayMs = minMs;
    },
    schedule,
  };
}

/**
 * Reconcile one live-share leg (the owner's pipe server, the viewer's client)
 * against the session it should serve/follow — '' = none. A retry aimed at
 * another session is dropped, a leg bound to another session is stopped, and a
 * leg is (re)started only when nothing is up and no retry is already pending.
 * `legId`/`legUp` are read lazily because both callers keep them in mutable
 * closure state.
 */
export function reconcileLeg(targetId, { retry, legId, legUp, stop, start }) {
  if (retry.id() && retry.id() !== targetId) retry.clear();
  if (!targetId && retry.pending()) retry.clear();
  if (legId() && legId() !== targetId) stop();
  if (targetId && !legUp() && !retry.pending()) start(targetId);
}
