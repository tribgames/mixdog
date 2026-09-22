/**
 * openai-http-sse-response-state/response-outcome.mjs — how the stream
 * leaves the loop: the canonical stream-outcome stamps every thrown error
 * carries, the stall partial, and `finish` (the success result or the
 * EOF-without-terminal failure).
 */
import { extractCacheWriteTokens, extractCachedTokens, traceAgentSse, traceAgentUsage } from '../../agent-trace.mjs';
import { dedupeToolCallList } from '../anthropic-leaked-toolcall.mjs';
import { _displayCodexModel } from '../openai-codex-model.mjs';
import { createProviderReplay } from '../lib/provider-replay.mjs';
import { LABEL } from './response-state.mjs';
import { createResponseStamps } from './response-stamps.mjs';

export function usageFromResponse(rawUsage, serviceTier) {
  return {
    inputTokens: rawUsage.input_tokens || 0,
    outputTokens: rawUsage.output_tokens || 0,
    cachedTokens: extractCachedTokens(rawUsage),
    cacheWriteTokens: extractCacheWriteTokens(rawUsage),
    promptTokens: rawUsage.input_tokens || 0,
    raw: serviceTier ? { ...rawUsage, service_tier: serviceTier } : rawUsage,
  };
}

export function createResponseOutcome({ state }) {
  const { stampToolSafety, stampOutcome, stallPartial, stampStreamError, endedEarlyError } = createResponseStamps({
    state,
  });

  const traceFinished = ({ liveModel, poolKey, iteration, sseStartedAt, ttftMs }) => {
    traceAgentSse({
      sessionId: poolKey,
      sseParseMs: Date.now() - sseStartedAt,
      ttftMs,
      provider: 'openai-oauth',
      model: liveModel,
      transport: 'sse',
    });
    const { usage } = state;
    if (!usage) return;
    traceAgentUsage({
      sessionId: poolKey,
      iteration,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cachedTokens: usage.cachedTokens || 0,
      promptTokens: usage.promptTokens || 0,
      model: liveModel,
      modelDisplay: _displayCodexModel(liveModel),
      responseId: state.responseId || null,
      rawUsage: usage.raw || null,
      provider: 'openai-oauth',
      serviceTier: state.serviceTier,
    });
  };

  const finish = ({ useModel, poolKey, iteration, sseStartedAt, ttftMs }) => {
    const unresolved = state.toolCalls.find((t) => t._pendingItemId);
    if (unresolved) {
      throw stampOutcome(
        stampToolSafety(
          new Error(
            `${LABEL} function_call salvage failed: missing call_id/name for item_id=${unresolved._pendingItemId || '?'}`
          )
        )
      );
    }
    if (!state.completed) throw endedEarlyError();

    const liveModel = state.model || useModel;
    traceFinished({ liveModel, poolKey, iteration, sseStartedAt, ttftMs });
    // Dedupe the returned array by name+args: a synthetic leaked call and an
    // identical native function_call must not both survive, else the agent
    // loop executes the side-effecting tool twice.
    const returnedToolCalls = state.toolCalls.length
      ? dedupeToolCallList(state.toolCalls.map(({ _pendingItemId, ...t }) => t))
      : undefined;
    return {
      content: state.content,
      model: liveModel,
      reasoningItems: state.reasoningItems.length ? state.reasoningItems : undefined,
      providerReplay: createProviderReplay('openai-responses', state.responseItems),
      toolCalls: returnedToolCalls,
      citations: state.citations.length ? state.citations : undefined,
      webSearchCalls: state.webSearchCalls.length ? state.webSearchCalls : undefined,
      usage: state.usage || undefined,
      stopReason: state.stopReason || undefined,
      // Only present when the terminal frame carried the wire field.
      ...(typeof state.endTurn === 'boolean' ? { endTurn: state.endTurn } : {}),
      // Text-only max-output cutoff (status:'incomplete'/reason=max_output_tokens
      // maps to stopReason='length' above and counts as success). Flag it so
      // loop.mjs can surface a truncation warning instead of accepting
      // silently-cut content as a clean final answer.
      ...(state.stopReason === 'length' && state.content.length > 0 ? { truncated: true } : {}),
      responseId: state.responseId || undefined,
      serviceTier: state.serviceTier || undefined,
    };
  };

  return { stampToolSafety, stampOutcome, stallPartial, stampStreamError, finish };
}
