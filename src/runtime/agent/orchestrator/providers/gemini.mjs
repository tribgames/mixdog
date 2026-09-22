import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAgentApiKey } from '../../../shared/provider-api-key.mjs';
import { canFallbackNonStreaming, withRetry } from './retry-classifier.mjs';
import { appendAgentTrace } from '../agent-trace.mjs';
import {
  PROVIDER_CACHE_CREATE_TIMEOUT_MS,
  PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS,
  providerTimeoutError,
  createTimeoutSignal,
  createPassthroughSignal,
} from '../stall-policy.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { GEMINI_FIRST_BYTE_TIMEOUT_MS, consumeGeminiRestStreamResponse } from './gemini-stream.mjs';
import { geminiTextLeakGuardFor, streamGeminiSdkAttempt } from './gemini-sdk-request.mjs';
import { emitGeminiToolCalls } from './gemini-schema.mjs';
import { buildGeminiRequest, geminiCachedRestBody } from './gemini-request-body.mjs';
import {
  geminiIncompleteError,
  geminiSendResult,
  parseGeminiCandidate,
  resolveGeminiUsage,
} from './gemini-response.mjs';
import {
  _getGeminiGlobalCache,
  _setGeminiGlobalCache,
  _geminiGlobalCacheNameIsLive,
  _attachGeminiCacheState,
  writeGeminiCacheTrace,
  geminiGlobalCacheCreates,
  GEMINI_GLOBAL_CACHE_DELETE_GRACE_MS,
  _geminiCredentialFingerprint,
  _invalidateGeminiCachesForCredentialFingerprint,
} from './gemini-cache.mjs';
import {
  awaitSharedCreate,
  dropRejectedGeminiCache,
  geminiCacheCreateBody,
  geminiCacheEntry,
  geminiCachePrefixIdentity,
  geminiCacheStateDecision,
  geminiCacheTunables,
  geminiExplicitCacheDisabled,
  geminiPrefixBelowMinimum,
  joinInFlightGeminiCreate,
  traceGeminiCache,
} from './gemini-cache-policy.mjs';
import {
  GEMINI_MODELS as MODELS,
  DEFAULT_GEMINI_MODEL as DEFAULT_MODEL,
  geminiModelCache as _modelCache,
  ensureLatestGeminiModel,
  fetchAndCacheGeminiModels,
} from './lib/gemini-model-catalog.mjs';

// De-dupes concurrent force-refreshes so they share one HTTP round-trip,
// mirroring anthropic-oauth's _modelRefreshInFlight.
let _modelRefreshInFlight = null;
const GEMINI_AVAILABILITY_TIMEOUT_MS = 1_000;

function geminiRestError(res, text, label) {
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {}
  const detail = payload?.error || payload || null;
  const err = new Error(`${label} ${res.status}: ${text.slice(0, 300)}`);
  err.status = res.status;
  err.httpStatus = res.status;
  err.headers = res.headers;
  // Initial-response failure: the request was rejected before any sample was
  // produced, so withRetry's typed rules decide: a known transient status
  // retries with bounded backoff (Retry-After honored), anything unknown or
  // deterministic surfaces as an error.
  err.initialResponseError = true;
  if (detail) {
    err.error = detail;
    err.data = payload;
    if (detail.status) err.geminiStatus = detail.status;
    if (Array.isArray(detail.details)) err.details = detail.details;
    const retryAfter = res.headers?.get?.('retry-after') ?? res.headers?.get?.('retry-after-ms');
    // RESOURCE_EXHAUSTED without a server retry window is deterministic
    // quota exhaustion. With Retry-After present, leave it request-local
    // so withRetry can honor the mandated delay.
    // A 429 RESOURCE_EXHAUSTED is a request-local rate limit even without
    // Retry-After (Google/LiteLLM retry). Do not stamp it as a quota code.
    if (detail.status && (retryAfter == null || retryAfter === '') && res.status !== 429) {
      err.code = detail.status;
    }
  }
  return err;
}

