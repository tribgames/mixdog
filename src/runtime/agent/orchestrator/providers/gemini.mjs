import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { loadConfig } from '../config.mjs';
import { makeModelCache } from './model-cache.mjs';
import { withRetry } from './retry-classifier.mjs';
import { traceAgentUsage, appendAgentTrace } from '../agent-trace.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_MAX_BEFORE_WARN_MS,
    PROVIDER_SSE_IDLE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    providerTimeoutError,
    resolveTimeoutMs,
    createTimeoutSignal,
    createPassthroughSignal,
} from '../stall-policy.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { traceHash, stableTraceStringify, summarizeTraceTools, traceTextShape } from './trace-utils.mjs';
import { normalizeContentForGeminiParts, splitToolContentForGemini } from './media-normalization.mjs';

const MODELS = [
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', provider: 'gemini', contextWindow: 1048576 },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', provider: 'gemini', contextWindow: 1048576 },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', provider: 'gemini', contextWindow: 1048576 },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', contextWindow: 1048576 },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', contextWindow: 1048576 },
];

const DEFAULT_MODEL = MODELS[0].id;

// --- Model catalog cache (24h disk TTL) ---
// Gemini's /models has no `created` timestamp, so latest-resolution is
// VERSION-based (parse gemini-X.Y) rather than release-date based.
const MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;

// De-dupes concurrent force-refreshes so they share one HTTP round-trip,
// mirroring anthropic-oauth's _modelRefreshInFlight.
let _modelRefreshInFlight = null;

const _modelCache = makeModelCache({ fileName: 'gemini-models.json', ttlMs: MODEL_CACHE_TTL_MS });

// Mirror of anthropic-oauth.mjs _compareVersion: compare two gemini ids by the
// X.Y version embedded in the id (gemini-3.5-flash -> [3, 5]). Falls back to a
// lexicographic tiebreak so ordering is total.
function _compareVersion(a, b) {
    const na = (a.match(/gemini-(\d+)(?:\.(\d+))?/) || []).slice(1).map(Number);
    const nb = (b.match(/gemini-(\d+)(?:\.(\d+))?/) || []).slice(1).map(Number);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
    }
    return a.localeCompare(b);
}

// Per family, mark the highest-version model as latest:true.
function _markLatestGemini(models) {
    const byFamily = new Map();
    for (const m of models) {
        if (!m?.id) continue;
        const cur = byFamily.get(m.family);
        if (!cur || _compareVersion(m.id, cur.id) > 0) {
            byFamily.set(m.family, m);
        }
    }
    for (const m of byFamily.values()) m.latest = true;
}

// Newest chat model by VERSION in the 'gemini-flash' family, read from the
// on-disk catalog cache. Returns null until cached; callers warm via
// ensureLatestGeminiModel when null.
export function resolveLatestGeminiModel() {
    const cached = _modelCache.loadSync();
    if (!Array.isArray(cached)) return null;
    let best = null;
    for (const m of cached) {
        if (!m?.id || m.family !== 'gemini-flash') continue;
        if (!best || _compareVersion(m.id, best.id) > 0) best = m;
    }
    return best?.id || null;
}

export async function ensureLatestGeminiModel(provider) {
    let m = resolveLatestGeminiModel();
    if (m) return m;
    await provider._refreshModelCache();
    m = resolveLatestGeminiModel();
    if (m) return m;
    throw new Error('[gemini] model catalog unavailable after warmup — cannot resolve default model');
}

