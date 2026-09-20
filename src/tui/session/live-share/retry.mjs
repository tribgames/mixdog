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
