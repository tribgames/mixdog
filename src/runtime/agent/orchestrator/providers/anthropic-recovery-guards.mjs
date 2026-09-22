/**
 * anthropic-recovery-guards.mjs — the two safety gates in front of an
 * Anthropic non-streaming re-issue, shared by both Anthropic transports:
 * the logical-send transport-recovery budget (one window for provider
 * fallback and loop replay together), and the retraction handshake that must
 * precede a replay once text or thinking has already been exposed.
 *
 * Neither gate touches the wire: the transport-specific re-issue arrives as
 * `issueNonStreamingFallback` (anthropic-api-recovery.mjs for the API-key
 * client, anthropic-oauth-recovery.mjs for the OAuth POST).
 */
import {
  markProviderRecoveryExhausted,
  resolveStallRetryBudget,
  STREAM_STALL_RETRY_BUDGET_MS,
} from './retry-classifier.mjs';

/**
 * @param {object} deps
 * @param {string} deps.label  stderr log tag (provider instance name)
 * @param {string} deps.budgetOwner  recovery owner recorded when the budget is spent
 * @param {object} deps.opts  send options (carry the shared stall-retry window)
 * @param {Function|null} deps.onTextReset  owner ack for retracting exposed output
 * @param {Function} deps.issueNonStreamingFallback  transport-specific re-issue
 */
export function createAnthropicRecoveryGuards({ label, budgetOwner, opts, onTextReset, issueNonStreamingFallback }) {
  // Shared logical-send window: provider fallback and loop replay consume
  // the same recovery budget.
  const stallRetryBudget = resolveStallRetryBudget(opts);
  const requireTransportRecoveryBudget = (error, controller) => {
    if (stallRetryBudget.allowStallRetry()) return;
    try {
      process.stderr.write(
        `[${label}] transport recovery budget exhausted (${STREAM_STALL_RETRY_BUDGET_MS}ms since first failure)\n`
      );
    } catch {}
    try {
      controller?.abort?.(error);
    } catch {}
    throw markProviderRecoveryExhausted(error, {
      owner: budgetOwner,
    });
  };

  // Exposed text AND exposed thinking are both retractable: the owner
  // truncates its live tail / collapses the thinking segment and acks,
  // after which the full request is repeated non-streaming. Only a
  // dispatched or partially streamed tool call is a hard replay
  // boundary (re-running would duplicate a side effect).
  const recoverNonStreaming = async (midState, streamingError, controller) => {
    const exposedChars = Number(midState?.emittedTextChars) || 0;
    const exposedReasoning = midState?.emittedThinking === true;
    if (
      !onTextReset ||
      (exposedChars <= 0 && !exposedReasoning) ||
      midState.emittedToolCall ||
      midState.partialToolCall
    ) {
      try {
        streamingError.liveTextEmitted = true;
        streamingError.unsafeToRetry = true;
      } catch {}
      throw streamingError;
    }
    let resetAccepted = false;
    try {
      resetAccepted =
        (await onTextReset({
          chars: exposedChars,
          reasoning: exposedReasoning,
          reason: 'anthropic-streaming-fallback',
        })) === true;
    } catch {}
    if (!resetAccepted) {
      try {
        streamingError.liveTextEmitted = true;
        streamingError.unsafeToRetry = true;
      } catch {}
      throw streamingError;
    }
    requireTransportRecoveryBudget(streamingError, controller);
    return issueNonStreamingFallback(controller, streamingError);
  };

  return { requireTransportRecoveryBudget, recoverNonStreaming };
}
