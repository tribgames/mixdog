import { markProviderRecoveryExhausted, retryDelayLabel, withRetry } from './retry-classifier.mjs';
import { consumeCompatResponsesStream } from './openai-compat-stream.mjs';
import { providerRetryStatusText } from '../../../shared/err-text.mjs';
import { PROVIDER_FIRST_BYTE_TIMEOUT_MS, createPassthroughSignal } from '../stall-policy.mjs';
import {
  nativeResponsesTools,
  toOpenAIMessages,
  toResponsesTools,
  toXaiResponsesInput,
  xaiSystemInstructions,
  knownToolNamesFromResponsesTools,
  parseResponsesToolCalls,
  responseOutputText,
} from './openai-compat-wire.mjs';
import {
  normalizeXaiReasoningEffort,
  xaiModelSupportsReasoningEffort,
  xaiResponsesCacheRouting,
  useXaiResponsesWebSocketWarmup,
  XAI_CACHE_LANE_META,
} from './openai-compat-xai.mjs';
import { normalizeXaiResponsesHttp, normalizeXaiResponsesWebSocket } from './openai-compat-response-normalization.mjs';
import { sendViaWebSocket } from './openai-oauth-ws.mjs';
import { applyCompatToolChoice } from './compat-request-policy.mjs';
import { envFlag as _envFlag } from '../../../shared/env.mjs';
import { resolveResponsesTransportPolicy, RESPONSES_TRANSPORT_CAPABILITIES } from './openai-transport-policy.mjs';

export async function sendXaiResponses(provider, messages, useModel, tools, opts) {
  const signal = opts.signal || null;
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error('xAI Responses request aborted by session close');
  }
  const chatMessagesForTrace = toOpenAIMessages(messages, provider.name);
  const cacheRouting = xaiResponsesCacheRouting(opts, { messages: chatMessagesForTrace }, tools || [], useModel);
  const { input, previousResponseId, startIndex, continuationResetReason } = toXaiResponsesInput(
    messages,
    opts.providerState,
    { model: useModel }
  );
  const params = {
    model: useModel,
    input,
    // xAI's reference sampler is ZDR-safe by default and asks the
    // service to return opaque reasoning state for continuation.
    // This method is xAI-only; other compat providers retain their
    // existing request bodies.
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  // A null routing key means "omit the field" (cache scope 'none'):
  // xAI's own client sends no prompt_cache_key and relies on the
  // service's automatic prefix caching.
  if (cacheRouting.key) params.prompt_cache_key = cacheRouting.key;
  if (previousResponseId) params.previous_response_id = previousResponseId;
  const nativeTools = nativeResponsesTools(opts);
  if (tools?.length || nativeTools.length) {
    params.tools = [...nativeTools, ...toResponsesTools(tools || [], { provider: 'xai' })];
  }
  // Explicit parallel tool calls, matching the OpenAI Responses
  // reference shape. Probe-verified accepted by api.x.ai (HTTP 200,
  // 2026-08-16); absent, the service default decides per turn.
  if (params.tools?.length) params.parallel_tool_calls = true;
  applyCompatToolChoice(params, opts);
  // SSE transport: report 'requesting' until the stream opens, then
  // per-chunk onStreamDelta feeds the agent stall watchdog.
  try {
    opts.onStageChange?.('requesting');
  } catch {
    /* heartbeat best-effort */
  }
  const reasoningEffort = normalizeXaiReasoningEffort(
    opts.xaiReasoningEffort ?? opts.effort ?? provider.config?.reasoningEffort ?? process.env.MIXDOG_XAI_REASONING_EFFORT
  );
  if (reasoningEffort && xaiModelSupportsReasoningEffort(useModel)) {
    params.reasoning = { effort: reasoningEffort };
  }
  params.stream = true;
  const cacheLane = XAI_CACHE_LANE_META;
  const totalSignal = createPassthroughSignal(signal);
  let streamed;
  try {
    streamed = await withRetry(
      async ({ signal: attemptSignal }) => {
        const stream = await withRetry(
          ({ signal: openSignal }) => provider.client.responses.create(params, { signal: openSignal }),
          {
            signal: attemptSignal,
            // Single attempt: first-byte timeout only; retry
            // is owned by the outer withRetry (see chat path).
            maxAttempts: 1,
            perAttemptTimeoutMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS,
            perAttemptLabel: 'xai responses first byte',
          }
        );
        try {
          opts.onStageChange?.('streaming');
        } catch {
          /* heartbeat best-effort */
        }
        try {
          return await consumeCompatResponsesStream(stream, {
            signal: attemptSignal,
            label: 'xai:responses',
            onStreamDelta: opts.onStreamDelta,
            onToolCall: opts.onToolCall,
            onTextDelta: opts.onTextDelta,
            parseResponsesToolCalls,
            responseOutputText,
            knownToolNames: knownToolNamesFromResponsesTools(params.tools),
          });
        } catch (error) {
          if (error?.streamStalled === true) {
            throw markProviderRecoveryExhausted(error, {
              owner: 'xai-content-idle-policy',
            });
          }
          throw error;
        }
      },
      {
        signal: totalSignal.signal,
        onRetry: ({ attempt, maxAttempts, lastErr, delayMs, delayReason }) => {
          const delayLabel = retryDelayLabel(delayMs, delayReason);
          process.stderr.write(
            `[xai:responses] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`
          );
          try {
            opts.onStageChange?.('reconnecting', {
              attempt: attempt + 1,
              max: maxAttempts,
              waitMs: delayMs,
              classifier: lastErr?.retryClassifier || lastErr?.code || null,
              message: providerRetryStatusText(lastErr, {
                attempt: attempt + 1,
                maxAttempts,
                delayMs,
              }),
            });
          } catch {
            /* display-only */
          }
        },
      }
    );
  } finally {
    totalSignal.cleanup();
  }
  return normalizeXaiResponsesHttp({
    messages,
    useModel,
    tools,
    opts,
    params,
    response: streamed.response,
    streamed,
    cacheRouting,
    previousResponseId,
    startIndex,
    continuationResetReason,
    cacheLane,
  });
}

