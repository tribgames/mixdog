import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    createTimeoutSignal,
    providerTimeoutError,
} from '../stall-policy.mjs';
import { populateHttpStatusFromMessage } from './retry-classifier.mjs';
import { customToolCallFromResponseItem } from './custom-tool-wire.mjs';

function truncatedCompatStreamError(label, detail) {
    return Object.assign(
        new Error(`${label} SSE stream truncated${detail ? `: ${detail}` : ''}`),
        { name: 'TruncatedStreamError', code: 'TRUNCATED_STREAM', truncatedStream: true },
    );
}

// Invalid-tool-args marker. Native-provider convergence (openai-oauth /
// opencode): completed-but-malformed tool_call arguments JSON must NOT throw
// (kills the turn) NOR be silently swallowed to `{}`. Instead the parse
// failure is carried as data on the tool call's `arguments` slot so the
// dispatch loop can turn it into an is_error tool_result and let the model
// re-issue the call with valid JSON in the SAME turn (follow-up retry).
//   { __invalidToolArgs: true, __rawArguments: <raw string>, __parseError: <msg> }
export function makeInvalidToolArgsMarker(rawArguments, parseError) {
    return {
        __invalidToolArgs: true,
        __rawArguments: typeof rawArguments === 'string' ? rawArguments : String(rawArguments ?? ''),
        __parseError: typeof parseError === 'string' ? parseError : String(parseError ?? 'parse error'),
    };
}
export function isInvalidToolArgsMarker(value) {
    return !!value && typeof value === 'object' && value.__invalidToolArgs === true;
}
/** Model-facing tool_result text for a tool call whose arguments failed to
 * parse. Mirrors opencode `The arguments provided to the tool are invalid` and
 * `failed to parse function arguments` — instructs an in-turn retry. */
export function formatInvalidToolArgsResult(call) {
    const name = call?.name || 'tool';
    const detail = call?.arguments?.__parseError || 'arguments were not valid JSON';
    return `The arguments provided to \`${name}\` are invalid JSON and could not be parsed: ${detail}. Re-issue this tool call with valid JSON arguments.`;
}

/** Completed tool_call.arguments must be valid JSON; empty/missing → {}.
 * @param {any} raw - raw arguments value (string or object)
 * @param {string} label - provider label for error messages
 * @param {{id?:string,name?:string,index?:number,finishReason?:string}} [meta] - optional tool-call identity for diagnostics.
 *   When `meta.finishReason` is set, a completion/finish signal was observed for
 *   the call: a JSON.parse failure is then deterministic bad JSON (permanent),
 *   not a mid-stream truncation (retryable). */
export function parseCompletedToolCallArgumentsJson(raw, label, meta) {
    const text = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
    const src = text === '' ? '{}' : text;
    try {
        return JSON.parse(src);
    } catch (err) {
        const preview = text.length <= 64
            ? text
            : text.slice(0, 32) + '...' + text.slice(-32);
        const detailParts = [`invalid tool_call arguments JSON: len=${text.length} preview=${JSON.stringify(preview)}`];
        if (meta) {
            const m = {};
            if (meta.id) m.id = meta.id;
            if (meta.name) m.name = meta.name;
            if (meta.index != null) m.index = meta.index;
            if (meta.finishReason) m.finishReason = meta.finishReason;
            detailParts.push(`tool=${JSON.stringify(m)}`);
        }
        // Invariant: a completion/finish signal was observed for this tool call
        // (finish_reason present, or a per-call/response "done" event fired), so
        // the arguments are NOT mid-stream-truncated — they are complete but
        // malformed. Native convergence: return an invalid-args MARKER (not a
        // throw) so the dispatch loop feeds the parse error back to the model as
        // a tool_result and the model self-corrects in the same turn. Only an
        // unfinished stream (no finishReason) stays the retryable truncation
        // case — that transient behavior is deliberately preserved.
        if (meta?.finishReason) {
            return makeInvalidToolArgsMarker(text, err instanceof Error ? err.message : String(err));
        }
        throw truncatedCompatStreamError(label, detailParts.join(' '));
    }
}

function firstByteCompatStreamError(label) {
    const err = providerTimeoutError(`${label} first byte`, PROVIDER_FIRST_BYTE_TIMEOUT_MS);
    err.firstByteTimeout = true;
    return err;
}

