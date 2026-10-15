import { extractCacheWriteTokens, grokCacheChainTraceFields, traceAgentUsage } from '../agent-trace.mjs';
import { extractCompatCachedTokens } from './openai-compat-trace.mjs';
import { collectCompatResponseSearchSources } from './openai-compat-wire.mjs';
import {
  traceXaiResponsesCacheContext,
  writeCompatCacheTrace,
  writeXaiResponsesCacheTrace,
} from './openai-compat-xai.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { reportedCostUsd } from './lib/usage-primitives.mjs';
import { stampStreamOutcome, STREAM_TRANSPORTS } from './lib/stream-outcome.mjs';
import { failingFinishReasonError } from './openai-compat-stream-common.mjs';
import {
  COMPAT_REASONING_METADATA_KEY,
  capturesShapeReasoning,
  replayReasoningField,
} from './openai-compat-reasoning-field.mjs';

export function compatReportedCostUsd(providerName, usage) {
  if (providerName === 'openrouter') return reportedCostUsd(usage?.cost);
  if (providerName === 'xai') {
    const ticks = reportedCostUsd(usage?.cost_in_usd_ticks);
    return ticks === undefined ? undefined : Number((ticks * 1e-10).toFixed(8));
  }
  return undefined;
}

export const costUsdFromTicks = (ticks) =>
  typeof ticks === 'number' && ticks >= 0 ? Number((ticks * 1e-10).toFixed(8)) : undefined;

export const withCostUsd = (usage, costUsd) => ({ ...usage, ...(costUsd != null ? { costUsd } : {}) });

function messageCountOf(messages) {
  return Array.isArray(messages) ? messages.length : 0;
}

// Carry the prior encrypted-reasoning history forward and append this turn's items.
function xaiEncryptedReasoningHistory(opts, messages, encryptedReasoningItems) {
  const prior = opts.providerState?.xaiResponses?.encryptedReasoningHistory;
  return [
    ...(Array.isArray(prior) ? prior : []),
    ...(encryptedReasoningItems.length
      ? [{ messageIndex: messageCountOf(messages), items: encryptedReasoningItems }]
      : []),
  ];
}

// Both xAI Responses traces (cache trace + cache context) consume the same fields.
function traceXaiResponses(fields) {
  writeXaiResponsesCacheTrace(fields);
  traceXaiResponsesCacheContext(fields);
}

/** Record one completed turn's usage; `extra` carries provider-specific trace fields. */
export function traceCompatResponseUsage({
  opts,
  provider,
  model,
  response,
  inputTokens,
  outputTokens,
  cachedTokens,
  ...extra
}) {
  traceAgentUsage({
    sessionId: opts.sessionId || opts.session?.id || null,
    iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens: 0,
    promptTokens: inputTokens,
    model: response.model || model,
    modelDisplay: response.model || model,
    responseId: response.id || null,
    rawUsage: response.usage,
    provider,
    ...extra,
  });
}

// Responses-wire reported cost: xAI `cost_in_usd_ticks` when present, else a
// gateway `cost` (decimal USD). null/empty/negative is "not reported", never a
// reported $0.
export function responsesReportedCostUsd(usage) {
  return costUsdFromTicks(usage?.cost_in_usd_ticks) ?? reportedCostUsd(usage?.cost);
}

export function chatCompletionUsage(providerName, usage) {
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  return withCostUsd(
    {
      inputTokens: input,
      outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      cachedTokens: extractCompatCachedTokens(usage),
      cacheWriteTokens: extractCacheWriteTokens(usage),
      // Chat Completions prompt_tokens is already the total prompt
      // the model ingested (cached is a subset) — alias directly.
      promptTokens: input,
      raw: { ...usage },
    },
    compatReportedCostUsd(providerName, usage)
  );
}

export function responsesUsage(usage) {
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  return withCostUsd(
    {
      inputTokens,
      outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
      cachedTokens: extractCompatCachedTokens(usage),
      cacheWriteTokens: extractCacheWriteTokens(usage),
      promptTokens: inputTokens,
      raw: { ...usage },
    },
    responsesReportedCostUsd(usage)
  );
}

export function encryptedXaiReasoningItems(output) {
  if (!Array.isArray(output)) return [];
  return output
    .filter(
      (item) => item?.type === 'reasoning' && typeof item?.encrypted_content === 'string' && item.encrypted_content
    )
    .map((item) => ({ ...item }));
}

