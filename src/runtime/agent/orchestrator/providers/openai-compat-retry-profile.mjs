// Per-provider request retry profile for the OpenAI-compatible family. Each
// provider carries its own retry constants; the
// shared withRetry still owns classification, the exposure/replay veto,
// quota refusals, x-should-retry and Retry-After. Providers with no profile
// keep the shared defaults.
//
// `backoffMs[n]` is the base wait before retry n (index 0 is never read, so
// the first value is the duplicate the withRetry schedule expects).
//   statusRetryCaps — retries allowed for one status (for example a
//     429 stops after a single retry, whatever the overall budget).
//   terminalStatuses — statuses that are terminal although the
//     shared classifier would retry them.
//   retryOnlyStatuses — the complete retryable error set: any other 4xx/5xx
//     status surfaces.
//   maxRetryAfterMs — give up instead of waiting longer than this.
//   maxFailedAttemptMs — a 5xx that took longer than this is not replayed.
//   retryEmptyResponse — a completed turn with no text, tool call or
//     reasoning is re-asked inside the ladder (nothing was exposed); a number
//     bounds how many times per send, true leaves it to the ladder.
//   adviceWindow - outside exceptStatuses, Retry-After is clamped to maxMs
//     and jittered by jitterRatio (the advice of the excepted statuses stays raw).
//   recycleDispatcherOn5xx — a retried 5xx rebuilds the shared HTTP pool.
//   adviceAtLeastBackoff — the advice is a floor under the jittered backoff step.
//   firstByteRetries — a header or first-chunk timeout (`timeoutPhase`) is
//     retried at most this many times, each retry on a doubled window capped
//     at PROVIDER_MAX_BEFORE_WARN_MS; other transient errors keep the ladder.
// Every stop is provider-terminal: the profile's limits are final, so the
// agent loop never re-runs a stopped or exhausted request (see
// COMPAT_RETRY_POLICY).
import { markProviderRecoveryExhausted } from './retry-classifier.mjs';
import { retryAfterMsFromError } from './provider-error-kind.mjs';
import { STREAM_TRANSPORTS, stampStreamOutcome } from './lib/stream-outcome.mjs';
import { DEFAULT_BACKOFF_MS, DEFAULT_MAX_ATTEMPTS, jitterDelayMs } from './retry-backoff.mjs';
import { PROVIDER_MAX_BEFORE_WARN_MS, firstBytePolicyBudget, firstByteWindowMs } from '../stall-policy.mjs';
import { isFirstByteTimeout } from '../../../shared/provider-timeout-phase.mjs';

const statusOf = (err) => Number(err?.httpStatus || err?.status || err?.response?.status || 0);

/** Loop retry policy of every profiled provider: no recovery cycles on top of the profile. */
export const COMPAT_RETRY_POLICY = Object.freeze({ recoveryCycles: false });

/** xAI additionally treats an in-band invalid-request error as retryable. */
export const XAI_COMPAT_RETRY_POLICY = Object.freeze({ ...COMPAT_RETRY_POLICY, inBandInvalidRequestRetryable: true });

