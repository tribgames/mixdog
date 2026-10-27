/**
 * anthropic-api-transport.mjs — the two SDK calls one API-key Anthropic turn
 * can make and the initial-response retry policy they share: the streaming
 * POST whose SSE body the turn parses, the stream:false re-issue the
 * non-streaming fallback needs, initial-response status typing (429 → typed
 * quota error carrying Retry-After), fast-pool de-latching between attempts
 * and the rate-limit notification the admission scheduler reads.
 *
 * Also owns the first-byte watchdog of a stream that has been handed over:
 * a response whose SSE body never produces message_start is aborted here.
 */
import {
  ANTHROPIC_RETRY_BACKOFF_MS,
  ANTHROPIC_RETRY_JITTER_RATIO,
  anthropicMaxAttempts,
  anthropicRequestTimeoutMs,
  AnthropicFallbackTriggeredError,
  emitProviderRetryStage,
  withRetry,
  retryDelayLabel,
} from './retry-classifier.mjs';
import { ANTHROPIC_MAX_CONSECUTIVE_529 } from './retry-backoff.mjs';
import { PROVIDER_FIRST_BYTE_TIMEOUT_MS, createTimeoutSignal } from '../stall-policy.mjs';
import { fastModeDowngraded, noteFastModeCapacityError } from './anthropic-fast-mode.mjs';
import { adjustMaxTokensForContextOverflow } from './anthropic-max-tokens-recovery.mjs';
import { applyAnthropicErrorContract, retryAfterMsFromHeaders } from './anthropic-error-contract.mjs';
import { noteRequestServiceTier } from '../../../shared/llm/usage-context.mjs';
import { notifyCurrentAnthropicRateLimit } from './admission-scheduler.mjs';

/**
 * Abort a handed-over stream that never reached message_start. The poll
 * disarms the window as soon as the first message arrives; `cleanup` is
 * idempotent and safe to call from both the success path and the finally.
 *
 * @param {{ signal: AbortSignal, abort: Function }} streamController
 * @param {{ sawMessageStart: boolean }} midState
 */
export function armFirstByteWatchdog(streamController, midState) {
  const firstByteTimeout = createTimeoutSignal(
    streamController.signal,
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    'Anthropic SSE first byte'
  );
  firstByteTimeout.signal.addEventListener(
    'abort',
    () => {
      if (!midState.sawMessageStart) {
        try {
          streamController.abort(firstByteTimeout.signal.reason);
        } catch {}
      }
    },
    { once: true }
  );

  let poll = setInterval(() => {
    if (midState.sawMessageStart) {
      firstByteTimeout.cleanup();
      clearInterval(poll);
      poll = null;
    }
  }, 25);

  return {
    cleanup: () => {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
      firstByteTimeout.cleanup();
    },
  };
}

/**
 * @param {object} deps
 * @param {{ messages: { create: Function } }} deps.client  Anthropic SDK client
 * @param {string} deps.label  stderr log tag (provider instance name)
 * @param {object} deps.opts  send options (fallback model, timeouts)
 * @param {string} deps.useModel
 * @param {object} deps.params  the streaming request body (mutated on fast-pool de-latch)
 * @param {object|null} deps.requestHeaders  per-call beta/extra headers
 * @param {AbortSignal|null} deps.totalSignal  session-lifetime pass-through
 * @param {{ state: { consecutive529Errors: number } }|null} [deps.overload]  the send's shared overload counter
 */
