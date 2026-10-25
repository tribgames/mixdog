/**
 * attempt-context.mjs — the state that crosses the attempts of one logical
 * WS send, plus the surface/backoff primitives both failure resolvers use.
 */
import { performance } from 'node:perf_hooks';
import { appendAgentTrace } from '../../agent-trace.mjs';
import {
  _sleepWithAbort,
  MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT,
  midstreamBackoffFor,
  tag,
} from './policy.mjs';
import { retryReasonClass, safeRetryErrorCode } from '../provider-error-kind.mjs';

/** One row per WS retry: the server's typed verdict (status, close code, an
 *  identifier-shaped code, the reason class) and the wait it bought, so a
 *  long advised wait is diagnosable after the fact. Never the server's free
 *  text: it can echo request content. Diagnostics only; never throws. */
function traceRetry(traceFn, trace, err, { attempt, max, classifier, waitMs }) {
  try {
    const payload = {
      provider: trace?.traceProvider || null,
      model: trace?.useModel || null,
      transport: 'websocket',
      attempt,
      max,
      classifier: classifier || null,
      reason: retryReasonClass(err),
      wait_ms: Math.round(Number(waitMs) || 0),
      http_status: Number(err?.httpStatus || err?.status || 0) || null,
      code: safeRetryErrorCode(err),
      ws_close_code: Number(err?.wsCloseCode || 0) || null,
    };
    traceFn({ sessionId: trace?.poolKey || null, kind: 'ws_retry', ...payload, payload });
  } catch {}
}

export function createAttemptContext(deps) {
  const { sendSpan, externalSignal, sleepFn, safetyStamps } = deps;
  const state = {
    /** The error the user's turn actually tripped on, surfaced when the
     *  retries that followed it also fail. */
    firstAttemptError: null,
    firstAttemptClassifier: null,
    /** Armed by the rejection safety net: once a server rejects a replayed
     *  reasoning item, every later attempt of THIS send strips them. */
    suppressReasoningReplay: false,
    /** Server-side xAI conversation anchor preserved across mid-stream
     *  retries. xAI keys its conversation by previous_response_id alone
     *  (sessionToken is null for xAI in _mintSessionToken); a forceFresh
     *  socket on retry would otherwise drop prev_id and cold-start a new
     *  server-side conversation, evicting every prefix the prior attempts
     *  warmed. openai-oauth / openai-direct anchor by per-socket session_id,
     *  where this carry-forward would not help and is therefore gated to xAI. */
    carryForwardCache: null,
  };
  const stampAll = (err) => safetyStamps.stampTool(safetyStamps.stampText(err));
  const surface = (err, target = null) => {
    sendSpan.emit('error', target);
    return stampAll(err);
  };
  // Server advice (Retry-After, or a typed rate limit's "try again in")
  // replaces the local curve, like the reference client's retry deadline.
  // Resolved before the retry is announced so the reconnect stage can name
  // the wait it is about to sit through.
  const retryWaitMs = (retryNumber, err = null) => midstreamBackoffFor(retryNumber, err);
  const backoff = async (waitMs) => {
    const sleepStart = performance.now();
    try {
      await _sleepWithAbort(waitMs, externalSignal, sleepFn);
    } catch (sleepErr) {
      sendSpan.retryBackoffMs += performance.now() - sleepStart;
      sendSpan.emit('error');
      throw sleepErr;
    }
    sendSpan.retryBackoffMs += performance.now() - sleepStart;
  };
  /** The first-attempt error is what the caller sees once retries are
   *  exhausted, tagged with how many retries it survived. */
  const surfaceFirstAttempt = (attemptIndex, retryLimit, extra) => {
    const first = state.firstAttemptError;
    tag(first, { midstreamRetries: attemptIndex, midstreamClassifier: state.firstAttemptClassifier });
    if (attemptIndex >= retryLimit) {
      tag(first, { wsRetriesExhausted: true });
      extra?.(first);
    }
    return first;
  };
  /** Stash the error a retry is about to leave behind and announce the retry
   *  with its cause and the wait before the next attempt. */
  const scheduleRetry = (err, { attemptIndex, classifier, retryLimit, remember, waitMs = 0 }) => {
    if (remember) {
      state.firstAttemptError = err;
      state.firstAttemptClassifier = classifier;
    }
    tag(err, { midstreamClassifier: classifier });
    deps.emitReconnectProgress({ attempt: attemptIndex + 1, max: retryLimit, classifier, error: err, waitMs });
    traceRetry(deps.traceFn || appendAgentTrace, deps.trace, err, {
      attempt: attemptIndex + 1,
      max: retryLimit,
      classifier,
      waitMs,
    });
  };

  return {
    deps,
    state,
    maxMidstreamRetries: MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT,
    stampAll,
    surface,
    retryWaitMs,
    backoff,
    surfaceFirstAttempt,
    scheduleRetry,
  };
}
