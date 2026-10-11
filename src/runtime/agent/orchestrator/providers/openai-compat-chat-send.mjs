import { canFallbackNonStreaming, markProviderRecoveryExhausted, withRetry } from './retry-classifier.mjs';
import { consumeCompatChatCompletionStream } from './openai-compat-stream.mjs';
import { getModelMetadataSync } from './model-catalog.mjs';
import { noteErrorUsage } from './lib/note-error-usage.mjs';
import { traceNonStreamingFallback } from './lib/transport-fallback-trace.mjs';
import {
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_GENERATE_TOTAL_TIMEOUT_MS,
  createPassthroughSignal,
} from '../stall-policy.mjs';
import {
  resolveCompatMaxOutputTokens,
  toOpenAIMessages,
  toOpenAITools,
  parseToolCalls,
  knownToolNamesFromOpenAITools,
  deepseekReplaysReasoningContent,
} from './openai-compat-wire.mjs';
import { applyCompatProviderChatOptions } from './openai-compat-options.mjs';
import { normalizeCompatChatResponse } from './openai-compat-response-normalization.mjs';
import { applyCompatToolChoice, compatStreamRetryReporter } from './compat-request-policy.mjs';
import { ensureChatToolPairs } from './lib/wire-pairing.mjs';
import { xaiCacheRouting } from './openai-compat-xai.mjs';
import { preparePdfTextForProvider } from './media-normalization.mjs';
import { isCustomProviderName, resolveCustomReasoning } from './custom-reasoning.mjs';

export async function sendCompatChat(provider, messages, useModel, tools, opts) {
  const signal = opts.signal || null;
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error('OpenAI-compat request aborted by session close');
  }
  const isCustom = isCustomProviderName(provider.name);
  // Opt-in per-provider wire profile (config.chatProfile): only a wrapper that
  // sets it gets the extra hooks below; every other provider is untouched.
  const profile = provider.config?.chatProfile || null;
  // Custom providers read only their own model rows: a same-id model in the
  // global catalog must not shape a user-defined endpoint's request.
  let modelInfo = null;
  if (isCustom) modelInfo = provider.getCachedModelInfo(useModel) || null;
  else if (provider.name === 'opencode-go')
    modelInfo = provider.getCachedModelInfo(useModel) || getModelMetadataSync(useModel, provider.name);
  else if (profile?.resolveModelInfo) modelInfo = profile.resolveModelInfo(provider, useModel) || null;
  // Resolved before lowering: replay eligibility depends on the snapped level
  // (thinking disabled → nothing to replay).
  const customReasoning = isCustom
    ? resolveCustomReasoning({
        protocol: 'openai-chat',
        model: modelInfo,
        effort: opts.effort ?? provider.config?.reasoningEffort,
      })
    : null;
  const replaysReasoningContent = isCustom
    ? customReasoning.replay
    : modelInfo?.reasoningContentField === 'reasoning_content' ||
      profile?.replaysReasoningContent === true ||
      (provider.name === 'deepseek' && deepseekReplaysReasoningContent(useModel));
  messages = await preparePdfTextForProvider(messages, provider);
  const params = {
    model: useModel,
    // Wire-level pairing guard: a call whose result never committed
    // (cancel/abort) is hard-rejected unpaired, so synthesize the
    // missing tool messages here.
    messages: ensureChatToolPairs(
      toOpenAIMessages(messages, provider.name, {
        replaysReasoningContent,
        ...(isCustom ? { customReplay: customReasoning.replay } : {}),
        nativePdf: provider.nativePdf,
      })
    ),
  };
  const maxOutputTokens = resolveCompatMaxOutputTokens(opts);
  if (maxOutputTokens) params.max_tokens = maxOutputTokens;
  if (tools?.length) params.tools = toOpenAITools(tools);
  applyCompatToolChoice(params, opts);
  applyCompatProviderChatOptions(params, provider.name, opts, provider.config, modelInfo);
  profile?.applyParams?.(params, { opts, config: provider.config, modelInfo });
  const firstByteTimeoutMs = profile?.firstByteTimeoutMs || PROVIDER_FIRST_BYTE_TIMEOUT_MS;
  const totalSignal = createPassthroughSignal(signal);
  const cacheRouting = provider.name === 'xai' ? xaiCacheRouting(opts, params, tools || [], useModel) : null;
  const cacheRoutingKey = cacheRouting?.key || null;
  params.stream = true;
  params.stream_options = { include_usage: true };
  let assembled;
  try {
    try {
      assembled = await withRetry(
        refineAttemptErrors(profile, async ({ signal: attemptSignal }) => {
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
              perAttemptTimeoutMs: firstByteTimeoutMs,
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
              providerName: provider.name,
              onStreamDelta: opts.onStreamDelta,
              onToolCall: opts.onToolCall,
              onTextDelta: opts.onTextDelta,
              parseToolCalls,
              // Known tool names for the leaked-tool-call guard:
              // recovered leaked calls only synthesize when they name
              // a tool actually offered to this request.
              knownToolNames: knownToolNamesFromOpenAITools(params.tools),
              ...(profile?.firstByteTimeoutMs ? { firstByteTimeoutMs: profile.firstByteTimeoutMs } : {}),
              ...(profile?.semanticIdleTimeoutMs ? { semanticIdleTimeoutMs: profile.semanticIdleTimeoutMs } : {}),
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
        }),
        {
          signal: totalSignal.signal,
          onRetry: compatStreamRetryReporter(provider.name, opts),
          retry529: opts.retry529,
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

// Opt-in: a provider profile may rewrite an attempt's error (gateway detail,
// permanent-failure stamps) before the retry classifier sees it.
function refineAttemptErrors(profile, attempt) {
  if (typeof profile?.refineError !== 'function') return attempt;
  return async (ctx) => {
    try {
      return await attempt(ctx);
    } catch (error) {
      throw profile.refineError(error) || error;
    }
  };
}

export async function recoverCompatNonStreaming(provider, { streamErr, params, opts, signal, useModel }) {
  if (!canFallbackNonStreaming(streamErr, { signal })) return null;
  noteErrorUsage(streamErr);
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
  traceNonStreamingFallback({ provider: provider.name, model: useModel, opts, streamErr });
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
