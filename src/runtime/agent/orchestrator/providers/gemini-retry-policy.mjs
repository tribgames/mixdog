/**
 * gemini-retry-policy.mjs — Gemini API retry constants and the two-phase
 * attempt loop (request backoff and stream retry):
 *
 *   connection phase  up to 10 attempts, 5s initial delay doubling to a 30s
 *                     cap, ±30% jitter (a server-advised wait replaces it);
 *   stream phase      a failure after the response opened (a stream that ends
 *                     with no finish reason is one: the transport raises it as
 *                     a truncated stream), or a response the model left
 *                     unusable (malformed / unexpected tool call, empty text),
 *                     re-issues the whole request up to 4 attempts total at
 *                     1s / 2s / 4s. A response that finished with no finish
 *                     reason is never judged here, and right after a tool
 *                     result an empty STOP answer is accepted as the model's
 *                     answer (an empty stream with no finish reason is still
 *                     unfinished). An empty answer that
 *                     survives all 4 attempts throws a typed, provider-terminal
 *                     invalid-stream error instead of returning nothing.
 *   long advice       a server wait over 300s ends recovery on both phases
 *                     (provider-terminal, no quota scope; the wait stays on
 *                     the error for display).
 *
 * Replay stays gated by the stream-outcome contract: a stream that exposed
 * text or dispatched a tool is never re-issued.
 */
import { noteAbandonedUsage } from '../../../shared/llm/usage-context.mjs';
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import { DETERMINISTIC_KINDS, providerErrorKind, typedCodeKind } from './provider-error-kind.mjs';
import { midstreamRetryDelayMs } from './retry-backoff.mjs';
import { geminiFinishReasonKind, geminiNormalizeFinishReason } from './gemini-error-contract.mjs';
import { classifyError, markProviderRecoveryExhausted, sleepWithAbort, withRetry } from './retry-classifier.mjs';

export const GEMINI_REQUEST_RETRY = Object.freeze({
  maxAttempts: 10,
  // Wait before retry N reads index N (the leading 5s covers index 0 and 1):
  // 5s, 10s, 20s, then the 30s cap.
  backoffMs: Object.freeze([5000, 5000, 10_000, 20_000, 30_000]),
  retryJitterRatio: 0.3,
  // Server advice gets positive-only jitter and is never below the step.
  retryAfterJitterRatio: 0.2,
  adviceAtLeastBackoff: true,
  retry499: true,
});

// A server wait longer than this is a lock-out, not a retry.
const GEMINI_MAX_RETRYABLE_ADVICE_MS = 300_000;

function hasLongAdvice(err) {
  const { kind, retryAfterMs } = providerErrorKind(err);
  return retryAfterMs > GEMINI_MAX_RETRYABLE_ADVICE_MS && !DETERMINISTIC_KINDS.has(kind);
}

/** True when the request's last turn is a tool result (functionResponse). */
export function geminiEndsWithFunctionResponse(contents) {
  const last = Array.isArray(contents) ? contents[contents.length - 1] : null;
  return Array.isArray(last?.parts) && last.parts.some((part) => part?.functionResponse);
}

export const GEMINI_MIDSTREAM_MAX_ATTEMPTS = 4;
const GEMINI_MIDSTREAM_INITIAL_DELAY_MS = 1000;

const midstreamStepMs = (streamAttempt) => GEMINI_MIDSTREAM_INITIAL_DELAY_MS * 2 ** streamAttempt;

/**
 * Wait before re-issuing after a stream-phase failure, or null when it must
 * surface. A server-advised wait on a retryable kind replaces the step.
 */
export function geminiMidstreamDelayMs(err, streamAttempt, signal = null) {
  if (streamAttempt + 1 >= GEMINI_MIDSTREAM_MAX_ATTEMPTS || signal?.aborted) return null;
  if (readStreamOutcome(err).replaySafe !== true) return null;
  const { kind } = providerErrorKind(err);
  if (hasLongAdvice(err)) return null;
  // A status-only 499 (client closed request) is retried, as on the request
  // ladder; a typed code on the 499 keeps it final.
  const closed499 =
    GEMINI_REQUEST_RETRY.retry499 && kind === 'invalid_request' && statusOf(err) === 499 && !typedCodeKind(err);
  if (DETERMINISTIC_KINDS.has(kind) && !closed499) return null;
  // 429 is request-local here: classifyError calls it permanent, but a rate
  // limit that is not a spent quota is retried like any other stream fault.
  if (!closed499 && classifyError(err) !== 'transient' && kind !== 'rate_limited') return null;
  return midstreamRetryDelayMs(err, midstreamStepMs(streamAttempt));
}

const statusOf = (err) => Number(err?.httpStatus || err?.status || 0);

/**
 * Invalid stream: the reason a finished response is unusable
 * ('MALFORMED_FUNCTION_CALL' | 'UNEXPECTED_TOOL_CALL' | 'MALFORMED_RESPONSE' |
 * 'NO_RESPONSE_TEXT'), or null. A response that carried a tool call, or whose
 * text was already relayed, is never invalid (and never replayed). Only a
 * STOP with no text is "no text"; every other documented finish (policy,
 * output limit, continuation, OTHER, ...) is owned by the incomplete handling.
 */
