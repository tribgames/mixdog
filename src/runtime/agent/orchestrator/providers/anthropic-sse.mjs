/**
 * anthropic-sse.mjs — Anthropic SSE stream parser + mid-stream retry policy.
 *
 * Shared by both Anthropic providers. anthropic-oauth.mjs retains its public
 * re-exports for provider test and integration entry points.
 */
import { randomBytes } from 'crypto';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
    streamStalledError,
} from '../stall-policy.mjs';
import {
    classifyMidstreamError,
    MIDSTREAM_RETRY_POLICY,
    sleepWithAbort,
} from './retry-classifier.mjs';
import { makeInvalidToolArgsMarker } from './openai-compat-stream.mjs';
import { scanLeakedToolCalls, createToolCallDedupe } from './anthropic-leaked-toolcall.mjs';

/** Bounded mid-stream SSE retries (transient stream loss); shared with anthropic.mjs.
 *  Sourced from the single shared retry-budget table (MIDSTREAM_RETRY_POLICY.sse). */
export const ANTHROPIC_MAX_MIDSTREAM_RETRIES = MIDSTREAM_RETRY_POLICY.sse.defaultRetries;

// Policy passed to the shared classifyMidstreamError for the SSE path. The
// top-of-function attempt-budget gate uses defaultRetries (3); perClassifierGate
// is false so the classifier returns raw bucket strings (the loop owns the
// MAX_MIDSTREAM_RETRIES bound), matching the former _classifyMidstreamError.
const SSE_MIDSTREAM_POLICY = {
    mode: 'sse',
    defaultRetries: MIDSTREAM_RETRY_POLICY.sse.defaultRetries,
    perClassifierGate: false,
};

// --- SSE parser ---

function _captureMidstreamAbort(state, reason) {
    if (!state) return;
    const reasonName = reason?.name || '';
    if (reasonName === 'AgentStallAbortError' || reasonName === 'StreamStalledAbortError') {
        state.watchdogAbort = reasonName;
    } else {
        state.userAbort = true;
    }
}

// Abort-aware mid-stream backoff sleep → shared sleepWithAbort
// (retry-classifier.mjs). abortMessage preserves the prior fallback text.
export function _midstreamSleepWithAbort(ms, signal, sleepFn) {
    return sleepWithAbort(ms, signal, sleepFn, 'Anthropic OAuth mid-stream retry backoff aborted');
}

function _statusForAnthropicSseError(type, message) {
    const kind = String(type || '').toLowerCase();
    const text = String(message || '').toLowerCase();
    if (kind.includes('overload') || text.includes('overload')) return 503;
    if (kind.includes('rate_limit') || text.includes('rate limit') || text.includes('quota')) return 429;
    if (kind.includes('authentication') || text.includes('authentication') || text.includes('unauthorized')) return 401;
    if (kind.includes('permission') || text.includes('forbidden')) return 403;
    if (kind.includes('not_found') || text.includes('not found')) return 404;
    if (kind.includes('invalid_request')) return 400;
    return 0;
}

function _anthropicSseError(event) {
    const payload = event?.error && typeof event.error === 'object' ? event.error : event;
    const type = payload?.type || event?.type || 'error';
    const message = payload?.message || 'Anthropic SSE error';
    const err = new Error(`Anthropic OAuth SSE error ${type}: ${message}`);
    err.name = 'AnthropicSseError';
    err.code = 'EANTHROPIC_SSE_ERROR';
    err.providerErrorType = type;
    err.requestId = event?.request_id || event?.requestId || null;
    const status = _statusForAnthropicSseError(type, message);
    if (status) {
        err.httpStatus = status;
        err.status = status;
    }
    return err;
}

