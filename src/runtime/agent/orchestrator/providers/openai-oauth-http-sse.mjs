/**
 * openai-oauth-http-sse.mjs — HTTP/SSE fallback transport for openai-oauth.
 *
 * Extracted from openai-oauth.mjs. Used when the WebSocket transport is
 * unhealthy (see _shouldUseOpenAIHttpFallback / shouldFallbackTransport).
 * Owns SSE frame parsing, the single-emit tool-call dedupe contract
 * (scripts/openai-oauth-http-sse-toolcall-smoke.mjs) and fallback headers.
 */
import { randomBytes } from 'crypto';
import zlib from 'node:zlib';
import {
    extractCacheWriteTokens,
    extractCachedTokens,
    traceAgentFetch,
    traceAgentSse,
    traceAgentUsage,
} from '../agent-trace.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
    PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    streamStalledError,
    createTimeoutSignal,
    createPassthroughSignal,
} from '../stall-policy.mjs';
import {
    classifyError,
    jitterDelayMs,
    shouldFallbackTransport,
    sleepWithAbort,
    typedStatusFrom,
} from './retry-classifier.mjs';
import { stampStreamOutcome, readStreamOutcome, STREAM_TRANSPORTS } from './lib/stream-outcome.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { makeInvalidToolArgsMarker } from './openai-compat-stream.mjs';
import { createLeakGuard, createToolCallDedupe, dedupeToolCallList } from './anthropic-leaked-toolcall.mjs';
import { customToolCallFromResponseItem } from './custom-tool-wire.mjs';
import { CODEX_OAUTH_ORIGINATOR, CODEX_RESPONSES_URL, _displayCodexModel } from './openai-oauth.mjs';
import { createActiveToolItemTracker } from './tool-stream-state.mjs';
import { parseProviderJsonBatch } from './stream-json-pool.mjs';
export { envPositiveInt as _envPositiveInt } from './lib/env-utils.mjs';

// Public OpenAI Responses API endpoint for the api-key `openai` provider.
// The openai-direct WS transport hits the same origin (openai-ws-pool
// OPENAI_WS_URL = wss://api.openai.com/v1/responses); this HTTP/SSE fallback
// mirrors it so OpenAIDirectProvider can fall back off WebSocket like
// openai-oauth. Same Responses SSE wire format, only endpoint + auth differ.
const OPENAI_DIRECT_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CODEX_REQUEST_MAX_RETRIES = 4;
const CODEX_REQUEST_BACKOFF_MS = Object.freeze([200, 400, 800, 1600]);
const CODEX_RETRY_JITTER_RATIO = 0.1;

// Request-body zstd gate (see sendViaHttpSse). Namespace import: on Node
// runtimes without zlib zstd bindings the named export would fail at module
// load, so the call site typeof-guards zlib.zstdCompressSync instead.
const OPENAI_REQ_ZSTD_MIN_BYTES = 8 * 1024;
let _openaiReqZstdLatch = false;
function _openaiReqZstdDisabled() {
    return _openaiReqZstdLatch || process.env.MIXDOG_OPENAI_REQ_ZSTD === '0';
}
function _disableOpenaiReqZstd() { _openaiReqZstdLatch = true; }
function _zstdHeaders(headers, bodyForSend) {
    return bodyForSend.encoding
        ? { ...headers, 'Content-Encoding': bodyForSend.encoding }
        : headers;
}

export function _envFlag(name, fallback = true) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
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

