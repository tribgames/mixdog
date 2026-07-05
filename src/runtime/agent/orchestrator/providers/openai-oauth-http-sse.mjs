/**
 * openai-oauth-http-sse.mjs — HTTP/SSE fallback transport for openai-oauth.
 *
 * Extracted from openai-oauth.mjs. Used when the WebSocket transport is
 * unhealthy (see _shouldUseOpenAIHttpFallback / shouldFallbackTransport).
 * Owns SSE frame parsing, the single-emit tool-call dedupe contract
 * (scripts/openai-oauth-http-sse-toolcall-smoke.mjs) and fallback headers.
 */
import { randomBytes } from 'crypto';
import {
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
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { makeInvalidToolArgsMarker } from './openai-compat-stream.mjs';
import { createLeakGuard, createToolCallDedupe, dedupeToolCallList } from './anthropic-leaked-toolcall.mjs';
import { customToolCallFromResponseItem } from './custom-tool-wire.mjs';
import { CODEX_OAUTH_ORIGINATOR, CODEX_RESPONSES_URL, _displayCodexModel } from './openai-oauth.mjs';

// Public OpenAI Responses API endpoint for the api-key `openai` provider.
// The openai-direct WS transport hits the same origin (openai-ws-pool
// OPENAI_WS_URL = wss://api.openai.com/v1/responses); this HTTP/SSE fallback
// mirrors it so OpenAIDirectProvider can fall back off WebSocket like
// openai-oauth. Same Responses SSE wire format, only endpoint + auth differ.
const OPENAI_DIRECT_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export function _envFlag(name, fallback = true) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

export function _envPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Completed function_call.arguments parse for the OpenAI Responses stream.
// A function_call item arrives only on a completion/done signal, so a
// non-empty-but-malformed
// arguments string is deterministic bad JSON — NOT mid-stream truncation.
// Empty/whitespace input legitimately means "no arguments" → {}. A non-empty
// string that fails JSON.parse is surfaced as an invalid-args MARKER (instead
// of being silently swallowed to {}) so the dispatch loop turns it into an
// is_error tool_result and the model self-corrects in the same turn.
function _parseJsonObject(value) {
    const text = typeof value === 'string' ? value : (value == null ? '' : String(value));
    if (text.trim() === '') return {};
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
        return makeInvalidToolArgsMarker(text, err instanceof Error ? err.message : String(err));
    }
}

function _extractCachedTokens(usage) {
    const details = usage?.input_tokens_details || usage?.prompt_tokens_details || {};
    return Number(details.cached_tokens ?? details.cached ?? usage?.cached_tokens ?? 0) || 0;
}

function _sseEventsFromBuffer(buffer) {
    const frames = [];
    let rest = buffer.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = rest.indexOf('\n\n')) >= 0) {
        frames.push(rest.slice(0, idx));
        rest = rest.slice(idx + 2);
    }
    return { frames, rest };
}

function _parseSseFrame(frame) {
    const lines = String(frame || '').split('\n');
    const data = [];
    for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return null;
    const raw = data.join('\n').trim();
    if (!raw || raw === '[DONE]') return null;
    try { return JSON.parse(raw); } catch { return null; }
}

function _incompleteReasonFromEvent(event) {
    const reasonObj = event?.response?.incomplete_details
        || event?.incomplete_details
        || event?.response?.status_details
        || null;
    return String(reasonObj?.reason || event?.response?.status || 'incomplete');
}

function _isMaxOutputIncompleteReason(reason) {
    return /^(?:max_output_tokens|max_tokens|length|output_token_limit)$/i.test(String(reason || '').trim());
}

function _pushOutputTextAnnotations(part, citations, citationKeys) {
    const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
    for (const raw of annotations) {
        const url = raw?.url || raw?.uri || raw?.href || '';
        if (!url || citationKeys.has(url)) continue;
        citationKeys.add(url);
        citations.push({
            title: raw?.title || '',
            url,
            snippet: raw?.snippet || raw?.text || raw?.description || '',
            source: 'openai-oauth',
        });
    }
}

