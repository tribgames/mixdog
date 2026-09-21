/**
 * policy.mjs — the WS send retry budget, its backoff curves and the
 * classification wrappers shared by the handshake and stream resolvers.
 */
import {
  classifyHandshakeError,
  classifyMidstreamError,
  jitterDelayMs,
  MIDSTREAM_RETRY_POLICY,
  sleepWithAbort,
} from '../retry-classifier.mjs';

// The official Codex Responses policy has one five-retry stream budget shared
// by connect/handshake and pre-output stream failures.
export const MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT = MIDSTREAM_RETRY_POLICY.ws.transientCloseRetries;
const MIDSTREAM_DEFAULT_RETRY_LIMIT = MIDSTREAM_RETRY_POLICY.ws.defaultRetries;
// The reference client uses a 200ms base, factor 2, and symmetric ±10%
// jitter for each of its five stream retries.
const MIDSTREAM_BACKOFF_MS = Object.freeze([200, 400, 800, 1600, 3200]);
const CODEX_RETRY_JITTER_RATIO = 0.1;
// Policy object passed to the shared classifyMidstreamError for the WS path.
const WS_MIDSTREAM_POLICY = {
  mode: 'ws',
  transientCloseRetries: MIDSTREAM_RETRY_POLICY.ws.transientCloseRetries,
  defaultRetries: MIDSTREAM_RETRY_POLICY.ws.defaultRetries,
};

// Kept for the _acquireWithRetry test seam and non-Codex callers.
// sendViaWebSocket deliberately invokes it with maxAttempts:1 so handshake
// failures consume the same stream budget as pre-output disconnects.
export const HANDSHAKE_MAX_ATTEMPTS = MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT + 1;
const HANDSHAKE_BACKOFF_BASE_MS = 200;
const HANDSHAKE_BACKOFF_CAP_MS = 3200;
// These statuses are decisions made by the CURRENT attempt. They must never
// be replaced by a stale transient from an earlier retry: auth recovery,
// transport fallback, and Retry-After handling all depend on the live error.
const CURRENT_ATTEMPT_DECISION_STATUSES = new Set([401, 403, 426, 429]);

export function _mustSurfaceCurrentAttempt(err, externalSignal) {
  return (
    CURRENT_ATTEMPT_DECISION_STATUSES.has(Number(err?.httpStatus || 0)) ||
    externalSignal?.aborted ||
    err?.unsafeToRetry === true
  );
}

export function _classifyHandshakeError(err, { retry429 = true } = {}) {
  return classifyHandshakeError(err, { retry429 });
}

/**
 * Classify a mid-stream error for bounded retry eligibility.
 *
 * Only fires AFTER `response.created` is observed and BEFORE
 * `response.completed`. The window is narrow on purpose: retrying a handshake
 * or a pre-create connect failure is owned by _acquireWithRetry; retrying
 * after completion would replay a finished turn.
 *
 * Retry buckets:
 *   'agent_stall'        — AgentStallAbortError from agent stall watchdog
 *   'stream_stalled'     — StreamStalledAbortError from stream-watchdog
 *   'ws_1006'            — abnormal close (connection lost)
 *   'ws_1011'            — server unexpected condition
 *   'ws_1012'            — service restart
 *   'ws_4000'            — our armPreStreamWatchdog close with idle_timeout
 *   'ws_1000'            — server-side normal close fired after response.created
 *                          but before response.completed (truncated stream)
 *   'first_byte_timeout' — post-upgrade-no-first-event: socket opened, our
 *                          response.create frame sent, but the server never
 *                          emitted response.created within the short
 *                          pre-stream deadline. Fast-fail retryable.
 *   'response_failed_network'       — response.failed with network_error
 *   'response_failed_disconnected'  — response.failed with stream_disconnected
 *
 * Deny buckets (return null):
 *   - externalSignal aborted by user (state.userAbort)
 *   - state.sawCompleted === true (already done)
 *   - state.sawResponseCreated === false (still pre-stream; handshake retry
 *     owns that window) — EXCEPT for WS close 1011/1012, which can fire
 *     after the 101 upgrade but before the first response.created event,
 *     AND the pre-`response.created` first-byte timeout
 *     (state.firstByteTimeout), which is permitted a bounded retry here
 *   - HTTP 401 / 403 / 429 surfaced after the WS handshake
 *   - state.attemptIndex has reached the classifier-specific retry budget
 *
 * The full WS decision tree lives in the shared classifyMidstreamError
 * (retry-classifier.mjs, policy.mode='ws'). Kept as a named export so internal
 * call sites and any external importer keep resolving the same symbol.
 */
export function _classifyMidstreamError(err, state) {
  return classifyMidstreamError(err, state, WS_MIDSTREAM_POLICY);
}

// Per-classifier retry budget, used by the sendViaWebSocket loop to bound the
// attempt count once classifyMidstreamError returns a bucket. Mirrors the
// shared _midstreamLimitFor(ws) — both values are the same unified budget.
export function midstreamRetryLimit(classifier) {
  return classifier === 'ws_1006' || classifier === 'ws_1011'
    ? MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT
    : MIDSTREAM_DEFAULT_RETRY_LIMIT;
}

export function midstreamBackoffFor(retryNumber) {
  const raw = MIDSTREAM_BACKOFF_MS[Math.min(Math.max(retryNumber, 1), MIDSTREAM_BACKOFF_MS.length) - 1];
  return jitterDelayMs(raw, CODEX_RETRY_JITTER_RATIO);
}

export function _backoffFor(attempt) {
  // attempt is 1-based; exponential backoff is capped before jitter.
  const raw = HANDSHAKE_BACKOFF_BASE_MS * (1 << (attempt - 1));
  return jitterDelayMs(Math.min(raw, HANDSHAKE_BACKOFF_CAP_MS), CODEX_RETRY_JITTER_RATIO);
}

export const _defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Abort-aware backoff sleep → shared sleepWithAbort (retry-classifier.mjs). The
// abortMessage preserves the prior fallback text when the abort reason is not an
// Error; _sleepFn (test seam) is threaded through as the no-signal sleep impl.
export function _sleepWithAbort(ms, externalSignal, sleepFn = _defaultSleep) {
  return sleepWithAbort(ms, externalSignal, sleepFn, 'OpenAI OAuth WS retry backoff aborted');
}

/**
 * Server rejection of a replayed reasoning item (duplicate rs_* inside a
 * stateful chain). Deliberately narrow: generic transport/5xx errors must not
 * trip the replay-suppression retry.
 */
export function isReasoningReplayRejection(err) {
  const msg = String(err?.payload?.message || err?.message || '');
  if (!msg) return false;
  if (/\brs_[A-Za-z0-9]/i.test(msg) && /duplicate|already|exists|repeated/i.test(msg)) return true;
  return /reasoning/i.test(msg) && /duplicate|already exists|repeated|invalid item/i.test(msg);
}

/** Best-effort field assignment onto errors that may be frozen or exotic. */
export function tag(target, fields) {
  for (const [key, value] of Object.entries(fields)) {
    try {
      target[key] = value;
    } catch {}
  }
}
