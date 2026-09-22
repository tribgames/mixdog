/**
 * anthropic-api-recovery.mjs — non-streaming re-issue of an API-key Anthropic
 * turn whose stream died: the stream:false replay of the SAME request under
 * its own lifetime timeout, plus the shared gates in front of it (transport
 * recovery budget, exposed-output retraction handshake) from
 * anthropic-recovery-guards.mjs. Mirrors anthropic-oauth-recovery.mjs over
 * the SDK client instead of the OAuth POST.
 */
import { PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS, createTimeoutSignal } from '../stall-policy.mjs';
import { AnthropicFallbackTriggeredError, markProviderRecoveryExhausted } from './retry-classifier.mjs';
import { normalizeAnthropicNonStreamingResponse } from './lib/anthropic-request-utils.mjs';
import { createAnthropicRecoveryGuards } from './anthropic-recovery-guards.mjs';

/**
 * @param {object} deps
 * @param {string} deps.label  stderr log tag (provider instance name)
 * @param {object} deps.opts  send options (fallback timeout seam, stall budget)
 * @param {string} deps.useModel
 * @param {object} deps.params  streaming request body (copied with stream:false)
 * @param {AbortSignal|null} deps.totalSignal
 * @param {{ requestNonStreamingMessage: Function }} deps.transport
 * @param {(parseResult: object) => object} deps.buildTurnResult
 * @param {Function|null} deps.onStageChange
 * @param {Function|null} deps.onTextReset
 */
export function createAnthropicApiRecovery({
  label,
  opts,
  useModel,
  params,
  totalSignal,
  transport,
  buildTurnResult,
  onStageChange,
  onTextReset,
}) {
  // Core non-streaming re-issue shared by the exposed-text recovery
  // (onTextReset-gated) and the no-exposure stall fallback (trivially
  // safe — nothing was relayed or dispatched). Mirrors anthropic-oauth.
  const issueNonStreamingFallback = async (streamController, abortReason) => {
    try {
      streamController.abort?.(abortReason);
    } catch {}
    try {
      onStageChange?.('requesting', { transport: 'non-streaming-fallback' });
    } catch {}
    const nonStreamingParams = { ...params, stream: false };
    const timeoutMs =
      Number(opts._nonStreamingTimeoutMs) > 0
        ? Number(opts._nonStreamingTimeoutMs)
        : PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS;
    const lifetime = createTimeoutSignal(totalSignal, timeoutMs, `${label} Anthropic non-streaming fallback`);
    try {
      const message = await transport.requestNonStreamingMessage(nonStreamingParams, lifetime.signal);
      return buildTurnResult(normalizeAnthropicNonStreamingResponse(message, useModel));
    } catch (error) {
      if (error instanceof AnthropicFallbackTriggeredError || totalSignal?.aborted) throw error;
      throw markProviderRecoveryExhausted(error, {
        owner: `${label}-nonstreaming-fallback`,
      });
    } finally {
      lifetime.cleanup();
    }
  };

  const { requireTransportRecoveryBudget, recoverNonStreaming } = createAnthropicRecoveryGuards({
    label,
    budgetOwner: `${label}-transport-budget`,
    opts,
    onTextReset,
    issueNonStreamingFallback,
  });

  return { requireTransportRecoveryBudget, issueNonStreamingFallback, recoverNonStreaming };
}
