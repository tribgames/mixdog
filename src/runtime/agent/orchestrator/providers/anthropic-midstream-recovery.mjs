/**
 * anthropic-midstream-recovery.mjs — what both Anthropic transports do when
 * an SSE stream fails after its initial response: the per-attempt exposure
 * record (midState), the canonical outcome stamp, and the ordered recovery
 * ladder — acknowledged non-streaming replay for exposed text/thinking,
 * bounded streaming retries for empty / transient / truncated streams,
 * non-streaming fallback for a silent stall, classifier-driven retries with
 * Retry-After, and the exhausted-budget marks on the error that finally
 * surfaces.
 *
 * The ladder reads only the error, the exposure record and the response
 * headers, so the API-key provider (anthropic.mjs) and the OAuth provider
 * (anthropic-oauth.mjs) share it despite sending over different transports.
 * Only the log label, the outcome/owner identities and the verdict on an
 * initial-response error differ, and those arrive as parameters.
 */
import {
  classifyError,
  markProviderRecoveryExhausted,
  midstreamBackoffFor,
  retryAfterMsFromError,
} from './retry-classifier.mjs';
import { _classifyMidstreamError, _midstreamSleepWithAbort, stampAnthropicStreamOutcome } from './anthropic-sse.mjs';
import { notifyCurrentAnthropicRateLimit } from './admission-scheduler.mjs';

export function createAnthropicMidState(attemptIndex) {
  return {
    attemptIndex,
    sawMessageStart: false,
    sawCompleted: false,
    emittedToolCall: false,
    partialToolCall: false,
    emittedThinking: false,
    // Gateway live-text relay invariant: set by parseSSEStream once
    // a non-empty text chunk has been forwarded to the client. A
    // later failure is non-retryable (rendered text cannot be
    // withdrawn; a retry would concatenate attempts).
    emittedText: false,
    userAbort: false,
    watchdogAbort: null,
  };
}

/**
 * @param {object} deps
 * @param {string} deps.label  stderr log tag (provider instance name)
 * @param {string} deps.outcomeProvider  provider id on the canonical outcome stamp
 * @param {string} deps.midstreamOwner  recovery owner recorded when retries are exhausted
 * @param {string} deps.unreachableMessage  message of the never-observed loop-exit error
 * @param {boolean} [deps.initialResponseErrorTerminal]  true when the caller's
 *   request-level retry already spent the budget for a non-OK initial response,
 *   so such an error must not earn an extra SSE retry here
 * @param {number} deps.maxRetries  bounded mid-stream retries for transient stream loss
 * @param {AbortSignal|null} deps.totalSignal
 * @param {{ recoverNonStreaming: Function, issueNonStreamingFallback: Function, requireTransportRecoveryBudget: Function }} deps.recovery
 */
/**
 * Empty-stream guard. Invariant: a valid Anthropic SSE response ALWAYS opens
 * with message_start (which carries usage.input_tokens). A 200 whose body
 * produced no message_start delivered nothing — no usage, no content, no tool
 * calls — i.e. a dropped/empty stream (transient, often rate-limit-adjacent
 * under concurrent load), NOT a valid terminal turn. Returning it surfaces
 * upstream as a silent empty turn (0 tokens, no content) that masks the
 * cause. Throw a marked error: retry is provably safe here (no message_start
 * ⇒ nothing was emitted ⇒ no duplicate-tool risk), and once retries are
 * exhausted the error is surfaced instead of swallowed.
 */
export function assertAnthropicStreamNotEmpty(midState, result, label) {
  if (
    !midState.sawMessageStart &&
    !midState.userAbort &&
    !midState.watchdogAbort &&
    !result.content &&
    !result.toolCalls?.length &&
    !(result.usage && result.usage.inputTokens > 0)
  ) {
    const emptyErr = new Error(
      `${label} SSE stream produced no message_start (empty/dropped stream — likely transient or rate-limited)`
    );
    emptyErr.code = 'EEMPTYSTREAM';
    emptyErr.isEmptyStream = true;
    throw emptyErr;
  }
}

