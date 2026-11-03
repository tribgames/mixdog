import { reloadProviderApiKey, resolveProviderApiKey } from '../../../shared/provider-api-key.mjs';
import { noteAbandonedUsage } from '../../../shared/llm/usage-context.mjs';
import {
  canFallbackNonStreaming,
  emitProviderRetryStage,
  markProviderRecoveryExhausted,
  withRetry,
} from './retry-classifier.mjs';
import { noteErrorUsage } from './lib/note-error-usage.mjs';
import { traceNonStreamingFallback } from './lib/transport-fallback-trace.mjs';
import {
  PROVIDER_CACHE_CREATE_TIMEOUT_MS,
  PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS,
  providerTimeoutError,
  createTimeoutSignal,
  createPassthroughSignal,
} from '../stall-policy.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { GEMINI_FIRST_BYTE_TIMEOUT_MS, consumeGeminiRestStreamResponse } from './gemini-stream.mjs';
import {
  applyGeminiErrorContract,
  geminiContinuationUnsupportedError,
  geminiFinishErrorFields,
  geminiFinishReasonKind,
} from './gemini-error-contract.mjs';
import {
  GEMINI_MIDSTREAM_MAX_ATTEMPTS,
  geminiEndsWithFunctionResponse,
  geminiInvalidStreamReason,
  runGeminiStreamAttempts,
} from './gemini-retry-policy.mjs';
import { geminiTextLeakGuardFor } from './gemini-sdk-request.mjs';
import { emitGeminiToolCalls, parseGeminiTextPartMetadata } from './gemini-schema.mjs';
import { createGeminiReasoningRelay } from './gemini-reasoning-relay.mjs';
import { buildGeminiRequest, geminiCachedRestBody, geminiUncachedRestBody } from './gemini-request-body.mjs';
import { geminiRedirectTarget } from './gemini-model-redirect.mjs';
import {
  geminiIncompleteError,
  geminiSendResult,
  parseGeminiCandidate,
  resolveGeminiUsage,
  geminiFailureUsage,
  normalizeGeminiUsage,
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
  geminiExplicitCacheRefused,
  markGeminiExplicitCacheRefused,
} from './gemini-cache.mjs';
import {
  awaitSharedCreate,
  dropRejectedGeminiCache,
  geminiBareModelId,
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
const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com';
// Long decode: a streamed hop stops at 64K output tokens (32K non-streaming)
// with finishReason CONTINUATION. The 1M-token context bounds a turn to 16
// streamed hops (32 if every hop fell back to non-streaming); more is a loop.
const GEMINI_MAX_CONTINUATION_HOPS = 32;
// Redirected model ids already announced in this process.
const announcedRedirects = new Set();

// The key travels only in the documented header, never in a URL.
function geminiApiHeaders(apiKey, json = true) {
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), 'x-goog-api-key': apiKey };
}

const USAGE_COUNT_FIELDS = [
  'promptTokenCount',
  'cachedContentTokenCount',
  'candidatesTokenCount',
  'toolUsePromptTokenCount',
  'thoughtsTokenCount',
  'totalTokenCount',
];

// Usage of a long-decode turn: every hop is billed, so every count is the sum
// over the hops; initialPromptTokenCount keeps the first hop's prompt (the
// context size, which the summed prompt count overstates). Context occupancy
// is that prompt plus the summed generated tokens.
function sumGeminiHopUsage(hops) {
  const metas = hops.map((hop) => hop.usageMetadata).filter(Boolean);
  if (!metas.length) return undefined;
  const summed = { ...metas.at(-1) };
  for (const field of USAGE_COUNT_FIELDS) {
    if (metas.some((meta) => meta[field] !== undefined)) {
      summed[field] = metas.reduce((total, meta) => total + (Number(meta[field]) || 0), 0);
    }
  }
  summed.initialPromptTokenCount = Number(metas[0].promptTokenCount) || 0;
  summed.initialCachedContentTokenCount = Number(metas[0].cachedContentTokenCount) || 0;
  return summed;
}

// One response for a long-decode turn: the parts of every hop in order, the
// final hop's terminal state and the summed usage.
function mergeGeminiHops(hops) {
  if (hops.length === 1) return hops[0];
  const last = hops.at(-1);
  const lastCandidate = last.candidates?.[0] || {};
  const parts = hops.flatMap((hop) => hop.candidates?.[0]?.content?.parts || []);
  const merged = {
    ...last,
    candidates: [{ ...lastCandidate, content: { role: lastCandidate.content?.role || 'model', parts } }],
  };
  const promptFeedback = hops.find((hop) => hop.promptFeedback)?.promptFeedback;
  if (promptFeedback) merged.promptFeedback = promptFeedback;
  const usageMetadata = sumGeminiHopUsage(hops);
  if (usageMetadata) merged.usageMetadata = usageMetadata;
  return merged;
}

