import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAgentApiKey } from '../../../shared/provider-api-key.mjs';
import { canFallbackNonStreaming, withRetry } from './retry-classifier.mjs';
import { traceAgentUsage, appendAgentTrace } from '../agent-trace.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { geminiThinkingConfig } from './gemini-thinking.mjs';
import {
  PROVIDER_CACHE_CREATE_TIMEOUT_MS,
  PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS,
  providerTimeoutError,
  createTimeoutSignal,
  createPassthroughSignal,
} from '../stall-policy.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import {
  GEMINI_FIRST_BYTE_TIMEOUT_MS,
  geminiTimeoutError,
  createGeminiTextLeakGuard,
  consumeGeminiRestStreamResponse,
  consumeGeminiSdkStream,
  stampGeminiRpcError,
} from './gemini-stream.mjs';
import {
  toGeminiTools,
  toGeminiNativeTools,
  toGeminiToolConfig,
  toGeminiContents,
  parseToolCalls,
  emitGeminiToolCalls,
  collectGeminiGroundingSources,
  parseGeminiTextPartMetadata,
} from './gemini-schema.mjs';
import {
  _estimateGeminiCacheTokens,
  _geminiCacheMinTokens,
  _geminiCachePrefixCount,
  _geminiCachePrefixContents,
  _geminiCachePrefixHash,
  _geminiGlobalCacheKey,
  _getGeminiGlobalCache,
  _setGeminiGlobalCache,
  _geminiGlobalCacheNameIsLive,
  _attachGeminiCacheState,
  _resolveGeminiCacheUsage,
  writeGeminiCacheTrace,
  geminiGlobalCacheCreates,
  GEMINI_GLOBAL_CACHE_DELETE_GRACE_MS,
  _geminiCredentialFingerprint,
  _invalidateGeminiCachesForCredentialFingerprint,
  _invalidateGeminiCacheName,
} from './gemini-cache.mjs';
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