export function normalizeCompatChatResponse({
  providerName,
  useModel,
  tools,
  opts,
  params,
  assembled,
  cacheRoutingKey,
  cacheRouting,
  replaysReasoningContent,
  reasoningShape = null,
}) {
  const response = assembled.response;
  const choice = response.choices[0];
  const toolCalls = assembled.toolCalls;
  const stopReason = choice?.finish_reason || null;
  const failingFinish = failingFinishReasonError(stopReason, providerName);
  if (failingFinish) {
    const err = failingFinish;
    const partialContent = assembled.content || '';
    Object.assign(err, {
      partialContent,
      partialToolCalls: Array.isArray(toolCalls) && toolCalls.length ? toolCalls : undefined,
      pendingToolUse: false,
      partialModel: response.model || useModel,
      ...(response.usage ? { partialUsage: chatCompletionUsage(providerName, response.usage) } : {}),
    });
    stampStreamOutcome(err, {
      transport: STREAM_TRANSPORTS.NON_STREAMING,
      provider: 'openai-compat',
      terminalObserved: false,
      continuation: true,
      textObservedChars: partialContent.length,
      toolCallsComplete: err.partialToolCalls?.length || 0,
    });
    throw err;
  }
  if (
    (stopReason === 'length' && Array.isArray(toolCalls) && toolCalls.length > 0) ||
    stopReason === 'content_filter'
  ) {
    throw Object.assign(new Error(`${providerName} response incomplete: finish_reason=${stopReason}`), {
      name: 'ProviderIncompleteError',
      code: 'PROVIDER_INCOMPLETE',
      providerIncomplete: true,
      finishReason: stopReason,
      partialContent: assembled.content || '',
      partialToolCalls: toolCalls,
      model: response.model || useModel,
      responseId: response.id || null,
      rawUsage: response.usage || null,
      ...(response.usage
        ? { partialUsage: chatCompletionUsage(providerName, response.usage), partialModel: response.model || useModel }
        : {}),
    });
  }
  writeCompatCacheTrace({
    provider: providerName,
    model: useModel,
    opts,
    params,
    rawTools: tools || [],
    response,
    cacheRoutingKey,
    cacheRouting,
  });
  if (response.usage) {
    const inputTokens = Number(response.usage.prompt_tokens ?? response.usage.input_tokens ?? 0);
    traceCompatResponseUsage({
      opts,
      provider: providerName,
      model: useModel,
      response,
      inputTokens,
      outputTokens: Number(response.usage.completion_tokens ?? response.usage.output_tokens ?? 0),
      cachedTokens: extractCompatCachedTokens(response.usage),
    });
  }
  // Together/vLLM/Groq/OpenRouter report reasoning on `reasoning` or
  // `reasoning_content`; Mistral reports it as thinking chunks inside
  // `content`. Both are captured by the provider's own shape / the response
  // shape, whatever the replay flag says.
  const reasoningField = replayReasoningField(reasoningShape, assembled.reasoningSource);
  const capturesReasoningContent =
    providerName === 'deepseek' ||
    providerName === 'xai' ||
    providerName === 'mixdog-local' ||
    replaysReasoningContent ||
    capturesShapeReasoning(reasoningShape, assembled.reasoningSource);
  const reasoningContent =
    capturesReasoningContent && typeof assembled.reasoningContent === 'string' ? assembled.reasoningContent : null;
  const reasoningDetails =
    providerName === 'openrouter' && Array.isArray(choice?.message?.reasoning_details)
      ? choice.message.reasoning_details
      : null;
  // Replay sends reasoning back under the field it arrived on.
  const providerMetadata = {
    ...(reasoningDetails?.length ? { openrouter: { reasoning_details: reasoningDetails } } : {}),
    ...(reasoningContent !== null && reasoningField
      ? { [COMPAT_REASONING_METADATA_KEY]: { reasoningField } }
      : {}),
  };
  return {
    content: assembled.content || '',
    // Streamed chunks can omit `model`; fall back to the requested
    // model so callers never receive a null model identifier.
    model: response.model || useModel,
    toolCalls,
    stopReason,
    // P1 audit fix: a text-only completion that hit finish_reason=
    // 'length' (no tool calls, so not thrown above as
    // ProviderIncompleteError) previously returned as an ordinary
    // success with no signal that the content is a mid-sentence
    // cutoff. Flag it so loop.mjs can surface a one-line warning
    // instead of silently treating a truncated answer as complete.
    ...(stopReason === 'length' && (assembled.content || '').length > 0 ? { truncated: true } : {}),
    ...(reasoningContent !== null ? { reasoningContent } : {}),
    ...(Object.keys(providerMetadata).length ? { providerMetadata } : {}),
    usage: response.usage ? chatCompletionUsage(providerName, response.usage) : undefined,
  };
}

