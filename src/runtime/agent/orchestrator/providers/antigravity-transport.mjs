/**
 * antigravity-transport.mjs — one POST to the Antigravity unified gateway's
 * streamGenerateContent endpoint under the shared retry policy: the first-byte
 * window and the abort-reason mapping fetch would otherwise flatten into a
 * bare AbortError, the non-OK body → typed error projection (including the
 * account-verification URL Google hides in the error details), and the
 * per-attempt hand-off of the live stream to the turn collector.
 */
import { withRetry } from './retry-classifier.mjs';
import { createTimeoutSignal } from '../stall-policy.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { GEMINI_FIRST_BYTE_TIMEOUT_MS } from './gemini-stream.mjs';
import { _scrubTokens } from './antigravity-oauth-tokens.mjs';

export function antigravityError(res, text, endpoint) {
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const detail = payload?.error || null;
  const message = detail?.message || text?.slice(0, 300) || '';
  const err = new Error(`Antigravity ${res.status} (${endpoint}): ${_scrubTokens(message)}`);
  err.status = res.status;
  err.httpStatus = res.status;
  err.headers = res.headers;
  err.initialResponseError = true;
  if (detail) {
    err.error = detail;
    err.data = payload;
    if (detail.status) err.geminiStatus = detail.status;
  }
  // Account verification is terminal and actionable: surface the URL Google
  // returns instead of a raw API body the user cannot act on.
  // Google puts the link in the error details, not the message text.
  const validationDetail = Array.isArray(detail?.details)
    ? detail.details.find(
        (entry) => entry?.reason === 'VALIDATION_REQUIRED' && typeof entry.metadata?.validation_url === 'string'
      )
    : null;
  const validationUrl =
    validationDetail?.metadata.validation_url ||
    /https:\/\/\S*(?:accounts|console)\.google\.com\/\S+/.exec(message || '')?.[0] ||
    '';
  if (res.status === 403 && /VALIDATION_REQUIRED/i.test(text || '')) {
    err.message = `Antigravity requires account verification${validationUrl ? `: open ${validationUrl} , complete the check, then retry` : ''}`;
    err.validationUrl = validationUrl || undefined;
    err.unsafeToRetry = true;
  }
  return err;
}

/**
 * @param {object} deps
 * @param {Function} deps.fetchFn
 * @param {string} deps.endpoint  content endpoint base
 * @param {object} deps.headers  request headers (Authorization is replaced in place on refresh)
 * @param {string} deps.body  serialized request
 * @param {object} deps.opts  send options (stage heartbeat)
 * @param {AbortSignal|null} deps.signal  retry-loop signal (session pass-through)
 * @param {{ beginAttempt: Function, consume: Function }} deps.collector
 * @returns {() => Promise<object>} one retried request that resolves the final payload
 */
export function createAntigravityRequest({ fetchFn, endpoint, headers, body, opts, signal, collector }) {
  return () =>
    withRetry(
      async ({ signal: attemptSignal }) => {
        try {
          opts.onStageChange?.('requesting');
        } catch {
          /* heartbeat */
        }
        const firstByte = createTimeoutSignal(attemptSignal, GEMINI_FIRST_BYTE_TIMEOUT_MS, 'Antigravity first byte');
        let res;
        try {
          res = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers,
            body,
            signal: firstByte.signal,
            dispatcher: getLlmDispatcher(),
          });
        } catch (err) {
          // Fetch surfaces AbortError; rethrow the timer/parent
          // reason so same-host retry sees EPROVIDERTIMEOUT and
          // a caller cancel stays a cancel.
          if (firstByte.signal.aborted && firstByte.signal.reason instanceof Error) {
            throw firstByte.signal.reason;
          }
          throw err;
        } finally {
          firstByte.cleanup();
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw antigravityError(res, text, endpoint);
        }
        collector.beginAttempt();
        return collector.consume(res, attemptSignal);
      },
      {
        signal,
        onRetry: ({ attempt, lastErr: retryErr }) => {
          try {
            opts.onStageChange?.('requesting');
          } catch {
            /* heartbeat */
          }
          process.stderr.write(`[antigravity] retry ${attempt + 1} after ${retryErr?.message || 'transient error'}\n`);
        },
      }
    );
}
