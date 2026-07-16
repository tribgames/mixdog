/**
 * openai-ws-stream.mjs — WS Responses stream consumer + incremental-input
 * delta engine for the OpenAI OAuth WebSocket transport.
 *
 * Extracted from openai-oauth-ws.mjs:
 *   - request/response item matching + delta computation (_computeDelta,
 *     _sansInput, _logicalResponseItemMatch, ...) used to send only the
 *     input tail on a warm socket,
 *   - the per-response stream loop (_streamResponse): event parsing, idle/
 *     pre-created watchdogs, leak guard, tool-call dedupe, usage assembly.
 *
 * sendViaWebSocket (openai-oauth-ws.mjs) is the only production caller;
 * scripts import parseToolSearchArgs/_logicalResponseItemMatch via the
 * openai-oauth-ws.mjs re-exports.
 */
import { randomBytes } from 'crypto';
import { performance } from 'node:perf_hooks';
import {
    extractCachedTokens,
    appendAgentTrace,
} from '../agent-trace.mjs';
import { populateHttpStatusFromMessage } from './retry-classifier.mjs';
import { makeInvalidToolArgsMarker } from './openai-compat-stream.mjs';
import { createLeakGuard, createToolCallDedupe, dedupeToolCallList } from './anthropic-leaked-toolcall.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS,
    PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS,
    streamStalledError,
} from '../stall-policy.mjs';
import { customToolCallFromResponseItem } from './custom-tool-wire.mjs';
import { _wsErrLabel } from './openai-ws-pool.mjs';
import {
    _sansInput,
    _stableStringify,
    _cloneJson,
    _logicalResponseItemMatch,
    _stripResponseItemsFromHead,
    _computeDelta,
    _estimateFrameTokens,
    _buildResponseCreateFrame,
} from './openai-ws-delta.mjs';
import {
    _combineUsageWithWarmup,
    _parseEvent,
    _incompleteReasonFromEvent,
    _isMaxOutputIncompleteReason,
    _httpStatusFromWsClose,
} from './openai-ws-events.mjs';
import {
    createActiveToolItemTracker,
    hasCompleteToolCall as sharedHasCompleteToolCall,
} from './tool-stream-state.mjs';
import {
    enableSessionTransportTracking,
    disableSessionTransportTracking,
    markSessionTransportActivity,
} from '../session/manager/runtime-liveness.mjs';

// Facade re-exports: the delta/matching helpers and usage/event helpers below
// were extracted to openai-ws-delta.mjs / openai-ws-events.mjs (no behavior
// change). Re-exported here so existing importers of openai-ws-stream.mjs
// (openai-oauth-ws.mjs et al) keep resolving these symbols unchanged.
export {
    _sansInput,
    _stableStringify,
    _cloneJson,
    _logicalResponseItemMatch,
    _stripResponseItemsFromHead,
    _computeDelta,
    _estimateFrameTokens,
    _buildResponseCreateFrame,
    _combineUsageWithWarmup,
};

// Pre-`response.created` deadline. Once the socket is open and the
// response.create frame is sent, a healthy server emits response.created
// within seconds. If it stalls past this short bound the socket has wedged
// post-upgrade with zero server events — treat it as a fast, retryable
// first-byte timeout. This is the ONLY pre-stream watchdog; once any server
// event arrives the single inter-chunk idle timer below takes over.
// Only this short window is shortened; the post-`response.created`
// inter-chunk / reasoning span keeps the longer deadlines below.
// Positive-int coercion for per-call timeout overrides: finite > 0 → floor,
// else fallback.
export function _positiveInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
export const WS_PRE_RESPONSE_CREATED_MS = (() => {
    const raw = process.env.MIXDOG_PROVIDER_WS_PRE_RESPONSE_CREATED_TIMEOUT_MS;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.max(n, 1_000), PROVIDER_FIRST_BYTE_TIMEOUT_MS);
    return PROVIDER_FIRST_BYTE_TIMEOUT_MS;
})();
// Single inter-chunk idle timer. Resets on EVERY received frame — any frame,
// including metadata/keepalive, proves the socket is live.
export const WS_INTER_CHUNK_MS = PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS;
// Bound the second allocation performed when ws RawData is decoded to UTF-8.
// The ws library has already assembled the Buffer by this point, so this check
// must stay before data.toString() below. xAI shares this stream implementation
// but retains its existing unbounded behavior.
export const OPENAI_WS_MAX_INCOMING_FRAME_BYTES = 16 * 1024 * 1024;
const X_CODEX_TURN_STATE_HEADER = 'x-codex-turn-state';
const WS_TRACE_ENABLED = process.env.MIXDOG_WS_TRACE === '1';

function _incomingFrameByteLength(data) {
    if (typeof data === 'string') return Buffer.byteLength(data);
    if (Array.isArray(data)) {
        let total = 0;
        for (const chunk of data) {
            const size = Number(chunk?.byteLength ?? chunk?.length);
            if (!Number.isFinite(size) || size < 0) return null;
            total += size;
        }
        return total;
    }
    const size = Number(data?.byteLength ?? data?.length);
    return Number.isFinite(size) && size >= 0 ? size : null;
}

function _writeWsLifecycleTrace(lifecycle) {
    process.stderr.write(`[ws-trace] t=${new Date().toISOString()} lifecycle=${lifecycle}\n`);
}

function _responseItemKey(item, fallbackIndex = 0) {
    if (!item || typeof item !== 'object') return `primitive:${fallbackIndex}`;
    if (item.id) return `${item.type || 'item'}:id:${item.id}`;
    if (item.call_id) return `${item.type || 'item'}:call:${item.call_id}`;
    try { return `${item.type || 'item'}:json:${_stableStringify(item)}`; } catch {}
    return `${item.type || 'item'}:${fallbackIndex}`;
}

function _headerString(headers, name) {
    if (!headers || typeof headers !== 'object') return null;
    const wanted = String(name).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() !== wanted) continue;
        if (typeof value === 'string' && value) return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (Array.isArray(value)) {
            const first = value.find((item) => typeof item === 'string' && item);
            if (first) return first;
        }
    }
    return null;
}

function _headerKeys(headers) {
    if (!headers || typeof headers !== 'object') return [];
    const keys = [];
    for (const key of Object.keys(headers)) {
        const normalized = String(key || '').trim().toLowerCase();
        if (normalized) keys.push(normalized);
    }
    return [...new Set(keys)].sort();
}

function _hasHeaderKey(headers, name) {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return false;
    return _headerKeys(headers).includes(wanted);
}

export function _captureTurnStateFromEvent(entry, event) {
    if (!entry || entry.turnState || !event || typeof event !== 'object') return;
    const turnState = _headerString(event.headers, X_CODEX_TURN_STATE_HEADER)
        || _headerString(event.response?.headers, X_CODEX_TURN_STATE_HEADER)
        || _headerString(event.response?.metadata?.headers, X_CODEX_TURN_STATE_HEADER)
        || _headerString(event.metadata?.headers, X_CODEX_TURN_STATE_HEADER);
    if (turnState) {
        entry.turnState = turnState;
        // Attribute the captured token to the turn currently on the wire so
        // the per-turn drop guard (_withCodexWsClientMetadata) can retire it
        // once turn_id advances; null falls back to first-use attribution. An
        // empty turn_id (parity prewarm) is a valid owner — preserve '' rather
        // than collapsing it to null, so a prewarm-captured token is retired on
        // the next real turn instead of leaking onto it.
        entry.turnStateTurnId = entry.currentTurnId != null ? entry.currentTurnId : null;
    }
}

