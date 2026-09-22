/**
 * openai-ws-send-trace.mjs — the diagnostic rows a completed WS send emits:
 * the usage row (with the xAI chain-continuity fields), the cache-miss row,
 * the transport row, and the cache-break row that follows a chain fallback.
 *
 * Trace emission is never allowed to fail a send: every row is written inside
 * a swallow, and nothing here changes the result the caller receives.
 */
import { createHash } from 'node:crypto';
import { grokCacheChainTraceFields, traceAgentUsage } from '../agent-trace.mjs';
import { traceCacheBreak } from '../cache-break-trace.mjs';
import { WS_IDLE_MS } from './openai-ws-pool.mjs';
import { WS_PRE_RESPONSE_CREATED_MS, WS_INTER_CHUNK_MS } from './openai-ws-stream.mjs';

/** The usage row for one send. xAI additionally reports whether the request's
 *  previous_response_id chained onto what the entry held BEFORE this send. */
export function traceSendUsage({
  send,
  result,
  liveModel,
  responseServiceTier,
  sentPrevResponseId,
  priorEntryResponseId,
}) {
  let cacheChain = null;
  if (send.traceProvider === 'xai' && priorEntryResponseId) {
    cacheChain = {
      requestPrevResponseId: sentPrevResponseId,
      chainContinuous: sentPrevResponseId !== null && sentPrevResponseId === priorEntryResponseId,
      continuationResetReason: null,
    };
  } else if (send.traceProvider === 'xai') {
    cacheChain = grokCacheChainTraceFields(send.sendOpts?.providerState, sentPrevResponseId, null);
  }
  traceAgentUsage({
    sessionId: send.poolKey,
    iteration: send.iteration,
    inputTokens: result.usage?.inputTokens || 0,
    outputTokens: result.usage?.outputTokens || 0,
    cachedTokens: result.usage?.cachedTokens || 0,
    promptTokens: result.usage?.promptTokens || 0,
    model: liveModel,
    modelDisplay: send.displayModel ? send.displayModel(liveModel) : liveModel,
    responseId: result.responseId || null,
    rawUsage: result.usage?.raw || null,
    provider: send.traceProvider,
    serviceTier: responseServiceTier,
    ...(cacheChain
      ? {
          requestPrevResponseId: cacheChain.requestPrevResponseId,
          chainContinuous: cacheChain.chainContinuous,
          continuationResetReason: cacheChain.continuationResetReason,
        }
      : {}),
  });
}

export function traceCacheMiss({
  send,
  attempt,
  result,
  requestBody,
  frame,
  cacheObservation,
  liveModel,
  transportCacheKeyHash,
}) {
  if (!cacheObservation.actualMiss) return;
  const requestHasPreviousResponseId =
    typeof frame.previous_response_id === 'string' && frame.previous_response_id.length > 0;
  try {
    send.agentTraceFn({
      sessionId: send.poolKey,
      iteration: send.iteration,
      kind: 'cache_miss',
      provider: send.traceProvider,
      model: liveModel,
      transport: 'websocket',
      payload: {
        provider: send.traceProvider,
        model: liveModel,
        transport: 'websocket',
        ws_mode: attempt.mode,
        reason: cacheObservation.missReason || 'warm_session_cache_miss',
        cached_tokens: cacheObservation.cachedTokens,
        prompt_tokens: cacheObservation.promptTokens,
        input_tokens: cacheObservation.inputTokens,
        uncached_tokens: cacheObservation.uncachedTokens,
        cache_ratio: cacheObservation.cacheRatio,
        previous_max_cached_tokens: cacheObservation.previousMaxCached,
        cache_key_hash: transportCacheKeyHash,
        warm_threshold_tokens: cacheObservation.warmThreshold,
        prompt_threshold_tokens: cacheObservation.promptThreshold,
        drop_ratio: cacheObservation.dropRatio,
        drop_threshold_tokens: cacheObservation.dropThreshold,
        request_has_previous_response_id: requestHasPreviousResponseId,
        chain_delta_reason: attempt.mode === 'delta' ? null : attempt.deltaReason,
        body_input_items: Array.isArray(requestBody.input) ? requestBody.input.length : null,
        frame_input_items: Array.isArray(frame.input) ? frame.input.length : null,
        response_id: result.responseId || null,
      },
    });
  } catch {}
  traceCacheBreak(
    {
      sessionId: send.poolKey,
      iteration: send.iteration,
      classification: 'provider_miss',
      reason: cacheObservation.missReason || 'warm_session_cache_miss',
      source: 'provider_usage',
      provider: send.traceProvider,
      model: liveModel,
      transport: 'websocket',
      cachedTokens: cacheObservation.cachedTokens,
      promptTokens: cacheObservation.promptTokens,
      uncachedTokens: cacheObservation.uncachedTokens,
      cacheRatio: cacheObservation.cacheRatio,
      actualCacheMiss: true,
    },
    { traceFn: send.agentTraceFn }
  );
}

