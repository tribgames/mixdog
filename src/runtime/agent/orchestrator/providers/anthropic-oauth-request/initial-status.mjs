// Judgement of the initial response status before any byte of the stream was
// sampled: a 429 becomes a typed quota error and a transient status a
// retryable error; both drain the response and release its abort wiring so
// re-issuing the POST is safe.
import { noteFastModeCapacityError } from '../anthropic-fast-mode.mjs';
import { classifyError, retryAfterMsFromError } from '../retry-classifier.mjs';

function formatRetryAfter(ms) {
  if (ms == null) return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 60_000 && n % 60_000 === 0) return `${Math.round(n / 60_000)}m`;
  if (n >= 1000) return `${Math.ceil(n / 1000)}s`;
  return `${Math.ceil(n)}ms`;
}

export function anthropicQuotaError(status, headers, bodyText = '') {
  const retryAfterMs = retryAfterMsFromError({ headers, response: { headers } });
  const retryAfter = formatRetryAfter(retryAfterMs);
  const detail = bodyText ? `: ${String(bodyText).slice(0, 200)}` : '';
  const retry = retryAfter ? ` retryAfter=${retryAfter}` : '';
  const err = new Error(`Anthropic OAuth API ${status} quota/rate limit${retry}${detail}`);
  err.name = 'ProviderQuotaError';
  err.code = 'PROVIDER_QUOTA';
  err.httpStatus = status;
  err.status = status;
  err.headers = headers;
  err.response = { status, headers };
  err.retryAfterMs = retryAfterMs;
  err.providerQuota = true;
  err.quotaExceeded = true;
  // This error is constructed only from the initial HTTP response, before
  // SSE parsing can expose text or a tool call. It is therefore safe for the
  // request-local withRetry loop. Mid-stream paths stamp unsafeToRetry when
  // output/tool exposure actually occurs.
  return err;
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
    // in-loop, so the cooldown is what keeps the NEXT turn off the drained
    // fast pool.
    noteFastModeCapacityError(
      { httpStatus: status, headers: result?.response?.headers },
      { fast: requestBody?.speed === 'fast' }
    );
    throw Object.assign(anthropicQuotaError(status, result?.response?.headers, provider.scrubTokens(quotaText)), {
      initialResponseError: true,
    });
  }
  const err = new Error(`Anthropic OAuth API ${status}`);
  err.httpStatus = status;
  err.status = status;
  err.headers = result?.response?.headers;
  err.response = { status, headers: result?.response?.headers };
  err.initialResponseError = true;
  try {
    await result.response.text();
  } catch {}
  release();
  throw err;
}