function _traceWsHeaderKeys(entry, event, midState, traceProvider, model) {
    try {
        if (!entry || !event || typeof event !== 'object') return;
        const eventType = typeof event.type === 'string' ? event.type : '';
        if (eventType !== 'response.created' && eventType !== 'response.metadata') return;
        const topLevelHeaderKeys = _headerKeys(event.headers);
        const responseHeaderKeys = _headerKeys(event.response?.headers);
        const responseMetadataHeaderKeys = _headerKeys(event.response?.metadata?.headers);
        const eventMetadataHeaderKeys = _headerKeys(event.metadata?.headers);
        const hasAnyHeaders = topLevelHeaderKeys.length > 0
            || responseHeaderKeys.length > 0
            || responseMetadataHeaderKeys.length > 0
            || eventMetadataHeaderKeys.length > 0;
        if (hasAnyHeaders && entry.wsHeaderKeysFinalTraced) return;
        if (!hasAnyHeaders && entry.wsHeaderKeysEmptyTraced) return;
        const iteration = Number(midState?.iteration);
        const payload = {
            provider: midState?.traceProvider || traceProvider,
            transport: 'websocket',
            event_type: eventType,
            model: midState?.model || model || null,
            top_level_header_keys: topLevelHeaderKeys,
            response_header_keys: responseHeaderKeys,
            response_metadata_header_keys: responseMetadataHeaderKeys,
            event_metadata_header_keys: eventMetadataHeaderKeys,
            has_turn_state_header: _hasHeaderKey(event.headers, X_CODEX_TURN_STATE_HEADER)
                || _hasHeaderKey(event.response?.headers, X_CODEX_TURN_STATE_HEADER)
                || _hasHeaderKey(event.response?.metadata?.headers, X_CODEX_TURN_STATE_HEADER)
                || _hasHeaderKey(event.metadata?.headers, X_CODEX_TURN_STATE_HEADER),
            values_redacted: true,
        };
        appendAgentTrace({
            sessionId: midState?.sessionId || null,
            iteration: Number.isFinite(iteration) ? iteration : null,
            kind: 'ws_header_keys',
            provider: payload.provider,
            model: payload.model,
            transport: 'websocket',
            event_type: eventType,
            payload,
        });
        if (hasAnyHeaders) entry.wsHeaderKeysFinalTraced = true;
        else entry.wsHeaderKeysEmptyTraced = true;
    } catch {}
}
// tool_search_call.arguments parse. Module-scope (exported) for direct test
// coverage. Same policy as the function_call_arguments.done path and
// openai-oauth _parseJsonObject —
// object passes through; null/non-string/empty/whitespace → {} (no args); a
// non-empty string that fails JSON.parse is deterministic bad JSON, surfaced
// as an invalid-args MARKER (not silently swallowed to {}) so the dispatch
// loop returns an is_error tool_result and the model self-corrects in the same
// turn.
export function parseToolSearchArgs(value) {
    if (value && typeof value === 'object') {
        // Reject arrays — the tool_search schema is an object
        // ({query,select,limit}); an array must never pass through as args.
        return Array.isArray(value) ? {} : value;
    }
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
        return makeInvalidToolArgsMarker(value, err instanceof Error ? err.message : String(err));
    }
}