function _sseJsonPayload(frame) {
    const lines = String(frame || '').split('\n');
    const data = [];
    for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return null;
    const raw = data.join('\n').trim();
    return !raw || raw === '[DONE]' ? null : raw;
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

// Wire-level `end_turn` on a terminal Responses frame: an optional boolean on
// the completed response.
// Optional by contract: only a real boolean normalizes; a missing/non-boolean
// field stays undefined so absence is never collapsed into false.
export function _endTurnFromEvent(event) {
    if (!event || typeof event !== 'object') return undefined;
    const fromResponse = event.response?.end_turn;
    if (typeof fromResponse === 'boolean') return fromResponse;
    const topLevel = event.end_turn;
    if (typeof topLevel === 'boolean') return topLevel;
    return undefined;
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

function _buildOpenAIHttpFallbackHeaders({ auth, cacheKey, statelessConversation = false }) {
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
    if (cacheKey && !statelessConversation) {
        const sid = String(cacheKey);
        // Backend-native anchors (see openai-ws-pool _buildHandshakeHeaders):
        // the hyphenated `session-id`/`thread-id` pair; legacy underscore
        // `session_id` kept for backward compat.
        headers.session_id = sid;
        headers['session-id'] = sid;
        headers['thread-id'] = sid;
    }
    return headers;
}

// WS→HTTP/SSE fallback predicate → shared shouldFallbackTransport
// (retry-classifier.mjs). The per-provider env flag is computed here and passed
// as `enabled`; OAuth rate limits are terminal and must never trigger a
// transport fallback, even if a caller has marked a prior WS attempt exhausted.
export function _shouldUseOpenAIHttpFallback(err, externalSignal) {
    if (Number(err?.httpStatus || 0) === 429) return false;
    // Codex switches WS→HTTPS on a typed transport failure; the only extra
    // deny is exposure (relayed text / dispatched tool), which the shared
    // predicate reads off the canonical record stamped by the WS transport.
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
    _sleepFn,
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
    const statelessConversation = opts?.statelessConversation === true
        || _envFlag('MIXDOG_OAI_STATELESS_HTTP', false);
    const headers = _buildOpenAIHttpFallbackHeaders({ auth, cacheKey, statelessConversation });
    const fetchStartedAt = Date.now();
    const responsesUrl = auth?.type === 'openai-direct'
        ? OPENAI_DIRECT_RESPONSES_URL
        : CODEX_RESPONSES_URL;
    // Request-body zstd: compression is enabled for the codex backend on the
    // OpenAI provider — the server decompresses Content-Encoding: zstd.
    // openai-direct is excluded: only the codex backend is verified. Env
    // kill-switch plus a process-wide latch flipped on the first 400 seen on
    // a compressed request, which then replays that attempt uncompressed.
    const _rawReqBytes = Buffer.from(JSON.stringify(body));
    let _reqBodyForSend = auth?.type !== 'openai-direct'
        && !_openaiReqZstdDisabled()
        && typeof zlib.zstdCompressSync === 'function'
        && _rawReqBytes.length >= OPENAI_REQ_ZSTD_MIN_BYTES
        ? { bytes: zlib.zstdCompressSync(_rawReqBytes), encoding: 'zstd' }
        : { bytes: _rawReqBytes, encoding: null };
    let response;
    for (let attempt = 0; attempt <= CODEX_REQUEST_MAX_RETRIES; attempt++) {
        const headerTimeout = createTimeoutSignal(
            totalTimeout.signal,
            PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
            'OpenAI OAuth HTTP fallback initial response',
        );
        let requestError = null;
        try {
            // Keep the established stage name for consumers, while making each
            // bounded retry an observable liveness heartbeat. Session runtime
            // liveness updates lastProgressAt for every stage callback,
            // including a repeated `requesting` stage.
            try {
                onStageChange?.('requesting', {
                    attempt: attempt + 1,
                    maxAttempts: CODEX_REQUEST_MAX_RETRIES + 1,
                    retry: attempt > 0,
                });
            } catch {}
            response = await fetchFn(responsesUrl, {
                method: 'POST',
                headers: _zstdHeaders(headers, _reqBodyForSend),
                body: _reqBodyForSend.bytes,
                signal: headerTimeout.signal,
                dispatcher: getLlmDispatcher(),
            });
        } catch (err) {
            requestError = headerTimeout.signal?.aborted
                && headerTimeout.signal.reason instanceof Error
                ? headerTimeout.signal.reason
                : err;
        } finally {
            headerTimeout.cleanup();
        }

        // zstd rejection fallback: a 400 on a compressed request latches
        // compression OFF process-wide and replays this attempt uncompressed.
        if (response && response.status === 400 && _reqBodyForSend.encoding) {
            _disableOpenaiReqZstd();
            _reqBodyForSend = { bytes: _rawReqBytes, encoding: null };
            await response.arrayBuffer().catch(() => {});
            response = undefined;
            continue;
        }
        const retryableStatus = response && response.status >= 500 && response.status <= 599;
        // Typed transient transport failures only (errno / SDK connection
        // type). An unknown pre-response failure throws immediately instead of
        // re-issuing the POST.
        const retryableTransport = !response && requestError
            && classifyError(requestError) === 'transient'
            && !externalSignal?.aborted
            && !totalTimeout.signal?.aborted;
        if (attempt < CODEX_REQUEST_MAX_RETRIES && (retryableStatus || retryableTransport)) {
            // Reissuing the POST is a REPLAY: allowed for a typed transient
            // failure of the initial request, denied once the failure carries
            // exposure evidence (relayed output / dispatched tool call).
            const attemptFailure = requestError || Object.assign(
                new Error(`OpenAI OAuth HTTP fallback ${response.status}`),
                { httpStatus: response.status, headers: response.headers, initialResponseError: true },
            );
            if (readStreamOutcome(attemptFailure).replaySafe !== true) {
                if (response) await response.arrayBuffer().catch(() => {});
                totalTimeout.cleanup();
                throw attemptFailure;
            }
            // A non-success response has not exposed any streamed output. Drain
            // its body before reissuing so the dispatcher can reuse the socket.
            if (response) await response.arrayBuffer().catch(() => {});
            const raw = CODEX_REQUEST_BACKOFF_MS[attempt];
            await sleepWithAbort(
                jitterDelayMs(raw, CODEX_RETRY_JITTER_RATIO),
                externalSignal,
                _sleepFn,
                'OpenAI OAuth HTTP request retry backoff aborted',
            );
            response = undefined;
            continue;
        }
        if (requestError) {
            totalTimeout.cleanup();
            // The initial response never arrived: nothing was sampled, so the
            // typed rules upstream decide whether to retry.
            throw requestError;
        }
        break;
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
        err.initialResponseError = true;
        totalTimeout.cleanup();
        throw err;
    }
    if (!response.body) {
        totalTimeout.cleanup();
        throw Object.assign(new Error('OpenAI OAuth HTTP fallback returned no response body'), { initialResponseError: true });
    }

    try { onStreamDelta?.('transport'); } catch {}
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
    let _pendingReadReject = null;
    const _rejectPendingRead = (err) => {
        if (!_pendingReadReject) return;
        const reject = _pendingReadReject;
        _pendingReadReject = null;
        reject(err);
    };
    let _onTotalAbort = null;
    if (totalTimeout.signal) {
        _onTotalAbort = () => {
            const reason = totalTimeout.signal.reason;
            _streamAbortReason = reason instanceof Error
                ? reason
                : new Error('OpenAI OAuth HTTP fallback aborted');
            try { reader.cancel(_streamAbortReason).catch(() => {}); } catch {}
            _rejectPendingRead(_streamAbortReason);
        };
        if (totalTimeout.signal.aborted) _onTotalAbort();
        else totalTimeout.signal.addEventListener('abort', _onTotalAbort, { once: true });
    }
    // SEMANTIC idle watchdog: reset ONLY on meaningful() (text/reasoning/tool
    // deltas), never on raw bytes/keepalive frames, so a stream that emits some
    // deltas then goes silent trips a short, named terminal failure instead of
    // hanging until the 30-min agent watchdog. Disablable via the shared env.
    let _semanticIdleTimer = null;
    let _firstServerEventTimer = null;
    const firstServerEventOverrideMs = Number(opts?._firstServerEventTimeoutMs);
    const firstServerEventMs = Number.isFinite(firstServerEventOverrideMs) && firstServerEventOverrideMs > 0
        ? firstServerEventOverrideMs
        : PROVIDER_FIRST_BYTE_TIMEOUT_MS;
    const _clearFirstServerEvent = () => {
        if (_firstServerEventTimer) {
            clearTimeout(_firstServerEventTimer);
            _firstServerEventTimer = null;
        }
    };
    const _armFirstServerEvent = () => {
        if (!(firstServerEventMs > 0)) return;
        _clearFirstServerEvent();
        _firstServerEventTimer = setTimeout(() => {
            const err = new Error(`OpenAI OAuth HTTP fallback first server event timed out after ${firstServerEventMs}ms`);
            err.code = 'EPROVIDERTIMEOUT';
            err.firstByteTimeout = true;
            _streamAbortReason = err;
            try { reader.cancel(err).catch(() => {}); } catch {}
            _rejectPendingRead(err);
        }, firstServerEventMs);
        try { _firstServerEventTimer.unref?.(); } catch {}
    };
    const _clearSemanticIdle = () => {
        if (_semanticIdleTimer) { clearTimeout(_semanticIdleTimer); _semanticIdleTimer = null; }
    };
    const semanticIdleOverrideMs = Number(opts?._semanticIdleTimeoutMs);
    const semanticIdleMs = Number.isFinite(semanticIdleOverrideMs) && semanticIdleOverrideMs > 0
        ? semanticIdleOverrideMs
        : PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS;
    const semanticIdleEnabled = (Number.isFinite(semanticIdleOverrideMs) && semanticIdleOverrideMs > 0)
        || PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
    const _armSemanticIdle = () => {
        if (!semanticIdleEnabled || !(semanticIdleMs > 0)) return;
        _clearSemanticIdle();
        _semanticIdleTimer = setTimeout(() => {
            _streamAbortReason = streamStalledError('OpenAI OAuth HTTP fallback', semanticIdleMs, { emittedToolCall: emittedToolCallIds.size > 0 });
            // Partial-final recovery: attach the
            // streamed partial state so the agent loop can accept a wedged FINAL
            // no-tool summary as a successful partial-final instead of dropping
            // the result. pendingToolUse gates out any mid-flight tool call.
            try {
                _streamAbortReason.partialContent = content;
                _streamAbortReason.partialToolCalls = toolCalls.length ? toolCalls.slice() : undefined;
                // Shared active tool-item tracker (tool-stream-state.mjs) closes
                // the custom-tool gap: a stall mid custom_tool_call_input.delta
                // never lands in pendingCalls, so without activeToolItems/_toolInFlight
                // a tool-bearing turn would look text-only and be wrongly accepted
                // as a partial-final.
                _streamAbortReason.pendingToolUse = pendingCalls.size > 0
                    || emittedToolCallIds.size > 0
                    || activeToolItems.size > 0
                    || _toolInFlight === true;
                _streamAbortReason.partialModel = model || undefined;
            } catch { /* best-effort enrichment */ }
            try { reader.cancel(_streamAbortReason).catch(() => {}); } catch {}
            _rejectPendingRead(_streamAbortReason);
        }, semanticIdleMs);
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
    // Active tool-item / alias tracking shared with the WS + compat Responses
    // streams (tool-stream-state.mjs). Mark on output_item.added / arg-input
    // deltas, clear on output_item.done; _toolInFlight latches tool work the
    // moment a call's input starts streaming (before it lands in pendingCalls).
    const _toolTracker = createActiveToolItemTracker();
    const activeToolItems = _toolTracker.items;
    const markActiveToolItem = _toolTracker.mark;
    const clearActiveToolItem = _toolTracker.clear;
    let _toolInFlight = false;
    const reasoningItems = [];
    const citations = [];
    const citationKeys = new Set();
    const webSearchCalls = [];
    const webSearchCallKeys = new Set();
    let completed = false;
    let stopReason = null;
    // Normalized wire `end_turn` from the terminal frame; undefined unless the
    // server actually supplied a boolean.
    let endTurn;
    // Gateway live-text relay invariant: set once a non-empty text chunk has
    // been forwarded to the client. A failure afterwards is non-retryable —
    // the rendered text cannot be withdrawn and a re-request would concatenate
    // a second attempt.
    let emittedText = false;

    // Reasoning-exposure invariant: set the moment a reasoning/summary delta is
    // seen (NOT at completion, where reasoningItems is assembled). Exposed
    // reasoning is a replay boundary for retry, transport fallback and the
    // reactive compact retry.
    let emittedReasoning = false;

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
    // Canonical stream-outcome contract for the HTTP/SSE transport. ONE hint
    // builder is shared by the mid-stream catch and by every post-loop reject
    // so no reject path can escape unstamped (an unstamped outcome is
    // "unknown", which the consumers treat as fail-closed).
    const _outcomeHints = (extra = {}) => ({
        transport: STREAM_TRANSPORTS.HTTP_SSE,
        provider: 'openai-responses',
        terminalObserved: completed === true,
        continuation: completed !== true,
        textEmitted: emittedText === true,
        textObservedChars: content.length,
        reasoningEmitted: emittedReasoning === true || reasoningItems.length > 0,
        toolCallsStarted: pendingCalls.size > 0 || activeToolItems.size > 0
            || _toolInFlight === true || toolCalls.length > 0,
        toolCallsComplete: toolCalls.length,
        toolCallsDispatched: emittedToolCallIds.size,
        pendingToolInput: pendingCalls.size > 0 || activeToolItems.size > 0 || _toolInFlight === true,
        // Protocol distinction: a terminal frame carrying end_turn=false keeps
        // the SAME user turn open — terminal observed, still a continuation.
        ...(endTurn === false ? { continuationDeclared: true } : {}),
        ...extra,
    });
    const _stampOutcome = (err, extra = {}) => {
        try { stampStreamOutcome(err, _outcomeHints(extra)); } catch { /* best-effort */ }
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
        meaningful('tool');
    };
    const relayLeakText = (delta) => {
        if (!leakGuard.enabled) {
            content += delta || '';
            if (delta && onTextDelta) {
                emittedText = true;
                try { onTextDelta(delta); } catch {}
            }
            if (delta) meaningful('text');
            return;
        }
        const { text, calls } = leakGuard.push(delta);
        if (text) {
            content += text;
            meaningful('text');
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
            name: 'load_tool',
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
    const meaningful = (kind = 'semantic') => {
        if (ttftMs == null) ttftMs = Date.now() - sseStartedAt;
        _armSemanticIdle();
        try { onStreamDelta?.(kind); } catch {}
    };
    const handleEvent = (event) => {
        if (!event || typeof event.type !== 'string') return;
        _clearFirstServerEvent();
        // Once any real SSE server event arrives, the fixed initial deadline is
        // satisfied and semantic-idle ownership begins. meaningful() below may
        // immediately re-arm it for a semantic event.
        _armSemanticIdle();
        switch (event.type) {
            case 'response.created':
                if (event.response?.model) model = event.response.model;
                if (event.response?.id) responseId = event.response.id;
                meaningful('semantic');
                break;
            case 'response.output_text.delta':
                relayLeakText(event.delta || '');
                break;
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
                if (event.delta) {
                    // Reasoning exposure is a replay boundary the MOMENT a delta
                    // arrives — not at response completion. A failure after this
                    // point must never be re-issued (duplicate exposed thinking).
                    emittedReasoning = true;
                    meaningful('reasoning');
                }
                break;
            case 'response.output_item.added':
                if (event.item?.type === 'function_call') {
                    markActiveToolItem(event.item);
                    pendingCalls.set(event.item.id || '', {
                        name: event.item.name || '',
                        callId: event.item.call_id || '',
                    });
                    _toolInFlight = true;
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
                            name: 'load_tool',
                            callId: event.item.call_id || '',
                            kind: 'tool_search',
                        });
                    }
                    markActiveToolItem(event.item);
                    _toolInFlight = true;
                } else if (event.item?.type === 'custom_tool_call') {
                    // Custom tool calls surface no pendingCalls entry, so mark
                    // the item active at added-time (mirroring function_call /
                    // tool_search_call above). The later custom_tool_call_input.delta
                    // still marks too, but a stall between added and the first
                    // input delta must already read as pendingToolUse.
                    markActiveToolItem(event.item);
                    _toolInFlight = true;
                }
                meaningful(_toolInFlight ? 'tool' : 'semantic');
                break;
            case 'response.function_call_arguments.delta':
                markActiveToolItem(null, event.item_id);
                _toolInFlight = true;
                meaningful('tool');
                break;
            case 'response.function_call_arguments.done': {
                const itemId = event.item_id || '';
                const pending = pendingCalls.get(itemId);
                if (pending?.kind === 'tool_search') { meaningful('tool'); break; }
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
                meaningful('tool');
                break;
            }
            case 'response.custom_tool_call_input.delta':
                markActiveToolItem(null, event.item_id);
                _toolInFlight = true;
                meaningful('tool');
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
                    // Drop the resolved function item from pendingCalls before
                    // recomputing _toolInFlight (mirrors tool_search_call below
                    // and the compat path) — otherwise a completed call keeps
                    // pendingCalls.size > 0 and the latch never clears, so a
                    // later max-output cutoff is misread as a tool in flight.
                    pendingCalls.delete(item.id || '');
                    clearActiveToolItem(item, item.id || '');
                    _toolInFlight = pendingCalls.size > 0 || activeToolItems.size > 0;
                } else if (item.type === 'tool_search_call') {
                    pendingCalls.delete(item.id || '');
                    pushToolSearchCall(item);
                    clearActiveToolItem(item, item.id || '');
                    _toolInFlight = pendingCalls.size > 0 || activeToolItems.size > 0;
                } else if (item.type === 'custom_tool_call') {
                    pushCustomToolCall(item);
                    clearActiveToolItem(item, item.id || '');
                    _toolInFlight = pendingCalls.size > 0 || activeToolItems.size > 0;
                }
                meaningful(item.type === 'reasoning'
                    ? 'reasoning'
                    : (/tool|function_call/.test(item.type || '') ? 'tool' : 'semantic'));
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
                        cachedTokens: extractCachedTokens(resp.usage),
                        cacheWriteTokens: extractCacheWriteTokens(resp.usage),
                        promptTokens: resp.usage.input_tokens || 0,
                        raw: serviceTier ? { ...resp.usage, service_tier: serviceTier } : resp.usage,
                    };
                }
                let reportedBundleProgress = false;
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
                                    if (text) {
                                        meaningful('text');
                                        reportedBundleProgress = true;
                                    }
                                    for (const c of calls) dispatchLeakedCall(c);
                                    if (calls.length) reportedBundleProgress = true;
                                } else {
                                    content += part.text || '';
                                    if (part.text) {
                                        meaningful('text');
                                        reportedBundleProgress = true;
                                    }
                                }
                            }
                            if (part.type === 'output_text') _pushOutputTextAnnotations(part, citations, citationKeys);
                        }
                    } else if (item.type === 'reasoning') {
                        pushReasoningItem(item);
                        meaningful('reasoning');
                        reportedBundleProgress = true;
                    } else if (item.type === 'web_search_call') {
                        pushWebSearchCall(item);
                        meaningful('tool');
                        reportedBundleProgress = true;
                    } else if (item.type === 'tool_search_call') {
                        pushToolSearchCall(item);
                        meaningful('tool');
                        reportedBundleProgress = true;
                    } else if (item.type === 'custom_tool_call') {
                        pushCustomToolCall(item);
                        meaningful('tool');
                        reportedBundleProgress = true;
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
                        meaningful('tool');
                        reportedBundleProgress = true;
                    }
                }
                if (!reportedBundleProgress) meaningful('semantic');
                completed = true;
                {
                    const wireEndTurn = _endTurnFromEvent(event);
                    if (typeof wireEndTurn === 'boolean') endTurn = wireEndTurn;
                }
                break;
            }
            case 'response.done':
                if (!event.response || event.response.status === 'completed') {
                    completed = true;
                    // Terminal success frame for streams that never emit a
                    // separate response.completed — same optional end_turn.
                    const wireEndTurn = _endTurnFromEvent(event);
                    if (typeof wireEndTurn === 'boolean') endTurn = wireEndTurn;
                } else if (event.response.status === 'failed') {
                    const msg = event.response?.error?.message || 'response.done failed';
                    const err = new Error(`OpenAI OAuth HTTP fallback response.done failed: ${msg}`);
                    const typed = typedStatusFrom(event.response?.error, event.error, event);
                    if (typed) err.httpStatus = typed;
                    throw err;
                } else if (event.response.status === 'incomplete') {
                    const reason = _incompleteReasonFromEvent(event);
                    if (_isMaxOutputIncompleteReason(reason)) {
                        // Max-output cutoff with a function/custom/tool_search
                        // still in flight means the tool arguments were
                        // truncated — do NOT mark a clean completion (mirrors
                        // the compat Responses path), or partial args surface as
                        // a successful tool call. Throw a stream-stalled
                        // pendingToolUse error so the loop gates/retries.
                        if (pendingCalls.size > 0 || activeToolItems.size > 0 || _toolInFlight === true) {
                            const err = _stampToolSafety(new Error('OpenAI OAuth HTTP fallback response.done incomplete (max_output_tokens) with tool call in flight'));
                            err.streamStalled = true;
                            err.pendingToolUse = true;
                            err.partialContent = content;
                            err.partialModel = model || undefined;
                            throw err;
                        }
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
                // Typed status only — nothing is synthesized from text. The
                // frame itself is preserved so the wire-error default-retry
                // classification applies (fatal codes stay terminal).
                err.responseFailed = event;
                const typed = typedStatusFrom(event.response?.error, event.error, event);
                if (typed) err.httpStatus = typed;
                const detail = event.response?.error || event.error || null;
                const code = detail?.code ?? detail?.type ?? null;
                if (typeof code === 'string' && code) err.providerErrorCode = code;
                throw err;
            }
            case 'response.incomplete': {
                const reason = _incompleteReasonFromEvent(event);
                if (_isMaxOutputIncompleteReason(reason)) {
                    // See response.done incomplete above: a max-output cutoff
                    // while a tool is in flight is a truncated tool call, not a
                    // clean length completion.
                    if (pendingCalls.size > 0 || activeToolItems.size > 0 || _toolInFlight === true) {
                        const err = _stampToolSafety(new Error('OpenAI OAuth HTTP fallback response.incomplete (max_output_tokens) with tool call in flight'));
                        err.streamStalled = true;
                        err.pendingToolUse = true;
                        err.partialContent = content;
                        err.partialModel = model || undefined;
                        throw err;
                    }
                    completed = true;
                    stopReason = 'length';
                    break;
                }
                throw new Error(`OpenAI OAuth HTTP fallback response.incomplete: ${reason}`);
            }
            case 'error': {
                const msg = event.message || event.error?.message || 'unknown';
                const err = new Error(`OpenAI OAuth HTTP fallback error: ${msg}`);
                // Same wire-error contract as response.failed.
                err.responseFailed = event;
                const typed = typedStatusFrom(event.error, event);
                if (typed) err.httpStatus = typed;
                const code = event.error?.code ?? event.error?.type ?? event.code ?? null;
                if (typeof code === 'string' && code) err.providerErrorCode = code;
                throw err;
            }
            default:
                break;
        }
    };

    try {
        // Initial wait is governed only by the fixed first-server-event policy.
        // Semantic idle begins in meaningful() after a parsed server event, so
        // a lower semantic-idle override cannot shorten this first-event wait.
        _armFirstServerEvent();
        while (true) {
            if (totalTimeout.signal?.aborted) {
                _clearSemanticIdle();
                const reason = totalTimeout.signal.reason;
                throw reason instanceof Error ? reason : new Error('OpenAI OAuth HTTP fallback aborted');
            }
            if (_streamAbortReason) throw _streamAbortReason;
            const { value, done } = await new Promise((resolve, reject) => {
                _pendingReadReject = reject;
                reader.read().then(resolve, reject);
            });
            _pendingReadReject = null;
            if (done) break;
            try { onStreamDelta?.('transport'); } catch {}
            buffer += decoder.decode(value, { stream: true });
            const parsed = _sseEventsFromBuffer(buffer);
            buffer = parsed.rest;
            const payloads = parsed.frames.map(_sseJsonPayload).filter((payload) => payload !== null);
            // These bytes have already been delivered by reader.read(). Finish
            // this bounded chunk before observing abort on the next read so
            // visible text is never lost at the cancellation boundary.
            const events = await parseProviderJsonBatch(payloads);
            for (const event of events) handleEvent(event);
        }
        // The read() above can unblock via reader.cancel() as {done:true} on an
        // external/total-timeout abort. Surface that as the abort/timeout error
        // instead of treating the partial stream as a successful response.
        if (_streamAbortReason) throw _streamAbortReason;
        buffer += decoder.decode();
        const parsed = _sseEventsFromBuffer(buffer + '\n\n');
        const payloads = parsed.frames.map(_sseJsonPayload).filter((payload) => payload !== null);
        const events = await parseProviderJsonBatch(payloads);
        for (const event of events) handleEvent(event);
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
        // Canonical record (same shape as the WS path); aliases above preserved.
        _stampOutcome(err);
        throw err;
    } finally {
        _pendingReadReject = null;
        _clearFirstServerEvent();
        _clearSemanticIdle();
        try { reader.releaseLock?.(); } catch {}
        if (_onTotalAbort && totalTimeout.signal) {
            try { totalTimeout.signal.removeEventListener('abort', _onTotalAbort); } catch {}
        }
        totalTimeout.cleanup();
    }

    const unresolved = toolCalls.find(t => t._pendingItemId);
    if (unresolved) {
        throw _stampOutcome(_stampToolSafety(new Error(
            `OpenAI OAuth HTTP fallback function_call salvage failed: missing call_id/name for item_id=${unresolved._pendingItemId || '?'}`,
        )));
    }
    // EOF without a terminal frame is ALWAYS a failure, regardless of how much
    // partial text or how many tool calls were streamed. The turn has no
    // terminal signal, so it is a continuation: returning it would report an
    // unfinished sample as a completed assistant turn (and, with tool calls
    // already dispatched, a half-finished side-effecting turn). The partial
    // rides on the error for interrupted-turn persistence.
    if (!completed) {
        const err = _stampToolSafety(new Error(
            `OpenAI OAuth HTTP fallback ended before response.completed `
            + `(text=${content.length} chars, toolCalls=${toolCalls.length})`,
        ));
        try {
            err.partialContent = content;
            err.partialToolCalls = toolCalls.length ? toolCalls.slice() : undefined;
            err.partialModel = model || undefined;
            err.pendingToolUse = pendingCalls.size > 0 || activeToolItems.size > 0 || _toolInFlight === true;
        } catch { /* best-effort enrichment */ }
        throw _stampOutcome(err, { terminalObserved: false, continuation: true });
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
        // Only present when the terminal frame carried the wire field.
        ...(typeof endTurn === 'boolean' ? { endTurn } : {}),
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
