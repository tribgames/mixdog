/**
 * retry-classifier.mjs — shared transient/permanent error classifier
 *
 * Single source of truth across every provider (openai-oauth-ws, openai-oauth,
 * anthropic-oauth, anthropic, gemini, openai-ws, openai-compat).
 *
 * Goal: when a provider returns a TYPED transient server-side condition we
 * should retry; when it returns a deterministic refusal (auth, permission,
 * quota) we should fail fast. Evidence is structural only — HTTP status,
 * Node errno, SDK error type, WS close code, or a typed field on a wire event.
 * Error MESSAGE TEXT is never parsed into a status/transience/auth verdict:
 * an untyped failure stays 'unknown' and is surfaced, not retried.
 *
 * Usage:
 *   import { classifyError, typedStatusFrom } from './retry-classifier.mjs'
 *   const kind = classifyError(err)               // 'auth' | 'permanent' | 'transient' | 'unknown'
 *   typedStatusFrom(event.response?.error, event) // structured status, or 0
 *
 * The implementation is split by responsibility; this module is the shared
 * entry point so providers keep one import path:
 *   retry-classification.mjs — typed status / transience / auth verdicts
 *   retry-backoff.mjs        — attempt budgets, backoff, jitter, stall budget, abortable sleep
 *   retry-midstream.mjs      — mid-stream (WS + SSE), transport-fallback and handshake verdicts
 *   retry-executor.mjs       — withRetry loop, stream-safety stamps, recovery-exhausted markers
 * Provider differences are passed as ARGUMENTS (policy objects), never
 * branched on a hardcoded provider name.
 */

export {
  canFallbackNonStreaming,
  classifyError,
  isConnectionFailure,
  isContextOverflowError,
  isCursorTransientTransportError,
  isExplicitUserAbortError,
  isNonTerminalStreamClose,
  isRetryableStreamErrorEvent,
  isRetryableWireErrorEvent,
  retryAfterMsFromError,
  shouldDropPreviousResponseId,
  typedErrorCode,
  typedStatusFrom,
} from './retry-classification.mjs';
export {
  ANTHROPIC_RETRY_BACKOFF_MS,
  ANTHROPIC_RETRY_JITTER_RATIO,
  AnthropicFallbackTriggeredError,
  MIDSTREAM_BACKOFF_MS,
  STREAM_STALL_RETRY_BUDGET_MS,
  anthropicMaxAttempts,
  anthropicRequestTimeoutMs,
  createStallRetryBudget,
  jitterDelayMs,
  midstreamBackoffFor,
  resetStallRetryBudget,
  resolveStallRetryBudget,
  sleepWithAbort,
} from './retry-backoff.mjs';
export {
  MIDSTREAM_RETRY_POLICY,
  classifyHandshakeError,
  classifyMidstreamError,
  shouldFallbackTransport,
} from './retry-midstream.mjs';
export {
  createStreamSafetyStamps,
  isProviderRecoveryExhausted,
  markProviderRecoveryExhausted,
  retryDelayLabel,
  withRetry,
} from './retry-executor.mjs';

export {
  readStreamOutcome,
  stampStreamOutcome,
  isReplaySafe,
  isReplayUnsafe,
  canPromoteToSuccess,
  hasObservedOutput,
  hasDispatchedToolCalls,
  STREAM_TRANSPORTS,
} from './lib/stream-outcome.mjs';