function _buildOpenAIHttpFallbackHeaders({ auth, cacheKey }) {
    if (auth?.type === 'openai-direct') {
        // Public API-key auth: Bearer <OPENAI_API_KEY>, no chatgpt-account-id /
        // originator (mirrors openai-ws-pool _buildHandshakeHeaders' direct
        // branch). session_id anchors are an OAuth-backend behavior, so omit
        // them — the public API keys its prefix cache off body.prompt_cache_key.
        return {
            Authorization: `Bearer ${auth.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'x-client-request-id': randomBytes(16).toString('hex'),
        };
    }
    const headers = {
        Authorization: `Bearer ${auth.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'OpenAI-Beta': 'responses=experimental',
        originator: CODEX_OAUTH_ORIGINATOR,
        'chatgpt-account-id': auth.account_id || '',
        'x-client-request-id': randomBytes(16).toString('hex'),
    };
    if (cacheKey) {
        const sid = String(cacheKey);
        // Codex-native anchors (see openai-ws-pool _buildHandshakeHeaders):
        // `session-id`/`thread-id` (hyphen) match codex-rs headers.rs; legacy
        // underscore `session_id` kept for backward compat.
        headers.session_id = sid;
        headers['session-id'] = sid;
        headers['thread-id'] = sid;
    }
    return headers;
}

// WS→HTTP/SSE fallback predicate → shared shouldFallbackTransport
// (retry-classifier.mjs). The per-provider env flag is computed here and passed
// as `enabled`; the deny-order + allow-list are identical to the former copy.
export function _shouldUseOpenAIHttpFallback(err, externalSignal) {
    return shouldFallbackTransport(err, {
        signal: externalSignal,
        enabled: _envFlag('MIXDOG_OPENAI_OAUTH_HTTP_FALLBACK', true),
    });
}

// Exported for the single-emit regression smoke (scripts/openai-oauth-
// http-sse-toolcall-smoke.mjs): the SSE stream can surface the same
// function_call across response.function_call_arguments.done +
// response.output_item.done + response.completed, and onToolCall must fire
// exactly once per call id. No production caller imports this name; the
// provider invokes it internally.
export async function sendViaHttpSse({
    auth,
    body,
    opts,
    onStreamDelta,
    onToolCall,
    onTextDelta,
    onStageChange,
    externalSignal,
    poolKey,
    cacheKey,
    iteration,
    useModel,
    fetchFn = fetch,
} = {}) {
    // P1 audit fix: no fixed wall-clock total cap on the HTTP/SSE fallback
    // stream. The old createTimeoutSignal(..., PROVIDER_GENERATE_TOTAL_TIMEOUT_MS)
    // killed a healthy, still-streaming turn purely on elapsed time, unlike
    // every other streaming provider path (anthropic-oauth uses the same
    // createPassthroughSignal pattern — see anthropic-oauth.mjs "Option A").
    // The stream is bounded instead by:
    //   (a) headerTimeout below (PROVIDER_HTTP_RESPONSE_TIMEOUT_MS) for a
    //       socket that never sends the initial response,
    //   (b) the SEMANTIC idle watchdog (_armSemanticIdle /
    //       PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS), which resets on every
    //       meaningful() chunk — a live stream stays alive, a truly silent
    //       one still aborts, and
    //   (c) externalSignal (client disconnect / replaced-by-newer-request).
    const totalTimeout = createPassthroughSignal(externalSignal);
    const headerTimeout = createTimeoutSignal(
        totalTimeout.signal,
        PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
        'OpenAI OAuth HTTP fallback initial response',
    );
    const headers = _buildOpenAIHttpFallbackHeaders({ auth, cacheKey });
    const fetchStartedAt = Date.now();
    const responsesUrl = auth?.type === 'openai-direct'
        ? OPENAI_DIRECT_RESPONSES_URL
        : CODEX_RESPONSES_URL;
    let response;
    try {
        try { onStageChange?.('requesting'); } catch {}
        response = await fetchFn(responsesUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: headerTimeout.signal,
            dispatcher: getLlmDispatcher(),
        });
    } catch (err) {
        if (headerTimeout.signal?.aborted && headerTimeout.signal.reason instanceof Error) throw headerTimeout.signal.reason;
        throw err;
    } finally {
        headerTimeout.cleanup();
    }

    traceAgentFetch({
        sessionId: poolKey,
        headersMs: Date.now() - fetchStartedAt,
        httpStatus: response.status,
        provider: 'openai-oauth',
        model: useModel,
        transport: 'http',
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        const err = new Error(`OpenAI OAuth HTTP fallback ${response.status}: ${text.slice(0, 200)}`);
        err.httpStatus = response.status;
        err.headers = response.headers;
        populateHttpStatusFromMessage(err, text);
        totalTimeout.cleanup();
        throw err;
    }
    if (!response.body) {
        totalTimeout.cleanup();
        throw new Error('OpenAI OAuth HTTP fallback returned no response body');
    }

    try { onStageChange?.('streaming'); } catch {}
    const sseStartedAt = Date.now();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // After headerTimeout.cleanup() the in-flight fetch no longer carries a live
    // signal, so a totalTimeout / external abort that fires during a pending
    // reader.read() would otherwise leave the pooled request hanging. Keep the
    // reader tied to totalTimeout for the whole stream: on abort, cancel the
    // reader so the awaited read() unblocks and the socket is released back to
    // the shared pool instead of leaking. reader.cancel() may resolve the
    // pending read() as {done:true} rather than rejecting, which would let a
    // partial response surface as success — so record the abort reason and
    // re-throw it after the loop unblocks (see below).
    let _streamAbortReason = null;
    let _onTotalAbort = null;
    if (totalTimeout.signal) {
        _onTotalAbort = () => {
            const reason = totalTimeout.signal.reason;
            _streamAbortReason = reason instanceof Error
                ? reason
                : new Error('OpenAI OAuth HTTP fallback aborted');
            try { reader.cancel(_streamAbortReason).catch(() => {}); } catch {}
        };
        if (totalTimeout.signal.aborted) _onTotalAbort();
        else totalTimeout.signal.addEventListener('abort', _onTotalAbort, { once: true });
    }
    // SEMANTIC idle watchdog: reset ONLY on meaningful() (text/reasoning/tool
    // deltas), never on raw bytes/keepalive frames, so a stream that emits some
    // deltas then goes silent trips a short, named terminal failure instead of
    // hanging until the 30-min agent watchdog. Disablable via the shared env.
    let _semanticIdleTimer = null;
    const _clearSemanticIdle = () => {
        if (_semanticIdleTimer) { clearTimeout(_semanticIdleTimer); _semanticIdleTimer = null; }
    };
    const _armSemanticIdle = () => {
        if (!PROVIDER_SSE_IDLE_WATCHDOG_ENABLED || !(PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS > 0)) return;
        _clearSemanticIdle();
        _semanticIdleTimer = setTimeout(() => {
            _streamAbortReason = streamStalledError('OpenAI OAuth HTTP fallback', PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS, { emittedToolCall: emittedToolCallIds.size > 0 });
            // Partial-final recovery: attach the
            // streamed partial state so the agent loop can accept a wedged FINAL
            // no-tool summary as a successful partial-final instead of dropping
            // the result. pendingToolUse gates out any mid-flight tool call.
            try {
                _streamAbortReason.partialContent = content;
                _streamAbortReason.partialToolCalls = toolCalls.length ? toolCalls.slice() : undefined;
                _streamAbortReason.pendingToolUse = pendingCalls.size > 0 || emittedToolCallIds.size > 0;
                _streamAbortReason.partialModel = model || undefined;
            } catch { /* best-effort enrichment */ }
            try { reader.cancel(_streamAbortReason).catch(() => {}); } catch {}
        }, PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS);
        try { _semanticIdleTimer.unref?.(); } catch {}
    };
    let buffer = '';
    let content = '';
    let model = '';
    let responseId = '';
    let serviceTier = '';
    let usage = null;
    let ttftMs = null;
    const toolCalls = [];
    const pendingCalls = new Map();
    const reasoningItems = [];
    const citations = [];
    const citationKeys = new Set();
    const webSearchCalls = [];
    const webSearchCallKeys = new Set();
    let completed = false;
    let stopReason = null;
    // Gateway live-text relay invariant: set once a non-empty text chunk has
    // been forwarded to the client. A failure afterwards is non-retryable —
    // the rendered text cannot be withdrawn and a re-request would concatenate
    // a second attempt.
    let emittedText = false;

    // Tool-emit invariant (mirrors emittedText, WS path's emittedToolCall): set
    // once onToolCall has actually dispatched a call. A failure afterwards is
    // non-retryable — the side-effecting tool already ran, and any upstream
    // retry/fallback would double-execute it. Stamped onto errors below so
    // shouldFallbackTransport / the WS auth-retry gate refuse to reissue.
    let emittedToolCall = false;
    const _stampToolSafety = (err) => {
        if (emittedToolCall && err) { try { err.emittedToolCall = true; err.unsafeToRetry = true; } catch {} }
        return err;
    };

    // Single-emit guard for tool calls (matches the WS path's
    // emittedToolCall intent). The HTTP/SSE event stream can surface the
    // same function_call across multiple frames — response.function_call_arguments.done,
    // response.output_item.done, and the final response.completed.output
    // bundle. Each frame independently completes the call (id + name) and
    // would re-invoke onToolCall, double-executing a side-effecting tool.
    // Route every emit through emitToolCall: it fires the callback exactly
    // once per unique call id, the first time the call is complete. A call
    // whose id/name only arrives in a later frame is NOT dropped — its
    // first complete frame still emits; only redundant re-emits are
    // suppressed.
    const emittedToolCallIds = new Set();
    // Fix 2: cross-path name+args dedupe. A text-leaked synthetic and an
    // identical native function_call must fire onToolCall exactly once.
    const _toolDedupe = createToolCallDedupe();
    const emitToolCall = (call) => {
        if (!call || !call.id) return;
        if (emittedToolCallIds.has(call.id)) return;
        emittedToolCallIds.add(call.id);
        if (!_toolDedupe.shouldDispatch(call.name, call.arguments)) return;
        emittedToolCall = true;
        try { onToolCall?.(call); } catch {}
    };

    // Leaked tool-call guard. The model sometimes emits a tool call as plain
    // text (XML `<invoke>`/`<function_calls>` or gpt-oss harmony
    // `<|channel|>...to=functions.NAME...<|call|>`) inside
    // `response.output_text.delta` instead of a native function_call. Route
    // text through the guard so leaked calls are suppressed from the visible
    // stream, synthesized (native `call_...` id shape), and dispatched like
    // native ones. Known tool names come from the request body so recovery
    // only fires for tools the model was actually offered. Additive: the
    // native function_call path is untouched.
    const _leakKnownTools = new Set(
        (Array.isArray(body?.tools) ? body.tools : [])
            .map((t) => (typeof t?.name === 'string' ? t.name : null))
            .filter(Boolean),
    );
    const leakGuard = createLeakGuard({ knownToolNames: _leakKnownTools, harmony: true });
    const dispatchLeakedCall = (recovered) => {
        let args = recovered?.arguments;
        if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
        const call = {
            id: `call_leaked_${randomBytes(8).toString('hex')}`,
            name: recovered.name,
            arguments: args,
        };
        toolCalls.push(call);
        emitToolCall(call);
    };
    const relayLeakText = (delta) => {
        if (!leakGuard.enabled) {
            content += delta || '';
            if (delta && onTextDelta) {
                emittedText = true;
                try { onTextDelta(delta); } catch {}
            }
            return;
        }
        const { text, calls } = leakGuard.push(delta);
        if (text) {
            content += text;
            if (onTextDelta) {
                emittedText = true;
                try { onTextDelta(text); } catch {}
            }
        }
        for (const c of calls) dispatchLeakedCall(c);
    };
    const flushLeak = () => {
        if (!leakGuard.enabled) return;
        const { text, calls } = leakGuard.flush();
        if (text) {
            content += text;
            if (onTextDelta) {
                emittedText = true;
                try { onTextDelta(text); } catch {}
            }
        }
        for (const c of calls) dispatchLeakedCall(c);
    };

    const pushWebSearchCall = (item) => {
        if (!item || item.type !== 'web_search_call') return;
        const key = item.id || JSON.stringify(item.action || item);
        if (webSearchCallKeys.has(key)) return;
        webSearchCallKeys.add(key);
        webSearchCalls.push({ id: item.id || '', status: item.status || '', action: item.action || null });
    };
    const pushReasoningItem = (item) => {
        if (item?.type === 'reasoning' && item.encrypted_content && !reasoningItems.some(r => r.id === item.id)) {
            reasoningItems.push({
                id: item.id || '',
                encrypted_content: item.encrypted_content,
                summary: Array.isArray(item.summary) ? item.summary : [],
            });
        }
    };
    const pushToolSearchCall = (item) => {
        if (!item || item.type !== 'tool_search_call') return;
        const callId = item.call_id || item.id || '';
        if (!callId || toolCalls.some(t => t.id === callId)) return;
        let args = {};
        if (item.arguments && typeof item.arguments === 'object') {
            args = item.arguments;
        } else if (typeof item.arguments === 'string' && item.arguments.trim()) {
            // Non-empty but malformed tool_search arguments are deterministic
            // bad JSON (the item is only emitted on completion). Surface an
            // invalid-args marker instead of swallowing to {} so the model can
            // self-correct in the same turn.
            args = _parseJsonObject(item.arguments);
        }
        const call = {
            id: callId,
            name: 'tool_search',
            arguments: args,
            nativeType: 'tool_search_call',
        };
        toolCalls.push(call);
        emitToolCall(call);
    };
    const pushCustomToolCall = (item) => {
        const call = customToolCallFromResponseItem(item);
        if (!call || toolCalls.some(t => t.id === call.id)) return;
        toolCalls.push(call);
        emitToolCall(call);
    };
    const meaningful = () => {
        if (ttftMs == null) ttftMs = Date.now() - sseStartedAt;
        _armSemanticIdle();
        try { onStreamDelta?.(); } catch {}
    };
    const handleEvent = (event) => {
        if (!event || typeof event.type !== 'string') return;
        switch (event.type) {
            case 'response.created':
                if (event.response?.model) model = event.response.model;
                if (event.response?.id) responseId = event.response.id;
                break;
            case 'response.output_text.delta':
                meaningful();
                relayLeakText(event.delta || '');
                break;
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
                meaningful();
                break;
            case 'response.output_item.added':
                if (event.item?.type === 'function_call') {
                    pendingCalls.set(event.item.id || '', {
                        name: event.item.name || '',
                        callId: event.item.call_id || '',
                    });
                } else if (event.item?.type === 'tool_search_call') {
                    // Mark tool_search as in-flight the moment the item is
                    // added, mirroring function_call above, so the semantic
                    // idle watchdog's pendingToolUse gate (pendingCalls.size)
                    // sees a mid-flight tool_search and never lets stall
                    // recovery drop it before response.output_item.done.
                    // kind:'tool_search' tags the entry so the shared
                    // function_call_arguments.done handler (below) never
                    // mistakes it for a function call by id collision/empty id.
                    if (event.item.id) {
                        pendingCalls.set(event.item.id, {
                            name: 'tool_search',
                            callId: event.item.call_id || '',
                            kind: 'tool_search',
                        });
                    }
                }
                break;
            case 'response.function_call_arguments.delta':
                meaningful();
                break;
            case 'response.function_call_arguments.done': {
                const itemId = event.item_id || '';
                const pending = pendingCalls.get(itemId);
                if (pending?.kind === 'tool_search') { meaningful(); break; }
                const call = {
                    id: pending?.callId || event.call_id || '',
                    name: pending?.name || event.name || '',
                    arguments: _parseJsonObject(event.arguments),
                    _pendingItemId: itemId,
                };
                toolCalls.push(call);
                if (call.id && call.name) {
                    delete call._pendingItemId;
                    emitToolCall(call);
                }
                meaningful();
                break;
            }
            case 'response.custom_tool_call_input.delta':
                meaningful();
                break;
            case 'response.output_item.done': {
                const item = event.item || {};
                pushReasoningItem(item);
                pushWebSearchCall(item);
                if (item.type === 'function_call') {
                    const tc = toolCalls.find(t => t._pendingItemId === (item.id || ''));
                    if (tc) {
                        if (!tc.id && item.call_id) tc.id = item.call_id;
                        if (!tc.name && item.name) tc.name = item.name;
                        if (tc.id && tc.name) {
                            delete tc._pendingItemId;
                            emitToolCall(tc);
                        }
                    }
                } else if (item.type === 'tool_search_call') {
                    pendingCalls.delete(item.id || '');
                    pushToolSearchCall(item);
                } else if (item.type === 'custom_tool_call') {
                    pushCustomToolCall(item);
                    meaningful();
                }
                break;
            }
            case 'response.completed': {
                const resp = event.response || {};
                serviceTier = resp.service_tier || resp.serviceTier || serviceTier;
                if (!model && resp.model) model = resp.model;
                if (!responseId && resp.id) responseId = resp.id;
                if (resp.usage) {
                    usage = {
                        inputTokens: resp.usage.input_tokens || 0,
                        outputTokens: resp.usage.output_tokens || 0,
                        cachedTokens: _extractCachedTokens(resp.usage),
                        promptTokens: resp.usage.input_tokens || 0,
                        raw: serviceTier ? { ...resp.usage, service_tier: serviceTier } : resp.usage,
                    };
                }
                for (const item of resp.output || []) {
                    if (item.type === 'message') {
                        for (const part of item.content || []) {
                            if (!content && part.type === 'output_text') {
                                // Completed-output fallback (no streamed text).
                                // Route through the leak guard so a tool call
                                // leaked only in the final bundle is recovered
                                // rather than surfaced as visible content. push
                                // with final=true flushes fully (no held tail).
                                if (leakGuard.enabled) {
                                    const { text, calls } = leakGuard.push(part.text || '', true);
                                    content += text;
                                    for (const c of calls) dispatchLeakedCall(c);
                                } else {
                                    content += part.text || '';
                                }
                            }
                            if (part.type === 'output_text') _pushOutputTextAnnotations(part, citations, citationKeys);
                        }
                    } else if (item.type === 'reasoning') {
                        pushReasoningItem(item);
                    } else if (item.type === 'web_search_call') {
                        pushWebSearchCall(item);
                    } else if (item.type === 'tool_search_call') {
                        pushToolSearchCall(item);
                    } else if (item.type === 'custom_tool_call') {
                        pushCustomToolCall(item);
                        meaningful();
                    } else if (item.type === 'function_call') {
                        // Match the still-pending placeholder by item id, or
                        // an already-recorded call by its canonical call_id —
                        // so a call completed at args.done / output_item.done
                        // is reused here rather than re-pushed as a duplicate.
                        const tc = toolCalls.find(t =>
                            t._pendingItemId === (item.id || '')
                            || (item.call_id && t.id === item.call_id));
                        if (tc) {
                            if (!tc.id && item.call_id) tc.id = item.call_id;
                            if (!tc.name && item.name) tc.name = item.name;
                            if (tc.id && tc.name) {
                                delete tc._pendingItemId;
                                emitToolCall(tc);
                            }
                        } else if (item.call_id && item.name) {
                            const call = {
                                id: item.call_id,
                                name: item.name,
                                arguments: _parseJsonObject(item.arguments),
                            };
                            toolCalls.push(call);
                            emitToolCall(call);
                        }
                    }
                }
                completed = true;
                break;
            }
            case 'response.done':
                if (!event.response || event.response.status === 'completed') completed = true;
                else if (event.response.status === 'failed') {
                    const msg = event.response?.error?.message || 'response.done failed';
                    const err = new Error(`OpenAI OAuth HTTP fallback response.done failed: ${msg}`);
                    populateHttpStatusFromMessage(err, msg);
                    throw err;
                } else if (event.response.status === 'incomplete') {
                    const reason = _incompleteReasonFromEvent(event);
                    if (_isMaxOutputIncompleteReason(reason)) {
                        completed = true;
                        stopReason = 'length';
                        break;
                    }
                    throw new Error(`OpenAI OAuth HTTP fallback response.done incomplete: ${reason}`);
                }
                break;
            case 'response.failed': {
                const msg = event.response?.error?.message || event.error?.message || event.message || 'response.failed';
                const err = new Error(`OpenAI OAuth HTTP fallback response.failed: ${msg}`);
                populateHttpStatusFromMessage(err, msg);
                throw err;
            }
            case 'response.incomplete': {
                const reason = _incompleteReasonFromEvent(event);
                if (_isMaxOutputIncompleteReason(reason)) {
                    completed = true;
                    stopReason = 'length';
                    break;
                }
                throw new Error(`OpenAI OAuth HTTP fallback response.incomplete: ${reason}`);
            }
            case 'error': {
                const msg = event.message || event.error?.message || 'unknown';
                const err = new Error(`OpenAI OAuth HTTP fallback error: ${msg}`);
                populateHttpStatusFromMessage(err, msg);
                throw err;
            }
            default:
                break;
        }
    };

    try {
        // Arm the idle watchdog BEFORE the first read: a 200 response with an
        // open-but-silent body (no SSE events at all) previously hung on bare
        // reader.read() until the outer agent watchdog (CC/codex/opencode all
        // bound the first read). meaningful() re-arms it per delta thereafter;
        // an empty-partial stall classifies stream_stalled → retry/fallback.
        _armSemanticIdle();
        while (true) {
            if (totalTimeout.signal?.aborted) {
                _clearSemanticIdle();
                const reason = totalTimeout.signal.reason;
                throw reason instanceof Error ? reason : new Error('OpenAI OAuth HTTP fallback aborted');
            }
            if (_streamAbortReason) throw _streamAbortReason;
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = _sseEventsFromBuffer(buffer);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
                const event = _parseSseFrame(frame);
                if (event) handleEvent(event);
            }
        }
        // The read() above can unblock via reader.cancel() as {done:true} on an
        // external/total-timeout abort. Surface that as the abort/timeout error
        // instead of treating the partial stream as a successful response.
        if (_streamAbortReason) throw _streamAbortReason;
        buffer += decoder.decode();
        const parsed = _sseEventsFromBuffer(buffer + '\n\n');
        for (const frame of parsed.frames) {
            const event = _parseSseFrame(frame);
            if (event) handleEvent(event);
        }
        // Flush any partial-sentinel tail held back mid-stream so legitimate
        // trailing text is never lost (streamed-text path).
        flushLeak();
    } catch (err) {
        // Live-text invariant: once a non-empty chunk has been relayed it
        // cannot be withdrawn — flag the error so no upstream layer retries.
        if (emittedText && err) { try { err.liveTextEmitted = true; err.unsafeToRetry = true; } catch {} }
        // Tool-emit invariant: an error after a dispatched tool call must not
        // reissue the turn (double-execution). Stamp emittedToolCall too.
        _stampToolSafety(err);
        throw err;
    } finally {
        _clearSemanticIdle();
        try { reader.releaseLock?.(); } catch {}
        if (_onTotalAbort && totalTimeout.signal) {
            try { totalTimeout.signal.removeEventListener('abort', _onTotalAbort); } catch {}
        }
        totalTimeout.cleanup();
    }

    const unresolved = toolCalls.find(t => t._pendingItemId);
    if (unresolved) {
        throw _stampToolSafety(new Error(`OpenAI OAuth HTTP fallback function_call salvage failed: missing call_id/name for item_id=${unresolved._pendingItemId || '?'}`));
    }
    if (!completed && !content && !toolCalls.length) {
        throw _stampToolSafety(new Error('OpenAI OAuth HTTP fallback ended before response.completed'));
    }

    const liveModel = model || useModel;
    traceAgentSse({
        sessionId: poolKey,
        sseParseMs: Date.now() - sseStartedAt,
        ttftMs,
        provider: 'openai-oauth',
        model: liveModel,
        transport: 'sse',
    });
    if (usage) {
        traceAgentUsage({
            sessionId: poolKey,
            iteration,
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
            cachedTokens: usage.cachedTokens || 0,
            promptTokens: usage.promptTokens || 0,
            model: liveModel,
            modelDisplay: _displayCodexModel(liveModel),
            responseId: responseId || null,
            rawUsage: usage.raw || null,
            provider: 'openai-oauth',
            serviceTier,
        });
    }
    // Dedupe the returned array by name+args (Fix 2, array side): a synthetic
    // leaked call and an identical native function_call must not both survive,
    // else the agent loop executes the side-effecting tool twice.
    const _returnedToolCalls = toolCalls.length
        ? dedupeToolCallList(toolCalls.map(({ _pendingItemId, ...t }) => t))
        : undefined;
    return {
        content,
        model: liveModel,
        reasoningItems: reasoningItems.length ? reasoningItems : undefined,
        toolCalls: _returnedToolCalls,
        citations: citations.length ? citations : undefined,
        webSearchCalls: webSearchCalls.length ? webSearchCalls : undefined,
        usage: usage || undefined,
        stopReason: stopReason || undefined,
        // P1 audit fix: text-only max-output cutoff (openai-oauth HTTP/SSE
        // fallback maps status:'incomplete'/reason=max_output_tokens to
        // stopReason='length' above and treats it as success). Flag it so
        // loop.mjs can surface a truncation warning instead of accepting
        // silently-cut content as a clean final answer.
        ...(stopReason === 'length' && content.length > 0 ? { truncated: true } : {}),
        responseId: responseId || undefined,
        serviceTier: serviceTier || undefined,
    };
}
