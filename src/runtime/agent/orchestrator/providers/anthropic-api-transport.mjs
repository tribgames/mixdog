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
  withRetry,
  retryAfterMsFromError,
  retryDelayLabel,
} from './retry-classifier.mjs';
import { PROVIDER_FIRST_BYTE_TIMEOUT_MS, createTimeoutSignal } from '../stall-policy.mjs';
import { noteFastModeCapacityError } from './anthropic-fast-mode.mjs';
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
 */
export function createAnthropicApiTransport({ client, label, opts, useModel, params, requestHeaders, totalSignal }) {
  const requestOptions = (attemptSignal) => ({
    signal: attemptSignal,
    ...(requestHeaders ? { headers: requestHeaders } : {}),
  });

  const requestStreamingResponse = () =>
    withRetry(
      async ({ signal: attemptSignal }) => {
        const res = await client.messages.create(params, requestOptions(attemptSignal)).asResponse();
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`Anthropic API ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status;
          err.httpStatus = res.status;
          err.initialResponseError = true;
          // Carry response headers so withRetry can honor a
          // short Retry-After and upstream can read quota hints.
          err.headers = res.headers;
          err.response = { status: res.status, headers: res.headers };
          // This is an initial-response 429, before SSE
          // output/tool exposure, so the request-local
          // withRetry loop may retry it with jitter.
          if (res.status === 429) {
            const retryAfterMs = retryAfterMsFromError({
              headers: res.headers,
              response: { headers: res.headers },
            });
            err.name = 'ProviderQuotaError';
            err.code = 'PROVIDER_QUOTA';
            err.retryAfterMs = retryAfterMs;
            err.providerQuota = true;
            err.quotaExceeded = true;
          }
          throw err;
        }
        if (!res.body) {
          throw new Error('Anthropic streaming response has no body');
        }
        return res;
      },
      {
        signal: totalSignal,
        maxAttempts: anthropicMaxAttempts(),
        backoffMs: ANTHROPIC_RETRY_BACKOFF_MS,
        retryJitterRatio: ANTHROPIC_RETRY_JITTER_RATIO,
        retryJitterMode: 'positive',
        perAttemptTimeoutMs: anthropicRequestTimeoutMs(),
        perAttemptLabel: `${label} Anthropic streaming response`,
        provider: 'anthropic',
        recoveryOwner: `${label}-initial-response`,
        model: useModel,
        fallbackModel: opts._fallbackTriggered ? undefined : opts.fallbackModel,
        onRetry: ({ attempt, lastErr, delayMs, delayReason }) => {
          // Long/unknown fast-pool window: replay at
          // standard speed rather than waiting it out.
          if (params?.speed === 'fast' && noteFastModeCapacityError(lastErr, { fast: true }) !== 'retry-fast') {
            delete params.speed;
          }
          const status = Number(lastErr?.httpStatus || lastErr?.status || lastErr?.response?.status || 0);
          if (status === 429) notifyCurrentAnthropicRateLimit(lastErr);
          const delayLabel = retryDelayLabel(delayMs, delayReason);
          process.stderr.write(
            `[${label}] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`
          );
        },
      }
    );

  const requestNonStreamingMessage = (nonStreamingParams, signal) =>
    withRetry(
      async ({ signal: attemptSignal }) => client.messages.create(nonStreamingParams, requestOptions(attemptSignal)),
      {
        signal,
        maxAttempts: anthropicMaxAttempts(),
        backoffMs: ANTHROPIC_RETRY_BACKOFF_MS,
        retryJitterRatio: ANTHROPIC_RETRY_JITTER_RATIO,
        retryJitterMode: 'positive',
        perAttemptTimeoutMs: anthropicRequestTimeoutMs(),
        perAttemptLabel: `${label} Anthropic non-streaming fallback`,
        provider: 'anthropic',
        recoveryOwner: `${label}-nonstreaming-request`,
        model: useModel,
        fallbackModel: opts._fallbackTriggered ? undefined : opts.fallbackModel,
      }
    );

  return { requestStreamingResponse, requestNonStreamingMessage };
}