function isGeminiCachedContentError(err, cacheName) {
  const status = Number(err?.status || err?.httpStatus || 0);
  if (status !== 400 && status !== 404) return false;
  const text = `${err?.message || ''} ${JSON.stringify(err?.data || '')}`.toLowerCase();
  return (
    text.includes('cachedcontent') ||
    text.includes('cached content') ||
    (cacheName && text.includes(String(cacheName).toLowerCase()))
  );
}

function signalRequesting(opts) {
  try {
    opts.onStageChange?.('requesting');
  } catch {}
}

function geminiRetryLogger(opts, tag) {
  return ({ attempt, lastErr }) => {
    signalRequesting(opts);
    process.stderr.write(
      `${tag} retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}\n`
    );
  };
}

function geminiSendCallbacks(opts) {
  return {
    onStreamDelta: typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null,
    onToolCall: typeof opts.onToolCall === 'function' ? opts.onToolCall : null,
    onTextDelta: typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null,
  };
}

function throwIfGeminiAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('Gemini request aborted by session close');
}

export class GeminiProvider {
  // promptTokenCount is the total (cachedContentTokenCount is a subset), so
  // input already includes cache. See registry.mjs.
  static inputExcludesCache = false;
  name = 'gemini';
  genAI;
  config;
  _fetch;
  _preconnect;
  _createGenAI;
  _modelCache;

  constructor(config = {}) {
    this.config = config;
    this._fetch = typeof config.fetchFn === 'function' ? config.fetchFn : fetch;
    this._preconnect = typeof config.preconnectFn === 'function' ? config.preconnectFn : preconnect;
    this._createGenAI =
      typeof config.createGenAI === 'function' ? config.createGenAI : (apiKey) => new GoogleGenerativeAI(apiKey);
    this._modelCache = config.modelCache || _modelCache;
    const apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
    this.genAI = config.genAI || this._createGenAI(apiKey);
    // Warm a kept-alive socket to the Gemini REST API so the first cache/
    // generateContent request skips the cold TLS handshake. Best-effort.
    this._preconnect('https://generativelanguage.googleapis.com');
  }

  reloadApiKey() {
    try {
      const newKey = getAgentApiKey('gemini') || this.config?.apiKey || process.env.GEMINI_API_KEY;
      if (newKey) {
        // Keep this.config in sync so REST/cache paths (which read the
        // key via _getApiKey() → this.config.apiKey) don't keep using
        // the stale key after a rotation; genAI alone is not enough.
        this.config = { ...(this.config || {}), apiKey: newKey };
        this.genAI = this._createGenAI(newKey);
      }
      return newKey || '';
    } catch {
      /* best effort */
    }
    return '';
  }

  _getApiKey() {
    return this.config?.apiKey || process.env.GEMINI_API_KEY || '';
  }

  /**
   * Stream-death recovery: re-issue a dead stream ONCE as a
   * non-streaming generateContent call instead of failing the turn.
   * Deliberately narrow — canFallbackNonStreaming() clears only a
   * stream that exposed nothing, so rendered text is never duplicated and a
   * dispatched tool can never run twice. Returns the aggregated response, or
   * null when the failure is ineligible or the fallback itself fails.
   */
  async _recoverGeminiNonStreaming({ streamErr, signal, opts, model, generate }) {
    if (!canFallbackNonStreaming(streamErr, { signal })) return null;
    let aggregated;
    try {
      try {
        opts?.onStageChange?.('requesting');
      } catch {
        /* heartbeat best-effort */
      }
      aggregated = await generate(signal || undefined);
    } catch {
      return null;
    }
    if (!aggregated || !Array.isArray(aggregated.candidates) || aggregated.candidates.length === 0) {
      return null;
    }
    try {
      process.stderr.write(
        `[gemini] stream failed (${streamErr?.code || streamErr?.message || 'unknown'}); ` +
          `recovered via non-streaming generateContent\n`
      );
    } catch {
      /* best-effort */
    }
    try {
      appendAgentTrace({
        sessionId: opts?.sessionId || opts?.session?.id || null,
        iteration: Number.isFinite(Number(opts?.iteration)) ? Number(opts.iteration) : null,
        kind: 'transport_fallback',
        provider: 'gemini',
        model,
        transport: 'non-streaming',
        payload: {
          from: 'stream',
          to: 'non-streaming',
          reason: streamErr?.retryClassifier || streamErr?.code || streamErr?.message || 'stream_failed',
          error_code: streamErr?.code || null,
          error_http_status: Number(streamErr?.httpStatus || streamErr?.status || 0) || null,
          error_classifier: streamErr?.retryClassifier || streamErr?.midstreamClassifier || null,
        },
      });
    } catch {
      /* best-effort */
    }
    return aggregated;
  }

