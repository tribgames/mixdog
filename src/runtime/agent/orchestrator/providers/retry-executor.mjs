// withRetry: the shared attempt loop plus the stream-safety stamps and
// recovery-exhausted markers it relies on.
import { PROVIDER_RETRY_JITTER_RATIO, createTimeoutSignal } from '../stall-policy.mjs';
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import { recycleLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import {
  TERMINAL_EDGE_STATUSES,
  headerValue,
  boundedCauseChain,
  classifyError,
  isPermanentQuotaError,
  isStaleKeepAliveError,
  retryAfterMsFromError,
} from './retry-classification.mjs';
import {
  ANTHROPIC_MAX_CONSECUTIVE_529,
  AnthropicFallbackTriggeredError,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  jitterDelayMs,
  sleepWithAbort,
} from './retry-backoff.mjs';

// C) Stream-safety stamp latches. Mirrors openai-oauth-ws's _stampLiveText /
//    _stampTool: once text/tool has been marked, every subsequent throw path
//    re-applies the liveTextEmitted/emittedToolCall + unsafeToRetry markers so
//    no upstream gate can reissue the turn and concatenate attempts.
export function createStreamSafetyStamps() {
  let textLatched = false;
  let toolLatched = false;
  const stampText = (e) => {
    if (textLatched && e) {
      try {
        e.liveTextEmitted = true;
        e.unsafeToRetry = true;
      } catch {}
    }
    return e;
  };
  const stampTool = (e) => {
    if (toolLatched && e) {
      try {
        e.emittedToolCall = true;
        e.unsafeToRetry = true;
      } catch {}
    }
    return e;
  };
  return {
    markText() {
      textLatched = true;
    },
    markTool() {
      toolLatched = true;
    },
    stampText,
    stampTool,
    stampAll: (e) => stampTool(stampText(e)),
  };
}

/**
 * Run an async function with exponential-backoff retry on transient errors.
 *
 * Behavior:
 *   - Calls `fn()` up to `maxAttempts` times.
 *   - Between attempts, sleeps `backoffMs[attemptIndex]`.
 *   - Honors `signal` (AbortSignal): aborts current attempt's wait and re-
 *     throws caller's reason. Does NOT abort an in-flight call — that's
 *     the provider's own responsibility via its native abort plumbing.
 *   - Uses classifyError() to decide retry. 'transient' → retry,
 *     'auth' / 'permanent' / 'unknown' → throw immediately.
 *   - Classification is typed-only: an error with no status/errno/SDK type is
 *     'unknown' and is surfaced immediately instead of being replayed.
 *
 * Returns whatever `fn()` resolves to. Throws the last error if every retry
 * is exhausted, or the first error if it's classified non-transient.
 */
const providerRecoveryExhaustedErrors = new WeakSet();

export function markProviderRecoveryExhausted(error, { owner = 'provider', attempts = null } = {}) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
  providerRecoveryExhaustedErrors.add(error);
  try {
    error.providerRecoveryExhausted = true;
    if (owner) error.providerRecoveryOwner = String(owner);
    const count = Number(attempts);
    if (Number.isFinite(count) && count > 0) error.providerRecoveryAttempts = Math.floor(count);
  } catch {
    /* best-effort terminal ownership stamp */
  }
  return error;
}

export function isProviderRecoveryExhausted(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
  return boundedCauseChain(error).some(
    (candidate) => candidate?.providerRecoveryExhausted === true || providerRecoveryExhaustedErrors.has(candidate)
  );
}

function throwIfRetryAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('withRetry: aborted');
}

// A stale keep-alive socket, or (Grok) the first 5xx, rebuilds the HTTP
// client to escape a poisoned HTTP/2 keep-alive pool (CF 522/523/524
// included). 525/526 stay fatal.
function recycleDispatcherAfter(caught, status) {
  const poisoned =
    isStaleKeepAliveError(caught) || (status >= 500 && status < 600 && !TERMINAL_EDGE_STATUSES.has(status));
  if (!poisoned) return;
  try {
    recycleLlmDispatcher();
  } catch {
    /* never let pool recycle break retry */
  }
}

