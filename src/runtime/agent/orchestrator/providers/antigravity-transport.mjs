/**
 * antigravity-transport.mjs — one POST to the Antigravity unified gateway's
 * streamGenerateContent endpoint under the shared retry policy: the first-byte
 * window and the abort-reason mapping fetch would otherwise flatten into a
 * bare AbortError, the non-OK body → typed error projection (including the
 * account-verification URL Google hides in the error details), and the
 * per-attempt hand-off of the live stream to the turn collector.
 */
import {
  emitProviderRetryStage,
  markProviderRecoveryExhausted,
  sleepWithAbort,
  withRetry,
} from './retry-classifier.mjs';
import {
  ANTIGRAVITY_RETRY,
  ANTIGRAVITY_UNCLASSED_FIRST_BYTE,
  antigravity429WaitMs,
  isAntigravityCapacityError,
} from './antigravity-retry-policy.mjs';
import { createTimeoutSignal, firstByteWindowMs } from '../stall-policy.mjs';
import { MODEL_THINKING_STAGE } from '../../../shared/quiet-progress.mjs';
import { TIMEOUT_PHASE, isFirstByteTimeout } from '../../../shared/provider-timeout-phase.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { _scrubTokens } from './antigravity-oauth-tokens.mjs';
import { applyGeminiErrorContract } from './gemini-error-contract.mjs';
import { geminiInvalidStreamReask } from './gemini-retry-policy.mjs';
import { DETERMINISTIC_KINDS, providerErrorKind } from './provider-error-kind.mjs';

// Rate-limit reason: 503/529 are capacity by status; a
// typed ErrorInfo reason decides next; wording is the last resort for a 429.
const CAPACITY_MESSAGE_RE = /capacity|overloaded|resource exhausted|server (?:is )?(?:currently )?busy/i;
const RATE_LIMIT_MESSAGE_RE = /per minute|rate limit|too many requests/i;
const TYPED_REASONS = new Set(['quota_exhausted', 'rate_limit_exceeded', 'model_capacity_exhausted']);

function applyAntigravityRateLimitReason(err, status, message) {
  if (status === 503 || status === 529) {
    // A typed refusal of this request (bad argument, policy, auth, quota) is
    // not an overload whatever the status says.
    if (DETERMINISTIC_KINDS.has(providerErrorKind(err).kind)) return;
    err.code = 'model_capacity_exhausted';
    return;
  }
  if (status !== 429 || TYPED_REASONS.has(err.code)) return;
  if (CAPACITY_MESSAGE_RE.test(message)) err.code = 'model_capacity_exhausted';
  else if (RATE_LIMIT_MESSAGE_RE.test(message)) err.code = 'rate_limit_exceeded';
}

const CAPACITY_STATUSES = new Set([429, 503, 529]);

