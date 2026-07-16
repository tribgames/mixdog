import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
    streamStalledError,
    createTimeoutSignal,
    providerTimeoutError,
} from '../stall-policy.mjs';
import { populateHttpStatusFromMessage } from './retry-classifier.mjs';
import { customToolCallFromResponseItem } from './custom-tool-wire.mjs';
import { createLeakGuard, createToolCallDedupe, dedupeToolCallList } from './anthropic-leaked-toolcall.mjs';
import { randomBytes } from 'crypto';
import { createActiveToolItemTracker } from './tool-stream-state.mjs';
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

// Synthesize a native-shaped OpenAI tool call from a recovered leaked call.
// Matches the `call_...` id scheme the native Responses/Chat paths use so the
// dispatch loop and any downstream tool_result reference line up.
function synthLeakedOpenAICall(recovered) {
    let args = recovered?.arguments;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
    return {
        id: `call_leaked_${randomBytes(8).toString('hex')}`,
        name: recovered.name,
        arguments: args,
    };
}

function firstByteCompatStreamError(label) {
    const err = providerTimeoutError(`${label} first byte`, PROVIDER_FIRST_BYTE_TIMEOUT_MS);
    err.firstByteTimeout = true;
    return err;
}

async function nextAsyncWithWatchdog(iterator, {
    signal,
    idleMs,
    idleDeadlineAt,
    idleEnabled,
    idleLabel,
    emittedToolCall,
} = {}) {
    let idleTimer = null;
    let idleReject = null;
    let idleTimedOut = false;
    let iteratorCloseRequested = false;
    const closeIterator = () => {
        if (iteratorCloseRequested) return;
        iteratorCloseRequested = true;
        try {
            const closing = iterator?.return?.();
            if (closing && typeof closing.catch === 'function') closing.catch(() => {});
        } catch { /* closing must never replace the watchdog/abort error */ }
    };
    // Double-dispatch guard (reviewer High): if a tool call was already emitted
    // this stream, a stall must be unsafe-to-retry so withRetry() won't replay
    // the turn and re-run the side-effecting tool. `emittedToolCall` may be a
    // boolean or a getter evaluated at abort time (state mutates mid-stream).
    const didEmitToolCall = () => {
        try { return typeof emittedToolCall === 'function' ? !!emittedToolCall() : !!emittedToolCall; }
        catch { return false; }
    };
    const armIdle = () => {
        if (!idleEnabled || !(idleMs > 0)) return;
        if (idleTimer) clearTimeout(idleTimer);
        const deadline = Number(idleDeadlineAt);
        const delayMs = Number.isFinite(deadline) && deadline > 0
            ? Math.max(0, deadline - Date.now())
            : idleMs;
        idleTimer = setTimeout(() => {
            idleTimedOut = true;
            // SEMANTIC idle abort: this timer is (re)armed only around waiting
            // for the NEXT stream event, so keepalive/comment frames the SDK
            // filters out cannot keep it alive. Throw the named terminal
            // StreamStalledError so the retry-classifier treats it as a stream
            // failure (owner gets notified) rather than a user cancel.
            const e = streamStalledError(idleLabel || 'compat SSE', idleMs, { emittedToolCall: didEmitToolCall() });
            closeIterator();
            if (idleReject) {
                const r = idleReject;
                idleReject = null;
                r(e);
            }
        }, delayMs);
        if (typeof idleTimer.unref === 'function') idleTimer.unref();
    };
    armIdle();
    try {
        const result = await new Promise((resolve, reject) => {
            idleReject = reject;
            if (signal?.aborted) {
                const reason = signal.reason;
                closeIterator();
                reject(reason instanceof Error ? reason : new Error('compat stream aborted'));
                return;
            }
            let onAbort = null;
            if (signal) {
                onAbort = () => {
                    const reason = signal.reason;
                    closeIterator();
                    reject(reason instanceof Error ? reason : new Error('compat stream aborted'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }
            iterator.next().then(
                (value) => {
                    if (idleTimer) clearTimeout(idleTimer);
                    if (signal && onAbort) {
                        try { signal.removeEventListener('abort', onAbort); } catch {}
                    }
                    resolve(value);
                },
                (err) => {
                    if (idleTimer) clearTimeout(idleTimer);
                    if (signal && onAbort) {
                        try { signal.removeEventListener('abort', onAbort); } catch {}
                    }
                    reject(err);
                },
            );
        });
        return result;
    } catch (err) {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleTimedOut) throw streamStalledError(idleLabel || 'compat SSE', idleMs, { emittedToolCall: didEmitToolCall() });
        throw err;
    }
}

function mergeToolCallDelta(accByIndex, deltaCalls, bucketState) {
    for (const tc of deltaCalls || []) {
        let key;
        if (Number.isFinite(Number(tc?.index))) {
            key = `n:${Number(tc.index)}`;
        } else if (tc.id) {
            key = `id:${tc.id}`;
        } else if (tc.function?.name) {
            const anonId = ++bucketState._nextAnonId;
            key = `anon:${anonId}`;
            bucketState._lastAnonKey = key;
        } else {
            key = bucketState._lastAnonKey;
            if (!key) continue;
        }
        let prev = accByIndex.get(key);
        if (!prev) {
            prev = {
                id: '',
                type: 'function',
                function: { name: '', arguments: '' },
                _order: ++bucketState._orderSeq,
            };
            accByIndex.set(key, prev);
        }
        if (tc.id) prev.id = tc.id;
        if (tc.type) prev.type = tc.type;
        if (tc.function?.name && !prev.function.name) prev.function.name = tc.function.name;
        if (tc.function?.arguments) {
            const delta = tc.function.arguments;
            // Some providers send the full (cumulative) arguments value in
            // each delta rather than incremental chunks. Detect this: if
            // the incoming delta starts with what we already have, it's a
            // replacement — replace instead of append so the JSON stays
            // well-formed and we avoid "invalid tool_call arguments JSON".
            if (prev.function.arguments && delta.startsWith(prev.function.arguments)) {
                prev.function.arguments = delta;
            } else {
                prev.function.arguments += delta;
            }
        }
    }
}

export function toolCallsFromStreamAcc(accByIndex, parseToolCalls, label, finishReason) {
    if (!accByIndex.size) return undefined;
    const choice = {
        // Carry the observed finish_reason onto the synthetic choice so the
        // provider's parseToolCalls can mark a JSON.parse failure permanent
        // (deterministic bad JSON) rather than retryable (mid-stream truncation).
        finish_reason: finishReason || null,
        message: {
            tool_calls: [...accByIndex.values()]
                .sort((a, b) => a._order - b._order)
                .map(v => { const { _order, ...rest } = v; return rest; }),
        },
    };
    return parseToolCalls(choice, label);
}

function emitCompatToolCallOnce(state, call, onToolCall) {
    if (typeof onToolCall !== 'function' || !call?.id || !call?.name) return false;
    const key = `id:${call.id}`;
    if (!state.emittedToolCallKeys) state.emittedToolCallKeys = new Set();
    if (state.emittedToolCallKeys.has(key)) return false;
    // Fix 2: cross-path name+args dedupe. A synthesized text-leaked call and an
    // identical native tool_call must fire onToolCall exactly once. state._toolDedupe
    // is created per stream; when absent (older callers) behavior is unchanged.
    if (state._toolDedupe && !state._toolDedupe.shouldDispatch(call.name, call.arguments)) {
        // Still mark the id as emitted so later id-frames for the same native
        // call don't retry, but do NOT invoke onToolCall (already dispatched).
        state.emittedToolCallKeys.add(key);
        return false;
    }
    state.emittedToolCallKeys.add(key);
    state.emittedToolCall = true;
    const { _pendingItemId, ...cleanCall } = call;
    try { onToolCall(cleanCall); } catch {}
    return true;
}

function markUnsafeRetryIfToolEmitted(err, state) {
    if (!err) return err;
    if (state?.emittedToolCall) {
        try {
            err.emittedToolCall = true;
            err.unsafeToRetry = true;
        } catch {}
    }
    if (state?.emittedText) markErrorLiveTextEmitted(err);
    return err;
}

// Invariant guard: once a non-empty live text chunk has been forwarded to the
// client (gateway live relay) it is irreversibly rendered and cannot be
// withdrawn. Flag the error permanent so the shared classifier / retry
// wrappers never reissue the attempt and concatenate a second one.
function markErrorLiveTextEmitted(err) {
    if (!err) return err;
    try {
        err.liveTextEmitted = true;
        err.unsafeToRetry = true;
    } catch {}
    return err;
}

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

export async function consumeCompatChatCompletionStream(stream, {
    signal,
    label,
    onStreamDelta,
    onToolCall,
    onTextDelta,
    parseToolCalls,
    knownToolNames,
    semanticIdleTimeoutMs,
} = {}) {
    // Reaching the consumer means the HTTP response/stream object exists.
    // Record transport health without satisfying semantic model activity.
    try { onStreamDelta?.('transport'); } catch {}
    const iterator = stream[Symbol.asyncIterator]();
    const firstByteTimeout = createTimeoutSignal(signal, PROVIDER_FIRST_BYTE_TIMEOUT_MS, `${label} first byte`);
    const idleOverrideEnabled = Number.isFinite(Number(semanticIdleTimeoutMs)) && Number(semanticIdleTimeoutMs) > 0;
    const idleEnabled = idleOverrideEnabled || PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
    // Per-event (last-event-relative) SEMANTIC idle: nextAsyncWithWatchdog arms
    // the timer only while awaiting the NEXT stream event, so a stream that
    // emits some deltas then goes silent trips it within the window.
    const idleMs = Number.isFinite(Number(semanticIdleTimeoutMs)) && Number(semanticIdleTimeoutMs) > 0
        ? Number(semanticIdleTimeoutMs)
        : PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS;
    let semanticIdleDeadlineAt = 0;
    const reportProgress = (kind) => {
        if (kind !== 'transport') semanticIdleDeadlineAt = Date.now() + idleMs;
        try { onStreamDelta?.(kind); } catch {}
    };
    let sawFirstEvent = false;
    let content = '';
    let reasoningContent = '';
    // Invariant flag for the gateway live-text relay: set once a non-empty
    // text chunk has been forwarded to the client. A failure after this point
    // must be treated as permanent — the rendered text cannot be withdrawn and
    // a retry would concatenate a second attempt.
    let emittedText = false;
    let model = '';
    let responseId = '';
    let stopReason = null;
    let rawUsage = null;
    const toolAcc = new Map();
    const toolBucketState = { _orderSeq: 0, _nextAnonId: 0, _lastAnonKey: null };
    // Fix 2: one dedupe per stream, shared by the synthetic leaked-call
    // dispatch and every native emit so an identical (name,args) fires once.
    const _toolDedupe = createToolCallDedupe();
    // Persistent stream state: leaked calls dispatch eagerly, before the final
    // native parse. If the iterator later fails this latch makes the failure
    // unsafe-to-retry so the eager side effect cannot run twice.
    const streamEmitState = {
        emittedToolCallKeys: new Set(),
        emittedToolCall: false,
        _toolDedupe,
    };
    // Leaked tool-call guard: the model sometimes emits a tool call as plain
    // text (XML `<invoke>`/`<function_calls>` or gpt-oss harmony
    // `<|channel|>...to=functions.NAME...<|call|>`) inside `delta.content`
    // instead of a native `tool_calls` delta. Route content through the guard
    // so leaked calls are suppressed from visible text, synthesized, and
    // dispatched like native calls. Additive: the native tool_calls path is
    // untouched. Harmony detection is opt-in here (gpt-oss compat backends).
    const leakGuard = createLeakGuard({ knownToolNames, harmony: true });
    const dispatchLeakedCall = (recovered) => {
        const call = synthLeakedOpenAICall(recovered);
        emitCompatToolCallOnce(streamEmitState, call, onToolCall);
        reportProgress('tool');
        return call;
    };
    const leakedCalls = [];
    const relayText = (delta) => {
        const { text, calls } = leakGuard.push(delta);
        if (text) {
            content += text;
            reportProgress('text');
            if (onTextDelta) {
                emittedText = true;
                try { onTextDelta(text); } catch {}
            }
        }
        for (const c of calls) leakedCalls.push(dispatchLeakedCall(c));
    };
    const flushLeak = () => {
        const { text, calls } = leakGuard.flush();
        if (text) {
            content += text;
            reportProgress('text');
            if (onTextDelta) {
                emittedText = true;
                try { onTextDelta(text); } catch {}
            }
        }
        for (const c of calls) leakedCalls.push(dispatchLeakedCall(c));
    };
    try {
        while (true) {
            const { value: chunk, done } = await nextAsyncWithWatchdog(iterator, {
                // Until the first SSE chunk, bound the pending read to the
                // first-byte timer (createTimeoutSignal already chains parent).
                signal: sawFirstEvent ? signal : firstByteTimeout.signal,
                idleMs,
                idleDeadlineAt: semanticIdleDeadlineAt,
                idleEnabled: sawFirstEvent && idleEnabled && semanticIdleDeadlineAt > 0,
                idleLabel: `${label} SSE idle`,
                // A stall after a tool call has already been dispatched (native
                // or recovered-leaked) must be unsafe-to-retry (no double-run).
                emittedToolCall: () => streamEmitState.emittedToolCall || toolAcc.size > 0,
            });
            if (done) break;
            if (!sawFirstEvent) {
                sawFirstEvent = true;
                firstByteTimeout.cleanup();
            }
            try { onStreamDelta?.('transport'); } catch {}
            if (chunk?.id) responseId = chunk.id;
            if (chunk?.model) model = chunk.model;
            const choice = chunk?.choices?.[0];
            if (typeof choice?.delta?.role === 'string' && choice.delta.role) {
                reportProgress('semantic');
            }
            if (choice?.delta?.content) {
                // Live text relay (gateway): explicit assistant text delta,
                // routed through the leaked-tool-call guard (which appends to
                // `content`, forwards visible text, and recovers leaked calls).
                // reasoning_content + tool_calls deltas stay off this path.
                if (leakGuard.enabled) {
                    relayText(choice.delta.content);
                } else {
                    content += choice.delta.content;
                    reportProgress('text');
                    if (onTextDelta) {
                        emittedText = true;
                        try { onTextDelta(choice.delta.content); } catch {}
                    }
                }
            }
            // DeepSeek/OpenCode use reasoning_content; newer LM Studio builds
            // use reasoning, and some local compatibility shims expose
            // thinking. They are aliases, never concatenate multiple aliases
            // from the same chunk.
            const reasoningDelta = typeof choice?.delta?.reasoning_content === 'string'
                ? choice.delta.reasoning_content
                : typeof choice?.delta?.reasoning === 'string'
                    ? choice.delta.reasoning
                    : typeof choice?.delta?.thinking === 'string'
                        ? choice.delta.thinking
                        : null;
            if (reasoningDelta !== null) {
                reasoningContent += reasoningDelta;
                if (reasoningDelta) {
                    reportProgress('reasoning');
                }
            }
            if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length) {
                reportProgress('tool');
            }
            mergeToolCallDelta(toolAcc, choice?.delta?.tool_calls, toolBucketState);
            if (choice?.finish_reason) stopReason = choice.finish_reason;
            if (chunk?.usage) rawUsage = chunk.usage;
        }
        // Flush any partial-sentinel tail held back mid-stream so legitimate
        // trailing text is never lost.
        if (leakGuard.enabled) flushLeak();
    } catch (err) {
        // Any mid-stream failure after live text was relayed is non-retryable —
        // but the streamed partial must still ride on the error (CC rule: once
        // output is visible, keep it and finalize with a notice instead of
        // discarding the turn). The loop's partial-final path consumes these.
        if (emittedText) {
            markErrorLiveTextEmitted(err);
            try {
                err.partialContent = content;
                err.pendingToolUse = toolAcc.size > 0 || leakedCalls.length > 0;
                err.partialModel = model || undefined;
            } catch { /* best-effort */ }
            throw markUnsafeRetryIfToolEmitted(err, streamEmitState);
        }
        // Partial-final recovery: on a mid-stream stall, attach the
        // streamed partial state so the loop can accept a wedged FINAL no-tool
        // summary as partial-final success. pendingToolUse gates out any
        // in-flight/emitted tool call.
        if (err?.streamStalled === true) {
            try {
                err.partialContent = content;
                err.pendingToolUse = toolAcc.size > 0 || leakedCalls.length > 0;
                err.partialModel = model || undefined;
            } catch { /* best-effort */ }
        }
        throw markUnsafeRetryIfToolEmitted(err, streamEmitState);
    } finally {
        firstByteTimeout.cleanup();
    }
    if (!sawFirstEvent) {
        if (firstByteTimeout.signal?.aborted) throw firstByteCompatStreamError(label);
        throw firstByteCompatStreamError(label);
    }
    if (!stopReason) {
        const err = truncatedCompatStreamError(label, 'no finish_reason');
        if (emittedText) {
            // Truncation after visible output: preserve the partial (CC-style)
            // instead of surfacing a bare terminal error. streamStalled lets
            // the loop's partial-final acceptance path pick it up; liveText
            // marking still blocks any retry/replay.
            markErrorLiveTextEmitted(err);
            try {
                err.streamStalled = true;
                err.partialContent = content;
                err.pendingToolUse = toolAcc.size > 0 || leakedCalls.length > 0;
                err.partialModel = model || undefined;
            } catch { /* best-effort */ }
        }
        throw markUnsafeRetryIfToolEmitted(err, streamEmitState);
    }
    const message = {
        content: content || null,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    };
    const rawToolCalls = [...toolAcc.values()]
        .sort((a, b) => a._order - b._order)
        .map(v => { const { _order, ...rest } = v; return rest; })
        .filter(tc => tc.id || tc.function?.name);
    if (rawToolCalls.length) message.tool_calls = rawToolCalls;
    const response = {
        id: responseId || null,
        model: model || null,
        choices: [{ message, finish_reason: stopReason }],
        usage: rawUsage || undefined,
    };
    let toolCalls;
    try {
        // stopReason is guaranteed non-null here (the `if (!stopReason)` guard
        // above already threw on a finish-less stream), so any parse failure is
        // deterministic bad JSON, not truncation.
        toolCalls = toolCallsFromStreamAcc(toolAcc, parseToolCalls, label, stopReason);
    } catch (err) {
        if (stopReason && err.truncatedStream) {
            try { err.message += ` finish_reason=${stopReason}`; } catch {}
        }
        if (emittedText) markErrorLiveTextEmitted(err);
        throw markUnsafeRetryIfToolEmitted(err, streamEmitState);
    }
    if (Array.isArray(toolCalls) && toolCalls.length) {
        for (const call of toolCalls) emitCompatToolCallOnce(streamEmitState, call, onToolCall);
    }
    // Fold recovered leaked calls into the returned toolCalls so the dispatch
    // loop treats them exactly like native ones. They were already emitted via
    // onToolCall in relayText/flushLeak, so no re-dispatch here. Dedupe the
    // final array by name+args (Fix 2, array side): a synthetic leaked call and
    // an identical native tool_call must not both remain, else the loop runs
    // the side-effecting tool twice.
    if (leakedCalls.length) {
        toolCalls = dedupeToolCallList([...(Array.isArray(toolCalls) ? toolCalls : []), ...leakedCalls]);
    }
    return {
        response,
        model,
        content,
        toolCalls,
        stopReason,
        reasoningContent: reasoningContent || null,
        rawUsage,
    };
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
        const call = {
            id: callId,
            name: 'load_tool',
            // Schema is a plain object ({query,select,limit}); an array must
            // never pass through as args.
            arguments: (_tsArgs && typeof _tsArgs === 'object' && !Array.isArray(_tsArgs)) ? _tsArgs : {},
            nativeType: 'tool_search_call',
        };
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
                populateHttpStatusFromMessage(err, msg);
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
            populateHttpStatusFromMessage(err, msg);
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
            populateHttpStatusFromMessage(err, msg);
            throw err;
        }
        default:
            break;
    }
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
            if (done) break;
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
        throw markUnsafeRetryIfToolEmitted(err, state);
    } finally {
        firstByteTimeout.cleanup();
    }
    if (!sawFirstEvent) {
        if (firstByteTimeout.signal?.aborted) throw firstByteCompatStreamError(label);
        throw firstByteCompatStreamError(label);
    }
    if (!state.completed) {
        const err = truncatedCompatStreamError(label, 'no response.completed');
        if (state.emittedText) {
            // Truncation after visible output: keep the streamed partial
            // (CC rule) so the loop can finalize it as partial-final instead
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
        throw err;
    }
    const unresolved = state.toolCalls.find(t => t._pendingItemId);
    if (unresolved) {
        throw new Error(`xAI Responses stream function_call salvage failed: missing call_id/name for item_id=${unresolved._pendingItemId || '?'}`);
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
