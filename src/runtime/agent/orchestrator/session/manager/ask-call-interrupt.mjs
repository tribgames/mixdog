// manager/ask-call-interrupt.mjs
// The abort-aware call wrapper: a provider call races the session's abort
// signal so closeSession() settles the ask even when the provider ignores
// the signal.
import { createAbortController } from '../../../../shared/abort-controller.mjs';
import { _touchRuntime } from './runtime-liveness.mjs';
import { SessionClosedError } from './session-errors.mjs';

/**
 * Wrap an async call so that if the session's controller aborts mid-flight,
 * the wrapper settles with a SessionClosedError even if the underlying promise
 * hasn't returned yet. The original promise is kept alive with a detached
 * `.catch()` to prevent unhandled-rejection warnings once it eventually
 * settles. Callers still must check generation/closed after await returns
 * to handle providers that ignore the AbortSignal entirely.
 */
export async function _api_call_with_interrupt(sessionId, fn) {
  const entry = _touchRuntime(sessionId);
  if (!entry.controller) entry.controller = createAbortController();
  const signal = entry.controller.signal;
  const closedFromAbort = (phase) => {
    const reason = signal.reason;
    if (reason instanceof SessionClosedError) return reason;
    let detail = '';
    if (reason instanceof Error) detail = reason.message;
    else if (reason !== undefined && reason !== null && reason !== '') detail = String(reason);
    return new SessionClosedError(sessionId, detail ? `${phase}: ${detail}` : phase);
  };
  if (signal.aborted) throw closedFromAbort('aborted before call');
  const underlying = fn(signal);
  underlying.catch(() => {}); // prevent unhandled rejection if we race ahead
  let onAbort = null;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(closedFromAbort('aborted during call'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([underlying, aborted]);
  } finally {
    // If the underlying promise settled first, the abort listener is
    // still attached. Remove it to avoid accumulating listeners across
    // many asks on the same session.
    if (onAbort && !signal.aborted) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        /* ignore */
      }
    }
  }
}
