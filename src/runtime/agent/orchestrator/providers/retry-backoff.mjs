// Retry timing: attempt budgets, backoff schedules, jitter, stall-retry
// budgets and abortable sleeps.
import {
  PROVIDER_RETRY_BACKOFF_MS,
  PROVIDER_RETRY_JITTER_RATIO,
  PROVIDER_RETRY_MAX_ATTEMPTS,
} from '../stall-policy.mjs';

/** Anthropic request budget: 10 retries (11 attempts).
 * CLAUDE_CODE_MAX_RETRIES is intentionally read per request for reload/tests.
 * The upper bound prevents an accidental unbounded retry loop. */
export function anthropicMaxAttempts() {
  const raw = process.env.CLAUDE_CODE_MAX_RETRIES;
  const parsed = raw == null || raw === '' ? 10 : Number.parseInt(raw, 10);
  const retries = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 100) : 10;
  return retries + 1;
}

// Anthropic retry defaults: 500ms exponential backoff,
// capped at 32s, with positive-only jitter up to 25% of the base delay.
// The leading duplicate accounts for the sleep-before-attempt index:
// retry attempt 2 reads index 1.
export const ANTHROPIC_RETRY_BACKOFF_MS = Object.freeze([
  500, 500, 1000, 2000, 4000, 8000, 16000, 32000, 32000, 32000, 32000,
]);
export const ANTHROPIC_RETRY_JITTER_RATIO = 0.25;

