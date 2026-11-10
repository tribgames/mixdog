/**
 * fair-call-scheduler/queue-item.mjs — the errors a scheduled call can be
 * rejected with, and the abort-listener detach every dequeue path shares.
 */
export function schedulerError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function abortError(signal, fallback = 'scheduled call canceled') {
  return signal?.reason instanceof Error ? signal.reason : schedulerError(String(signal?.reason || fallback), 499);
}

export function detach(item) {
  if (!item?.onAbort || !item.signal) return;
  try {
    item.signal.removeEventListener('abort', item.onAbort);
  } catch {}
  item.onAbort = null;
}
