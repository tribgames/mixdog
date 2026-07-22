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
import {
    parseToolCalls,
    emitGeminiToolCalls,
    collectGeminiGroundingSources,
    parseGeminiTextPartMetadata,
} from './gemini.mjs';

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

function geminiTruncatedStreamError(message) {
    return Object.assign(
        new Error(message),
        { name: 'TruncatedStreamError', code: 'TRUNCATED_STREAM', truncatedStream: true },
    );
}

function geminiStreamCorruptionError(message, cause = null) {
    return Object.assign(
        new Error(message, cause ? { cause } : undefined),
        {
            name: 'GeminiStreamCorruptionError',
            code: 'TRUNCATED_STREAM',
            truncatedStream: true,
            streamCorruption: true,
        },
    );
}

function isGeminiSdkStreamParseError(err) {
    let cursor = err;
    const seen = new Set();
    for (let depth = 0; cursor && depth < 5 && !seen.has(cursor); depth++) {
        seen.add(cursor);
        if (cursor instanceof SyntaxError) return true;
        const name = String(cursor?.name || '');
        const message = String(cursor?.message || '');
        if (name === 'GoogleGenerativeAIError'
            && /(?:parse|parsing|json|unexpected token|unexpected end|unterminated)/i.test(message)) {
            return true;
        }
        cursor = cursor?.cause;
    }
    return false;
}

function normalizeGeminiSdkStreamError(err, label) {
    return isGeminiSdkStreamParseError(err)
        ? geminiStreamCorruptionError(`${label} corrupt SDK SSE JSON`, err)
        : err;
}

// CC-rule safety stamp for Gemini stream failures (provider-stall audit):
// once text has been relayed to the live gateway or a leaked tool call was
// dispatched, replaying the request would double-render/double-execute — the
// outer withRetry() in gemini.mjs wraps the WHOLE stream, and a bare
// EGEMINITIMEOUT classifies transient, so without these markers a mid-stream
// stall after visible output was silently retried. Visible-text stalls also
// gain streamStalled + partialContent so the loop's partial-final path can
// keep the streamed output instead of dropping the turn.
function stampGeminiStreamFailure(err, {
    relayedText = '',
    textLeakGuard = null,
    sawFunctionCall = false,
    chunks = [],
} = {}) {
    if (!err || typeof err !== 'object') return err;
    const leaked = (textLeakGuard?.getLeakedToolCalls?.() || []).length > 0;
    const finalizedText = textLeakGuard?.getVisibleText?.();
    const visibleText = typeof finalizedText === 'string' ? finalizedText : relayedText;
    const visible = visibleText.length > 0;
    // Native functionCall chunks are only dispatched after successful stream
    // completion in gemini.mjs. Until then a reconnect is safe. Text-leaked
    // calls are dispatched while parsing and remain a hard replay boundary.
    const pendingTool = leaked;
    try {
        if (visible) { err.liveTextEmitted = true; err.unsafeToRetry = true; }
        if (pendingTool) { err.emittedToolCall = true; err.unsafeToRetry = true; }
        const partialParts = aggregateGeminiStreamChunks(chunks)?.candidates?.[0]?.content?.parts || [];
        const providerMetadata = parseGeminiTextPartMetadata(partialParts);
        if (providerMetadata) err.providerMetadata = providerMetadata;
        // TRUNCATED_STREAM EOF after visible output must also carry the
        // partial-final stamps (streamStalled/partialContent), aligning with the
        // compat streams — otherwise live output is dropped instead of kept.
        if (visible && !leaked
            && (err.code === 'EGEMINITIMEOUT' || err.code === 'TRUNCATED_STREAM' || err.truncatedStream === true)) {
            err.streamStalled = true;
            if (typeof err.partialContent !== 'string') err.partialContent = visibleText;
            if (err.pendingToolUse === undefined) err.pendingToolUse = pendingTool;
        }
    } catch { /* best-effort */ }
    return err;
}

