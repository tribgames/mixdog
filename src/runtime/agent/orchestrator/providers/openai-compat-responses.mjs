// Generic OpenAI Responses HTTP/SSE transport for OpenAI-compatible gateway
// providers. The xAI Responses path in openai-compat.mjs carries xAI-only
// cache-lane routing, warmup accounting, and trace context; gateway brands
// that merely speak the Responses wire (OpenCode Go: Muse Spark, GPT, Grok)
// need the plain request shape only. Stateless continuation (store:false +
// encrypted reasoning replay) mirrors the reference OpenAI client so multi-
// turn tool loops keep the model's reasoning chain without server storage.

import { markProviderRecoveryExhausted, withRetry } from './retry-classifier.mjs';
import { consumeCompatResponsesStream } from './openai-compat-stream.mjs';
import { getModelMetadataSync } from './model-catalog.mjs';
import { traceAgentUsage } from '../agent-trace.mjs';
import { PROVIDER_FIRST_BYTE_TIMEOUT_MS, createPassthroughSignal } from '../stall-policy.mjs';
import { extractCompatCachedTokens } from './openai-compat-trace.mjs';
import {
  resolveCompatMaxOutputTokens,
  toResponsesTools,
  knownToolNamesFromResponsesTools,
  parseResponsesToolCalls,
  responseOutputText,
  collectCompatResponseSearchSources,
  toXaiResponsesInput,
} from './openai-compat-wire.mjs';
import { normalizeOpencodeGoReasoningEffort } from './openai-compat-xai.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import {
  applyCompatToolChoice,
  compatResponsesReplayProvider,
  compatStreamRetryReporter,
} from './compat-request-policy.mjs';
import { encryptedXaiReasoningItems } from './openai-compat-response-normalization.mjs';

// providerState slot + providerReplay tag. Distinct from the xAI slot so a
// provider switch never replays foreign encrypted items into this gateway.
const COMPAT_RESPONSES_STATE_KEY = 'compatResponses';

function resolveReasoningEffort(provider, useModel, opts) {
  const modelInfo =
    (typeof provider.getCachedModelInfo === 'function' && provider.getCachedModelInfo(useModel)) ||
    getModelMetadataSync(useModel, provider.name);
  return normalizeOpencodeGoReasoningEffort(opts.effort ?? provider.config?.reasoningEffort, modelInfo);
}

/** The request body: lowered transcript plus the per-turn knobs (output cap,
 *  tools and tool choice, reasoning effort). */
function buildCompatResponsesParams({ provider, useModel, input, previousResponseId, tools, opts }) {
  const params = {
    model: useModel,
    input,
    store: false,
    include: ['reasoning.encrypted_content'],
    stream: true,
  };
  if (previousResponseId) params.previous_response_id = previousResponseId;
  const maxOutputTokens = resolveCompatMaxOutputTokens(opts);
  if (maxOutputTokens) params.max_output_tokens = maxOutputTokens;
  if (tools?.length) {
    params.tools = toResponsesTools(tools, { provider: provider.name });
    params.parallel_tool_calls = true;
  }
  applyCompatToolChoice(params, opts);
  const reasoningEffort = resolveReasoningEffort(provider, useModel, opts);
  if (reasoningEffort) params.reasoning = { effort: reasoningEffort };
  return params;
}

/**
 * Open the stream and consume it, under two nested retry budgets: an inner
 * first-byte attempt (single try, own timeout) and the outer transport retry
 * that re-opens the request. A content-idle stall is terminal for this
 * transport, so it is marked recovery-exhausted rather than retried.
 */
async function streamCompatResponses({ provider, params, label, signal, opts }) {
  const totalSignal = createPassthroughSignal(signal);
  try {
    return await withRetry(
      async ({ signal: attemptSignal }) => {
        const stream = await withRetry(
          ({ signal: openSignal }) =>
            provider.client.responses.create(params, {
              signal: openSignal,
              ...(opts.requestHeaders ? { headers: opts.requestHeaders } : {}),
            }),
          {
            signal: attemptSignal,
            maxAttempts: 1,
            perAttemptTimeoutMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS,
            perAttemptLabel: `${label} first byte`,
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
            label,
            onStreamDelta: opts.onStreamDelta,
            onToolCall: opts.onToolCall,
            onTextDelta: opts.onTextDelta,
            parseResponsesToolCalls,
            responseOutputText,
            knownToolNames: knownToolNamesFromResponsesTools(params.tools),
          });
        } catch (error) {
          if (error?.streamStalled === true) {
            throw markProviderRecoveryExhausted(error, { owner: `${provider.name}-content-idle-policy` });
          }
          throw error;
        }
      },
      {
        signal: totalSignal.signal,
        onRetry: compatStreamRetryReporter(label, opts),
      }
    );
  } finally {
    totalSignal.cleanup();
  }
}