export const COMPAT_RETRY_PROFILES = Object.freeze({
  // A budget of 15 sends (the retry limit is reached when the next retry number
  // equals it, so 14 waits), 2s doubling to 30s, ±20% jitter, one retry for a
  // 429. Outside a 429, Retry-After is capped at 30s and jittered.
  xai: Object.freeze({
    maxAttempts: 15,
    backoffMs: [2000, 2000, 4000, 8000, 16000, 30000],
    retryJitterRatio: 0.2,
    statusRetryCaps: { 429: 1 },
    terminalStatuses: [408, 409, 425],
    retryEmptyResponse: true,
    adviceWindow: Object.freeze({ maxMs: 30_000, jitterRatio: 0.2, exceptStatuses: [429] }),
    recycleDispatcherOn5xx: true,
  }),
  // 5 retries, 500ms doubling to 10s, ±10% jitter;
  // a Retry-After beyond the 10s ceiling is not waited out.
  deepseek: Object.freeze({
    maxAttempts: 6,
    backoffMs: [500, 500, 1000, 2000, 4000, 8000],
    retryJitterRatio: 0.1,
    maxRetryAfterMs: 10_000,
    terminalStatuses: [408, 409, 425],
    retryEmptyResponse: true,
  }),
  // The HTTP transport layer governs one request: 6 sends, 500ms doubling, no
  // jitter, a Retry-After beyond 60s is not waited out; only 408, 429 and 5xx
  // are transient, every other 4xx is terminal. A benign empty completion is
  // re-asked at most twice.
  'muse-code-oauth': Object.freeze({
    maxAttempts: 6,
    backoffMs: [500, 500, 1000, 2000, 4000, 8000],
    retryJitterRatio: 0,
    terminalStatuses: [409, 425],
    maxRetryAfterMs: 60_000,
    retryEmptyResponse: 2,
  }),
  // server budget 8 retries (2s doubling to 30s,
  // ±10%), rate-limit budget 5 retries; 408, 409, 501 and 505 are terminal
  // (425 stays retryable); a Retry-After beyond 300s is not waited out. A
  // first-byte timeout gets one longer retry instead of the whole ladder.
  'mimo-oauth': Object.freeze({
    maxAttempts: 9,
    firstByteRetries: 1,
    backoffMs: [2000, 2000, 4000, 8000, 16000, 30000],
    retryJitterRatio: 0.1,
    statusRetryCaps: { 429: 5 },
    terminalStatuses: [408, 409, 501, 505],
    maxRetryAfterMs: 300_000,
  }),
  // 3 sends (400ms doubling to 5s) for exactly
  // 500/502/503/504/520/521/522 — every 4xx (429 included) and every other
  // 5xx is terminal; a failed attempt slower than 15s is returned.
  'command-code-oauth': Object.freeze({
    maxAttempts: 3,
    backoffMs: [400, 400, 800],
    retryOnlyStatuses: [500, 502, 503, 504, 520, 521, 522],
    maxFailedAttemptMs: 15_000,
    maxRetryAfterMs: 60_000,
    adviceAtLeastBackoff: true,
  }),
});

/** withRetry options (attempt budget, schedule, jitter) for a provider; {} for the shared defaults. */
export function compatRetryOptions(providerName) {
  const profile = COMPAT_RETRY_PROFILES[providerName];
  if (!profile) return {};
  return {
    maxAttempts: profile.maxAttempts,
    backoffMs: profile.backoffMs,
    retryJitterRatio: profile.retryJitterRatio,
    finalOnExhaust: true,
    ...(profile.adviceAtLeastBackoff ? { adviceAtLeastBackoff: true } : {}),
    ...(profile.recycleDispatcherOn5xx ? { recycleDispatcherOn5xx: true } : {}),
    ...(profile.retryJitterMode ? { retryJitterMode: profile.retryJitterMode } : {}),
  };
}

// The provider's first-byte policy (see firstByteWindowMs) on a base window:
// a profile's `firstByteRetries` caps first-byte retries on a doubling window;
// without it every attempt keeps the base window.
function compatFirstBytePolicy(providerName, baseMs) {
  return {
    timeoutMs: baseMs,
    maxMs: PROVIDER_MAX_BEFORE_WARN_MS,
    retries: COMPAT_RETRY_PROFILES[providerName]?.firstByteRetries ?? null,
  };
}

/** First-byte window of an attempt after `timeouts` first-byte timeouts. */
export function compatFirstByteWindowMs(providerName, baseMs, timeouts = 0) {
  return firstByteWindowMs(compatFirstBytePolicy(providerName, baseMs), timeouts);
}

/**
 * First-response budget of a chat profile that sets its own first-byte window
 * (`firstByteTimeoutMs`, applied to the headers and to the first chunk): the
 * worst case over the profile's whole ladder, where drops and 5xx use up
 * attempts and backoff alongside the first-byte timeouts the profile permits
 * (see firstBytePolicyBudget). Null for a profile on the shared window, which
 * the agent watchdog's default already covers.
 */
