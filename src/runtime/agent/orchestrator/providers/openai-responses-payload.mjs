// ChatGPT-backend Responses payload builders, extracted from openai-oauth.mjs.
/**
 * OpenAI ChatGPT OAuth subscription provider.
 *
 * Dispatches over the WebSocket upgrade of chatgpt.com/backend-api/codex/
 * responses (responses_websockets=2026-02-06 beta). Authenticates via PKCE
 * OAuth using Mixdog-owned token storage. Streaming/framing lives in
 * openai-oauth-ws.mjs; this file owns auth, model catalog, request-body
 * shape, and HTTP/SSE fallback when WebSocket transport is unhealthy.
 */
import { createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { getPluginData } from '../config.mjs';
import { enrichModels } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { writeJsonAtomicSync, withFileLock } from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { makeModelCache } from './model-cache.mjs';

import { sendViaWebSocket } from './openai-oauth-ws.mjs';
import { _combineUsageWithWarmup } from './openai-ws-events.mjs';
import { resolveOpenAiTransportPolicy } from './openai-transport-policy.mjs';
import {
    buildStableProviderPromptCacheKey,
    resolveProviderPromptCacheLane,
    resolveProviderCacheKey,
} from '../agent-runtime/cache-strategy.mjs';
import {
    appendAgentTrace,
    traceAgentFetch,
    traceAgentSse,
    traceAgentUsage,
} from '../agent-trace.mjs';
import {
    PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
    PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    streamStalledError,
    createTimeoutSignal,
    createPassthroughSignal,
} from '../stall-policy.mjs';
import { shouldFallbackTransport } from './retry-classifier.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { makeInvalidToolArgsMarker } from './openai-compat-stream.mjs';
import { createLeakGuard, createToolCallDedupe, dedupeToolCallList } from './anthropic-leaked-toolcall.mjs';
import {
    normalizeContentForOpenAIResponses,
    splitToolContentForOpenAIResponses,
} from './media-normalization.mjs';
import {
    customToolCallFromResponseItem,
    customToolInputFromArguments,
    isCustomToolCallRecord,
    isResponsesFreeformTool,
    nativeToolSearchCallInput,
    nativeToolSearchOutputInput,
    toResponsesCustomTool,
} from './custom-tool-wire.mjs';
import {
    sendViaHttpSse,
    _envFlag,
    _shouldUseOpenAIHttpFallback,
} from './openai-oauth-http-sse.mjs';
import { createOpenAIOAuthLogin } from './openai-oauth-login.mjs';
import { warmCodexClientVersion } from './codex-client-meta.mjs';
import {
    _displayCodexModel,
    _codexFamily,
    _normalizeCodexModel,
    _compareVersion,
    _isMainCodexFamily,
    _markLatestCodex,
    _codexUsesResponsesLite,
} from './openai-codex-model.mjs';

// Public test/integration entry retained alongside the transport module export.
// --- Constants ---

import { _findCachedCodexModel, codexModelSupportsServiceTier } from './openai-oauth.mjs';

function _contentTextParts(content, type = 'input_text') {
    if (typeof content === 'string') return content ? [{ type, text: content }] : [];
    if (!Array.isArray(content)) {
        const text = content == null ? '' : JSON.stringify(content);
        return text ? [{ type, text }] : [];
    }
    const out = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.text === 'string') {
            out.push({ type: item.type === 'output_text' ? 'output_text' : type, text: item.text });
        } else if (typeof item.content === 'string') {
            out.push({ type, text: item.content });
        }
    }
    return out;
}

/**
 * Convert a message slice to Responses API input items.
 */
