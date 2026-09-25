/**
 * anthropic-oauth-request.mjs — one Anthropic OAuth /v1/messages POST and the
 * retry policy of its initial response: request-body gzip latch, abort wiring
 * for the session signal plus the per-attempt signal, quota (429) / transient
 * status handling, and the fallback-model hand-off withRetry drives.
 *
 * Streaming, mid-stream recovery and the non-streaming fallback live with the
 * provider (anthropic-oauth.mjs, anthropic-oauth-recovery.mjs); this module
 * only gets a response whose status the caller then judges.
 */
import { traceAgentFetch } from '../agent-trace.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { notifyCurrentAnthropicRateLimit } from './admission-scheduler.mjs';
import { noteFastModeCapacityError } from './anthropic-fast-mode.mjs';
import {
  ANTHROPIC_RETRY_BACKOFF_MS,
  ANTHROPIC_RETRY_JITTER_RATIO,
  anthropicMaxAttempts,
  anthropicRequestTimeoutMs,
  withRetry,
} from './retry-classifier.mjs';
import { postMessages } from './anthropic-oauth-request/gzip-post.mjs';
import { removeAbortListener, wireRequestAbort } from './anthropic-oauth-request/abort-wiring.mjs';
import { judgeInitialStatus } from './anthropic-oauth-request/initial-status.mjs';

export { ANTHROPIC_VERSION } from './anthropic-oauth-request/gzip-post.mjs';
export { anthropicQuotaError } from './anthropic-oauth-request/initial-status.mjs';

/**
 * @param {object} deps
 * @param {{ scrubTokens(text: string): string }} deps.provider
 * @param {object} deps.opts  send options (seams, fallback model)
 * @param {object} deps.body  the streaming request body
 * @param {string} deps.useModel
 * @param {string|null} deps.sessionId
 * @param {AbortSignal|null} deps.totalSignal  session-lifetime pass-through
 * @param {(requestBody: object) => string} deps.betaHeadersFor
 * @param {((stage: string) => void)|null} deps.onStageChange
 */
export function createAnthropicOAuthRequest({
  provider,
  opts,
  body,
  useModel,
  sessionId,
  totalSignal,
  betaHeadersFor,
  onStageChange,
}) {
  const requestTimeoutMs = anthropicRequestTimeoutMs();
  const cleanupCancelHandler = (handler) => removeAbortListener(totalSignal, handler);

  const doRequest = async (accessToken, requestSignal = null, requestBody = body) => {
    const controller = createAbortController();
    const fetchStartedAt = Date.now();
    const abort = wireRequestAbort({ controller, totalSignal, requestSignal });
    try {
      try {
        onStageChange?.('requesting');
      } catch {}
      // NOTE: do NOT sanitize here. body.messages was already
      // sanitized once inside toAnthropicMessages and then had cache
      // markers applied by applyAnthropicCacheMarkers. Re-sanitizing
      // after marking could drop/reorder a marked block and move the
      // provider-visible cache breakpoint off the cached one — the
      // exact COLD-turn bug this change fixes. Order is fixed:
      // build → sanitize (once) → mark → prepare image bytes → JSON.stringify.
      const response = await postMessages({
        accessToken,
        requestBody,
        betaHeaders: betaHeadersFor(requestBody),
        signal: controller.signal,
      });
      traceAgentFetch({
        sessionId,
        headersMs: Date.now() - fetchStartedAt,
        httpStatus: response.status,
        provider: 'anthropic-oauth',
        model: useModel,
        transport: 'sse',
      });
      abort.releaseAttempt();
      return { response, controller, cancelHandler: abort.cancelHandler };
    } catch (err) {
      abort.releaseAttempt();
      abort.releaseSession();
      throw abort.failure(err, requestTimeoutMs);
    }
  };
  // Test seam: injectable request factory for retry-path tests.
  const doRequestImpl = typeof opts._doRequestFn === 'function' ? opts._doRequestFn : doRequest;

  const requestWithRetry = async (accessToken, requestBody = body, retrySignal = totalSignal) =>
    withRetry(
      async ({ signal: attemptSignal }) => {
        const result = await doRequestImpl(accessToken, attemptSignal, requestBody);
        await judgeInitialStatus(result, requestBody, { provider, cleanupCancelHandler });
        return result;
      },
      {
        signal: retrySignal,
        maxAttempts: anthropicMaxAttempts(),
        backoffMs: ANTHROPIC_RETRY_BACKOFF_MS,
        retryJitterRatio: ANTHROPIC_RETRY_JITTER_RATIO,
        retryJitterMode: 'positive',
        // Max/Pro OAuth sessions use subscription quota windows. Claude
        // Code fails their 429s immediately rather than waiting through
        // the API-key/PAYG retry budget (which may carry hours-long
        // Retry-After values).
        retry429: false,
        perAttemptTimeoutMs: requestTimeoutMs,
        perAttemptLabel: 'Anthropic OAuth initial response',
        provider: 'anthropic',
        model: useModel,
        fallbackModel: opts._fallbackTriggered ? undefined : opts.fallbackModel,
        onRetry: ({ attempt, lastErr, delayMs, delayReason }) => {
          const status = Number(lastErr?.httpStatus || lastErr?.status || lastErr?.response?.status || 0) || null;
          if (status === 429) notifyCurrentAnthropicRateLimit(lastErr);
          // Fast capacity exhausted: drop `speed` so the replay runs at
          // standard speed instead of re-hitting the drained pool.
          if (requestBody?.speed === 'fast' && noteFastModeCapacityError(lastErr, { fast: true }) !== 'retry-fast') {
            delete requestBody.speed;
          }
          const reason = status || lastErr?.code || lastErr?.message || 'network error';
          const suffix = delayReason ? ` (${delayReason})` : '';
          try {
            process.stderr.write(
              `[anthropic-oauth] retry attempt ${attempt + 1}/${anthropicMaxAttempts()} after ${reason}, backoff ${delayMs}ms${suffix}\n`
            );
          } catch {}
        },
      }
    );

  return { requestWithRetry, cleanupCancelHandler };
}
