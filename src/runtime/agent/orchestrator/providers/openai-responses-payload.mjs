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
import { populateHttpStatusFromMessage, shouldFallbackTransport } from './retry-classifier.mjs';
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
} from './openai-codex-model.mjs';

// Public test/integration entry retained alongside the transport module export.
// --- Constants ---

import { _findCachedCodexModel, codexModelSupportsServiceTier } from './openai-oauth.mjs';

export function _contentTextParts(content, type = 'input_text') {
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
    const wireParity = process.env.MIXDOG_OAI_CODEX_WIRE_PARITY === '1';
    const wireMessage = (role, content) => (wireParity
        ? { type: 'message', role, content, internal_chat_message_metadata_passthrough: {} }
        : { role, content });
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
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            // Reasoning replay deliberately omitted: openai-oauth rejects an
            // `rs_*` reasoning item with the same id across the same
            // handshake session_id (in-memory conversation state lives
            // for the WS_IDLE_MS window even after a socket close).
            // Server-side state already preserves the prefix; sending
            // reasoning in `input` triggers "Duplicate item".
            if (m.content) out.push(wireMessage('assistant', normalizeContentForOpenAIResponses(m.content, { role: 'assistant' })));
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

// codex build_reasoning() (core/src/client.rs:785-805) only attaches the
// reasoning object when model_info.supports_reasoning_summaries; models
// without summary support get NO reasoning field at all. Mirror that via the
// cached codex catalog; unknown models default to true (gpt-5 family all
// support summaries) so a cold catalog cannot strip reasoning from the wire.
export function _codexModelSupportsReasoningSummaries(id) {
    const info = _findCachedCodexModel(id);
    if (!info) return true;
    const flags = [info.supportsReasoningSummaries, info.supports_reasoning_summaries, info.supportsReasoning, info.supports_reasoning];
    for (const flag of flags) {
        if (typeof flag === 'boolean') return flag;
    }
    return true;
}

// codex reasoning_effort_for_request (core/src/client.rs): `ultra` collapses to
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
    const systemMsgs = messages.filter(m => m.role === 'system');
    const instructions = systemMsgs.map(m => m.content).join('\n\n') || 'You are a helpful assistant.';
    const opts = sendOpts || {};
    const input = convertMessagesToResponsesInput(messages, {
        providerState: opts.providerState,
        model,
        nativeToolSearchProvider: opts.promptCacheProvider || 'openai-oauth',
    });
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
    // Field order MIRRORS codex-rs ResponsesApiRequest (common.rs struct order):
    // model, instructions, input, tools, tool_choice, parallel_tool_calls,
    // reasoning, store, stream, include, service_tier, prompt_cache_key, text.
    // JSON serialization order is load-bearing for the server prompt cache
    // (exact-prefix match): matching codex's byte layout keeps our requests on
    // the same cache-routing shape codex warms. tools/service_tier/
    // prompt_cache_key are appended below in the same relative order.
    const body = {
        model,
        instructions,
        input,
        tool_choice: opts.toolChoice || 'auto',
        parallel_tool_calls: true,
        // codex build_reasoning() sends { effort, summary } — summary defaults to
        // ReasoningSummary::Auto (protocol config_types.rs), serialized lowercase
        // as "auto". Matching this keeps our reasoning object byte-identical to
        // codex so the server prompt-cache prefix hash lines up. codex also
        // normalizes `ultra` -> `max` on the wire (reasoning_effort_for_request
        // in core/src/client.rs); the openai-oauth backend does not accept
        // `ultra` as a wire value, so mirror that mapping here.
        // WIRE-VERIFIED (codex desktop logs_2.sqlite, 40 response.create
        // captures, 2026-07-03): codex sends reasoning as {"effort":"..."}
        // with NO summary field on gpt-5.5, regardless of what the repo's
        // build_reasoning() suggests. Match the observed bytes.
        reasoning: { effort: _normalizeReasoningEffort(opts.effort) },
        store: process.env.MIXDOG_OAI_STORE === 'true' ? true : false,
        stream: true,
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
    const promptCacheProvider = opts.promptCacheProvider || 'openai-oauth';
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
    // parallel_tool_calls, reasoning, store, stream, include, service_tier,
    // prompt_cache_key, text. service_tier is only present when fast set it.
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
