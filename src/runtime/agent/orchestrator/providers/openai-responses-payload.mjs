// Shared public API and OAuth Responses payload construction.
import { projectEffortConfiguration } from './effort-configuration.mjs';
import { convertMessagesToResponsesInput } from './openai-responses-input.mjs';
export { convertMessagesToResponsesInput } from './openai-responses-input.mjs';
import { buildStableProviderPromptCacheKey, resolveProviderPromptCacheLane } from '../agent-runtime/cache-strategy.mjs';
import { isResponsesFreeformTool, toResponsesCustomTool, responsesToolLoadingSurface } from './custom-tool-wire.mjs';
import { _envFlag } from './openai-oauth-http-sse.mjs';
import { findCachedCodexModel, codexModelSupportsServiceTier } from './openai-oauth-catalog.mjs';

export function toOpenAIResponsesTool(t) {
  if (t?.name === 'load_tool' || t?.name === 'tool_search') {
    return {
      type: 'tool_search',
      execution: 'client',
      description: t.description,
      parameters: t.inputSchema,
    };
  }
  if (isResponsesFreeformTool(t)) return toResponsesCustomTool(t);
  return {
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  };
}

export const _convertMessagesToResponsesInputForTest = convertMessagesToResponsesInput;

// The reference client only attaches the
// reasoning object when model_info.supports_reasoning_summaries; models
// without summary support get NO reasoning field at all. Mirror that via the
// cached codex catalog; unknown models default to true (gpt-5 family all
// support summaries) so a cold catalog cannot strip reasoning from the wire.
function _codexModelSupportsReasoningSummaries(id) {
  const info = findCachedCodexModel(id);
  if (!info) return true;
  const flags = [
    info.supportsReasoningSummaries,
    info.supports_reasoning_summaries,
    info.supportsReasoning,
    info.supports_reasoning,
  ];
  for (const flag of flags) {
    if (typeof flag === 'boolean') return flag;
  }
  return true;
}

export function buildCodexStartupPrewarmBody(body) {
  return { ...body, input: [], generate: false };
}

// Effort normalization: `ultra` collapses to
// `max` on the wire — the openai-oauth backend does not accept `ultra`. Every
// other effort passes through unchanged; empty/unknown falls back to medium.
export function _normalizeReasoningEffort(effort) {
  const e = String(effort || '')
    .trim()
    .toLowerCase();
  if (!e) return 'medium';
  if (e === 'ultra') return 'max';
  return e;
}

// Keep volatile environment context outside the shared instruction prefix.
// It remains runtime instruction context, not another user request. Other
// providers retain their existing system-block representation.
function responsesInstructions(messages) {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const environmentMsgs = systemMsgs.filter((m) => m?.cacheTier === 'env');
  const prefixSystemMsgs = environmentMsgs.length ? systemMsgs.filter((m) => m?.cacheTier !== 'env') : systemMsgs;
  return {
    instructions: prefixSystemMsgs.map((m) => m.content).join('\n\n') || 'You are a helpful assistant.',
    environmentText: environmentMsgs
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n\n---\n\n'),
  };
}

// Conversion skips system messages. Preserve the environment block's
// instruction role when placing its sole wire copy before the user's actual
// task.
function environmentContextItem(environmentText, promptCacheProvider) {
  return {
    type: 'message',
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text: `<environment_context>\n${environmentText}\n</environment_context>`,
      },
    ],
    ...(promptCacheProvider === 'openai-oauth' ? { internal_chat_message_metadata_passthrough: {} } : {}),
  };
}

function responsesInclude(opts) {
  const include = ['reasoning.encrypted_content'];
  for (const item of Array.isArray(opts.nativeInclude) ? opts.nativeInclude : []) {
    const value = String(item || '').trim();
    if (value && !include.includes(value)) include.push(value);
  }
  return include;
}

// `nativeTools` are server-hosted Responses tools (for example web_search)
// and must be passed through without wrapping them as function tools.
function responsesToolsList(tools, opts) {
  const functionTools = tools?.length ? responsesToolLoadingSurface(tools).map(toOpenAIResponsesTool) : [];
  const nativeTools = Array.isArray(opts.nativeTools) ? opts.nativeTools.filter((t) => t && typeof t === 'object') : [];
  return functionTools.length || nativeTools.length ? [...nativeTools, ...functionTools] : null;
}

function requestedMaxOutputTokens(opts) {
  const maxOutputTokens = Number(opts.maxOutputTokens ?? opts.outputTokens ?? opts.max_output_tokens);
  const send =
    _envFlag('MIXDOG_OPENAI_OAUTH_SEND_MAX_OUTPUT_TOKENS', false) &&
    Number.isFinite(maxOutputTokens) &&
    maxOutputTokens > 0;
  return send ? Math.floor(maxOutputTokens) : null;
}

// 'priority' is the only fast-class value the OpenAI OAuth backend accepts
// on the wire: 'fast' is hard-rejected ("Unsupported service_tier: fast",
// probed 2026-06-11). Only send the request value when the model catalog
// advertises it.
function requestedServiceTier(model, opts) {
  return opts.fast === true && codexModelSupportsServiceTier(model, 'priority') ? 'priority' : '';
}