const GEMINI_FIRST_BYTE_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS',
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    { minMs: 30_000, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

function summarizeTracePart(part) {
    if (!part || typeof part !== 'object') return { type: typeof part };
    if ('text' in part) {
        return { type: 'text', ...traceTextShape(part.text) };
    }
    if (part.functionCall) {
        return {
            type: 'functionCall',
            name: part.functionCall.name || null,
            argsHash: traceHash(stableTraceStringify(part.functionCall.args || {})),
        };
    }
    if (part.functionResponse) {
        const response = part.functionResponse.response || {};
        const responseShape = stableTraceStringify(response);
        return {
            type: 'functionResponse',
            name: part.functionResponse.name || null,
            responseChars: responseShape.length,
            responseHash: traceHash(responseShape),
        };
    }
    return { type: Object.keys(part).sort().join('|') || 'unknown' };
}

function summarizeTraceContents(contents) {
    const summaries = (contents || []).map((content, index) => ({
        index,
        role: content?.role || null,
        parts: Array.isArray(content?.parts) ? content.parts.map(summarizeTracePart) : [],
    }));
    if (summaries.length <= 12) return summaries;
    return [
        ...summaries.slice(0, 8),
        { omittedTurns: summaries.length - 12 },
        ...summaries.slice(-4),
    ];
}

// Gemini cachedContents API rejects prefixes below the model-specific minimum
// (Gemini 2.0/2.5 = 2048 tokens, Gemini 3.x = 4096 tokens) with HTTP 400
// "Cached content is too small". Estimating chars/4 ≈ tokens lets us skip the
// roundtrip when the prefix cannot satisfy the invariant. Estimate undercount
// is harmless (we attempt and get the same 400 we would have skipped); overcount
// is harmless (we skip, fall back to implicit cache).
function _estimateGeminiCacheTokens(systemInstruction, geminiTools, contents) {
    let chars = 0;
    if (typeof systemInstruction === 'string') chars += systemInstruction.length;
    if (Array.isArray(geminiTools) && geminiTools.length) {
        try { chars += JSON.stringify(geminiTools).length; } catch {}
    }
    if (Array.isArray(contents) && contents.length > 1) {
        for (let i = 0; i < contents.length - 1; i++) {
            try { chars += JSON.stringify(contents[i]?.parts ?? '').length; } catch {}
        }
    }
    return Math.ceil(chars / 4);
}

function _geminiCacheMinTokens(model) {
    return /^gemini-3/i.test(String(model || '')) ? 4096 : 2048;
}

function _geminiCachePrefixCount(contents) {
    return Array.isArray(contents) && contents.length > 1 ? contents.length - 1 : 0;
}

function _geminiCachePrefixContents(contents, prefixCount) {
    if (!Array.isArray(contents) || prefixCount <= 0) return [];
    return contents.slice(0, prefixCount).map(c => {
        const r = c?.role;
        const safeRole = (r === 'model' || r === 'user') ? r : 'user';
        return {
            role: safeRole,
            parts: Array.isArray(c?.parts) ? c.parts : [],
        };
    });
}

function _geminiCachePrefixHash({ model, systemInstruction, geminiTools, contents, prefixCount }) {
    return traceHash(stableTraceStringify({
        model: model || null,
        systemInstruction: systemInstruction || '',
        tools: geminiTools || [],
        contents: _geminiCachePrefixContents(contents, prefixCount),
    }));
}

const GEMINI_GLOBAL_CACHE_MIN_LIVE_MS = 6 * 60 * 1000;
const GEMINI_GLOBAL_CACHE_MAX_ENTRIES = 128;
const geminiGlobalCaches = new Map();
const geminiGlobalCacheCreates = new Map();

function _geminiGlobalCacheKey({ apiKey, model, cachePrefixHash, cachePrefixContentCount }) {
    return traceHash(stableTraceStringify({
        apiKeyHash: traceHash(apiKey || ''),
        model: model || null,
        cachePrefixHash,
        cachePrefixContentCount,
    }));
}

function _pruneGeminiGlobalCaches(now = Date.now()) {
    for (const [key, entry] of geminiGlobalCaches) {
        if (!entry?.cacheName || Number(entry.cacheExpiresAt || 0) <= now) {
            geminiGlobalCaches.delete(key);
        }
    }
    while (geminiGlobalCaches.size > GEMINI_GLOBAL_CACHE_MAX_ENTRIES) {
        const oldest = geminiGlobalCaches.keys().next().value;
        if (oldest === undefined) break;
        geminiGlobalCaches.delete(oldest);
    }
}

function _getGeminiGlobalCache(key, now = Date.now()) {
    _pruneGeminiGlobalCaches(now);
    const entry = geminiGlobalCaches.get(key);
    if (!entry?.cacheName) return null;
    if ((entry.cacheExpiresAt || 0) - now <= GEMINI_GLOBAL_CACHE_MIN_LIVE_MS) {
        geminiGlobalCaches.delete(key);
        return null;
    }
    entry.lastUsedAt = now;
    return entry;
}

function _setGeminiGlobalCache(key, entry) {
    if (!key || !entry?.cacheName) return;
    geminiGlobalCaches.set(key, {
        ...entry,
        lastUsedAt: Date.now(),
    });
    _pruneGeminiGlobalCaches();
}

function _geminiGlobalCacheNameIsLive(cacheName, now = Date.now()) {
    if (!cacheName) return false;
    for (const entry of geminiGlobalCaches.values()) {
        if (entry?.cacheName === cacheName && Number(entry.cacheExpiresAt || 0) > now) return true;
    }
    return false;
}

function _attachGeminiCacheState(opts, entry, currentIter) {
    if (!entry?.cacheName) return;
    opts.providerState = {
        ...(opts.providerState || {}),
        gemini: {
            cacheName: entry.cacheName,
            cacheCreatedAt: entry.cacheCreatedAt,
            cacheCreatedAtIter: currentIter,
            cacheExpiresAt: entry.cacheExpiresAt,
            cacheModel: entry.cacheModel,
            cacheTokenSize: entry.cacheTokenSize,
            cachePrefixContentCount: entry.cachePrefixContentCount,
            cachePrefixHash: entry.cachePrefixHash,
        },
    };
}

function _resolveGeminiCacheUsage({ usageMetadata, cachedContent, providerState }) {
    const inputTokens = Number(usageMetadata?.promptTokenCount || usageMetadata?.totalTokenCount || 0) || 0;
    const reportedCachedTokens = Number(usageMetadata?.cachedContentTokenCount || 0) || 0;
    const cachedFallbackTokens = cachedContent
        ? Number(providerState?.gemini?.cacheTokenSize || 0) || 0
        : 0;
    const rawCachedTokens = reportedCachedTokens > 0 ? reportedCachedTokens : cachedFallbackTokens;
    const cachedTokens = inputTokens > 0 ? Math.min(rawCachedTokens, inputTokens) : rawCachedTokens;
    const cacheTokenSource = reportedCachedTokens > 0
        ? 'usage_metadata'
        : (cachedFallbackTokens > 0 ? 'cache_create_fallback' : 'none');
    return {
        inputTokens,
        reportedCachedTokens,
        cachedFallbackTokens,
        cachedTokens,
        cacheTokenSource,
    };
}

function writeGeminiCacheTrace({ opts, model, systemInstruction, tools, contents, usageMetadata, cachedContent }) {
    if (process.env.MIXDOG_GEMINI_CACHE_TRACE !== '1') return;
    try {
        const session = opts?.session || {};
        const {
            inputTokens,
            reportedCachedTokens,
            cachedFallbackTokens,
            cachedTokens,
            cacheTokenSource,
        } = _resolveGeminiCacheUsage({
            usageMetadata,
            cachedContent,
            providerState: opts?.providerState,
        });
        const toolShape = summarizeTraceTools(tools);
        const trace = {
            event: 'generate',
            provider: 'gemini',
            model,
            owner: session.owner || null,
            role: session.role || null,
            permission: session.permission || null,
            toolPermission: session.toolPermission || null,
            profileId: session.profileId || null,
            sourceType: session.sourceType || null,
            sourceName: session.sourceName || null,
            sessionIdHash: opts?.sessionId ? traceHash(opts.sessionId) : null,
            providerCacheKeyHash: opts?.providerCacheKey ? traceHash(opts.providerCacheKey) : null,
            promptCacheKeyHash: opts?.promptCacheKey ? traceHash(opts.promptCacheKey) : null,
            systemChars: systemInstruction ? systemInstruction.length : 0,
            systemHash: systemInstruction ? traceHash(systemInstruction) : null,
            toolCount: Array.isArray(tools) ? tools.length : 0,
            toolSchemaHash: traceHash(stableTraceStringify(toolShape)),
            contentTurnCount: Array.isArray(contents) ? contents.length : 0,
            contents: summarizeTraceContents(contents),
            inputTokens,
            cachedTokens,
            reportedCachedTokens,
            cachedFallbackTokens,
            cacheTokenSource,
            cacheAttached: !!cachedContent,
            cachePrefixContentCount: opts?.providerState?.gemini?.cachePrefixContentCount ?? null,
            cacheHitRate: inputTokens > 0 ? Number((cachedTokens / inputTokens).toFixed(6)) : null,
        };
        process.stderr.write(`[gemini-cache-trace] ${JSON.stringify(trace)}\n`);
    } catch (err) {
        process.stderr.write(`[gemini-cache-trace] failed: ${err?.message || err}\n`);
    }
}

function geminiTimeoutError(label, timeoutMs) {
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

/**
 * Aggregate streamed GenerateContentResponse chunks into one response object
 * (same shape as a non-streaming generateContent JSON body).
 * Mirrors @google/generative-ai aggregateResponses().
 */
function aggregateGeminiStreamChunks(responses) {
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

function assertGeminiStreamCompleted({ sawStreamChunk, finishReason, label }) {
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
function geminiChunkText(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    let text = '';
    for (const p of parts) {
        if (p && typeof p.text === 'string') text += p.text;
    }
    return text;
}

async function consumeGeminiRestStreamResponse(response, { signal, onStreamDelta, onTextDelta, label }) {
    if (!response?.body) throw new Error(`${label}: missing response body`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const allChunks = [];
    let sawStreamChunk = false;
    let idleTimedOut = false;
    let idleTimer = null;
    let idleReject = null;

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
                if (onTextDelta) {
                    const t = geminiChunkText(parsed);
                    if (t) { try { onTextDelta(t); } catch {} }
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
                        if (onTextDelta) {
                            const t = geminiChunkText(parsed);
                            if (t) { try { onTextDelta(t); } catch {} }
                        }
                    } catch { /* skip malformed tail */ }
                }
            }
        }
    } finally {
        clearFirstByteTimer();
        if (idleTimer) clearTimeout(idleTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch {}
    }

    const aggregated = aggregateGeminiStreamChunks(allChunks);
    const finishReason = aggregated.candidates?.[0]?.finishReason || null;
    assertGeminiStreamCompleted({ sawStreamChunk, finishReason, label });
    return aggregated;
}

async function consumeGeminiSdkStream(streamResult, { signal, onStreamDelta, onTextDelta, label }) {
    let sawStreamChunk = false;
    let idleTimedOut = false;
    let idleTimer = null;
    let firstByteReject = null;
    let firstByteTimer = null;
    let inFlightReject = null;

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
            try { onStreamDelta?.(); } catch {}
            if (onTextDelta) {
                const t = geminiChunkText(step.value);
                if (t) { try { onTextDelta(t); } catch {} }
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
        throw err;
    } finally {
        clearFirstByteTimer();
        if (idleTimer) clearTimeout(idleTimer);
        if (signal && onSignalAbort) {
            try { signal.removeEventListener('abort', onSignalAbort); } catch {}
        }
    }

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
    const raw = response?.candidates ? response : (response?.response || response);
    const finishReason = raw?.candidates?.[0]?.finishReason || null;
    assertGeminiStreamCompleted({ sawStreamChunk, finishReason, label });
    return raw;
}

/**
 * Convert JSON Schema type string to Gemini SchemaType.
 * Gemini SDK uses its own enum instead of plain strings.
 */
function toSchemaType(t) {
    const map = {
        string: SchemaType.STRING,
        number: SchemaType.NUMBER,
        integer: SchemaType.INTEGER,
        boolean: SchemaType.BOOLEAN,
        array: SchemaType.ARRAY,
        object: SchemaType.OBJECT,
    };
    return map[t] ?? SchemaType.STRING;
}

/**
 * Recursively convert a JSON Schema object to Gemini's FunctionDeclarationSchema.
 * Gemini requires `type` to be a SchemaType enum, not a plain string, and
 * rejects several JSON Schema fields the API does not understand
 * (additionalProperties, $schema, $ref, const, examples, definitions,
 * patternProperties). We strip those at every level.
 */
const GEMINI_SCHEMA_STRIP = new Set([
    'additionalProperties',
    '$schema',
    '$ref',
    'const',
    'examples',
    'definitions',
    'patternProperties',
]);
function convertSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const result = {};
    for (const [k, v] of Object.entries(schema)) {
        if (GEMINI_SCHEMA_STRIP.has(k)) continue;
        result[k] = v;
    }
    // Gemini's Schema validator requires every `enum` entry to be a string,
    // even when the parent `type` is integer/number/boolean. Drop the enum in
    // that case rather than emit an invalid typed enum — `type` plus the
    // description still guides the model, and the tool handler revalidates.
    const rawType = typeof result.type === 'string' ? result.type : undefined;
    if (Array.isArray(result.enum) && (rawType === 'integer' || rawType === 'number' || rawType === 'boolean')) {
        if (result.enum.some((item) => typeof item !== 'string')) {
            delete result.enum;
        }
    }
    // Gemini rejects array schemas that omit `items`; fill a permissive
    // default so the declaration validates.
    if (rawType === 'array' && (!result.items || typeof result.items !== 'object')) {
        result.items = { type: 'string' };
    }
    if (typeof result.type === 'string') {
        result.type = toSchemaType(result.type);
    }
    if (result.properties && typeof result.properties === 'object') {
        const props = {};
        for (const [key, val] of Object.entries(result.properties)) {
            props[key] = convertSchema(val);
        }
        result.properties = props;
    }
    if (result.items && typeof result.items === 'object') {
        result.items = convertSchema(result.items);
    }
    // Recurse into JSON Schema combinator keys so disallowed fields
    // (additionalProperties, $schema, etc.) get stripped at every nesting
    // level. Without this, schemas using anyOf/oneOf/allOf/not pass the
    // shallow strip but fail Gemini validation at depth.
    //
    // Two Gemini-specific normalizations are also applied per combinator
    // subschema:
    //   1. Inject `type: OBJECT` when a subschema uses object-only keys
    //      (`required` / `properties`) without an explicit type — Gemini
    //      rejects `required` outside of OBJECT type.
    //   2. Materialize a local `properties` map from the parent's properties
    //      when the subschema only carries `required: [names]` — Gemini
    //      validates that every name in `required` exists in *this*
    //      subschema's `properties` (it does not inherit from the parent
    //      the way JSON Schema's compositional model does).
    for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(result[combinator])) {
            result[combinator] = result[combinator].map((s) => {
                const sub = convertSchema(s);
                if (sub && typeof sub === 'object') {
                    const usesObjectKeys = sub.required !== undefined || sub.properties !== undefined;
                    if (usesObjectKeys && sub.type === undefined) {
                        sub.type = toSchemaType('object');
                    }
                    if (Array.isArray(sub.required) && !sub.properties && result.properties) {
                        const projected = {};
                        for (const k of sub.required) {
                            if (result.properties[k]) projected[k] = result.properties[k];
                        }
                        if (Object.keys(projected).length > 0) sub.properties = projected;
                    }
                }
                return sub;
            });
        }
    }
    if (result.not && typeof result.not === 'object') {
        result.not = convertSchema(result.not);
    }
    return result;
}