/** The cache-break row: emitted when the chain fell back off delta mode, or
 *  advanced in delta mode with a reason. Two rows, one classification: the
 *  cross-provider cache-break record and the agent-trace row. */
function traceChainCacheBreak({
  send,
  attempt,
  result,
  requestBody,
  frame,
  cacheObservation,
  liveModel,
  transportCacheKeyHash,
  keepResponseChain,
  resultToolCallCount,
  requestHasPreviousResponseId,
  frameHasInstructions,
}) {
  const { mode, deltaReason } = attempt;
  const chainFallback =
    mode !== 'delta' &&
    deltaReason &&
    !['no_anchor', 'full_forced', 'full_default', 'delta_missing_turn_state'].includes(deltaReason);
  if (!chainFallback && !(mode === 'delta' && deltaReason)) return;
  const intentionalTransition =
    typeof send.sendOpts?.cacheBreakIntent === 'string' ? send.sendOpts.cacheBreakIntent : null;
  const classification = intentionalTransition ? 'intentional' : 'provider_transition';
  const reason = mode === 'delta' ? deltaReason : deltaReason || 'full_frame';
  traceCacheBreak(
    {
      sessionId: send.poolKey,
      iteration: send.iteration,
      classification,
      reason,
      source: 'openai_ws_delta',
      provider: send.traceProvider,
      model: liveModel,
      transport: 'websocket',
      intentionalTransition,
      cachedTokens: cacheObservation.cachedTokens,
      promptTokens: cacheObservation.promptTokens,
      uncachedTokens: cacheObservation.uncachedTokens,
      cacheRatio: cacheObservation.cacheRatio,
      actualCacheMiss: cacheObservation.actualMiss,
      ...(attempt.requestInputMismatch || {}),
    },
    { traceFn: null }
  );
  send.agentTraceFn({
    sessionId: send.poolKey,
    iteration: send.iteration,
    kind: 'cache_break',
    classification,
    source: 'openai_ws_delta',
    provider: send.traceProvider,
    model: liveModel,
    payload: {
      provider: send.traceProvider,
      model: liveModel,
      transport: 'websocket',
      ws_mode: mode,
      reason,
      classification,
      source: 'openai_ws_delta',
      intentional_transition: intentionalTransition,
      request_tool_choice: requestBody.tool_choice ?? null,
      cache_key_hash: transportCacheKeyHash,
      cached_tokens: cacheObservation.cachedTokens,
      prompt_tokens: cacheObservation.promptTokens,
      uncached_tokens: cacheObservation.uncachedTokens,
      cache_ratio: cacheObservation.cacheRatio,
      actual_cache_miss: cacheObservation.actualMiss,
      request_has_previous_response_id: requestHasPreviousResponseId,
      chain_stripped_response_items: attempt.strippedResponseItems,
      chain_skipped_response_items: attempt.skippedResponseItems,
      ...(attempt.responseOutputMismatch || {}),
      ...(attempt.requestInputMismatch || {}),
      chain_response_items: Array.isArray(result.responseItems) ? result.responseItems.length : 0,
      body_input_items: Array.isArray(requestBody.input) ? requestBody.input.length : null,
      frame_input_items: Array.isArray(frame.input) ? frame.input.length : null,
      frame_has_instructions: frameHasInstructions,
      keep_response_chain: keepResponseChain,
      tool_call_count: resultToolCallCount,
    },
  });
}

/** Extra WS-specific observability: transport + per-iteration delta bytes,
 *  and the cache-break row when the chain fell back or advanced with a
 *  reason. Never throws into the send path. */
