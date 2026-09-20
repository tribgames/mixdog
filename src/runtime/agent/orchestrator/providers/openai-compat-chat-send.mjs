import { canFallbackNonStreaming, markProviderRecoveryExhausted, retryDelayLabel, withRetry } from './retry-classifier.mjs';
import { consumeCompatChatCompletionStream } from './openai-compat-stream.mjs';
import { getModelMetadataSync } from './model-catalog.mjs';
import { appendAgentTrace } from '../agent-trace.mjs';
import { providerRetryStatusText } from '../../../shared/err-text.mjs';
import { PROVIDER_FIRST_BYTE_TIMEOUT_MS, PROVIDER_GENERATE_TOTAL_TIMEOUT_MS, createPassthroughSignal } from '../stall-policy.mjs';
import { resolveCompatMaxOutputTokens, toOpenAIMessages, toOpenAITools, parseToolCalls, knownToolNamesFromOpenAITools, deepseekReplaysReasoningContent } from './openai-compat-wire.mjs';
import { applyCompatProviderChatOptions } from './openai-compat-options.mjs';
import { normalizeCompatChatResponse } from './openai-compat-response-normalization.mjs';
import { applyCompatToolChoice } from './compat-request-policy.mjs';
import { ensureChatToolPairs } from './lib/wire-pairing.mjs';
import { xaiCacheRouting } from './openai-compat-xai.mjs';

export async function sendCompatChat(provider, messages, useModel, tools, opts) {
  const signal = opts.signal || null;
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error('OpenAI-compat request aborted by session close');
  }
  const modelInfo =
    provider.name === 'opencode-go'
      ? provider.getCachedModelInfo(useModel) || getModelMetadataSync(useModel, provider.name)
      : null;
  const replaysReasoningContent =
    modelInfo?.reasoningContentField === 'reasoning_content' ||
    (provider.name === 'deepseek' && deepseekReplaysReasoningContent(useModel));
  const params = {
    model: useModel,
    // Wire-level pairing guard: a call whose result never committed
    // (cancel/abort) is hard-rejected unpaired, so synthesize the
    // missing tool messages here.
    messages: ensureChatToolPairs(toOpenAIMessages(messages, provider.name, { replaysReasoningContent })),
  };
  const maxOutputTokens = resolveCompatMaxOutputTokens(opts);
  if (maxOutputTokens) params.max_tokens = maxOutputTokens;
  if (tools?.length) params.tools = toOpenAITools(tools);
  applyCompatToolChoice(params, opts);
  applyCompatProviderChatOptions(params, provider.name, opts, provider.config, modelInfo);
  const totalSignal = createPassthroughSignal(signal);
  const cacheRouting = provider.name === 'xai' ? xaiCacheRouting(opts, params, tools || [], useModel) : null;
  const cacheRoutingKey = cacheRouting?.key || null;
  params.stream = true;
  params.stream_options = { include_usage: true };
  let assembled;
  try {
    try {
      assembled = await withRetry(
        async ({ signal: attemptSignal }) => {
          try {
            opts.onStageChange?.('requesting');
          } catch {
            /* heartbeat best-effort */
          }
          const stream = await withRetry(
            ({ signal: openSignal }) =>
              provider.client.chat.completions.create(params, {
                signal: openSignal,
                ...(opts.requestHeaders ? { headers: opts.requestHeaders } : {}),
              }),
            {
              signal: attemptSignal,
              // Single attempt: this inner wrapper exists only to
              // apply the first-byte per-attempt timeout. Retry is
              // owned by the outer withRetry — nesting retry loops
              // here multiplied tail latency (5x5).
              maxAttempts: 1,
              perAttemptTimeoutMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS,
              perAttemptLabel: `${provider.name} first byte`,
            }
          );
          try {
            opts.onStageChange?.('streaming');
          } catch {
            /* heartbeat best-effort */
          }
          try {
            return await consumeCompatChatCompletionStream(stream, {
              signal: attemptSignal,
              label: provider.name,
              onStreamDelta: opts.onStreamDelta,
              onToolCall: opts.onToolCall,
              onTextDelta: opts.onTextDelta,
              parseToolCalls,
              // Known tool names for the leaked-tool-call guard:
              // recovered leaked calls only synthesize when they name
              // a tool actually offered to this request.
              knownToolNames: knownToolNamesFromOpenAITools(params.tools),
            });
          } catch (error) {
            // Grok's reference sampler treats content-idle as a
            // terminal sampling decision, not a resample signal.
            if (provider.name === 'xai' && error?.streamStalled === true) {
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
              `[${provider.name}] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`
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
    } catch (streamErr) {
      const recovered = await provider._recoverCompatNonStreaming({
        streamErr,
        params,
        opts,
        signal: totalSignal.signal,
        useModel,
      });
      if (!recovered) throw streamErr;
      assembled = recovered;
    }
  } finally {
    totalSignal.cleanup();
  }
  return normalizeCompatChatResponse({
    providerName: provider.name,
    useModel,
    tools,
    opts,
    params,
    assembled,
    cacheRoutingKey,
    cacheRouting,
    replaysReasoningContent,
  });
}

export async function recoverCompatNonStreaming(provider, { streamErr, params, opts, signal, useModel }) {
  if (!canFallbackNonStreaming(streamErr, { signal })) return null;
  const nonStreamParams = { ...params, stream: false };
  delete nonStreamParams.stream_options;
  let response;
  try {
    try {
      opts.onStageChange?.('requesting');
    } catch {
      /* heartbeat best-effort */
    }
    response = await withRetry(
      ({ signal: attemptSignal }) =>
        provider.client.chat.completions.create(nonStreamParams, {
          signal: attemptSignal,
          ...(opts.requestHeaders ? { headers: opts.requestHeaders } : {}),
        }),
      {
        signal,
        maxAttempts: 1,
        // A non-streaming call returns only when generation is done,
        // so the first-byte bound would false-abort it.
        perAttemptTimeoutMs: PROVIDER_GENERATE_TOTAL_TIMEOUT_MS,
        perAttemptLabel: `${provider.name} non-streaming fallback`,
      }
    );
  } catch {
    return null;
  }
  const choice = response?.choices?.[0] || null;
  if (!choice) return null;
  const message = choice.message || {};
  let toolCalls;
  try {
    toolCalls = parseToolCalls(choice, provider.name);
  } catch {
    return null;
  }
  try {
    process.stderr.write(
      `[${provider.name}] stream failed (${streamErr?.code || streamErr?.message || 'unknown'}); ` +
        `recovered via non-streaming request\n`
    );
  } catch {
    /* best-effort */
  }
  try {
    appendAgentTrace({
      sessionId: opts?.sessionId || opts?.session?.id || null,
      iteration: Number.isFinite(Number(opts?.iteration)) ? Number(opts.iteration) : null,
      kind: 'transport_fallback',
      provider: provider.name,
      model: useModel,
      transport: 'non-streaming',
      payload: {
        from: 'stream',
        to: 'non-streaming',
        reason: streamErr?.retryClassifier || streamErr?.code || streamErr?.message || 'stream_failed',
        error_code: streamErr?.code || null,
        error_http_status: Number(streamErr?.httpStatus || streamErr?.status || 0) || null,
        error_classifier: streamErr?.retryClassifier || streamErr?.midstreamClassifier || null,
      },
    });
  } catch {
    /* best-effort */
  }
  return {
    response,
    model: response.model || useModel,
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls,
    stopReason: choice.finish_reason || null,
    reasoningContent: typeof message.reasoning_content === 'string' ? message.reasoning_content : null,
    rawUsage: response.usage || null,
  };
}
