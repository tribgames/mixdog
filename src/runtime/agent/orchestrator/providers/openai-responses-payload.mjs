// Shared public API and OAuth Responses payload construction.
import { projectEffortConfiguration } from './effort-configuration.mjs';
import { convertMessagesToResponsesInput } from './openai-responses-input.mjs';
export { convertMessagesToResponsesInput } from './openai-responses-input.mjs';
import {
    buildStableProviderPromptCacheKey,
    resolveProviderPromptCacheLane,
} from '../agent-runtime/cache-strategy.mjs';
import {
    isResponsesFreeformTool,
    toResponsesCustomTool,
} from './custom-tool-wire.mjs';
import { _envFlag } from './openai-oauth-http-sse.mjs';
import { _findCachedCodexModel, codexModelSupportsServiceTier } from './openai-oauth.mjs';

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
    };
}

export const _convertMessagesToResponsesInputForTest = convertMessagesToResponsesInput;

// The reference client only attaches the
// reasoning object when model_info.supports_reasoning_summaries; models
// without summary support get NO reasoning field at all. Mirror that via the
// cached codex catalog; unknown models default to true (gpt-5 family all
// support summaries) so a cold catalog cannot strip reasoning from the wire.
function _codexModelSupportsReasoningSummaries(id) {
    const info = _findCachedCodexModel(id);
    if (!info) return true;
    const flags = [info.supportsReasoningSummaries, info.supports_reasoning_summaries, info.supportsReasoning, info.supports_reasoning];
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
    const e = String(effort || '').trim().toLowerCase();
    if (!e) return 'medium';
    if (e === 'ultra') return 'max';
    return e;
}

