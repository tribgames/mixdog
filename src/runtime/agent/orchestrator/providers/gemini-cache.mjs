/**
 * gemini-cache.mjs — Gemini explicit cachedContents prefix accounting:
 * token estimation, prefix hashing, the process-global cache registry
 * (create de-dupe + prune), cache-state attach, usage resolution, and the
 * cache trace writer.
 *
 * Owns the module-level geminiGlobalCaches / geminiGlobalCacheCreates maps.
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
  return [...summaries.slice(0, 8), { omittedTurns: summaries.length - 12 }, ...summaries.slice(-4)];
}

// Gemini cachedContents API rejects prefixes below a model-specific minimum
// with HTTP 400 "Cached content is too small". Estimating chars/4 ≈ tokens
// lets us skip the roundtrip when the prefix cannot satisfy the invariant.
// Estimate undercount is harmless (we attempt and get the same 400 we would
// have skipped); overcount is harmless (we skip, fall back to implicit cache).
export function _estimateGeminiCacheTokens(systemInstruction, geminiTools, contents) {
  let chars = 0;
  if (typeof systemInstruction === 'string') chars += systemInstruction.length;
  if (Array.isArray(geminiTools) && geminiTools.length) {
    try {
      chars += JSON.stringify(geminiTools).length;
    } catch {}
  }
  if (Array.isArray(contents) && contents.length > 1) {
    for (let i = 0; i < contents.length - 1; i++) {
      try {
        chars += JSON.stringify(contents[i]?.parts ?? '').length;
      } catch {}
    }
  }
  return Math.ceil(chars / 4);
}

// Explicit-cache eligibility and minimum prefix size per model, from the
// caching docs: explicit caching works on Gemini 3 and 2.5 and is not supported
// from Gemini 4 onward; documented minimums are 4096 for Gemini 3.x and 2048
// for 2.5 Flash/Pro. Other ids keep the conservative 4096 floor (skipping a
// small prefix only falls back to the implicit cache, whereas a floor that is
// too low would POST a create the server rejects every turn).
const GEMINI_CACHE_MIN_TOKENS = 4096;

// Minimum prefix tokens for an explicit cache, or null when the docs exclude
// the model from explicit caching.
export function geminiExplicitCacheMinTokens(model) {
  const bare = String(model || '')
    .replace(/^models\//i, '')
    .toLowerCase();
  const major = /^gemini-(\d+)/.exec(bare);
  if (major && Number(major[1]) >= 4) return null;
  if (/^gemini-2\.5-(?:pro|flash)(?!-lite)(?:-|$)/.test(bare)) return 2048;
  return GEMINI_CACHE_MIN_TOKENS;
}

export function _geminiCacheMinTokens(model) {
  return geminiExplicitCacheMinTokens(model) ?? GEMINI_CACHE_MIN_TOKENS;
}

export function _geminiCachePrefixCount(contents) {
  return Array.isArray(contents) && contents.length > 1 ? contents.length - 1 : 0;
}

export function _geminiCachePrefixContents(contents, prefixCount) {
  if (!Array.isArray(contents) || prefixCount <= 0) return [];
  return contents.slice(0, prefixCount).map((c) => {
    const r = c?.role;
    const safeRole = r === 'model' || r === 'user' ? r : 'user';
    return {
      role: safeRole,
      parts: Array.isArray(c?.parts) ? c.parts : [],
    };
  });
}

export function _geminiCachePrefixHash({ model, systemInstruction, geminiTools, toolConfig, contents, prefixCount }) {
  return traceHash(
    stableTraceStringify({
      model: model || null,
      systemInstruction: systemInstruction || '',
      tools: geminiTools || [],
      toolConfig: toolConfig || null,
      contents: _geminiCachePrefixContents(contents, prefixCount),
    })
  );
}

// Keep enough headroom for the provider's 60s first-byte window plus setup
// overhead. This matches the default five-minute cache's per-session 25%
// reuse threshold, so a cross-session hit cannot expire while opening.
const GEMINI_GLOBAL_CACHE_MIN_LIVE_MS = 75 * 1000;
const GEMINI_GLOBAL_CACHE_MAX_ENTRIES = 128;
// Grace window before deleting a superseded cachedContents name (see the
// cross-session race note at the delete call site in gemini.mjs). Long enough
// that a concurrent session still mid-flight on the old name has time to finish.
export const GEMINI_GLOBAL_CACHE_DELETE_GRACE_MS = 2 * 60 * 1000;
const geminiGlobalCaches = new Map();
export const geminiGlobalCacheCreates = new Map();
// Models whose cachedContents.create the server refused as unsupported (not
// a prefix or quota failure). No catalog publishes explicit-cache support, so
// the server's own answer decides, once per process.
const geminiExplicitCacheRefusedModels = new Set();

export function markGeminiExplicitCacheRefused(model, err) {
  if (err?.status !== 400) return false;
  if (!/explicit caching is not supported/i.test(String(err?.message || ''))) return false;
  geminiExplicitCacheRefusedModels.add(String(model || ''));
  return true;
}

// True when explicit cache creates must not be attempted: the docs exclude the
// model, or the server already refused it.
export function geminiExplicitCacheRefused(model) {
  return geminiExplicitCacheMinTokens(model) === null || geminiExplicitCacheRefusedModels.has(String(model || ''));
}

export function _geminiCredentialFingerprint(apiKey) {
  return traceHash(String(apiKey || ''));
}

export function _geminiGlobalCacheKey({ credentialFingerprint, model, cachePrefixHash, cachePrefixContentCount }) {
  return traceHash(
    stableTraceStringify({
      credentialFingerprint: credentialFingerprint || null,
      model: model || null,
      cachePrefixHash,
      cachePrefixContentCount,
    })
  );
}

function _deleteGeminiGlobalCaches(matches) {
  let removed = 0;
  for (const [key, entry] of geminiGlobalCaches) {
    if (!matches(entry)) continue;
    geminiGlobalCaches.delete(key);
    removed += 1;
  }
  return removed;
}

export function _invalidateGeminiCachesForCredentialFingerprint(credentialFingerprint) {
  if (!credentialFingerprint) return 0;
  return _deleteGeminiGlobalCaches((entry) => entry?.cacheCredentialFingerprint === credentialFingerprint);
}

export function _invalidateGeminiCacheName(cacheName) {
  if (!cacheName) return 0;
  return _deleteGeminiGlobalCaches((entry) => entry?.cacheName === cacheName);
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
  const promptTokens = firstFinite(usageMetadata?.promptTokenCount, usageMetadata?.prompt_token_count);
  const totalTokens = firstFinite(usageMetadata?.totalTokenCount, usageMetadata?.total_token_count);
  // Gemini totalTokenCount includes candidate and thought output tokens.
  // When promptTokenCount is omitted, derive the prompt portion so callers
  // that separately record output tokens do not count them twice.
  const outputTokens =
    firstFinite(usageMetadata?.candidatesTokenCount, usageMetadata?.candidates_token_count) +
    firstFinite(usageMetadata?.thoughtsTokenCount, usageMetadata?.thoughts_token_count);
  const hasExplicitPromptTokens =
    Object.hasOwn(usageMetadata || {}, 'promptTokenCount') || Object.hasOwn(usageMetadata || {}, 'prompt_token_count');
  // toolUsePromptTokenCount (tool-result prompt tokens) is billed as input and
  // reported separately from promptTokenCount; cached tokens stay a subset of
  // the prompt portion.
  const toolUseTokens = firstFinite(usageMetadata?.toolUsePromptTokenCount, usageMetadata?.tool_use_prompt_token_count);
  const inputTokens = hasExplicitPromptTokens ? promptTokens + toolUseTokens : Math.max(0, totalTokens - outputTokens);
  const reportedCachedCount = [
    // generateContent UsageMetadata field.
    usageMetadata?.cachedContentTokenCount,
    usageMetadata?.cached_content_token_count,
    // Newer SDK convenience alias documented for implicit cache hits.
    usageMetadata?.totalCachedTokens,
    usageMetadata?.total_cached_tokens,
  ]
    .map((value) => (value == null ? NaN : Number(value)))
    .find((value) => Number.isFinite(value) && value >= 0);
  const reportedCachedTokens = reportedCachedCount ?? 0;
  const cachedFallbackTokens = cachedContent ? Number(providerState?.gemini?.cacheTokenSize || 0) || 0 : 0;
  // An explicit zero is a measured miss, not missing usage metadata.
  const rawCachedTokens = reportedCachedCount ?? cachedFallbackTokens;
  const cachedTokens = inputTokens > 0 ? Math.min(rawCachedTokens, inputTokens) : rawCachedTokens;
  let cacheTokenSource = 'none';
  if (reportedCachedCount !== undefined) cacheTokenSource = 'usage_metadata';
  else if (cachedFallbackTokens > 0) cacheTokenSource = 'cache_create_fallback';
  return {
    inputTokens,
    reportedCachedTokens,
    cachedFallbackTokens,
    cachedTokens,
    cacheTokenSource,
  };
}

export function writeGeminiCacheTrace({
  opts,
  model,
  systemInstruction,
  tools,
  contents,
  usageMetadata,
  cachedContent,
}) {
  if (process.env.MIXDOG_GEMINI_CACHE_TRACE !== '1') return;
  try {
    const session = opts?.session || {};
    const { inputTokens, reportedCachedTokens, cachedFallbackTokens, cachedTokens, cacheTokenSource } =
      _resolveGeminiCacheUsage({
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
