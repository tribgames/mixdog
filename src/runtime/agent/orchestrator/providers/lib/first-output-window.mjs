// The first-output window one provider stream runs under. A logical model
// request owns ONE window (stall-policy.mjs PROVIDER_FIRST_OUTPUT_TIMEOUT_MS)
// from its start, whatever attempts serve it: a provider retry, a loop replay
// or a route fallback opens a new stream for the same request and inherits
// its absolute deadline and whether it already produced output (a stream for
// a request that had output runs under the semantic idle from its opening).
// Only a new logical request (runtime-liveness) starts a new window.
//
// A stream joins the session's request only when it reports its progress
// into it (`reportsProgress`: the loop's onStreamDelta). Forks of the request
// — a /btw side question, a cache warm, a compaction summary — carry the
// session id without that callback and keep a window of their own.
import { getLogicalModelRequest } from '../../session/manager/runtime-liveness.mjs';

/**
 * @param {object} input
 * @param {string|null} [input.sessionId]
 * @param {boolean} input.reportsProgress
 * @param {number} input.timeoutMs  the window length
 * @returns {{ timeoutMs: number, deadlineAt: number, outputSeen: boolean }}
 */
export function streamFirstOutputWindow({ sessionId, reportsProgress, timeoutMs }) {
  const request = reportsProgress ? getLogicalModelRequest(sessionId) : null;
  return {
    timeoutMs,
    deadlineAt: (request?.startedAt || Date.now()) + timeoutMs,
    outputSeen: request?.outputSeen === true,
  };
}
