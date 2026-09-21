/**
 * openai-ws-send-outcome.mjs — what a completed WS send leaves behind: the
 * pooled entry's conversation chain for the next delta frame, the prompt
 * cache observation and its trace rows, the transport diagnostics row, and
 * the result shape the provider caller receives.
 */
import { createHash } from 'node:crypto';
import { traceAgentSse, traceAgentUsage, grokCacheChainTraceFields } from '../agent-trace.mjs';
import { traceCacheBreak } from '../cache-break-trace.mjs';
import { envPositiveInt } from '../../../shared/env.mjs';
import { WS_IDLE_MS, releaseWebSocket } from './openai-ws-pool.mjs';
import { WS_PRE_RESPONSE_CREATED_MS, WS_INTER_CHUNK_MS, _combineUsageWithWarmup } from './openai-ws-stream.mjs';
import { _cloneJson, _requestInputMismatchDiagnostics, _sansInput, _stableStringify } from './openai-ws-delta.mjs';
import { _hashText } from './openai-codex-metadata.mjs';

function _num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _envRatio(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export function _cacheObservation({ entry, result, continuityResetReason = null }) {
  const inputTokens = _num(result?.usage?.inputTokens, 0);
  const promptTokens = _num(result?.usage?.promptTokens, 0) || inputTokens;
  const cachedTokens = _num(result?.usage?.cachedTokens, 0);
  const previousMaxCached = _num(entry?.promptCacheMaxCachedTokens, 0);
  const warmThreshold = envPositiveInt('MIXDOG_OAI_CACHE_MISS_WARM_TOKENS', 2048);
  const promptThreshold = envPositiveInt('MIXDOG_OAI_CACHE_MISS_PROMPT_TOKENS', 4096);
  const dropRatio = _envRatio('MIXDOG_OAI_CACHE_MISS_DROP_RATIO', 0.6);
  const dropThreshold = Math.floor(previousMaxCached * dropRatio);
  // A full-frame chain break (most commonly compaction/input-prefix rewrite)
  // starts a new prompt shape. Comparing its small new prompt against the
  // old shape's lifetime high-water creates a "cache drop" on every following
  // iteration until the new transcript grows past 60% of the old one.
  const wasWarm = !continuityResetReason && previousMaxCached >= warmThreshold;
  const cacheRatio = promptTokens > 0 ? cachedTokens / promptTokens : null;
  const zeroMiss = wasWarm && promptTokens >= promptThreshold && cachedTokens === 0;
  const partialDrop =
    wasWarm &&
    promptTokens >= promptThreshold &&
    cachedTokens > 0 &&
    previousMaxCached > 0 &&
    cachedTokens < dropThreshold;
  const actualMiss = zeroMiss || partialDrop;
  return {
    inputTokens,
    promptTokens,
    cachedTokens,
    uncachedTokens: Math.max(0, promptTokens - cachedTokens),
    previousMaxCached,
    wasWarm,
    warmThreshold,
    promptThreshold,
    dropRatio,
    dropThreshold,
    cacheRatio,
    actualMiss,
    continuityResetReason,
    missReason:
      [zeroMiss && 'warm_session_zero_cached_tokens', partialDrop && 'warm_session_cached_tokens_dropped'].find(
        Boolean
      ) ?? null,
  };
}

function _requestInputExtends(previousInput, currentInput) {
  if (!Array.isArray(previousInput) || !Array.isArray(currentInput)) return false;
  if (currentInput.length < previousInput.length) return false;
  return previousInput.every((item, index) => _stableStringify(item) === _stableStringify(currentInput[index]));
}

export function _cacheContinuityResetReason({ mode, deltaReason, entry, body, traceProvider }) {
  if (mode === 'delta') return null;
  if (deltaReason && !['no_anchor', 'full_forced', 'full_default'].includes(deltaReason)) {
    return deltaReason;
  }
  // ws-full bypasses _computeDelta's structural comparisons and reports only
  // full_default. Re-run the two cheap snapshot checks so compaction or any
  // other prompt rewrite still retires the old prompt's cache high-water.
  if (deltaReason !== 'full_default' || !entry?.lastResponseId) return null;
  const currentSansInput = _stableStringify(
    _sansInput(body, {
      normalizeWarmupGenerate: traceProvider === 'openai-oauth',
    })
  );
  if (entry.lastRequestSansInput && currentSansInput !== entry.lastRequestSansInput) {
    return 'request_properties_changed';
  }
  if (
    Array.isArray(entry.lastRequestInput) &&
    !_requestInputExtends(entry.lastRequestInput, Array.isArray(body?.input) ? body.input : [])
  ) {
    return 'input_prefix_mismatch';
  }
  return null;
}

// Warmup→first-real continuity trace (Codex prewarm_websocket parity
// observability). Pure/deterministic so it unit-tests without a live socket.
// The R23 finding forbids the post-warmup request rewrite, so parity is
// asserted via metrics instead of behavior: does the warmup's response_id
// become the anchor the FIRST real request chains from, and what is the
// hit/miss outcome of the first up-to-3 real requests on the socket.
export function _warmupContinuityTrace({
  warmupUsed,
  warmupResponseId,
  priorEntryResponseId,
  sentPrevResponseId,
  earlyCacheMisses,
} = {}) {
  const misses = Array.isArray(earlyCacheMisses) ? earlyCacheMisses.slice(0, 3) : [];
  // The first real request is a full frame (no prev_id, per R23), so its
  // anchor is what the entry held at build time — which the warmup wrote.
  const firstRealPrevId = sentPrevResponseId || priorEntryResponseId || null;
  return {
    warmup_first_real_prev_id: firstRealPrevId,
    warmup_chain_continuous: !!warmupUsed && !!warmupResponseId && firstRealPrevId === warmupResponseId,
    early_cache_misses: misses,
    early_cache_miss_count: misses.filter(Boolean).length,
  };
}

/**
 * Prefix-consistency probe (item-level). Serialized-JSON byte prefixes can
 * never match across appends (the shorter frame ends in "]}" where the longer
 * has ","), so compare what the server's prefix cache actually sees: the
 * non-input request header and the per-item content of the input array.
 * prevMatch=true means the current call's header is identical and its first
 * N input items equal the previous call's N items (append-only history).
 * Best-effort: a failure mid-probe keeps whatever was computed.
 */
export function probeFramePrefix(entry, frame, requestBody) {
  const probe = { hash: null, headHash: null, prevMatch: null };
  try {
    // previous_response_id is the per-call anchor: it changes on every delta
    // frame by design, so including it made prevMatch structurally false for
    // the entire delta path and the probe could never report what it was
    // built to report — whether OUR request prefix stayed stable across
    // calls.
    const { client_metadata: _cm, input: frameInput, previous_response_id: _prevAnchor, ...frameHeader } = frame;
    const headerHash = _hashText(JSON.stringify(frameHeader), 16);
    // A delta frame carries only the tail, so hashing frame.input compares
    // [C] against [A,B] and prevMatch can never hold on the delta path. The
    // question the probe exists to answer is whether the LOGICAL
    // conversation stayed append-only, so hash the full request body input
    // and fall back to the frame only when the body is unavailable.
    const logicalInput = [requestBody?.input, frameInput].find(Array.isArray) ?? [];
    const itemHashes = logicalInput.map((item) => _hashText(JSON.stringify(item), 12));
    probe.hash = headerHash;
    probe.headHash = _hashText(itemHashes.join(','), 16);
    const prevHeader = entry.lastFrameHeaderHash;
    const prevItems = entry.lastFrameItemHashes;
    if (prevHeader && Array.isArray(prevItems)) {
      probe.prevMatch =
        headerHash === prevHeader &&
        itemHashes.length >= prevItems.length &&
        prevItems.every((h, i) => itemHashes[i] === h);
    }
    entry.lastFrameHeaderHash = headerHash;
    entry.lastFrameItemHashes = itemHashes;
  } catch {}
  return probe;
}

/**
 * Keeps the conversation chain whenever the server gave us a response id.
 * `incompleteReason` is ONLY ever set for max_output_tokens-class truncation
 * (every other incomplete status throws upstream), and in that case the
 * response IS valid and the server preserves its response_id as a
 * continuation anchor. Dropping the chain here forced the NEXT turn to
 * cold-start (no_anchor → full resend), which the trace logs showed
 * repeating 50-78x in long max-output sessions. If a truncated turn's
 * response items don't line up next turn, _stripResponseItemsFromHead still
 * falls back to a full send on its own, so retaining the anchor cannot
 * corrupt the cache — it only adds a delta fast-path when the items DO match.
 *
 * openai-oauth keeps the previous response anchor even when the model emitted
 * tool calls: the next request is previous input + server output items +
 * tool results, and _computeDelta strips the first two parts so the WebSocket
 * frame only sends the true new tail.
 */
function recordResponseChain({ entry, result, requestBody, useCodexWsClientMetadata }) {
  const keepResponseChain = !!result.responseId;
  if (result.responseId && keepResponseChain) {
    entry.lastResponseId = result.responseId;
    entry.lastRequestSansInput = _stableStringify(
      _sansInput(requestBody, {
        normalizeWarmupGenerate: useCodexWsClientMetadata,
      })
    );
    const inputArr = Array.isArray(requestBody.input) ? requestBody.input : [];
    entry.lastRequestInput = _cloneJson(inputArr);
    entry.lastResponseItems = _cloneJson(Array.isArray(result.responseItems) ? result.responseItems : []);
    entry.lastInputLen = inputArr.length;
    // Kept for diagnostics / xAI retry carry-forward. The canonical prefix
    // guard is lastRequestInput above, not this hash.
    entry.lastInputPrefixHash = createHash('sha256').update(JSON.stringify(inputArr)).digest('hex');
  } else if (!keepResponseChain) {
    entry.lastResponseId = null;
    entry.lastRequestSansInput = null;
    entry.lastRequestInput = null;
    entry.lastResponseItems = null;
    entry.lastInputLen = 0;
    entry.lastInputPrefixHash = null;
  }
  return keepResponseChain;
}

function traceCacheMiss({
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

/** Extra WS-specific observability: transport + per-iteration delta bytes,
 *  and the cache-break row when the chain fell back or advanced with a
 *  reason. Never throws into the send path. */
function traceTransport({
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
    const { mode, deltaReason } = attempt;
    const chainFallback =
      mode !== 'delta' &&
      deltaReason &&
      !['no_anchor', 'full_forced', 'full_default', 'delta_missing_turn_state'].includes(deltaReason);
    if (chainFallback || (mode === 'delta' && deltaReason)) {
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
          request_has_previous_response_id: transportPayload.request_has_previous_response_id,
          chain_stripped_response_items: attempt.strippedResponseItems,
          chain_skipped_response_items: attempt.skippedResponseItems,
          ...(attempt.responseOutputMismatch || {}),
          ...(attempt.requestInputMismatch || {}),
          chain_response_items: Array.isArray(result.responseItems) ? result.responseItems.length : 0,
          body_input_items: Array.isArray(requestBody.input) ? requestBody.input.length : null,
          frame_input_items: Array.isArray(frame.input) ? frame.input.length : null,
          frame_has_instructions: transportPayload.frame_has_instructions,
          keep_response_chain: keepResponseChain,
          tool_call_count: resultToolCallCount,
        },
      });
    }
  } catch {}
}

