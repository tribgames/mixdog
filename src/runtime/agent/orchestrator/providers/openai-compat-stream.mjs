import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
    createTimeoutSignal,
} from '../stall-policy.mjs';
import { typedStatusFrom } from './retry-classifier.mjs';
import { stampStreamOutcome, STREAM_TRANSPORTS } from './lib/stream-outcome.mjs';
import { customToolCallFromResponseItem, nativeToolSearchCallFromArguments } from './custom-tool-wire.mjs';
import { createLeakGuard, createToolCallDedupe, dedupeToolCallList } from './anthropic-leaked-toolcall.mjs';
import { createActiveToolItemTracker } from './tool-stream-state.mjs';
import {
    closeCompatStream,
    emitCompatToolCallOnce,
    firstByteCompatStreamError,
    markErrorLiveTextEmitted,
    markUnsafeRetryIfToolEmitted,
    nextAsyncWithWatchdog,
    synthLeakedOpenAICall,
} from './openai-compat-stream-common.mjs';
import {
    truncatedCompatStreamError,
    makeInvalidToolArgsMarker,
    isInvalidToolArgsMarker,
    formatInvalidToolArgsResult,
    parseCompletedToolCallArgumentsJson,
} from './lib/openai-tool-args.mjs';

export {
    makeInvalidToolArgsMarker,
    isInvalidToolArgsMarker,
    formatInvalidToolArgsResult,
    parseCompletedToolCallArgumentsJson,
};
export { consumeCompatChatCompletionStream } from './openai-compat-chat-stream.mjs';

function incompleteReasonFromResponsesEvent(event) {
    const reasonObj = event?.response?.incomplete_details
        || event?.incomplete_details
        || event?.response?.status_details
        || null;
    return String(reasonObj?.reason || event?.response?.status || 'incomplete');
}

function isMaxOutputIncompleteReason(reason) {
    return /^(?:max_output_tokens|max_tokens|length|output_token_limit)$/i.test(String(reason || '').trim());
}

// Reconcile a COMPLETED function_call item into state.toolCalls: fill in the
// id/name a streamed call may still be missing, or adopt the item as a new
// call. `response.output_item.done` and the `response.completed` sweep see the
// same item shape and must land on the same single emit, so both route here.
// Returns the item id the done-branch still needs for its pendingCalls /
// tool-tracker bookkeeping.
function reconcileCompatFunctionCallItem(state, item, label, onToolCall) {
    const itemId = item.id || '';
    const tc = state.toolCalls.find(t => t._pendingItemId === itemId)
        || (item.call_id ? state.toolCalls.find(t => t.id === item.call_id) : null);
    if (tc) {
        if (!tc.id && item.call_id) tc.id = item.call_id;
        if (!tc.name && item.name) tc.name = item.name;
        if (tc.id && tc.name) delete tc._pendingItemId;
        emitCompatToolCallOnce(state, tc, onToolCall);
    } else if (item.call_id && item.name) {
        const call = {
            id: item.call_id,
            name: item.name,
            arguments: parseCompletedToolCallArgumentsJson(item.arguments, label, { id: item.call_id, name: item.name, finishReason: 'done' }),
        };
        state.toolCalls.push(call);
        emitCompatToolCallOnce(state, call, onToolCall);
    }
    return itemId;
}

