/**
 * openai-ws-warmup.mjs — the Codex generate:false prewarm on a fresh socket.
 *
 * Codex performs generate:false during session startup, then hands the live
 * client session to the first real turn. The prewarm contains stable
 * instructions/tools but no live user/transcript input; its response id
 * becomes the anchor the first real request chains from.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { releaseWebSocket } from './openai-ws-pool.mjs';
import { _buildResponseCreateFrame, _cloneJson, _sansInput, _stableStringify } from './openai-ws-delta.mjs';
import { _metadataTrace, _withCodexWsClientMetadata } from './openai-codex-metadata.mjs';

/** Only when the session has no prior request state. A reused pooled socket
 *  with a live chain must go straight to the real request. */
export function startupWarmupApplies({ warmupBody, completedWarmup, attemptIndex, entry }) {
  return (
    Boolean(warmupBody) &&
    typeof warmupBody === 'object' &&
    !completedWarmup &&
    attemptIndex === 0 &&
    !entry.lastResponseId
  );
}

/**
 * Sends the prewarm frame and streams its (empty) response. Throws on any
 * failure; the caller's stream-failure path handles it like the real send.
 * Returns the warmup result plus what the caller records about the wire
 * frame it produced.
 */
export async function runStartupWarmup({
  entry,
  warmupBody,
  attemptIndex,
  codexMetadataContext,
  useCodexWsClientMetadata,
  sendSpan,
  externalSignal,
  logSuppressedReasoningDeltas,
  traceProvider,
  poolKey,
  iteration,
  useModel,
  midState,
  streamTimeouts,
  sendFrame,
  streamFn,
  agentTraceFn,
}) {
  const warmupBuildStart = performance.now();
  // Enforce the no-transcript rule at the transport boundary as well as in
  // the OAuth caller so a future caller cannot accidentally duplicate the
  // transcript. Keep the same request properties as the real turn; Codex
  // changes only the input tail and adds generate:false.
  const parityWarmupBody = {
    ...warmupBody,
    input: Array.isArray(warmupBody.input) ? warmupBody.input : [],
    generate: false,
  };
  const warmupFrame = _buildResponseCreateFrame(parityWarmupBody);
  const warmupMetadataContext = {
    ...codexMetadataContext,
    sendOpts: {
      ...(codexMetadataContext?.sendOpts || {}),
      requestKind: 'prewarm',
      codexRequestKind: 'prewarm',
    },
  };
  const wireWarmupFrame = _withCodexWsClientMetadata(
    warmupFrame,
    entry,
    useCodexWsClientMetadata,
    warmupMetadataContext
  );
  const wireFrameHadTurnState = !!wireWarmupFrame?.client_metadata?.['x-codex-turn-state'];
  const wireFrameMetadataTrace = _metadataTrace(wireWarmupFrame?.client_metadata);
  sendSpan.requestBuildSerializationMs += performance.now() - warmupBuildStart;
  await sendFrame(entry, wireWarmupFrame, sendSpan);
  const warmupStart = Date.now();
  const warmupState = {
    attemptIndex,
    sawResponseCreated: false,
    sawCompleted: false,
    sessionId: poolKey,
    iteration,
    model: useModel,
    traceProvider,
    warmup: true,
    sendSpan,
    sendStartedAt: performance.now(),
  };
  const warmupResult = await streamFn({
    entry,
    externalSignal,
    onStreamDelta: null,
    onToolCall: null,
    state: warmupState,
    logSuppressedReasoningDeltas,
    traceProvider,
    _timeouts: streamTimeouts,
  });
  // Surface warmup-time first-event timeout / send-failure flags onto the
  // shared midState so the outer catch's classifier sees them.
  // (warmupResult itself only resolves on success; failures throw.)
  if (warmupState.firstByteTimeout) midState.firstByteTimeout = true;
  if (warmupState.wsSendFailed) midState.wsSendFailed = true;
  if (!warmupResult?.responseId) {
    throw new Error('Responses WS warmup completed without response id');
  }
  const completedWarmup = {
    requestBody: parityWarmupBody,
    responseId: warmupResult.responseId,
    usage: warmupResult.usage,
  };
  entry.lastResponseId = warmupResult.responseId;
  entry.lastRequestSansInput = _stableStringify(
    _sansInput(parityWarmupBody, {
      normalizeWarmupGenerate: useCodexWsClientMetadata,
    })
  );
  const warmupInputArr = Array.isArray(parityWarmupBody.input) ? parityWarmupBody.input : [];
  entry.lastRequestInput = _cloneJson(warmupInputArr);
  entry.lastResponseItems = _cloneJson(Array.isArray(warmupResult.responseItems) ? warmupResult.responseItems : []);
  entry.lastInputLen = warmupInputArr.length;
  entry.lastInputPrefixHash = createHash('sha256').update(JSON.stringify(warmupInputArr)).digest('hex');
  try {
    const warmupPayload = {
      provider: traceProvider,
      transport: 'websocket',
      event: 'warmup_completed',
      response_id: warmupResult.responseId,
      elapsed_ms: Date.now() - warmupStart,
      input_tokens: warmupResult.usage?.inputTokens || 0,
      cached_tokens: warmupResult.usage?.cachedTokens || 0,
      output_tokens: warmupResult.usage?.outputTokens || 0,
      prompt_tokens: warmupResult.usage?.promptTokens || 0,
    };
    agentTraceFn({
      sessionId: poolKey,
      iteration,
      kind: 'cache_warmup',
      ...warmupPayload,
      payload: warmupPayload,
    });
  } catch {}
  return { warmupResult, completedWarmup, wireFrameHadTurnState, wireFrameMetadataTrace };
}

/** Startup callers stop after the prewarm: the pooled entry retains its
 *  response id, request snapshot and socket for the later real send. */
export function startupPrewarmResult({ entry, poolKey, cacheKey, warmupResult, startupWarmupResponseId, useModel }) {
  const responseId = warmupResult?.responseId || startupWarmupResponseId || entry.lastResponseId || null;
  if (responseId) entry.startupWarmupResponseId = responseId;
  else releaseWebSocket({ entry, poolKey, keep: false });
  return {
    content: '',
    model: warmupResult?.model || useModel,
    toolCalls: [],
    usage: warmupResult?.usage || {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      promptTokens: 0,
    },
    startupPrewarm: !!responseId,
    startupPrewarmHandle: responseId ? { entry, poolKey, cacheKey } : null,
  };
}
