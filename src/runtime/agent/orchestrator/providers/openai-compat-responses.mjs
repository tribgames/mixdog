// Generic OpenAI Responses HTTP/SSE transport for OpenAI-compatible gateway
// providers. The xAI Responses path in openai-compat.mjs carries xAI-only
// cache-lane routing and trace context; gateway brands
// that merely speak the Responses wire (OpenCode Go: Muse Spark, GPT, Grok)
// need the plain request shape only. Stateless continuation (store:false +
// encrypted reasoning replay) mirrors the reference OpenAI client so multi-
// turn tool loops keep the model's reasoning chain without server storage.

import { markProviderRecoveryExhausted, withRetry } from './retry-classifier.mjs';
import { compatRetryOptions, withCompatRetryProfile } from './openai-compat-retry-profile.mjs';
import { consumeCompatResponsesStream } from './openai-compat-stream.mjs';
import { getModelMetadataSync } from './model-catalog.mjs';
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
  xaiSystemInstructions,
} from './openai-compat-wire.mjs';
import { nativeDeferredFamilyForRoute } from './wire-route.mjs';
import { preparePdfTextForProvider } from './media-normalization.mjs';
import { normalizeOpencodeGoReasoningEffort } from './openai-compat-xai.mjs';
import { isCustomProviderName, resolveCustomReasoning } from './custom-reasoning.mjs';
import { projectEffortConfiguration, withEffortConfigurationFallback } from './effort-configuration.mjs';
import { normalizeCacheKey } from '../agent-runtime/cache-strategy.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { splitTailReminder } from './lib/tail-reminder-split.mjs';
import {
  applyCompatToolChoice,
  compatResponsesReplayProvider,
  compatStreamRetryReporter,
} from './compat-request-policy.mjs';
import {
  encryptedXaiReasoningItems,
  responsesUsage,
  traceCompatResponseUsage,
} from './openai-compat-response-normalization.mjs';

// providerState slot + providerReplay tag. Distinct from the xAI slot so a
// provider switch never replays foreign encrypted items into this gateway.
const COMPAT_RESPONSES_STATE_KEY = 'compatResponses';

// The request's `reasoning` field, or null. Custom providers snap onto their
// own model row (never promoting); gateway brands keep the catalog promotion.
function resolveReasoning(provider, useModel, opts) {
  const effort = opts.effort ?? provider.config?.reasoningEffort;
  const cached = (typeof provider.getCachedModelInfo === 'function' && provider.getCachedModelInfo(useModel)) || null;
  if (isCustomProviderName(provider.name)) {
    return resolveCustomReasoning({ protocol: 'openai-responses', model: cached, effort }).fields.reasoning || null;
  }
  const modelInfo = cached || getModelMetadataSync(useModel, provider.name);
  const reasoningEffort = normalizeOpencodeGoReasoningEffort(effort, modelInfo);
  return reasoningEffort ? { effort: reasoningEffort } : null;
}

/**
 * A custom route's mid-conversation effort projection (GPT-6+ on this wire)
 * with every effort in the row's wire value, or null for the per-request
 * effort. Consecutive efforts sharing one wire value collapse into none; an
 * effort the row cannot serve falls back to the per-request effort.
 */
function customEffortProjection(provider, useModel, messages, opts) {
  if (!isCustomProviderName(provider.name)) return null;
  const projection = projectEffortConfiguration(messages, provider.name, useModel, {
    ...provider.config,
    ...opts,
    protocol: 'openai-responses',
  });
  if (!projection) return null;
  const model = provider.getCachedModelInfo?.(useModel) || null;
  const wire = (effort) =>
    resolveCustomReasoning({ protocol: 'openai-responses', model, effort }).fields.reasoning?.effort || null;
  const initialEffort = wire(projection.initialEffort);
  if (!initialEffort) return null;
  const updates = new Map();
  let current = initialEffort;
  for (const [message, effort] of projection.updates) {
    const value = wire(effort);
    if (!value) return null;
    if (value !== current) {
      current = value;
      updates.set(message, value);
    }
  }
  return { ...projection, initialEffort, effort: current, updates };
}

// Whether the endpoint takes `prompt_cache_key`. An explicit
// `opts.responsesPromptCacheKey` / `config.responsesPromptCacheKey` boolean
// decides; otherwise only custom routes (which always had it) send it.
function supportsPromptCacheKey(provider, opts) {
  const declared = opts.responsesPromptCacheKey ?? provider.config?.responsesPromptCacheKey;
  return typeof declared === 'boolean' ? declared : isCustomProviderName(provider.name);
}

// Native Responses items (tool_search_call/output, custom_tool_call/output) in
// replayed history are strictly opt-in: only a route that declares
// `responsesNativeItems: true` (opts or config) gets the first-party lowering.
// Every other route keeps the function-only lowering byte for byte.
function supportsNativeResponsesItems(provider, opts) {
  return (
    (opts.responsesNativeItems ?? provider.config?.responsesNativeItems) === true ||
    hasNativeDeferredTools(provider, opts)
  );
}