export function convertMessagesToResponsesInput(messages, opts = {}) {
    const out = [];
    const pendingToolMedia = [];
    const customToolCallNameById = new Map();
    const replayEncryptedReasoning = opts.replayEncryptedReasoning === true;
    const wireParity = opts.codexWireParity === true;
    const wireMessageMetadata = opts.codexMessageMetadata
        && typeof opts.codexMessageMetadata === 'object'
        ? opts.codexMessageMetadata
        : {};
    const wireMessage = (role, content) => (wireParity
        ? {
            type: 'message',
            role,
            content,
            internal_chat_message_metadata_passthrough: wireMessageMetadata,
        }
        : { role, content });
    // `phase` replays each retained item on the side of the assistant text it
    // was emitted on, so the rebuilt turn keeps the response's own item order.
    const pushReasoningItems = (message, phase = 'before') => {
        if (!replayEncryptedReasoning || message?.role !== 'assistant' || !Array.isArray(message.reasoningItems)) return;
        for (const item of message.reasoningItems) {
            if ((item?.afterText === true) !== (phase === 'after')) continue;
            // Collector shape contract: the WS/HTTP stream collectors store
            // retained items as {id, encrypted_content, summary} WITHOUT a
            // type tag (openai-ws-stream pushReasoningItem). Requiring
            // type:'reasoning' here silently dropped every retained item, so
            // replay never actually fired. Accept untagged items; only an
            // explicit non-reasoning tag is rejected.
            if (!item || (item.type != null && item.type !== 'reasoning')) continue;
            if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) continue;
            out.push({
                type: 'reasoning',
                ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}),
                encrypted_content: item.encrypted_content,
                summary: Array.isArray(item.summary) ? item.summary : [],
            });
        }
    };
    const flushToolMedia = () => {
        if (!pendingToolMedia.length) return;
        out.push(wireMessage('user', pendingToolMedia.splice(0)));
    };
    for (const m of messages) {
        if (!m || m.role === 'system') continue;
        if (m.role === 'tool') {
            const { output, mediaContent } = splitToolContentForOpenAIResponses(m.content);
            if (customToolCallNameById.has(m.toolCallId || '')) {
                out.push({
                    type: 'custom_tool_call_output',
                    call_id: m.toolCallId || '',
                    name: customToolCallNameById.get(m.toolCallId || '') || undefined,
                    output,
                });
                if (mediaContent) pendingToolMedia.push(...mediaContent);
                continue;
            }
            const nativeSearchOutput = nativeToolSearchOutputInput(
                m,
                opts.nativeToolSearchProvider || 'openai-oauth',
            );
            if (nativeSearchOutput) {
                out.push(nativeSearchOutput);
                if (mediaContent) pendingToolMedia.push(...mediaContent);
                continue;
            }
            out.push({
                type: 'function_call_output',
                call_id: m.toolCallId || '',
                output,
            });
            if (mediaContent) pendingToolMedia.push(...mediaContent);
            continue;
        }
        flushToolMedia();
        pushReasoningItems(m, 'before');
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            // Default path deliberately omits reasoning replay: openai-oauth
            // rejects an `rs_*` item repeated inside the same stateful
            // handshake session_id. The explicit replay experiment pairs this
            // converter option with stateless HTTP headers, where the complete
            // retained conversation is the only continuation source.
            if (m.content) out.push(wireMessage('assistant', normalizeContentForOpenAIResponses(m.content, { role: 'assistant' })));
            pushReasoningItems(m, 'after');
            for (const tc of m.toolCalls) {
                const nativeSearchCall = nativeToolSearchCallInput(tc);
                if (nativeSearchCall) {
                    out.push(nativeSearchCall);
                } else if (isCustomToolCallRecord(tc)) {
                    if (tc.id) customToolCallNameById.set(tc.id, tc.name || '');
                    out.push({
                        type: 'custom_tool_call',
                        call_id: tc.id,
                        name: tc.name,
                        input: customToolInputFromArguments(tc.name, tc.arguments),
                    });
                } else {
                    out.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.name === 'tool_search' ? 'load_tool' : tc.name,
                        arguments: JSON.stringify(tc.arguments),
                    });
                }
            }
            continue;
        }
        out.push(wireMessage(
            m.role === 'assistant' ? 'assistant' : 'user',
            normalizeContentForOpenAIResponses(m.content, { role: m.role }),
        ));
        pushReasoningItems(m, 'after');
    }
    flushToolMedia();
    return out;
}

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

function _codexModelUsesResponsesLite(id, opts = {}) {
    if (typeof opts.useResponsesLite === 'boolean') return opts.useResponsesLite;
    const override = String(process.env.MIXDOG_OAI_RESPONSES_LITE || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(override)) return true;
    if (['0', 'false', 'no', 'off'].includes(override)) return false;
    const info = _findCachedCodexModel(id);
    return _codexUsesResponsesLite(id, info);
}