  // Explicit cachedContents stores the reusable system/tools/history prefix.
  // The default five-minute TTL bounds storage cost; periodic refresh includes
  // newer history. Ineligible prefixes and create failures can proceed uncached.
  async _ensureGeminiCache({
    apiKey,
    model,
    systemInstruction,
    geminiTools,
    toolConfig,
    contents,
    opts,
    skipExplicitCache = false,
  }) {
    if (skipExplicitCache) return null;
    if (Array.isArray(opts?.nativeTools) && opts.nativeTools.length) return null;
    if (geminiExplicitCacheDisabled()) return null;
    const state = opts.providerState?.gemini || null;
    const credentialFingerprint = _geminiCredentialFingerprint(apiKey);
    const now = Date.now();
    const currentIter = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : 1;
    const { refreshEveryN, ttlSeconds } = geminiCacheTunables();
    const request = { systemInstruction, geminiTools, toolConfig, contents };
    const decision = geminiCacheStateDecision({
      state,
      model,
      credentialFingerprint,
      request,
      currentIter,
      now,
      ttlSeconds,
      refreshEveryN,
    });
    traceGeminiCache(opts, currentIter, 'gemini_cache_decision', decision.trace);
    if (decision.canReuseState) {
      return state.cacheName;
    }
    if (!apiKey) return null;
    const { canAttachState } = decision;
    if (geminiPrefixBelowMinimum({ model, systemInstruction, geminiTools, contents, opts, currentIter })) {
      return canAttachState ? state.cacheName : null;
    }
    const { prefix, globalCacheKey } = geminiCachePrefixIdentity({ model, request, credentialFingerprint });
    const globalCache = _getGeminiGlobalCache(globalCacheKey, now);
    if (globalCache) {
      traceGeminiCache(opts, currentIter, 'gemini_cache_global_hit', {
        cacheName: globalCache.cacheName,
        cacheTokenSize: globalCache.cacheTokenSize,
        ...prefix,
      });
      _attachGeminiCacheState(opts, globalCache, currentIter);
      return globalCache.cacheName;
    }
    return this._joinOrCreateGeminiCache({
      apiKey,
      model,
      ttlSeconds,
      request,
      prefix,
      globalCacheKey,
      credentialFingerprint,
      state,
      canAttachState,
      opts,
      currentIter,
    });
  }

  // Strict singleflight: a WAITER never inherits the creation duty.
  //
  // The earlier bounded wait loop still herded. When the shared create
  // settles, its own cleanup removes the slot BEFORE the waiters resume,
  // so every waiter saw an empty slot; and a waiter that exhausted its
  // rounds fell through and created even while another create was in
  // flight — 8 waiters over repeated failures produced ~4 concurrent
  // cachedContents POSTs for one prefix.
  //
  // The rule is now unconditional: if a create is in flight we wait for
  // exactly that one, and if it does not yield a cache we proceed
  // UNCACHED (the cache is an optimization, and the next turn re-creates).
  // Only the caller that finds an EMPTY slot creates, and it publishes its
  // task synchronously, so at most one create per key can exist.
  async _joinOrCreateGeminiCache({ state, canAttachState, globalCacheKey, prefix, opts, currentIter, ...create }) {
    const inFlightCreate = geminiGlobalCacheCreates.get(globalCacheKey);
    if (inFlightCreate) {
      const joined = await joinInFlightGeminiCreate(inFlightCreate, { globalCacheKey, opts, currentIter, prefix });
      if (!joined) return canAttachState ? state.cacheName : null;
      _attachGeminiCacheState(opts, joined, currentIter);
      return joined.cacheName;
    }
    const created = await this._ownGeminiCacheCreate({
      ...create,
      prefix,
      globalCacheKey,
      priorCacheName: state?.cacheName || null,
      canAttachState,
      opts,
      currentIter,
    });
    // A failed refresh must not silently retain a cache that may have
    // expired or been evicted server-side. The caller proceeds uncached.
    if (!created?.cacheName) return null;
    _attachGeminiCacheState(opts, created, currentIter);
    return created.cacheName;
  }

