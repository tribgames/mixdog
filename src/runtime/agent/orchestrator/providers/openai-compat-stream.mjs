import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    createTimeoutSignal,
    providerTimeoutError,
} from '../stall-policy.mjs';
import { populateHttpStatusFromMessage } from './retry-classifier.mjs';

function truncatedCompatStreamError(label, detail) {
    return Object.assign(
        new Error(`${label} SSE stream truncated${detail ? `: ${detail}` : ''}`),
        { name: 'TruncatedStreamError', code: 'TRUNCATED_STREAM', truncatedStream: true },
    );
}

// Permanent (non-retryable) tool-call arguments parse failure. Unlike a
// truncated stream, this is raised only once a completion/finish signal has
// been observed for the call — the model emitted complete-but-malformed JSON,
// which is deterministic: re-requesting the same turn yields the same bad
// payload. Mark unsafeToRetry so classifyError() routes it permanent and the
// shared retry wrapper never reissues.
function badToolCallArgumentsError(label, detail) {
    return Object.assign(
        new Error(`${label} tool_call arguments JSON parse failed${detail ? `: ${detail}` : ''}`),
        { name: 'ToolCallArgumentsParseError', code: 'TOOL_CALL_ARGS_PARSE', unsafeToRetry: true },
    );
}

// Salvage malformed tool_call argument JSON emitted by weaker models.
//
// Observed failure mode (deepseek-v4-flash and similar): a string value is
// emitted as an unquoted scalar with the surrounding quotes dropped, e.g.
//   {"pattern": dispatchAiWrapped, "path": "src/agent"}
//                ^^^^^^^^^^^^^^^^^ should be "dispatchAiWrapped"
//   {"query": claude-code PromptInput borderRight, "site": "github.com"}
//             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ should be one string
// The structure is otherwise well-formed. This is deterministic and common in
// code-search workloads where the model passes identifiers/symbols as values.
//
// Strategy: walk the text tracking object/array context and JSON strings
// (honoring backslash escapes). OUTSIDE a string, only value slots are repaired.
// A value slot is the token after `:` in an object, after `[` in an array, after
// `,` in an array, or after `,` followed by the next object key. If the value is
// not already a complete JSON scalar/container, quote the whole unquoted scalar
// up to the next syntactic value boundary. Characters inside string literals are
// never touched, so a `:` or `,` appearing inside a legitimately-quoted value
// can't trigger a rewrite.
//
// Returns the parsed object on success, or null if salvage did not produce
// valid JSON (caller then falls through to the original error path).
function salvageBarewordJson(text) {
    if (typeof text !== 'string' || !text.length) return null;
    let out = '';
    let inStr = false;
    let i = 0;
    const n = text.length;
    const stack = [];
    // expectValue=true means the next non-space char begins a value slot
    // (just after `:` `[` `,` or at the very start).
    let expectValue = true;
    const matchingClose = (open) => open === '{' ? '}' : (open === '[' ? ']' : '');
    const skipWs = (pos) => {
        while (pos < n && /\s/.test(text[pos])) pos++;
        return pos;
    };
    const scanStringEnd = (pos) => {
        if (text[pos] !== '"') return -1;
        for (let j = pos + 1; j < n; j++) {
            if (text[j] === '\\') { j++; continue; }
            if (text[j] === '"') return j;
        }
        return -1;
    };
    const isBoundaryAfter = (pos) => {
        const j = skipWs(pos);
        return j >= n || text[j] === ',' || text[j] === '}' || text[j] === ']';
    };
    const quotedKeyAfterComma = (commaPos) => {
        let j = skipWs(commaPos + 1);
        if (text[j] !== '"') return false;
        const end = scanStringEnd(j);
        if (end < 0) return false;
        j = skipWs(end + 1);
        return text[j] === ':';
    };
    const quotedKeyAt = (pos) => {
        const end = scanStringEnd(pos);
        if (end < 0) return false;
        return text[skipWs(end + 1)] === ':';
    };
    const structuralEnd = (pos) => {
        const open = text[pos];
        const close = matchingClose(open);
        if (!close) return -1;
        const local = [open];
        let localInStr = false;
        for (let j = pos + 1; j < n; j++) {
            const ch = text[j];
            if (localInStr) {
                if (ch === '\\') { j++; continue; }
                if (ch === '"') localInStr = false;
                continue;
            }
            if (ch === '"') { localInStr = true; continue; }
            if (ch === '{' || ch === '[') { local.push(ch); continue; }
            if (ch === '}' || ch === ']') {
                if (matchingClose(local[local.length - 1]) !== ch) return -1;
                local.pop();
                if (!local.length) return j;
            }
        }
        return -1;
    };
    // Find where the unquoted scalar value at `pos` ends. Returns the boundary
    // index, or -1 when the surrounding object structure itself is malformed
    // (so salvage must fail rather than quote over it and change structure).
    //
    // Bracket/brace depth is tracked so a `,` or `:` that belongs to regex/glob
    // value text (e.g. `[,:]`, `{a,b,c}`) is correctly kept INSIDE the scalar,
    // while depth-0 object-member separators are treated as structure. Quotes are
    // NOT treated as string delimiters here: we are inside an unquoted value, so
    // any `"` is literal value text (e.g. a regex char class `["']`), and the
    // whole run is re-quoted via JSON.stringify by appendQuotedScalar.
    const scalarEnd = (pos) => {
        const ctx = stack[stack.length - 1] || '';
        let depth = 0;
        for (let j = pos; j < n; j++) {
            const ch = text[j];
            if (ch === '[' || ch === '{') { depth++; continue; }
            if (ch === ']' || ch === '}') {
                if (depth > 0) { depth--; continue; }
                return j; // depth-0 closer ends our container, so ends the value
            }
            if (depth > 0) continue; // inside nested brackets — part of the value
            // A depth-0 quoted key before any separator means a comma is missing
            // between members: malformed object structure, not value text.
            if (ctx === '{' && ch === '"' && quotedKeyAt(j)) return -1;
            if (ctx === '{' && ch === ':') {
                const before = text.slice(pos, j);
                const next = skipWs(j + 1);
                // A depth-0 colon with whitespace on either side looks like an
                // object member separator that was swallowed into the scalar
                // because a comma is missing (e.g. `foo b: 1`, `foo : 1`).
                // Keep compact colon-bearing scalars such as `C:/x`, `http://x`,
                // or `key:value` recoverable.
                if (!before.trim() || /\s/.test(before) || next !== j + 1) return -1;
            }
            if (ch === ',') {
                if (ctx === '[') return j; // array element separator
                if (ctx === '{') return quotedKeyAfterComma(j) ? j : -1;
                return j;
            }
        }
        return n;
    };
    const appendQuotedScalar = (start, end) => {
        const run = text.slice(start, end);
        const leadLen = run.length - run.trimStart().length;
        const trailLen = run.length - run.trimEnd().length;
        const lead = run.slice(0, leadLen);
        const body = run.slice(leadLen, run.length - trailLen);
        const trail = trailLen ? run.slice(run.length - trailLen) : '';
        if (!body) return false;
        out += lead + JSON.stringify(body) + trail;
        return true;
    };
    const readJsonScalar = (pos) => {
        const tail = text.slice(pos);
        const literal = /^(?:true|false|null)\b/.exec(tail);
        if (literal && isBoundaryAfter(pos + literal[0].length)) return literal[0].length;
        const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(tail);
        if (number && isBoundaryAfter(pos + number[0].length)) return number[0].length;
        return 0;
    };
    while (i < n) {
        const c = text[i];
        if (inStr) {
            out += c;
            if (c === '\\') { // copy the escaped char verbatim
                if (i + 1 < n) { out += text[i + 1]; i += 2; continue; }
            } else if (c === '"') {
                inStr = false;
            }
            i++;
            continue;
        }
        if (c === '"') { inStr = true; out += c; expectValue = false; i++; continue; }
        if (c === ':') { out += c; expectValue = true; i++; continue; }
        if (c === '{') {
            stack.push(c);
            out += c;
            expectValue = false;
            i++;
            continue;
        }
        if (c === '[') {
            if (expectValue) {
                const end = structuralEnd(i);
                if (end >= 0 && isBoundaryAfter(end + 1)) {
                    const segment = text.slice(i, end + 1);
                    try { JSON.parse(segment); out += segment; i = end + 1; expectValue = false; continue; } catch {}
                }
                const valueEnd = scalarEnd(i);
                if (valueEnd < 0) return null;
                if (!appendQuotedScalar(i, valueEnd)) return null;
                i = valueEnd;
                expectValue = false;
                continue;
            }
            stack.push(c);
            out += c;
            expectValue = c === '[';
            i++;
            continue;
        }
        if (c === ',') {
            out += c;
            expectValue = stack[stack.length - 1] === '[' || quotedKeyAfterComma(i);
            i++;
            continue;
        }
        if (c === '}' || c === ']') {
            if (matchingClose(stack[stack.length - 1]) === c) stack.pop();
            out += c;
            expectValue = false;
            i++;
            continue;
        }
        if (/\s/.test(c)) { out += c; i++; continue; }
        // Non-space, non-structural char in a value slot.
        if (expectValue) {
            const scalarLen = readJsonScalar(i);
            if (scalarLen) {
                out += text.slice(i, i + scalarLen);
                i += scalarLen;
                expectValue = false;
                continue;
            }
            const end = scalarEnd(i);
            if (end < 0) return null;
            if (!appendQuotedScalar(i, end)) return null;
            i = end;
            expectValue = false;
            continue;
        }
        out += c;
        i++;
    }
    if (inStr) return null; // unbalanced string — don't risk a bad parse
    try {
        return JSON.parse(out);
    } catch {
        return null;
    }
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
    } catch {
        // Salvage the common weak-model failure: a string value emitted as a
        // bare (unquoted) word. Deterministic and structure-preserving, so a
        // successful salvage yields the exact arguments the model intended.
        const salvaged = salvageBarewordJson(text);
        if (salvaged !== null) {
            try { process.stderr.write(`[toolcall-salvage] label=${label} recovered bareword JSON (len=${text.length})\n`); } catch {}
            return salvaged;
        }
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
        // malformed. Surface a permanent parse error; only an unfinished stream
        // (no finishReason) is the retryable truncation case.
        if (meta?.finishReason) {
            throw badToolCallArgumentsError(label, detailParts.join(' '));
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
            if (!state.toolCalls.length) {
                const parsed = parseResponsesToolCalls(resp, label);
                if (parsed?.length) {
                    for (const parsedCall of parsed) {
                        const call = { ...parsedCall };
                        state.toolCalls.push(call);
                        emitCompatToolCallOnce(state, call, onToolCall);
                    }
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