// Decides whether `caught` may be re-issued: returns the error to throw (the
// caught one, the exhausted-marked one on the last attempt, or the model
// fallback trigger) or null when the next attempt may run.
function retryVeto(caught, { opts, attempt, maxAttempts, state }) {
  const lastAttempt = attempt === maxAttempts - 1;
  const exhaustedError = () =>
    maxAttempts > 1
      ? markProviderRecoveryExhausted(caught, {
          owner: opts.recoveryOwner || 'withRetry',
          attempts: maxAttempts,
        })
      : caught;
  // A nested provider layer already spent its complete recovery budget.
  // Never multiply that budget by replaying it from an outer withRetry.
  if (isProviderRecoveryExhausted(caught)) return caught;
  const status = Number(caught?.httpStatus || caught?.status || caught?.response?.status || 0);
  const kind = classifyError(caught);
  // Hard replay boundary: a retry RE-ISSUES the request, so it is denied
  // once visible output was relayed or a tool call was dispatched. Whether
  // an eligible failure is actually retried remains the typed question
  // resolved by classifyError()/status below.
  if (readStreamOutcome(caught).replaySafe !== true) return caught;
  recycleDispatcherAfter(caught, status);
  // x-should-retry:false is an explicit server veto on retrying and is
  // honored as-is. Keep this ahead of status defaults, including the
  // request-local 429 path.
  const shouldRetryHeader = String(
    headerValue(caught?.headers || caught?.response?.headers || caught?.data?.responseHeaders, 'x-should-retry') || ''
  ).toLowerCase();
  if (shouldRetryHeader === 'false') return caught;
  // Anthropic's non-standard positive override outranks ordinary status
  // classification. Keep subscription OAuth 429 fail-fast ownership:
  // retry429:false is the Max/Pro gate and must not wait for that window.
  if (opts.provider === 'anthropic' && shouldRetryHeader === 'true' && !(status === 429 && opts.retry429 === false)) {
    return lastAttempt ? exhaustedError() : null;
  }
  // The optional model fallback fires on the third 529. This remains opt-in:
  // providers pass fallbackModel only when the caller set one. The hard
  // progress veto above must run first so fallback can never replay partial
  // thinking/tool output.
  if (status === 529 && opts.fallbackModel && opts.fallbackModel !== opts.model) {
    state.consecutive529Errors += 1;
    if (state.consecutive529Errors >= ANTHROPIC_MAX_CONSECUTIVE_529) {
      return new AnthropicFallbackTriggeredError(opts.model, opts.fallbackModel, caught);
    }
  }
  if (status === 429) {
    if (opts.retry429 === false) return caught;
    // A deterministic quota refusal cannot recover by replaying the same
    // request. An explicit server retry window outranks message-text quota
    // heuristics: RESOURCE_EXHAUSTED + Retry-After/RetryInfo is transient.
    if (retryAfterMsFromError(caught) == null && isPermanentQuotaError(caught)) return caught;
    // Retry only this request. Admission concurrency is fixed and is never
    // reduced by rate limits. Output/tool stamps above remain a hard replay
    // boundary.
    return lastAttempt ? exhaustedError() : null;
  }
  if (kind !== 'transient') return caught;
  // Last attempt failed transiently — propagate to caller.
  return lastAttempt ? exhaustedError() : null;
}

function retryOptions(opts) {
  return {
    maxAttempts: Number(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    backoffMs: Array.isArray(opts.backoffMs) ? opts.backoffMs : DEFAULT_BACKOFF_MS,
    signal: opts.signal || null,
    onRetry: typeof opts.onRetry === 'function' ? opts.onRetry : null,
    perAttemptTimeoutMs: Number(opts.perAttemptTimeoutMs || 0),
    perAttemptLabel: opts.perAttemptLabel || 'provider request',
    retryJitterRatio: Number(opts.retryJitterRatio ?? PROVIDER_RETRY_JITTER_RATIO),
    retryJitterMode: opts.retryJitterMode === 'positive' ? 'positive' : 'symmetric',
    sleepFn: typeof opts.sleepFn === 'function' ? opts.sleepFn : undefined,
  };
}

// The wait before `attempt`: the server's Retry-After when it sent one, else
// the jittered backoff step. Retry-After is a server-mandated minimum. Do
// not cap, shorten, or jitter it; cancellation remains active throughout
// the full wait.
function retryWaitMs(attempt, { nextDelayMs, nextDelayReason }, { backoffMs, retryJitterRatio, retryJitterMode }) {
  const rawWait = nextDelayMs ?? backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0;
  return nextDelayReason === 'retry-after'
    ? Math.max(0, rawWait)
    : jitterDelayMs(rawWait, retryJitterRatio, retryJitterMode);
}

export async function withRetry(fn, opts = {}) {
  const retry = retryOptions(opts);
  const { maxAttempts, signal, onRetry, perAttemptTimeoutMs, perAttemptLabel, sleepFn } = retry;

  let lastErr = null;
  let nextDelayMs = null;
  let nextDelayReason = null;
  const state = { consecutive529Errors: Math.max(0, Number(opts.initialConsecutive529Errors) || 0) };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    throwIfRetryAborted(signal);
    if (attempt > 0) {
      const wait = retryWaitMs(attempt, { nextDelayMs, nextDelayReason }, retry);
      onRetry?.({ attempt, maxAttempts, lastErr, delayMs: wait, delayReason: nextDelayReason });
      if (wait > 0) await sleepWithAbort(wait, signal, sleepFn, 'withRetry: sleep aborted');
      throwIfRetryAborted(signal);
      nextDelayMs = null;
      nextDelayReason = null;
    }
    const attemptTimeout =
      perAttemptTimeoutMs > 0
        ? createTimeoutSignal(signal, perAttemptTimeoutMs, `${perAttemptLabel} attempt ${attempt + 1}`)
        : null;
    const attemptSignal = attemptTimeout?.signal || signal;
    try {
      return await fn({ attempt, signal: attemptSignal });
    } catch (err) {
      let caught = err;
      if (!signal?.aborted && attemptSignal?.aborted && attemptSignal.reason instanceof Error) {
        caught = attemptSignal.reason;
      }
      throwIfRetryAborted(signal);
      lastErr = caught;
      const veto = retryVeto(caught, { opts, attempt, maxAttempts, state });
      if (veto) throw veto;
      // Respect Retry-After when present; otherwise the ordinary jittered
      // backoff applies on the next iteration.
      const retryAfterMs = retryAfterMsFromError(caught);
      if (retryAfterMs != null) {
        nextDelayMs = Math.max(0, retryAfterMs);
        nextDelayReason = 'retry-after';
      }
    } finally {
      attemptTimeout?.cleanup();
    }
  }
  // Defensive — loop above always returns or throws.
  throw lastErr || new Error('withRetry: exhausted with no error captured');
}
