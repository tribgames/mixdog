/**
 * Decision layer for Gemini explicit `cachedContents`: the tunables and
 * kill-switch, the reuse/rebuild verdict for a session's recorded cache, the
 * prefix identity one cache entry is keyed on, the create request body, the
 * entry shape published to the process-global map, the below-minimum
 * preflight, the singleflight wait semantics, and the invalidation of a cache
 * the server rejected.
 *
 * Wire-format note: every field name here (`model`, `ttl`, `systemInstruction`,
 * `tools`, `toolConfig`, `contents`) is the v1beta cachedContents contract, and
 * every trace `kind` is a consumed log key — they are moved verbatim, never
 * renamed. The HTTP call itself stays on the provider, which owns `_fetch`,
 * the API key and the retry budget.
 */
import { appendAgentTrace } from '../agent-trace.mjs';
import {
  _estimateGeminiCacheTokens,
  _geminiCacheMinTokens,
  _geminiCachePrefixCount,
  _geminiCachePrefixContents,
  _geminiCachePrefixHash,
  _geminiGlobalCacheKey,
  _getGeminiGlobalCache,
  _invalidateGeminiCacheName,
} from './gemini-cache.mjs';

export function traceGeminiCache(opts, iteration, kind, payload) {
  try {
    appendAgentTrace({ sessionId: opts.sessionId || opts.session?.id || null, iteration, kind, payload });
  } catch {}
}

// Explicit-cache tunables. The prefix is rebuilt every N iterations so
// recent turns also enter the cached prefix. Cache TTL (storage is billed
// per token-hour, so shorter is cheaper) defaults to 5m: agent tool loops
// re-request within seconds, and the refresh-every-4-iterations rebuild
// re-arms the TTL well before expiry. Long-idle sessions just pay one cold
// rebuild on resume.
export function geminiCacheTunables() {
  const refreshEveryN =
    Number(process.env.MIXDOG_GEMINI_CACHE_REFRESH_EVERY) > 0
      ? Number(process.env.MIXDOG_GEMINI_CACHE_REFRESH_EVERY)
      : 4;
  const ttlSeconds =
    Number(process.env.MIXDOG_GEMINI_CACHE_TTL_SECONDS) > 0 ? Number(process.env.MIXDOG_GEMINI_CACHE_TTL_SECONDS) : 300;
  return { refreshEveryN, ttlSeconds };
}

// The recorded prefix length and the hash the current request produces at
// that length; both null when the state records no prefix.
function geminiStatePrefix(state, model, request) {
  const statePrefixContentCount = Number.isFinite(Number(state?.cachePrefixContentCount))
    ? Math.max(0, Math.trunc(Number(state.cachePrefixContentCount)))
    : null;
  const currentStatePrefixHash =
    statePrefixContentCount != null
      ? _geminiCachePrefixHash({ model, ...request, prefixCount: statePrefixContentCount })
      : null;
  return { statePrefixContentCount, currentStatePrefixHash };
}

// Whether the session's recorded cache can still be attached (live TTL,
// same model, credential and prefix) and whether it is fresh enough to
// reuse outright. Reuse requires remaining TTL headroom so we never attach a
// cache that expires mid-request — scaled with TTL (25%, clamped to
// 10s..6m); the old fixed 6-minute floor silently disabled reuse for any
// TTL <= 6m, forcing a full-price rebuild every turn.
export function geminiCacheStateDecision({
  state,
  model,
  credentialFingerprint,
  request,
  currentIter,
  now,
  ttlSeconds,
  refreshEveryN,
}) {
  const { contents } = request;
  const reuseHeadroomMs = Math.min(6 * 60 * 1000, Math.max(10 * 1000, ttlSeconds * 250));
  const cacheLiveMs = state?.cacheExpiresAt ? state.cacheExpiresAt - now : 0;
  const itersSinceCreate = state?.cacheCreatedAtIter != null ? currentIter - state.cacheCreatedAtIter : Infinity;
  const { statePrefixContentCount, currentStatePrefixHash } = geminiStatePrefix(state, model, request);
  const modelMatches = !!state?.cacheName && state?.cacheModel === model;
  const credentialMatches = !!state?.cacheName && state?.cacheCredentialFingerprint === credentialFingerprint;
  const prefixMatches =
    !!state?.cacheName &&
    statePrefixContentCount != null &&
    statePrefixContentCount <= (Array.isArray(contents) ? contents.length : 0) &&
    !!state?.cachePrefixHash &&
    state.cachePrefixHash === currentStatePrefixHash;
  const canAttachState = !!state?.cacheName && cacheLiveMs > 0 && modelMatches && credentialMatches && prefixMatches;
  const canReuseState = canAttachState && cacheLiveMs > reuseHeadroomMs && itersSinceCreate < refreshEveryN;
  return {
    canAttachState,
    canReuseState,
    trace: {
      hasState: !!state?.cacheName,
      stateCacheName: state?.cacheName || null,
      stateCreatedAtIter: state?.cacheCreatedAtIter ?? null,
      stateCacheModel: state?.cacheModel || null,
      statePrefixContentCount,
      statePrefixHash: state?.cachePrefixHash || null,
      currentStatePrefixHash,
      modelMatches,
      credentialMatches,
      prefixMatches,
      canAttachState,
      cacheLiveMs,
      itersSinceCreate,
      refreshEveryN,
      decision: canReuseState ? 'reuse' : 'rebuild',
      contentsLen: Array.isArray(contents) ? contents.length : 0,
    },
  };
}

