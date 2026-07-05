/**
 * gemini-stream.mjs — Gemini stream consumption (REST + SDK) and stream guards.
 *
 * Extracted from gemini.mjs. Owns chunk aggregation, completion assertions,
 * timeout/truncation error shapes and the text leak guard that recovers
 * tool calls emitted as plain text. gemini.mjs imports the consumer entry
 * points; parseToolCalls/emitGeminiToolCalls stay in gemini.mjs and are
 * imported back (function-level, no init-time cycle).
 */
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_MAX_BEFORE_WARN_MS,
    PROVIDER_SSE_IDLE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    providerTimeoutError,
    resolveTimeoutMs,
} from '../stall-policy.mjs';
import { scanLeakedToolCalls } from './anthropic-leaked-toolcall.mjs';
import { traceHash, stableTraceStringify } from './trace-utils.mjs';
import { parseToolCalls, emitGeminiToolCalls, collectGeminiGroundingSources } from './gemini.mjs';

export const GEMINI_FIRST_BYTE_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS',
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    { minMs: 30_000, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

export function geminiTimeoutError(label, timeoutMs) {
    const err = providerTimeoutError(label, timeoutMs);
    err.name = 'GeminiTimeoutError';
    err.code = 'EGEMINITIMEOUT';
    return err;
}

export function geminiTruncatedStreamError(message) {
    return Object.assign(
        new Error(message),
        { name: 'TruncatedStreamError', code: 'TRUNCATED_STREAM', truncatedStream: true },
    );
}

// CC-rule safety stamp for Gemini stream failures (provider-stall audit):
// once text has been relayed to the live gateway or a leaked tool call was
// dispatched, replaying the request would double-render/double-execute — the
// outer withRetry() in gemini.mjs wraps the WHOLE stream, and a bare
// EGEMINITIMEOUT classifies transient, so without these markers a mid-stream
// stall after visible output was silently retried. Visible-text stalls also
// gain streamStalled + partialContent so the loop's partial-final path can
// keep the streamed output instead of dropping the turn.
export function stampGeminiStreamFailure(err, { relayedText = '', textLeakGuard = null, sawFunctionCall = false } = {}) {
    if (!err || typeof err !== 'object') return err;
    const leaked = (textLeakGuard?.getLeakedToolCalls?.() || []).length > 0;
    const visible = relayedText.length > 0;
    // A native functionCall chunk (not a text-leaked one) is also an in-flight
    // tool use — replaying would double-dispatch, and partial-final must NOT
    // treat it as a clean no-tool summary.
    const pendingTool = leaked || sawFunctionCall === true;
    try {
        if (visible) { err.liveTextEmitted = true; err.unsafeToRetry = true; }
        if (pendingTool) { err.emittedToolCall = true; err.unsafeToRetry = true; }
        // TRUNCATED_STREAM EOF after visible output must also carry the
        // partial-final stamps (streamStalled/partialContent), aligning with the
        // compat streams — otherwise live output is dropped instead of kept.
        if (visible && !leaked
            && (err.code === 'EGEMINITIMEOUT' || err.code === 'TRUNCATED_STREAM' || err.truncatedStream === true)) {
            err.streamStalled = true;
            if (typeof err.partialContent !== 'string') err.partialContent = relayedText;
            if (err.pendingToolUse === undefined) err.pendingToolUse = pendingTool;
        }
    } catch { /* best-effort */ }
    return err;
}

// True when a streamed Gemini chunk carries a native functionCall part (as
// opposed to a tool call leaked as plain text, tracked by textLeakGuard).
export function geminiChunkHasFunctionCall(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return false;
    return parts.some((p) => p && p.functionCall);
}

/**
 * Aggregate streamed GenerateContentResponse chunks into one response object
 * (same shape as a non-streaming generateContent JSON body).
 * Mirrors @google/generative-ai aggregateResponses().
 */
export function aggregateGeminiStreamChunks(responses) {
    const lastResponse = responses[responses.length - 1];
    const aggregatedResponse = {
        promptFeedback: lastResponse?.promptFeedback,
    };
    for (const response of responses) {
        if (response?.candidates) {
            let candidateIndex = 0;
            for (const candidate of response.candidates) {
                if (!aggregatedResponse.candidates) aggregatedResponse.candidates = [];
                if (!aggregatedResponse.candidates[candidateIndex]) {
                    aggregatedResponse.candidates[candidateIndex] = { index: candidateIndex };
                }
                const aggCand = aggregatedResponse.candidates[candidateIndex];
                aggCand.citationMetadata = candidate.citationMetadata;
                aggCand.groundingMetadata = candidate.groundingMetadata;
                aggCand.finishReason = candidate.finishReason;
                aggCand.finishMessage = candidate.finishMessage;
                aggCand.safetyRatings = candidate.safetyRatings;
                if (candidate.content?.parts) {
                    if (!aggCand.content) {
                        aggCand.content = {
                            role: candidate.content.role || 'user',
                            parts: [],
                        };
                    }
                    for (const part of candidate.content.parts) {
                        const newPart = {};
                        if (part.text) newPart.text = part.text;
                        if (part.functionCall) newPart.functionCall = part.functionCall;
                        if (part.thoughtSignature) newPart.thoughtSignature = part.thoughtSignature;
                        if (part.thought_signature) newPart.thought_signature = part.thought_signature;
                        if (part.executableCode) newPart.executableCode = part.executableCode;
                        if (part.codeExecutionResult) newPart.codeExecutionResult = part.codeExecutionResult;
                        if (Object.keys(newPart).length === 0) newPart.text = '';
                        aggCand.content.parts.push(newPart);
                    }
                }
                candidateIndex++;
            }
        }
        if (response?.usageMetadata) aggregatedResponse.usageMetadata = response.usageMetadata;
    }
    return aggregatedResponse;
}

export function assertGeminiStreamCompleted({ sawStreamChunk, finishReason, label }) {
    if (!sawStreamChunk) {
        throw geminiTruncatedStreamError(`${label} truncated: empty stream`);
    }
    if (!finishReason) {
        throw geminiTruncatedStreamError(`${label} truncated: no finishReason`);
    }
}

// Concatenate the text parts of a single streamed Gemini chunk. Used to feed
// the gateway live-text relay (onTextDelta) with the incremental text payload
// as each SSE/SDK chunk arrives. Returns '' for tool-call / thought-only /
// malformed chunks so the caller can skip empty emits.
export function geminiChunkText(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    let text = '';
    for (const p of parts) {
        if (p && typeof p.text === 'string') text += p.text;
    }
    return text;
}

export function relayGeminiStreamText(t, { onTextDelta, textLeakGuard }) {
    if (!t) return;
    if (textLeakGuard) textLeakGuard.feedText(t);
    else if (onTextDelta) { try { onTextDelta(t); } catch {} }
}

/**
 * Rolling scanner for tool calls leaked as plain XML/antml tags inside Gemini
 * `part.text` streams. Mirrors the Anthropic OAuth guard: suppress tags from
 * visible text, synthesize known-tool calls, dispatch via onToolCall.
 */
export function createGeminiTextLeakGuard({ knownToolNames, onTextDelta, onToolCall, onStreamDelta }) {
    const _knownTools = knownToolNames instanceof Set
        ? knownToolNames
        : new Set(Array.isArray(knownToolNames) ? knownToolNames : []);
    const _enabled = _knownTools.size > 0;
    const _isKnownTool = (name) => _knownTools.has(name);
    let leakBuffer = '';
    const leakedCalls = [];
    const dispatchedFingerprints = new Set();

    const toolCallFingerprint = (name, args) => {
        let a = args;
        if (a === null || typeof a !== 'object' || Array.isArray(a)) a = {};
        return traceHash(stableTraceStringify({ name: name || '', args: a }));
    };

    const dispatchLeakedCall = (recovered) => {
        let args = recovered?.arguments;
        if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
        const fp = toolCallFingerprint(recovered.name, args);
        if (dispatchedFingerprints.has(fp)) return;
        dispatchedFingerprints.add(fp);
        const idHash = traceHash(stableTraceStringify({
            name: recovered.name,
            args,
            leak: true,
        })).slice(0, 16);
        const call = {
            id: `gemini_leaked_${idHash}`,
            name: recovered.name,
            arguments: args,
        };
        leakedCalls.push(call);
        try { onToolCall?.(call); } catch {}
        try { onStreamDelta?.(); } catch {}
    };

    const pumpLeakBuffer = (final) => {
        if (!_enabled) return;
        if (!leakBuffer && !final) return;
        const { emit, calls, rest } = scanLeakedToolCalls(leakBuffer, { isKnownTool: _isKnownTool, final });
        leakBuffer = rest;
        if (emit && onTextDelta) {
            try { onTextDelta(emit); } catch {}
        }
        for (const c of calls) dispatchLeakedCall(c);
    };

    return {
        get enabled() { return _enabled; },
        feedText(text) {
            if (!text) return;
            if (!_enabled) {
                try { onTextDelta?.(text); } catch {}
                return;
            }
            leakBuffer += text;
            pumpLeakBuffer(false);
        },
        finalize() {
            pumpLeakBuffer(true);
        },
        scrubAssistantText(raw) {
            if (!raw) return '';
            if (!_enabled) return raw;
            const { emit, calls, rest } = scanLeakedToolCalls(raw, { isKnownTool: _isKnownTool, final: true });
            for (const c of calls) dispatchLeakedCall(c);
            return emit + rest;
        },
        filterNativeToolCalls(nativeCalls) {
            if (!_enabled || !nativeCalls?.length) return nativeCalls;
            const kept = [];
            for (const call of nativeCalls) {
                const fp = toolCallFingerprint(call?.name, call?.arguments);
                if (dispatchedFingerprints.has(fp)) continue;
                dispatchedFingerprints.add(fp);
                kept.push(call);
            }
            return kept.length ? kept : undefined;
        },
        getLeakedToolCalls() {
            return leakedCalls.length ? [...leakedCalls] : [];
        },
    };
}

export async function consumeGeminiRestStreamResponse(response, { signal, onStreamDelta, onTextDelta, textLeakGuard, label }) {
    if (!response?.body) throw new Error(`${label}: missing response body`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const allChunks = [];
    let sawStreamChunk = false;
    let idleTimedOut = false;
    let idleTimer = null;
    let idleReject = null;
    let relayedText = '';
    let sawFunctionCall = false;

    let firstByteTimer = setTimeout(() => {
        try { reader.cancel('first byte timeout'); } catch {}
        if (idleReject) {
            const e = geminiTimeoutError(`${label} first byte`, GEMINI_FIRST_BYTE_TIMEOUT_MS);
            const r = idleReject; idleReject = null; r(e);
        }
    }, GEMINI_FIRST_BYTE_TIMEOUT_MS);
    if (firstByteTimer.unref) firstByteTimer.unref();

    const clearFirstByteTimer = () => {
        if (firstByteTimer) {
            clearTimeout(firstByteTimer);
            firstByteTimer = null;
        }
    };

    const resetIdleTimer = () => {
        if (!PROVIDER_SSE_IDLE_WATCHDOG_ENABLED) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimedOut = true;
            try { reader.cancel('SSE idle timeout'); } catch {}
            if (idleReject) {
                const e = geminiTimeoutError(`${label} SSE idle`, PROVIDER_SSE_IDLE_TIMEOUT_MS);
                const r = idleReject; idleReject = null; r(e);
            }
        }, PROVIDER_SSE_IDLE_TIMEOUT_MS);
        if (idleTimer.unref) idleTimer.unref();
    };

    const onAbort = () => {
        try {
            const c = reader.cancel('aborted');
            if (c && typeof c.catch === 'function') c.catch(() => {});
        } catch {}
    };

    if (signal) {
        if (signal.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error(`${label} aborted`);
        }
        signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        resetIdleTimer();
        while (true) {
            let chunk;
            try {
                chunk = await new Promise((resolve, reject) => {
                    idleReject = reject;
                    reader.read().then(resolve, reject);
                });
            } catch (err) {
                if (idleTimedOut) {
                    throw geminiTimeoutError(`${label} SSE idle`, PROVIDER_SSE_IDLE_TIMEOUT_MS);
                }
                if (signal?.aborted) {
                    const reason = signal.reason;
                    throw reason instanceof Error ? reason : new Error(`${label} aborted`);
                }
                throw err;
            } finally {
                idleReject = null;
            }
            const { done, value } = chunk;
            if (done) break;
            resetIdleTimer();
            buffer += decoder.decode(value, { stream: true });
            let lineEnd;
            while ((lineEnd = buffer.indexOf('\n')) >= 0) {
                let line = buffer.slice(0, lineEnd);
                buffer = buffer.slice(lineEnd + 1);
                line = line.replace(/\r$/, '');
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data || data === '[DONE]') continue;
                let parsed;
                try { parsed = JSON.parse(data); } catch { continue; }
                if (!sawStreamChunk) {
                    sawStreamChunk = true;
                    clearFirstByteTimer();
                }
                allChunks.push(parsed);
                try { onStreamDelta?.(); } catch {}
                if (!sawFunctionCall && geminiChunkHasFunctionCall(parsed)) sawFunctionCall = true;
                if (onTextDelta || textLeakGuard) {
                    const t = geminiChunkText(parsed);
                    if (t) relayedText += t;
                    relayGeminiStreamText(t, { onTextDelta, textLeakGuard });
                }
            }
        }
        if (buffer.trim()) {
            const line = buffer.trim().replace(/\r$/, '');
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data && data !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(data);
                        if (!sawStreamChunk) {
                            sawStreamChunk = true;
                            clearFirstByteTimer();
                        }
                        allChunks.push(parsed);
                        try { onStreamDelta?.(); } catch {}
                        if (!sawFunctionCall && geminiChunkHasFunctionCall(parsed)) sawFunctionCall = true;
                        if (onTextDelta || textLeakGuard) {
                            const t = geminiChunkText(parsed);
                            if (t) relayedText += t;
                            relayGeminiStreamText(t, { onTextDelta, textLeakGuard });
                        }
                    } catch { /* skip malformed tail */ }
                }
            }
        }
    } catch (err) {
        throw stampGeminiStreamFailure(err, { relayedText, textLeakGuard, sawFunctionCall });
    } finally {
        clearFirstByteTimer();
        if (idleTimer) clearTimeout(idleTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch {}
        try { textLeakGuard?.finalize(); } catch {}
    }

    const aggregated = aggregateGeminiStreamChunks(allChunks);
    const finishReason = aggregated.candidates?.[0]?.finishReason || null;
    // Truncation (no finishReason) after visible output must carry the same
    // safety stamps as an in-loop failure — assert throws OUTSIDE the catch
    // above, so stamp here too (review High: transient TRUNCATED_STREAM would
    // otherwise replay/double-render live text via withRetry).
    try {
        assertGeminiStreamCompleted({ sawStreamChunk, finishReason, label });
    } catch (err) {
        throw stampGeminiStreamFailure(err, { relayedText, textLeakGuard, sawFunctionCall });
    }
    return aggregated;
}