// True when a streamed Gemini chunk carries a native functionCall part (as
// opposed to a tool call leaked as plain text, tracked by textLeakGuard).
function geminiChunkHasFunctionCall(chunk) {
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
                        if (part.thought === true) newPart.thought = true;
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

function assertGeminiStreamCompleted({ sawStreamChunk, finishReason, promptBlockReason, label }) {
    if (!sawStreamChunk) {
        throw geminiTruncatedStreamError(`${label} truncated: empty stream`);
    }
    if (!finishReason && !promptBlockReason) {
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
        // Thought summaries are reasoning, not user-visible answer deltas.
        if (p && p.thought !== true && typeof p.text === 'string') text += p.text;
    }
    return text;
}

function relayGeminiStreamText(t, { onTextDelta, textLeakGuard }) {
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
    let visibleText = '';
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
            visibleText += emit;
            try { onTextDelta(emit); } catch {}
        } else if (emit) {
            visibleText += emit;
        }
        for (const c of calls) dispatchLeakedCall(c);
    };

    return {
        get enabled() { return _enabled; },
        feedText(text) {
            if (!text) return;
            if (!_enabled) {
                visibleText += text;
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
        getVisibleText() {
            return visibleText;
        },
    };
}

export async function consumeGeminiRestStreamResponse(response, { signal, onStreamDelta, onTextDelta, textLeakGuard, label }) {
    if (!response?.body) throw new Error(`${label}: missing response body`);
    if (signal?.aborted) {
        const reason = signal.reason;
        throw reason instanceof Error ? reason : new Error(`${label} aborted`);
    }
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
    let leakGuardFinalized = false;
    const finalizeLeakGuard = () => {
        if (leakGuardFinalized) return;
        leakGuardFinalized = true;
        try { textLeakGuard?.finalize(); } catch {}
    };

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
                try {
                    parsed = JSON.parse(data);
                } catch (cause) {
                    throw geminiStreamCorruptionError(`${label} corrupt SSE JSON`, cause);
                }
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
                    } catch (cause) {
                        throw geminiStreamCorruptionError(`${label} corrupt SSE tail JSON`, cause);
                    }
                }
            }
        }
    } catch (err) {
        finalizeLeakGuard();
        throw stampGeminiStreamFailure(err, { relayedText, textLeakGuard, sawFunctionCall, chunks: allChunks });
    } finally {
        clearFirstByteTimer();
        if (idleTimer) clearTimeout(idleTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch {}
        finalizeLeakGuard();
    }

    const aggregated = aggregateGeminiStreamChunks(allChunks);
    const finishReason = aggregated.candidates?.[0]?.finishReason || null;
    const promptBlockReason = aggregated.promptFeedback?.blockReason || null;
    // Truncation (no finishReason) after visible output must carry the same
    // safety stamps as an in-loop failure — assert throws OUTSIDE the catch
    // above, so stamp here too (review High: transient TRUNCATED_STREAM would
    // otherwise replay/double-render live text via withRetry).
    try {
        assertGeminiStreamCompleted({ sawStreamChunk, finishReason, promptBlockReason, label });
    } catch (err) {
        throw stampGeminiStreamFailure(err, { relayedText, textLeakGuard, sawFunctionCall, chunks: allChunks });
    }
    return aggregated;
}

