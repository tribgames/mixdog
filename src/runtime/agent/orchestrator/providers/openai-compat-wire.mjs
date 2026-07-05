/**
 * openai-compat-wire.mjs — message/tool wire conversion + response parsing for
 * the OpenAI-compat provider.
 *
 * Extracted from openai-compat.mjs. Pure (stateless) converters between the
 * agent's internal message/tool shape and the OpenAI Chat Completions /
 * Responses API wire shapes, plus the response tool-call / text / search-source
 * parsers. No provider instance state; openai-compat.mjs imports these entry
 * points and re-exports the ones its tests/importers reference.
 */
import {
    parseCompletedToolCallArgumentsJson,
} from './openai-compat-stream.mjs';
import {
    normalizeContentForOpenAIChat,
    normalizeContentForOpenAIResponses,
    splitToolContentForOpenAIChat,
    splitToolContentForOpenAIResponses,
} from './media-normalization.mjs';
import {
    customToolCallFromResponseItem,
} from './custom-tool-wire.mjs';

export function positiveTokenInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function resolveCompatMaxOutputTokens(opts = {}) {
    return positiveTokenInt(
        opts.maxOutputTokens
        ?? opts.outputTokens
        ?? opts.max_output_tokens
        ?? opts.maxTokens
        ?? opts.max_tokens,
    );
}

export function toOpenAIMessages(messages, providerName, options = {}) {
    // NOTE: chat.completions has no equivalent slot for replaying reasoning
    // encrypted_content the way the Responses API does (no `type:'reasoning'`
    // input item). Whatever reasoningItems may be attached to assistant
    // messages by the openai-oauth provider is intentionally dropped here —
    // strict providers (xai) reject unknown roles/types and would 400 the
    // request. Documented in v0.1.160 (GPT reasoning replay).
    //
    // DeepSeek thinking models require the prior turn's `reasoning_content`
    // string to be echoed back inside the assistant message, otherwise the API
    // returns 400. xAI reasoning models also preserve their official multi-turn
    // shape and cache prefix stability when prior assistant reasoning_content
    // is replayed; reasoning_effort itself remains caller/user-selected.
    const replaysReasoningContent = options.replaysReasoningContent === true
        || providerName === 'deepseek'
        || providerName === 'xai';
    const out = [];
    const pendingToolMedia = [];
    const flushToolMedia = () => {
        if (!pendingToolMedia.length) return;
        out.push({ role: 'user', content: pendingToolMedia.splice(0) });
    };
    for (const m of messages) {
        if (m.role === 'tool') {
            const { output, mediaContent } = splitToolContentForOpenAIChat(m.content);
            out.push({
                role: 'tool',
                tool_call_id: m.toolCallId || '',
                content: output,
            });
            if (mediaContent) pendingToolMedia.push(...mediaContent);
            continue;
        }
        flushToolMedia();
        if (m.role === 'assistant' && m.toolCalls?.length) {
            const msg = {
                role: 'assistant',
                content: normalizeContentForOpenAIChat(m.content, { role: 'assistant' }) || null,
                tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
            };
            if (replaysReasoningContent && m.reasoningContent) msg.reasoning_content = m.reasoningContent;
            out.push(msg);
            continue;
        }
        if (m.role === 'assistant' && replaysReasoningContent && m.reasoningContent) {
            out.push({ role: m.role, content: normalizeContentForOpenAIChat(m.content, { role: 'assistant' }), reasoning_content: m.reasoningContent });
            continue;
        }
        out.push({ role: m.role, content: normalizeContentForOpenAIChat(m.content, { role: m.role }) });
    }
    flushToolMedia();
    return out;
}

export function toOpenAITools(tools) {
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        },
    }));
}

export function toResponsesTools(tools) {
    return tools.map((t) => {
        if (t?.name === 'tool_search') {
            return {
                type: 'tool_search',
                execution: 'client',
                description: t.description,
                parameters: t.inputSchema,
            };
        }
        // xAI/Grok Responses rejects the OpenAI-only `type:'custom'` freeform
        // variant ("unknown variant 'custom'"). Serialize freeform/grammar
        // tools (e.g. apply_patch) as ordinary function tools instead. Grammar
        // tools may carry no usable inputSchema, so fall back to a permissive
        // object schema so grok still registers a valid function tool.
        return {
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.inputSchema || { type: 'object', additionalProperties: true },
        };
    });
}