export function normalizeXaiResponsesHttp({
  messages,
  useModel,
  tools,
  opts,
  params,
  response,
  streamed,
  cacheRouting,
  previousResponseId,
  startIndex,
  continuationResetReason,
  cacheLane,
}) {
  const toolCalls = streamed.toolCalls;
  traceXaiResponses({
    model: useModel,
    opts,
    params,
    rawTools: tools || [],
    response,
    cacheRouting,
    previousResponseId,
    inputStartIndex: startIndex,
    continuationResetReason,
    transport: 'http',
    cacheLane,
  });
  if (response.usage) {
    const inputTokens = Number(response.usage.input_tokens ?? response.usage.prompt_tokens ?? 0);
    const cacheChain = grokCacheChainTraceFields(opts.providerState, previousResponseId, continuationResetReason);
    traceCompatResponseUsage({
      opts,
      provider: 'xai',
      model: useModel,
      response,
      inputTokens,
      outputTokens: Number(response.usage.output_tokens ?? response.usage.completion_tokens ?? 0),
      cachedTokens: extractCompatCachedTokens(response.usage),
      requestPrevResponseId: cacheChain.requestPrevResponseId,
      chainContinuous: cacheChain.chainContinuous,
      continuationResetReason: cacheChain.continuationResetReason,
    });
  }
  const encryptedReasoningItems = encryptedXaiReasoningItems(response.output);
  const providerReplay = createProviderReplay('xai-responses', response.output);
  const encryptedReasoningHistory = xaiEncryptedReasoningHistory(opts, messages, encryptedReasoningItems);
  const searchSources = collectCompatResponseSearchSources(response);
  return {
    content: streamed.content,
    model: response.model || useModel,
    toolCalls,
    stopReason: streamed.stopReason || null,
    // P1 audit fix: mirror the chat-completions truncated flag for
    // the xAI Responses HTTP path — a max-output cutoff with real
    // content must not look identical to a clean stop.
    ...(streamed.stopReason === 'length' && (streamed.content || '').length > 0 ? { truncated: true } : {}),
    citations: searchSources.citations.length ? searchSources.citations : undefined,
    webSearchCalls: searchSources.webSearchCalls.length ? searchSources.webSearchCalls : undefined,
    providerReplay,
    providerState: {
      ...(opts.providerState || {}),
      xaiResponses: {
        previousResponseId: null,
        responseId: response.id,
        store: false,
        encryptedReasoningItems,
        encryptedReasoningHistory,
        seenMessageCount: messageCountOf(messages),
        // The proxy may return a deployment alias (for example
        // grok-4.5-build) for a requested public model id. Chain
        // compatibility is keyed to the requested id; storing the
        // alias here would falsely reset the next tool-result turn.
        model: useModel,
        updatedAt: Date.now(),
      },
    },
    usage: response.usage ? responsesUsage(response.usage) : undefined,
  };
}

export function normalizeXaiResponsesWebSocket({
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
}) {
  const responseId = result.responseId || previousResponseId || null;
  // The WS send result drops the collector's `responseItems`; its own
  // owner-tagged `providerReplay` (traceProvider 'xai') still carries every
  // output item in order: encrypted reasoning and server-executed tool_search
  // call/output pairs. Always taken, so they survive to the next turn as xAI
  // requires.
  const responseItems = result.responseItems ?? result.providerReplay?.items;
  const encryptedReasoningItems = encryptedXaiReasoningItems(responseItems);
  const providerReplay = createProviderReplay('xai-responses', responseItems);
  const encryptedReasoningHistory = xaiEncryptedReasoningHistory(opts, messages, encryptedReasoningItems);
  const rawUsage = result.usage?.raw || result.usage || null;
  const response = {
    id: responseId,
    model: result.model || useModel,
    output: [],
    usage: rawUsage,
  };
  traceXaiResponses({
    model: useModel,
    opts,
    params,
    rawTools: tools || [],
    response,
    cacheRouting,
    previousResponseId,
    inputStartIndex: startIndex,
    continuationResetReason,
    transport: 'websocket',
    cacheLane,
  });
  return {
    content: result.content || '',
    model: result.model || useModel,
    toolCalls: result.toolCalls,
    stopReason: result.stopReason || null,
    // P1 audit fix: same truncated signal as the HTTP path, for the
    // WebSocket transport.
    ...(result.stopReason === 'length' && (result.content || '').length > 0 ? { truncated: true } : {}),
    providerReplay,
    providerState: {
      ...(opts.providerState || {}),
      xaiResponses: {
        previousResponseId: null,
        responseId,
        store: false,
        encryptedReasoningItems,
        encryptedReasoningHistory,
        seenMessageCount: messageCountOf(messages),
        model: useModel,
        updatedAt: Date.now(),
        transport: 'websocket',
      },
    },
    usage: result.usage ? withCostUsd(result.usage, costUsdFromTicks(rawUsage?.cost_in_usd_ticks)) : undefined,
    citations: Array.isArray(result.citations) && result.citations.length ? result.citations : undefined,
    webSearchCalls:
      Array.isArray(result.webSearchCalls) && result.webSearchCalls.length ? result.webSearchCalls : undefined,
  };
}