function isCapacityFailure(err) {
  return CAPACITY_STATUSES.has(Number(err?.status)) && isAntigravityCapacityError(err);
}

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
    const details = detail.details ?? detail.errorDetails;
    applyGeminiErrorContract(err, { details, googleStatus: detail.status, message });
  }
  // Capacity is overload of the shared model pool, not this account's quota.
  applyAntigravityRateLimitReason(err, res.status, message);
  // Account verification is terminal and actionable: surface the URL Google
  // returns instead of a raw API body the user cannot act on.
  // Google puts the link in the error details, not the message text.
  // Order: google.rpc.Help.links, metadata.validation_url, metadata.validation_link.
  const detailEntries = Array.isArray(detail?.details) ? detail.details : [];
  const helpUrl = detailEntries
    .flatMap((entry) => (Array.isArray(entry?.links) ? entry.links : []))
    .map((link) => link?.url)
    .find((url) => typeof url === 'string' && url.length > 0);
  const metadataUrl = (key) =>
    detailEntries.find(
      (entry) =>
        entry?.reason === 'VALIDATION_REQUIRED' && typeof entry.metadata?.[key] === 'string' && entry.metadata[key]
    )?.metadata[key];
  const validationUrl =
    helpUrl ||
    metadataUrl('validation_url') ||
    metadataUrl('validation_link') ||
    /https:\/\/\S*(?:accounts|console)\.google\.com\/\S+/.exec(message || '')?.[0] ||
    '';
  if (res.status === 403 && /VALIDATION_REQUIRED/i.test(text || '')) {
    err.message = `Antigravity requires account verification${validationUrl ? `: open ${validationUrl} , complete the check, then retry` : ''}`;
    err.validationUrl = validationUrl || undefined;
    err.unsafeToRetry = true;
    // This account needs verification; another account may still serve.
    err.code ||= 'validation_required';
    err.accountBlocked = true;
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
 * @param {{ beginAttempt: Function, consume: Function, failureUsage?: { model: string, normalize: Function } }} deps.collector
 * @param {{ timeoutMs: number, maxMs: number, retries: number|null }} [deps.firstByte]
 *   first-byte window per attempt (antigravityFirstBytePolicy)
 * @param {boolean} [deps.afterToolResult]  the request ends with a tool result (an empty STOP is then a valid answer)
 * @returns {() => Promise<object>} one retried request that resolves the final payload
 */
export function createAntigravityRequest({
  fetchFn,
  endpoint,
  headers,
  body,
  opts,
  signal,
  collector,
  sleepFn,
  firstByte = ANTIGRAVITY_UNCLASSED_FIRST_BYTE,
  afterToolResult = false,
}) {
  const log = (attempt, lastErr, delayMs) => {
    // A first-byte timeout runs on its own, shorter retry budget.
    const firstByteLimited = isFirstByteTimeout(lastErr) && firstByte.retries != null;
    emitProviderRetryStage(opts.onStageChange, {
      attempt: attempt + 1,
      maxAttempts: firstByteLimited
        ? Math.min(ANTIGRAVITY_RETRY.maxAttempts, firstByte.retries + 1)
        : ANTIGRAVITY_RETRY.maxAttempts,
      lastErr,
      delayMs,
      providerLabel: 'Antigravity',
    });
    process.stderr.write(`[antigravity] retry ${attempt + 1} after ${lastErr?.message || 'transient error'}\n`);
  };
  // Stamps what the attempt tells the user: how many attempts ran and, for a
  // first-byte timeout, how long the model was given in total. A timeout past
  // the first-byte retry budget ends the ladder here. A caller's cancellation
  // reason may be shared by other requests and is never stamped.
  const noteFailure = (err, { attemptSignal, windowMs, send }) => {
    if (!err || typeof err !== 'object' || attemptSignal?.aborted) return err;
    send.attempts += 1;
    err.attempts = send.attempts;
    if (!isFirstByteTimeout(err)) return err;
    send.firstByteTimeouts += 1;
    send.firstByteWaitedMs += windowMs;
    err.waitedMs = send.firstByteWaitedMs;
    if (firstByte.retries != null && send.firstByteTimeouts > firstByte.retries) {
      markProviderRecoveryExhausted(err, { owner: 'antigravity-first-byte', attempts: send.attempts, terminal: true });
    }
    return err;
  };
  const attemptOnce = (send) =>
    withRetry(
      async ({ signal: attemptSignal }) => {
        try {
          opts.onStageChange?.('requesting');
        } catch {
          /* heartbeat */
        }
        const windowMs = firstByteWindowMs(firstByte, send.firstByteTimeouts);
        try {
          const firstByteTimer = createTimeoutSignal(attemptSignal, windowMs, 'Antigravity first byte');
          let res;
          try {
            const response = fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
              method: 'POST',
              headers,
              body,
              signal: firstByteTimer.signal,
              dispatcher: getLlmDispatcher(),
            });
            // The request is on the wire and its headers are pending: the
            // gateway sends them only with the first chunk, so this wait is
            // the model's queueing and thinking time.
            try {
              opts.onStageChange?.(MODEL_THINKING_STAGE);
            } catch {
              /* heartbeat */
            }
            res = await response;
          } catch (err) {
            // Fetch surfaces AbortError; rethrow the timer/parent
            // reason so same-host retry sees EPROVIDERTIMEOUT and
            // a caller cancel stays a cancel.
            if (firstByteTimer.signal.aborted && firstByteTimer.signal.reason instanceof Error) {
              const reason = firstByteTimer.signal.reason;
              if (!attemptSignal?.aborted) reason.timeoutPhase = TIMEOUT_PHASE.HEADERS;
              throw reason;
            }
            throw err;
          } finally {
            firstByteTimer.cleanup();
          }
          // Headers arrived: the connection is live even while the model
          // has not produced its first chunk.
          try {
            opts.onStreamDelta?.('transport');
          } catch {
            // the stream-delta observer is advisory
          }
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            const failure = antigravityError(res, text, endpoint);
            // Capacity is paced by the local schedule below; the generic loop
            // would sleep whatever wait the server names.
            if (isCapacityFailure(failure)) markProviderRecoveryExhausted(failure, { owner: 'antigravity-capacity' });
            throw failure;
          }
          try {
            opts.onStageChange?.('streaming');
          } catch {
            /* heartbeat */
          }
          collector.beginAttempt();
          return await collector.consume(res, attemptSignal, { firstByteTimeoutMs: windowMs });
        } catch (err) {
          throw noteFailure(err, { attemptSignal, windowMs, send });
        }
      },
      {
        ...ANTIGRAVITY_RETRY,
        finalOnExhaust: true,
        signal,
        sleepFn,
        onRetry: ({ attempt, lastErr: retryErr, delayMs }) => log(attempt, retryErr, delayMs),
      }
    );
  // A 429 comes back from withRetry untouched (retry429:false) and is paced by
  // the retry schedule: capacity backs off on this host, an RPM hit
  // gets one quick retry, a spent quota surfaces.
  return async () => {
    const state = { capacityRetries: 0, quickRetried: false };
    const send = { attempts: 0, firstByteTimeouts: 0, firstByteWaitedMs: 0 };
    let streamAttempt = 0;
    for (let tried = 1; ; tried++) {
      try {
        const response = await attemptOnce(send);
        // A finished but unusable answer (empty STOP, malformed call) gets
        // the same bounded re-ask as the API-key transport. The dead
        // attempt's thinking is retracted when the next attempt begins.
        if (signal?.aborted) return response;
        const reask = geminiInvalidStreamReask(response, collector.leakGuard, {
          afterToolResult,
          streamAttempt,
          failureUsage: collector.failureUsage,
        });
        if (!reask) return response;
        log(streamAttempt + 1, reask.unusable, reask.waitMs);
        streamAttempt += 1;
        await sleepWithAbort(reask.waitMs, signal, sleepFn, 'Antigravity retry wait aborted');
      } catch (err) {
        const waitMs = antigravity429WaitMs(err, state);
        if (waitMs == null) {
          if (isCapacityFailure(err)) {
            markProviderRecoveryExhausted(err, { owner: 'antigravity-capacity', attempts: tried });
          }
          throw err;
        }
        log(tried, err, waitMs);
        await sleepWithAbort(waitMs, signal, sleepFn, 'Antigravity retry wait aborted');
      }
    }
  };
}
