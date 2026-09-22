/**
 * openai-ws-send-outcome.mjs — what a completed WS send leaves behind: the
 * pooled entry's conversation chain for the next delta frame, the prompt
 * cache observation and its trace rows, the transport diagnostics row, and
 * the result shape the provider caller receives.
 */
import { createHash } from 'node:crypto';
import { traceAgentSse } from '../agent-trace.mjs';
import { envPositiveInt } from '../../../shared/env.mjs';
import { releaseWebSocket } from './openai-ws-pool.mjs';
import { _combineUsageWithWarmup } from './openai-ws-stream.mjs';
import { traceCacheMiss, traceSendUsage, traceTransport } from './openai-ws-send-trace.mjs';
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

/**
 * Prompt-cache high-water bookkeeping for the pooled entry, plus the
 * early-session miss ledger the warmup continuity trace reads.
 */
function updateEntryCacheLedger(entry, cacheObservation) {
  // Rebase after a genuine provider retreat so one eviction produces one
  // diagnostic instead of a long run of duplicate "dropped" rows. The
  // request that exposed the retreat has already rebuilt the prefix; its
  // observed cached count is the correct baseline for recovery.
  entry.promptCacheMaxCachedTokens =
    cacheObservation.actualMiss || cacheObservation.continuityResetReason
      ? cacheObservation.cachedTokens
      : Math.max(_num(entry.promptCacheMaxCachedTokens, 0), cacheObservation.cachedTokens);
  // Early-session cache-miss ledger (first up-to-3 real requests on this
  // socket) for the warmup→first-real continuity trace. Warmup itself is
  // excluded — this only runs on the real send.
  if (!Array.isArray(entry.earlyCacheMisses)) entry.earlyCacheMisses = [];
  if (entry.earlyCacheMisses.length < 3) {
    entry.earlyCacheMisses.push(cacheObservation.actualMiss ? cacheObservation.missReason || 'miss' : false);
  }
}

/**
 * The object the provider caller receives: the streamed result minus the
 * transport-internal fields, with the optional response id and the two
 * non-enumerable breadcrumbs (warmup record, midstream retry count).
 */
function buildSendResult({ send, attempt, result, completedWarmup }) {
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
  traceSendUsage({ send, result, liveModel, responseServiceTier, sentPrevResponseId, priorEntryResponseId });
  const transportCacheKeyHash = send.cacheKey
    ? createHash('sha256').update(String(send.cacheKey)).digest('hex').slice(0, 12)
    : null;
  traceCacheMiss({ send, attempt, result, requestBody, frame, cacheObservation, liveModel, transportCacheKeyHash });
  updateEntryCacheLedger(entry, cacheObservation);
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
  return buildSendResult({ send, attempt, result, completedWarmup });
}
