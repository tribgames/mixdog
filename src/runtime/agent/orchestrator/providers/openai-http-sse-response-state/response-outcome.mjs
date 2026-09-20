/**
 * openai-http-sse-response-state/response-outcome.mjs — how the stream
 * leaves the loop: the canonical stream-outcome stamps every thrown error
 * carries, the stall partial, and `finish` (the success result or the
 * EOF-without-terminal failure).
 */
import { extractCacheWriteTokens, extractCachedTokens, traceAgentSse, traceAgentUsage } from '../../agent-trace.mjs';
import { stampStreamOutcome, STREAM_TRANSPORTS } from '../lib/stream-outcome.mjs';
import { dedupeToolCallList } from '../anthropic-leaked-toolcall.mjs';
import { _displayCodexModel } from '../openai-codex-model.mjs';
import { createProviderReplay } from '../lib/provider-replay.mjs';
import { LABEL, toolInputPending } from './response-state.mjs';

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
  const stampToolSafety = (err) => {
    if (state.emittedToolCall && err) {
      try {
        err.emittedToolCall = true;
        err.unsafeToRetry = true;
      } catch {}
    }
    return err;
  };
  // Canonical stream-outcome contract for the HTTP/SSE transport. ONE hint
  // builder is shared by the mid-stream catch and by every post-loop reject
  // so no reject path can escape unstamped (an unstamped outcome is
  // "unknown", which the consumers treat as fail-closed).
  const outcomeHints = (extra = {}) => ({
    transport: STREAM_TRANSPORTS.HTTP_SSE,
    provider: 'openai-responses',
    terminalObserved: state.completed === true,
    continuation: state.completed !== true,
    textEmitted: state.emittedText === true,
    textObservedChars: state.content.length,
    reasoningEmitted: state.emittedReasoning === true || state.reasoningItems.length > 0,
    toolCallsStarted: toolInputPending(state) || state.toolCalls.length > 0,
    toolCallsComplete: state.toolCalls.length,
    toolCallsDispatched: state.emittedToolCallIds.size,
    pendingToolInput: toolInputPending(state),
    // Protocol distinction: a terminal frame carrying end_turn=false keeps
    // the SAME user turn open — terminal observed, still a continuation.
    ...(state.endTurn === false ? { continuationDeclared: true } : {}),
    ...extra,
  });
  const stampOutcome = (err, extra = {}) => {
    try {
      stampStreamOutcome(err, outcomeHints(extra));
    } catch {
      /* best-effort */
    }
    return err;
  };

  // Streamed partial state attached to a semantic-idle stall.
  const stallPartial = () => ({
    emittedToolCall: state.emittedToolCallIds.size > 0,
    content: state.content,
    toolCalls: state.toolCalls.length ? state.toolCalls.slice() : undefined,
    pendingToolUse:
      state.pendingCalls.size > 0 ||
      state.emittedToolCallIds.size > 0 ||
      state.toolTracker.items.size > 0 ||
      state.toolInFlight === true,
    model: state.model || undefined,
  });
  // Every error leaving the stream loop carries the replay, the exposure
  // invariants and the canonical outcome record (same shape as the WS path).
  const stampStreamError = (err) => {
    if (err && !err.partialProviderReplay) {
      try {
        err.partialProviderReplay = createProviderReplay('openai-responses', state.responseItems);
      } catch {}
    }
    // Live-text invariant: once a non-empty chunk has been relayed it
    // cannot be withdrawn — flag the error so no upstream layer retries.
    if (state.emittedText && err) {
      try {
        err.liveTextEmitted = true;
        err.unsafeToRetry = true;
      } catch {}
    }
    // Tool-emit invariant: an error after a dispatched tool call must not
    // reissue the turn (double-execution).
    stampToolSafety(err);
    stampOutcome(err);
    return err;
  };

  // EOF without a terminal frame is ALWAYS a failure, regardless of how much
  // partial text or how many tool calls were streamed. The turn has no
  // terminal signal, so it is a continuation: returning it would report an
  // unfinished sample as a completed assistant turn (and, with tool calls
  // already dispatched, a half-finished side-effecting turn). The partial
  // rides on the error for interrupted-turn persistence.
  const endedEarlyError = () => {
    const err = stampToolSafety(
      new Error(
        `${LABEL} ended before response.completed (text=${state.content.length} chars, toolCalls=${state.toolCalls.length})`
      )
    );
    try {
      err.partialContent = state.content;
      err.partialToolCalls = state.toolCalls.length ? state.toolCalls.slice() : undefined;
      err.partialProviderReplay = createProviderReplay('openai-responses', state.responseItems);
      err.partialModel = state.model || undefined;
      err.pendingToolUse = toolInputPending(state);
    } catch {
      /* best-effort enrichment */
    }
    return stampOutcome(err, { terminalObserved: false, continuation: true });
  };

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
