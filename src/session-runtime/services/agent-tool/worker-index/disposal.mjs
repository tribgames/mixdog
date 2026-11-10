// worker-index/disposal.mjs
// Disposing a worker index: queued rows persist first, then `teardown`
// releases its registrations; a failed drain leaves them for a retry. Owns
// the disposed / in-flight dispose state.
export function createIndexDisposal({ batch, store, teardown }) {
  let disposed = false;
  let disposePromise = null;

  async function drainThenTeardown() {
    batch.flush();
    await store.flush();
    teardown();
  }

  /** Persist queued rows, then release the exit registration. Active rows are
   *  NOT settled: they are keyed by process pid, which every inline runtime in
   *  the daemon shares, so settling here would idle other runtimes' workers.
   *  When the sync flush cannot run (this process's async writer holds the
   *  lock) the exit hook and store ref stay until the async drain settles. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    let flushed = false;
    try {
      batch.flush();
      flushed = store.flushSync();
    } catch {}
    if (flushed) {
      teardown();
      return;
    }
    disposePromise = drainThenTeardown().catch(reopenAfterFailedDrain);
  }

  /** A failed drain tears nothing down; allow a later dispose to retry it. */
  function reopenAfterFailedDrain() {
    disposed = false;
    disposePromise = null;
  }

  /** Awaitable dispose: drain everything, then tear down. A failed drain
   *  rejects and leaves the registrations in place. */
  function disposeAsync() {
    if (!disposePromise) {
      disposed = true;
      disposePromise = drainThenTeardown().catch((error) => {
        reopenAfterFailedDrain();
        throw error;
      });
    }
    return disposePromise;
  }

  return { dispose, disposeAsync };
}
