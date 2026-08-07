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

  const underlying = Promise.resolve().then(task);
  underlying.catch(() => {});

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      try { signal.removeEventListener('abort', onAbort); } catch {}
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
      (error) => finish(reject, error),
    );
  });
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