export async function sendXaiResponsesWebSocket(provider, messages, useModel, tools, opts) {
  const signal = opts.signal || null;
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error('xAI Responses WebSocket request aborted by session close');
  }
  const apiKey = provider.config?.apiKey || process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('xAI API key not configured');
  const chatMessagesForTrace = toOpenAIMessages(messages, provider.name);
  const cacheRouting = xaiResponsesCacheRouting(opts, { messages: chatMessagesForTrace }, tools || [], useModel);
  const { input, previousResponseId, startIndex, continuationResetReason } = toXaiResponsesInput(
    messages,
    opts.providerState,
    { includeSystem: false, model: useModel }
  );
  const params = {
    model: useModel,
    input,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  if (cacheRouting.key) params.prompt_cache_key = cacheRouting.key;
  const instructions = xaiSystemInstructions(messages);
  if (previousResponseId) params.previous_response_id = previousResponseId;
  // xAI rejects instructions together with previous_response_id; the
  // first response already anchors instructions for the continuation.
  else if (instructions) params.instructions = instructions;
  const nativeTools = nativeResponsesTools(opts);
  if (tools?.length || nativeTools.length) {
    params.tools = [...nativeTools, ...toResponsesTools(tools || [], { provider: 'xai' })];
  }
  // Same explicit parallel-tool-calls contract as the HTTP/SSE path.
  if (params.tools?.length) params.parallel_tool_calls = true;
  applyCompatToolChoice(params, opts);
  const reasoningEffort = normalizeXaiReasoningEffort(
    opts.xaiReasoningEffort ?? opts.effort ?? provider.config?.reasoningEffort ?? process.env.MIXDOG_XAI_REASONING_EFFORT
  );
  if (reasoningEffort && xaiModelSupportsReasoningEffort(useModel)) {
    params.reasoning = { effort: reasoningEffort };
  }
  const warmupBody = useXaiResponsesWebSocketWarmup(opts, provider.config, { previousResponseId })
    ? { ...params, generate: false, input: [] }
    : null;
  const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
  const cacheLane = XAI_CACHE_LANE_META;
  // Fast-fallback only shortens the WS handshake retry budget when the
  // HTTP/SSE fallback is actually enabled for this call. With no-fallback
  // (allowHttpFallback=false) the WS path must keep its FULL retry budget,
  // mirroring openai-oauth's httpFallbackEnabled gate.
  const xaiTransportPolicy = resolveResponsesTransportPolicy(process.env, RESPONSES_TRANSPORT_CAPABILITIES.xai);
  const httpFallbackEnabled = xaiTransportPolicy.allowHttpFallback && _envFlag('MIXDOG_XAI_WS_HTTP_FALLBACK', true);
  const result = await sendViaWebSocket({
    auth: { type: 'xai', apiKey },
    body: params,
    sendOpts: opts,
    onStreamDelta: typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null,
    onToolCall: typeof opts.onToolCall === 'function' ? opts.onToolCall : null,
    onTextDelta: typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null,
    onStageChange: typeof opts.onStageChange === 'function' ? opts.onStageChange : null,
    externalSignal: signal,
    poolKey: opts.sessionId || opts.session?.id || null,
    cacheKey: cacheRouting.key,
    iteration,
    useModel,
    displayModel: (id) => id,
    includeResponseId: true,
    traceProvider: 'xai',
    logSuppressedReasoningDeltas: false,
    warmupBody,
    _carriedWarmup: opts._carriedWarmup || null,
    // Mirror openai-oauth fast fallback: when the HTTP fallback is
    // enabled (outer catch → _shouldFallbackXaiWsToHttp), a first
    // acquire/first-byte failure should skip remaining WS
    // handshake retries instead of burning the retry budget
    // before HTTP starts. Gated on httpFallbackEnabled so a
    // no-fallback config keeps the full WS retry budget.
    fastFallback: httpFallbackEnabled,
  });
  return normalizeXaiResponsesWebSocket({
    messages,
    useModel,
    tools,
    opts,
    result,
    params,
    cacheRouting,
    previousResponseId,
    startIndex,
    continuationResetReason,
    cacheLane,
  });
}
