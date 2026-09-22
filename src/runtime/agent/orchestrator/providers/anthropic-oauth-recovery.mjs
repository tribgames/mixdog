/**
 * anthropic-oauth-recovery.mjs — non-streaming re-issue of an Anthropic OAuth
 * turn whose stream died: the shared transport-recovery budget, the
 * stream:false replay of the SAME request, and the exposed-text/thinking
 * retraction handshake (onTextReset) that must precede that replay.
 */
import { PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS, createTimeoutSignal } from '../stall-policy.mjs';
import { AnthropicFallbackTriggeredError, markProviderRecoveryExhausted } from './retry-classifier.mjs';
import { cloneAnthropicEffortBody } from './effort-configuration.mjs';
import { normalizeAnthropicNonStreamingResponse } from './lib/anthropic-request-utils.mjs';
import { createAnthropicRecoveryGuards } from './anthropic-recovery-guards.mjs';

/**
 * @param {object} deps
 * @param {{ ensureAuth(o: object): Promise<object>, scrubTokens(t: string): string }} deps.provider
 * @param {object} deps.opts
 * @param {object} deps.body  streaming request body (cloned with stream:false)
 * @param {string} deps.useModel
 * @param {{ creds: object }} deps.auth  shared credential holder (refreshed on 401)
 * @param {AbortSignal|null} deps.totalSignal
 * @param {Function} deps.requestWithRetry
 * @param {Function} deps.cleanupCancelHandler
 * @param {Function|null} deps.onStageChange
 * @param {Function|null} deps.onTextReset
 */
export function createAnthropicOAuthRecovery({
  provider,
  opts,
  body,
  useModel,
  auth,
  totalSignal,
  requestWithRetry,
  cleanupCancelHandler,
  onStageChange,
  onTextReset,
}) {
  // Core non-streaming re-issue: abort the dead stream and repeat the
  // SAME request with stream:false. Shared by the exposed-text recovery
  // (which must first get the owner's onTextReset acknowledgement) and
  // the no-exposure stall fallback (trivially safe — nothing was
  // relayed or dispatched, so there is nothing to withdraw or replay).
  const issueNonStreamingFallback = async (controller, abortReason) => {
    try {
      controller?.abort?.(abortReason);
    } catch {}
    try {
      onStageChange?.('requesting', { transport: 'non-streaming-fallback' });
    } catch {}
    const timeoutMs =
      Number(opts._nonStreamingTimeoutMs) > 0
        ? Number(opts._nonStreamingTimeoutMs)
        : PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS;
    const lifetime = createTimeoutSignal(totalSignal, timeoutMs, 'Anthropic OAuth non-streaming fallback');
    let fallback = null;
    let lifetimeAbortHandler = null;
    const releaseFallback = (reason) => {
      if (lifetimeAbortHandler) {
        try {
          lifetime.signal.removeEventListener('abort', lifetimeAbortHandler);
        } catch {}
        lifetimeAbortHandler = null;
      }
      cleanupCancelHandler(fallback?.cancelHandler);
      try {
        fallback?.controller?.abort?.(reason);
      } catch {}
      fallback = null;
    };
    const requestFallback = async (accessToken) => {
      const result = await requestWithRetry(
        accessToken,
        cloneAnthropicEffortBody(body, { stream: false }),
        lifetime.signal
      );
      fallback = result;
      lifetimeAbortHandler = () => {
        try {
          result.controller?.abort?.(lifetime.signal.reason);
        } catch {}
      };
      if (lifetime.signal.aborted) {
        lifetimeAbortHandler();
        const reason = lifetime.signal.reason;
        throw reason instanceof Error ? reason : new Error('Anthropic OAuth non-streaming fallback aborted');
      }
      lifetime.signal.addEventListener('abort', lifetimeAbortHandler, { once: true });
      return result;
    };
    try {
      fallback = await requestFallback(auth.creds.accessToken);
      if (fallback.response.status === 401) {
        releaseFallback('Anthropic OAuth non-streaming fallback refreshing auth');
        auth.creds = await provider.ensureAuth({ forceRefresh: true, reason: '401' });
        fallback = await requestFallback(auth.creds.accessToken);
      }
      if (!fallback.response.ok) {
        const text = await fallback.response.text().catch(() => '');
        const fallbackError = new Error(
          `Anthropic OAuth API ${fallback.response.status}: ${provider.scrubTokens(text).slice(0, 200)}`
        );
        fallbackError.status = fallback.response.status;
        fallbackError.httpStatus = fallback.response.status;
        throw fallbackError;
      }
      const message = await fallback.response.json();
      return normalizeAnthropicNonStreamingResponse(message, useModel);
    } catch (err) {
      const failure = lifetime.signal.aborted && lifetime.signal.reason instanceof Error ? lifetime.signal.reason : err;
      if (failure instanceof AnthropicFallbackTriggeredError || totalSignal?.aborted) throw failure;
      throw markProviderRecoveryExhausted(failure, {
        owner: 'anthropic-oauth-nonstreaming-fallback',
      });
    } finally {
      releaseFallback('Anthropic non-streaming fallback complete');
      lifetime.cleanup();
    }
  };

  // Transport-recovery budget + the exposed-output retraction handshake are
  // transport-independent; both Anthropic providers share them.
  const { requireTransportRecoveryBudget, recoverNonStreaming } = createAnthropicRecoveryGuards({
    label: 'anthropic-oauth',
    budgetOwner: 'anthropic-oauth-transport-budget',
    opts,
    onTextReset,
    issueNonStreamingFallback,
  });

  return { requireTransportRecoveryBudget, issueNonStreamingFallback, recoverNonStreaming };
}