  // Owner path of the singleflight: publish the create task for this key
  // synchronously, then await it with the same abort semantics as the
  // waiters — the shared create continues even if this caller stops waiting.
  async _ownGeminiCacheCreate(params) {
    const { globalCacheKey, opts } = params;
    const createTask = this._createGeminiCache(params);
    geminiGlobalCacheCreates.set(globalCacheKey, createTask);
    // Ownership is released by the TASK, never by the awaiting caller: a
    // caller that walks away (abort) must not retract a still-running create
    // from the map, or the next caller starts a duplicate POST for the same
    // prefix — the herd this singleflight exists to prevent.
    createTask.finally(() => {
      if (geminiGlobalCacheCreates.get(globalCacheKey) === createTask) {
        geminiGlobalCacheCreates.delete(globalCacheKey);
      }
    });
    return await awaitSharedCreate(createTask, opts.signal);
  }

  // POSTs the cachedContents.create request under the shared create budget.
  // Deliberately NOT merged with opts.signal. This create is the
  // process-global singleflight every concurrent session waits on, so
  // the FIRST caller's abort (stall-watchdog / closeSession) must not
  // cancel the cache every other session is waiting for — that is the
  // herd trigger. The 20s ceiling still bounds the preflight request,
  // and an aborting caller simply stops waiting (awaitSharedCreate).
  async _postGeminiCacheCreate(url, body, onFail) {
    const createTotal = createTimeoutSignal(
      null,
      PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS,
      'Gemini cachedContents.create total'
    );
    try {
      return await withRetry(
        async ({ signal: attemptSignal }) => {
          const res = await this._fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: attemptSignal,
            dispatcher: getLlmDispatcher(),
          });
          if (res.ok) return await res.json();
          const text = await res.text().catch(() => '');
          onFail(res, text);
          throw geminiRestError(res, text, 'Gemini cachedContents.create');
        },
        {
          signal: createTotal.signal,
          perAttemptTimeoutMs: PROVIDER_CACHE_CREATE_TIMEOUT_MS,
          perAttemptLabel: 'Gemini cachedContents.create',
        }
      );
    } finally {
      createTotal.cleanup();
    }
  }

  // The process-global cachedContents.create for one prefix. Never rejects:
  // a failure logs and resolves null so every waiter proceeds uncached.
  async _createGeminiCache({
    apiKey,
    model,
    ttlSeconds,
    request,
    prefix,
    globalCacheKey,
    credentialFingerprint,
    priorCacheName,
    canAttachState,
    opts,
    currentIter,
  }) {
    const { contents } = request;
    const { cachePrefixContentCount, cachePrefixHash } = prefix;
    const contentsLen = Array.isArray(contents) ? contents.length : 0;
    try {
      const body = geminiCacheCreateBody({ model, ttlSeconds, ...request, cachePrefixContentCount });
      const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${encodeURIComponent(apiKey)}`;
      const onFail = (res, text) =>
        traceGeminiCache(opts, currentIter, 'gemini_cache_create_fail', {
          status: res.status,
          body: text.slice(0, 500),
          contentsLen,
          cachePrefixContentCount,
          canAttachState,
        });
      const data = await this._postGeminiCacheCreate(url, body, onFail);
      const cacheName = data?.name || null;
      if (!cacheName) return null;
      const cacheTokenSize = Number(data?.usageMetadata?.totalTokenCount || 0) || 0;
      traceGeminiCache(opts, currentIter, 'gemini_cache_create_ok', {
        cacheName,
        cacheTokenSize,
        contentsLen,
        cachePrefixContentCount,
        cachePrefixHash,
      });
      if (priorCacheName && priorCacheName !== cacheName) this._scheduleGeminiCacheDelete(priorCacheName, apiKey);
      const entry = geminiCacheEntry({
        cacheName,
        ttlSeconds,
        model,
        cacheTokenSize,
        cachePrefixContentCount,
        cachePrefixHash,
        credentialFingerprint,
      });
      _setGeminiGlobalCache(globalCacheKey, entry);
      return entry;
    } catch (err) {
      process.stderr.write(`[gemini] cachedContents.create error: ${err?.message || err}\n`);
      return null;
    }
  }

  // Best-effort cleanup of the previous cache so storage cost only accrues
  // on the live revision. Fire-and-forget; TTL expiry covers any delete
  // failures.
  //
  // Cross-session race: `_geminiGlobalCacheNameIsLive` only checks whether
  // `priorCacheName` still appears as *some* entry's live cacheName in
  // `geminiGlobalCaches`. If another session sharing the same
  // globalCacheKey already overwrote that map slot with a newer cache (via
  // `_setGeminiGlobalCache`), the check sees "not live" for a name that a
  // *different* in-flight session still holds in its own
  // `providerState.gemini.cacheName` (captured earlier via
  // `_attachGeminiCacheState` and possibly already in-flight inside a
  // `generateContent`/`streamGenerateContent` call). Deleting immediately
  // can 404 that concurrent request server-side.
  //
  // Fix chosen: delay the DELETE by a grace period instead of adding
  // refcounting/last-used-session tracking. Rationale (minimal-change,
  // matches the module's "best-effort, TTL is the backstop" posture):
  //   - Any session that captured `priorCacheName` did so before this
  //     create finished, so its in-flight (or next) turn using that name
  //     almost certainly completes within a couple of minutes; a short
  //     grace window is enough for it to either finish or move on to a
  //     fresh cache attach.
  //   - The server-side cache TTL (5m by default) reclaims any cache we
  //     fail to delete, so skipping/delaying deletion is safe — it only
  //     costs a little extra storage for at most the grace window, never
  //     correctness.
  //   - Refcounting/session tracking would need to plumb per-session
  //     liveness into a shared map across concurrent providers, which is a
  //     much larger change for a purely cosmetic cost saving.
  // Liveness is re-checked right before firing the DELETE too, in case the
  // name became live again (e.g. re-attached) during the wait.
  _scheduleGeminiCacheDelete(priorCacheName, apiKey) {
    setTimeout(() => {
      if (_geminiGlobalCacheNameIsLive(priorCacheName)) return;
      const delUrl = `https://generativelanguage.googleapis.com/v1beta/${priorCacheName}?key=${encodeURIComponent(apiKey)}`;
      this._fetch(delUrl, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10_000),
        dispatcher: getLlmDispatcher(),
      }).catch(() => {
        /* TTL expiry will reclaim it */
      });
    }, GEMINI_GLOBAL_CACHE_DELETE_GRACE_MS).unref?.();
  }

  async send(messages, model, tools, sendOpts) {
    // Re-warm a kept-alive socket before the turn (TTL-gated no-op while
    // hot) so a post-idle request skips the cold TLS handshake.
    this._preconnect('https://generativelanguage.googleapis.com');
    try {
      return await this._doSend(messages, model, tools, sendOpts);
    } catch (err) {
      // Credential reload + reissue requires a TYPED 401: message text is
      // not evidence, and a typed 403 (permission/quota decision) is not
      // fixed by re-reading the key, so it surfaces unchanged.
      const status = Number(err?.status || err?.httpStatus || err?.response?.status || 0);
      if (status === 401) {
        if (err.liveTextEmitted === true || err.emittedToolCall === true || err.unsafeToRetry === true) {
          throw err;
        }
        process.stderr.write(`[provider] Auth error, re-reading provider authentication...\n`);
        const oldCredentialFingerprint = _geminiCredentialFingerprint(this._getApiKey());
        const newKey = this.reloadApiKey();
        _invalidateGeminiCachesForCredentialFingerprint(oldCredentialFingerprint);
        const geminiState = sendOpts?.providerState?.gemini;
        if (geminiState?.cacheName) {
          const { gemini: _dropGemini, ...rest } = sendOpts.providerState;
          sendOpts.providerState = rest;
        }
        if (!newKey) throw err;
        return await this._doSend(messages, model, tools, sendOpts);
      }
      throw err;
    }
  }

  async _doSend(messages, model, tools, sendOpts, internal = {}) {
    const opts = sendOpts || {};
    const signal = opts.signal || null;
    const callbacks = geminiSendCallbacks(opts);
    throwIfGeminiAborted(signal);

    const useModel = model || (await ensureLatestGeminiModel(this));
    const request = buildGeminiRequest(messages, useModel, tools, opts);
    signalRequesting(opts);

    // Explicit cachedContents (system + tools + prior-turn transcript).
    // Cache system/tools/toolConfig together. Google rejects repeating
    // those fields on generateContent when cachedContent is attached.
    // The contents payload captures the accumulated prefix; refresh every
    // N iterations so recent turns also enter the cached prefix.
    const cachedContent = await this._ensureGeminiCache({
      apiKey: this._getApiKey(),
      model: useModel,
      systemInstruction: request.systemInstruction,
      geminiTools: request.geminiTools,
      toolConfig: request.toolConfig,
      contents: request.contents,
      opts,
      skipExplicitCache: internal.skipExplicitCache === true,
    });
    signalRequesting(opts);

    const stream = { ...request, opts, signal, useModel, tools, callbacks, cachedContent };
    const outcome = cachedContent
      ? await this._streamCachedViaRest(stream, internal)
      : await this._streamViaSdk(stream);
    if (outcome.retryUncached) {
      return await this._doSend(messages, model, tools, opts, { skipExplicitCache: true });
    }
    const { response, textLeakGuard } = outcome;
    writeGeminiCacheTrace({
      opts,
      model: useModel,
      systemInstruction: request.systemInstruction,
      tools,
      contents: request.contents,
      usageMetadata: response.usageMetadata,
      cachedContent,
    });
    const parsed = parseGeminiCandidate(response, textLeakGuard);
    emitGeminiToolCalls(parsed.nativeToolCalls, callbacks.onToolCall);
    const incomplete = geminiIncompleteError(response, parsed, useModel);
    if (incomplete) throw incomplete;
    return geminiSendResult(parsed, useModel, opts, resolveGeminiUsage(response, opts, cachedContent, useModel));
  }

  // First byte bounded by GEMINI_FIRST_BYTE_TIMEOUT_MS; a non-OK status
  // becomes a typed REST error for withRetry's rules.
  async _openRestStream(url, body, attemptSignal) {
    const openFirstByte = createTimeoutSignal(attemptSignal, GEMINI_FIRST_BYTE_TIMEOUT_MS, 'Gemini REST first byte');
    let res;
    try {
      res = await this._fetch(url, {
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
      throw geminiRestError(res, text, 'Gemini REST streamGenerateContent');
    }
    return res;
  }

  async _restGenerateContent(useModel, apiKey, body, fallbackSignal) {
    const nonStreamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await this._fetch(nonStreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: fallbackSignal,
      dispatcher: getLlmDispatcher(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw geminiRestError(res, text, 'Gemini REST generateContent');
    }
    return await res.json();
  }

  // With cachedContent attached we bypass @google/generative-ai
  // (deprecated; v1beta v1.x docs explicitly forbid re-sending tools or
  // systemInstruction once a cache carries them, but the bundled SDK can't
  // actually issue a tool-less generateContent call). REST direct sends the
  // v1beta payload Google's new genai client uses, so the cache owns
  // system/tools and the runtime gets a clean cache hit. Resolves
  // { retryUncached: true } when the cache itself was rejected and the send
  // must be replayed without it.
  async _streamCachedViaRest(stream, internal) {
    const { opts, signal, useModel, contents, generationConfig, cachedContent, callbacks } = stream;
    const apiKey = this._getApiKey();
    const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    const body = geminiCachedRestBody({ opts, contents, cachedContent, generationConfig });
    // cachedContent owns tools + toolConfig. The API rejects a
    // generateContent request that repeats either field.
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
      return await withRetry(
        async ({ signal: attemptSignal }) => {
          signalRequesting(opts);
          const res = await this._openRestStream(genUrl, body, attemptSignal);
          const textLeakGuard = geminiTextLeakGuardFor(stream);
          const response = await consumeGeminiRestStreamResponse(res, {
            signal: attemptSignal,
            onStreamDelta: callbacks.onStreamDelta,
            onTextDelta: callbacks.onTextDelta,
            textLeakGuard,
            label: 'Gemini REST streamGenerateContent',
          });
          return { response, textLeakGuard };
        },
        { signal: totalSignal, onRetry: geminiRetryLogger(opts, '[gemini-rest]') }
      );
    } catch (err) {
      if (
        !internal.skipExplicitCache &&
        err?.unsafeToRetry !== true &&
        isGeminiCachedContentError(err, cachedContent)
      ) {
        dropRejectedGeminiCache(cachedContent, opts);
        return { retryUncached: true };
      }
      const recovered = await this._recoverGeminiNonStreaming({
        streamErr: err,
        signal: totalSignal,
        opts,
        model: useModel,
        generate: (fallbackSignal) => this._restGenerateContent(useModel, apiKey, body, fallbackSignal),
      });
      if (!recovered) throw err;
      return { response: recovered, textLeakGuard: null };
    } finally {
      restPassthrough.cleanup();
    }
  }

  async _streamViaSdk(stream) {
    const { opts, signal, useModel, systemInstruction, geminiTools, toolConfig, generationConfig, contents } = stream;
    const genModel = this.genAI.getGenerativeModel({
      model: useModel,
      systemInstruction,
      tools: geminiTools,
      ...(toolConfig ? { toolConfig } : {}),
      ...(generationConfig ? { generationConfig } : {}),
    });
    // Option A (mirror anthropic-oauth): pure pass-through of the external
    // signal, no absolute streaming total cap. See the REST path.
    const sdkPassthrough = createPassthroughSignal(signal);
    const totalSignal = sdkPassthrough.signal;
    try {
      return await withRetry(
        async ({ signal: attemptSignal }) => {
          signalRequesting(opts);
          return await streamGeminiSdkAttempt(genModel, stream, attemptSignal);
        },
        { signal: totalSignal, onRetry: geminiRetryLogger(opts, '[gemini]') }
      );
    } catch (err) {
      const recovered = await this._recoverGeminiNonStreaming({
        streamErr: err,
        signal: totalSignal,
        opts,
        model: useModel,
        generate: async (fallbackSignal) => {
          const result = await genModel.generateContent({ contents }, { signal: fallbackSignal });
          return result?.response ?? null;
        },
      });
      if (!recovered) throw err;
      return { response: recovered, textLeakGuard: null };
    } finally {
      sdkPassthrough.cleanup();
    }
  }

  async listModels() {
    const cached = this._modelCache.loadSync();
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
    return fetchAndCacheGeminiModels({
      apiKey,
      fetchFn: this._fetch,
      modelCache: this._modelCache,
      catalogForceRefresh: this.config.catalogForceRefresh,
    });
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
        if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
          process.stderr.write(`[gemini] catalog refreshed (${enriched.length} models)\n`);
        return enriched;
      } catch (err) {
        if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
          process.stderr.write(`[gemini] catalog refresh failed (${err.message})\n`);
        return null;
      } finally {
        _modelRefreshInFlight = null;
      }
    })();
    return _modelRefreshInFlight;
  }

  async isAvailable() {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(providerTimeoutError('Gemini availability probe', GEMINI_AVAILABILITY_TIMEOUT_MS));
    }, GEMINI_AVAILABILITY_TIMEOUT_MS);
    try {
      const model = this.genAI.getGenerativeModel({ model: DEFAULT_MODEL });
      const generation = Promise.resolve(model.generateContent('hi', { signal: controller.signal }));
      generation.catch(() => {});
      await Promise.race([
        generation,
        new Promise((_, reject) => {
          if (controller.signal.aborted) {
            reject(controller.signal.reason);
            return;
          }
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