export function nativeResponsesTools(opts) {
    return Array.isArray(opts?.nativeTools)
        ? opts.nativeTools.filter(t => t && typeof t === 'object')
        : [];
}

// Known tool-name sets for the leaked-tool-call guard, derived from the exact
// request body so a recovered leaked call is only synthesized when it names a
// tool the model was actually offered. Chat tools nest the name under
// `function.name`; Responses tools carry a top-level `name`.
export function knownToolNamesFromOpenAITools(tools) {
    return new Set(
        (Array.isArray(tools) ? tools : [])
            .map((t) => (typeof t?.function?.name === 'string' ? t.function.name
                : typeof t?.name === 'string' ? t.name : null))
            .filter(Boolean),
    );
}

export function knownToolNamesFromResponsesTools(tools) {
    return new Set(
        (Array.isArray(tools) ? tools : [])
            .map((t) => (typeof t?.name === 'string' ? t.name : null))
            .filter(Boolean),
    );
}

export function parseToolCalls(choice, label) {
    const calls = choice.message?.tool_calls;
    if (!calls?.length)
        return undefined;
    // finish_reason present ⇒ the turn completed; a JSON.parse failure on the
    // arguments is deterministic bad JSON (permanent), not stream truncation.
    const finishReason = choice.finish_reason || null;
    return calls
        .filter((tc) => tc.type === 'function')
        .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseCompletedToolCallArgumentsJson(tc.function.arguments, label, { id: tc.id, name: tc.function.name, finishReason }),
    }));
}

export function parseResponsesToolCalls(response, label) {
    const out = [];
    // A Responses tool call is only parsed off a completed/done item, so any
    // malformed-JSON failure here is deterministic, not mid-stream truncation.
    const finishReason = response?.status || 'completed';
    for (const item of response?.output || []) {
        if (item?.type === 'function_call') {
            out.push({
                id: item.call_id || item.id,
                name: item.name,
                arguments: parseCompletedToolCallArgumentsJson(item.arguments, label, { id: item.call_id || item.id, name: item.name, finishReason }),
            });
        } else if (item?.type === 'custom_tool_call') {
            const call = customToolCallFromResponseItem(item);
            if (call) out.push(call);
        } else if (item?.type === 'tool_search_call') {
            const _tsArgs = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
                ? item.arguments
                : parseCompletedToolCallArgumentsJson(item.arguments || '{}', label, { id: item.call_id || item.id, name: 'tool_search', finishReason });
            out.push({
                id: item.call_id || item.id,
                name: 'tool_search',
                // Schema is a plain object ({query,select,limit}); an array
                // (parsed JSON or passthrough) must never pass through as args.
                arguments: (_tsArgs && typeof _tsArgs === 'object' && !Array.isArray(_tsArgs)) ? _tsArgs : {},
                nativeType: 'tool_search_call',
            });
        }
    }
    return out.length ? out : undefined;
}

export function responseOutputText(response) {
    if (typeof response?.output_text === 'string') return response.output_text;
    const chunks = [];
    for (const item of response?.output || []) {
        if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
        }
    }
    return chunks.join('');
}

export function collectCompatResponseSearchSources(response) {
    const citations = [];
    const webSearchCalls = [];
    const seen = new Set();
    const addCitation = (source, fallback = {}) => {
        if (!source) return;
        if (typeof source === 'string') {
            const url = source.trim();
            if (!url || seen.has(url)) return;
            seen.add(url);
            citations.push({ title: url, url, snippet: '', source: fallback.source || 'citation', provider: 'xai' });
            return;
        }
        if (typeof source !== 'object') return;
        const url = String(
            source.url
            || source.uri
            || source.href
            || source.source_url
            || source.url_citation?.url
            || '',
        ).trim();
        if (!url || seen.has(url)) return;
        seen.add(url);
        citations.push({
            title: String(source.title || source.name || source.query || source.url_citation?.title || fallback.title || url).trim(),
            url,
            snippet: String(source.snippet || source.text || source.description || '').trim(),
            source: source.source || fallback.source || 'citation',
            provider: source.provider || 'xai',
        });
    };
    for (const citation of Array.isArray(response?.citations) ? response.citations : []) addCitation(citation);
    for (const item of Array.isArray(response?.output) ? response.output : []) {
        if (item?.type === 'web_search_call') {
            webSearchCalls.push({ id: item.id || '', status: item.status || '', action: item.action || null });
            const action = item.action || {};
            for (const source of Array.isArray(action.sources) ? action.sources : []) addCitation(source, { title: action.query || '', source: 'web_search_call' });
            if (action.url) addCitation({ url: action.url, title: action.query || '' }, { source: 'web_search_call' });
            for (const url of Array.isArray(action.urls) ? action.urls : []) addCitation({ url, title: action.query || '' }, { source: 'web_search_call' });
        }
        for (const citation of Array.isArray(item?.citations) ? item.citations : []) addCitation(citation);
        for (const part of Array.isArray(item?.content) ? item.content : []) {
            for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
                addCitation(annotation, { source: 'annotation' });
            }
        }
    }
    return { citations, webSearchCalls };
}