function toGeminiTools(tools) {
    return {
        functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: convertSchema(t.inputSchema),
        })),
    };
}
function toGeminiNativeTools(nativeTools) {
    if (!Array.isArray(nativeTools)) return [];
    const out = [];
    for (const tool of nativeTools) {
        const type = String(tool?.type || '').trim().toLowerCase();
        if (type === 'google_search' || type === 'google_search_retrieval') {
            out.push({ googleSearch: {} });
        }
    }
    return out;
}

function collectGeminiGroundingSources(candidate) {
    const out = [];
    const seen = new Set();
    const add = (source) => {
        if (!source || typeof source !== 'object') return;
        const web = source.web && typeof source.web === 'object' ? source.web : source;
        const url = String(web.uri || web.url || source.uri || source.url || '').trim();
        if (!url || seen.has(url)) return;
        seen.add(url);
        out.push({
            title: String(web.title || source.title || url).trim(),
            url,
            snippet: '',
            source: 'gemini-grounding',
            provider: 'gemini',
        });
    };
    const grounding = candidate?.groundingMetadata || {};
    for (const chunk of Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : []) add(chunk);
    const citationMetadata = candidate?.citationMetadata || {};
    for (const source of Array.isArray(citationMetadata.citationSources) ? citationMetadata.citationSources : []) add(source);
    return out;
}