export function createAnthropicMidstreamRecovery({
  label,
  outcomeProvider,
  midstreamOwner,
  unreachableMessage,
  initialResponseErrorTerminal = false,
  maxRetries,
  totalSignal,
  recovery,
}) {
  const log = (line) => {
    try {
      process.stderr.write(`[${label}] ${line}\n`);
    } catch {}
  };
  let firstAttemptError = null;
  let firstAttemptClassifier = null;
  const retry = { retry: true };
  const settled = (value) => ({ retry: false, value });

  // Jittered backoff between streaming attempts; the dead stream is torn
  // down first so its socket returns to the pool.
  const retryStreaming = async ({ err, classifier, controller, attemptIndex, message, delayMs = null }) => {
    firstAttemptError = err;
    firstAttemptClassifier = classifier;
    try {
      controller?.abort?.(err);
    } catch {
      /* best-effort teardown */
    }
    log(message);
    await _midstreamSleepWithAbort(delayMs ?? midstreamBackoffFor(attemptIndex + 1), totalSignal);
    return retry;
  };

  /**
   * Decide the next step for a stream that threw. Resolves `{ retry: true }`
   * after the backoff when the loop should issue another streaming attempt,
   * `{ retry: false, value }` when a non-streaming replay produced the turn,
   * and throws the (stamped) error when the turn is over.
   */
  const onStreamError = async ({ err, midState, controller, response, attemptIndex }) => {
    // Canonical stream-outcome contract: stamp before ANY safety
    // decision below. The parser's stamped verdict (when present)
    // is authoritative — coarse midState.partialToolCall must not
    // overwrite an idempotent pending-input truncation — while
    // genuinely new wrapper-observed exposure is still merged.
    let outcome = null;
    try {
      outcome = stampAnthropicStreamOutcome(err, midState, { provider: outcomeProvider });
    } catch {
      /* stamping is best-effort */
    }
    // Acknowledged reset semantics let the owner tombstone this
    // attempt before the full request is restarted non-streaming.
    // Without that acknowledgement, recoverNonStreaming stamps
    // the error unsafe and preserves the no-concatenation rule.
    if (midState.emittedText || midState.emittedThinking) {
      return settled(await recovery.recoverNonStreaming(midState, err, controller));
    }
    // Dispatched tools and exposed thinking are replay boundaries;
    // the canonical merge above already recorded them and wrote the
    // aliases. Coarse midState flags are NOT written here: they
    // would downgrade the parser's authoritative verdict that an
    // incomplete, never dispatched tool input stays replay-safe.
    // Every retry branch below relies on this early exit.
    if (outcome?.replayUnsafe === true) {
      try {
        controller?.abort?.(err);
      } catch {}
      throw err;
    }
    // The request-level retry loop already exhausted its full budget on a
    // non-OK initial response. Do not accidentally grant an additional SSE
    // retry budget to an initial HTTP 429 that never produced a stream.
    if (initialResponseErrorTerminal && err?.initialResponseError) throw err;
    const canRetry = attemptIndex < maxRetries;
    const attemptLabel = `${attemptIndex + 1}/${maxRetries}`;
    // Empty/dropped stream (no message_start): safe to retry once —
    // nothing was emitted, so there is no duplicate-tool risk. This
    // is intentionally NOT routed through _classifyMidstreamError,
    // which requires sawMessageStart and would reject it.
    if (err?.isEmptyStream && canRetry) {
      return retryStreaming({
        err,
        classifier: 'empty_stream',
        controller,
        attemptIndex,
        message: `empty stream (no message_start) — retry ${attemptLabel}`,
      });
    }
    if (classifyError(err) === 'transient' && !midState.sawMessageStart && canRetry) {
      return retryStreaming({
        err,
        classifier: err?.providerErrorType || 'sse_transient',
        controller,
        attemptIndex,
        message: `transient SSE error — retry ${attemptLabel} (${err?.providerErrorType || err?.message || 'unknown'})`,
      });
    }
    // Truncated stream (message_start without message_stop): the
    // partial result is discarded and re-requesting is safe (a
    // pendingToolUse means the tool_use input JSON never completed).
    // _classifyMidstreamError does not cover this; route it through
    // the shared classifier so it inherits the cross-provider
    // transient policy instead of escaping and killing the worker.
    // Guard: parseSSEStream eagerly fires onToolCall and sets
    // emittedToolCall=true at content_block_stop, BEFORE message_stop.
    // If the stream truncates after that, retrying would
    // double-execute the tool. Only retry when nothing was emitted
    // yet; otherwise let the error surface.
    if (
      (err?.truncatedStream === true || err?.code === 'TRUNCATED_STREAM') &&
      classifyError(err) === 'transient' &&
      canRetry
    ) {
      return retryStreaming({
        err,
        classifier: 'truncated_stream',
        controller,
        attemptIndex,
        message: `truncated stream — retry ${attemptLabel}`,
      });
    }
    const classifier = _classifyMidstreamError(err, midState);
    // Stall recovery: a stalled stream that exposed NOTHING (no
    // text/thinking relayed, no tool emitted) is re-issued NON-STREAMING
    // instead of retrying the same streaming shape. Effort-mode models can
    // legitimately think in silence past any streaming idle window; an
    // in-place streaming retry re-runs the same silent generation into the
    // same timer (observed live: deterministic 4×~138s beheading, ~552s per
    // turn), while the non-streaming transport simply waits for the full
    // body (bounded by PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS). Replay is
    // trivially safe here — nothing was relayed or dispatched.
    if (
      classifier === 'stream_stalled' &&
      !midState.emittedText &&
      !midState.emittedToolCall &&
      !midState.partialToolCall &&
      !midState.emittedThinking
    ) {
      recovery.requireTransportRecoveryBudget(err, controller);
      log('stream stalled with no exposure — retrying non-streaming');
      return settled(await recovery.issueNonStreamingFallback(controller, err));
    }
    if (classifier === 'stream_stalled') {
      recovery.requireTransportRecoveryBudget(err, controller);
    }
    if (classifier && canRetry) {
      firstAttemptError = err;
      firstAttemptClassifier = classifier;
      const status = Number(err?.httpStatus || err?.status || 0);
      let retryDelayMs = null;
      if (status === 429) {
        if (!err.headers && response?.headers) err.headers = response.headers;
        if (!err.response && response) err.response = { status, headers: response.headers };
        retryDelayMs = retryAfterMsFromError(err);
        if (retryDelayMs != null) err.retryAfterMs = retryDelayMs;
        notifyCurrentAnthropicRateLimit(err);
      }
      try {
        controller?.abort?.(err);
      } catch (abortErr) {
        /* best-effort stream teardown */
        log(`abort on stream error failed: ${abortErr?.message ?? String(abortErr)}`);
      }
      log(`mid-stream recovered: retry ${attemptLabel} (cause: ${classifier})`);
      await _midstreamSleepWithAbort(retryDelayMs ?? midstreamBackoffFor(attemptIndex + 1), totalSignal);
      return retry;
    }
    if (classifier && !canRetry) {
      markProviderRecoveryExhausted(err, {
        owner: midstreamOwner,
        attempts: attemptIndex + 1,
      });
    }
    if (attemptIndex > 0 && firstAttemptError) {
      try {
        err.midstreamRetries = attemptIndex;
      } catch {}
      try {
        err.midstreamClassifier = firstAttemptClassifier;
      } catch {}
    }
    throw err;
  };

  const exhaustedError = () => firstAttemptError || new Error(unreachableMessage);

  return { onStreamError, exhaustedError };
}