export function toResponsesInputMessage(m, pendingToolMedia = null, customToolCallNameById = null) {
    if (m.role === 'tool') {
        if (Array.isArray(m.nativeToolSearch?.openaiTools)) {
            return {
                type: 'tool_search_output',
                call_id: m.toolCallId || '',
                status: 'completed',
                execution: 'client',
                tools: m.nativeToolSearch.openaiTools,
            };
        }
        const { output, mediaContent } = splitToolContentForOpenAIResponses(m.content);
        // xai path: never emit `custom_tool_call_output` (the `custom` variant
        // is rejected by grok). Replay prior tool outputs as the standard
        // `function_call_output` item regardless of original native type.
        const item = {
            type: 'function_call_output',
            call_id: m.toolCallId || '',
            output: output,
        };
        if (mediaContent && pendingToolMedia) pendingToolMedia.push(...mediaContent);
        return item;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        const items = [];
        if (m.content) items.push({ role: 'assistant', content: normalizeContentForOpenAIResponses(m.content, { role: 'assistant' }) });
        for (const tc of m.toolCalls) {
            if (tc.nativeType === 'tool_search_call' || tc.name === 'tool_search') {
                items.push({
                    type: 'tool_search_call',
                    call_id: tc.id,
                    execution: 'client',
                    arguments: tc.arguments || {},
                });
            } else {
                // xai path: prior native `custom_tool_call` history is replayed
                // as a standard `function_call` (grok rejects the `custom`
                // variant). tc.arguments already holds the recovered object
                // form, so the same stringify path as regular calls applies.
                items.push({
                    type: 'function_call',
                    call_id: tc.id,
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments || {}),
                });
            }
        }
        return items;
    }
    return { role: m.role, content: normalizeContentForOpenAIResponses(m.content || '', { role: m.role }) };
}

export function xaiSystemInstructions(messages) {
    const instructions = (messages || [])
        .filter(m => m?.role === 'system')
        .map(m => String(m.content || ''))
        .filter(Boolean)
        .join('\n\n');
    return instructions || undefined;
}

export function toXaiResponsesInput(messages, providerState, options = {}) {
    const includeSystem = options.includeSystem !== false;
    const state = providerState?.xaiResponses || null;
    let startIndex = 0;
    let resetReason = null;
    let previousResponseId = typeof state?.previousResponseId === 'string' ? state.previousResponseId : null;
    const expectedModel = options.model ? String(options.model) : '';
    const stateModel = state?.model ? String(state.model) : '';
    const seen = Number.isInteger(state?.seenMessageCount) ? state.seenMessageCount : null;
    if (previousResponseId && expectedModel && stateModel && stateModel !== expectedModel) {
        previousResponseId = null;
        resetReason = 'model_changed';
    }
    if (previousResponseId && (seen == null || seen < 0 || seen > messages.length)) {
        previousResponseId = null;
        resetReason = seen == null ? 'missing_seen_message_count' : 'seen_message_count_out_of_range';
    }
    if (previousResponseId) {
        startIndex = Math.max(0, Math.min(seen, messages.length));
        if (messages[startIndex]?.role === 'assistant') startIndex += 1;
    }
    const input = [];
    const pendingToolMedia = [];
    const customToolCallNameById = new Map();
    const flushToolMedia = () => {
        if (!pendingToolMedia.length) return;
        input.push({ role: 'user', content: pendingToolMedia.splice(0) });
    };
    for (const m of messages.slice(startIndex)) {
        if (!includeSystem && m.role === 'system') continue;
        if (m.role !== 'tool') flushToolMedia();
        const converted = toResponsesInputMessage(m, pendingToolMedia, customToolCallNameById);
        if (Array.isArray(converted)) input.push(...converted);
        else input.push(converted);
    }
    flushToolMedia();
    return { input, previousResponseId, startIndex, continuationResetReason: resetReason };
}