// A long-decode turn that fails on a later hop is still one turn: its failure
// fields cover every finished hop before the failing one. `shownText` is what
// those hops relayed live; once anything was shown the turn is past its replay
// boundary even if the failing hop itself showed nothing.
function carryGeminiHopsIntoFailure(err, hops, shownText) {
  if (!hops.length || !err || typeof err !== 'object') return err;
  try {
    const priorParts = hops.flatMap((hop) => hop.candidates?.[0]?.content?.parts || []);
    const priorText = priorParts
      .filter((part) => part?.thought !== true && typeof part?.text === 'string')
      .map((part) => part.text)
      .join('');
    const shown = shownText.length > 0;
    if (shown || typeof err.partialContent === 'string') {
      err.partialContent = `${shown ? shownText : priorText}${typeof err.partialContent === 'string' ? err.partialContent : ''}`;
    }
    const prior = parseGeminiTextPartMetadata(priorParts)?.gemini || {};
    const failing = err.providerMetadata?.gemini || {};
    const thoughtParts = [...(prior.thoughtParts || []), ...(failing.thoughtParts || [])];
    const textParts = [...(prior.textParts || []), ...(failing.textParts || [])];
    if (thoughtParts.length || textParts.length) {
      err.providerMetadata = {
        ...err.providerMetadata,
        gemini: {
          ...failing,
          ...(thoughtParts.length ? { thoughtParts } : {}),
          ...(textParts.length ? { textParts } : {}),
        },
      };
    }
    if (shown) {
      err.liveTextEmitted = true;
      err.unsafeToRetry = true;
      if (err.code === 'EGEMINITIMEOUT' || err.code === 'TRUNCATED_STREAM' || err.truncatedStream === true) {
        err.streamStalled = true;
        if (err.pendingToolUse === undefined) err.pendingToolUse = false;
      }
    }
  } catch {
    /* best-effort */
  }
  return err;
}

function continuationTokenOf(response) {
  const candidate = response?.candidates?.[0];
  if (geminiFinishReasonKind(candidate?.finishReason) !== 'continuation') return null;
  return typeof candidate?.continuationToken === 'string' && candidate.continuationToken
    ? candidate.continuationToken
    : null;
}

export function geminiRestError(res, text, label) {
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
    const details = detail.details ?? detail.errorDetails;
    if (Array.isArray(details)) err.details = details;
    // Typed contract (code/retryAfterMs/resetAt/quotaScope); the core decides
    // whether a 429 RESOURCE_EXHAUSTED is request-local or a quota refusal.
    applyGeminiErrorContract(err, { details, googleStatus: detail.status, message: detail.message });
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
  return ({ attempt, maxAttempts, lastErr, delayMs }) => {
    emitProviderRetryStage(opts.onStageChange, { attempt: attempt + 1, maxAttempts, lastErr, delayMs });
    process.stderr.write(
      `${tag} retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}\n`
    );
  };
}

function geminiSendCallbacks(opts) {
  const reasoning = createGeminiReasoningRelay(opts);
  return {
    onStreamDelta: typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null,
    onToolCall: typeof opts.onToolCall === 'function' ? opts.onToolCall : null,
    onTextDelta: typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null,
    onReasoningDelta: reasoning.onReasoningDelta,
    // Thinking already shown by a dead or discarded attempt.
    retractReasoning: reasoning.retract,
    commitReasoning: reasoning.commit,
  };
}

function throwIfGeminiAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('Gemini request aborted by session close');
}

export class GeminiProvider {
  // Takes a PDF as a native document block (decided by this adapter's wire protocol).
  nativePdf = true;
  // promptTokenCount is the total (cachedContentTokenCount is a subset), so
  // input already includes cache. See registry.mjs.
  static inputExcludesCache = false;
  name = 'gemini';
  // The two-phase ladder (gemini-retry-policy.mjs) is the whole recovery:
  // a spent ladder surfaces instead of parking on loop recovery cycles.
  retryPolicy = Object.freeze({ recoveryCycles: false });
  config;
  _fetch;
  _preconnect;
  _now;
  _modelCache;

