// Coalesce pending values, serialize writes, and retain failed work until the
// next explicit flush or scheduled change. There is no automatic retry loop.
export function createDebouncedWriter({ write, onError, delayMs }) {
  let pending = null;
  let timer = null;
  let inFlight = null;
  let accepted = 0; // one per scheduled value, in schedule order
  let written = 0; // every value up to this one is written
  const reachWaiters = new Set();

  function markWritten(snapshot) {
    if (snapshot.seq <= written) return;
    written = snapshot.seq;
    for (const waiter of reachWaiters) if (written >= waiter.target) waiter.resolve(true);
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(value, flushPending = flush) {
    accepted += 1;
    pending = { value, seq: accepted };
    clearTimer();
    timer = setTimeout(() => {
      void flushPending();
    }, delayMs);
    timer.unref?.();
  }

  async function drain() {
    try {
      while (pending) {
        const snapshot = pending;
        try {
          await write(snapshot.value);
        } catch (error) {
          onError(error, false);
          return false;
        }
        markWritten(snapshot);
        if (pending === snapshot) pending = null;
      }
      return true;
    } finally {
      // Release ownership in the drain's last synchronous step. A separate
      // promise-finally leaves a gap where a completed write's observer can
      // join an already-finished drain and lose its newly scheduled timer.
      inFlight = null;
    }
  }

  function flush() {
    clearTimer();
    if (inFlight) return inFlight;
    const promise = Promise.resolve().then(drain);
    inFlight = promise;
    return promise;
  }

  function flushSyncIfIdle(writeSync) {
    clearTimer();
    // A synchronous writer cannot wait for the event loop's asynchronous
    // owner, nor overtake an older write that has not acquired its lock yet.
    if (inFlight) return false;
    if (!pending) return true;
    const snapshot = pending;
    try {
      writeSync(snapshot.value);
    } catch (error) {
      onError(error, true);
      return false;
    }
    markWritten(snapshot);
    if (pending === snapshot) pending = null;
    return pending === null;
  }

  /** Resolves true once every value scheduled before this call is written,
   *  without waiting on values scheduled later; false when the flush `start`
   *  begins (default: this writer's own) ended first without writing them. */
  function flushAccepted(start = flush) {
    return flushTo(accepted, start);
  }

  /** flushAccepted for a mark taken earlier with acceptedMark(). */
  function flushTo(target, start = flush) {
    if (written >= target) return Promise.resolve(true);
    let waiter;
    const reached = new Promise((resolve) => {
      waiter = { target, resolve };
      reachWaiters.add(waiter);
    });
    const ended = Promise.resolve()
      .then(start)
      .then(
        () => written >= target,
        () => written >= target
      );
    return Promise.race([reached, ended]).finally(() => reachWaiters.delete(waiter));
  }

  return {
    schedule,
    flush,
    flushAccepted,
    flushTo,
    acceptedMark: () => accepted,
    flushSyncIfIdle,
    hasPending: () => pending !== null,
    getPending: () => pending?.value ?? null,
  };
}