export function createAnthropicApiTransport({
  client,
  label,
  opts,
  useModel,
  params,
  requestHeaders,
  totalSignal,
  overload = null,
}) {
  const requestOptions = (attemptSignal) => ({
    signal: attemptSignal,
    ...(requestHeaders ? { headers: requestHeaders } : {}),
  });
  // The SDK throws a non-2xx before `.asResponse()` resolves, so an HTTP
  // failure arrives as an APIError rather than a Response. Stamp the
  // provider-boundary error contract on it (status, lowercased error type as
  // `code`, preserved headers, uncapped retryAfterMs / resetAt).
  const annotateHttpFailure = (err) => {
    if (err && typeof err === 'object' && Number(err.status || err.httpStatus || 0) > 0) {
      applyAnthropicErrorContract(err, { status: err.status || err.httpStatus, headers: err.headers });
    }
    return err;
  };
  // A fast-pool refusal (or a "Fast mode is not enabled" 400) says nothing
  // about standard-speed capacity: drop `speed` and let the caller replay at
  // once instead of waiting out a window that only the fast pool owns.
  const dropFastSpeedAfter = (body, err) => {
    if (body.speed !== 'fast') return false;
    if (!fastModeDowngraded(noteFastModeCapacityError(err, { fast: true }))) return false;
    delete body.speed;
    return true;
  };
  // In-attempt body repairs, each replayed once: drop speed after a fast-pool
  // refusal, and shrink max_tokens after the "input length and max_tokens
  // exceed context limit" 400.
  const withBodyRecovery = (body, attempt) => async (ctx) => {
    let speedDropped = false;
    let tokensAdjusted = false;
    for (;;) {
      try {
        return await attempt(ctx);
      } catch (err) {
        if (!speedDropped && dropFastSpeedAfter(body, err)) {
          speedDropped = true;
        } else if (!tokensAdjusted && adjustMaxTokensForContextOverflow(body, err?.status, err?.message)) {
          tokensAdjusted = true;
        } else {
          throw err;
        }
      }
    }
  };
  // Initial-response retry policy shared by the streaming request and the
  // non-streaming fallback.
  const retryPolicy = (signal, perAttemptLabel, recoveryOwner) => ({
    signal,
    maxAttempts: anthropicMaxAttempts(),
    backoffMs: ANTHROPIC_RETRY_BACKOFF_MS,
    retryJitterRatio: ANTHROPIC_RETRY_JITTER_RATIO,
    retryJitterMode: 'positive',
    perAttemptTimeoutMs: anthropicRequestTimeoutMs(),
    perAttemptLabel,
    provider: 'anthropic',
    // This transport honors the positive x-should-retry override.
    honorShouldRetryTrue: true,
    recoveryOwner,
    retry529: opts.retry529,
    model: useModel,
    fallbackModel: opts._fallbackTriggered ? undefined : opts.fallbackModel,
    // One overload counter for the send: SSE overloads count toward the same
    // limit as request-loop 529s.
    overloadState: overload?.state,
    overloadFallbackAfter: ANTHROPIC_MAX_CONSECUTIVE_529,
    stopAfterRepeated529: overload?.stopAfterRepeated529 === true,
  });

  const requestStreamingResponse = async () => {
    const attempt = async ({ signal: attemptSignal }) => {
      noteRequestServiceTier(params.speed);
      try {
        const res = await client.messages.create(params, requestOptions(attemptSignal)).asResponse();
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`Anthropic API ${res.status}: ${text.slice(0, 200)}`);
          // Carry response headers so withRetry can honor a
          // short Retry-After and upstream can read quota hints.
          err.headers = res.headers;
          err.response = { status: res.status, headers: res.headers };
          // This is an initial-response 429, before SSE
          // output/tool exposure, so the request-local
          // withRetry loop may retry it with jitter.
          if (res.status === 429) {
            err.name = 'ProviderQuotaError';
            err.retryAfterMs = retryAfterMsFromHeaders(res.headers);
            err.providerQuota = true;
            err.quotaExceeded = true;
          }
          throw applyAnthropicErrorContract(err, { status: res.status, headers: res.headers, bodyText: text });
        }
        if (!res.body) {
          throw new Error('Anthropic streaming response has no body');
        }
        return res;
      } catch (err) {
        throw annotateHttpFailure(err);
      }
    };
    try {
      return await withRetry(withBodyRecovery(params, attempt), {
        ...retryPolicy(totalSignal, `${label} Anthropic streaming response`, `${label}-initial-response`),
        onRetry: ({ attempt: retryNo, maxAttempts, lastErr, delayMs, delayReason }) => {
          emitProviderRetryStage(opts.onStageChange, { attempt: retryNo + 1, maxAttempts, lastErr, delayMs });
          const status = Number(lastErr?.httpStatus || lastErr?.status || lastErr?.response?.status || 0);
          if (status === 429) notifyCurrentAnthropicRateLimit(lastErr);
          const delayLabel = retryDelayLabel(delayMs, delayReason);
          process.stderr.write(
            `[${label}] retry attempt ${retryNo + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`
          );
        },
      });
    } catch (err) {
      // Whatever escapes withRetry failed before any stream existed and has
      // already spent the request-level budget: mark it so mid-stream
      // recovery never grants it a second, SSE-sized retry budget.
      if (err && typeof err === 'object' && !(err instanceof AnthropicFallbackTriggeredError)) {
        err.initialResponseError = true;
      }
      throw err;
    }
  };

  // `timeoutMs` is the replay's own lifetime, handed to the SDK as the request
  // timeout: without an explicit one the SDK refuses any stream:false body
  // whose max_tokens it estimates past 10 minutes before sending it.
  const requestNonStreamingMessage = (nonStreamingParams, signal, timeoutMs) =>
    withRetry(
      withBodyRecovery(nonStreamingParams, async ({ signal: attemptSignal }) => {
        noteRequestServiceTier(nonStreamingParams.speed);
        try {
          return await client.messages.create(nonStreamingParams, {
            ...requestOptions(attemptSignal),
            timeout: timeoutMs,
          });
        } catch (err) {
          throw annotateHttpFailure(err);
        }
      }),
      {
        ...retryPolicy(signal, `${label} Anthropic non-streaming fallback`, `${label}-nonstreaming-request`),
        onRetry: ({ attempt, maxAttempts, lastErr, delayMs }) =>
          emitProviderRetryStage(opts.onStageChange, { attempt: attempt + 1, maxAttempts, lastErr, delayMs }),
      }
    );

  return { requestStreamingResponse, requestNonStreamingMessage };
}