export function compatFirstResponseBudget(providerName, chatProfile) {
  const windowMs = Number(chatProfile?.firstByteTimeoutMs);
  if (!(windowMs > 0)) return null;
  const options = compatRetryOptions(providerName);
  return firstBytePolicyBudget(compatFirstBytePolicy(providerName, windowMs), {
    attempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
  });
}

function profileStops(profile, err, { attempt, elapsedMs }) {
  const status = statusOf(err);
  if (profile.terminalStatuses?.includes(status)) return true;
  const cap = profile.statusRetryCaps?.[status];
  if (cap !== undefined && attempt >= cap) return true;
  if (profile.retryOnlyStatuses && status >= 400 && status < 600 && !profile.retryOnlyStatuses.includes(status)) {
    return true;
  }
  if (profile.maxFailedAttemptMs && status >= 500 && status < 600 && elapsedMs > profile.maxFailedAttemptMs) {
    return true;
  }
  const advice = retryAfterMsFromError(err);
  return profile.maxRetryAfterMs !== undefined && advice != null && advice > profile.maxRetryAfterMs;
}

// Restamps the advice as a deadline (the highest-precedence source) so the
// shared loop waits the clamped, jittered value instead of the raw one.
function shapeAdvice(window, err) {
  if (!window || !err || typeof err !== 'object' || window.exceptStatuses?.includes(statusOf(err))) return;
  const advice = retryAfterMsFromError(err);
  if (advice == null) return;
  err.retryAfterAt = Date.now() + jitterDelayMs(Math.min(advice, window.maxMs), window.jitterRatio);
}

// A completed turn that produced nothing: no text, tool call or reasoning, and
// a normal finish (a Responses turn carries no stop reason when it completes).
function isEmptyNormalFinish(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.stopReason != null && result.stopReason !== 'stop') return false;
  return (
    !String(result.content ?? '').trim() &&
    !result.toolCalls?.length &&
    !result.reasoningContent &&
    !result.reasoningDetails?.length &&
    result.reasoningEmitted !== true
  );
}

function emptyResponseError(providerName) {
  const err = Object.assign(new Error(`${providerName} returned an empty response`), {
    code: 'server_error',
    emptyResponse: true,
  });
  // The turn finished: a failed ladder must not reopen it as a non-streaming request.
  stampStreamOutcome(err, { transport: STREAM_TRANSPORTS.SSE, terminalObserved: true });
  return err;
}

/**
 * Wrap one withRetry attempt with the provider's profile: a failure the
 * profile treats as final is marked recovery-exhausted and provider-terminal
 * (withRetry then surfaces it unchanged and no outer layer replays it), and a
 * profiled empty response is raised as a retryable failure.
 */
export function withCompatRetryProfile(providerName, attemptFn) {
  const profile = COMPAT_RETRY_PROFILES[providerName];
  if (!profile) return attemptFn;
  let emptyRetries = 0;
  let firstByteTimeouts = 0;
  return async (ctx) => {
    const startedAt = Date.now();
    try {
      const result = await attemptFn({ ...ctx, firstByteTimeouts });
      if (profile.retryEmptyResponse && isEmptyNormalFinish(result)) {
        const bound = profile.retryEmptyResponse === true ? Infinity : profile.retryEmptyResponse;
        if (emptyRetries < bound) {
          emptyRetries += 1;
          throw emptyResponseError(providerName);
        }
      }
      return result;
    } catch (err) {
      if (profile.firstByteRetries != null && isFirstByteTimeout(err) && !ctx?.signal?.aborted) {
        firstByteTimeouts += 1;
        if (firstByteTimeouts > profile.firstByteRetries) {
          throw markProviderRecoveryExhausted(err, { owner: `${providerName}-first-byte`, terminal: true });
        }
      }
      if (profileStops(profile, err, { attempt: ctx?.attempt | 0, elapsedMs: Date.now() - startedAt })) {
        throw markProviderRecoveryExhausted(err, { owner: `${providerName}-retry-profile`, terminal: true });
      }
      shapeAdvice(profile.adviceWindow, err);
      throw err;
    }
  };
}
