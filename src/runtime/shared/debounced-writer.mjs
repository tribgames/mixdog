// Coalesce pending values, serialize writes, and retain failed work until the
// next explicit flush or scheduled change. There is no automatic retry loop.
export function createDebouncedWriter({ write, onError, delayMs }) {
  let pending = null
  let timer = null
  let inFlight = null

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function schedule(value, flushPending = flush) {
    pending = { value }
    clearTimer()
    timer = setTimeout(() => { void flushPending() }, delayMs)
    timer.unref?.()
  }

  async function drain() {
    try {
      while (pending) {
        const snapshot = pending
        try {
          await write(snapshot.value)
        } catch (error) {
          onError(error, false)
          return false
        }
        if (pending === snapshot) pending = null
      }
      return true
    } finally {
      // Release ownership in the drain's last synchronous step. A separate
      // promise-finally leaves a gap where a completed write's observer can
      // join an already-finished drain and lose its newly scheduled timer.
      inFlight = null
    }
  }

  function flush() {
    clearTimer()
    if (inFlight) return inFlight
    const promise = Promise.resolve().then(drain)
    inFlight = promise
    return promise
  }

  function flushSyncIfIdle(writeSync) {
    clearTimer()
    // A synchronous writer cannot wait for the event loop's asynchronous
    // owner, nor overtake an older write that has not acquired its lock yet.
    if (inFlight) return false
    if (!pending) return true
    const snapshot = pending
    try {
      writeSync(snapshot.value)
    } catch (error) {
      onError(error, true)
      return false
    }
    if (pending === snapshot) pending = null
    return pending === null
  }

  return {
    schedule,
    flush,
    flushSyncIfIdle,
    hasPending: () => pending !== null,
    getPending: () => pending?.value ?? null,
  }
}