/**
 * Everything that follows a resolved stream, in order: SSE timing, the
 * entry's chain, the cache observation (main request usage only) and usage
 * trace, cache-miss and transport rows, the pool release, and the result the
 * provider caller receives.
 *
 * @param {object} input
 * @param {object} input.send     per-send constants: poolKey, cacheKey, iteration,
 *   traceProvider, useModel, displayModel, sendOpts, useCodexWsClientMetadata,
 *   includeResponseId, agentTraceFn, body
 * @param {object} input.attempt  per-attempt facts: mode, frame, deltaReason,
 *   deltaTokens, strippedResponseItems, skippedResponseItems,
 *   responseOutputMismatch, requestInputMismatch, wireFrameHadTurnState,
 *   wireFrameMetadataTrace, framePrefix, reused, handshakeRetries,
 *   handshakeRetryClassifiers, attemptIndex, sseStart, warmupResult,
 *   startupWarmupResponseId
 * @param {object} input.entry
 * @param {object} input.result
 * @param {object} input.requestBody
 * @param {object|null} input.completedWarmup
 */
export function completeWsSend({ send, attempt, entry, result, requestBody, completedWarmup }) {
  const { frame } = attempt;
  const liveModel = result.model || send.useModel;
  traceAgentSse({
    sessionId: send.poolKey,
    sseParseMs: Date.now() - attempt.sseStart,
    provider: send.traceProvider,
    model: liveModel,
    transport: 'websocket',
  });
  // Normally the socket is pooled for reuse. But an early tool-call settle
  // (result.closeSocket) means the stream resolved before
  // response.completed/done arrived: the server may still emit those as
  // orphan frames, so the socket must be discarded, not reused.
  const keepSocket = !result.closeSocket;
  // Captured BEFORE the chain overwrite below: chain-continuity trace must
  // compare the request's prev_id against what the entry held when the
  // request was BUILT, not the id we just received.
  const priorEntryResponseId =
    typeof entry?.lastResponseId === 'string' && entry.lastResponseId.length > 0 ? entry.lastResponseId : null;
  const cacheContinuityResetReason = _cacheContinuityResetReason({
    mode: attempt.mode,
    deltaReason: attempt.deltaReason,
    entry,
    body: requestBody,
    traceProvider: send.traceProvider,
  });
  if (cacheContinuityResetReason === 'input_prefix_mismatch' && !attempt.requestInputMismatch) {
    attempt.requestInputMismatch = _requestInputMismatchDiagnostics(requestBody?.input, entry?.lastRequestInput);
  }
  const keepResponseChain = recordResponseChain({
    entry,
    result,
    requestBody,
    useCodexWsClientMetadata: send.useCodexWsClientMetadata,
  });
  // Cache observation must see the MAIN request's usage only. Folding warmup
  // usage in first made prompt_tokens spike on it=1 and then "shrink" on
  // it=2, faking prefix-rewrite/cache-drop signals in every warmup session.
  const cacheObservation = _cacheObservation({
    entry,
    result,
    continuityResetReason: cacheContinuityResetReason,
  });
  if (completedWarmup?.usage) {
    result.usage = _combineUsageWithWarmup(result.usage, completedWarmup.usage, {
      // xAI/Grok prewarm is billable just like Codex prewarm, but it is not
      // part of the real request's context footprint. Direct OpenAI
      // intentionally retains its existing usage shape.
      separateMainContext: send.useCodexWsClientMetadata || send.traceProvider === 'xai',
    });
  }
  const requestedServiceTier = send.body?.service_tier || null;
  const responseServiceTier = result.serviceTier || result.usage?.raw?.service_tier || null;
  const nonEmptyString = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
  const sentPrevResponseId =
    nonEmptyString(frame?.previous_response_id) ?? nonEmptyString(send.body?.previous_response_id);
  // Compare against the entry's PRE-request lastResponseId (captured above,
  // before the chain overwrite): the WS delta path chains from entry state,
  // so stale providerState OR the post-overwrite id would both mis-report
  // continuity.
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
  const transportCacheKeyHash = send.cacheKey
    ? createHash('sha256').update(String(send.cacheKey)).digest('hex').slice(0, 12)
    : null;
  traceCacheMiss({ send, attempt, result, requestBody, frame, cacheObservation, liveModel, transportCacheKeyHash });
  // Rebase after a genuine provider retreat so one eviction produces one
  // diagnostic instead of a long run of duplicate "dropped" rows. The
  // request that exposed the retreat has already rebuilt the prefix; its
  // observed cached count is the correct baseline for recovery.
  entry.promptCacheMaxCachedTokens =
    cacheObservation.actualMiss || cacheObservation.continuityResetReason
      ? cacheObservation.cachedTokens
      : Math.max(_num(entry.promptCacheMaxCachedTokens, 0), cacheObservation.cachedTokens);
  // Early-session cache-miss ledger (first up-to-3 real requests on this
  // socket) for the warmup→first-real continuity trace below. Warmup itself
  // is excluded — this only runs on the real send.
  if (!Array.isArray(entry.earlyCacheMisses)) entry.earlyCacheMisses = [];
  if (entry.earlyCacheMisses.length < 3) {
    entry.earlyCacheMisses.push(cacheObservation.actualMiss ? cacheObservation.missReason || 'miss' : false);
  }
  const effectiveWarmupResponseId = attempt.warmupResult?.responseId || attempt.startupWarmupResponseId || null;
  const warmupContinuity = _warmupContinuityTrace({
    warmupUsed: !!effectiveWarmupResponseId,
    warmupResponseId: effectiveWarmupResponseId,
    priorEntryResponseId,
    sentPrevResponseId,
    earlyCacheMisses: entry.earlyCacheMisses,
  });
  traceTransport({
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
  });
  if (attempt.startupWarmupResponseId) {
    try {
      delete entry.startupWarmupResponseId;
    } catch {}
  }
  releaseWebSocket({ entry, poolKey: send.poolKey, keep: keepSocket });
  const {
    responseId: _ignored,
    responseItems: _responseItemsIgnored,
    closeSocket: _closeSocketIgnored,
    ...out
  } = result;
  if (send.includeResponseId && result.responseId) out.responseId = result.responseId;
  if (completedWarmup) {
    try {
      Object.defineProperty(out, '__warmup', {
        value: completedWarmup,
        enumerable: false,
      });
    } catch {}
  }
  // Leave a breadcrumb on the result so downstream callers can observe that
  // a retry was used (0 = first-try success, up to 2 for ws_1006/1011).
  try {
    Object.defineProperty(out, '__midstreamRetries', { value: attempt.attemptIndex, enumerable: false });
  } catch {}
  return out;
}