// Wait on a shared create while still honouring THIS caller's abort: the
// create itself is process-global and must outlive any single session, so
// the caller only stops waiting (resolving null) instead of cancelling the
// work for everyone.
export function awaitSharedCreate(task, signal) {
  if (!(signal instanceof AbortSignal))
    return task.then(
      (v) => v,
      () => null
    );
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(null);
      }
    );
  });
}

// cachedContents request body: system/tools/toolConfig plus the
// conversation prefix (everything except the latest user/tool input that
// the generateContent call will carry). cachedContents only accepts
// role='user' or 'model'; generateContent uses role='function' for
// tool_result turns, so that is collapsed to 'user' (functionResponse parts
// remain inside).
export function geminiCacheCreateBody({
  model,
  ttlSeconds,
  systemInstruction,
  geminiTools,
  toolConfig,
  contents,
  cachePrefixContentCount,
}) {
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
  if (toolConfig) body.toolConfig = toolConfig;
  if (cachePrefixContents.length) {
    body.contents = cachePrefixContents;
  }
  return body;
}

// Kill-switch: MIXDOG_GEMINI_EXPLICIT_CACHE=0 skips cachedContents
// entirely and relies on Gemini's implicit prefix caching (2.5+/3.x
// default, same 90% discount, no storage fee). A/B probe knob.
export function geminiExplicitCacheDisabled() {
  const explicitMode = String(process.env.MIXDOG_GEMINI_EXPLICIT_CACHE || '')
    .trim()
    .toLowerCase();
  return ['0', 'false', 'off', 'no'].includes(explicitMode);
}

// The prefix identity one cachedContents entry is keyed on: the content
// count + hash of the reusable prefix, and the process-global cache key.
export function geminiCachePrefixIdentity({ model, request, credentialFingerprint }) {
  const cachePrefixContentCount = _geminiCachePrefixCount(request.contents);
  const cachePrefixHash = _geminiCachePrefixHash({ model, ...request, prefixCount: cachePrefixContentCount });
  const globalCacheKey = _geminiGlobalCacheKey({
    credentialFingerprint,
    model,
    cachePrefixHash,
    cachePrefixContentCount,
  });
  return { prefix: { cachePrefixContentCount, cachePrefixHash }, globalCacheKey };
}

// A WAITER on an in-flight create never inherits the creation duty: it waits
// for exactly that create and, when that yields nothing, takes whatever
// another caller published for the same prefix meanwhile. Null means
// "proceed uncached this turn".
export async function joinInFlightGeminiCreate(inFlightCreate, { globalCacheKey, opts, currentIter, prefix }) {
  const created = await awaitSharedCreate(inFlightCreate, opts.signal);
  if (created?.cacheName) {
    traceGeminiCache(opts, currentIter, 'gemini_cache_global_wait_hit', {
      cacheName: created.cacheName,
      cacheTokenSize: created.cacheTokenSize,
      ...prefix,
    });
    return created;
  }
  // Failed or abandoned wait: another caller may still have published
  // a usable cache for this exact prefix meanwhile.
  return _getGeminiGlobalCache(globalCacheKey, Date.now());
}

export function geminiCacheEntry({
  cacheName,
  ttlSeconds,
  model,
  cacheTokenSize,
  cachePrefixContentCount,
  cachePrefixHash,
  credentialFingerprint,
}) {
  const createdAt = Date.now();
  return {
    cacheName,
    cacheCreatedAt: createdAt,
    cacheExpiresAt: createdAt + ttlSeconds * 1000,
    cacheModel: model,
    cacheTokenSize,
    cachePrefixContentCount,
    cachePrefixHash,
    cacheCredentialFingerprint: credentialFingerprint,
  };
}

// The server rejected the cache itself: forget it globally and on the
// session's provider state so the replay runs uncached.
export function dropRejectedGeminiCache(cachedContent, opts) {
  _invalidateGeminiCacheName(cachedContent);
  if (opts.providerState?.gemini?.cacheName === cachedContent) {
    const { gemini: _dropGemini, ...rest } = opts.providerState;
    opts.providerState = rest;
  }
}

// Pre-flight invariant: cachedContents.create rejects prefixes below
// the model-specific minimum. Skip the POST entirely when the estimate
// is under threshold so we don't spam 400 responses turn-after-turn.
export function geminiPrefixBelowMinimum({ model, systemInstruction, geminiTools, contents, opts, currentIter }) {
  const minTokens = _geminiCacheMinTokens(model);
  const estimatedTokens = _estimateGeminiCacheTokens(systemInstruction, geminiTools, contents);
  if (estimatedTokens >= minTokens) return false;
  traceGeminiCache(opts, currentIter, 'gemini_cache_skip', {
    reason: 'prefix_below_min',
    estimatedTokens,
    minTokens,
    model,
  });
  return true;
}