function handleCompatResponsesStreamEvent(event, state, { label, parseResponsesToolCalls, responseOutputText, onStreamDelta, onToolCall, onTextDelta, relayLeakText }) {
    if (!event || typeof event.type !== 'string') return;
    const pushToolSearchCall = (item) => {
        if (!item || item.type !== 'tool_search_call') return;
        const callId = item.call_id || item.id || '';
        if (!callId || state.toolCalls.some((call) => call.id === callId)) return;
        const _tsArgs = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
            ? item.arguments
            : parseCompletedToolCallArgumentsJson(item.arguments || '{}', label, { id: callId, name: 'tool_search', finishReason: 'done' });
        const call = nativeToolSearchCallFromArguments(
            callId,
            // Schema is a plain object ({query,select,limit}); an array must
            // never pass through as args.
            (_tsArgs && typeof _tsArgs === 'object' && !Array.isArray(_tsArgs)) ? _tsArgs : {},
        );
        state.toolCalls.push(call);
        emitCompatToolCallOnce(state, call, onToolCall);
    };
    const pushCustomToolCall = (item) => {
        const call = customToolCallFromResponseItem(item);
        if (!call || state.toolCalls.some((existing) => existing.id === call.id)) return;
        state.toolCalls.push(call);
        emitCompatToolCallOnce(state, call, onToolCall);
    };
    switch (event.type) {
        case 'response.created':
            if (event.response?.model) state.model = event.response.model;
            if (event.response?.id) state.responseId = event.response.id;
            try { onStreamDelta?.('semantic'); } catch {}
            break;
        case 'response.output_text.delta':
            state.sawOutput = true;
            // Route assistant text through the leaked-tool-call guard (appends
            // to state.content, forwards visible text, recovers leaked calls).
            if (relayLeakText) relayLeakText(event.delta || '');
            else {
                state.content += event.delta || '';
                if (event.delta) {
                    try { onStreamDelta?.('text'); } catch {}
                }
                if (event.delta && onTextDelta) {
                    state.emittedText = true;
                    try { onTextDelta(event.delta); } catch {}
                }
            }
            break;
        case 'response.reasoning_text.delta':
        case 'response.reasoning_summary_text.delta':
            if (event.delta) {
                // Reasoning exposure latch (mirrors the Chat path): set at
                // DELTA time, not at completion. Exposed reasoning cannot be
                // withdrawn, so any later failure is non-replayable — a retry
                // or non-streaming reset would duplicate it.
                state.emittedReasoning = true;
                try { onStreamDelta?.('reasoning'); } catch {}
            }
            break;
        case 'response.output_item.added':
            if (event.item?.type === 'function_call') {
                state.pendingCalls.set(event.item.id || '', {
                    name: event.item.name || '',
                    callId: event.item.call_id || '',
                });
                state.toolTracker?.mark(event.item);
                state.toolInFlight = true;
            } else if (event.item?.type === 'custom_tool_call') {
                state.toolTracker?.mark(event.item);
                state.toolInFlight = true;
            } else if (event.item?.type === 'tool_search_call') {
                // Mark tool_search in-flight at item-added time, same as
                // function_call/custom_tool_call above, so the stall-recovery
                // pendingToolUse gate never drops a mid-flight tool_search
                // before response.output_item.done pushes it.
                state.toolTracker?.mark(event.item);
                state.toolInFlight = true;
            }
            try { onStreamDelta?.(state.toolInFlight ? 'tool' : 'semantic'); } catch {}
            break;
        case 'response.function_call_arguments.delta':
            // A tool call's args are streaming — mark tool work in-flight so a
            // mid-args stall is NEVER accepted as a text-only partial-final.
            state.toolTracker?.mark(null, event.item_id);
            state.toolInFlight = true;
            try { onStreamDelta?.('tool'); } catch {}
            break;
        case 'response.custom_tool_call_input.delta':
            // Custom-tool input streams before output_item.done records the call
            // in pendingCalls; flag it so a mid-input stall gates out partial-
            // final success (otherwise a tool-bearing turn looks text-only).
            state.toolTracker?.mark(null, event.item_id);
            state.toolInFlight = true;
            try { onStreamDelta?.('tool'); } catch {}
            break;
        case 'response.function_call_arguments.done': {
            const itemId = event.item_id || '';
            const pending = state.pendingCalls.get(itemId);
            const call = {
                id: pending?.callId || event.call_id || '',
                name: pending?.name || event.name || '',
                // `*.done` ⇒ arguments are complete; a parse failure is
                // deterministic bad JSON (permanent), not stream truncation.
                arguments: parseCompletedToolCallArgumentsJson(event.arguments, label, { id: pending?.callId || event.call_id, name: pending?.name || event.name, finishReason: 'done' }),
                _pendingItemId: itemId,
            };
            state.toolCalls.push(call);
            if (call.id && call.name) delete call._pendingItemId;
            emitCompatToolCallOnce(state, call, onToolCall);
            try { onStreamDelta?.('tool'); } catch {}
            break;
        }
        case 'response.output_item.done': {
            const item = event.item || {};
            if (item.type === 'function_call') {
                const itemId = reconcileCompatFunctionCallItem(state, item, label, onToolCall);
                // Drop the resolved function item from pendingCalls before
                // recomputing toolInFlight — otherwise a completed call keeps
                // pendingCalls.size > 0 and the latch never clears, so a later
                // text-only stall stays wrongly gated as tool-bearing.
                if (itemId) state.pendingCalls.delete(itemId);
                state.toolTracker?.clear(item, itemId);
                state.toolInFlight = state.pendingCalls.size > 0 || (state.toolTracker ? state.toolTracker.items.size > 0 : false);
            } else if (item.type === 'tool_search_call') {
                pushToolSearchCall(item);
                state.toolTracker?.clear(item, item.id || '');
                state.toolInFlight = state.pendingCalls.size > 0 || (state.toolTracker ? state.toolTracker.items.size > 0 : false);
            } else if (item.type === 'custom_tool_call') {
                pushCustomToolCall(item);
                state.toolTracker?.clear(item, item.id || '');
                state.toolInFlight = state.pendingCalls.size > 0 || (state.toolTracker ? state.toolTracker.items.size > 0 : false);
            }
            const kind = item.type === 'reasoning'
                ? 'reasoning'
                : (/tool|function_call|web_search_call/.test(item.type || '') ? 'tool' : 'semantic');
            try { onStreamDelta?.(kind); } catch {}
            break;
        }
        case 'response.completed': {
            const resp = event.response || {};
            state.completed = true;
            state.completedResponse = resp;
            if (!state.model && resp.model) state.model = resp.model;
            if (!state.responseId && resp.id) state.responseId = resp.id;
            let reportedBundleProgress = false;
            if (!state.content) {
                const fallbackText = responseOutputText(resp);
                if (fallbackText) {
                    if (relayLeakText) {
                        const result = relayLeakText(fallbackText, true);
                        reportedBundleProgress = !!(result?.text || result?.tool);
                    } else {
                        state.content = fallbackText;
                        try { onStreamDelta?.('text'); } catch {}
                        reportedBundleProgress = true;
                    }
                }
            }
            for (const item of resp.output || []) {
                if (item?.type === 'function_call') {
                    reconcileCompatFunctionCallItem(state, item, label, onToolCall);
                    try { onStreamDelta?.('tool'); } catch {}
                    reportedBundleProgress = true;
                } else if (item?.type === 'tool_search_call') {
                    pushToolSearchCall(item);
                    try { onStreamDelta?.('tool'); } catch {}
                    reportedBundleProgress = true;
                } else if (item?.type === 'custom_tool_call') {
                    pushCustomToolCall(item);
                    try { onStreamDelta?.('tool'); } catch {}
                    reportedBundleProgress = true;
                } else if (item?.type === 'reasoning') {
                    try { onStreamDelta?.('reasoning'); } catch {}
                    reportedBundleProgress = true;
                } else if (item?.type === 'web_search_call') {
                    try { onStreamDelta?.('tool'); } catch {}
                    reportedBundleProgress = true;
                }
            }
            if (!reportedBundleProgress) {
                try { onStreamDelta?.('semantic'); } catch {}
            }
            break;
        }
        case 'response.done':
            if (!event.response || event.response.status === 'completed') state.completed = true;
            else if (event.response.status === 'failed') {
                const msg = event.response?.error?.message || 'response.done failed';
                const err = new Error(`xAI Responses stream response.done failed: ${msg}`);
                _applyTypedResponsesFailure(err, event);
                throw err;
            } else if (event.response.status === 'incomplete') {
                const reason = incompleteReasonFromResponsesEvent(event);
                if (isMaxOutputIncompleteReason(reason)) {
                    // Max-output cutoff with a tool call still in flight means
                    // the function-call arguments were truncated — do NOT mark
                    // this a clean completion, or partial args surface as a
                    // successful tool call. Treat as unsafe/partial instead.
                    if (state.toolInFlight || (state.pendingCalls && state.pendingCalls.size > 0)) {
                        const err = truncatedCompatStreamError(label, `incomplete (${reason}) with tool call in flight`);
                        err.streamStalled = true;
                        err.pendingToolUse = true;
                        err.partialContent = state.content || '';
                        throw err;
                    }
                    state.completed = true;
                    state.stopReason = 'length';
                    state.completedResponse = event.response || state.completedResponse;
                    break;
                }
                throw new Error(`xAI Responses stream response.done incomplete: ${reason}`);
            }
            break;
        case 'response.failed': {
            const msg = event.response?.error?.message || event.error?.message || event.message || 'response.failed';
            const err = new Error(`xAI Responses stream response.failed: ${msg}`);
            // The wire event's OWN typed status/code is preserved verbatim. A
            // forbidden/unknown failure is never coerced into a synthetic 500:
            // without typed evidence it stays unclassified and is surfaced.
            _applyTypedResponsesFailure(err, event);
            throw err;
        }
        case 'response.incomplete': {
            const reason = incompleteReasonFromResponsesEvent(event);
            if (isMaxOutputIncompleteReason(reason)) {
                if (state.toolInFlight || (state.pendingCalls && state.pendingCalls.size > 0)) {
                    const err = truncatedCompatStreamError(label, `incomplete (${reason}) with tool call in flight`);
                    err.streamStalled = true;
                    err.pendingToolUse = true;
                    err.partialContent = state.content || '';
                    throw err;
                }
                state.completed = true;
                state.stopReason = 'length';
                state.completedResponse = event.response || state.completedResponse;
                break;
            }
            throw new Error(`xAI Responses stream response.incomplete: ${reason}`);
        }
        case 'error': {
            const msg = event.message || event.error?.message || 'unknown';
            const err = new Error(`xAI Responses stream error: ${msg}`);
            _applyTypedResponsesFailure(err, event);
            throw err;
        }
        default:
            break;
    }
}

