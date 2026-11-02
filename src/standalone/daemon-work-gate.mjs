/**
 * daemon-work-gate.mjs — the one admission gate for everything that starts work
 * in this daemon. An update install closes it (hold) after reading the running
 * count in the same step. While it is closed, HTTP session calls that start or
 * change work are refused, and in-daemon starts wrapped by `deferring` (turn
 * starts of scheduled, routine and channel work, memory agent dispatch) wait
 * for it to reopen instead of being dropped; a waiter whose caller cancels, or
 * the daemon's shutdown, rejects it. Work counts as running from the moment
 * `deferring` admits it, so a hold can never slip in while a start is still
 * preparing. A hold lapses by itself so an installer that died or gave up can
 * never leave the daemon refusing work.
 */
const HOLD_REFUSAL = 'daemon is holding new work for an update install';
const HOLD_DEFAULT_MS = 120_000;
const HOLD_MAX_MS = 5 * 60_000;

// Reads and the calls that let the user stop or answer work already running.
export const HOLD_ALLOWED_CALLS = new Set([
  'session.list',
  'session.read',
  'session.subscribe',
  'session.unsubscribe',
  'session.abort',
  'session.approve',
  'project.list',
  'project.inspect',
  'desktop.control',
  'desktop.ready',
  'desktop.init',
  'desktop.unsubscribe',
]);

export function createWorkGate({ busy = () => 0 } = {}) {
  let busySource = busy;
  let held = false;
  let closed = null;
  let timer = null;
  let starting = 0;
  let waiters = new Set();
  const busyNow = () => Math.max(0, Number(busySource()) || 0) + starting;

  const open = () => {
    held = false;
    clearTimeout(timer);
    timer = null;
    const woken = waiters;
    waiters = new Set();
    for (const waiter of woken) waiter.resolve();
  };

  /** Resolves when the hold ends; rejects when `signal` aborts or the gate is shut down. */
  const waitForOpen = (signal) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(closed);
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (reason) => {
          signal?.removeEventListener('abort', onAbort);
          reject(reason);
        },
      };
      const onAbort = () => {
        waiters.delete(waiter);
        waiter.reject(signal.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.add(waiter);
    });

  return {
    get held() {
      return held;
    },
    setBusySource(source) {
      busySource = source;
    },
    /** Why a session call may not run now, or null. */
    callRefusal(name) {
      return held && !HOLD_ALLOWED_CALLS.has(String(name || '')) ? HOLD_REFUSAL : null;
    },
    /** Running work: the embedder's count plus starts admitted and still preparing. */
    busy: busyNow,
    /** `start` wrapped as an admitted work start: it waits out a hold (and
     *  never runs if `signalOf(...args)` aborts meanwhile), then counts as
     *  running until it settles — which covers its preparation up to the point
     *  the work is registered by the embedder's own count. */
    deferring:
      (start, signalOf = () => undefined) =>
      async (...args) => {
        const signal = signalOf(...args);
        // Shutdown and cancellation are judged on every pass, right before the
        // count and the start with no await between: a wake-up that raced a
        // shutdown or an abort must not start the work.
        for (;;) {
          if (closed) throw closed;
          if (signal?.aborted) throw signal.reason ?? new Error('aborted');
          if (!held) break;
          await waitForOpen(signal);
        }
        starting += 1;
        try {
          return await start(...args);
        } finally {
          starting -= 1;
        }
      },
    /** Reads the running count and closes admission with no gap between: busy
     *  leaves (or puts) it open, idle keeps it closed until release or lapse. */
    hold(ttlMs) {
      const running = busyNow();
      if (running > 0) {
        open();
        return { held: false, busy: running };
      }
      clearTimeout(timer);
      held = true;
      timer = setTimeout(open, Math.min(HOLD_MAX_MS, Math.max(1_000, Number(ttlMs) || HOLD_DEFAULT_MS)));
      timer.unref?.();
      return { held: true, busy: 0 };
    },
    release: open,
    /** The daemon is stopping: every waiter rejects and admission stays as it is. */
    shutdown(reason = 'daemon is shutting down') {
      closed = reason instanceof Error ? reason : new Error(String(reason));
      clearTimeout(timer);
      timer = null;
      const woken = waiters;
      waiters = new Set();
      for (const waiter of woken) waiter.reject(closed);
    },
  };
}

/** This process's gate: the daemon wires its busy count and both front doors. */
export const daemonWorkGate = createWorkGate();
