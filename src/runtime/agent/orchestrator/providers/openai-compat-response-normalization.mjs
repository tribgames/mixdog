import { grokCacheChainTraceFields, traceAgentUsage } from '../agent-trace.mjs';
import { extractCompatCachedTokens } from './openai-compat-trace.mjs';
import { collectCompatResponseSearchSources } from './openai-compat-wire.mjs';
import {
  traceXaiResponsesCacheContext,
  writeCompatCacheTrace,
  writeXaiResponsesCacheTrace,
} from './openai-compat-xai.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';

export function compatReportedCostUsd(providerName, usage) {
  if (providerName === 'openrouter') {
    const cost = Number(usage?.cost);
    return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
  }
  if (providerName === 'xai') {
    const ticks = Number(usage?.cost_in_usd_ticks);
    return Number.isFinite(ticks) && ticks >= 0 ? Number((ticks * 1e-10).toFixed(8)) : undefined;
  }
  return undefined;
}

export const costUsdFromTicks = (ticks) =>
  typeof ticks === 'number' && ticks >= 0 ? Number((ticks * 1e-10).toFixed(8)) : undefined;

export const withCostUsd = (usage, costUsd) => ({ ...usage, ...(costUsd != null ? { costUsd } : {}) });

function messageCountOf(messages) {
  return Array.isArray(messages) ? messages.length : 0;
}

export function chatCompletionUsage(providerName, usage) {
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  return withCostUsd(
    {
      inputTokens: input,
      outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      cachedTokens: extractCompatCachedTokens(usage),
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
      promptTokens: inputTokens,
      raw: { ...usage },
    },
    costUsdFromTicks(usage.cost_in_usd_ticks)
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
}) {
  const response = assembled.response;
  const choice = response.choices[0];
  const toolCalls = assembled.toolCalls;
  const stopReason = choice?.finish_reason || null;
  if (
    (stopReason === 'length' && Array.isArray(toolCalls) && toolCalls.length > 0) ||
    stopReason === 'content_filter'
  ) {
    const err = Object.assign(new Error(`${providerName} response incomplete: finish_reason=${stopReason}`), {
      name: 'ProviderIncompleteError',
      code: 'PROVIDER_INCOMPLETE',
      providerIncomplete: true,
      finishReason: stopReason,
      partialContent: choice?.message?.content || '',
      partialToolCalls: toolCalls,
      model: response.model || useModel,
      responseId: response.id || null,
      rawUsage: response.usage || null,
    });
    throw err;
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
    const cachedTokens = extractCompatCachedTokens(response.usage);
    traceAgentUsage({
      sessionId: opts.sessionId || opts.session?.id || null,
      iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
      inputTokens,
      outputTokens: Number(response.usage.completion_tokens ?? response.usage.output_tokens ?? 0),
      cachedTokens,
      cacheWriteTokens: 0,
      promptTokens: inputTokens,
      model: response.model || useModel,
      modelDisplay: response.model || useModel,
      responseId: response.id || null,
      rawUsage: response.usage,
      provider: providerName,
    });
  }
  const capturesReasoningContent =
    providerName === 'deepseek' || providerName === 'xai' || providerName === 'mixdog-local' || replaysReasoningContent;
  const reasoningContent =
    capturesReasoningContent && typeof assembled.reasoningContent === 'string' ? assembled.reasoningContent : null;
  const reasoningDetails =
    providerName === 'openrouter' && Array.isArray(choice?.message?.reasoning_details)
      ? choice.message.reasoning_details
      : null;
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
    ...(reasoningDetails?.length
      ? {
          providerMetadata: { openrouter: { reasoning_details: reasoningDetails } },
        }
      : {}),
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
  writeXaiResponsesCacheTrace({
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
  traceXaiResponsesCacheContext({
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
    const cachedTokens = extractCompatCachedTokens(response.usage);
    const cacheChain = grokCacheChainTraceFields(opts.providerState, previousResponseId, continuationResetReason);
    traceAgentUsage({
      sessionId: opts.sessionId || opts.session?.id || null,
      iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
      inputTokens,
      outputTokens: Number(response.usage.output_tokens ?? response.usage.completion_tokens ?? 0),
      cachedTokens,
      cacheWriteTokens: 0,
      promptTokens: inputTokens,
      model: response.model || useModel,
      modelDisplay: response.model || useModel,
      responseId: response.id || null,
      rawUsage: response.usage,
      provider: 'xai',
      requestPrevResponseId: cacheChain.requestPrevResponseId,
      chainContinuous: cacheChain.chainContinuous,
      continuationResetReason: cacheChain.continuationResetReason,
    });
  }
  const nextPreviousResponseId = response.id;
  const encryptedReasoningItems = encryptedXaiReasoningItems(response.output);
  const providerReplay = createProviderReplay('xai-responses', response.output);
  const encryptedReasoningHistory = [
    ...(Array.isArray(opts.providerState?.xaiResponses?.encryptedReasoningHistory)
      ? opts.providerState.xaiResponses.encryptedReasoningHistory
      : []),
    ...(encryptedReasoningItems.length
      ? [{ messageIndex: messageCountOf(messages), items: encryptedReasoningItems }]
      : []),
  ];
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
        responseId: nextPreviousResponseId,
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
  const nextPreviousResponseId = responseId;
  const encryptedReasoningItems = encryptedXaiReasoningItems(result.responseItems);
  const providerReplay = createProviderReplay('xai-responses', result.responseItems);
  const encryptedReasoningHistory = [
    ...(Array.isArray(opts.providerState?.xaiResponses?.encryptedReasoningHistory)
      ? opts.providerState.xaiResponses.encryptedReasoningHistory
      : []),
    ...(encryptedReasoningItems.length
      ? [{ messageIndex: messageCountOf(messages), items: encryptedReasoningItems }]
      : []),
  ];
  const rawUsage = result.usage?.raw || result.usage || null;
  const traceParams = result.__warmup?.requestBody || params;
  const response = {
    id: responseId,
    model: result.model || useModel,
    output: [],
    usage: rawUsage,
  };
  writeXaiResponsesCacheTrace({
    model: useModel,
    opts,
    params: traceParams,
    rawTools: tools || [],
    response,
    cacheRouting,
    previousResponseId,
    inputStartIndex: startIndex,
    continuationResetReason,
    transport: 'websocket',
    cacheLane,
  });
  traceXaiResponsesCacheContext({
    model: useModel,
    opts,
    params: traceParams,
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
    // P1 audit fix: same truncated signal as the HTTP path (see
    // _doSendXaiResponses above) for the WebSocket transport.
    ...(result.stopReason === 'length' && (result.content || '').length > 0 ? { truncated: true } : {}),
    providerReplay,
    providerState: {
      ...(opts.providerState || {}),
      xaiResponses: {
        previousResponseId: null,
        responseId: nextPreviousResponseId,
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