  constructor(config = {}) {
    this.config = config;
    this._fetch = typeof config.fetchFn === 'function' ? config.fetchFn : fetch;
    this._preconnect = typeof config.preconnectFn === 'function' ? config.preconnectFn : preconnect;
    this._now = typeof config.nowFn === 'function' ? config.nowFn : Date.now;
    this._modelCache = config.modelCache || _modelCache;
    // Warm a kept-alive socket to the Gemini REST API so the first cache/
    // generateContent request skips the cold TLS handshake. Best-effort.
    this._preconnect(GEMINI_API_ORIGIN);
  }

  reloadApiKey() {
    try {
      const newKey = reloadProviderApiKey('gemini', this.config);
      // Keep this.config in sync so REST/cache paths don't keep using the
      // stale key after a rotation.
      if (newKey) this.config = { ...(this.config || {}), apiKey: newKey };
      return newKey || '';
    } catch {
      /* best effort */
    }
    return '';
  }

  _getApiKey() {
    return resolveProviderApiKey('gemini', this.config);
  }

  // The direct Gemini API (not a gateway engine built on this adapter).
  get _isDirectGeminiApi() {
    return this.name === 'gemini';
  }

  // The id the Gemini API serves `model` as today. A redirected id resolves
  // to its target for the whole request (wire id, settings, cache, cost),
  // announced once per process.
  _servedModel(model, opts) {
    if (!this._isDirectGeminiApi) return model;
    const target = geminiRedirectTarget(model, this._now());
    if (!target) return model;
    const requested = geminiBareModelId(model);
    if (!announcedRedirects.has(requested)) {
      announcedRedirects.add(requested);
      const message = `${requested} is now served by Google as ${target} (redirect effective 2026-12-01; billed at ${target} rates)`;
      try {
        opts.onStageChange?.('notice', { tone: 'warn', message });
      } catch {
        /* display-only */
      }
      try {
        process.stderr.write(`[gemini] ${message}\n`);
      } catch {
        /* best-effort */
      }
    }
    return target;
  }