// Map the orchestrator-level toolChoice to Gemini's functionCallingConfig.
//   auto      -> AUTO
//   required  -> ANY
//   none      -> NONE
//   { name }  -> ANY + allowedFunctionNames:[name]   (specific tool)
function toGeminiToolConfig(toolChoice) {
    if (toolChoice == null) return undefined;
    if (typeof toolChoice === 'string') {
        if (toolChoice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
        if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
        if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
        return undefined;
    }
    if (typeof toolChoice === 'object') {
        const name = toolChoice.name || toolChoice.function?.name;
        if (typeof name === 'string' && name) {
            return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
        }
    }
    return undefined;
}

function toGeminiContent(message, toolNameByCallId) {
    if (!message || message.role === 'system') return null;
    if (message.role === 'assistant' && message.toolCalls?.length) {
        const parts = [];
        if (message.content) parts.push(...normalizeContentForGeminiParts(message.content));
        for (const tc of message.toolCalls) {
            // Gemini 3 thinking models require the original thoughtSignature
            // echoed back on every prior functionCall so the cached thinking
            // prefix stays valid. v1beta places the field at the Part level
            // (sibling of functionCall) — putting it inside functionCall returns
            // 400 "Unknown name". Older models / first turn have no signature.
            const part = { functionCall: { name: tc.name, args: tc.arguments } };
            if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature;
            parts.push(part);
        }
        return { role: 'model', parts };
    }
    if (message.role === 'tool') {
        // Tool result content stays byte-identical for cache prefix stability.
        // Gemini accepts functionResponse parts under role 'user' (per docs).
        // Using 'user' keeps tool_result entries byte-identical between
        // cachedContents.create (which rejects role:'function') and
        // generateContent, so the cached prefix actually matches at runtime.
        // functionResponse.name must be the FUNCTION name, not the synthetic
        // toolCallId. Resolve it from the toolCallId->functionName map built
        // from prior assistant tool_calls; fall back to the raw id only when
        // no mapping exists.
        const functionName = (toolNameByCallId && toolNameByCallId.get(message.toolCallId))
            || message.toolCallId
            || '';
        const { response, mediaParts } = splitToolContentForGemini(message.content);
        const parts = [{ functionResponse: { name: functionName, response } }];
        if (mediaParts.length) parts.push(...mediaParts);
        return {
            role: 'user',
            parts,
        };
    }
    return {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: normalizeContentForGeminiParts(message.content),
    };
}

function toGeminiContents(messages) {
    const contents = [];
    // Map synthetic toolCallId -> function name from prior assistant
    // tool_calls so each functionResponse part carries the real function name.
    const toolNameByCallId = new Map();
    for (const m of messages) {
        if (m?.role === 'assistant' && Array.isArray(m.toolCalls)) {
            for (const tc of m.toolCalls) {
                if (tc?.id && tc?.name) toolNameByCallId.set(tc.id, tc.name);
            }
        }
    }
    for (const message of messages) {
        const content = toGeminiContent(message, toolNameByCallId);
        if (content) contents.push(content);
    }
    return contents;
}

export function parseToolCalls(parts) {
    const calls = parts.filter((p) => 'functionCall' in p && !!p.functionCall);
    if (!calls.length)
        return undefined;
    // The @google/generative-ai 0.24.1 SDK predates Gemini 3 thinking — its
    // FunctionCall type only declares { name, args }. The runtime object,
    // however, retains whatever the wire response carried, which means the
    // signature may sit under any of:
    //   • part.functionCall.thoughtSignature   (camelCase, expected)
    //   • part.functionCall.thought_signature  (snake_case, raw protobuf)
    //   • part.thoughtSignature / part.thought_signature (sibling on Part)
    // Read all four and use the first non-empty hit. Set MIXDOG_DEBUG_GEMINI=1
    // to dump the raw parts so we can confirm the actual key location on the
    // next session and harden the parser.
    if (process.env.MIXDOG_DEBUG_GEMINI === '1') {
        try { process.stderr.write(`[gemini fc raw] ${JSON.stringify(parts)}\n`); } catch {}
    }
    return calls.map((p, i) => {
        const fc = p.functionCall;
        const sig = fc.thoughtSignature
            || fc.thought_signature
            || p.thoughtSignature
            || p.thought_signature
            || null;
        const idHash = traceHash(stableTraceStringify({
            index: i,
            name: fc.name || '',
            args: fc.args ?? {},
        })).slice(0, 16);
        const call = {
            id: `gemini_${idHash}`,
            name: fc.name,
            arguments: (fc.args ?? {}),
        };
        if (sig) call.thoughtSignature = sig;
        return call;
    });
}

function emitGeminiToolCalls(toolCalls, onToolCall) {
    if (typeof onToolCall !== 'function' || !Array.isArray(toolCalls)) return;
    const emitted = new Set();
    for (const call of toolCalls) {
        if (!call?.id || !call?.name || emitted.has(call.id)) continue;
        emitted.add(call.id);
        try { onToolCall(call); } catch {}
    }
}

export class GeminiProvider {
    // promptTokenCount is the total (cachedContentTokenCount is a subset), so
    // input already includes cache. See registry.mjs.
    static inputExcludesCache = false;
    name = 'gemini';
    genAI;
    config;

    constructor(config) {
        this.config = config;
        const apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
        this.genAI = new GoogleGenerativeAI(apiKey);
        // Warm a kept-alive socket to the Gemini REST API so the first cache/
        // generateContent request skips the cold TLS handshake. Best-effort.
        preconnect('https://generativelanguage.googleapis.com');
    }

    reloadApiKey() {
        try {
            const freshConfig = loadConfig();
            const cfg = freshConfig.providers?.gemini;
            const newKey = cfg?.apiKey || process.env.GEMINI_API_KEY;
            if (newKey) {
                this.genAI = new GoogleGenerativeAI(newKey);
            }
        } catch { /* best effort */ }
    }

    _getApiKey() {
        return this.config?.apiKey || process.env.GEMINI_API_KEY || '';
    }

    // Explicit cachedContents API. The implicit cache layer on Gemini 3.x
    // does not surface cachedContentTokenCount in usageMetadata, so the only
    // way to obtain measurable + billable cache savings is to register the
    // stable prefix (system + tools) as a CachedContent and pass its name on
    // every generateContent call. TTL is 1h so a single worker session keeps
    // one cache slot warm without re-creation overhead; storage cost (~$0.5/M
    // tokens/hour) is dwarfed by the 75% input-price discount on hits beyond
    // a few iterations.
    async _ensureGeminiCache({ apiKey, model, systemInstruction, geminiTools, contents, opts }) {
        if (Array.isArray(opts?.nativeTools) && opts.nativeTools.length) return null;
        const state = opts.providerState?.gemini || null;
        const now = Date.now();
        const currentIter = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : 1;
        const refreshEveryN = Number(process.env.MIXDOG_GEMINI_CACHE_REFRESH_EVERY) > 0
            ? Number(process.env.MIXDOG_GEMINI_CACHE_REFRESH_EVERY)
            : 4;
        const cacheLiveMs = state?.cacheExpiresAt ? state.cacheExpiresAt - now : 0;
        const itersSinceCreate = state?.cacheCreatedAtIter != null
            ? currentIter - state.cacheCreatedAtIter
            : Infinity;
        const statePrefixContentCount = Number.isFinite(Number(state?.cachePrefixContentCount))
            ? Math.max(0, Math.trunc(Number(state.cachePrefixContentCount)))
            : null;
        const currentStatePrefixHash = statePrefixContentCount != null
            ? _geminiCachePrefixHash({
                model,
                systemInstruction,
                geminiTools,
                contents,
                prefixCount: statePrefixContentCount,
            })
            : null;
        const modelMatches = !!state?.cacheName && state?.cacheModel === model;
        const prefixMatches = !!state?.cacheName
            && statePrefixContentCount != null
            && statePrefixContentCount <= (Array.isArray(contents) ? contents.length : 0)
            && !!state?.cachePrefixHash
            && state.cachePrefixHash === currentStatePrefixHash;
        const canAttachState = !!state?.cacheName && cacheLiveMs > 0 && modelMatches && prefixMatches;
        const canReuseState = canAttachState && cacheLiveMs > 6 * 60 * 1000 && itersSinceCreate < refreshEveryN;
        try {
            appendAgentTrace({
                sessionId: opts.sessionId || opts.session?.id || null,
                iteration: currentIter,
                kind: 'gemini_cache_decision',
                payload: {
                    hasState: !!state?.cacheName,
                    stateCacheName: state?.cacheName || null,
                    stateCreatedAtIter: state?.cacheCreatedAtIter ?? null,
                    stateCacheModel: state?.cacheModel || null,
                    statePrefixContentCount,
                    statePrefixHash: state?.cachePrefixHash || null,
                    currentStatePrefixHash,
                    modelMatches,
                    prefixMatches,
                    canAttachState,
                    cacheLiveMs,
                    itersSinceCreate,
                    refreshEveryN,
                    decision: canReuseState ? 'reuse' : 'rebuild',
                    contentsLen: Array.isArray(contents) ? contents.length : 0,
                },
            });
        } catch {}
        if (canReuseState) {
            return state.cacheName;
        }
        if (!apiKey) return null;
        // Pre-flight invariant: cachedContents.create rejects prefixes below
        // the model-specific minimum. Skip the POST entirely when the estimate
        // is under threshold so we don't spam 400 responses turn-after-turn.
        const minTokens = _geminiCacheMinTokens(model);
        const estimatedTokens = _estimateGeminiCacheTokens(systemInstruction, geminiTools, contents);
        if (estimatedTokens < minTokens) {
            try {
                appendAgentTrace({
                    sessionId: opts.sessionId || opts.session?.id || null,
                    iteration: currentIter,
                    kind: 'gemini_cache_skip',
                    payload: {
                        reason: 'prefix_below_min',
                        estimatedTokens,
                        minTokens,
                        model,
                    },
                });
            } catch {}
            return canAttachState ? state.cacheName : null;
        }
        const ttlSeconds = 3600;
        const cachePrefixContentCount = _geminiCachePrefixCount(contents);
        const cachePrefixHash = _geminiCachePrefixHash({
            model,
            systemInstruction,
            geminiTools,
            contents,
            prefixCount: cachePrefixContentCount,
        });
        const globalCacheKey = _geminiGlobalCacheKey({
            apiKey,
            model,
            cachePrefixHash,
            cachePrefixContentCount,
        });
        const globalCache = _getGeminiGlobalCache(globalCacheKey, now);
        if (globalCache) {
            try {
                appendAgentTrace({
                    sessionId: opts.sessionId || opts.session?.id || null,
                    iteration: currentIter,
                    kind: 'gemini_cache_global_hit',
                    payload: {
                        cacheName: globalCache.cacheName,
                        cacheTokenSize: globalCache.cacheTokenSize,
                        cachePrefixContentCount,
                        cachePrefixHash,
                    },
                });
            } catch {}
            _attachGeminiCacheState(opts, globalCache, currentIter);
            return globalCache.cacheName;
        }
        const inFlightCreate = geminiGlobalCacheCreates.get(globalCacheKey);
        if (inFlightCreate) {
            const created = await inFlightCreate.catch(() => null);
            if (created?.cacheName) {
                try {
                    appendAgentTrace({
                        sessionId: opts.sessionId || opts.session?.id || null,
                        iteration: currentIter,
                        kind: 'gemini_cache_global_wait_hit',
                        payload: {
                            cacheName: created.cacheName,
                            cacheTokenSize: created.cacheTokenSize,
                            cachePrefixContentCount,
                            cachePrefixHash,
                        },
                    });
                } catch {}
                _attachGeminiCacheState(opts, created, currentIter);
                return created.cacheName;
            }
        }
        const createTask = (async () => {
            try {
            const cachePrefixContents = _geminiCachePrefixContents(contents, cachePrefixContentCount);
            const body = {
                model: `models/${model}`,
                ttl: `${ttlSeconds}s`,
            };
            if (systemInstruction) {
                body.systemInstruction = { parts: [{ text: systemInstruction }] };
            }
            if (Array.isArray(geminiTools) && geminiTools.length) {
                body.tools = geminiTools;
            }
            // Capture conversation prefix (everything except the latest user/
            // tool input that the generateContent call will carry) inside the
            // cache. cachedContents only accepts role='user' or 'model';
            // generateContent uses role='function' for tool_result turns, so
            // collapse that to 'user' (functionResponse parts remain inside).
            if (cachePrefixContents.length) {
                body.contents = cachePrefixContents;
            }
            const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${encodeURIComponent(apiKey)}`;
            // Honor the external session abort signal during cache creation, not
            // only the 20s ceiling. Without merging opts.signal a session that is
            // aborted (stall-watchdog / closeSession) mid-cache-create leaves this
            // preflight request running until its own timeout fires.
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: opts.signal
                    ? AbortSignal.any([opts.signal, AbortSignal.timeout(20_000)])
                    : AbortSignal.timeout(20_000),
                dispatcher: getLlmDispatcher(),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                try {
                    appendAgentTrace({
                        sessionId: opts.sessionId || opts.session?.id || null,
                        iteration: currentIter,
                        kind: 'gemini_cache_create_fail',
                        payload: {
                            status: res.status,
                            body: text.slice(0, 500),
                            contentsLen: Array.isArray(contents) ? contents.length : 0,
                            cachePrefixContentCount,
                            canAttachState,
                        },
                    });
                } catch {}
                return null;
            }
            const data = await res.json();
            const cacheName = data?.name || null;
            if (!cacheName) return null;
            const cacheTokenSize = Number(data?.usageMetadata?.totalTokenCount || 0) || 0;
            try {
                appendAgentTrace({
                    sessionId: opts.sessionId || opts.session?.id || null,
                    iteration: currentIter,
                    kind: 'gemini_cache_create_ok',
                    payload: {
                        cacheName,
                        cacheTokenSize,
                        contentsLen: Array.isArray(contents) ? contents.length : 0,
                        cachePrefixContentCount,
                        cachePrefixHash,
                    },
                });
            } catch {}
            // Best-effort cleanup of the previous cache so storage cost only
            // accrues on the live revision. Fire-and-forget; TTL expiry covers
            // any delete failures.
            const priorCacheName = state?.cacheName || null;
            if (priorCacheName && priorCacheName !== cacheName && !_geminiGlobalCacheNameIsLive(priorCacheName)) {
                const delUrl = `https://generativelanguage.googleapis.com/v1beta/${priorCacheName}?key=${encodeURIComponent(apiKey)}`;
                fetch(delUrl, { method: 'DELETE', signal: AbortSignal.timeout(10_000), dispatcher: getLlmDispatcher() })
                    .catch(() => { /* TTL expiry will reclaim it */ });
            }
            const createdAt = Date.now();
            const entry = {
                cacheName,
                cacheCreatedAt: createdAt,
                cacheExpiresAt: createdAt + ttlSeconds * 1000,
                cacheModel: model,
                cacheTokenSize,
                cachePrefixContentCount,
                cachePrefixHash,
            };
            _setGeminiGlobalCache(globalCacheKey, entry);
            return entry;
            } catch (err) {
                process.stderr.write(`[gemini] cachedContents.create error: ${err?.message || err}\n`);
                return null;
            }
        })();
        geminiGlobalCacheCreates.set(globalCacheKey, createTask);
        try {
            const created = await createTask;
            if (!created?.cacheName) return canAttachState ? state.cacheName : null;
            _attachGeminiCacheState(opts, created, currentIter);
            return created.cacheName;
        } finally {
            if (geminiGlobalCacheCreates.get(globalCacheKey) === createTask) {
                geminiGlobalCacheCreates.delete(globalCacheKey);
            }
        }
    }

    async send(messages, model, tools, sendOpts) {
        // Re-warm a kept-alive socket before the turn (TTL-gated no-op while
        // hot) so a post-idle request skips the cold TLS handshake.
        preconnect('https://generativelanguage.googleapis.com');
        try {
            return await this._doSend(messages, model, tools, sendOpts);
        } catch (err) {
            if (err.message && (err.message.includes('401') || err.message.includes('403'))) {
                process.stderr.write(`[provider] Auth error, re-reading config...\n`);
                this.reloadApiKey();
                return await this._doSend(messages, model, tools, sendOpts);
            }
            throw err;
        }
    }

    async _doSend(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const signal = opts.signal || null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error('Gemini request aborted by session close');
        }

        const useModel = model || await ensureLatestGeminiModel(this);
        const systemInstruction = messages
            .filter(m => m.role === 'system')
            .map(m => m.content)
            .join('\n\n') || undefined;
        const chatMsgs = messages.filter(m => m.role !== 'system');
        const contents = toGeminiContents(chatMsgs);
        if (!contents.length)
            throw new Error('No messages to send');

        const nativeGeminiTools = toGeminiNativeTools(opts.nativeTools);
        const functionGeminiTools = tools?.length ? [toGeminiTools(tools)] : [];
        const geminiTools = nativeGeminiTools.length || functionGeminiTools.length
            ? [...nativeGeminiTools, ...functionGeminiTools]
            : undefined;
        const toolConfig = functionGeminiTools.length ? toGeminiToolConfig(opts.toolChoice) : undefined;
        try { opts.onStageChange?.('requesting'); } catch {}

        // Explicit cachedContents (system + tools + prior-turn transcript).
        // Per Google docs, `tools` must be supplied on BOTH the cache create
        // call AND every subsequent generate_content call — the cache stores
        // the schema for prompt-token credit but the runtime model still
        // needs the tool schema to actually emit function calls. Sending
        // cachedContent without tools yields an empty completion (function
        // calling silently disabled). The contents payload captures the
        // accumulated prefix; we refresh the cache every N iterations so
        // recent turns also enter the cached prefix instead of being billed
        // at full input rates.
        const cachedContent = await this._ensureGeminiCache({
            apiKey: this._getApiKey(),
            model: useModel,
            systemInstruction,
            geminiTools,
            contents,
            opts,
        });
        try { opts.onStageChange?.('requesting'); } catch {}

        // When cachedContent is attached we bypass @google/generative-ai
        // (deprecated; v1beta v1.x docs explicitly forbid re-sending tools or
        // systemInstruction once a cache carries them, but the bundled SDK
        // can't actually issue a tool-less generateContent call). REST direct
        // sends the v1beta payload Google's new genai client uses, so the
        // cache owns system/tools and the runtime gets a clean cache hit.
        let response;
        if (cachedContent) {
            const apiKey = this._getApiKey();
            const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
            const cachedPrefixContentCount = Number.isFinite(Number(opts.providerState?.gemini?.cachePrefixContentCount))
                ? Math.max(0, Math.min(contents.length, Math.trunc(Number(opts.providerState.gemini.cachePrefixContentCount))))
                : 0;
            const deltaContents = contents.slice(cachedPrefixContentCount);
            // Cache carries the recorded prefix. Send every uncached tail turn,
            // not just the last message, so reused cachedContents preserve
            // full conversation context between periodic refreshes.
            const body = {
                contents: deltaContents.length ? deltaContents : contents.slice(-1),
                cachedContent,
            };
            if (toolConfig) body.toolConfig = toolConfig;
            // Option A (mirror anthropic-oauth): no absolute wall-clock cap on a
            // live streaming turn. A stream that keeps emitting SSE deltas must
            // not be killed by a fixed total-lifetime timer — that false-aborts
            // healthy high-reasoning turns still producing tokens. The streaming
            // phase is bounded instead by the per-attempt first-byte timeout
            // (truly wedged socket), the external signal (client disconnect /
            // replaced request), and the SSE idle watchdog. totalSignal is a pure
            // pass-through of the external signal with no timer.
            const restPassthrough = createPassthroughSignal(signal);
            const totalSignal = restPassthrough.signal;
            try {
                response = await withRetry(
                    async ({ signal: attemptSignal }) => {
                        try { opts.onStageChange?.('requesting'); } catch {}
                        const openFirstByte = createTimeoutSignal(
                            attemptSignal,
                            GEMINI_FIRST_BYTE_TIMEOUT_MS,
                            'Gemini REST first byte',
                        );
                        let res;
                        try {
                            res = await fetch(genUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(body),
                                signal: openFirstByte.signal,
                                dispatcher: getLlmDispatcher(),
                            });
                        } finally {
                            openFirstByte.cleanup();
                        }
                        if (!res.ok) {
                            const text = await res.text().catch(() => '');
                            const err = new Error(`Gemini REST streamGenerateContent ${res.status}: ${text.slice(0, 300)}`);
                            err.status = res.status;
                            throw err;
                        }
                        return await consumeGeminiRestStreamResponse(res, {
                            signal: attemptSignal,
                            onStreamDelta,
                            onTextDelta,
                            label: 'Gemini REST streamGenerateContent',
                        });
                    },
                    {
                        signal: totalSignal,
                        onRetry: ({ attempt, lastErr }) => {
                            try { opts.onStageChange?.('requesting'); } catch {}
                            process.stderr.write(`[gemini-rest] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}\n`);
                        },
                    },
                );
            } finally {
                restPassthrough.cleanup();
            }
        } else {
            const genModel = this.genAI.getGenerativeModel({
                model: useModel,
                systemInstruction,
                tools: geminiTools,
                ...(toolConfig ? { toolConfig } : {}),
            });
            // Option A (mirror anthropic-oauth): pure pass-through of the external
            // signal, no absolute streaming total cap. See the REST branch above.
            const sdkPassthrough = createPassthroughSignal(signal);
            const totalSignal = sdkPassthrough.signal;
            try {
                response = await withRetry(
                    async ({ signal: attemptSignal }) => {
                        try { opts.onStageChange?.('requesting'); } catch {}
                        // Mirror the REST branch's signal lifetime: the request
                        // controller stays linked to the parent (attemptSignal)
                        // for the FULL stream — connect AND body — so a parent /
                        // client / gateway abort after first byte still cancels
                        // the underlying SDK request (the SSE idle watchdog is off
                        // by default). The first-byte timer only bounds the
                        // connect phase and is cleared once the stream starts, so
                        // it can never kill a live, still-producing stream.
                        const reqController = new AbortController();
                        let parentAbortListener = null;
                        let firstByteTimer = null;
                        const detachParent = () => {
                            if (parentAbortListener && attemptSignal) {
                                try { attemptSignal.removeEventListener('abort', parentAbortListener); } catch {}
                                parentAbortListener = null;
                            }
                        };
                        const clearConnectTimer = () => {
                            if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
                        };
                        if (attemptSignal) {
                            if (attemptSignal.aborted) {
                                try { reqController.abort(attemptSignal.reason); } catch {}
                            } else {
                                parentAbortListener = () => { try { reqController.abort(attemptSignal.reason); } catch {} };
                                attemptSignal.addEventListener('abort', parentAbortListener, { once: true });
                            }
                        }
                        firstByteTimer = setTimeout(() => {
                            try { reqController.abort(geminiTimeoutError('Gemini SDK first byte', GEMINI_FIRST_BYTE_TIMEOUT_MS)); } catch {}
                        }, GEMINI_FIRST_BYTE_TIMEOUT_MS);
                        if (firstByteTimer.unref) firstByteTimer.unref();
                        try {
                            let streamResult;
                            try {
                                streamResult = await genModel.generateContentStream(
                                    { contents },
                                    { signal: reqController.signal },
                                );
                            } catch (err) {
                                if (reqController.signal.aborted) {
                                    throw reqController.signal.reason instanceof Error
                                        ? reqController.signal.reason
                                        : err;
                                }
                                throw err;
                            }
                            // First byte / headers received: drop the connect-phase
                            // timer but KEEP the parent link attached so a later
                            // abort during streaming still reaches the request.
                            clearConnectTimer();
                            return await consumeGeminiSdkStream(streamResult, {
                                signal: attemptSignal,
                                onStreamDelta,
                                onTextDelta,
                                label: 'Gemini SDK streamGenerateContent',
                            });
                        } finally {
                            clearConnectTimer();
                            detachParent();
                        }
                    },
                    {
                        signal: totalSignal,
                        onRetry: ({ attempt, lastErr }) => {
                            try { opts.onStageChange?.('requesting'); } catch {}
                            process.stderr.write(`[gemini] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}\n`);
                        },
                    },
                );
            } finally {
                sdkPassthrough.cleanup();
            }
        }
        writeGeminiCacheTrace({
            opts,
            model: useModel,
            systemInstruction,
            tools,
            contents,
            usageMetadata: response.usageMetadata,
            cachedContent,
        });
        const candidate = response.candidates?.[0] || null;
        const textParts = candidate?.content?.parts?.filter(p => 'text' in p) ?? [];
        const content = textParts.map(p => 'text' in p ? p.text : '').join('');
        const toolCalls = parseToolCalls(candidate?.content?.parts ?? []);
        const citations = collectGeminiGroundingSources(candidate);
        emitGeminiToolCalls(toolCalls, onToolCall);
        // Inspect candidate.finishReason — Gemini reports terminal status here.
        // Only STOP (and the legacy "FINISH_REASON_STOP") plus tool/function-
        // call paths represent a fully delivered turn. MAX_TOKENS / SAFETY /
        // RECITATION / OTHER all mean the candidate was cut off before the
        // model finished, and surfacing the partial text as final would
        // silently accept a truncated answer. Convert those into a typed
        // provider-incomplete error so the loop can decide whether to retry,
        // nudge, or surface to the user. Missing finishReason (still
        // streaming / unknown) is left alone — existing success paths for
        // genuinely complete responses keep working.
        const finishReason = candidate?.finishReason || null;
        const incompleteFinishReasons = new Set([
            'MAX_TOKENS',
            'SAFETY',
            'RECITATION',
            'OTHER',
            'BLOCKLIST',
            'PROHIBITED_CONTENT',
            'SPII',
            'MALFORMED_FUNCTION_CALL',
        ]);
        if (finishReason && incompleteFinishReasons.has(finishReason)) {
            const err = Object.assign(
                new Error(`Gemini response incomplete: finishReason=${finishReason}`),
                {
                    name: 'ProviderIncompleteError',
                    code: 'PROVIDER_INCOMPLETE',
                    providerIncomplete: true,
                    finishReason,
                    partialContent: content,
                    partialToolCalls: toolCalls,
                    model: useModel,
                    rawUsage: response.usageMetadata || null,
                },
            );
            throw err;
        }
        const um = response.usageMetadata || null;
        // Hoist cachedTokens so the returned usage block can reuse the
        // exact value the trace already recorded (including the
        // cachedFallback when cachedContentTokenCount under-reports).
        let cachedTokens = 0;
        if (um) {
            const {
                inputTokens,
                reportedCachedTokens,
                cachedFallbackTokens,
                cachedTokens: resolvedCachedTokens,
                cacheTokenSource,
            } = _resolveGeminiCacheUsage({
                usageMetadata: um,
                cachedContent,
                providerState: opts.providerState,
            });
            cachedTokens = resolvedCachedTokens;
            const outputTokens = (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
            if (cachedContent && inputTokens > 0 && cachedTokens <= 0) {
                try {
                    appendAgentTrace({
                        sessionId: opts.sessionId || opts.session?.id || null,
                        iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
                        kind: 'gemini_cache_anomaly',
                        payload: {
                            reason: 'cached_content_attached_but_zero_cached_tokens',
                            inputTokens,
                            reportedCachedTokens,
                            cachedFallbackTokens,
                            cacheTokenSource,
                            cacheName: opts.providerState?.gemini?.cacheName || null,
                            cachePrefixContentCount: opts.providerState?.gemini?.cachePrefixContentCount ?? null,
                        },
                    });
                } catch {}
            }
            traceAgentUsage({
                sessionId: opts.sessionId || opts.session?.id || null,
                iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
                inputTokens,
                outputTokens,
                cachedTokens,
                cacheWriteTokens: 0,
                promptTokens: inputTokens,
                model: useModel,
                modelDisplay: useModel,
                rawUsage: um,
                provider: 'gemini',
            });
        }
        return {
            content,
            model: useModel,
            toolCalls,
            citations: citations.length ? citations : undefined,
            providerState: opts.providerState,
            usage: um ? (() => {
                const input = um.promptTokenCount || um.totalTokenCount || 0;
                return {
                    inputTokens: input,
                    outputTokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
                    // Use the already-computed cachedTokens (with
                    // cache-create fallback applied) rather than the raw
                    // metadata field, so the returned usage matches what
                    // traceAgentUsage recorded for this same call.
                    cachedTokens,
                    // Gemini promptTokenCount is total (cachedContentTokenCount
                    // is a subset). Alias directly into promptTokens.
                    promptTokens: input,
                };
            })() : undefined,
        };
    }

    async listModels() {
        const cached = _modelCache.loadSync();
        if (cached) return cached;
        // Dynamic lookup via Gemini v1beta /models. Requires API key.
        const apiKey = this.config.apiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) return MODELS; // no key — return minimal static list
        try {
            return await this._fetchAndCacheModels(apiKey);
        } catch (err) {
            process.stderr.write(`[gemini] listModels fetch failed (${err.message})\n`);
            return MODELS;
        }
    }

    // Shared fetch+normalize+enrich+write used by both listModels() (after the
    // TTL check) and _refreshModelCache() (bypassing it). Throws on failure so
    // each caller applies its own fallback/logging.
    async _fetchAndCacheModels(apiKey) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
        const listSignal = AbortSignal.timeout(60_000);
        const res = await fetch(url, { signal: listSignal, dispatcher: getLlmDispatcher() });
        if (!res.ok) throw new Error(`gemini list_models ${res.status}`);
        const data = await res.json();
        const items = Array.isArray(data?.models) ? data.models : [];
        // Filter to Gemini family; skip embedding/imagen endpoints.
        const normalized = items
            .filter(m => (m?.name || '').includes('gemini'))
            .filter(m => !/embedding|aqa|imagen/.test(m?.name || ''))
            .map(m => {
                const id = (m.name || '').replace(/^models\//, '');
                const family = /flash-lite/.test(id) ? 'gemini-flash-lite'
                    : /flash/.test(id) ? 'gemini-flash'
                    : /pro/.test(id) ? 'gemini-pro'
                    : 'gemini';
                return {
                    id,
                    display: m.displayName || id,
                    family,
                    provider: 'gemini',
                    contextWindow: m.inputTokenLimit || 1000000,
                    outputTokens: m.outputTokenLimit || 8192,
                    tier: 'version',
                    latest: false,
                    description: m.description || '',
                };
            });
        _markLatestGemini(normalized);
        // LiteLLM catalog overlays pricing and updated metadata.
        const { enrichModels } = await import('./model-catalog.mjs');
        const enriched = await enrichModels(normalized);
        _modelCache.save(enriched);
        return enriched;
    }

    // Force a catalog refresh (ignores the 24h disk TTL). De-duped via
    // _modelRefreshInFlight so concurrent callers share one HTTP round-trip.
    // Fire-and-forget context: failures are caught/logged, returning null.
    async _refreshModelCache() {
        if (_modelRefreshInFlight) return _modelRefreshInFlight;
        _modelRefreshInFlight = (async () => {
            try {
                const apiKey = this.config.apiKey || process.env.GEMINI_API_KEY;
                if (!apiKey) return null; // no key — nothing to refresh
                const enriched = await this._fetchAndCacheModels(apiKey);
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[gemini] catalog refreshed (${enriched.length} models)\n`);
                return enriched;
            } catch (err) {
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[gemini] catalog refresh failed (${err.message})\n`);
                return null;
            } finally {
                _modelRefreshInFlight = null;
            }
        })();
        return _modelRefreshInFlight;
    }

    async isAvailable() {
        try {
            const model = this.genAI.getGenerativeModel({ model: DEFAULT_MODEL });
            await model.generateContent('hi');
            return true;
        }
        catch {
            return false;
        }
    }
}