// Both OpenAI routes retain reasoning in full logical history. Delta
// transport strips an anchored response; recovery/full-frame sends need the
// original items. Preserve explicit opt-out and the existing kill switch.
function replaysEncryptedReasoning(opts, promptCacheProvider) {
  return (
    !_envFlag('MIXDOG_OAI_DISABLE_REASONING_REPLAY', false) &&
    (opts.replayEncryptedReasoning === true ||
      (opts.replayEncryptedReasoning !== false &&
        (promptCacheProvider === 'openai-oauth' || promptCacheProvider === 'openai')))
  );
}

// The reference client sends { effort, summary } — summary defaults to
// "auto" (lowercase on the wire). Matching this keeps our reasoning object
// byte-identical so the server prompt-cache prefix hash lines up. `ultra`
// is normalized to `max` on the wire too; the openai-oauth backend does not
// accept `ultra` as a wire value, so mirror that mapping here.
// WIRE-VERIFIED (40 response.create captures, 2026-07-03): the wire
// carries reasoning as {"effort":"..."} with NO summary field on gpt-5.5.
function responsesReasoningFields(model, effortProjection, opts, promptCacheProvider) {
  const supportsReasoningSummary = _codexModelSupportsReasoningSummaries(model);
  return {
    reasoning: {
      effort: _normalizeReasoningEffort(effortProjection?.initialEffort ?? opts.effort),
      ...(supportsReasoningSummary ? { summary: 'auto' } : {}),
    },
    streamOptions:
      promptCacheProvider === 'openai-oauth' && supportsReasoningSummary
        ? { reasoning_summary_delivery: 'sequential_cutoff' }
        : null,
  };
}

// WIRE-VERIFIED (codex desktop logs, 2026-07-03): every live gpt-5.5
// response.create carries text:{"verbosity":"low"} (or a schema variant);
// none omit the field. Default to codex's observed "low", allow override.
function requestedVerbosity(opts) {
  return (
    (typeof opts.verbosity === 'string' && opts.verbosity.trim() ? opts.verbosity.trim().toLowerCase() : null) || 'low'
  );
}

// The stable prompt cache key over everything that shapes the request prefix.
function responsesPromptCacheKey(promptCacheProvider, opts, { model, instructions, toolsList, effort, serviceTier, toolChoice }) {
  const promptCacheLane = opts.promptCacheLane || resolveProviderPromptCacheLane(promptCacheProvider, opts);
  return buildStableProviderPromptCacheKey(promptCacheProvider, opts, {
    model,
    instructions,
    tools: toolsList || [],
    effort,
    fast: opts.fast === true,
    serviceTier,
    toolChoice,
    parallelToolCalls: true,
    cacheLaneSlot: promptCacheLane.slot,
    cacheLaneShards: promptCacheLane.shards,
  });
}

export function buildRequestBody(messages, model, tools, sendOpts) {
  const { instructions, environmentText } = responsesInstructions(messages);
  const opts = sendOpts || {};
  const promptCacheProvider = opts.promptCacheProvider || 'openai-oauth';
  const effortProjection = projectEffortConfiguration(messages, promptCacheProvider, model, opts);
  const input = convertMessagesToResponsesInput(messages, {
    effortProjection,
    providerState: opts.providerState,
    model,
    nativeToolSearchProvider: promptCacheProvider,
    replayEncryptedReasoning: replaysEncryptedReasoning(opts, promptCacheProvider),
    codexWireParity: promptCacheProvider === 'openai-oauth',
  });
  if (environmentText) input.unshift(environmentContextItem(environmentText, promptCacheProvider));
  const { reasoning, streamOptions } = responsesReasoningFields(model, effortProjection, opts, promptCacheProvider);
  const serviceTier = requestedServiceTier(model, opts);
  const maxOutputTokens = requestedMaxOutputTokens(opts);
  const toolChoice = opts.toolChoice || 'auto';
  const toolsList = responsesToolsList(tools, opts);
  const promptCacheKey = responsesPromptCacheKey(promptCacheProvider, opts, {
    model,
    instructions,
    toolsList,
    effort: reasoning.effort,
    serviceTier,
    toolChoice,
  });
  const verbosity = requestedVerbosity(opts);
  // Match the request body shape the OAuth backend expects so the
  // server-side auto-cache routes correctly: text.verbosity / include /
  // tool_choice / parallel_tool_calls are inert for most callers but their
  // presence affects how the backend classifies the request (and therefore
  // whether the prompt cache is consulted). Field order MIRRORS the codex
  // request struct — model, instructions, input, tools, tool_choice,
  // parallel_tool_calls, reasoning, store, stream, stream_options, include,
  // service_tier, prompt_cache_key, text — because JSON serialization order
  // is load-bearing for the server prompt cache (exact-prefix match).
  // service_tier is only present when fast set it. Cache lifetime fields are
  // public-API/model-specific: the direct provider adds them separately,
  // OAuth keeps its backend defaults.
  return {
    model,
    instructions,
    input,
    ...(toolsList ? { tools: toolsList } : {}),
    tool_choice: toolChoice,
    parallel_tool_calls: true,
    reasoning,
    store: process.env.MIXDOG_OAI_STORE === 'true',
    stream: true,
    ...(streamOptions ? { stream_options: streamOptions } : {}),
    include: responsesInclude(opts),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    prompt_cache_key: promptCacheKey,
    text: { verbosity },
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
  };
}

// --- Provider ---
