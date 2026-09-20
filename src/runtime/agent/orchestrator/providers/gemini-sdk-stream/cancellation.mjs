// Cancellation of an in-flight Gemini SDK iterator.
//
// A timeout or external abort must stop the generation and retire the SDK
// iterator without deadlocking on it. The first forced failure wins; a read
// that settles later reports that failure once cleanup finished.
export function createSdkStreamCancellation({ signal, label, cancelGeneration, cancellationGraceMs }) {
  let iterator = null;
  let cancellation = null;
  let forcedFailure = null;

  const abortError = () => (signal?.reason instanceof Error ? signal.reason : new Error(`${label} aborted`));

  const cancelInFlight = (err) => {
    if (cancellation) return cancellation;
    forcedFailure = err;
    cancellation = (async () => {
      try {
        cancelGeneration?.(err);
      } catch {}
      let returnPromise;
      try {
        returnPromise = Promise.resolve(iterator?.return?.());
      } catch {
        return;
      }
      // iterator.return() is best-effort cleanup. A broken SDK iterator
      // must not deadlock the timeout path and prevent withRetry from
      // beginning the next attempt after the generation was aborted.
      let graceTimer = null;
      try {
        await Promise.race([
          returnPromise.catch(() => {}),
          new Promise((resolve) => {
            graceTimer = setTimeout(resolve, Math.max(0, cancellationGraceMs));
          }),
        ]);
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
        // Keep observing a late rejection after the grace race expires.
        returnPromise.catch(() => {});
      }
    })();
    return cancellation;
  };

  return {
    abortError,
    cancelInFlight,
    // The iterator to retire; bound once the SDK stream is opened.
    bindIterator(next) {
      iterator = next;
    },
    // Fail a pending read only after the generation was cancelled.
    rejectAfterCancellation(reject, err) {
      cancelInFlight(err).then(
        () => reject(err),
        () => reject(err)
      );
    },
    // A read settling after a forced cancellation reports that failure once
    // cleanup finished. Returns false when no cancellation was forced.
    settleForced(reject) {
      if (!forcedFailure) return false;
      cancellation.then(
        () => reject(forcedFailure),
        () => reject(forcedFailure)
      );
      return true;
    },
  };
}
