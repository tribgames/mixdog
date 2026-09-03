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
import { providerRetryStatusText } from '../../../shared/err-text.mjs';
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

// providerState slot + providerReplay tag. Distinct from the xAI slot so a
// provider switch never replays foreign encrypted items into this gateway.
export const COMPAT_RESPONSES_STATE_KEY = 'compatResponses';
export const COMPAT_RESPONSES_REPLAY_PROVIDER = 'openai-responses';

function encryptedReasoningItems(output) {
    if (!Array.isArray(output)) return [];
    return output
        .filter((item) => item?.type === 'reasoning' && typeof item?.encrypted_content === 'string' && item.encrypted_content)
        .map((item) => ({ ...item }));
}

function resolveReasoningEffort(provider, useModel, opts) {
    const modelInfo = (typeof provider.getCachedModelInfo === 'function' && provider.getCachedModelInfo(useModel))
        || getModelMetadataSync(useModel, provider.name);
    return normalizeOpencodeGoReasoningEffort(opts.effort ?? provider.config?.reasoningEffort, modelInfo);
}

/**
 * Send one turn over `POST {baseURL}/responses` (streaming) using the
 * provider's existing OpenAI SDK client. Returns the same result shape as
 * the chat/completions path so the agent loop stays wire-agnostic.
 */
export async function sendCompatResponses(provider, messages, useModel, tools, opts = {}) {
    const signal = opts.signal || null;
    if (signal?.aborted) {
        const reason = signal.reason;
        throw reason instanceof Error ? reason : new Error(`${provider.name} Responses request aborted by session close`);
    }
    const label = `${provider.name}:responses`;
    const { input, previousResponseId, continuationResetReason } = toXaiResponsesInput(
        messages,
        opts.providerState,
        {
            model: useModel,
            stateKey: COMPAT_RESPONSES_STATE_KEY,
            replayProvider: COMPAT_RESPONSES_REPLAY_PROVIDER,
        },
    );
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
    const reasoningEffort = resolveReasoningEffort(provider, useModel, opts);
    if (reasoningEffort) params.reasoning = { effort: reasoningEffort };

    try { opts.onStageChange?.('requesting'); } catch { /* heartbeat best-effort */ }
    const totalSignal = createPassthroughSignal(signal);
    let streamed;
    try {
        streamed = await withRetry(
            async ({ signal: attemptSignal }) => {
                const stream = await withRetry(
                    ({ signal: openSignal }) => provider.client.responses.create(params, { signal: openSignal }),
                    {
                        signal: attemptSignal,
                        maxAttempts: 1,
                        perAttemptTimeoutMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS,
                        perAttemptLabel: `${label} first byte`,
                    },
                );
                try { opts.onStageChange?.('streaming'); } catch { /* heartbeat best-effort */ }
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
                onRetry: ({ attempt, maxAttempts, lastErr, delayMs, delayReason }) => {
                    const delayLabel = Number.isFinite(Number(delayMs)) ? `, delay ${delayMs}ms${delayReason ? ` (${delayReason})` : ''}` : '';
                    process.stderr.write(`[${label}] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`);
                    try {
                        opts.onStageChange?.('reconnecting', {
                            attempt: attempt + 1,
                            max: maxAttempts,
                            waitMs: delayMs,
                            classifier: lastErr?.retryClassifier || lastErr?.code || null,
                            message: providerRetryStatusText(lastErr, { attempt: attempt + 1, maxAttempts, delayMs }),
                        });
                    } catch { /* display-only */ }
                },
            },
        );
    } finally {
        totalSignal.cleanup();
    }
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
    const reasoningItems = encryptedReasoningItems(response?.output);
    const priorState = opts.providerState?.[COMPAT_RESPONSES_STATE_KEY];
    const encryptedReasoningHistory = [
        ...(Array.isArray(priorState?.encryptedReasoningHistory) ? priorState.encryptedReasoningHistory : []),
        ...(reasoningItems.length
            ? [{ messageIndex: Array.isArray(messages) ? messages.length : 0, items: reasoningItems }]
            : []),
    ];
    const searchSources = collectCompatResponseSearchSources(response);
    // Gateway `cost` is a decimal-string USD figure when present.
    const gatewayCost = Number(usage?.cost);
    return {
        content: streamed.content,
        model: response?.model || useModel,
        toolCalls: streamed.toolCalls,
        stopReason: streamed.stopReason || null,
        ...(streamed.stopReason === 'length' && (streamed.content || '').length > 0 ? { truncated: true } : {}),
        citations: searchSources.citations.length ? searchSources.citations : undefined,
        webSearchCalls: searchSources.webSearchCalls.length ? searchSources.webSearchCalls : undefined,
        providerReplay: createProviderReplay(COMPAT_RESPONSES_REPLAY_PROVIDER, response?.output),
        providerState: {
            ...(opts.providerState || {}),
            [COMPAT_RESPONSES_STATE_KEY]: {
                previousResponseId: null,
                responseId: response?.id || null,
                store: false,
                encryptedReasoningItems: reasoningItems,
                encryptedReasoningHistory,
                seenMessageCount: Array.isArray(messages) ? messages.length : 0,
                model: useModel,
                updatedAt: Date.now(),
            },
        },
        usage: usage ? {
            inputTokens,
            outputTokens,
            cachedTokens,
            promptTokens: inputTokens,
            raw: { ...usage },
            ...(Number.isFinite(gatewayCost) && gatewayCost >= 0 ? { costUsd: gatewayCost } : {}),
        } : undefined,
    };
}