async function nextAsyncWithWatchdog(iterator, { signal, idleMs, idleEnabled, idleLabel } = {}) {
    let idleTimer = null;
    let idleReject = null;
    let idleTimedOut = false;
    const armIdle = () => {
        if (!idleEnabled || !(idleMs > 0)) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimedOut = true;
            const e = providerTimeoutError(idleLabel || 'compat SSE idle', idleMs);
            e.code = 'ETIMEDOUT';
            if (idleReject) {
                const r = idleReject;
                idleReject = null;
                r(e);
            }
        }, idleMs);
        if (typeof idleTimer.unref === 'function') idleTimer.unref();
    };
    armIdle();
    try {
        const result = await new Promise((resolve, reject) => {
            idleReject = reject;
            if (signal?.aborted) {
                const reason = signal.reason;
                reject(reason instanceof Error ? reason : new Error('compat stream aborted'));
                return;
            }
            let onAbort = null;
            if (signal) {
                onAbort = () => {
                    const reason = signal.reason;
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
        if (idleTimedOut) throw providerTimeoutError(idleLabel || 'compat SSE idle', idleMs);
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

export async function consumeCompatChatCompletionStream(stream, { signal, label, onStreamDelta, onToolCall, onTextDelta, parseToolCalls } = {}) {
    const iterator = stream[Symbol.asyncIterator]();
    const firstByteTimeout = createTimeoutSignal(signal, PROVIDER_FIRST_BYTE_TIMEOUT_MS, `${label} first byte`);
    const idleEnabled = PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
    const idleMs = PROVIDER_SSE_IDLE_TIMEOUT_MS;
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
    try {
        while (true) {
            const { value: chunk, done } = await nextAsyncWithWatchdog(iterator, {
                // Until the first SSE chunk, bound the pending read to the
                // first-byte timer (createTimeoutSignal already chains parent).
                signal: sawFirstEvent ? signal : firstByteTimeout.signal,
                idleMs,
                idleEnabled: sawFirstEvent && idleEnabled,
                idleLabel: `${label} SSE idle`,
            });
            if (done) break;
            if (!sawFirstEvent) {
                sawFirstEvent = true;
                firstByteTimeout.cleanup();
            }
            try { onStreamDelta?.(); } catch {}
            if (chunk?.id) responseId = chunk.id;
            if (chunk?.model) model = chunk.model;
            const choice = chunk?.choices?.[0];
            if (choice?.delta?.content) {
                content += choice.delta.content;
                // Live text relay (gateway): explicit assistant text delta.
                // reasoning_content + tool_calls deltas stay off this path.
                if (onTextDelta) {
                    emittedText = true;
                    try { onTextDelta(choice.delta.content); } catch {}
                }
            }
            if (typeof choice?.delta?.reasoning_content === 'string') {
                reasoningContent += choice.delta.reasoning_content;
            }
            mergeToolCallDelta(toolAcc, choice?.delta?.tool_calls, toolBucketState);
            if (choice?.finish_reason) stopReason = choice.finish_reason;
            if (chunk?.usage) rawUsage = chunk.usage;
        }
    } catch (err) {
        // Any mid-stream failure after live text was relayed is non-retryable.
        if (emittedText) throw markErrorLiveTextEmitted(err);
        throw err;
    } finally {
        firstByteTimeout.cleanup();
    }
    if (!sawFirstEvent) {
        if (firstByteTimeout.signal?.aborted) throw firstByteCompatStreamError(label);
        throw firstByteCompatStreamError(label);
    }
    if (!stopReason) {
        const err = truncatedCompatStreamError(label, 'no finish_reason');
        if (emittedText) markErrorLiveTextEmitted(err);
        throw err;
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
        throw err;
    }
    if (Array.isArray(toolCalls) && toolCalls.length) {
        const emitState = { emittedToolCallKeys: new Set() };
        for (const call of toolCalls) emitCompatToolCallOnce(emitState, call, onToolCall);
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

function handleCompatResponsesStreamEvent(event, state, { label, parseResponsesToolCalls, responseOutputText, onStreamDelta, onToolCall, onTextDelta }) {
    if (!event || typeof event.type !== 'string') return;
    const pushToolSearchCall = (item) => {
        if (!item || item.type !== 'tool_search_call') return;
        const callId = item.call_id || item.id || '';
        if (!callId || state.toolCalls.some((call) => call.id === callId)) return;
        const call = {
            id: callId,
            name: 'tool_search',
            arguments: item.arguments && typeof item.arguments === 'object'
                ? item.arguments
                : parseCompletedToolCallArgumentsJson(item.arguments || '{}', label, { id: callId, name: 'tool_search', finishReason: 'done' }),
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
            break;
        case 'response.output_text.delta':
            state.content += event.delta || '';
            state.sawOutput = true;
            try { onStreamDelta?.(); } catch {}
            if (event.delta && onTextDelta) {
                state.emittedText = true;
                try { onTextDelta(event.delta); } catch {}
            }
            break;
        case 'response.output_item.added':
            if (event.item?.type === 'function_call') {
                state.pendingCalls.set(event.item.id || '', {
                    name: event.item.name || '',
                    callId: event.item.call_id || '',
                });
            }
            try { onStreamDelta?.(); } catch {}
            break;
        case 'response.function_call_arguments.delta':
            try { onStreamDelta?.(); } catch {}
            break;
        case 'response.custom_tool_call_input.delta':
            try { onStreamDelta?.(); } catch {}
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
            try { onStreamDelta?.(); } catch {}
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
            } else if (item.type === 'tool_search_call') {
                pushToolSearchCall(item);
            } else if (item.type === 'custom_tool_call') {
                pushCustomToolCall(item);
            }
            try { onStreamDelta?.(); } catch {}
            break;
        }
        case 'response.completed': {
            const resp = event.response || {};
            state.completed = true;
            state.completedResponse = resp;
            if (!state.model && resp.model) state.model = resp.model;
            if (!state.responseId && resp.id) state.responseId = resp.id;
            if (!state.content) state.content = responseOutputText(resp);
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
                } else if (item?.type === 'tool_search_call') {
                    pushToolSearchCall(item);
                } else if (item?.type === 'custom_tool_call') {
                    pushCustomToolCall(item);
                }
            }
            try { onStreamDelta?.(); } catch {}
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
} = {}) {
    const iterator = stream[Symbol.asyncIterator]();
    const firstByteTimeout = createTimeoutSignal(signal, PROVIDER_FIRST_BYTE_TIMEOUT_MS, `${label} first byte`);
    const idleEnabled = PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
    const idleMs = PROVIDER_SSE_IDLE_TIMEOUT_MS;
    const state = {
        content: '',
        model: '',
        responseId: '',
        stopReason: null,
        toolCalls: [],
        pendingCalls: new Map(),
        emittedToolCallKeys: new Set(),
        emittedToolCall: false,
        completed: false,
        completedResponse: null,
        sawOutput: false,
        // Gateway live-text relay invariant: set once a non-empty text chunk
        // has been forwarded. A later failure is non-retryable (rendered text
        // cannot be withdrawn; a retry would concatenate attempts).
        emittedText: false,
    };
    let sawFirstEvent = false;
    const deps = { label, parseResponsesToolCalls, responseOutputText, onStreamDelta, onToolCall, onTextDelta };
    try {
        while (true) {
            const { value: event, done } = await nextAsyncWithWatchdog(iterator, {
                signal: sawFirstEvent ? signal : firstByteTimeout.signal,
                idleMs,
                idleEnabled: sawFirstEvent && idleEnabled,
                idleLabel: `${label} SSE idle`,
            });
            if (done) break;
            if (!sawFirstEvent) {
                sawFirstEvent = true;
                firstByteTimeout.cleanup();
            }
            handleCompatResponsesStreamEvent(event, state, deps);
        }
    } catch (err) {
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
        if (state.emittedText) markErrorLiveTextEmitted(err);
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
    const toolCalls = state.toolCalls.length
        ? state.toolCalls.map(({ _pendingItemId, ...t }) => t)
        : parseResponsesToolCalls(response, label);
    return {
        response,
        content: state.content || responseOutputText(response),
        toolCalls,
        model: state.model || response.model || null,
        responseId: state.responseId || response.id || null,
        stopReason: state.stopReason || null,
    };
}
