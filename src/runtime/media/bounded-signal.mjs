/** The caller's signal (when any) combined with a timeout of `ms`. */
export function timeoutSignal(signal, ms) {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)].filter(Boolean));
}

/**
 * Abort signal for one request inside a polling job: the caller's signal, plus
 * a timeout of `capMs` clamped so the request never outlives the job deadline.
 */
export function boundedSignal(signal, deadline, capMs) {
  const remaining = Math.max(1, deadline - Date.now());
  return timeoutSignal(signal, Math.min(capMs, remaining));
}