function _responsesLiteTools(tools) {
    const out = [];
    const functions = [];
    let functionsIndex = null;
    for (const tool of Array.isArray(tools) ? tools : []) {
        if (tool?.type === 'function' || tool?.type === 'custom') {
            if (functionsIndex == null) functionsIndex = out.length;
            functions.push(tool);
            continue;
        }
        if (tool?.type === 'namespace' && tool?.name === 'functions') {
            if (functionsIndex == null) functionsIndex = out.length;
            if (Array.isArray(tool.tools)) functions.push(...tool.tools);
            continue;
        }
        out.push(tool);
    }
    if (functions.length) {
        out.splice(functionsIndex, 0, {
            type: 'namespace',
            name: 'functions',
            description: '',
            tools: functions,
        });
    }
    return out;
}

export function buildCodexStartupPrewarmBody(body) {
    const input = Array.isArray(body?.input) ? body.input : [];
    const stableInput = [];
    if (input[0]?.type === 'additional_tools' && input[0]?.role === 'developer') {
        stableInput.push(input[0]);
        if (input[1]?.type === 'message' && input[1]?.role === 'developer') {
            stableInput.push(input[1]);
        }
    }
    return { ...body, input: stableInput, generate: false };
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
    const useResponsesLite = promptCacheProvider === 'openai-oauth'
        && _codexModelUsesResponsesLite(model, opts);
    // Recovery-only encrypted-reasoning replay is DEFAULT ON for the OAuth
    // backend (validated 2026-08-11: smoke wire parity on normal chains +
    // live full-frame acceptance + full-run A/B). The per-socket policy in
    // _applyReasoningReplayPolicy strips rs_* on live chains, so this only
    // changes recovery frames. MIXDOG_OAI_DISABLE_REASONING_REPLAY=1 is the
    // kill switch (wins over everything); explicit opts.replayEncryptedReasoning
    // still forces either direction for probes.
    const replayEncryptedReasoning = !_envFlag('MIXDOG_OAI_DISABLE_REASONING_REPLAY', false)
        && (opts.replayEncryptedReasoning === true
            || (opts.replayEncryptedReasoning !== false
                && promptCacheProvider === 'openai-oauth'));
    const input = convertMessagesToResponsesInput(messages, {
        providerState: opts.providerState,
        model,
        nativeToolSearchProvider: promptCacheProvider,
        replayEncryptedReasoning,
        codexWireParity: promptCacheProvider === 'openai-oauth',
        codexMessageMetadata: (opts.turnId || opts.turn_id)
            ? { turn_id: opts.turnId || opts.turn_id }
            : {},
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
                ? {
                    internal_chat_message_metadata_passthrough: (opts.turnId || opts.turn_id)
                        ? { turn_id: opts.turnId || opts.turn_id }
                        : {},
                }
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
            effort: _normalizeReasoningEffort(opts.effort),
            ...(supportsReasoningSummary ? { summary: 'auto' } : {}),
            ...(useResponsesLite ? { context: 'all_turns' } : {}),
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
    const liteTools = useResponsesLite ? _responsesLiteTools(toolsList || []) : null;
    const wireInput = useResponsesLite
        ? [
            {
                type: 'additional_tools',
                role: 'developer',
                tools: liteTools,
            },
            ...(instructions
                ? [{
                    type: 'message',
                    role: 'developer',
                    content: [{ type: 'input_text', text: instructions }],
                }]
                : []),
            ...input,
        ]
        : input;
    if (useResponsesLite) body.parallel_tool_calls = false;
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
        ...(!useResponsesLite ? { instructions: body.instructions } : {}),
        input: wireInput,
        ...(!useResponsesLite && toolsList ? { tools: toolsList } : {}),
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
    // NOTE: prompt_cache_retention is a public OpenAI Responses API parameter,
    // but the openai-oauth endpoint still rejects it ("Unsupported parameter:
    // prompt_cache_retention", re-probed 2026-06-22). Leave retention on the
    // openai-oauth server default; public OpenAI direct injects 24h separately.
    return ordered;
}

// --- Provider ---
