// The phase a provider timeout names on its `timeoutPhase` field. A provider
// stamps it where the timer that fired is known; retry policy and error
// presentation read it instead of matching the timeout's message text.
export const TIMEOUT_PHASE = Object.freeze({
  // The response headers did not arrive in the first-byte window.
  HEADERS: 'headers',
  // The headers arrived, the first chunk did not.
  FIRST_CHUNK: 'first-chunk',
  // A stream that already produced output went silent.
  IDLE: 'idle',
});

/** A timeout before the model produced anything: headers or first chunk. */
export function isFirstByteTimeout(err) {
  const phase = err?.timeoutPhase;
  return phase === TIMEOUT_PHASE.HEADERS || phase === TIMEOUT_PHASE.FIRST_CHUNK;
}