// Copy the TYPED failure evidence a Responses `response.failed` / `error`
// event carries (numeric HTTP status, provider error code/type) onto the
// thrown error. Message text is never parsed, and nothing is synthesized when
// the event declares no typed status. The wire-event marker routes the error
// through the fatal-code deny-list / default-retry classification.
function _applyTypedResponsesFailure(err, event) {
    const detail = event?.response?.error || event?.error || null;
    const typed = typedStatusFrom(detail, event);
    if (typed) err.httpStatus = typed;
    const code = detail?.code ?? detail?.type ?? event?.code ?? null;
    if (code != null && code !== '') err.providerErrorCode = String(code);
    if (detail) err.providerError = detail;
    err.providerWireError = true;
    return err;
}

export async function consumeCompatResponsesStream(stream, {
    signal,
    label,
    onStreamDelta,
    onToolCall,
    onTextDelta,
    parseResponsesToolCalls,
    responseOutputText,
    knownToolNames,
    semanticIdleTimeoutMs,
} = {}) {
    try { onStreamDelta?.('transport'); } catch {}
    const iterator = stream[Symbol.asyncIterator]();
    let iteratorDone = false;
    const firstByteTimeout = createTimeoutSignal(signal, PROVIDER_FIRST_BYTE_TIMEOUT_MS, `${label} first byte`);
    const idleOverrideEnabled = Number.isFinite(Number(semanticIdleTimeoutMs)) && Number(semanticIdleTimeoutMs) > 0;
    const idleEnabled = idleOverrideEnabled || PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
    // Per-event (last-event-relative) SEMANTIC idle — see the Chat path note.
    const idleMs = Number.isFinite(Number(semanticIdleTimeoutMs)) && Number(semanticIdleTimeoutMs) > 0
        ? Number(semanticIdleTimeoutMs)
        : PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS;
    const state = {
        content: '',
        model: '',
        responseId: '',
        stopReason: null,
        toolCalls: [],
        pendingCalls: new Map(),
        emittedToolCallKeys: new Set(),
        emittedToolCall: false,
        // Active tool-item / alias tracking shared with the WS + HTTP-SSE
        // Responses streams (tool-stream-state.mjs): mark on output_item.added /
        // arg-input deltas, clear on output_item.done. Unions id/call_id/item_id
        // aliases so a mark under one key and a clear under another resolve to
        // the same item — closes the custom-tool-input in-flight gap that a bare
        // boolean toolInFlight latch could not (a mid-input stall now gates out
        // text-only partial-final).
        toolTracker: createActiveToolItemTracker(),
        completed: false,
        completedResponse: null,
        sawOutput: false,
        // Fix 2: cross-path name+args dedupe shared by synthetic leaked-call
        // dispatch and every native emit in this Responses stream.
        _toolDedupe: createToolCallDedupe(),
        // Gateway live-text relay invariant: set once a non-empty text chunk
        // has been forwarded. A later failure is non-retryable (rendered text
        // cannot be withdrawn; a retry would concatenate attempts).
        emittedText: false,
        // Reasoning-exposure invariant, latched by
        // handleCompatResponsesStreamEvent on the first non-empty reasoning
        // delta (see the Chat path's emittedReasoning).
        emittedReasoning: false,
        semanticIdleDeadlineAt: 0,
    };
    const reportProgress = (kind) => {
        if (kind !== 'transport') state.semanticIdleDeadlineAt = Date.now() + idleMs;
        try { onStreamDelta?.(kind); } catch {}
    };
    let sawFirstEvent = false;
    // Leaked tool-call guard for the Responses text stream. Same recovery as
    // the Chat path: leaked XML/harmony tool syntax in `output_text.delta` is
    // suppressed from visible text, synthesized, and dispatched like native.
    const leakGuard = createLeakGuard({ knownToolNames, harmony: true });
    const leakedCalls = [];
    const dispatchLeakedCall = (recovered) => {
        const call = synthLeakedOpenAICall(recovered);
        emitCompatToolCallOnce(state, call, onToolCall);
        leakedCalls.push(call);
        reportProgress('tool');
    };
    const relayLeakText = leakGuard.enabled
        ? (delta, final = false) => {
            const { text, calls } = leakGuard.push(delta, final);
            if (text) {
                state.content += text;
                reportProgress('text');
                if (onTextDelta) {
                    state.emittedText = true;
                    try { onTextDelta(text); } catch {}
                }
            }
            for (const c of calls) dispatchLeakedCall(c);
            return { text: !!text, tool: calls.length > 0 };
        }
        : null;
    const flushLeak = () => {
        if (!leakGuard.enabled) return;
        const { text, calls } = leakGuard.flush();
        if (text) {
            state.content += text;
            reportProgress('text');
            if (onTextDelta) {
                state.emittedText = true;
                try { onTextDelta(text); } catch {}
            }
        }
        for (const c of calls) dispatchLeakedCall(c);
    };
    const deps = { label, parseResponsesToolCalls, responseOutputText, onStreamDelta: reportProgress, onToolCall, onTextDelta, relayLeakText };
    // Canonical stream-outcome stamp for EVERY reject path of the Responses
    // consumer — identical contract to the Chat consumer. Without it a failure
    // is "unknown" to the replay gates and an upstream retry / transport
    // fallback / non-streaming reset could duplicate exposed output.
    const _toolInFlight = () => (state.pendingCalls?.size > 0)
        || (state.toolTracker?.items?.size > 0)
        || state.toolInFlight === true;
    const _stampResponsesOutcome = (err, extra = {}) => {
        try {
            stampStreamOutcome(err, {
                transport: STREAM_TRANSPORTS.SSE,
                provider: 'openai-compat-responses',
                terminalObserved: state.completed === true,
                continuation: state.completed !== true,
                textEmitted: state.emittedText === true,
                textObservedChars: (state.content || '').length,
                reasoningEmitted: state.emittedReasoning === true,
                toolCallsStarted: state.toolCalls.length > 0 || leakedCalls.length > 0 || _toolInFlight(),
                toolCallsComplete: state.toolCalls.length + leakedCalls.length,
                toolCallsDispatched: state.emittedToolCall === true
                    ? Math.max(1, state.emittedToolCallKeys?.size || 0)
                    : 0,
                pendingToolInput: _toolInFlight(),
                ...extra,
            });
        } catch { /* stamping is best-effort */ }
        return err;
    };
    try {
        while (true) {
            const { value: event, done } = await nextAsyncWithWatchdog(iterator, {
                signal: sawFirstEvent ? signal : firstByteTimeout.signal,
                idleMs,
                idleDeadlineAt: state.semanticIdleDeadlineAt,
                idleEnabled: sawFirstEvent && idleEnabled && state.semanticIdleDeadlineAt > 0,
                idleLabel: `${label} SSE idle`,
                // Unsafe-to-retry once any tool call (native or recovered-leaked)
                // has been emitted this stream — avoid a double side-effect.
                emittedToolCall: () => state.emittedToolCall || leakedCalls.length > 0,
            });
            if (done) {
                iteratorDone = true;
                break;
            }
            if (!sawFirstEvent) {
                sawFirstEvent = true;
                firstByteTimeout.cleanup();
            }
            reportProgress('transport');
            handleCompatResponsesStreamEvent(event, state, deps);
        }
        flushLeak();
    } catch (err) {
        // Partial-final recovery: attach streamed partial state so a
        // wedged FINAL no-tool summary can be accepted as partial-final success.
        if (err?.streamStalled === true) {
            try {
                err.partialContent = state.content || '';
                err.pendingToolUse = state.emittedToolCall === true
                    || leakedCalls.length > 0
                    || (state.pendingCalls && state.pendingCalls.size > 0)
                    || (Array.isArray(state.toolCalls) && state.toolCalls.length > 0)
                    || (state.toolTracker && state.toolTracker.items.size > 0)
                    || state.toolInFlight === true;
                err.partialModel = state.model || undefined;
            } catch { /* best-effort */ }
        }
        throw _stampResponsesOutcome(markUnsafeRetryIfToolEmitted(err, state));
    } finally {
        firstByteTimeout.cleanup();
        if (!iteratorDone) closeCompatStream(stream, iterator);
    }
    if (!sawFirstEvent) {
        // Pre-output: nothing was sampled, so this stays replay-safe.
        if (firstByteTimeout.signal?.aborted) throw _stampResponsesOutcome(firstByteCompatStreamError(label));
        throw _stampResponsesOutcome(firstByteCompatStreamError(label));
    }
    if (!state.completed) {
        const err = truncatedCompatStreamError(label, 'no response.completed');
        if (state.emittedText) {
            // Truncation after visible output: keep the streamed partial
            // (same rule) so the loop can finalize it as partial-final instead
            // of dropping the turn. liveText marking still blocks replay.
            markErrorLiveTextEmitted(err);
            try {
                err.streamStalled = true;
                err.partialContent = state.content || '';
                err.pendingToolUse = state.emittedToolCall === true
                    || leakedCalls.length > 0
                    || (state.pendingCalls && state.pendingCalls.size > 0)
                    || (Array.isArray(state.toolCalls) && state.toolCalls.length > 0)
                    || (state.toolTracker && state.toolTracker.items.size > 0)
                    || state.toolInFlight === true;
                err.partialModel = state.model || undefined;
            } catch { /* best-effort */ }
        }
        throw _stampResponsesOutcome(err);
    }
    const unresolved = state.toolCalls.find(t => t._pendingItemId);
    if (unresolved) {
        throw _stampResponsesOutcome(new Error(
            `xAI Responses stream function_call salvage failed: missing call_id/name for item_id=${unresolved._pendingItemId || '?'}`,
        ));
    }
    const response = state.completedResponse || {
        id: state.responseId || null,
        model: state.model || null,
        output_text: state.content,
        output: [],
    };
    let toolCalls = state.toolCalls.length
        ? state.toolCalls.map(({ _pendingItemId, ...t }) => t)
        : parseResponsesToolCalls(response, label);
    // Fold recovered leaked calls in (already emitted via onToolCall above).
    // Dedupe by name+args so an identical native+synthetic pair can't run twice.
    if (leakedCalls.length) {
        toolCalls = dedupeToolCallList([...(Array.isArray(toolCalls) ? toolCalls : []), ...leakedCalls]);
    }
    return {
        response,
        content: state.content || responseOutputText(response),
        toolCalls,
        model: state.model || response.model || null,
        responseId: state.responseId || response.id || null,
        stopReason: state.stopReason || null,
    };
}