  /**
   * Stream-death recovery: re-issue a dead stream ONCE as a
   * non-streaming generateContent call instead of failing the turn.
   * Deliberately narrow — canFallbackNonStreaming() clears only a
   * stream that exposed nothing, so rendered text is never duplicated and a
   * dispatched tool can never run twice. Returns the aggregated response, or
   * null when the failure is ineligible or the fallback itself fails.
   */
  async _recoverGeminiNonStreaming({ streamErr, signal, opts, model, generate, retractReasoning }) {
    if (!canFallbackNonStreaming(streamErr, { signal })) return null;
    noteErrorUsage(streamErr);
    let aggregated;
    try {
      retractReasoning?.();
      signalRequesting(opts);
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
    traceNonStreamingFallback({ provider: 'gemini', model, opts, streamErr });
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
    // A request forked from a shared prefix (/btw: opts.sharedCachePrefixCount)
    // only reads the session's live cache. Creating or refreshing one would
    // store the fork's own suffix (the appended reply and question).
    if (opts.sharedCachePrefixCount) return decision.canAttachState ? state.cacheName : null;
    if (!apiKey || geminiExplicitCacheRefused(model)) return null;
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
  async _postGeminiCacheCreate(url, apiKey, body, onFail) {
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
            headers: geminiApiHeaders(apiKey),
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
      const url = `${GEMINI_API_ORIGIN}/v1beta/cachedContents`;
      const onFail = (res, text) =>
        traceGeminiCache(opts, currentIter, 'gemini_cache_create_fail', {
          status: res.status,
          body: text.slice(0, 500),
          contentsLen,
          cachePrefixContentCount,
          canAttachState,
        });
      const data = await this._postGeminiCacheCreate(url, apiKey, body, onFail);
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
      markGeminiExplicitCacheRefused(model, err);
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
      const delUrl = `${GEMINI_API_ORIGIN}/v1beta/${priorCacheName}`;
      this._fetch(delUrl, {
        method: 'DELETE',
        headers: geminiApiHeaders(apiKey, false),
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
    this._preconnect(GEMINI_API_ORIGIN);
    try {
      return await this._doSend(messages, model, tools, sendOpts);
    } catch (err) {
      noteErrorUsage(err);
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

  // The output limit the live model roster declared for this model, or null.
  _rosterOutputLimit(model) {
    try {
      const id = geminiBareModelId(model);
      return this._modelCache.loadSync()?.find?.((entry) => entry?.id === id)?.outputTokens ?? null;
    } catch {
      return null;
    }
  }

  async _doSend(messages, model, tools, sendOpts, internal = {}) {
    const opts = sendOpts || {};
    const signal = opts.signal || null;
    const callbacks = geminiSendCallbacks(opts);
    throwIfGeminiAborted(signal);

    const useModel = this._servedModel(model || (await ensureLatestGeminiModel(this)), opts);
    const request = buildGeminiRequest(messages, useModel, tools, opts, this._rosterOutputLimit(useModel), {
      omitIgnoredSampling: this._isDirectGeminiApi,
    });
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

    const stream = { ...request, opts, signal, useModel, tools, callbacks, cachedContent, continuationToken: null };
    const hops = [];
    let shownText = '';
    let outcome;
    try {
      for (;;) {
        outcome = cachedContent ? await this._streamViaRest(stream, internal) : await this._streamViaSdk(stream);
        if (outcome.retryUncached) {
          return await this._doSend(messages, model, tools, opts, { skipExplicitCache: true });
        }
        hops.push(outcome.response);
        shownText += outcome.textLeakGuard?.getRelayedText?.() || '';
        const token = this._isDirectGeminiApi ? continuationTokenOf(outcome.response) : null;
        if (!token) break;
        if (hops.length >= GEMINI_MAX_CONTINUATION_HOPS) {
          throw Object.assign(
            new Error(`Gemini long decode exceeded ${GEMINI_MAX_CONTINUATION_HOPS} continuation hops`),
            { name: 'GeminiContinuationLimitError', code: 'CONTINUATION_LIMIT', continuationToken: token }
          );
        }
        // Long decode: resend the same request with the hop's token; the
        // shown hop is part of the turn, never retracted by a later retry.
        throwIfGeminiAborted(signal);
        callbacks.commitReasoning();
        stream.continuationToken = token;
        signalRequesting(opts);
      }
    } catch (err) {
      // Finished hops were billed even though the turn failed.
      for (const hop of hops) {
        if (hop?.usageMetadata) {
          noteAbandonedUsage(normalizeGeminiUsage(hop.usageMetadata, opts, cachedContent).resolvedUsage, useModel);
        }
      }
      throw carryGeminiHopsIntoFailure(err, hops, shownText);
    }
    const response = mergeGeminiHops(hops);
    const { textLeakGuard } = outcome;
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
    const usage = resolveGeminiUsage(response, opts, cachedContent, useModel);
    // Terminal status first: a failed candidate's calls are never dispatched.
    const incomplete = geminiIncompleteError(response, parsed, useModel, usage);
    if (incomplete) {
      Object.assign(incomplete, geminiFinishErrorFields(response));
      if (geminiFinishReasonKind(incomplete.finishReason) === 'continuation') {
        // Direct Gemini only: surface the typed result with its token.
        throw geminiContinuationUnsupportedError(incomplete, response);
      }
      // A malformed / unexpected tool call that survived the stream ladder
      // (4 attempts) is spent; the loop must not multiply that budget.
      if (
        geminiInvalidStreamReason(response, textLeakGuard, {
          afterToolResult: geminiEndsWithFunctionResponse(request.contents),
        })
      ) {
        markProviderRecoveryExhausted(incomplete, { owner: 'gemini-stream', attempts: GEMINI_MIDSTREAM_MAX_ATTEMPTS });
      }
      throw incomplete;
    }
    textLeakGuard?.releaseDeferredToolCalls?.();
    emitGeminiToolCalls(parsed.nativeToolCalls, callbacks.onToolCall);
    return geminiSendResult(parsed, useModel, opts, usage);
  }

  // First byte bounded by GEMINI_FIRST_BYTE_TIMEOUT_MS; a non-OK status
  // becomes a typed REST error for withRetry's rules.
  async _openRestStream(url, apiKey, body, attemptSignal) {
    const openFirstByte = createTimeoutSignal(attemptSignal, GEMINI_FIRST_BYTE_TIMEOUT_MS, 'Gemini REST first byte');
    let res;
    try {
      res = await this._fetch(url, {
        method: 'POST',
        headers: geminiApiHeaders(apiKey),
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
    const nonStreamUrl = `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(geminiBareModelId(useModel))}:generateContent`;
    const res = await this._fetch(nonStreamUrl, {
      method: 'POST',
      headers: geminiApiHeaders(apiKey),
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

  // The one Gemini wire: streamGenerateContent over SSE. With a cachedContents
  // prefix attached the body carries only the uncached tail (the cache owns
  // system/tools/toolConfig, and the API rejects a request repeating them);
  // without one it carries the whole request. A long-decode hop resends the
  // same body plus its continuation token. Resolves { retryUncached: true }
  // when the cache itself was rejected and the send must be replayed without
  // it.
  async _streamViaRest(stream, internal = {}) {
    const { opts, signal, useModel, contents, cachedContent, callbacks, continuationToken } = stream;
    const apiKey = this._getApiKey();
    const genUrl = `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(geminiBareModelId(useModel))}:streamGenerateContent?alt=sse`;
    const body = {
      ...(cachedContent ? geminiCachedRestBody(stream) : geminiUncachedRestBody(stream)),
      ...(continuationToken ? { continuationToken } : {}),
    };
    const label = cachedContent ? '[gemini-rest]' : '[gemini]';
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
      const afterToolResult = geminiEndsWithFunctionResponse(contents);
      return await runGeminiStreamAttempts({
        signal: totalSignal,
        sleepFn: this.config?.sleepFn,
        onRetry: geminiRetryLogger(opts, label),
        afterToolResult,
        failureUsage: geminiFailureUsage(opts, cachedContent, useModel),
        run: async ({ signal: attemptSignal, connected }) => {
          callbacks.retractReasoning();
          signalRequesting(opts);
          const res = await this._openRestStream(genUrl, apiKey, body, attemptSignal);
          connected();
          const textLeakGuard = geminiTextLeakGuardFor(stream);
          const response = await consumeGeminiRestStreamResponse(res, {
            signal: attemptSignal,
            onStreamDelta: callbacks.onStreamDelta,
            onTextDelta: callbacks.onTextDelta,
            onReasoningDelta: callbacks.onReasoningDelta,
            textLeakGuard,
            label: 'Gemini REST streamGenerateContent',
            failureUsage: geminiFailureUsage(opts, cachedContent, useModel),
          });
          return { response, textLeakGuard };
        },
      });
    } catch (err) {
      if (
        cachedContent &&
        !internal.skipExplicitCache &&
        !continuationToken &&
        err?.unsafeToRetry !== true &&
        isGeminiCachedContentError(err, cachedContent)
      ) {
        noteErrorUsage(err);
        dropRejectedGeminiCache(cachedContent, opts);
        return { retryUncached: true };
      }
      const recovered = await this._recoverGeminiNonStreaming({
        streamErr: err,
        signal: totalSignal,
        opts,
        model: useModel,
        generate: (fallbackSignal) => this._restGenerateContent(useModel, apiKey, body, fallbackSignal),
        retractReasoning: callbacks.retractReasoning,
      });
      if (!recovered) throw err;
      return { response: recovered, textLeakGuard: null };
    } finally {
      restPassthrough.cleanup();
    }
  }

  // Transport for a send without a cached prefix. Gateway engines built on
  // this adapter (OpenCode Go) override it; the name predates the removal of
  // the legacy SDK, which no longer exists on any path.
  async _streamViaSdk(stream) {
    return this._streamViaRest(stream);
  }

  async listModels() {
    const cached = this._modelCache.loadSync();
    if (cached) return cached;
    // Dynamic lookup via Gemini v1beta /models. Requires API key.
    const apiKey = this._getApiKey();
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
  // Resolves null when there is no key; fetch/normalize failures reject so
  // callers (registry refresh) report them.
  async _refreshModelCache() {
    if (_modelRefreshInFlight) return _modelRefreshInFlight;
    const refresh = (async () => {
      const apiKey = this._getApiKey();
      if (!apiKey) return null; // no key — nothing to refresh
      const enriched = await this._fetchAndCacheModels(apiKey);
      if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
        process.stderr.write(`[gemini] catalog refreshed (${enriched.length} models)\n`);
      return enriched;
    })();
    // Clear only after the shared promise is published: a refresh that settles
    // synchronously (no key) must not leave its settled promise memoized.
    _modelRefreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (_modelRefreshInFlight === refresh) _modelRefreshInFlight = null;
    }
  }

  async isAvailable() {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(providerTimeoutError('Gemini availability probe', GEMINI_AVAILABILITY_TIMEOUT_MS));
    }, GEMINI_AVAILABILITY_TIMEOUT_MS);
    try {
      const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
      const generation = this._restGenerateContent(DEFAULT_MODEL, this._getApiKey(), body, controller.signal);
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