export function buildRequestBody(messages, model, tools, sendOpts) {
    // codex reasoning_effort_for_request: `ultra` collapses to `max` on the
    // wire (the only remap; every other effort passes through). Default medium.
    // Kept inline (not a module const) so buildRequestBody stays self-contained.
    // Extract system/instructions
    // The volatile environment block (session header, cwd, shell startup
    // capabilities) is per-session BY DEFINITION, so leaving it inside
    // `instructions` makes the cached prefix unique to a single session and
    // nothing can ever be shared. Measured 2026-08-21 on 8 parallel bench
    // sessions: the first 10,408 bytes of `instructions` were byte-identical
    // and only these lines differed, yet all 8 sessions paid a full cold
    // prefix (0 cached tokens on every first call). The reference client keeps
    // instructions static and delivers the same information as a leading
    // <environment_context> input item; mirror that split here. Anthropic and
    // Gemini paths are untouched — they consume the env block as its own
    // unmarked system block.
    const systemMsgs = messages.filter(m => m.role === 'system');
    const environmentMsgs = systemMsgs.filter(m => m?.cacheTier === 'env');
    const prefixSystemMsgs = environmentMsgs.length
        ? systemMsgs.filter(m => m?.cacheTier !== 'env')
        : systemMsgs;
    const instructions = prefixSystemMsgs.map(m => m.content).join('\n\n') || 'You are a helpful assistant.';
    const environmentText = environmentMsgs
        .map(m => (typeof m.content === 'string' ? m.content : ''))
        .filter(Boolean)
        .join('\n\n---\n\n');
    const opts = sendOpts || {};
    const promptCacheProvider = opts.promptCacheProvider || 'openai-oauth';
    const effortProjection = projectEffortConfiguration(messages, promptCacheProvider, model, opts);
    // Both OpenAI routes retain reasoning in full logical history. Delta
    // transport strips an anchored response; recovery/full-frame sends need the
    // original items. Preserve explicit opt-out and the existing kill switch.
    const replayEncryptedReasoning = !_envFlag('MIXDOG_OAI_DISABLE_REASONING_REPLAY', false)
        && (opts.replayEncryptedReasoning === true
            || (opts.replayEncryptedReasoning !== false
                && (promptCacheProvider === 'openai-oauth' || promptCacheProvider === 'openai')));
    const input = convertMessagesToResponsesInput(messages, {
        effortProjection,
        providerState: opts.providerState,
        model,
        nativeToolSearchProvider: promptCacheProvider,
        replayEncryptedReasoning,
        codexWireParity: promptCacheProvider === 'openai-oauth',
    });
    if (environmentText) {
        // Leading input item, after the cached prefix instead of inside it.
        // convertMessagesToResponsesInput skips every system message, so this
        // is the only copy on the wire — the information reaches the model
        // unchanged, just one position later.
        input.unshift({
            type: 'message',
            role: 'user',
            content: [{
                type: 'input_text',
                text: `<environment_context>\n${environmentText}\n</environment_context>`,
            }],
            ...(promptCacheProvider === 'openai-oauth'
                ? { internal_chat_message_metadata_passthrough: {} }
                : {}),
        });
    }
    // Match the request body shape the OAuth backend expects so the
    // server-side auto-cache routes correctly. text.verbosity / include /
    // tool_choice / parallel_tool_calls are all inert without side effects
    // for most callers but their presence affects how the OAuth backend classifies the
    // request (and therefore whether the prompt cache is consulted).
    const include = ['reasoning.encrypted_content'];
    for (const item of Array.isArray(opts.nativeInclude) ? opts.nativeInclude : []) {
        const value = String(item || '').trim();
        if (value && !include.includes(value)) include.push(value);
    }
    const supportsReasoningSummary = _codexModelSupportsReasoningSummaries(model);
    // Field order MIRRORS the reference request struct:
    // model, instructions, input, tools, tool_choice, parallel_tool_calls,
    // reasoning, store, stream, stream_options, include, service_tier,
    // prompt_cache_key, text.
    // JSON serialization order is load-bearing for the server prompt cache
    // (exact-prefix match): matching that byte layout keeps our requests on
    // the same cache-routing shape the backend warms. tools/service_tier/
    // prompt_cache_key are appended below in the same relative order.
    const body = {
        model,
        instructions,
        input,
        tool_choice: opts.toolChoice || 'auto',
        parallel_tool_calls: true,
        // The reference client sends { effort, summary } — summary defaults
        // to "auto" (lowercase on the wire). Matching this keeps our
        // reasoning object byte-identical so the server prompt-cache prefix
        // hash lines up. `ultra` is normalized to `max` on the wire too; the
        // openai-oauth backend does not accept `ultra` as a wire value, so
        // mirror that mapping here.
        // WIRE-VERIFIED (40 response.create captures, 2026-07-03): the wire
        // carries reasoning as {"effort":"..."} with NO summary field on
        // gpt-5.5. Match the observed bytes.
        reasoning: {
            effort: _normalizeReasoningEffort(effortProjection?.initialEffort ?? opts.effort),
            ...(supportsReasoningSummary ? { summary: 'auto' } : {}),
        },
        store: process.env.MIXDOG_OAI_STORE === 'true' ? true : false,
        stream: true,
        ...(promptCacheProvider === 'openai-oauth' && supportsReasoningSummary
            ? {
                stream_options: {
                    reasoning_summary_delivery: 'sequential_cutoff',
                },
            }
            : {}),
        include,
    };
    const maxOutputTokens = Number(opts.maxOutputTokens ?? opts.outputTokens ?? opts.max_output_tokens);
    if (_envFlag('MIXDOG_OPENAI_OAUTH_SEND_MAX_OUTPUT_TOKENS', false)
        && Number.isFinite(maxOutputTokens)
        && maxOutputTokens > 0) {
        body.max_output_tokens = Math.floor(maxOutputTokens);
    }
    if (opts.fast === true) {
        // 'priority' is the only fast-class value the OpenAI OAuth backend
        // accepts on the wire: 'fast' is hard-rejected ("Unsupported
        // service_tier: fast", probed 2026-06-11). Only send the request value
        // when the model catalog advertises it.
        if (codexModelSupportsServiceTier(model, 'priority')) {
            body.service_tier = 'priority';
        }
    }
    // Add tools. `nativeTools` are server-hosted Responses tools (for
    // example web_search) and must be passed through without wrapping them as
    // function tools. codex places `tools` right after `input` (before
    // tool_choice); we insert it there via a rebuilt object so serialization
    // order matches, rather than appending it last.
    const functionTools = tools?.length ? tools.map(toOpenAIResponsesTool) : [];
    const nativeTools = Array.isArray(opts.nativeTools)
        ? opts.nativeTools.filter(t => t && typeof t === 'object')
        : [];
    const toolsList = (functionTools.length || nativeTools.length)
        ? [...nativeTools, ...functionTools]
        : null;
    const promptCacheLane = opts.promptCacheLane || resolveProviderPromptCacheLane(promptCacheProvider, opts);
    const promptCacheKey = buildStableProviderPromptCacheKey(promptCacheProvider, opts, {
        model,
        instructions,
        tools: toolsList || [],
        effort: body.reasoning?.effort,
        fast: opts.fast === true,
        serviceTier: body.service_tier || '',
        toolChoice: body.tool_choice,
        parallelToolCalls: body.parallel_tool_calls,
        cacheLaneSlot: promptCacheLane.slot,
        cacheLaneShards: promptCacheLane.shards,
    });
    // WIRE-VERIFIED (codex desktop logs, 2026-07-03): every live gpt-5.5
    // response.create carries text:{"verbosity":"low"} (or a schema variant);
    // none omit the field. Default to codex's observed "low", allow override.
    const verbosity = (typeof opts.verbosity === 'string' && opts.verbosity.trim()
        ? opts.verbosity.trim().toLowerCase()
        : null) || 'low';
    // Rebuild the body in codex struct order so JSON serialization is
    // byte-compatible with codex: ... input, tools, tool_choice,
    // parallel_tool_calls, reasoning, store, stream, stream_options, include,
    // service_tier, prompt_cache_key, text. service_tier is only present when
    // fast set it.
    const ordered = {
        model: body.model,
        instructions: body.instructions,
        input: body.input,
        ...(toolsList ? { tools: toolsList } : {}),
        tool_choice: body.tool_choice,
        parallel_tool_calls: body.parallel_tool_calls,
        reasoning: body.reasoning,
        store: body.store,
        stream: body.stream,
        ...(body.stream_options ? { stream_options: body.stream_options } : {}),
        include: body.include,
        ...(body.service_tier ? { service_tier: body.service_tier } : {}),
        prompt_cache_key: promptCacheKey,
        text: { verbosity },
        ...(body.max_output_tokens ? { max_output_tokens: body.max_output_tokens } : {}),
    };
    // Cache lifetime fields are public-API/model-specific. The direct provider
    // adds them separately; OAuth keeps its backend defaults.
    return ordered;
}

// --- Provider ---
