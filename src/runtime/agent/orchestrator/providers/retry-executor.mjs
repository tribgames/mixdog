// withRetry: the shared attempt loop plus the stream-safety stamps and
// recovery-exhausted markers it relies on.
import { PROVIDER_RETRY_JITTER_RATIO, createTimeoutSignal } from '../stall-policy.mjs';
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import { recycleLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { noteErrorUsage } from './lib/note-error-usage.mjs';
import { retryStatusLine, retryTimeoutText } from '../../../shared/err-text.mjs';
import {
  TERMINAL_EDGE_STATUSES,
  boundedCauseChain,
  classifyError,
  isStaleKeepAliveError,
  isToolInputCut,
  retryAfterMsFromError,
} from './retry-classification.mjs';
import {
  DETERMINISTIC_KINDS,
  QUOTA_KINDS,
  errorHeaderValue,
  providerErrorKind,
  retryReasonClass,
  safeRetryErrorCode,
} from './provider-error-kind.mjs';
import { adviceGatedRetry } from './retry-midstream.mjs';
import {
  ModelFallbackTriggeredError,
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

const providerRecoveryExhaustedErrors = new WeakSet();

// `terminal: true` records a provider VERDICT that recovery is over (a policy
// veto such as an unadvised advice-gated overload, or the repeated-overload
// stop), not merely a spent ladder: outer layers end recovery on it instead
// of opening another budget.
export function markProviderRecoveryExhausted(error, { owner = 'provider', attempts = null, terminal = false } = {}) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
  providerRecoveryExhaustedErrors.add(error);
  try {
    error.providerRecoveryExhausted = true;
    if (terminal) error.providerRecoveryTerminal = true;
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

/** True when a provider layer ruled that no further recovery may run (see markProviderRecoveryExhausted). */
export function isProviderRecoveryTerminal(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
  return boundedCauseChain(error).some((candidate) => candidate?.providerRecoveryTerminal === true);
}

function throwIfRetryAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('withRetry: aborted');
}

// Before a retry: a stale keep-alive socket rebuilds the HTTP client to escape
// a poisoned keep-alive pool. A caller whose upstream poisons its HTTP/2 pool
// on server faults (`recycleDispatcherOn5xx`) also rebuilds it on a retried
// 5xx (edge 522/523/524 included). Never runs for a failure that is not retried.
function recycleDispatcherAfter(caught, status, opts) {
  const poisoned =
    isStaleKeepAliveError(caught) || (opts.recycleDispatcherOn5xx === true && status >= 500 && status < 600);
  if (!poisoned) return;
  try {
    recycleLlmDispatcher();
  } catch {
    /* never let pool recycle break retry */
  }
}

// Opt-in: without a fallback model, the request loop stops after
// `overloadFallbackAfter` overloads instead of spending the whole
// attempt budget. A provider verdict: no outer layer re-opens recovery.
function repeated529Error(caught, opts, maxAttempts) {
  const error = new Error('Repeated 529 Overloaded errors', { cause: caught });
  error.name = 'Repeated529Error';
  error.repeated529 = true;
  error.status = Number(caught?.status || caught?.httpStatus || 529) || 529;
  error.httpStatus = error.status;
  error.code = 'overloaded_error';
  if (caught?.headers) error.headers = caught.headers;
  return markProviderRecoveryExhausted(error, {
    owner: opts.recoveryOwner || 'withRetry',
    attempts: maxAttempts,
    terminal: true,
  });
}

// Deterministic refusals of this request (auth, permission, policy, invalid
// request, context/size) end the loop before any status, header or overload
// rule may re-issue it. Quota kinds are judged separately below.
function deterministicRefusal(errorKind, kind, status, opts) {
  if (!DETERMINISTIC_KINDS.has(errorKind) || QUOTA_KINDS.has(errorKind)) return false;
  // Opt-in: a status-only 499 is retried (classifyError's retry499 verdict;
  // a typed code on the 499 keeps it final).
  return !(status === 499 && opts.retry499 === true && kind === 'transient');
}

// The overload counter (`overloadFallbackAfter`) counts every overload of the
// send; intervening non-overload failures do not reset it.
function isOverloadFailure(status, errorKind) {
  return status === 529 || errorKind === 'overloaded';
}

function exceedsAdviceCeiling(caught, opts) {
  const ceiling = Number(opts.maxRetryAfterMs);
  if (!(ceiling > 0)) return false;
  const advised = retryAfterMsFromError(caught);
  return advised != null && advised > ceiling;
}

// Decides whether `caught` may be re-issued: returns the error to throw (the
// caught one, the exhausted-marked one on the last attempt, or the model
// fallback trigger) or null when the next attempt may run — and only then
// rebuilds a poisoned HTTP pool for it.
function retryVeto(caught, context) {
  const verdict = retryVerdict(caught, context);
  if (verdict === null) {
    const status = Number(caught?.httpStatus || caught?.status || caught?.response?.status || 0);
    recycleDispatcherAfter(caught, status, context.opts);
  }
  return verdict;
}

function retryVerdict(caught, { opts, attempt, maxAttempts, state }) {
  const lastAttempt = attempt === maxAttempts - 1;
  // `finalOnExhaust`: the caller's ladder is the whole recovery, so a spent
  // ladder is a provider-terminal verdict no outer layer re-opens.
  const exhaustedError = () =>
    maxAttempts > 1 || opts.finalOnExhaust === true
      ? markProviderRecoveryExhausted(caught, {
          owner: opts.recoveryOwner || 'withRetry',
          attempts: maxAttempts,
          terminal: opts.finalOnExhaust === true,
        })
      : caught;
  // A nested provider layer already spent its complete recovery budget.
  // Never multiply that budget by replaying it from an outer withRetry.
  if (isProviderRecoveryExhausted(caught)) return caught;
  const status = Number(caught?.httpStatus || caught?.status || caught?.response?.status || 0);
  const kind = classifyError(caught, { retry499: opts.retry499 === true });
  const errorKind = providerErrorKind(caught).kind;
  // Hard replay boundary: a retry RE-ISSUES the request, so it is denied
  // once visible output was relayed or a tool call was dispatched. Whether
  // an eligible failure is actually retried remains the typed question
  // resolved by classifyError()/status below.
  if (readStreamOutcome(caught).replaySafe !== true) return caught;
  // A cut mid tool-argument stream is replayed by the agent loop with a
  // split-call notice; re-issuing the identical request here would tend to be
  // cut at the same place again.
  if (isToolInputCut(caught)) return caught;
  const overload = isOverloadFailure(status, errorKind);
  // Deterministic refusals first: no status, header (x-should-retry:true
  // included) or overload rule below may re-issue them.
  if (deterministicRefusal(errorKind, kind, status, opts)) return caught;
  // An origin-TLS edge failure (525/526) is final whatever header, advice or
  // overload code accompanies it.
  if (TERMINAL_EDGE_STATUSES.has(status)) return caught;
  // An explicit quota / plan / billing refusal cannot recover by replaying
  // the same request, whatever Retry-After the server attached. A 429 whose
  // only quota evidence is header-derived (providerQuota / quotaExceeded) is
  // still retried for non-subscriber callers (Enterprise/PAYG
  // 429s); a typed quota/billing code never is.
  if (QUOTA_KINDS.has(errorKind)) {
    const typedQuota = QUOTA_KINDS.has(providerErrorKind(caught, { quotaFlags: false }).kind);
    if (typedQuota || opts.retry429 === false || status !== 429) return caught;
  }
  // Opt-in `maxRetryAfterMs`: a server wait longer than the caller will sit
  // through is a lock-out, not a retry. It surfaces now (with its advice for
  // the notice and the account pool) instead of parking the send for it.
  if (exceedsAdviceCeiling(caught, opts)) {
    return markProviderRecoveryExhausted(caught, {
      owner: opts.recoveryOwner || 'withRetry',
      attempts: attempt + 1,
      terminal: true,
    });
  }
  // Background calls (titles and the like) never retry an overload: during a
  // capacity cascade every retry multiplies gateway load, and nobody is
  // waiting on the result.
  if (status === 529 && opts.retry529 === false) return caught;
  // A caller may opt into advice-gated overload / generic-429 retries. The
  // denial is the provider's verdict: outer recovery layers honor it.
  if (adviceGatedRetry(caught, opts) === false) {
    return markProviderRecoveryExhausted(caught, {
      owner: opts.recoveryOwner || 'withRetry',
      attempts: attempt + 1,
      terminal: true,
    });
  }
  // Overload first: counted and retried ahead of the x-should-retry veto.
  // The optional model fallback fires after `overloadFallbackAfter`
  // overloads in the send (opt-in: providers pass fallbackModel only when
  // the caller set one); without one, `stopAfterRepeated529` ends the loop
  // there instead. The hard progress veto above runs first so neither can
  // replay partial thinking/tool output. `overloadState` shares the count
  // across a send.
  if (overload) {
    // Subscriber 429 fail-fast ownership also covers an overload-coded 429.
    if (status === 429 && opts.retry429 === false) return caught;
    state.consecutive529Errors += 1;
    const limit = Number(opts.overloadFallbackAfter);
    if (Number.isFinite(limit) && limit > 0 && state.consecutive529Errors >= limit) {
      if (opts.fallbackModel && opts.fallbackModel !== opts.model) {
        return new ModelFallbackTriggeredError(opts.model, opts.fallbackModel, caught);
      }
      if (opts.stopAfterRepeated529 === true) return repeated529Error(caught, opts, maxAttempts);
    }
    return lastAttempt ? exhaustedError() : null;
  }
  // x-should-retry:false is an explicit server veto on retrying and is
  // honored as-is, ahead of status defaults including the 429 path.
  const shouldRetryHeader = String(errorHeaderValue(caught, 'x-should-retry') || '').toLowerCase();
  if (shouldRetryHeader === 'false') return caught;
  // A transport that opts in (honorShouldRetryTrue) lets the non-standard
  // positive override outrank ordinary status classification — except for
  // subscribers (retry429:false), whose fail-fast ownership holds for every status.
  if (opts.honorShouldRetryTrue === true && shouldRetryHeader === 'true' && opts.retry429 !== false) {
    return lastAttempt ? exhaustedError() : null;
  }
  if (status === 429) {
    if (opts.retry429 === false) return caught;
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
    retryJitterMode: ['positive', 'negative'].includes(opts.retryJitterMode) ? opts.retryJitterMode : 'symmetric',
    sleepFn: typeof opts.sleepFn === 'function' ? opts.sleepFn : undefined,
    // Opt-in: positive jitter on server advice, and advice as a
    // floor under — never a replacement for — the current backoff step.
    retryAfterJitterRatio: Math.max(0, Number(opts.retryAfterJitterRatio) || 0),
    adviceAtLeastBackoff: opts.adviceAtLeastBackoff === true,
  };
}

// The wait before `attempt`: the server's Retry-After when it sent one, else
// the jittered backoff step. Retry-After is a server-mandated minimum. Do
// not cap, shorten, or jitter it; cancellation remains active throughout
// the full wait.
function retryWaitMs(
  attempt,
  { nextDelayMs, nextDelayReason },
  { backoffMs, retryJitterRatio, retryJitterMode, retryAfterJitterRatio = 0, adviceAtLeastBackoff = false }
) {
  const step = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0;
  if (nextDelayReason !== 'retry-after') return jitterDelayMs(nextDelayMs ?? step, retryJitterRatio, retryJitterMode);
  let wait = Math.max(0, nextDelayMs ?? 0);
  if (adviceAtLeastBackoff) wait = Math.max(wait, jitterDelayMs(step, retryJitterRatio, retryJitterMode));
  // Positive-only jitter never shortens the advice.
  return retryAfterJitterRatio > 0 ? jitterDelayMs(wait, retryAfterJitterRatio, 'positive') : wait;
}

/** Fixed status phrases for a caller-classified retry reason. */
const RETRY_REASON_TEXT = Object.freeze({
  rate_limited: 'Rate limited by the provider',
  overloaded: 'Provider overloaded',
  server_error: 'Provider server error',
  auth: 'Provider rejected the sign-in',
  other: 'Connection interrupted',
});

// Timeout classes read our own typed timeout stamps (retryTimeoutText), so
// their phrases carry the wait window.
const TIMEOUT_REASON_CLASSES = new Set(['first_response_timeout', 'stalled']);

/**
 * Display-only 'reconnecting' stage for one retry wait, so it reads as a
 * reconnect instead of a silent spinner. `attempt` is the attempt about to run
 * (1-based) of `maxAttempts`. `retryAt` and `reason` let a surface count the
 * wait down live instead of freezing on the first "in 15s".
 */
export function emitProviderRetryStage(
  onStageChange,
  { attempt, maxAttempts, lastErr, delayMs, classifier = null, extra = null, reasonClass = null, providerLabel = null }
) {
  if (typeof onStageChange !== 'function') return;
  try {
    // The reason is a fixed phrase for a class (the caller's, else derived from
    // the error's typed status/code), never the error's own text; an
    // unrecognized class reads as `other`.
    const cls = reasonClass == null ? retryReasonClass(lastErr) : reasonClass;
    const fixedClass = Object.hasOwn(RETRY_REASON_TEXT, cls) || TIMEOUT_REASON_CLASSES.has(cls) ? cls : 'other';
    const reason = TIMEOUT_REASON_CLASSES.has(fixedClass)
      ? retryTimeoutText(lastErr, fixedClass, providerLabel)
      : RETRY_REASON_TEXT[fixedClass];
    const waitMs = Math.max(0, Number(delayMs) || 0);
    onStageChange('reconnecting', {
      ...extra,
      reasonClass: fixedClass,
      attempt,
      max: maxAttempts,
      waitMs,
      retryAt: Date.now() + waitMs,
      reason,
      classifier: classifier || lastErr?.retryClassifier || safeRetryErrorCode(lastErr),
      message: retryStatusLine({ reason, attempt, maxAttempts, delayMs: waitMs }),
    });
  } catch {
    /* display-only */
  }
}

/** The `, delay 1200ms (reason)` suffix of a retry log line; '' without a finite delay. */
export function retryDelayLabel(delayMs, delayReason) {
  if (!Number.isFinite(Number(delayMs))) return '';
  const note = delayReason ? ` (${delayReason})` : '';
  return `, delay ${delayMs}ms${note}`;
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
export async function withRetry(fn, opts = {}) {
  const retry = retryOptions(opts);
  const { maxAttempts, signal, onRetry, perAttemptTimeoutMs, perAttemptLabel, sleepFn } = retry;

  let lastErr = null;
  let nextDelayMs = null;
  let nextDelayReason = null;
  // `opts.overloadState` ({ consecutive529Errors }) lets one logical send share
  // its overload count across every withRetry it runs (streaming, recovery
  // cycles, non-streaming fallback), so the configured fallback still fires.
  const shared = opts.overloadState && typeof opts.overloadState === 'object' ? opts.overloadState : null;
  const state = shared || {};
  if (!Number.isFinite(state.consecutive529Errors)) {
    state.consecutive529Errors = Math.max(0, Number(opts.initialConsecutive529Errors) || 0);
  }
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
      noteErrorUsage(caught);
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
