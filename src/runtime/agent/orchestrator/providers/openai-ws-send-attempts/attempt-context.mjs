/**
 * attempt-context.mjs — the state that crosses the attempts of one logical
 * WS send, plus the surface/backoff primitives both failure resolvers use.
 */
import { performance } from 'node:perf_hooks';
import { _sleepWithAbort, MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT, midstreamBackoffFor, tag } from './policy.mjs';

export function createAttemptContext(deps) {
  const { sendSpan, externalSignal, sleepFn, stampWarmup, safetyStamps } = deps;
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
  const backoff = async (retryNumber) => {
    const sleepStart = performance.now();
    try {
      await _sleepWithAbort(midstreamBackoffFor(retryNumber), externalSignal, sleepFn);
    } catch (sleepErr) {
      sendSpan.retryBackoffMs += performance.now() - sleepStart;
      sendSpan.emit('error');
      throw stampWarmup(sleepErr);
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
  /** Stash the error a retry is about to leave behind and announce the retry. */
  const scheduleRetry = (err, { attemptIndex, classifier, retryLimit, remember }) => {
    if (remember) {
      state.firstAttemptError = err;
      state.firstAttemptClassifier = classifier;
    }
    tag(err, { midstreamClassifier: classifier });
    deps.emitReconnectProgress({ attempt: attemptIndex + 1, max: retryLimit, classifier });
  };

  return {
    deps,
    state,
    maxMidstreamRetries: MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT,
    stampAll,
    surface,
    backoff,
    surfaceFirstAttempt,
    scheduleRetry,
  };
}