export async function consumeGeminiSdkStream(streamResult, {
    signal,
    onStreamDelta,
    onTextDelta,
    textLeakGuard,
    label,
    cancelGeneration,
    firstByteTimeoutMs = GEMINI_FIRST_BYTE_TIMEOUT_MS,
    cancellationGraceMs = 250,
}) {
    let sawStreamChunk = false;
    let idleTimedOut = false;
    let idleTimer = null;
    let firstByteReject = null;
    let firstByteTimer = null;
    let inFlightReject = null;
    let relayedText = '';
    let sawFunctionCall = false;
    let leakGuardFinalized = false;
    const finalizeLeakGuard = () => {
        if (leakGuardFinalized) return;
        leakGuardFinalized = true;
        try { textLeakGuard?.finalize(); } catch {}
    };

    let iterator = null;
    let cancellation = null;
    let forcedFailure = null;
    const cancelInFlight = (err) => {
        if (cancellation) return cancellation;
        forcedFailure = err;
        cancellation = (async () => {
            try { cancelGeneration?.(err); } catch {}
            let returnPromise;
            try {
                returnPromise = Promise.resolve(iterator?.return?.());
            } catch {
                return;
            }
            // iterator.return() is best-effort cleanup. A broken SDK iterator
            // must not deadlock the timeout path and prevent withRetry from
            // beginning the next attempt after the generation was aborted.
            let graceTimer = null;
            try {
                await Promise.race([
                    returnPromise.catch(() => {}),
                    new Promise((resolve) => {
                        graceTimer = setTimeout(resolve, Math.max(0, cancellationGraceMs));
                    }),
                ]);
            } finally {
                if (graceTimer) clearTimeout(graceTimer);
                // Keep observing a late rejection after the grace race expires.
                returnPromise.catch(() => {});
            }
        })();
        return cancellation;
    };

    const rejectAfterCancellation = (reject, err) => {
        cancelInFlight(err).then(() => reject(err), () => reject(err));
    };

    const armFirstByteTimer = () => {
        if (firstByteTimer) clearTimeout(firstByteTimer);
        firstByteTimer = setTimeout(() => {
            if (firstByteReject) {
                const e = geminiTimeoutError(`${label} first byte`, firstByteTimeoutMs);
                const r = firstByteReject; firstByteReject = null;
                rejectAfterCancellation(r, e);
            }
        }, firstByteTimeoutMs);
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
                const r = inFlightReject; inFlightReject = null;
                rejectAfterCancellation(r, e);
            }
        }, PROVIDER_SSE_IDLE_TIMEOUT_MS);
    };

    if (signal?.aborted) {
        const reason = signal.reason;
        throw reason instanceof Error ? reason : new Error(`${label} aborted`);
    }

    iterator = streamResult.stream[Symbol.asyncIterator]();
    // The SDK tees the parsed stream into `response`. Even though local
    // aggregation normally avoids awaiting it, its rejection must remain
    // observed across parser/abort retries.
    let responsePromise;
    try {
        responsePromise = Promise.resolve(streamResult.response);
    } catch (err) {
        responsePromise = Promise.reject(err);
    }
    responsePromise.catch(() => {});

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
            cancelInFlight(err).catch(() => {});
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
                            if (forcedFailure) {
                                cancellation.then(
                                    () => reject(forcedFailure),
                                    () => reject(forcedFailure),
                                );
                            } else {
                                resolve(value);
                            }
                        },
                        (err) => {
                            inFlightReject = null;
                            firstByteReject = null;
                            if (forcedFailure) {
                                cancellation.then(
                                    () => reject(forcedFailure),
                                    () => reject(forcedFailure),
                                );
                            } else {
                                reject(err);
                            }
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
                throw normalizeGeminiSdkStreamError(err, label);
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
        let failure = err;
        if (signal?.aborted) {
            const reason = signal.reason;
            failure = reason instanceof Error ? reason : new Error(`${label} aborted`);
        }
        finalizeLeakGuard();
        throw stampGeminiStreamFailure(failure, { relayedText, textLeakGuard, sawFunctionCall, chunks: collectedChunks });
    } finally {
        clearFirstByteTimer();
        if (idleTimer) clearTimeout(idleTimer);
        if (signal && onSignalAbort) {
            try { signal.removeEventListener('abort', onSignalAbort); } catch {}
        }
        finalizeLeakGuard();
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
            response = await responsePromise;
        } catch (err) {
            let failure = normalizeGeminiSdkStreamError(err, label);
            if (signal?.aborted) {
                const reason = signal.reason;
                failure = reason instanceof Error ? reason : new Error(`${label} aborted`);
            }
            finalizeLeakGuard();
            throw stampGeminiStreamFailure(failure, {
                relayedText,
                textLeakGuard,
                sawFunctionCall,
                chunks: collectedChunks,
            });
        }
        raw = response?.candidates ? response : (response?.response || response);
    }
    const finishReason = raw?.candidates?.[0]?.finishReason || null;
    const promptBlockReason = raw?.promptFeedback?.blockReason || null;
    // Same stamping as the REST consumer: truncation after visible output
    // must not classify transient (review High).
    try {
        assertGeminiStreamCompleted({ sawStreamChunk, finishReason, promptBlockReason, label });
    } catch (err) {
        throw stampGeminiStreamFailure(err, { relayedText, textLeakGuard, sawFunctionCall, chunks: collectedChunks });
    }
    return raw;
}