export async function consumeGeminiSdkStream(streamResult, { signal, onStreamDelta, onTextDelta, textLeakGuard, label }) {
    let sawStreamChunk = false;
    let idleTimedOut = false;
    let idleTimer = null;
    let firstByteReject = null;
    let firstByteTimer = null;
    let inFlightReject = null;
    let relayedText = '';
    let sawFunctionCall = false;

    const armFirstByteTimer = () => {
        if (firstByteTimer) clearTimeout(firstByteTimer);
        firstByteTimer = setTimeout(() => {
            if (firstByteReject) {
                const e = geminiTimeoutError(`${label} first byte`, GEMINI_FIRST_BYTE_TIMEOUT_MS);
                const r = firstByteReject; firstByteReject = null; r(e);
            }
        }, GEMINI_FIRST_BYTE_TIMEOUT_MS);
        if (firstByteTimer.unref) firstByteTimer.unref();
    };

    const clearFirstByteTimer = () => {
        if (firstByteTimer) {
            clearTimeout(firstByteTimer);
            firstByteTimer = null;
        }
        firstByteReject = null;
    };

    const resetIdleTimer = () => {
        if (!PROVIDER_SSE_IDLE_WATCHDOG_ENABLED) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimedOut = true;
            if (inFlightReject) {
                const e = geminiTimeoutError(`${label} SSE idle`, PROVIDER_SSE_IDLE_TIMEOUT_MS);
                const r = inFlightReject; inFlightReject = null; r(e);
            }
        }, PROVIDER_SSE_IDLE_TIMEOUT_MS);
        if (idleTimer.unref) idleTimer.unref();
    };

    if (signal?.aborted) {
        const reason = signal.reason;
        throw reason instanceof Error ? reason : new Error(`${label} aborted`);
    }

    const iterator = streamResult.stream[Symbol.asyncIterator]();

    // Wire the abort signal to actually CANCEL iteration (mirror of the REST
    // consumer's onAbort -> reader.cancel). Without this, a parent / client /
    // gateway abort that fires AFTER the first byte — with the SSE idle
    // watchdog off by default — would leave iterator.next() hanging: the loop
    // below only reads `signal` for error translation, never to interrupt the
    // pending read. Rejecting the in-flight promise and returning the iterator
    // releases it promptly even if the SDK is slow to propagate the underlying
    // request abort.
    let onSignalAbort = null;
    if (signal) {
        onSignalAbort = () => {
            const reason = signal.reason;
            const err = reason instanceof Error ? reason : new Error(`${label} aborted`);
            if (inFlightReject) {
                const r = inFlightReject;
                inFlightReject = null;
                firstByteReject = null;
                r(err);
            }
            try {
                const ret = iterator.return?.();
                if (ret && typeof ret.catch === 'function') ret.catch(() => {});
            } catch {}
        };
        signal.addEventListener('abort', onSignalAbort, { once: true });
    }

    try {
        armFirstByteTimer();
        resetIdleTimer();
        var collectedChunks = [];
        while (true) {
            if (idleTimedOut) {
                throw geminiTimeoutError(`${label} SSE idle`, PROVIDER_SSE_IDLE_TIMEOUT_MS);
            }
            let step;
            try {
                step = await new Promise((resolve, reject) => {
                    inFlightReject = reject;
                    if (!sawStreamChunk) firstByteReject = reject;
                    iterator.next().then(
                        (value) => {
                            inFlightReject = null;
                            firstByteReject = null;
                            resolve(value);
                        },
                        (err) => {
                            inFlightReject = null;
                            firstByteReject = null;
                            reject(err);
                        },
                    );
                });
            } catch (err) {
                if (idleTimedOut) {
                    throw geminiTimeoutError(`${label} SSE idle`, PROVIDER_SSE_IDLE_TIMEOUT_MS);
                }
                if (signal?.aborted) {
                    const reason = signal.reason;
                    throw reason instanceof Error ? reason : new Error(`${label} aborted`);
                }
                throw err;
            }
            if (step.done) break;
            if (!sawStreamChunk) {
                sawStreamChunk = true;
                clearFirstByteTimer();
            }
            resetIdleTimer();
            if (step.value) collectedChunks.push(step.value);
            try { onStreamDelta?.(); } catch {}
            if (!sawFunctionCall && geminiChunkHasFunctionCall(step.value)) sawFunctionCall = true;
            if (onTextDelta || textLeakGuard) {
                const t = geminiChunkText(step.value);
                if (t) relayedText += t;
                relayGeminiStreamText(t, { onTextDelta, textLeakGuard });
            }
        }
        if (idleTimedOut) {
            throw geminiTimeoutError(`${label} SSE idle`, PROVIDER_SSE_IDLE_TIMEOUT_MS);
        }
    } catch (err) {
        clearFirstByteTimer();
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error(`${label} aborted`);
        }
        throw stampGeminiStreamFailure(err, { relayedText, textLeakGuard, sawFunctionCall });
    } finally {
        clearFirstByteTimer();
        if (idleTimer) clearTimeout(idleTimer);
        if (signal && onSignalAbort) {
            try { signal.removeEventListener('abort', onSignalAbort); } catch {}
        }
        try { textLeakGuard?.finalize(); } catch {}
    }

    // Aggregate the raw wire chunks locally instead of awaiting the SDK's
    // streamResult.response: @google/generative-ai 0.24.1 aggregateResponses()
    // predates Gemini 3 thinking and silently drops part.thoughtSignature.
    // Losing the signature breaks the mandatory echo-back on the next turn
    // (400 "Function call is missing a thought_signature in functionCall
    // parts"). aggregateGeminiStreamChunks() preserves it (see part copy
    // above). Fall back to the SDK aggregate only if we somehow collected no
    // usable chunks.
    let raw;
    if (collectedChunks.length > 0) {
        raw = aggregateGeminiStreamChunks(collectedChunks);
    } else {
        let response;
        try {
            response = await streamResult.response;
        } catch (err) {
            if (signal?.aborted) {
                const reason = signal.reason;
                throw reason instanceof Error ? reason : new Error(`${label} aborted`);
            }
            throw err;
        }
        raw = response?.candidates ? response : (response?.response || response);
    }
    const finishReason = raw?.candidates?.[0]?.finishReason || null;
    // Same stamping as the REST consumer: truncation after visible output
    // must not classify transient (review High).
    try {
        assertGeminiStreamCompleted({ sawStreamChunk, finishReason, label });
    } catch (err) {
        throw stampGeminiStreamFailure(err, { relayedText, textLeakGuard, sawFunctionCall });
    }
    return raw;
}