/**
 * Send one turn over `POST {baseURL}/responses` (streaming) using the
 * provider's existing OpenAI SDK client. Returns the same result shape as
 * the chat/completions path so the agent loop stays wire-agnostic.
 */
export async function sendCompatResponses(provider, messages, useModel, tools, opts = {}) {
  const replayProvider = compatResponsesReplayProvider(provider.name);
  const signal = opts.signal || null;
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error(`${provider.name} Responses request aborted by session close`);
  }
  const label = `${provider.name}:responses`;
  const { input, previousResponseId, continuationResetReason } = toXaiResponsesInput(messages, opts.providerState, {
    model: useModel,
    stateKey: COMPAT_RESPONSES_STATE_KEY,
    replayProvider,
  });
  const params = buildCompatResponsesParams({ provider, useModel, input, previousResponseId, tools, opts });

  try {
    opts.onStageChange?.('requesting');
  } catch {
    /* heartbeat best-effort */
  }
  const streamed = await streamCompatResponses({ provider, params, label, signal, opts });
  const response = streamed.response;
  const usage = response?.usage || null;
  const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  const cachedTokens = usage ? extractCompatCachedTokens(usage) : 0;
  if (usage) {
    traceAgentUsage({
      sessionId: opts.sessionId || opts.session?.id || null,
      iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens: 0,
      promptTokens: inputTokens,
      model: response.model || useModel,
      modelDisplay: response.model || useModel,
      responseId: response.id || null,
      rawUsage: usage,
      provider: provider.name,
      requestPrevResponseId: previousResponseId || null,
      continuationResetReason: continuationResetReason || null,
    });
  }
  const reasoningItems = encryptedXaiReasoningItems(response?.output);
  const priorState = opts.providerState?.[COMPAT_RESPONSES_STATE_KEY];
  const messageIndex = Array.isArray(messages) ? messages.length : 0;
  const encryptedReasoningHistory = [
    ...(Array.isArray(priorState?.encryptedReasoningHistory) ? priorState.encryptedReasoningHistory : []),
    ...(reasoningItems.length ? [{ messageIndex, items: reasoningItems }] : []),
  ];
  const searchSources = collectCompatResponseSearchSources(response);
  // Gateway `cost` is a decimal-string USD figure when present.
  const gatewayCost = Number(usage?.cost);
  const usageSummary = usage
    ? { inputTokens, outputTokens, cachedTokens, promptTokens: inputTokens, raw: { ...usage } }
    : undefined;
  if (usageSummary && Number.isFinite(gatewayCost) && gatewayCost >= 0) usageSummary.costUsd = gatewayCost;
  return {
    content: streamed.content,
    model: response?.model || useModel,
    toolCalls: streamed.toolCalls,
    stopReason: streamed.stopReason || null,
    ...(streamed.stopReason === 'length' && (streamed.content || '').length > 0 ? { truncated: true } : {}),
    citations: searchSources.citations.length ? searchSources.citations : undefined,
    webSearchCalls: searchSources.webSearchCalls.length ? searchSources.webSearchCalls : undefined,
    providerReplay: createProviderReplay(replayProvider, response?.output),
    providerState: {
      ...(opts.providerState || {}),
      [COMPAT_RESPONSES_STATE_KEY]: {
        previousResponseId: null,
        responseId: response?.id || null,
        store: false,
        encryptedReasoningItems: reasoningItems,
        encryptedReasoningHistory,
        seenMessageCount: messageIndex,
        model: useModel,
        updatedAt: Date.now(),
      },
    },
    usage: usageSummary,
  };
}