function traceGeminiCache(opts, iteration, kind, payload) {
  try {
    appendAgentTrace({ sessionId: opts.sessionId || opts.session?.id || null, iteration, kind, payload });
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

// Explicit-cache tunables. The prefix is rebuilt every N iterations so
// recent turns also enter the cached prefix. Cache TTL (storage is billed
// per token-hour, so shorter is cheaper) defaults to 5m: agent tool loops
// re-request within seconds, and the refresh-every-4-iterations rebuild
// re-arms the TTL well before expiry. Long-idle sessions just pay one cold
// rebuild on resume.
function geminiCacheTunables() {
  const refreshEveryN =
    Number(process.env.MIXDOG_GEMINI_CACHE_REFRESH_EVERY) > 0
      ? Number(process.env.MIXDOG_GEMINI_CACHE_REFRESH_EVERY)
      : 4;
  const ttlSeconds =
    Number(process.env.MIXDOG_GEMINI_CACHE_TTL_SECONDS) > 0 ? Number(process.env.MIXDOG_GEMINI_CACHE_TTL_SECONDS) : 300;
  return { refreshEveryN, ttlSeconds };
}

// Whether the session's recorded cache can still be attached (live TTL,
// same model, credential and prefix) and whether it is fresh enough to
// reuse outright. Reuse requires remaining TTL headroom so we never attach a
// cache that expires mid-request — scaled with TTL (25%, clamped to
// 10s..6m); the old fixed 6-minute floor silently disabled reuse for any
// TTL <= 6m, forcing a full-price rebuild every turn.
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

function geminiCacheStateDecision({
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
function awaitSharedCreate(task, signal) {
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
function geminiCacheCreateBody({
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

// Request pieces shared by the cached REST path and the SDK path.
function buildGeminiRequest(messages, useModel, tools, opts) {
  // Gemini returns thought summaries only when the request asks for them.
  // Without this the reasoning channel stays empty for the whole turn and
  // the model's only visible output is the plain pre-tool text, so every
  // round reads as another preamble. On by default for every model; an
  // explicit opts.includeThoughts still wins.
  const thinkingConfig = geminiThinkingConfig(useModel, opts, { includeThoughts: true });
  const generationConfig = thinkingConfig ? { thinkingConfig } : undefined;
  const systemInstruction =
    messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n') || undefined;
  const chatMsgs = messages.filter((m) => m.role !== 'system');
  const contents = toGeminiContents(chatMsgs, useModel);
  if (!contents.length) throw new Error('No messages to send');

  const nativeGeminiTools = toGeminiNativeTools(opts.nativeTools);
  const functionGeminiTools = tools?.length ? [toGeminiTools(tools)] : [];
  const geminiTools =
    nativeGeminiTools.length || functionGeminiTools.length ? [...nativeGeminiTools, ...functionGeminiTools] : undefined;
  const toolConfig = functionGeminiTools.length ? toGeminiToolConfig(opts.toolChoice) : undefined;
  return { generationConfig, systemInstruction, contents, geminiTools, toolConfig };
}

function geminiTextLeakGuardFor({ tools, callbacks }) {
  return createGeminiTextLeakGuard({
    knownToolNames: tools?.map((t) => t.name).filter(Boolean) ?? [],
    onTextDelta: callbacks.onTextDelta,
    onToolCall: callbacks.onToolCall,
    onStreamDelta: callbacks.onStreamDelta,
  });
}

// Mirrors the REST branch's signal lifetime: the request controller stays
// linked to the parent (attemptSignal) for the FULL stream — connect AND
// body — so a parent / client / gateway abort after first byte still
// cancels the underlying SDK request (the SSE idle watchdog is off by
// default). The first-byte timer only bounds the connect phase and is
// cleared once the stream starts, so it can never kill a live,
// still-producing stream.
function linkSdkRequestController(attemptSignal) {
  const controller = new AbortController();
  let parentAbortListener = null;
  let firstByteTimer = null;
  const detachParent = () => {
    if (parentAbortListener && attemptSignal) {
      try {
        attemptSignal.removeEventListener('abort', parentAbortListener);
      } catch {}
      parentAbortListener = null;
    }
  };
  const clearConnectTimer = () => {
    if (firstByteTimer) {
      clearTimeout(firstByteTimer);
      firstByteTimer = null;
    }
  };
  if (attemptSignal) {
    if (attemptSignal.aborted) {
      try {
        controller.abort(attemptSignal.reason);
      } catch {}
    } else {
      parentAbortListener = () => {
        try {
          controller.abort(attemptSignal.reason);
        } catch {}
      };
      attemptSignal.addEventListener('abort', parentAbortListener, { once: true });
    }
  }
  firstByteTimer = setTimeout(() => {
    try {
      controller.abort(geminiTimeoutError('Gemini SDK first byte', GEMINI_FIRST_BYTE_TIMEOUT_MS));
    } catch {}
  }, GEMINI_FIRST_BYTE_TIMEOUT_MS);
  if (firstByteTimer.unref) firstByteTimer.unref();
  return { controller, detachParent, clearConnectTimer };
}

async function streamGeminiSdkAttempt(genModel, stream, attemptSignal) {
  const { contents, callbacks } = stream;
  const link = linkSdkRequestController(attemptSignal);
  const { controller } = link;
  try {
    let streamResult;
    try {
      streamResult = await genModel.generateContentStream({ contents }, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : err;
      }
      throw stampGeminiRpcError(err);
    }
    // First byte / headers received: drop the connect-phase timer but KEEP
    // the parent link attached so a later abort during streaming still
    // reaches the request.
    link.clearConnectTimer();
    const textLeakGuard = geminiTextLeakGuardFor(stream);
    const response = await consumeGeminiSdkStream(streamResult, {
      signal: attemptSignal,
      onStreamDelta: callbacks.onStreamDelta,
      onTextDelta: callbacks.onTextDelta,
      textLeakGuard,
      label: 'Gemini SDK streamGenerateContent',
      cancelGeneration: (reason) => {
        if (!controller.signal.aborted) controller.abort(reason);
      },
    });
    return { response, textLeakGuard };
  } finally {
    link.clearConnectTimer();
    link.detachParent();
  }
}

// Candidate text and tool calls after the text-leak guard: leaked
// (text-embedded) tool calls are appended to the native ones and empty the
// provider replay.
function parseGeminiCandidate(response, textLeakGuard) {
  const candidate = response.candidates?.[0] || null;
  const responseParts = candidate?.content?.parts ?? [];
  const textParts = responseParts.filter((p) => p?.thought !== true && 'text' in p);
  const rawContent = textParts.map((p) => ('text' in p ? p.text : '')).join('');
  const providerMetadata = parseGeminiTextPartMetadata(responseParts);
  const content = textLeakGuard?.enabled ? textLeakGuard.scrubAssistantText(rawContent) : rawContent;
  const leakedToolCalls = textLeakGuard?.getLeakedToolCalls() ?? [];
  const providerReplay = createProviderReplay('gemini', leakedToolCalls.length ? [] : responseParts);
  let nativeToolCalls = parseToolCalls(candidate?.content?.parts ?? []);
  if (textLeakGuard?.enabled) {
    nativeToolCalls = textLeakGuard.filterNativeToolCalls(nativeToolCalls);
  }
  let toolCalls = nativeToolCalls;
  if (leakedToolCalls.length) {
    toolCalls = toolCalls?.length ? [...toolCalls, ...leakedToolCalls] : leakedToolCalls;
  }
  return {
    candidate,
    content,
    providerMetadata,
    providerReplay,
    nativeToolCalls,
    toolCalls,
    citations: collectGeminiGroundingSources(candidate),
  };
}

// Inspect candidate.finishReason — Gemini reports terminal status here.
// Only STOP (and the legacy "FINISH_REASON_STOP") plus tool/function-call
// paths represent a fully delivered turn. MAX_TOKENS / SAFETY / RECITATION /
// OTHER all mean the candidate was cut off before the model finished, and
// surfacing the partial text as final would silently accept a truncated
// answer. Those become a typed provider-incomplete error so the loop can
// decide whether to retry, nudge, or surface to the user. Missing
// finishReason (still streaming / unknown) is left alone — existing success
// paths for genuinely complete responses keep working. Newly-added
// safety/image/tool/malformed reasons are incomplete by default instead of
// silently accepting partial or empty output.
function geminiIncompleteError(response, parsed, useModel) {
  const promptBlockReason = response.promptFeedback?.blockReason || null;
  const finishReason = parsed.candidate?.finishReason || (promptBlockReason ? `PROMPT_${promptBlockReason}` : null);
  const normalizedFinishReason = String(finishReason || '').replace(/^FINISH_REASON_/, '');
  if (!finishReason || normalizedFinishReason === 'STOP') return null;
  return Object.assign(new Error(`Gemini response incomplete: finishReason=${finishReason}`), {
    name: 'ProviderIncompleteError',
    code: 'PROVIDER_INCOMPLETE',
    providerIncomplete: true,
    finishReason,
    partialContent: parsed.content,
    partialToolCalls: parsed.toolCalls,
    partialProviderReplay: parsed.providerReplay,
    providerMetadata: parsed.providerMetadata,
    model: useModel,
    rawUsage: response.usageMetadata || null,
  });
}

// Normalized usage from usageMetadata, recorded to the usage trace. cachedTokens
// reuses the exact value the cache trace resolved (including the
// cachedFallback when cachedContentTokenCount / total_cached_tokens
// under-reports).
function resolveGeminiUsage(response, opts, cachedContent, useModel) {
  const um = response.usageMetadata || null;
  if (!um) return null;
  const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
  const { inputTokens, reportedCachedTokens, cachedFallbackTokens, cachedTokens, cacheTokenSource } =
    _resolveGeminiCacheUsage({
      usageMetadata: um,
      cachedContent,
      providerState: opts.providerState,
    });
  const outputTokens =
    (um.candidatesTokenCount || um.candidates_token_count || 0) +
    (um.thoughtsTokenCount || um.thoughts_token_count || 0);
  const resolvedUsage = {
    inputTokens,
    outputTokens,
    cachedTokens,
    // Gemini promptTokenCount is total (cachedContentTokenCount is a
    // subset). Alias the resolver's normalized total directly.
    promptTokens: inputTokens,
  };
  if (cachedContent && inputTokens > 0 && cachedTokens <= 0) {
    traceGeminiCache(opts, iteration, 'gemini_cache_anomaly', {
      reason: 'cached_content_attached_but_zero_cached_tokens',
      inputTokens,
      reportedCachedTokens,
      cachedFallbackTokens,
      cacheTokenSource,
      cacheName: opts.providerState?.gemini?.cacheName || null,
      cachePrefixContentCount: opts.providerState?.gemini?.cachePrefixContentCount ?? null,
    });
  }
  traceAgentUsage({
    sessionId: opts.sessionId || opts.session?.id || null,
    iteration,
    inputTokens: resolvedUsage.inputTokens,
    outputTokens: resolvedUsage.outputTokens,
    cachedTokens: resolvedUsage.cachedTokens,
    cacheWriteTokens: 0,
    promptTokens: resolvedUsage.promptTokens,
    model: useModel,
    modelDisplay: useModel,
    rawUsage: um,
    provider: 'gemini',
  });
  return resolvedUsage;
}

// --- Cache accounting/trace: extracted to gemini-cache.mjs ---
// --- Stream consumption/guards: extracted to gemini-stream.mjs ---
// --- Schema/content/tool-call mapping: extracted to gemini-schema.mjs ---

// Kill-switch: MIXDOG_GEMINI_EXPLICIT_CACHE=0 skips cachedContents
// entirely and relies on Gemini's implicit prefix caching (2.5+/3.x
// default, same 90% discount, no storage fee). A/B probe knob.
function geminiExplicitCacheDisabled() {
  const explicitMode = String(process.env.MIXDOG_GEMINI_EXPLICIT_CACHE || '')
    .trim()
    .toLowerCase();
  return ['0', 'false', 'off', 'no'].includes(explicitMode);
}

// The prefix identity one cachedContents entry is keyed on: the content
// count + hash of the reusable prefix, and the process-global cache key.
function geminiCachePrefixIdentity({ model, request, credentialFingerprint }) {
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
async function joinInFlightGeminiCreate(inFlightCreate, { globalCacheKey, opts, currentIter, prefix }) {
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

// Pre-flight invariant: cachedContents.create rejects prefixes below
// the model-specific minimum. Skip the POST entirely when the estimate
// is under threshold so we don't spam 400 responses turn-after-turn.
function geminiCacheEntry({
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

function geminiSendResult(parsed, useModel, opts, resolvedUsage) {
  return {
    content: parsed.content,
    model: useModel,
    toolCalls: parsed.toolCalls,
    citations: parsed.citations.length ? parsed.citations : undefined,
    providerReplay: parsed.providerReplay,
    providerMetadata: parsed.providerMetadata,
    providerState: opts.providerState,
    // Use the same normalized usage object traceAgentUsage recorded,
    // including snake_case SDK aliases and cache-create fallback.
    usage: resolvedUsage || undefined,
  };
}

// The generateContent body for a cached prefix. The cache carries the
// recorded prefix; every uncached tail turn is sent, not just the last
// message, so reused cachedContents preserve full conversation context
// between periodic refreshes.
function geminiCachedRestBody({ opts, contents, cachedContent, generationConfig }) {
  const cachedPrefixContentCount = Number.isFinite(Number(opts.providerState?.gemini?.cachePrefixContentCount))
    ? Math.max(0, Math.min(contents.length, Math.trunc(Number(opts.providerState.gemini.cachePrefixContentCount))))
    : 0;
  const deltaContents = contents.slice(cachedPrefixContentCount);
  return {
    contents: deltaContents.length ? deltaContents : contents.slice(-1),
    cachedContent,
    ...(generationConfig ? { generationConfig } : {}),
  };
}

// The server rejected the cache itself: forget it globally and on the
// session's provider state so the replay runs uncached.
function dropRejectedGeminiCache(cachedContent, opts) {
  _invalidateGeminiCacheName(cachedContent);
  if (opts.providerState?.gemini?.cacheName === cachedContent) {
    const { gemini: _dropGemini, ...rest } = opts.providerState;
    opts.providerState = rest;
  }
}

function geminiPrefixBelowMinimum({ model, systemInstruction, geminiTools, contents, opts, currentIter }) {
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

  // The process-global cachedContents.create for one prefix. Never rejects:
  // a failure logs and resolves null so every waiter proceeds uncached.
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