export async function _streamResponse({
    entry,
    externalSignal,
    onStreamDelta,
    onToolCall,
    onTextDelta,
    state,
    logSuppressedReasoningDeltas = true,
    traceProvider = 'openai-oauth',
    _timeouts = null,
    knownToolNames = null,
}) {
    const errLabel = _wsErrLabel(traceProvider);
    const socket = entry.socket;
    enableSessionTransportTracking(state?.sessionId);
    // An already-open (possibly pooled) socket proves transport availability;
    // response.created/reasoning/text/tool events independently satisfy the
    // semantic deadline.
    if (socket?.readyState === WebSocket.OPEN) {
        markSessionTransportActivity(state?.sessionId);
    }
    const preResponseCreatedMs = _positiveInt(_timeouts?.preResponseCreatedMs, WS_PRE_RESPONSE_CREATED_MS);
    const interChunkMs = _positiveInt(_timeouts?.interChunkMs, WS_INTER_CHUNK_MS);
    const maxIncomingFrameBytes = traceProvider === 'xai'
        ? 0
        : _positiveInt(_timeouts?.maxIncomingFrameBytes, OPENAI_WS_MAX_INCOMING_FRAME_BYTES);
    // First-MEANINGFUL-frame deadline. Distinct from preResponseCreatedMs (a
    // short pre-created byte-silence window that resetIdle clears on the FIRST
    // frame of any kind): this timer is cleared only by a meaningful response
    // event (response.created or the first content/tool-arg delta), so a server
    // that ACKs with keepalive/metadata-only frames — resetting inter-chunk idle
    // forever — still trips a stall before the agent watchdog's first-byte abort.
    const firstMeaningfulMs = _positiveInt(_timeouts?.firstMeaningfulMs, PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS);
    const _streamingStart = Date.now();
    let _firstDeltaEmitted = false;
    let content = '';
    let model = '';
    let responseId = '';
    let responseServiceTier = '';
    const toolCalls = [];
    const webSearchCalls = [];
    const webSearchCallKeys = new Set();
    const responseItemsAdded = [];
    const responseItemKeys = new Set();
    const citations = [];
    const citationKeys = new Set();
    const pendingCalls = new Map();
    // Active tool-item / alias tracking extracted to tool-stream-state.mjs.
    // Keep the WS-local names bound to the tracker's Set + methods so the
    // event-switch call sites (markActiveToolItem/clearActiveToolItem/
    // activeToolItems.size) read unchanged.
    const _toolTracker = createActiveToolItemTracker();
    const activeToolItems = _toolTracker.items;
    const markActiveToolItem = _toolTracker.mark;
    const clearActiveToolItem = _toolTracker.clear;
    // Tool-work-in-flight flag: set the moment a function/custom tool call's
    // input starts streaming (before it lands in pendingCalls/toolCalls).
    // Gates partial-final SUCCESS so a stall mid tool-input never looks text-only.
    let _toolInFlight = false;
    // Early tool-call settle latch. Set when a fully-formed tool call is
    // available but the server never emits response.completed/response.done —
    // we resolve successfully anyway and surface `closeSocket` so the pool
    // discards (never reuses) the socket, which may still carry the missing
    // terminal frames as orphans.
    let _earlySettled = false;
    // Fix 2: cross-path name+args dedupe. A text-leaked synthetic and an
    // identical native function_call must fire onToolCall exactly once. Every
    // dispatch site routes through emitToolCallDedupe.
    const _toolDedupe = createToolCallDedupe();
    const emitToolCallDedupe = (call) => {
        if (!_toolDedupe.shouldDispatch(call?.name, call?.arguments)) return;
        midState.emittedToolCall = true;
        try { onToolCall?.(call); } catch {}
    };
    // Reasoning items collected from response.output_item.done (or salvaged
    // from response.completed.response.output). The request still includes
    // `reasoning.encrypted_content` so the server keeps emitting the blobs,
    // but explicit input-side replay is INTENTIONALLY OMITTED in
    // convertMessagesToResponsesInput (openai-oauth.mjs:233-238) — openai-oauth
    // rejects the same `rs_*` id twice in one handshake session_id with a
    // "Duplicate item" error. Server-side conversation state already carries
    // the prefix forward across the WS_IDLE_MS window. The collected
    // reasoningItems below are surfaced for trace/debugging only; they do
    // not feed back into the next request body.
    const reasoningItems = [];
    let reasoningTextDeltaCount = 0;
    let reasoningSummaryTextDeltaCount = 0;
    let reasoningOtherDeltaCount = 0;
    let reasoningDeltaLogEmitted = false;
    const pushReasoningItem = (item) => {
        if (!item || item.type !== 'reasoning') return;
        if (!item.encrypted_content) return;
        reasoningItems.push({
            id: item.id || '',
            encrypted_content: item.encrypted_content,
            summary: Array.isArray(item.summary) ? item.summary : [],
        });
    };
    const pushResponseItem = (item) => {
        if (!item || typeof item !== 'object') return;
        const key = _responseItemKey(item, responseItemsAdded.length);
        if (responseItemKeys.has(key)) {
            const existing = responseItemsAdded.find((candidate, index) => _responseItemKey(candidate, index) === key);
            if (existing?.type === 'function_call' && item.type === 'function_call') {
                if (!existing.call_id && item.call_id) existing.call_id = item.call_id;
                if (!existing.name && item.name) existing.name = item.name;
                if ((existing.arguments == null || existing.arguments === '') && item.arguments != null) existing.arguments = item.arguments;
            }
            return;
        }
        responseItemKeys.add(key);
        responseItemsAdded.push(_cloneJson(item));
    };
    const enrichFunctionCallResponseItem = ({ itemId = '', callId = '', name = '', argumentsText = '' } = {}) => {
        for (const item of responseItemsAdded) {
            if (item?.type !== 'function_call') continue;
            if (itemId && item.id && item.id !== itemId) continue;
            if (callId && item.call_id && item.call_id !== callId) continue;
            if (!item.call_id && callId) item.call_id = callId;
            if (!item.name && name) item.name = name;
            if ((item.arguments == null || item.arguments === '') && argumentsText) item.arguments = argumentsText;
        }
    };
    const pushCitation = (raw, fallbackTitle = '') => {
        const url = raw?.url || raw?.uri || raw?.href || '';
        if (!url || citationKeys.has(url)) return;
        citationKeys.add(url);
        citations.push({
            title: raw?.title || fallbackTitle || '',
            url,
            snippet: raw?.snippet || raw?.text || raw?.description || '',
            source: 'openai-oauth',
        });
    };
    const pushOutputTextAnnotations = (contentPart) => {
        const annotations = Array.isArray(contentPart?.annotations) ? contentPart.annotations : [];
        for (const annotation of annotations) pushCitation(annotation);
    };
    const pushWebSearchCall = (item) => {
        if (!item || item.type !== 'web_search_call') return;
        let key = item.id || '';
        if (!key) {
            try { key = JSON.stringify(item.action || item); } catch { key = `${webSearchCalls.length}`; }
        }
        if (webSearchCallKeys.has(key)) return;
        webSearchCallKeys.add(key);
        webSearchCalls.push({
            id: item.id || '',
            status: item.status || '',
            action: item.action || null,
        });
        const action = item.action || {};
        if (action.url) pushCitation({ url: action.url, title: action.query || '' });
        if (Array.isArray(action.urls)) {
            for (const url of action.urls) pushCitation({ url, title: action.query || '' });
        }
    };
    const pushCustomToolCall = (item) => {
        const call = customToolCallFromResponseItem(item);
        if (!call || toolCalls.some((existing) => existing.id === call.id)) return;
        toolCalls.push(call);
        emitToolCallDedupe(call);
    };
    const pushToolSearchCall = (item) => {
        if (!item || item.type !== 'tool_search_call') return;
        const callId = item.call_id || item.id || '';
        if (!callId || toolCalls.some((call) => call.id === callId)) return;
        const call = {
            id: callId,
            name: 'load_tool',
            arguments: parseToolSearchArgs(item.arguments),
            nativeType: 'tool_search_call',
        };
        toolCalls.push(call);
        emitToolCallDedupe(call);
    };
    // Leaked tool-call guard. The model sometimes emits a tool call as plain
    // text (XML `<invoke>`/`<function_calls>` or gpt-oss harmony
    // `<|channel|>...to=functions.NAME...<|call|>`) inside
    // `response.output_text.delta` instead of a native function_call. Route
    // text through the guard so leaked calls are suppressed from the visible
    // stream, synthesized (native `call_...` id shape), and dispatched like
    // native ones. Additive: the native function_call path is untouched.
    const leakGuard = createLeakGuard({ knownToolNames, harmony: true });
    const dispatchLeakedCall = (recovered) => {
        let args = recovered?.arguments;
        if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
        const call = {
            id: `call_leaked_${randomBytes(8).toString('hex')}`,
            name: recovered.name,
            arguments: args,
        };
        if (!_toolDedupe.shouldDispatch(call.name, call.arguments)) return;
        toolCalls.push(call);
        midState.emittedToolCall = true;
        try { onToolCall?.(call); } catch {}
        try { onStreamDelta?.('tool'); } catch {}
    };
    const relayLeakText = (delta) => {
        if (!leakGuard.enabled) {
            content += delta || '';
            if (delta && onTextDelta) {
                if (state) state.emittedText = true;
                try { onTextDelta(delta); } catch {}
            }
            if (delta) {
                try { onStreamDelta?.('text'); } catch {}
            }
            return { text: !!delta, tool: false };
        }
        const { text, calls } = leakGuard.push(delta);
        if (text) {
            content += text;
            try { onStreamDelta?.('text'); } catch {}
            if (onTextDelta) {
                if (state) state.emittedText = true;
                try { onTextDelta(text); } catch {}
            }
        }
        for (const c of calls) dispatchLeakedCall(c);
        return { text: !!text, tool: calls.length > 0 };
    };
    const flushLeak = () => {
        if (!leakGuard.enabled) return;
        const { text, calls } = leakGuard.flush();
        if (text) {
            content += text;
            if (onTextDelta) {
                if (state) state.emittedText = true;
                try { onTextDelta(text); } catch {}
            }
        }
        for (const c of calls) dispatchLeakedCall(c);
    };
    const logReasoningDeltaSuppression = () => {
        if (!logSuppressedReasoningDeltas) return;
        const total = reasoningTextDeltaCount + reasoningSummaryTextDeltaCount + reasoningOtherDeltaCount;
        if (reasoningDeltaLogEmitted || total === 0) return;
        reasoningDeltaLogEmitted = true;
        process.stderr.write(`[openai-oauth-ws] suppressed reasoning text deltas from user content count=${total} text=${reasoningTextDeltaCount} summary=${reasoningSummaryTextDeltaCount} other=${reasoningOtherDeltaCount}\n`);
    };
    let usage;
    let stopReason = null;
    let incompleteReason = null;
    let done = false;
    let terminalError = null;
    // Mid-stream retry classifier needs to distinguish "stream died before we
    // even saw response.created" from "stream died after we had a partial
    // response but before completion". Mutate the shared state object so the
    // caller can inspect flags on the error path without us having to attach
    // them manually at every reject site.
    const midState = state || {};
    midState.sawResponseCreated = midState.sawResponseCreated || false;
    midState.sawCompleted = midState.sawCompleted || false;
    midState.wsCloseCode = null;
    midState.responseFailedPayload = null;
    let idleTimer = null;
    let keepaliveTimer = null;
    let abortHandler = null;
    let messageHandler = null;
    let closeHandler = null;
    let errorHandler = null;
    let traceOpenHandler = null;
    let tracePingHandler = null;
    let tracePongHandler = null;
    // SEMANTIC idle timer: distinct from the inter-chunk
    // timer, which resets on EVERY frame (rate_limits/metadata/keepalive keep
    // the socket "alive"). This timer resets ONLY on meaningful output deltas
    // (text/reasoning/tool args — the same events that call onStreamDelta) so a
    // stream that emits some deltas then goes silent (server keepalive frames
    // only) trips a short, named terminal StreamStalledError instead of coasting
    // to the 300s inter-chunk cap / 30-min agent watchdog.
    let semanticIdleTimer = null;
    // WS gets its own shorter semantic-idle window. The shared SSE semantic
    // timeout is intentionally near the 300s stall warning to protect Anthropic
    // effort-mode "silent thinking"; using that value here lets a wedged WS
    // request race the TUI 300s watchdog. Keep websocket stalls provider-owned:
    // fail/retry/fallback here first, then let the TUI watchdog remain a final
    // safety net only.
    const semanticIdleMs = PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS;
    const semanticIdleEnabled = PROVIDER_SSE_IDLE_WATCHDOG_ENABLED && semanticIdleMs > 0;
    // First-meaningful-frame watchdog timer + one-shot latch. Armed alongside
    // the pre-stream watchdog; cleared exactly once by the first meaningful
    // response event (response.created / first content or tool-arg delta).
    let firstMeaningfulTimer = null;
    let firstMeaningfulSeen = false;
    const firstMeaningfulEnabled = firstMeaningfulMs > 0;

    return new Promise((resolve, reject) => {
        // Pre-stream watchdog: the timer fires if the server never sends a
        // first event (response.created) within preResponseCreatedMs
        // after our last frame. The socket is open and the response.create
        // frame was sent, but no server event has come back — a wedged
        // post-upgrade socket. Healthy servers ack within seconds, so this
        // window is intentionally short (WS_PRE_RESPONSE_CREATED_MS, ~10s).
        // Once ANY server event arrives, resetIdle() cancels this watchdog and
        // the single inter-chunk idle timer takes over — silent gaps
        // mid-reasoning (openai-oauth spending 50s+ producing reasoning
        // tokens) are normal and should not abort the turn.
        const armPreStreamWatchdog = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (process.env.MIXDOG_DEBUG_AGENT) {
                    process.stderr.write(`[agent-trace] ws-timeout kind=first-byte afterMs=${preResponseCreatedMs}\n`);
                }
                traceWsTimeout('first_byte_timeout', preResponseCreatedMs);
                const err = new Error(`WS stream: no first server event within ${preResponseCreatedMs}ms`);
                // Tag the close code so _classifyMidstreamError sees a 4000
                // (our local pre-stream watchdog code) and routes through
                // the post-upgrade-no-first-event retryable bucket.
                err.wsCloseCode = 4000;
                // Tag the error object itself (not just midState): the warmup
                // path streams under a separate warmupState and rethrows on
                // timeout BEFORE it can copy flags to the outer midState, so the
                // outer catch's _classifyMidstreamError would otherwise see
                // sawResponseCreated=false + close 4000 and hit the pre-created
                // deny gate. err.firstByteTimeout makes both paths retryable.
                err.firstByteTimeout = true;
                midState.firstByteTimeout = true;
                terminalError = err;
                try { socket.close(4000, 'first_byte_timeout'); } catch {}
                // socket.close() may not settle a half-open WS (closeHandler never
                // fires) — reject directly so the turn retries instead of hanging
                // until the 600s watchdog. finish() is idempotent (Promise settles
                // once; cleanup is null-safe).
                finish();
            }, preResponseCreatedMs);
        };
        let interChunkTimer = null;
        const traceWsTimeout = (event, timeoutMs) => {
            try {
                const iteration = Number(midState.iteration);
                const attemptIndex = Number(midState.attemptIndex);
                const payload = {
                    provider: midState.traceProvider || traceProvider,
                    transport: 'websocket',
                    event,
                    timeout_ms: timeoutMs,
                    elapsed_ms: Date.now() - _streamingStart,
                    model: midState.model || model || null,
                    attempt_index: Number.isFinite(attemptIndex) ? attemptIndex : null,
                    warmup: midState.warmup === true,
                    saw_response_created: midState.sawResponseCreated === true,
                };
                appendAgentTrace({
                    sessionId: midState.sessionId || null,
                    iteration: Number.isFinite(iteration) ? iteration : null,
                    kind: 'ws_timeout',
                    ...payload,
                    payload,
                });
            } catch {}
        };
        const clearPreStreamWatchdog = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        // First-meaningful-frame watchdog: fires if no meaningful response event
        // (response.created / first content or tool-arg delta) arrives within
        // firstMeaningfulMs, even while keepalive/metadata frames keep the
        // inter-chunk idle timer fresh. On expiry treat the stream as stalled →
        // named streamStalledError routes through the existing mid-stream
        // retry/fallback path (fires before the 300s agent first-byte abort).
        const armFirstMeaningfulWatchdog = () => {
            if (!firstMeaningfulEnabled) return;
            if (firstMeaningfulTimer) clearTimeout(firstMeaningfulTimer);
            firstMeaningfulTimer = setTimeout(() => {
                if (process.env.MIXDOG_DEBUG_AGENT) {
                    process.stderr.write(`[agent-trace] ws-timeout kind=first-meaningful afterMs=${firstMeaningfulMs}\n`);
                }
                traceWsTimeout('first_meaningful_timeout', firstMeaningfulMs);
                terminalError = streamStalledError('Responses WS', firstMeaningfulMs, { emittedToolCall: !!midState?.emittedToolCall });
                try { terminalError.wsCloseCode = 4000; } catch {}
                try { socket.close(4000, 'first_meaningful_timeout'); } catch {}
                finish();
            }, firstMeaningfulMs);
            try { firstMeaningfulTimer.unref?.(); } catch {}
        };
        // Cleared exactly once, only by a meaningful response event — NOT by
        // keepalive/metadata frames (which never call this).
        const clearFirstMeaningfulWatchdog = () => {
            if (firstMeaningfulSeen) return;
            firstMeaningfulSeen = true;
            if (firstMeaningfulTimer) {
                clearTimeout(firstMeaningfulTimer);
                firstMeaningfulTimer = null;
            }
        };
        const resetInterChunk = () => {
            if (interChunkTimer) clearTimeout(interChunkTimer);
            interChunkTimer = setTimeout(() => {
                // Early settle: a complete tool call is already captured with no
                // deferred salvage pending, so silence here is the missing
                // response.completed/done — resolve with the tool call instead
                // of a stall error the loop would retry.
                if (settleEarlyOnToolCall('inter_chunk')) return;
                if (process.env.MIXDOG_DEBUG_AGENT) {
                    process.stderr.write(`[agent-trace] ws-timeout kind=inter-chunk afterMs=${interChunkMs}\n`);
                }
                traceWsTimeout('inter_chunk_timeout', interChunkMs);
                terminalError = new Error(`WS stream: inter-chunk inactivity for ${interChunkMs}ms`);
                try { socket.close(4000, 'inter_chunk_timeout'); } catch {}
                // Same half-open guard as the pre-stream watchdog: reject directly
                // so a stuck socket.close() cannot leave the Promise pending.
                finish();
            }, interChunkMs);
        };
        // pi per-event idle: (re)armed only on meaningful output deltas via
        // bumpSemanticIdle(). Keepalive/metadata frames DON'T touch it, so a
        // deltas-then-silent wedge trips this short semantic window.
        const resetSemanticIdle = () => {
            if (!semanticIdleEnabled) return;
            if (semanticIdleTimer) clearTimeout(semanticIdleTimer);
            semanticIdleTimer = setTimeout(() => {
                // Early settle before treating tool-work silence as a stall: if
                // a complete tool call is available and no deferred salvage
                // remains, the turn result is already final even without
                // response.completed/done.
                if (settleEarlyOnToolCall('semantic_idle')) return;
                traceWsTimeout('semantic_idle_timeout', semanticIdleMs);
                terminalError = streamStalledError('Responses WS', semanticIdleMs, { emittedToolCall: !!midState?.emittedToolCall });
                // Partial-final recovery: attach streamed partial state so
                // a wedged FINAL no-tool summary can be accepted as partial-final
                // success by the loop. pendingToolUse gates out mid-flight tools.
                // Fold the held leak-guard tail into `content` FIRST so the
                // partial snapshot below keeps legitimate trailing text; finish()
                // then skips flushLeak (terminalError set) without losing it.
                flushLeak();
                try {
                    terminalError.partialContent = content;
                    terminalError.partialToolCalls = toolCalls.length ? toolCalls.slice() : undefined;
                    terminalError.pendingToolUse = pendingCalls.size > 0
                        || !!midState?.emittedToolCall
                        || toolCalls.length > 0
                        || _toolInFlight === true;
                    terminalError.partialModel = model || undefined;
                } catch { /* best-effort enrichment */ }
                try { terminalError.wsCloseCode = 4000; } catch {}
                try { socket.close(4000, 'semantic_idle_timeout'); } catch {}
                finish();
            }, semanticIdleMs);
            try { semanticIdleTimer.unref?.(); } catch {}
        };
        // Single idle reset — called on EVERY parsed server event (matches
        // codex, which resets one idle timer on every received WS frame). Any
        // frame proves the socket is live; there is no separate "meaningful
        // output" gate. Also clears the pre-stream watchdog defensively in case
        // the first event is not response.created.
        const resetIdle = () => {
            clearPreStreamWatchdog();
            resetInterChunk();
        };
        // Meaningful-output progress bump: called by the same delta cases that
        // call onStreamDelta (text/reasoning/tool args). Arms the semantic idle.
        // Also clears the first-meaningful-frame watchdog: the first content /
        // tool-arg delta is the meaningful signal that satisfies it (response
        // .created is cleared explicitly in its own case). Keepalive/metadata
        // frames never reach here, so they cannot satisfy the watchdog.
        const bumpSemanticIdle = () => { clearFirstMeaningfulWatchdog(); resetSemanticIdle(); };
        const cleanup = () => {
            disableSessionTransportTracking(midState.sessionId);
            if (idleTimer) clearTimeout(idleTimer);
            if (interChunkTimer) { clearTimeout(interChunkTimer); interChunkTimer = null; }
            if (semanticIdleTimer) { clearTimeout(semanticIdleTimer); semanticIdleTimer = null; }
            if (firstMeaningfulTimer) { clearTimeout(firstMeaningfulTimer); firstMeaningfulTimer = null; }
            if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
            if (messageHandler) socket.off('message', messageHandler);
            if (closeHandler) socket.off('close', closeHandler);
            if (errorHandler) socket.off('error', errorHandler);
            if (traceOpenHandler) socket.off('open', traceOpenHandler);
            if (tracePingHandler) socket.off('ping', tracePingHandler);
            if (tracePongHandler) socket.off('pong', tracePongHandler);
            if (abortHandler && externalSignal) externalSignal.removeEventListener('abort', abortHandler);
        };
        const finish = () => {
            logReasoningDeltaSuppression();
            // On a terminal error we must NOT flush buffered text/tool calls:
            // finish() rejects below, so flushing would emit partial output the
            // caller then never consumes as a clean result (double-render/
            // double-dispatch risk). The partial-final path reads partialContent
            // off the error instead. Only flush the held-back tail on success.
            if (!terminalError) flushLeak();
            // Flush any partial-sentinel tail held back mid-stream so
            // legitimate trailing text is never lost (streamed-text path).
            cleanup();
            if (terminalError) { reject(terminalError); return; }
            resolve({
                content,
                model,
                reasoningItems: reasoningItems.length ? reasoningItems : undefined,
                responseItems: responseItemsAdded.length ? responseItemsAdded : undefined,
                // Dedupe by name+args (Fix 2, array side) so an identical
                // synthetic-leaked + native pair can't run the tool twice.
                toolCalls: toolCalls.length ? dedupeToolCallList(toolCalls) : undefined,
                citations: citations.length ? citations : undefined,
                webSearchCalls: webSearchCalls.length ? webSearchCalls : undefined,
                usage,
                stopReason: stopReason || undefined,
                // P1 audit fix: mirror the HTTP/SSE fallback's truncated flag
                // for the WS path (sendViaWebSocket spreads this result
                // through to the provider caller unchanged).
                ...(stopReason === 'length' && content.length > 0 ? { truncated: true } : {}),
                // Early tool-call settle: tell the caller to drop (not pool)
                // this socket. The server may still emit the skipped
                // response.completed/done as orphan frames; reusing the socket
                // would read them as the next request's stream and wedge it.
                ...(_earlySettled ? { closeSocket: true } : {}),
                incompleteReason: incompleteReason || undefined,
                responseId: responseId || undefined,
                serviceTier: responseServiceTier || undefined,
            });
        };
        // Early tool-call settle guard. A fully-formed tool call (real call_id +
        // name, not a deferred salvage placeholder) means the turn's actionable
        // result is already complete. When the server then goes silent without
        // response.completed/response.done, resolve successfully with that tool
        // call rather than surfacing a stall error the loop gates out via
        // pendingToolUse and retries. Returns true if it settled the stream.
        const hasCompleteToolCall = () => sharedHasCompleteToolCall({
            toolCalls,
            pendingSize: pendingCalls.size,
            activeSize: activeToolItems.size,
            toolInFlight: _toolInFlight,
        });
        const settleEarlyOnToolCall = (reason) => {
            if (done || terminalError) return false;
            if (!hasCompleteToolCall()) return false;
            _earlySettled = true;
            // Treat as a normal completion for downstream state: we have the
            // canonical tool call, only the terminal lifecycle frame is missing.
            midState.sawCompleted = true;
            midState.wsEarlySettle = reason;
            done = true;
            // Close and mark keep=false (via closeSocket in the resolve). The
            // late/never response.completed cannot then leak onto a pooled reuse.
            try { socket.close(4000, `early_settle_${reason}`); } catch {}
            finish();
            return true;
        };

        messageHandler = (data) => {
            const frameBytes = _incomingFrameByteLength(data);
            if (maxIncomingFrameBytes > 0 && frameBytes != null && frameBytes > maxIncomingFrameBytes) {
                const err = new Error(
                    `OpenAI WebSocket response frame is too large (${frameBytes} bytes; limit ${maxIncomingFrameBytes} bytes); request is retryable`,
                );
                err.code = 'EOPENAIWSFRAMETOOLARGE';
                err.wsFrameTooLarge = true;
                err.retryable = true;
                terminalError = err;
                midState.wsFrameTooLarge = true;
                try { socket.close(1009, 'frame_too_large'); } catch {}
                finish();
                return;
            }
            if (midState.sendSpan && midState.sendStartedAt != null
                && midState.sendSpanAttemptFirstEvent !== true) {
                midState.sendSpanAttemptFirstEvent = true;
                midState.sendSpan.firstEventMs += performance.now() - midState.sendStartedAt;
            }
            resetIdle();
            // resetIdle() above resets the SINGLE inter-chunk idle timer on
            // EVERY received frame — response.created, metadata,
            // rate_limits, and all deltas keep the socket alive. Separately, do
            // NOT call onStreamDelta for every frame — metadata/keepalive frames
            // must not reset the agent stall watchdog's lastStreamDeltaAt. Only
            // meaningful output (text delta / tool call) updates that timestamp.
            const text = typeof data === 'string' ? data : data.toString('utf-8');
            const event = _parseEvent(text);
            if (!event) return;
            if (WS_TRACE_ENABLED) {
                const type = typeof event.type === 'string' ? event.type : '';
                const empty = type.endsWith('.delta')
                    && (event.delta == null || event.delta === '');
                process.stderr.write(
                    `[ws-trace] t=${new Date().toISOString()} type=${type} bytes=${Buffer.byteLength(text)} empty=${empty}\n`,
                );
            }
            markSessionTransportActivity(midState.sessionId);
            _traceWsHeaderKeys(entry, event, midState, traceProvider, model);
            _captureTurnStateFromEvent(entry, event);
            if (event.error) {
                const err = new Error(event.error.message || 'Responses WS error');
                try {
                    err.payload = event.error;
                    populateHttpStatusFromMessage(err);
                } catch {}
                terminalError = err;
                finish();
                return;
            }
            if (typeof event.type !== 'string') return;
            switch (event.type) {
                case 'response.created':
                    midState.sawResponseCreated = true;
                    if (midState.sendSpan && midState.sendStartedAt != null
                        && midState.sendSpanAttemptResponseCreated !== true) {
                        midState.sendSpanAttemptResponseCreated = true;
                        midState.sendSpan.preResponseCreatedMs += performance.now() - midState.sendStartedAt;
                    }
                    if (event.response?.model) model = event.response.model;
                    if (event.response?.id) responseId = event.response.id;
                    // Server ack (first event). resetIdle() at the top of
                    // messageHandler already cleared the pre-stream watchdog and
                    // armed the single idle timer. response.created is a
                    // MEANINGFUL frame, so it also satisfies the
                    // first-meaningful watchdog (keepalive/metadata frames do
                    // NOT reach this case, so they never clear it).
                    clearFirstMeaningfulWatchdog();
                    try { onStreamDelta?.('semantic'); } catch {}
                    // Do not arm semantic idle until actual model progress.
                    // Transport-only reasoning heartbeats are bounded by the
                    // outer first-visible ceiling instead.
                    break;
                case 'response.output_text.delta':
                    if (event.delta) try {
                        if (!_firstDeltaEmitted) {
                            _firstDeltaEmitted = true;
                            if (process.env.MIXDOG_DEBUG_AGENT) {
                                process.stderr.write(`[agent-trace] ws-first-delta sinceStreaming=${Date.now() - _streamingStart}ms\n`);
                            }
                        }
                    } catch {}
                    // Live text relay (gateway): forward the raw text chunk so
                    // the client renders first tokens before the final replay.
                    // Tool-call/argument deltas intentionally stay off this path.
                    // Invariant: once a non-empty chunk has been relayed live it
                    // cannot be withdrawn, so flag the attempt so a later
                    // mid-stream/truncated failure is NOT retried (retry would
                    // concatenate a second attempt onto rendered text).
                    // Routed through the leaked-tool-call guard: appends to
                    // `content`, forwards visible text via onTextDelta, and
                    // recovers/dispatches any leaked known-tool call.
                    {
                        const progress = relayLeakText(event.delta || '');
                        if (progress?.text || progress?.tool) bumpSemanticIdle();
                    }
                    break;
                case 'response.reasoning_text.delta':
                case 'response.reasoning_summary_text.delta':
                    if (event.type === 'response.reasoning_text.delta') reasoningTextDeltaCount += 1;
                    else reasoningSummaryTextDeltaCount += 1;
                    // Only non-empty reasoning text is model progress. Empty
                    // deltas remain transport activity via resetIdle() above.
                    if (event.delta) {
                        midState.emittedReasoning = true;
                        try { onStreamDelta?.('reasoning'); } catch {}
                        bumpSemanticIdle();
                    }
                    break;
                case 'response.output_item.added':
                    if (event.item?.type === 'function_call') {
                        midState.startedToolCall = true;
                        markActiveToolItem(event.item);
                        pendingCalls.set(event.item.id || '', {
                            name: event.item.name || '',
                            callId: event.item.call_id || '',
                        });
                        _toolInFlight = true;
                    } else if (event.item?.type === 'custom_tool_call') {
                        midState.startedToolCall = true;
                        markActiveToolItem(event.item);
                        _toolInFlight = true;
                    } else if (event.item?.type === 'tool_search_call') {
                        midState.startedToolCall = true;
                        markActiveToolItem(event.item);
                        // Mark tool_search in-flight at item-added time, same
                        // as function_call/custom_tool_call above, so the
                        // semantic-idle stall gate's pendingToolUse never
                        // drops a mid-flight tool_search before
                        // response.output_item.done.
                        _toolInFlight = true;
                    }
                    // Item lifecycle is genuine progress: reset the semantic-idle
                    // timer so long server-side tool latency after item-added
                    // (before any arg delta) is not mistaken for a silent stall.
                    resetSemanticIdle();
                    try { onStreamDelta?.(_toolInFlight ? 'tool' : 'semantic'); } catch {}
                    break;
                case 'response.function_call_arguments.delta':
                    if (event.delta) midState.startedToolCall = true;
                    markActiveToolItem(null, event.item_id);
                    _toolInFlight = true;
                    try { onStreamDelta?.('tool'); } catch {}
                    bumpSemanticIdle();
                    break;
                case 'response.custom_tool_call_input.delta':
                    if (event.delta) midState.startedToolCall = true;
                    markActiveToolItem(null, event.item_id);
                    _toolInFlight = true;
                    try { onStreamDelta?.('tool'); } catch {}
                    bumpSemanticIdle();
                    break;
                case 'response.function_call_arguments.done': {
                    const itemId = event.item_id || '';
                    const pending = pendingCalls.get(itemId);
                    // function_call_arguments.done is a completion signal:
                    // empty/whitespace → no args ({}); a non-empty string that
                    // fails JSON.parse is deterministic bad JSON. Surface an
                    // invalid-args MARKER (not silent {}) so the dispatch loop
                    // returns an is_error tool_result and the model re-issues
                    // valid JSON in the same turn.
                    let args = {};
                    {
                        const _argText = typeof event.arguments === 'string' ? event.arguments : '';
                        if (_argText.trim() !== '') {
                            try {
                                args = JSON.parse(_argText);
                            } catch (err) {
                                args = makeInvalidToolArgsMarker(_argText, err instanceof Error ? err.message : String(err));
                            }
                        }
                    }
                    enrichFunctionCallResponseItem({
                        itemId,
                        callId: pending?.callId || event.call_id || '',
                        name: pending?.name || event.name || '',
                        argumentsText: event.arguments || JSON.stringify(args),
                    });
                    if (pending?.callId && pending?.name) {
                        const call = { id: pending.callId, name: pending.name, arguments: args };
                        toolCalls.push(call);
                        emitToolCallDedupe(call);
                        pendingCalls.delete(itemId);
                        // Keep the function item active until output_item.done:
                        // arguments.done completes args, but the lifecycle item
                        // itself may still be followed by item.done/final frames.
                        _toolInFlight = pendingCalls.size > 0 || activeToolItems.size > 0;
                    } else {
                        // Synthesizing a `tc_${Date.now()}` callId here would
                        // make the next turn fail to match the model's
                        // function_call_output reference. Defer instead and
                        // salvage call_id/name from the final
                        // response.completed.output bundle below. If salvage
                        // also fails we fail the stream explicitly — masking
                        // the gap with a synthetic id just shifts the failure
                        // one turn later under a confusing "No tool output
                        // found for function call" error.
                        toolCalls.push({
                            id: pending?.callId || '',
                            name: pending?.name || '',
                            arguments: args,
                            _pendingItemId: itemId,
                            _deferred: true,
                        });
                    }
                    try { onStreamDelta?.('tool'); } catch {}
                    bumpSemanticIdle();
                    break;
                }
                case 'response.output_item.done':
                    pushResponseItem(event.item);
                    // function_call / output_text already captured via their
                    // dedicated streaming events. The one shape we still need
                    // here is `reasoning` — carries encrypted_content that
                    // must be replayed on the next input to keep the openai-oauth
                    // server-side prompt cache prefix warm.
                    if (event.item?.type === 'reasoning') pushReasoningItem(event.item);
                    if (event.item?.type === 'web_search_call') pushWebSearchCall(event.item);
                    if (event.item?.type === 'function_call') {
                        const item = event.item;
                        const itemId = item.id || '';
                        const callId = item.call_id || '';
                        const name = item.name || '';
                        const argsText = typeof item.arguments === 'string' ? item.arguments : '';
                        let args = {};
                        if (argsText.trim() !== '') {
                            try {
                                args = JSON.parse(argsText);
                            } catch (err) {
                                args = makeInvalidToolArgsMarker(argsText, err instanceof Error ? err.message : String(err));
                            }
                        }
                        const deferred = toolCalls.find((tc) => tc?._deferred && (!itemId || tc._pendingItemId === itemId));
                        if (deferred && callId && name) {
                            deferred.id = callId;
                            deferred.name = name;
                            deferred.arguments = deferred.arguments && Object.keys(deferred.arguments).length > 0 ? deferred.arguments : args;
                            delete deferred._deferred;
                            delete deferred._pendingItemId;
                            emitToolCallDedupe(deferred);
                        } else if (callId && name && !toolCalls.some((tc) => tc?.id === callId)) {
                            const call = { id: callId, name, arguments: args };
                            toolCalls.push(call);
                            emitToolCallDedupe(call);
                        }
                        if (itemId) pendingCalls.delete(itemId);
                        clearActiveToolItem(item, itemId);
                        _toolInFlight = pendingCalls.size > 0 || activeToolItems.size > 0;
                    }
                    if (event.item?.type === 'tool_search_call') {
                        pushToolSearchCall(event.item);
                        clearActiveToolItem(event.item);
                        _toolInFlight = pendingCalls.size > 0 || activeToolItems.size > 0;
                    }
                    if (event.item?.type === 'custom_tool_call') {
                        pushCustomToolCall(event.item);
                        clearActiveToolItem(event.item);
                        _toolInFlight = pendingCalls.size > 0 || activeToolItems.size > 0;
                    }
                    // Item-done is genuine lifecycle progress — reset semantic
                    // idle so latency before the next item/args does not stall.
                    resetSemanticIdle();
                    try {
                        onStreamDelta?.(
                            event.item?.type === 'reasoning'
                                ? 'reasoning'
                                : (_toolInFlight || /tool|function_call/.test(event.item?.type || '') ? 'tool' : 'semantic'),
                        );
                    } catch {}
                    break;
                case 'response.completed': {
                    const completedServiceTier = event.response?.service_tier || event.response?.serviceTier || '';
                    if (completedServiceTier) responseServiceTier = String(completedServiceTier);
                    if (event.response?.usage) {
                        const u = event.response.usage;
                        const rawUsage = responseServiceTier
                            ? { ...u, service_tier: responseServiceTier }
                            : u;
                        usage = {
                            inputTokens: u.input_tokens || 0,
                            outputTokens: u.output_tokens || 0,
                            cachedTokens: extractCachedTokens(u),
                            // openai-oauth reports input_tokens as the total
                            // prompt volume (cached portion is a subset, not
                            // additive). Alias into the cross-provider
                            // `promptTokens` field so downstream loggers have
                            // uniform semantics.
                            promptTokens: u.input_tokens || 0,
                            raw: rawUsage,
                        };
                    }
                    if (!model && event.response?.model) model = event.response.model;
                    if (!responseId && event.response?.id) responseId = event.response.id;
                    let reportedBundleProgress = false;
                    if (event.response?.output) {
                        for (const item of event.response.output) {
                            pushResponseItem(item);
                            if (!content && item.type === 'message') {
                                for (const c of item.content || []) {
                                    if (c.type === 'output_text') {
                                        // Completed-output fallback (no streamed
                                        // text). Route through the leak guard so
                                        // a tool call leaked only in the final
                                        // bundle is recovered, not surfaced as
                                        // visible content. final=true → full flush.
                                        if (leakGuard.enabled) {
                                            const { text, calls } = leakGuard.push(c.text || '', true);
                                            content += text;
                                            if (text) {
                                                try { onStreamDelta?.('text'); } catch {}
                                                reportedBundleProgress = true;
                                            }
                                            for (const lc of calls) dispatchLeakedCall(lc);
                                            if (calls.length) reportedBundleProgress = true;
                                        } else {
                                            content += c.text || '';
                                            if (c.text) {
                                                try { onStreamDelta?.('text'); } catch {}
                                                reportedBundleProgress = true;
                                            }
                                        }
                                        pushOutputTextAnnotations(c);
                                    }
                                }
                            }
                            if (item.type === 'message') {
                                for (const c of item.content || []) {
                                    if (c.type === 'output_text') pushOutputTextAnnotations(c);
                                }
                            }
                            if (item.type === 'web_search_call') {
                                pushWebSearchCall(item);
                                try { onStreamDelta?.('tool'); } catch {}
                                reportedBundleProgress = true;
                            }
                            if (item.type === 'tool_search_call') {
                                pushToolSearchCall(item);
                                try { onStreamDelta?.('tool'); } catch {}
                                reportedBundleProgress = true;
                            }
                            if (item.type === 'custom_tool_call') {
                                pushCustomToolCall(item);
                                try { onStreamDelta?.('tool'); } catch {}
                                reportedBundleProgress = true;
                            }
                            // Salvage path: some streams emit reasoning only
                            // inside the final response.completed.output
                            // bundle (no per-item .done event). Dedup by id.
                            if (item.type === 'reasoning'
                                && !reasoningItems.some(r => r.id === item.id)) {
                                pushReasoningItem(item);
                                try { onStreamDelta?.('reasoning'); } catch {}
                                reportedBundleProgress = true;
                            }
                            // Salvage path for function_call: when
                            // arguments.done fired before (or without) a
                            // matching output_item.added, the deferred tool
                            // call placeholder has empty id/name. The
                            // completed.output bundle carries the canonical
                            // call_id/name; fill them in and emit onToolCall.
                            if (item.type === 'function_call') {
                                const tc = toolCalls.find(
                                    (t) => t._deferred && t._pendingItemId === (item.id || ''),
                                );
                                if (tc) {
                                    if (!tc.id && item.call_id) tc.id = item.call_id;
                                    if (!tc.name && item.name) tc.name = item.name;
                                    if (tc.id && tc.name) {
                                        delete tc._deferred;
                                        delete tc._pendingItemId;
                                        emitToolCallDedupe(tc);
                                    }
                                }
                                try { onStreamDelta?.('tool'); } catch {}
                                reportedBundleProgress = true;
                            }
                        }
                    }
                    if (!reportedBundleProgress) {
                        try { onStreamDelta?.('semantic'); } catch {}
                    }
                    // Salvage validation. Any deferred call still missing
                    // id/name would propagate to the next turn as a
                    // function_call_output the server can't anchor. Fail the
                    // stream now so the caller sees a deterministic error
                    // instead of a cryptic mismatch one turn later.
                    const unresolved = toolCalls.find((t) => t._deferred);
                    if (unresolved) {
                        terminalError = new Error(
                            `${errLabel} function_call salvage failed: missing call_id/name for item_id=${unresolved._pendingItemId || '?'}`,
                        );
                        finish();
                        break;
                    }
                    midState.sawCompleted = true;
                    done = true;
                    finish();
                    break;
                }
                case 'response.done': {
                    // response.done is the terminal frame for some openai-oauth
                    // streams that never emit a separate response.completed.
                    // Route through the same completed/failed/incomplete
                    // normalization based on event.response.status so a
                    // server-side abort (incomplete / failed) does not slip
                    // through as success. status === 'completed' falls
                    // through to the success path with sawCompleted set;
                    // anything else is converted into a terminal error.
                    const status = event.response?.status || '';
                    if (status === 'failed') {
                        midState.responseFailedPayload = event;
                        const msg = event.response?.error?.message
                            || event.error?.message
                            || event.message
                            || 'response.done failed';
                        terminalError = Object.assign(
                            new Error(`${errLabel} response.done failed: ${msg}`),
                            { responseFailed: event },
                        );
                        populateHttpStatusFromMessage(terminalError, msg);
                        done = true;
                        finish();
                        break;
                    }
                    if (status === 'incomplete') {
                        const reasonStr = _incompleteReasonFromEvent(event);
                        if (_isMaxOutputIncompleteReason(reasonStr)) {
                            incompleteReason = reasonStr;
                            stopReason = 'length';
                            midState.sawCompleted = true;
                            done = true;
                            finish();
                            break;
                        }
                        terminalError = Object.assign(
                            new Error(`${errLabel} response.done incomplete: ${reasonStr}`),
                            { responseIncomplete: event, incompleteReason: reasonStr },
                        );
                        done = true;
                        finish();
                        break;
                    }
                    if (status && status !== 'completed') {
                        terminalError = Object.assign(
                            new Error(`${errLabel} response.done unexpected status: ${status}`),
                            { responseDoneStatus: status },
                        );
                        done = true;
                        finish();
                        break;
                    }
                    midState.sawCompleted = true;
                    done = true;
                    finish();
                    break;
                }
                case 'response.incomplete': {
                    // Most incomplete reasons are real failures. max_output_tokens
                    // maps cleanly to Anthropic's stop_reason=max_tokens; treating
                    // it as an error makes Claude retry the same over-budget turn.
                    const reasonStr = _incompleteReasonFromEvent(event);
                    if (_isMaxOutputIncompleteReason(reasonStr)) {
                        incompleteReason = reasonStr;
                        stopReason = 'length';
                        midState.sawCompleted = true;
                        done = true;
                        finish();
                        break;
                    }
                    terminalError = Object.assign(
                        new Error(`${errLabel} response.incomplete: ${reasonStr}`),
                        { responseIncomplete: event, incompleteReason: reasonStr },
                    );
                    finish();
                    break;
                }
                case 'response.failed': {
                    // Stash the payload so the mid-stream classifier can sniff
                    // network_error / stream_disconnected without re-parsing.
                    midState.responseFailedPayload = event;
                    const msg = event.response?.error?.message
                        || event.error?.message
                        || event.message
                        || 'response.failed';
                    terminalError = Object.assign(new Error(`${errLabel} response.failed: ${msg}`), {
                        responseFailed: event,
                    });
                    // Sniff the server message for transient/auth/permanent
                    // hints so the handshake / mid-stream retry classifiers
                    // can route by httpStatus. Without this, server-side
                    // events like "Our servers are currently overloaded"
                    // surfaced as unclassified errors and skipped the
                    // 5xx retry bucket entirely.
                    populateHttpStatusFromMessage(terminalError, msg);
                    finish();
                    break;
                }
                case 'error': {
                    const errMsg = String(event.message || event.error?.message || 'unknown');
                    terminalError = new Error(`${errLabel} error: ${errMsg}`);
                    populateHttpStatusFromMessage(terminalError, errMsg);
                    finish();
                    break;
                }
                default:
                    // Catch any other reasoning-delta variants (e.g.
                    // `response.reasoning.<sub>.delta`) so they are counted
                    // and suppressed, never reaching the user content buffer.
                    if (typeof event.type === 'string'
                        && event.type.startsWith('response.reasoning')
                        && event.type.endsWith('.delta')) {
                        reasoningOtherDeltaCount += 1;
                        // Only non-empty reasoning deltas are model progress;
                        // empty variants remain transport activity only.
                        if (event.delta) {
                            midState.emittedReasoning = true;
                            try { onStreamDelta?.('reasoning'); } catch {}
                            bumpSemanticIdle();
                        }
                    }
                    // response.in_progress is transport activity only;
                    // resetIdle() already kept the socket alive above.
                    else if (event.type === 'response.in_progress') {
                        // No semantic/model progress.
                    }
                    // Other trace-only events fall through.
                    break;
            }
        };
        closeHandler = (code, reason) => {
            if (WS_TRACE_ENABLED) _writeWsLifecycleTrace('close');
            if (done) return;
            midState.wsCloseCode = code;
            if (!terminalError) {
                const r = reason?.toString?.('utf-8') || '';
                const httpStatus = _httpStatusFromWsClose(code, r);
                terminalError = Object.assign(
                    new Error(`OpenAI OAuth WS closed before response.completed (code=${code}${r ? `, reason=${r}` : ''})`),
                    { wsCloseCode: code, wsCloseReason: r, ...(httpStatus ? { httpStatus } : {}) },
                );
            } else if (terminalError && !terminalError.wsCloseCode) {
                try { terminalError.wsCloseCode = code; } catch {}
                try { terminalError.httpStatus = terminalError.httpStatus || _httpStatusFromWsClose(code, reason?.toString?.('utf-8') || ''); } catch {}
            }
            finish();
        };
        errorHandler = (err) => {
            if (WS_TRACE_ENABLED) _writeWsLifecycleTrace('error');
            if (done) return;
            const wrapped = err instanceof Error ? err : new Error(String(err));
            if (terminalError) {
                // Preserve the first terminalError; chain the later socket
                // error in via `cause` (or `suppressed` if cause already set)
                // so diagnostics keep the original failure visible.
                try {
                    if (!terminalError.cause) terminalError.cause = wrapped;
                    else {
                        const list = Array.isArray(terminalError.suppressed)
                            ? terminalError.suppressed
                            : [];
                        list.push(wrapped);
                        terminalError.suppressed = list;
                    }
                } catch {}
            } else {
                terminalError = wrapped;
            }
            try { socket.close(4001, 'stream_error'); } catch {}
            finish();
        };
        if (externalSignal) {
            abortHandler = () => {
                if (done) return;
                const reason = externalSignal.reason;
                terminalError = reason instanceof Error ? reason : new Error('OpenAI OAuth WS aborted by session close');
                // Tag: was this a user/caller abort, or a watchdog abort?
                // Mid-stream retry must skip user aborts but may retry watchdog
                // aborts. The caller-owned AbortController surfaces through
                // externalSignal; the agent stall watchdog signals via a reason
                // object whose name === 'AgentStallAbortError'. stream-watchdog
                // uses StreamStalledAbortError. Anything else → treat as user.
                const reasonName = reason?.name || '';
                if (reasonName === 'AgentStallAbortError'
                    || reasonName === 'StreamStalledAbortError') {
                    midState.watchdogAbort = reasonName;
                } else {
                    midState.userAbort = true;
                }
                try { socket.close(4002, 'aborted'); } catch {}
                finish();
            };
            if (externalSignal.aborted) { abortHandler(); return; }
            externalSignal.addEventListener('abort', abortHandler, { once: true });
        }
        socket.on('message', messageHandler);
        socket.on('close', closeHandler);
        socket.on('error', errorHandler);
        tracePingHandler = () => {
            markSessionTransportActivity(midState.sessionId);
            if (WS_TRACE_ENABLED) _writeWsLifecycleTrace('ping');
        };
        tracePongHandler = () => {
            markSessionTransportActivity(midState.sessionId);
            if (WS_TRACE_ENABLED) _writeWsLifecycleTrace('pong');
        };
        socket.on('ping', tracePingHandler);
        socket.on('pong', tracePongHandler);
        if (WS_TRACE_ENABLED) {
            traceOpenHandler = () => _writeWsLifecycleTrace('open');
            socket.on('open', traceOpenHandler);
            if (socket.readyState === WebSocket.OPEN) _writeWsLifecycleTrace('open');
        }
        armPreStreamWatchdog();
        armFirstMeaningfulWatchdog();
        // No proactive client ping: Codex's Responses WebSocket uses the
        // library default (automatic pong replies, no periodic client ping).
        // Incoming frames remain bounded by the 300s stream idle timeout.
    });
}