// A session whose pinned route verified native deferred tools on the Responses
// wire (flag off in every PROFILES entry today): tool_search is declared
// natively and loaded tools replay as tool_search_output.
function hasNativeDeferredTools(provider, opts) {
  return nativeDeferredFamilyForRoute(provider.name, opts.wireRoute ?? opts.session?.wireRoute) === 'openai';
}

/**
 * A route's session identity: its prompt_cache_key and (custom routes) session
 * headers, '' without a session. The session wins over the provider-scoped
 * cache key, so parallel sessions never evict each other; a one-shot role
 * ('shared' scope, a fresh session per call) keys on the provider key instead.
 * Never the effort, so an effort change keeps the cache routing.
 */
function customSessionCacheKey(provider, opts) {
  if (!supportsPromptCacheKey(provider, opts)) return '';
  const explicit = opts.promptCacheKey || opts.providerCacheKey || opts.session?.promptCacheKey;
  return normalizeCacheKey(
    opts.promptCacheScope === 'shared' ? explicit || opts.sessionId : opts.sessionId || explicit
  );
}

// HTTP header names are case-insensitive. Do not shadow explicit SDK
// defaults, combine differently-cased identities, or stringify null deletions.
function customSessionHeaders(provider, sessionCacheKey, requestHeaders) {
  if (!sessionCacheKey) return requestHeaders;
  const headers = { 'session-id': sessionCacheKey, 'x-client-request-id': sessionCacheKey };
  const clientOptions = provider.config?.clientOptions || {};
  const configured = Object.hasOwn(clientOptions, 'defaultHeaders')
    ? clientOptions.defaultHeaders
    : provider.defaultHeaders;
  const entries = (source) =>
    source instanceof Headers || Array.isArray(source) ? source : Object.entries(source || {});
  const hasValue = (value) => (Array.isArray(value) ? value.some((item) => item !== undefined) : value !== undefined);
  for (const source of [configured, requestHeaders]) {
    for (const [name, value] of entries(source)) {
      if (hasValue(value)) delete headers[name.toLowerCase()];
    }
  }
  if (requestHeaders instanceof Headers) {
    const merged = new Headers(requestHeaders);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return merged;
  }
  if (Array.isArray(requestHeaders)) return [...Object.entries(headers), ...requestHeaders];
  const supplied = Object.fromEntries(Object.entries(requestHeaders || {}).filter(([, value]) => hasValue(value)));
  return { ...headers, ...supplied };
}

/** The request body: lowered transcript plus the per-turn knobs (output cap,
 *  tools and tool choice, reasoning effort, session cache key). */
function buildCompatResponsesParams({
  provider,
  useModel,
  input,
  previousResponseId,
  tools,
  opts,
  instructions,
  effortProjection,
  sessionCacheKey,
}) {
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
    params.tools = toResponsesTools(tools, {
      provider: provider.name,
      onToolExcluded: opts.onToolExcluded,
      ...(hasNativeDeferredTools(provider, opts) ? { nativeDeferredTools: true } : {}),
    });
    params.parallel_tool_calls = true;
  }
  applyCompatToolChoice(params, opts);
  // A projected conversation keeps its initial effort on top; changes ride as input items.
  const reasoning = effortProjection
    ? { effort: effortProjection.initialEffort }
    : resolveReasoning(provider, useModel, opts);
  if (reasoning) params.reasoning = reasoning;
  // Opt-in system-as-instructions: set before the hook so the hook can override it.
  if (instructions) params.instructions = instructions;
  if (sessionCacheKey) params.prompt_cache_key = sessionCacheKey;
  // Opt-in per-provider final shaping (a provider passes the hook in its config).
  const hook = provider.config?.responsesParamsHook;
  if (typeof hook === 'function') {
    const modelInfo =
      (typeof provider.getCachedModelInfo === 'function' && provider.getCachedModelInfo(useModel)) || null;
    hook(params, { useModel, opts, modelInfo });
  }
  return params;
}

/**
 * Open the stream and consume it, under two nested retry budgets: an inner
 * first-byte attempt (single try, own timeout) and the outer transport retry
 * that re-opens the request. A content-idle stall is terminal for this
 * transport, so it is marked recovery-exhausted rather than retried.
 */