// The Anthropic SDK client defaults API_TIMEOUT_MS to ten minutes.
// Read per request, like CLAUDE_CODE_MAX_RETRIES, so env reload/tests work.
export function anthropicRequestTimeoutMs() {
  const parsed = Number.parseInt(process.env.API_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}

export const ANTHROPIC_MAX_CONSECUTIVE_529 = 3;

export class AnthropicFallbackTriggeredError extends Error {
  constructor(originalModel, fallbackModel, cause) {
    super(`Anthropic model fallback triggered: ${originalModel} -> ${fallbackModel}`, { cause });
    this.name = 'AnthropicFallbackTriggeredError';
    this.originalModel = originalModel;
    this.fallbackModel = fallbackModel;
  }
}

// Default backoff schedule used by withRetry when caller does not override.
// Mirrors anthropic-oauth's 5-attempt curve (immediate + 1s/2s/4s/8s) so the
// total cap stays under 15s. Total upper bound = sum = 15s.
export const DEFAULT_BACKOFF_MS = PROVIDER_RETRY_BACKOFF_MS;
export const DEFAULT_MAX_ATTEMPTS = PROVIDER_RETRY_MAX_ATTEMPTS;

const MIDSTREAM_BACKOFF_MS = [250, 1000, 2000, 4000];

export function midstreamBackoffFor(retryNumber, schedule = MIDSTREAM_BACKOFF_MS) {
  const raw = schedule[Math.min(Math.max(retryNumber, 1), schedule.length) - 1];
  return jitterDelayMs(raw);
}

export function jitterDelayMs(ms, ratio = PROVIDER_RETRY_JITTER_RATIO, mode = 'symmetric') {
  const base = Number(ms) || 0;
  if (base <= 0) return 0;
  const r = Math.min(Math.max(Number(ratio) || 0, 0), 1);
  if (!r) return Math.round(base);
  const spread = base * r;
  const offset = mode === 'positive' ? Math.random() * spread : (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.round(base + offset));
}

// ── Stall-retry wall-clock budget (send-scoped) ──────────────────────────────
// Mid-stream 'stream_stalled' recoveries retry in place, which is right for a
// one-off blip but lets a chronically dying stream burn a whole task budget
// slowly (observed live: one send stretched 149s→298s→556s across stall
// retries before the agent deadline killed the task). A stalling stream is
// bounded instead of retried forever: a request is capped at ~300s wall
// clock (API_TIMEOUT_MS) and a stream dies after one 300s silent gap
// (stream idle timeout). This guard is the equivalent for our in-place
// recovery: the clock starts at the FIRST stall of a send, and stall-classified
// retries are allowed only inside that window; past it the stall error
// surfaces so loop-level transport retry issues a FRESH request. Healthy
// streams never consult the clock (no stall → no budget reads), so long
// thinking/output can never trip it.
export const STREAM_STALL_RETRY_BUDGET_MS = (() => {
  const v = Number(process.env.MIXDOG_STREAM_STALL_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 300_000;
})();

// One instance per provider send() call (NOT per attempt — the whole point is
// bounding the cross-attempt stall window). `now` is injectable for tests.
export function createStallRetryBudget(budgetMs = STREAM_STALL_RETRY_BUDGET_MS, now = Date.now) {
  let firstStallAt = 0;
  return {
    // Record a stall-classified retry candidate. Returns true while the
    // send's stall window still has budget; false once exhausted (the caller
    // surfaces the error instead of retrying in place).
    allowStallRetry() {
      const t = now();
      if (!firstStallAt) firstStallAt = t;
      return t - firstStallAt <= budgetMs;
    },
    get firstStallAt() {
      return firstStallAt;
    },
  };
}

// One recovery window must span every layer of the same logical send:
// provider-local stream recovery, streaming→non-streaming fallback, and the
// loop-level fresh-request replay. Callers pass the same opts object through
// those layers; keep the budget there instead of silently resetting it.
export function resolveStallRetryBudget(opts) {
  const existing = opts?._stallRetryBudget;
  if (existing && typeof existing.allowStallRetry === 'function') return existing;
  return resetStallRetryBudget(opts);
}

// A loop-level replay issues a BRAND NEW request, so it opens a new stall
// window instead of inheriting the spent one. Sharing it made the two 300s
// numbers cancel out: one full-length stall consumes the whole budget, and the
// replacement request is then aborted while its response is already arriving
// (observed live: regex-chess died on a healthy HTTP 200 replay with two hours
// of task budget left). Total exposure stays bounded by TRANSPORT_RETRY_MAX.
export function resetStallRetryBudget(opts) {
  const budget = createStallRetryBudget();
  if (opts && typeof opts === 'object') {
    try {
      opts._stallRetryBudget = budget;
    } catch {}
  }
  return budget;
}

const _defaultAbortSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

// D) Abort-aware sleep (single copy). Resolves after `ms`, or rejects with the
//    signal's reason (or `abortMessage`) the moment the signal aborts. `sleepFn`
//    is injectable for deterministic tests. Oversized deadlines are chunked so
//    Node never clamps setTimeout(>2^31-1) to approximately 1ms.
export async function sleepWithAbort(ms, signal, sleepFn = _defaultAbortSleep, abortMessage = 'sleep aborted') {
  let remaining = Math.max(0, Number(ms) || 0);
  const sleeper = sleepFn || _defaultAbortSleep;
  while (remaining > 0) {
    if (signal?.aborted) throw abortError(signal, abortMessage);
    const chunk = Math.min(remaining, MAX_SAFE_TIMEOUT_MS);
    await _sleepChunkWithAbort(chunk, signal, sleeper, abortMessage);
    remaining -= chunk;
  }
}

function abortError(signal, abortMessage) {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(abortMessage);
}

function detachAbortListener(signal, onAbort) {
  try {
    signal.removeEventListener('abort', onAbort);
  } catch {}
}

// A plain timer sleep that rejects as soon as `signal` aborts.
function timerSleepWithAbort(ms, signal, abortMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      detachAbortListener(signal, onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal, abortMessage));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// An injected sleep raced against `signal`: whichever settles first wins,
// and the loser can no longer settle the promise.
function customSleepWithAbort(ms, signal, sleepFn, abortMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      detachAbortListener(signal, onAbort);
      finish();
    };
    const onAbort = () => settle(() => reject(abortError(signal, abortMessage)));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => sleepFn(ms))
      .then(
        () => settle(resolve),
        (err) => settle(() => reject(err))
      );
  });
}

function _sleepChunkWithAbort(ms, signal, sleepFn, abortMessage) {
  if (!signal) return Promise.resolve().then(() => sleepFn(ms));
  if (sleepFn === _defaultAbortSleep) return timerSleepWithAbort(ms, signal, abortMessage);
  return customSleepWithAbort(ms, signal, sleepFn, abortMessage);
}
