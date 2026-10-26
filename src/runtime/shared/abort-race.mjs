export function abortReason(signal, fallback = 'Operation aborted') {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (reason !== undefined && reason !== null && reason !== '') {
    return new Error(String(reason));
  }
  return new Error(fallback);
}

export function throwIfAborted(signal, fallback) {
  if (signal?.aborted) throw abortReason(signal, fallback);
}

/**
 * Await one operation while making the caller's settlement independent from
 * an implementation that ignores AbortSignal. The detached operation remains
 * observed so a later rejection can never become unhandled.
 */
export async function runAbortable(signal, task, fallback) {
  if (typeof task !== 'function') throw new TypeError('runAbortable requires a task function');
  if (!signal) return await task();
  throwIfAborted(signal, fallback);

  const underlying = Promise.resolve().then(() => {
    throwIfAborted(signal, fallback);
    return task();
  });
  underlying.catch(() => {});

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {}
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal, fallback));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    underlying.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

/** Resolves after `ms`, or rejects with the abort reason once `signal` aborts. */
export function sleepUnlessAborted(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One operation that several callers await. `start(signal)` runs once, when
 * the first caller that still wants it joins — a live signal, or none — so a
 * caller that is already aborted starts nothing. Its signal aborts only when
 * every caller that joined with a signal has aborted and no caller joined
 * without one (such a caller keeps it running). The caller whose abort cancels
 * the work waits for the work to settle, its cleanup included, so nothing it
 * started outlives it; any other aborted caller stops waiting at once and
 * leaves the work to the callers still on it. `onSettled(failed)` runs once
 * the started work settles; `promise` is that work, null until started.
 */
export function createSharedAbortable(start, { onSettled = null } = {}) {
  const controller = new AbortController();
  let waiting = 0;
  let pinned = false;
  let promise = null;
  const begin = () => {
    if (!promise) {
      promise = Promise.resolve().then(() => start(controller.signal));
      promise.then(
        () => onSettled?.(false),
        () => onSettled?.(true)
      );
    }
    return promise;
  };
  return {
    get promise() {
      return promise;
    },
    join(signal) {
      if (!signal) {
        pinned = true;
        return begin();
      }
      if (signal.aborted) return Promise.reject(abortReason(signal));
      waiting += 1;
      const work = begin();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          waiting -= 1;
          const reason = abortReason(signal);
          if (waiting > 0 || pinned) {
            reject(reason);
            return;
          }
          controller.abort(reason);
          work.then(
            () => reject(reason),
            () => reject(reason)
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(
          (value) => {
            if (signal.aborted) return;
            signal.removeEventListener('abort', onAbort);
            waiting -= 1;
            resolve(value);
          },
          (error) => {
            if (signal.aborted) return;
            signal.removeEventListener('abort', onAbort);
            waiting -= 1;
            reject(error);
          }
        );
      });
    },
  };
}

/**
 * Bound best-effort cleanup without cancelling the underlying work. The
 * detached promise remains observed and may still finish in the background.
 */
export async function settleWithin(promise, timeoutMs) {
  const budget = Number(timeoutMs);
  if (!(Number.isFinite(budget) && budget > 0)) {
    return { settled: true, value: await promise };
  }
  const underlying = Promise.resolve(promise).then((value) => ({ settled: true, value }));
  underlying.catch(() => {});
  let timer = null;
  try {
    return await Promise.race([
      underlying,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false, value: undefined }), budget);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
