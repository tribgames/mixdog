/**
 * openai-ws-send-attempts.mjs — retry policy for one logical WS send and
 * the state that crosses its attempts.
 *
 * One bounded Codex stream retry budget covers transient handshake and
 * pre-output stream failures. Every retry acquires a fresh connection. No
 * replay is permitted after live text or an emitted tool call. The two
 * failure resolvers either return true (the caller starts the next attempt)
 * or throw the error the caller must surface — already stamped with the
 * warmup, live-text and tool markers.
 *
 *   openai-ws-send-attempts/policy.mjs                — budget, backoff, classification seams
 *   openai-ws-send-attempts/attempt-context.mjs       — cross-attempt state, surface/backoff
 *   openai-ws-send-attempts/handshake-failure.mjs     — acquire/handshake failure verdict
 *   openai-ws-send-attempts/stream-failure-stamps.mjs — anchor carry-forward, release, latches
 *   openai-ws-send-attempts/stream-failure.mjs        — post-acquire failure verdict
 */
import { createAttemptContext } from './openai-ws-send-attempts/attempt-context.mjs';
import { resolveHandshakeFailure } from './openai-ws-send-attempts/handshake-failure.mjs';
import { resolveStreamFailure } from './openai-ws-send-attempts/stream-failure.mjs';

export {
  _backoffFor,
  _classifyHandshakeError,
  _classifyMidstreamError,
  _defaultSleep,
  _mustSurfaceCurrentAttempt,
  _sleepWithAbort,
  HANDSHAKE_MAX_ATTEMPTS,
  MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT,
} from './openai-ws-send-attempts/policy.mjs';

/**
 * @param {object} deps
 * @param {AbortSignal|null} deps.externalSignal
 * @param {(ms: number) => Promise<void>} deps.sleepFn
 * @param {object} deps.sendSpan
 * @param {(progress: { attempt: number, max: number, classifier: string|null }) => void} deps.emitReconnectProgress
 * @param {(err: Error) => Error} deps.stampWarmup
 * @param {{ markText(): void, markTool(): void, stampText(e: Error): Error, stampTool(e: Error): Error }} deps.safetyStamps
 * @param {Function|null} deps.handshakeErrorPolicy
 * @param {boolean} deps.retry429
 * @param {object} deps.stallRetryBudget
 * @param {object} deps.trace  { poolKey, traceProvider, useModel }
 * @param {object|null} deps.auth
 * @param {object} deps.body
 */
export function createWsSendAttempts(deps) {
  const ctx = createAttemptContext(deps);
  return {
    maxMidstreamRetries: ctx.maxMidstreamRetries,
    state: ctx.state,
    /** A handshake/acquire failure. True → the caller retries. */
    handshakeFailed: (err, info) => resolveHandshakeFailure(ctx, err, info),
    /** A failure after the socket was acquired (frame send, warmup or the
     *  stream itself). True → the caller retries on a fresh socket. */
    streamFailed: (err, info) => resolveStreamFailure(ctx, err, info),
    /** The loop cannot end without returning or throwing; this is the
     *  honest fallback for a budget that somehow ran out silently. */
    exhausted: () =>
      deps.stampWarmup(ctx.stampAll(ctx.state.firstAttemptError || new Error('sendViaWebSocket: unreachable'))),
  };
}
