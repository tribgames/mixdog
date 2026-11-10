// The first-output window one provider stream runs under. A logical model
// request owns ONE window (stall-policy.mjs PROVIDER_FIRST_OUTPUT_TIMEOUT_MS)
// from its start, whatever attempts serve it: a provider retry, a loop replay
// or a route fallback opens a new stream for the same request and inherits
// its absolute deadline and whether it already produced output (a stream for
// a request that had output runs under the semantic idle from its opening).
// Only a new logical request (runtime-liveness) starts a new window.
//
// A stream joins the session's request only when it reports its progress
// into it (the loop's onStreamDelta). Forks of the request — a /btw side
// question, a cache warm, a compaction summary — carry the session id without
// that callback and keep a window of their own.
//
// The window is shared by all four transports: the timer-driven ones (WS,
// HTTP/SSE) use arm/noteOutput/clear, the iterator-driven compat streams use
// idleWatch.
import { getLogicalModelRequest } from '../../session/manager/runtime-liveness.mjs';

/**
 * @param {object} input
 * @param {string|null} [input.sessionId]
 * @param {Function} [input.onStreamDelta]  the stream's progress callback
 * @param {number} input.timeoutMs  the window length
 */
export function streamFirstOutputWindow({ sessionId, onStreamDelta, timeoutMs }) {
  const request = typeof onStreamDelta === 'function' ? getLogicalModelRequest(sessionId) : null;
  const deadlineAt = (request?.startedAt || Date.now()) + timeoutMs;
  let timer = null;
  const clear = () => {
    clearTimeout(timer);
    timer = null;
  };
  const window = {
    timeoutMs,
    /** Whether the request (or, after noteOutput, this stream) has produced semantic output. */
    outputSeen: request?.outputSeen === true,
    /** Calls `onExpire` at the request's deadline. */
    arm(onExpire) {
      clear();
      timer = setTimeout(onExpire, Math.max(0, deadlineAt - Date.now()));
      timer.unref?.();
    },
    clear,
    /** The stream's semantic output: ends the window. */
    noteOutput() {
      window.outputSeen = true;
      clear();
    },
    /** The `nextAsyncWithWatchdog` idle bounds: the semantic idle once output
     *  started (`semanticDeadlineAt` set), the window before. */
    idleWatch(semanticDeadlineAt, idleMs) {
      return semanticDeadlineAt > 0
        ? { idleMs, idleDeadlineAt: semanticDeadlineAt }
        : { idleMs: timeoutMs, idleDeadlineAt: deadlineAt };
    },
  };
  return window;
}
