// Judgement of the initial response status before any byte of the stream was
// sampled: a 429 becomes a typed quota error and a transient status a
// retryable error; both drain the response and release its abort wiring so
// re-issuing the POST is safe.
import { fastModeDowngraded, noteFastModeCapacityError } from '../anthropic-fast-mode.mjs';
import { applyAnthropicErrorContract, retryAfterMsFromHeaders } from '../anthropic-error-contract.mjs';
import { headerValue } from '../retry-classification.mjs';
import { classifyError } from '../retry-classifier.mjs';

// Anthropic's exact official revoked-token 403 body; any other 403 is an
// ordinary permission/policy refusal and stays terminal.
const REVOKED_TOKEN_MARKER = 'OAuth token has been revoked';

/**
 * True when a rejected initial response is one a forced credential refresh can
 * fix: every 401, and only the exact revoked-token 403 signature. Shared by
 * the streaming request and the non-streaming fallback.
 */
export function isRefreshableAuthRejection(status, bodyText) {
  return status === 401 || (status === 403 && String(bodyText ?? '').includes(REVOKED_TOKEN_MARKER));
}

// A subscription-window refusal carries these unified quota headers. A 429
// without them is an entitlement/routing refusal or a capacity blip — the
// account's quota is not exhausted, so it must not be reported as one.
const QUOTA_HEADERS = [
  'anthropic-ratelimit-unified-representative-claim',
  'anthropic-ratelimit-unified-overage-status',
];

function hasQuotaHeaders(headers) {
  return QUOTA_HEADERS.some((name) => {
    const value = headerValue(headers, name);
    return value != null && value !== '';
  });
}

function formatRetryAfter(ms) {
  if (ms == null) return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 60_000 && n % 60_000 === 0) return `${Math.round(n / 60_000)}m`;
  if (n >= 1000) return `${Math.ceil(n / 1000)}s`;
  return `${Math.ceil(n)}ms`;
}

export function anthropicQuotaError(status, headers, bodyText = '') {
  const retryAfterMs = retryAfterMsFromHeaders(headers);
  const retryAfter = formatRetryAfter(retryAfterMs);
  const detail = bodyText ? `: ${String(bodyText).slice(0, 200)}` : '';
  const retry = retryAfter ? ` retryAfter=${retryAfter}` : '';
  const quota = hasQuotaHeaders(headers);
  const err = new Error(
    `Anthropic OAuth API ${status} ${quota ? 'quota/rate limit' : 'request rejected'}${retry}${detail}`
  );
  err.name = quota ? 'ProviderQuotaError' : 'ProviderRequestRejectedError';
  err.headers = headers;
  err.response = { status, headers };
  err.retryAfterMs = retryAfterMs;
  err.providerQuota = quota;
  err.quotaExceeded = quota;
  // This error is constructed only from the initial HTTP response, before
  // SSE parsing can expose text or a tool call. It is therefore safe for the
  // request-local withRetry loop. Mid-stream paths stamp unsafeToRetry when
  // output/tool exposure actually occurs.
  return applyAnthropicErrorContract(err, { status, headers, bodyText });
}

export async function judgeInitialStatus(result, requestBody, { provider, cleanupCancelHandler }) {
  const status = Number(result?.response?.status || 0);
  const transientStatus = classifyError({ httpStatus: status }) === 'transient';
  if (!transientStatus && status !== 429) return;
  const release = () => {
    cleanupCancelHandler(result.cancelHandler);
    try {
      result.controller?.abort?.();
    } catch {}
  };
  if (status === 429) {
    const quotaText = await result.response.text().catch(() => '');
    release();
    // Initial-response failure: nothing was sampled, so the typed retry
    // rules upstream own the decision. Subscription 429s never retry
    // in-loop; a drained or unavailable fast pool says nothing about
    // standard-speed capacity, so `speed` is dropped and the error is
    // flagged for a single standard-speed replay by the caller.
    const fastDowngraded = dropFastSpeed(requestBody, status, result?.response?.headers, quotaText);
    throw Object.assign(anthropicQuotaError(status, result?.response?.headers, provider.scrubTokens(quotaText)), {
      initialResponseError: true,
      fastDowngraded,
    });
  }
  let overloadText = '';
  try {
    overloadText = await result.response.text();
  } catch {}
  release();
  // A drained fast pool (529) is replayed at standard speed within the same
  // attempt, exactly like a fast-pool 429, instead of waiting out its window.
  const fastDowngraded = dropFastSpeed(requestBody, status, result?.response?.headers, overloadText);
  const err = new Error(`Anthropic OAuth API ${status}`);
  err.headers = result?.response?.headers;
  err.response = { status, headers: result?.response?.headers };
  err.initialResponseError = true;
  err.fastDowngraded = fastDowngraded;
  throw applyAnthropicErrorContract(err, {
    status,
    headers: result?.response?.headers,
    bodyText: provider.scrubTokens(overloadText),
  });
}

// Records a fast-pool capacity refusal; on an explicit downgrade/disable the
// request drops `speed` and the caller replays once at standard speed. Any
// other verdict ('ignored', 'retry-fast') leaves the request untouched.
function dropFastSpeed(requestBody, status, headers, text) {
  const decision = noteFastModeCapacityError(
    { httpStatus: status, headers, message: text },
    { fast: requestBody?.speed === 'fast' }
  );
  if (!fastModeDowngraded(decision)) return false;
  delete requestBody.speed;
  return true;
}