export function traceTransport({
  send,
  attempt,
  entry,
  result,
  requestBody,
  frame,
  cacheObservation,
  liveModel,
  transportCacheKeyHash,
  keepSocket,
  keepResponseChain,
  requestedServiceTier,
  responseServiceTier,
  warmupContinuity,
  effectiveWarmupResponseId,
}) {
  try {
    const resultToolCallCount = Array.isArray(result.toolCalls) ? result.toolCalls.length : 0;
    const transportPayload = {
      provider: send.traceProvider,
      transport: 'websocket',
      ws_mode: attempt.mode,
      ws_pre_response_created_timeout_ms: WS_PRE_RESPONSE_CREATED_MS,
      ws_inter_chunk_timeout_ms: WS_INTER_CHUNK_MS,
      ws_idle_ms: WS_IDLE_MS,
      iteration_delta_tokens: attempt.deltaTokens,
      reused_connection: attempt.reused,
      requested_service_tier: requestedServiceTier,
      response_service_tier: responseServiceTier,
      handshake_retries: attempt.handshakeRetries,
      handshake_retry_classifiers: attempt.handshakeRetryClassifiers,
      midstream_retries: attempt.attemptIndex,
      response_id: result.responseId || null,
      cache_key_hash: transportCacheKeyHash,
      request_has_previous_response_id:
        typeof frame.previous_response_id === 'string' && frame.previous_response_id.length > 0,
      cached_tokens: cacheObservation.cachedTokens,
      prompt_tokens: cacheObservation.promptTokens,
      input_tokens: cacheObservation.inputTokens,
      uncached_tokens: cacheObservation.uncachedTokens,
      cache_ratio: cacheObservation.cacheRatio,
      actual_cache_miss: cacheObservation.actualMiss,
      actual_cache_miss_reason: cacheObservation.missReason,
      previous_max_cached_tokens: cacheObservation.previousMaxCached,
      cache_drop_threshold_tokens: cacheObservation.dropThreshold,
      frame_prefix_hash: attempt.framePrefix.hash,
      frame_prefix_head_hash: attempt.framePrefix.headHash,
      frame_prefix_prev_match: attempt.framePrefix.prevMatch,
      ws_client_metadata: send.useCodexWsClientMetadata,
      ws_client_metadata_key_count: attempt.wireFrameMetadataTrace.count,
      ws_client_metadata_hash: attempt.wireFrameMetadataTrace.hash,
      ws_client_metadata_has_turn_metadata: attempt.wireFrameMetadataTrace.hasTurnMetadata,
      ws_client_metadata_has_thread_id: attempt.wireFrameMetadataTrace.hasThreadId,
      ws_client_metadata_has_turn_state: attempt.wireFrameHadTurnState,
      ws_entry_turn_state_available: send.useCodexWsClientMetadata && !!entry.turnState,
      // Fingerprint only. The token is a routing credential, so it is hashed
      // rather than logged; the length still distinguishes a real server
      // token from a stub value, and the hash shows whether one session
      // keeps a single pin or is re-issued (reconnect / turn rollover).
      ws_entry_turn_state_fp:
        typeof entry.turnState === 'string' && entry.turnState
          ? `${createHash('sha256').update(entry.turnState).digest('hex').slice(0, 12)}:len${entry.turnState.length}`
          : null,
      chain_delta_reason: attempt.mode === 'delta' ? null : attempt.deltaReason,
      chain_stripped_response_items: attempt.strippedResponseItems,
      chain_skipped_response_items: attempt.skippedResponseItems,
      ...(attempt.responseOutputMismatch || {}),
      ...(attempt.requestInputMismatch || {}),
      chain_response_items: Array.isArray(result.responseItems) ? result.responseItems.length : 0,
      body_input_items: Array.isArray(requestBody.input) ? requestBody.input.length : null,
      frame_input_items: Array.isArray(frame.input) ? frame.input.length : null,
      frame_has_instructions: typeof frame.instructions === 'string' && frame.instructions.length > 0,
      warmup_used: !!effectiveWarmupResponseId,
      warmup_response_id: effectiveWarmupResponseId,
      warmup_first_real_cache_hit: !!effectiveWarmupResponseId && cacheObservation.cachedTokens > 0,
      ...warmupContinuity,
      tool_call_count: resultToolCallCount,
      keep_socket: keepSocket,
      keep_response_chain: keepResponseChain,
    };
    send.agentTraceFn({
      sessionId: send.poolKey,
      iteration: send.iteration,
      kind: 'transport',
      ...transportPayload,
      payload: transportPayload,
    });
    traceChainCacheBreak({
      send,
      attempt,
      result,
      requestBody,
      frame,
      cacheObservation,
      liveModel,
      transportCacheKeyHash,
      keepResponseChain,
      resultToolCallCount,
      requestHasPreviousResponseId: transportPayload.request_has_previous_response_id,
      frameHasInstructions: transportPayload.frame_has_instructions,
    });
  } catch {}
}
