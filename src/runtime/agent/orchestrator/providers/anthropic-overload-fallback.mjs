/**
 * anthropic-overload-fallback.mjs — one overload counter per logical send,
 * shared by the request loop (HTTP 529 before a stream exists) and the SSE
 * parser (`overloaded_error` event after one started). Both reach it through
 * the same error fields — `status: 529` / `code: 'overloaded_error'` — so a
 * mix of the two trips the configured fallback model after the same number of
 * consecutive overloads, instead of each path counting only its own.
 *
 * The request loop's counter is withRetry's `overloadState`; this tracker owns
 * that object, so the SSE path increments the very counter the loop reads.
 */
import { ANTHROPIC_MAX_CONSECUTIVE_529 } from './retry-backoff.mjs';
import { AnthropicFallbackTriggeredError } from './retry-classifier.mjs';

export const OVERLOADED_ERROR_CODE = 'overloaded_error';

/** Consecutive 529s end the request only for API-key (non-subscriber) first-party Opus. */
export function isTerminalOverloadModel(model) {
  return /^claude-opus-/.test(
    String(model || '')
      .trim()
      .toLowerCase()
  );
}

export function isAnthropicOverloadError(err) {
  const status = Number(err?.httpStatus || err?.status || err?.response?.status || 0);
  return status === 529 || String(err?.code || '').toLowerCase() === OVERLOADED_ERROR_CODE;
}

/**
 * @param {{ model: string, fallbackModel?: string|null, terminalAtLimit?: boolean }} deps  fallbackModel is
 *   already undefined when this send IS the fallback (no second hop).
 */
export function createAnthropicOverloadTracker({ model, fallbackModel, terminalAtLimit = false }) {
  const canFallback = Boolean(fallbackModel) && fallbackModel !== model;
  // Handed to every withRetry of the send as `overloadState`: the request
  // loop increments this same object on each 529.
  const state = { consecutive529Errors: 0 };
  return {
    state,
    // Repeated-overload stop, handed to withRetry as `stopAfterRepeated529`: with no
    // fallback model, API-key Opus stops after repeated 529s. A configured
    // fallback always wins (the executor checks it first).
    stopAfterRepeated529: terminalAtLimit && !canFallback,
    /**
     * An overload SSE error. Returns the fallback trigger to throw once the
     * consecutive limit is reached and a fallback model is configured.
     */
    noteStreamOverload(err) {
      state.consecutive529Errors += 1;
      if (state.consecutive529Errors < ANTHROPIC_MAX_CONSECUTIVE_529) return null;
      if (canFallback) return new AnthropicFallbackTriggeredError(model, fallbackModel, err);
      // No fallback model: API-key Opus stops here ("Repeated 529 Overloaded
      // errors") instead of spending the full budget.
      if (!terminalAtLimit) return null;
      err.repeated529 = true;
      return err;
    },
  };
}

/**
 * The catch around a whole Anthropic send. The fallback trigger can surface
 * from the request loop, a mid-stream overload, or the non-streaming
 * recovery; any other error is rethrown unchanged. For the trigger it logs,
 * announces the model switch, and returns the options of the single re-send
 * on `err.fallbackModel` (no second hop).
 */
export function takeAnthropicModelFallback(err, { tag, model, opts, onStageChange, displayModel = (id) => id }) {
  if (!(err instanceof AnthropicFallbackTriggeredError)) throw err;
  process.stderr.write(`[${tag}] ${err.message}\n`);
  announceAnthropicModelFallback(onStageChange, displayModel(model), displayModel(err.fallbackModel));
  return {
    ...opts,
    fallbackModel: undefined,
    _fallbackTriggered: true,
  };
}

/** Visible model-switch notice on the existing display-only stage channel. */
export function announceAnthropicModelFallback(onStageChange, fromLabel, toLabel) {
  if (typeof onStageChange !== 'function') return;
  try {
    onStageChange('reconnecting', {
      message: `${fromLabel} is overloaded — continuing on ${toLabel}`,
    });
  } catch {
    /* display-only */
  }
}