export async function parseSSEStream(response, signal, abortStream, onStreamDelta, onToolCall, state, onTextDelta, knownToolNames) {
    // onStreamDelta is a semantic-progress callback. HTTP headers and raw SSE
    // bytes prove transport health but must not refresh semantic watchdogs.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // SEMANTIC idle window: reset only by real model events (message/content/
    // tool deltas), NOT by raw keepalive bytes. A ping-only wedge therefore
    // trips this within the window instead of hanging until the 30-min agent
    // watchdog. See resetIdleTimer + the per-event reset in the loop below.
    // state.semanticIdleTimeoutMs is a test/override seam (same shape as
    // firstMessageTimeoutMs); production uses the shared env-backed default.
    const SSE_IDLE_TIMEOUT_MS = Number.isFinite(Number(state?.semanticIdleTimeoutMs))
        && Number(state.semanticIdleTimeoutMs) > 0
        ? Number(state.semanticIdleTimeoutMs)
        : PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS;
    const SSE_FIRST_MESSAGE_TIMEOUT_MS = Number.isFinite(Number(state?.firstMessageTimeoutMs))
        && Number(state.firstMessageTimeoutMs) > 0
        ? Number(state.firstMessageTimeoutMs)
        : PROVIDER_FIRST_BYTE_TIMEOUT_MS;
    let content = '';
    let hasThinkingContent = false;
    const contentBlockTypes = new Set();
    // Ordered extended-thinking blocks, keyed by content_block index. Each
    // holds the accumulated thinking text + signature exactly as received so
    // it can be round-tripped verbatim on tool-continuation turns (required
    // back on tool_use turns; empty thinking + signature is valid).
    const thinkingBlocks = new Map();
    let model = '';
    let toolCalls = [];
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, raw: null };
    let stopReason = null;
    let stopDetails;
    let buffer = '';
    let idleTimedOut = false;
    let firstMessageTimedOut = false;
    let idleTimer = null;
    let firstMessageTimer = null;
    let currentEvent = '';

    const pendingToolInputs = new Map();

    // Leaked tool-call guard. The model (esp. Opus via OAuth) occasionally
    // emits a tool call as plain text tags inside `text_delta` instead of a
    // native `tool_use` block. `leakBuffer` is a minimal rolling window that
    // only holds back text when a partial sentinel prefix is present, so a
    // tag split across chunk boundaries is still detected while ordinary text
    // still streams promptly. The guard is additive: the native tool_use path
    // (content_block_start/input_json_delta/content_block_stop) is untouched.
    const _knownTools = knownToolNames instanceof Set
        ? knownToolNames
        : new Set(Array.isArray(knownToolNames) ? knownToolNames : []);
    const _leakGuardEnabled = _knownTools.size > 0;
    const _isKnownTool = (name) => _knownTools.has(name);
    let leakBuffer = '';
    // Running markdown fence/inline-code state threaded across text_delta
    // chunks (Fix 1): a tool-call tag inside a ```code fence``` or inline span
    // is a doc example, not a real call — the guard emits it as text.
    let leakFenceState = undefined;
    // Cross-path fingerprint dedupe (Fix 2): a synthesized text-leaked call and
    // an identical native tool_use block must dispatch onToolCall exactly once.
    const _toolDedupe = createToolCallDedupe();

    // Synthesize + dispatch a recovered leaked call exactly like the native
    // content_block_stop path (push into toolCalls, flag state, eager
    // onToolCall). A generated id uses the same `toolu_`-prefixed shape as
    // Anthropic's native tool-call ids.
    const dispatchLeakedCall = (recovered) => {
        let args = recovered?.arguments;
        if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
        // Skip if an identical native (or prior synthetic) call already fired.
        if (!_toolDedupe.shouldDispatch(recovered.name, args)) return;
        const call = {
            id: `toolu_leaked_${randomBytes(8).toString('hex')}`,
            name: recovered.name,
            arguments: args,
        };
        toolCalls.push(call);
        if (state) state.emittedToolCall = true;
        try { onToolCall?.(call); } catch {}
        try { onStreamDelta?.('tool'); } catch {}
    };

    // Feed accumulated text through the scanner. On `final` nothing is held
    // back so legitimate text is never lost at stream end.
    const pumpLeakBuffer = (final) => {
        if (!_leakGuardEnabled) return;
        if (!leakBuffer && !final) return;
        const { emit, calls, rest, fenceState } = scanLeakedToolCalls(leakBuffer, { isKnownTool: _isKnownTool, final, fenceState: leakFenceState });
        leakBuffer = rest;
        leakFenceState = fenceState;
        if (emit) {
            content += emit;
            try { onStreamDelta?.('text'); } catch {}
            if (onTextDelta) {
                if (state) state.emittedText = true;
                try { onTextDelta(emit); } catch {}
            }
        }
        for (const c of calls) dispatchLeakedCall(c);
    };

    // Holds the in-flight reader.read() race rejector so the idle timer can
    // force-unblock the loop even when reader.cancel() fails to settle the
    // pending read (undici half-open socket). See resetIdleTimer below.
    let idleReject = null;

    const firstMessageTimeoutError = () => {
        const err = new Error(`Anthropic OAuth SSE stream produced no message_start within ${SSE_FIRST_MESSAGE_TIMEOUT_MS}ms`);
        err.code = 'EEMPTYSTREAM';
        err.isEmptyStream = true;
        err.firstByteTimeout = true;
        return err;
    };

    const clearFirstMessageTimer = () => {
        if (firstMessageTimer) {
            clearTimeout(firstMessageTimer);
            firstMessageTimer = null;
        }
    };

    const armFirstMessageTimer = () => {
        if (!(SSE_FIRST_MESSAGE_TIMEOUT_MS > 0)) return;
        clearFirstMessageTimer();
        firstMessageTimer = setTimeout(() => {
            if (state?.sawMessageStart) return;
            firstMessageTimedOut = true;
            const err = firstMessageTimeoutError();
            try { abortStream?.(err); } catch (abortErr) {
                try { process.stderr.write(`[anthropic-oauth] sse first-message abortStream failed: ${abortErr?.message ?? String(abortErr)}\n`); } catch {}
            }
            try {
                const _c = reader.cancel('SSE first message timeout');
                if (_c && typeof _c.catch === 'function') _c.catch(() => {});
            } catch (cancelErr) {
                try { process.stderr.write(`[anthropic-oauth] sse first-message cancel failed: ${cancelErr?.message ?? String(cancelErr)}\n`); } catch {}
            }
            if (idleReject) {
                const r = idleReject; idleReject = null; r(err);
            }
        }, SSE_FIRST_MESSAGE_TIMEOUT_MS);
        try { firstMessageTimer.unref?.(); } catch {}
    };

    // Attach the partial stream state to a mid-stream stall error so the agent
    // loop can decide SUCCESS vs FAILURE. The recurring "worker finished but
    // owner never notified" case is a FINAL no-tool summary stream that wedges
    // ping-only after the real work (tool calls) already completed in earlier
    // iterations: there is streamed `content`, no pending tool_use, and no
    // emitted tool call this iteration. The loop treats that as a successful
    // partial-final (deliver the summary we have) instead of dropping it. A
    // stall WITH a pending/emitted tool call stays a hard failure (a tool whose
    // input never completed must never be reported as done).
    const _attachStallPartial = (err) => {
        try {
            err.partialContent = content;
            err.partialToolCalls = toolCalls.length ? toolCalls.slice() : undefined;
            err.pendingToolUse = pendingToolInputs.size > 0;
            err.partialModel = model || undefined;
            err.partialUsage = usage;
            err.partialStopReason = stopReason || undefined;
            err.partialHasThinking = hasThinkingContent;
        } catch { /* best-effort enrichment */ }
        return err;
    };

    const resetIdleTimer = () => {
        // OFF by default. When disabled the
        // idle timer never arms, so the stream is never killed on inactivity;
        // the agent stall watchdog (600s) remains the dead-stream backstop.
        if (!PROVIDER_SSE_IDLE_WATCHDOG_ENABLED) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimedOut = true;
            try { abortStream?.(); } catch (err) {
                try { process.stderr.write(`[anthropic-oauth] sse idle abortStream failed: ${err?.message ?? String(err)}\n`); } catch {}
            }
            try {
                const _c = reader.cancel('SSE idle timeout');
                if (_c && typeof _c.catch === 'function') _c.catch(() => {});
            } catch (err) {
                try { process.stderr.write(`[anthropic-oauth] sse idle cancel failed: ${err?.message ?? String(err)}\n`); } catch {}
            }
            // Force-reject the in-flight reader.read() race even when reader.cancel()
            // fails to settle the pending read: without this the await below stays
            // pending forever and the SSE idle timeout never unblocks the loop —
            // the 391s-hang root cause.
            if (idleReject) {
                const e = _attachStallPartial(streamStalledError('Anthropic OAuth SSE', SSE_IDLE_TIMEOUT_MS, { emittedToolCall: !!state?.emittedToolCall }));
                const r = idleReject; idleReject = null; r(e);
            }
        // Shared provider policy: short SEMANTIC-event inactivity catches the
        // ping-only wedge where SSE starts, emits some deltas, then goes silent
        // while `:ping` keepalives keep the transport socket warm.
        }, SSE_IDLE_TIMEOUT_MS);
        try { idleTimer.unref?.(); } catch {}
    };

    const onAbort = () => {
        try {
            const _c = reader.cancel('SSE aborted');
            if (_c && typeof _c.catch === 'function') _c.catch(() => {});
        } catch {}
    };
    try {
        // Reader ownership begins at getReader() above, so even a signal that
        // was already aborted must pass through this try/finally cleanup path.
        if (signal) {
            if (signal.aborted) {
                _captureMidstreamAbort(state, signal.reason);
                throw signal.reason instanceof Error
                    ? signal.reason
                    : new Error('Anthropic OAuth SSE stream aborted');
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        // Part A / reviewer fix: do NOT arm the SEMANTIC idle timer before the
        // stream has produced its first event. A slow first response is governed
        // by armFirstMessageTimer() (first-byte window) alone; arming the
        // semantic idle here could let it win and mis-abort a legitimately slow
        // first response as a stall. The semantic idle is first armed at
        // `message_start` (see below), so it only ever guards MID-stream silence.
        armFirstMessageTimer();
        streamLoop: while (true) {
            let chunk;
            try {
                // Race the read against the idle timer's rejector so a stuck
                // reader.read() (cancel did not settle it) still unblocks here.
                chunk = await new Promise((resolve, reject) => {
                    idleReject = reject;
                    reader.read().then(resolve, reject);
                });
            } catch (err) {
                if (idleTimedOut) {
                    throw _attachStallPartial(streamStalledError('Anthropic OAuth SSE', SSE_IDLE_TIMEOUT_MS, { emittedToolCall: !!state?.emittedToolCall }));
                }
                if (firstMessageTimedOut) {
                    throw firstMessageTimeoutError();
                }
                if (signal?.aborted) {
                    _captureMidstreamAbort(state, signal.reason);
                    throw signal.reason instanceof Error
                        ? signal.reason
                        : new Error('Anthropic OAuth SSE stream aborted');
                }
                throw err;
            }
            const { done, value } = chunk;
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith(':')) {
                    // SSE comment frame (Anthropic `:ping` keepalive). Keep it
                    // at transport level only: comments must not refresh the
                    // agent's semantic progress timestamp, or a ping-only 200
                    // can look alive forever without message_start/content.
                    // Crucially it also does NOT reset the SEMANTIC idle timer
                    // below — a ping-only wedge must trip the idle abort.
                    continue;
                }
                // Blank lines are SSE record separators — emitted after EVERY
                // frame, including `:ping` keepalives — so they are NOT semantic
                // progress and must not reset the idle timer (else a ping frame's
                // trailing blank would keep a wedge alive forever).
                if (line === '') continue;
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                    continue;
                }
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                    const event = JSON.parse(data);

                    // SEMANTIC idle reset (Part A): reset the idle timer ONLY for
                    // real progress events, NOT for Anthropic keepalives. Anthropic
                    // sends pings as a NAMED event (`event: ping` /
                    // `data: {"type":"ping"}`), not just `:` comment frames, so a
                    // named ping must be excluded here or a ping-only wedge keeps
                    // the timer alive forever. Everything that is not a ping is a
                    // genuine server event (message_start/content/tool/thinking
                    // deltas, message_delta/stop, errors) and counts as progress.
                    if (currentEvent !== 'ping' && event?.type !== 'ping') {
                        resetIdleTimer();
                    }

                    if (currentEvent === 'error' || event?.type === 'error' || event?.error) {
                        throw _anthropicSseError(event);
                    }

                    if (event.type === 'message_start' && event.message) {
                        clearFirstMessageTimer();
                        if (state) state.sawMessageStart = true;
                        // The first protocol event proves the response transport
                        // is live. Report it only here (never for raw bytes,
                        // comments, or ping events), then separately report the
                        // semantic message boundary. Content kinds remain
                        // reasoning/text/tool-specific below.
                        try { onStreamDelta?.('transport'); } catch {}
                        try { onStreamDelta?.('semantic'); } catch {}
                        if (event.message.model) model = event.message.model;
                        if (event.message.usage) {
                            usage.inputTokens = event.message.usage.input_tokens || 0;
                            usage.cachedTokens = event.message.usage.cache_read_input_tokens || 0;
                            usage.cacheWriteTokens = event.message.usage.cache_creation_input_tokens || 0;
                            usage.raw = { ...event.message.usage };
                        }
                    }

                    if (event.type === 'content_block_start') {
                        const block = event.content_block;
                        if (block?.type === 'tool_use') {
                            if (state) state.partialToolCall = true;
                            pendingToolInputs.set(event.index, {
                                id: block.id || '',
                                name: block.name || '',
                                inputJson: '',
                            });
                        }
                        if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
                            if (state) state.emittedThinking = true;
                            if (block.type === 'redacted_thinking') {
                                // Redacted blocks round-trip EXACTLY as
                                // {type:'redacted_thinking',data} — no thinking/
                                // signature fields (the API rejects the extras).
                                // `data` carries the opaque payload verbatim.
                                thinkingBlocks.set(event.index, {
                                    type: 'redacted_thinking',
                                    data: typeof block.data === 'string' ? block.data : '',
                                });
                                hasThinkingContent = true;
                                try { onStreamDelta?.('reasoning'); } catch {}
                            } else {
                                // Seed an ordered thinking block; deltas below
                                // append text + signature into this same slot.
                                thinkingBlocks.set(event.index, {
                                    type: 'thinking',
                                    thinking: typeof block.thinking === 'string' ? block.thinking : '',
                                    signature: typeof block.signature === 'string' ? block.signature : '',
                                });
                            }
                        }
                    }

                    if (event.type === 'content_block_delta') {
                        const delta = event.delta;
                        if (delta?.type) contentBlockTypes.add(delta.type);
                        // Time-to-first-token: stamp the first content delta
                        // (text / thinking / tool input_json) exactly once so
                        // the SSE trace can separate first-byte latency from
                        // total stream/generation time. Without this stamp
                        // ttftMs was always null and reported as 0ms.
                        if (state && !state.ttftAt) state.ttftAt = Date.now();
                        if (delta?.type === 'text_delta') {
                            // Live text relay (gateway): forward the explicit
                            // text chunk. thinking/signature/input_json deltas
                            // intentionally stay off this path.
                            // Invariant: once a non-empty chunk has been relayed
                            // live it cannot be withdrawn, so flag the attempt so
                            // the mid-stream retry loop treats any later failure
                            // as final (a retry would concatenate attempts).
                            if (_leakGuardEnabled) {
                                // Route text through the leaked-tool-call guard.
                                // It appends to `content`, forwards visible text
                                // via onTextDelta, and synthesizes/dispatches any
                                // recovered known-tool call — suppressing the
                                // tags from the visible stream. A partial sentinel
                                // is held in leakBuffer until the next chunk.
                                leakBuffer += delta.text || '';
                                pumpLeakBuffer(false);
                            } else {
                                content += delta.text || '';
                                if (delta.text && onTextDelta) {
                                    if (state) state.emittedText = true;
                                    try { onTextDelta(delta.text); } catch {}
                                }
                                if (delta.text) {
                                    try { onStreamDelta?.('text'); } catch {}
                                }
                            }
                        }
                        if (delta?.type === 'thinking_delta' || delta?.type === 'signature_delta') {
                            if (state) state.emittedThinking = true;
                            // Extended-thinking block: provider reasoning without
                            // user-visible text. Track presence so a final turn
                            // that emitted ONLY thinking (no text_delta, no
                            // tool_use) can be classified by the loop as
                            // synthesis-stalled rather than silent empty.
                            hasThinkingContent = true;
                            // Accumulate the block content in order so it can be
                            // returned intact and round-tripped on the next turn.
                            // A signature_delta may arrive before any thinking_delta
                            // seeded the slot (display-omitted models emit only a
                            // signature) — lazily create it.
                            let tb = thinkingBlocks.get(event.index);
                            if (!tb) {
                                tb = { type: 'thinking', thinking: '', signature: '' };
                                thinkingBlocks.set(event.index, tb);
                            }
                            if (delta.type === 'thinking_delta') {
                                tb.thinking += delta.thinking || '';
                            } else {
                                tb.signature += delta.signature || '';
                            }
                            if ((delta.type === 'thinking_delta' && delta.thinking)
                                || (delta.type === 'signature_delta' && delta.signature)) {
                                try { onStreamDelta?.('reasoning'); } catch {}
                            }
                        }
                        if (delta?.type === 'input_json_delta') {
                            if (state) state.partialToolCall = true;
                            const pending = pendingToolInputs.get(event.index);
                            if (pending) {
                                pending.inputJson += delta.partial_json || '';
                            }
                            try { onStreamDelta?.('tool'); } catch {}
                        }
                    }

                    if (event.type === 'content_block_stop') {
                        const pending = pendingToolInputs.get(event.index);
                        if (pending) {
                            // Bare JSON.parse threw straight up into the
                            // surrounding broad catch, which swallowed the
                            // whole tool_call — the loop never saw it and
                            // the assistant turn ended with an unmatched
                            // tool_use id. Wrap the parse so a malformed
                            // input still produces a tool_call (with an
                            // invalid-args marker and a logged error) instead
                            // of a silent drop or accidental `{}` dispatch.
                            let parsedArgs = {};
                            if (pending.inputJson) {
                                try { parsedArgs = JSON.parse(pending.inputJson); }
                                catch (parseErr) {
                                    process.stderr.write(`[anthropic-oauth] tool args JSON.parse failed (id=${pending.id}, name=${pending.name}): ${parseErr?.message || parseErr}\n`);
                                    parsedArgs = makeInvalidToolArgsMarker(pending.inputJson, parseErr instanceof Error ? parseErr.message : String(parseErr));
                                }
                            }
                            // Tool arguments must be a plain object. Anthropic's
                            // tool_use input is always a JSON object, but a
                            // malformed stream could parse to an array/string/
                            // number — wrap those as {} to keep the contract
                            // (invariant-based, no heuristic coercion).
                            if (parsedArgs === null
                                || typeof parsedArgs !== 'object'
                                || Array.isArray(parsedArgs)) {
                                process.stderr.write(`[anthropic-oauth] tool args not a plain object (id=${pending.id}, name=${pending.name}, type=${Array.isArray(parsedArgs) ? 'array' : typeof parsedArgs}); using {}\n`);
                                parsedArgs = {};
                            }
                            const call = {
                                id: pending.id,
                                name: pending.name,
                                arguments: parsedArgs,
                            };
                            pendingToolInputs.delete(event.index);
                            // Eager dispatch: let the loop start this tool
                            // before message_stop arrives. The loop keys
                            // pending promises by call.id so order is safe.
                            // Fix 2: skip the ENTIRE call (push + dispatch) when a
                            // text-leaked synthetic of the same (name,args) already
                            // fired — otherwise the duplicate stays in `toolCalls`
                            // and the loop executes the side-effecting tool twice.
                            // An invalid-args marker never fingerprint-collides with
                            // a real recovered call, so malformed native calls still
                            // dispatch (the marker path is unaffected).
                            if (_toolDedupe.shouldDispatch(call.name, call.arguments)) {
                                toolCalls.push(call);
                                if (state) state.emittedToolCall = true;
                                // Eager dispatch: let the loop start this tool
                                // before message_stop arrives. The loop keys
                                // pending promises by call.id so order is safe.
                                try { onToolCall?.(call); } catch {}
                            }
                            try { onStreamDelta?.('tool'); } catch {}
                        }
                    }

                    if (event.type === 'message_delta') {
                        if (event.delta?.stop_reason) {
                            stopReason = event.delta.stop_reason;
                        }
                        if (event.delta && (event.delta.stop_details != null || event.delta.category != null)) {
                            const details = event.delta.stop_details;
                            stopDetails = details && typeof details === 'object' && !Array.isArray(details)
                                ? {
                                    ...details,
                                    ...(event.delta.category != null ? { category: event.delta.category } : {}),
                                }
                                : {
                                    ...(details != null ? { value: details } : {}),
                                    ...(event.delta.category != null ? { category: event.delta.category } : {}),
                                };
                        }
                        if (event.usage) {
                            usage.outputTokens = event.usage.output_tokens || 0;
                            usage.raw = { ...(usage.raw || {}), ...event.usage };
                        }
                        if (stopReason === 'tool_use' && toolCalls.length > 0 && pendingToolInputs.size === 0) {
                            if (state) state.sawCompleted = true;
                            break streamLoop;
                        }
                    }
                    if (event.type === 'message_stop') {
                        if (state) state.sawCompleted = true;
                        // Anthropic streams can keep emitting `:ping` keepalive
                        // frames after `message_stop`; if we wait for EOF the
                        // outer reader.read() loop hangs indefinitely. Break
                        // out of streamLoop the moment the message ends.
                        break streamLoop;
                    }
                    // Unified prompt volume — what the model actually ingested.
                    // Anthropic splits input into three billable slots (uncached
                    // input + cache_read + cache_create); keep them separate for
                    // cost math but also expose the sum so cross-provider logs
                    // have a consistent `promptTokens` meaning.
                    usage.promptTokens = (usage.inputTokens || 0)
                        + (usage.cachedTokens || 0)
                        + (usage.cacheWriteTokens || 0);
                } catch (err) {
                    if (err?.code === 'EANTHROPIC_SSE_ERROR') throw err;
                    /* skip malformed events */
                }
            }
        }

        // Stream ended: flush any held-back leaked-tool-call buffer. `final`
        // holds nothing back, so a trailing partial sentinel that never
        // resolved into a real call is surfaced as ordinary text — legitimate
        // user-visible content is never lost on the failure path.
        pumpLeakBuffer(true);

        // Truncated-stream guard: if the reader loop exited (EOF or break)
        // after message_start but without seeing message_stop / a tool_use
        // stop_reason, the assistant turn was cut off mid-flight. Returning
        // success here would silently surface partial content (or a partially
        // streamed tool_use whose input_json never completed) as final.
        // Throw a typed truncated-stream error so the loop can decide whether
        // to retry, surface, or escalate instead of accepting the partial.
        if (state?.sawMessageStart && !state?.sawCompleted) {
            const pendingToolUse = pendingToolInputs.size > 0;
            const err = Object.assign(
                new Error(
                    `Anthropic OAuth SSE stream truncated: message_start without message_stop`
                    + (pendingToolUse ? ` (pending tool_use input)` : ''),
                ),
                {
                    name: 'TruncatedStreamError',
                    code: 'TRUNCATED_STREAM',
                    truncatedStream: true,
                    pendingToolUse,
                    stopReason,
                },
            );
            throw err;
        }

        return {
            content,
            model,
            toolCalls: toolCalls.length ? toolCalls : undefined,
            usage,
            stopReason,
            stopDetails,
            hasThinkingContent,
            contentBlockTypes: Array.from(contentBlockTypes),
            // Ordered extended-thinking blocks (verbatim thinking text +
            // signature) for round-tripping on tool-continuation turns. Emitted
            // in content_block index order. Empty thinking + signature is a
            // valid block (display-omitted models) and is kept intact.
            thinkingBlocks: thinkingBlocks.size
                ? [...thinkingBlocks.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([, b]) => b)
                : undefined,
        };
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        clearFirstMessageTimer();
        if (signal) signal.removeEventListener('abort', onAbort);
        // message_stop deliberately exits before EOF because Anthropic may keep
        // sending pings. Cancel the reader so the successful response body and
        // underlying keep-alive connection are not stranded.
        try { await reader.cancel('Anthropic SSE complete'); } catch {}
        try { reader.releaseLock(); } catch (err) {
            try { process.stderr.write(`[anthropic-oauth] reader releaseLock failed: ${err?.message ?? String(err)}\n`); } catch {}
        }
    }
}

/**
 * Classify an Anthropic SSE failure for single-shot mid-stream retry.
 *
 * Retry is allowed only after `message_start` and before `message_stop`,
 * and only when no tool call has already been surfaced to the loop.
 * That keeps recovery limited to transport/stream stalls without risking
 * duplicate eager tool execution.
 */
// Thin wrapper: the SSE mid-stream decision tree now lives in the shared
// classifyMidstreamError (retry-classifier.mjs, policy.mode='sse'). Kept as a
// named export so internal call sites AND anthropic.mjs (which imports this
// symbol) keep resolving it. Behavior is byte-identical — the shared function
// is the relocated original, gated by SSE_MIDSTREAM_POLICY (defaultRetries=3,
// perClassifierGate:false).
export function _classifyMidstreamError(err, state) {
    return classifyMidstreamError(err, state, SSE_MIDSTREAM_POLICY);
}