async function streamCompatResponses({ provider, params, label, signal, opts, headers }) {
  const totalSignal = createPassthroughSignal(signal);
  try {
    return await withRetry(
      withCompatRetryProfile(provider.name, async ({ signal: attemptSignal }) => {
        const stream = await withRetry(
          ({ signal: openSignal }) =>
            provider.client.responses.create(params, {
              signal: openSignal,
              ...(headers ? { headers } : {}),
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
            sessionId: opts.sessionId,
            onStreamDelta: opts.onStreamDelta,
            onToolCall: opts.onToolCall,
            onTextDelta: opts.onTextDelta,
            onStreamItemStart: opts.onStreamItemStart,
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
      }),
      {
        signal: totalSignal.signal,
        onRetry: compatStreamRetryReporter(label, opts),
        retry529: opts.retry529,
        ...compatRetryOptions(provider.name),
      }
    );
  } finally {
    totalSignal.cleanup();
  }
}

// OpenRouter's Responses endpoint is stateless: it does not store responses or
// resolve `previous_response_id`. Imported server-side continuation state (a
// previous id, or a stored response) is rejected up front rather than sent.
function assertOpenRouterStateless(provider, opts) {
  if (provider.name !== 'openrouter') return;
  const imported = opts.providerState?.[COMPAT_RESPONSES_STATE_KEY];
  const previous = typeof imported?.previousResponseId === 'string' && imported.previousResponseId !== '';
  if (!previous && imported?.store !== true) return;
  throw Object.assign(
    new Error(
      'openrouter Responses is stateless: imported previous_response_id / store:true continuation state is not supported'
    ),
    { code: 'OPENROUTER_RESPONSES_STATELESS_ONLY', provider: provider.name }
  );
}

/**
 * Send one turn over `POST {baseURL}/responses` (streaming) using the
 * provider's existing OpenAI SDK client. Returns the same result shape as
 * the chat/completions path so the agent loop stays wire-agnostic. A custom
 * route whose model rejects the mid-conversation effort update is replayed
 * once with the per-request effort.
 */
export function sendCompatResponses(provider, messages, useModel, tools, opts = {}) {
  const send = (sendOpts) => sendCompatResponsesOnce(provider, messages, useModel, tools, sendOpts);
  if (!isCustomProviderName(provider.name)) return send(opts);
  return withEffortConfigurationFallback(provider.name, useModel, opts, send);
}

async function sendCompatResponsesOnce(provider, requestMessages, useModel, tools, opts) {
  // The continuation state below is indexed by transcript position
  // (seenMessageCount, reasoning messageIndex): the ephemeral tail reminder is
  // not part of the transcript, so it is lifted off here and appended to the
  // wire input last.
  const { messages: transcript, reminder } = splitTailReminder(requestMessages);
  let messages = transcript;
  const replayProvider = compatResponsesReplayProvider(provider.name);
  const signal = opts.signal || null;
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error(`${provider.name} Responses request aborted by session close`);
  }
  const label = `${provider.name}:responses`;
  messages = await preparePdfTextForProvider(messages, provider);
  assertOpenRouterStateless(provider, opts);
  const effortProjection = customEffortProjection(provider, useModel, messages, opts);
  const sessionCacheKey = customSessionCacheKey(provider, opts);
  const { input, previousResponseId, continuationResetReason } = toXaiResponsesInput(messages, opts.providerState, {
    effortProjection,
    model: useModel,
    stateKey: COMPAT_RESPONSES_STATE_KEY,
    replayProvider,
    providerName: provider.name,
    nativeLowering: supportsNativeResponsesItems(provider, opts),
    nativePdf: provider.nativePdf,
    // Opt-in: system prompts travel as top-level `instructions`, not input items.
    includeSystem: provider.config?.responsesSystemAsInstructions !== true,
  });
  const instructions = provider.config?.responsesSystemAsInstructions === true ? xaiSystemInstructions(messages) : '';
  if (reminder) input.push({ role: 'user', content: [{ type: 'input_text', text: reminder }] });
  const params = buildCompatResponsesParams({
    provider,
    useModel,
    input,
    previousResponseId,
    tools,
    opts,
    instructions,
    effortProjection,
    sessionCacheKey,
  });
  // The session identity also travels as headers; caller headers win.
  // Custom routes only: a gateway route that opts into prompt_cache_key keeps
  // its own headers.
  const headers = isCustomProviderName(provider.name)
    ? customSessionHeaders(provider, sessionCacheKey, opts.requestHeaders)
    : opts.requestHeaders;

  try {
    opts.onStageChange?.('requesting');
  } catch {
    /* heartbeat best-effort */
  }
  const streamed = await streamCompatResponses({ provider, params, label, signal, opts, headers });
  const response = streamed.response;
  const usage = response?.usage || null;
  const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  const cachedTokens = usage ? extractCompatCachedTokens(usage) : 0;
  if (usage) {
    traceCompatResponseUsage({
      opts,
      provider: provider.name,
      model: useModel,
      response,
      inputTokens,
      outputTokens,
      cachedTokens,
      requestPrevResponseId: previousResponseId || null,
      continuationResetReason: continuationResetReason || null,
    });
  }
  const reasoningItems = encryptedXaiReasoningItems(response?.output);
  const priorState = opts.providerState?.[COMPAT_RESPONSES_STATE_KEY];
  const messageIndex = Array.isArray(messages) ? messages.length : 0;
  const encryptedReasoningHistory = [
    ...(Array.isArray(priorState?.encryptedReasoningHistory) ? priorState.encryptedReasoningHistory : []),
    ...(reasoningItems.length ? [{ messageIndex, items: reasoningItems, owner: replayProvider }] : []),
  ];
  const searchSources = collectCompatResponseSearchSources(response);
  const usageSummary = usage ? responsesUsage(usage) : undefined;
  return {
    content: streamed.content,
    model: response?.model || useModel,
    toolCalls: streamed.toolCalls,
    stopReason: streamed.stopReason || null,
    ...(streamed.refusal ? { refusal: streamed.refusal } : {}),
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
        owner: replayProvider,
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
