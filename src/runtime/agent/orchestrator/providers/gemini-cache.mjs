/**
 * gemini-cache.mjs — Gemini explicit cachedContents prefix accounting:
 * token estimation, prefix hashing, the process-global cache registry
 * (create de-dupe + prune), cache-state attach, usage resolution, and the
 * cache trace writer.
 *
 * Extracted from gemini.mjs (no behavior change). Owns the module-level
 * geminiGlobalCaches / geminiGlobalCacheCreates maps. gemini.mjs imports
 * these helpers; no re-export needed (all names are internal to the
 * provider — none were part of the module's external surface).
 */
import { traceHash, stableTraceStringify, summarizeTraceTools, traceTextShape } from './trace-utils.mjs';

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
export function _estimateGeminiCacheTokens(systemInstruction, geminiTools, contents) {
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

export function _geminiCacheMinTokens(model) {
    return /^gemini-3/i.test(String(model || '')) ? 4096 : 2048;
}

export function _geminiCachePrefixCount(contents) {
    return Array.isArray(contents) && contents.length > 1 ? contents.length - 1 : 0;
}

export function _geminiCachePrefixContents(contents, prefixCount) {
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

export function _geminiCachePrefixHash({ model, systemInstruction, geminiTools, toolConfig, contents, prefixCount }) {
    return traceHash(stableTraceStringify({
        model: model || null,
        systemInstruction: systemInstruction || '',
        tools: geminiTools || [],
        toolConfig: toolConfig || null,
        contents: _geminiCachePrefixContents(contents, prefixCount),
    }));
}

// Keep enough headroom for the provider's 60s first-byte window plus setup
// overhead. This matches the default five-minute cache's per-session 25%
// reuse threshold, so a cross-session hit cannot expire while opening.
export const GEMINI_GLOBAL_CACHE_MIN_LIVE_MS = 75 * 1000;
const GEMINI_GLOBAL_CACHE_MAX_ENTRIES = 128;
// Grace window before deleting a superseded cachedContents name (see the
// cross-session race note at the delete call site in gemini.mjs). Long enough
// that a concurrent session still mid-flight on the old name has time to finish.
export const GEMINI_GLOBAL_CACHE_DELETE_GRACE_MS = 2 * 60 * 1000;
export const geminiGlobalCaches = new Map();
export const geminiGlobalCacheCreates = new Map();

export function _geminiCredentialFingerprint(apiKey) {
    return traceHash(String(apiKey || ''));
}

export function _geminiGlobalCacheKey({ credentialFingerprint, model, cachePrefixHash, cachePrefixContentCount }) {
    return traceHash(stableTraceStringify({
        credentialFingerprint: credentialFingerprint || null,
        model: model || null,
        cachePrefixHash,
        cachePrefixContentCount,
    }));
}

export function _invalidateGeminiCachesForCredentialFingerprint(credentialFingerprint) {
    if (!credentialFingerprint) return 0;
    let removed = 0;
    for (const [key, entry] of geminiGlobalCaches) {
        if (entry?.cacheCredentialFingerprint !== credentialFingerprint) continue;
        geminiGlobalCaches.delete(key);
        removed += 1;
    }
    return removed;
}

export function _invalidateGeminiCacheName(cacheName) {
    if (!cacheName) return 0;
    let removed = 0;
    for (const [key, entry] of geminiGlobalCaches) {
        if (entry?.cacheName !== cacheName) continue;
        geminiGlobalCaches.delete(key);
        removed += 1;
    }
    return removed;
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

export function _getGeminiGlobalCache(key, now = Date.now()) {
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

export function _setGeminiGlobalCache(key, entry) {
    if (!key || !entry?.cacheName) return;
    geminiGlobalCaches.set(key, {
        ...entry,
        lastUsedAt: Date.now(),
    });
    _pruneGeminiGlobalCaches();
}

export function _geminiGlobalCacheNameIsLive(cacheName, now = Date.now()) {
    if (!cacheName) return false;
    for (const entry of geminiGlobalCaches.values()) {
        if (entry?.cacheName === cacheName && Number(entry.cacheExpiresAt || 0) > now) return true;
    }
    return false;
}

export function _attachGeminiCacheState(opts, entry, currentIter) {
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
            cacheCredentialFingerprint: entry.cacheCredentialFingerprint,
        },
    };
}

export function _resolveGeminiCacheUsage({ usageMetadata, cachedContent, providerState }) {
    const firstFinite = (...values) => {
        for (const value of values) {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return 0;
    };
    const promptTokens = firstFinite(
        usageMetadata?.promptTokenCount,
        usageMetadata?.prompt_token_count,
    );
    const totalTokens = firstFinite(
        usageMetadata?.totalTokenCount,
        usageMetadata?.total_token_count,
    );
    // Gemini totalTokenCount includes candidate and thought output tokens.
    // When promptTokenCount is omitted, derive the prompt portion so callers
    // that separately record output tokens do not count them twice.
    const outputTokens = firstFinite(
        usageMetadata?.candidatesTokenCount,
        usageMetadata?.candidates_token_count,
    ) + firstFinite(
        usageMetadata?.thoughtsTokenCount,
        usageMetadata?.thoughts_token_count,
    );
    const hasExplicitPromptTokens = Object.prototype.hasOwnProperty.call(usageMetadata || {}, 'promptTokenCount')
        || Object.prototype.hasOwnProperty.call(usageMetadata || {}, 'prompt_token_count');
    const inputTokens = hasExplicitPromptTokens
        ? promptTokens
        : Math.max(0, totalTokens - outputTokens);
    const reportedCachedTokens = firstFinite(
        // generateContent UsageMetadata field.
        usageMetadata?.cachedContentTokenCount,
        usageMetadata?.cached_content_token_count,
        // Newer SDK convenience alias documented for implicit cache hits.
        usageMetadata?.totalCachedTokens,
        usageMetadata?.total_cached_tokens,
    );
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

export function writeGeminiCacheTrace({ opts, model, systemInstruction, tools, contents, usageMetadata, cachedContent }) {
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
            agent: session.agent || null,
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