export function geminiInvalidStreamReason(response, textLeakGuard = null, { afterToolResult = false } = {}) {
  const candidate = response?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  if (parts.some((part) => part?.functionCall)) return null;
  if ((textLeakGuard?.getLeakedToolCalls?.() || []).length > 0) return null;
  if ((textLeakGuard?.getRelayedText?.() || '').length > 0) return null;
  const finish = geminiNormalizeFinishReason(candidate?.finishReason);
  const kind = geminiFinishReasonKind(finish);
  if (kind === 'invalid_tool_call') return finish;
  if (kind !== 'complete') return null;
  // Right after a tool result the model may legitimately answer with nothing.
  if (afterToolResult) return null;
  const text = parts
    .filter((part) => part?.thought !== true && typeof part?.text === 'string')
    .map((part) => part.text)
    .join('')
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, '')
    .trim();
  return text ? null : 'NO_RESPONSE_TEXT';
}

/**
 * Run `run` under the Gemini ladder. `run({ signal, connected })` performs one
 * open + consume and calls `connected()` once the response opened; it resolves
 * `{ response, textLeakGuard }`.
 */
export async function runGeminiStreamAttempts({
  run,
  signal,
  onRetry,
  sleepFn,
  afterToolResult = false,
  failureUsage = null,
}) {
  for (let streamAttempt = 0; ; streamAttempt++) {
    let connected = false;
    let result;
    try {
      result = await withRetry(
        async ({ signal: attemptSignal }) => {
          try {
            return await run({
              signal: attemptSignal,
              connected: () => {
                connected = true;
              },
            });
          } catch (err) {
            // A server wait over the limit ends recovery on either phase.
            if (hasLongAdvice(err)) {
              throw markProviderRecoveryExhausted(err, {
                owner: connected ? 'gemini-stream' : 'gemini-connection',
                terminal: true,
              });
            }
            // The connection ladder is spent on opening; a stream-phase
            // failure belongs to the stream ladder below.
            throw connected ? markProviderRecoveryExhausted(err, { owner: 'gemini-connection' }) : err;
          }
        },
        { ...GEMINI_REQUEST_RETRY, finalOnExhaust: true, signal, sleepFn, onRetry }
      );
    } catch (err) {
      const waitMs = connected ? geminiMidstreamDelayMs(err, streamAttempt, signal) : null;
      if (waitMs == null) throw err;
      onRetry?.({
        attempt: streamAttempt + 1,
        maxAttempts: GEMINI_MIDSTREAM_MAX_ATTEMPTS,
        lastErr: err,
        delayMs: waitMs,
      });
      await sleepWithAbort(waitMs, signal, sleepFn, 'Gemini stream retry wait aborted');
      continue;
    }
    if (signal?.aborted) return result;
    const reask = geminiInvalidStreamReask(result.response, result.textLeakGuard, {
      afterToolResult,
      streamAttempt,
      failureUsage,
    });
    if (!reask) return result;
    onRetry?.({
      attempt: streamAttempt + 1,
      maxAttempts: GEMINI_MIDSTREAM_MAX_ATTEMPTS,
      lastErr: reask.unusable,
      delayMs: reask.waitMs,
    });
    await sleepWithAbort(reask.waitMs, signal, sleepFn, 'Gemini stream retry wait aborted');
  }
}

/**
 * The bounded re-ask for a finished but unusable response (empty STOP,
 * malformed / unexpected tool call), shared by every Gemini-shaped transport:
 * `{ unusable, waitMs }` when the request should be re-issued after `waitMs`,
 * null when the response stands (usable, or a spent ladder on a malformed
 * call, which keeps its finish-reason error). A spent ladder on an empty
 * answer throws: it is a failure, not an answer.
 *
 * The discarded response was still billed. `failureUsage` ({ model,
 * normalize(usageMetadata) }) records it: a scheduled re-ask notes it as
 * abandoned usage; a spent ladder that throws carries it as
 * partialUsage/partialModel (the send's error accounting records it once).
 */
export function geminiInvalidStreamReask(
  response,
  textLeakGuard,
  { afterToolResult = false, streamAttempt = 0, failureUsage = null } = {}
) {
  const invalid = geminiInvalidStreamReason(response, textLeakGuard, { afterToolResult });
  if (!invalid) return null;
  const unusable = Object.assign(new Error(`Gemini stream unusable: ${invalid}`), {
    name: 'InvalidStreamError',
    code: invalid.toLowerCase(),
  });
  const usage = response?.usageMetadata && failureUsage ? failureUsage.normalize(response.usageMetadata) : null;
  if (streamAttempt + 1 >= GEMINI_MIDSTREAM_MAX_ATTEMPTS) {
    if (invalid !== 'NO_RESPONSE_TEXT') return null;
    if (usage) {
      unusable.partialUsage = usage;
      unusable.partialModel = failureUsage.model;
    }
    throw markProviderRecoveryExhausted(unusable, {
      owner: 'gemini-stream',
      attempts: GEMINI_MIDSTREAM_MAX_ATTEMPTS,
      terminal: true,
    });
  }
  if (usage) noteAbandonedUsage(usage, failureUsage.model);
  return { unusable, waitMs: midstreamStepMs(streamAttempt) };
}
