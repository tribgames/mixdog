/**
 * OpenAI ChatGPT OAuth subscription provider.
 *
 * Dispatches over the WebSocket upgrade of chatgpt.com/backend-api/codex/
 * responses (responses_websockets=2026-02-06 beta). Authenticates via PKCE
 * OAuth using Mixdog-owned token storage.
 *
 * Responsibilities are split across modules and this file is the facade that
 * re-exports them for existing importers:
 *   - openai-oauth-tokens.mjs   credential store, refresh, login wiring
 *   - openai-oauth-catalog.mjs  model catalog, its cache and lookups
 *   - openai-oauth-ws.mjs / openai-oauth-http-sse.mjs  streaming + framing
 *   - openai-startup-prewarm.mjs  startup prewarm requests + reservations
 * What stays here is transport selection: WS dispatch, driving the session
 * startup prewarm, auth/catalog recovery retries, and the HTTP/SSE fallback
 * taken when WebSocket transport is unhealthy.
 */
import { createHash } from 'node:crypto';

import { sendViaWebSocket } from './openai-oauth-ws.mjs';
import { acquireWebSocket, releaseWebSocket, hasPooledWebSocket } from './openai-ws-pool.mjs';
import {
  armStartupPrewarmReservation,
  buildStartupPrewarmSendOpts,
  claimStartupPrewarmReservation,
  codexStartupPrefixHash,
  hasStartupPrewarmReservation,
  resolveStartupPrewarmTarget,
  retireStartupPrewarmRecord,
  stampStartupPrewarmReservation,
  traceStartupPrewarm,
} from './openai-startup-prewarm.mjs';
import { createOpenAiOAuthDispatch, isOpenAiOAuthHandshakeHttpFallback } from './openai-oauth-dispatch.mjs';
import { _codexWsCompatibilityHeaders } from './openai-codex-metadata.mjs';
import { resolveOpenAiTransportPolicy } from './openai-transport-policy.mjs';
import {
  buildStableProviderPromptCacheKey,
  resolveProviderPromptCacheLane,
  resolveProviderCacheKey,
} from '../agent-runtime/cache-strategy.mjs';
import { preconnect } from '../../../shared/llm/http-agent.mjs';
import { sendViaHttpSse, _envFlag } from './openai-oauth-http-sse.mjs';
import { warmCodexClientVersion } from './codex-client-meta.mjs';
import { CODEX_BACKEND_ORIGIN } from './openai-codex-endpoints.mjs';
import { loadTokens, refreshStoredTokens, tokensFileMtimeMs, TOKEN_REFRESH_SKEW_MS } from './openai-oauth-tokens.mjs';
import {
  codexModelSupportsServiceTier,
  ensureLatestCodexModel,
  findCachedCodexModel,
  listCodexModels,
  refreshCodexCatalog,
} from './openai-oauth-catalog.mjs';
import { _displayCodexModel } from './openai-codex-model.mjs';
export { _displayCodexModel };

// Public test/integration entry retained alongside the transport module export.
export { sendViaHttpSse };
import { buildRequestBody } from './openai-responses-payload.mjs';
export {
  buildCodexStartupPrewarmBody,
  buildRequestBody,
  convertMessagesToResponsesInput,
  toOpenAIResponsesTool,
  _convertMessagesToResponsesInputForTest,
} from './openai-responses-payload.mjs';
// Endpoint identity is shared with the transports and the catalog query; the
// re-export keeps openai-oauth-http-sse.mjs and the media adapters resolving
// through this facade.
//
// Those endpoints are version-gated: the OAuth backend rejects requests
// without a client version, gates new model exposures on it (gpt-5.6-* require
// >= 0.144.0), and rejects turns on gated models when the reported version is
// below the model's minimal_client_version. Resolution is unified in
// codex-client-meta.mjs (live npm @openai/codex latest, 24h in-process cache,
// offline floor) so the catalog query and the transport headers can never
// disagree.
export { CODEX_OAUTH_ORIGINATOR, CODEX_RESPONSES_URL } from './openai-codex-endpoints.mjs';
// Credential + catalog facade: /providers, the media lanes and
// openai-responses-payload.mjs keep importing these from here.
export {
  describeOpenAIOAuthCredentials,
  forgetOpenAIOAuthCredentials,
  hasOpenAIOAuthCredentials,
  beginOAuthLogin,
  loginOAuth,
} from './openai-oauth-tokens.mjs';
export { codexModelSupportsServiceTier } from './openai-oauth-catalog.mjs';

export class OpenAIOAuthProvider {
  // OpenAI input_tokens already INCLUDES cached_tokens (cached is a subset),
  // so input alone is the context footprint. See registry.mjs.
  static inputExcludesCache = false;
  name = 'openai-oauth';
  tokens = null;
  _refreshFallbackUntil = 0;
  // Sticky transport fallback is isolated by the WS pool/session key. A
  // provider instance is shared across concurrent sessions, so singleton
  // booleans here would let one unhealthy session force every other session
  // onto HTTP.
  _httpFallbackUntilByPoolKey = new Map();
  _startupPrewarmByPoolKey = new Map();
  _startupPrewarmReadyByPoolKey = new Map();
  config;
  constructor(config) {
    this.config = config || {};
    this.tokens = loadTokens();
    // Warm a kept-alive socket to the OAuth responses API so the first
    // request skips the cold TLS handshake. Best-effort; never throws.
    preconnect(CODEX_BACKEND_ORIGIN);
  }
  getCachedModelInfo(model) {
    return findCachedCodexModel(model);
  }
  async ensureAuth({ forceRefresh = false, reason = 'preemptive' } = {}) {
    if (!this.tokens) this.tokens = loadTokens();
    if (!this.tokens) throw new Error('OpenAI OAuth not authenticated. Open /providers in mixdog to sign in.');
    // Pick up Mixdog-owned token updates the moment the auth file is
    // rewritten — without this, a fresh login is ignored until the in-memory
    // token hits its expiry skew.
    const diskMtime = tokensFileMtimeMs();
    // Watermark guards termination: if the rewritten file is temporarily
    // unreadable/partial, record the scanned mtime so this check can't
    // re-fire on every ensureAuth().
    if (diskMtime > 0 && diskMtime > (this._lastDiskScan || 0) && diskMtime > (this.tokens._mtimeMs || 0)) {
      const fresh = loadTokens();
      if (fresh?.access_token) {
        this.tokens = fresh;
        this._refreshFallbackUntil = 0;
        process.stderr.write(`[openai-oauth] Reloaded tokens from disk (mtime change)\n`);
      }
      this._lastDiskScan = diskMtime;
    }
    if (!forceRefresh && this._refreshFallbackUntil > Date.now() && this.tokens?.access_token) {
      return this.tokens;
    }
    const expiring = this.tokens.expires_at ? this.tokens.expires_at < Date.now() + TOKEN_REFRESH_SKEW_MS : false;
    if (forceRefresh || expiring) {
      this._refreshFallbackUntil = 0;
      this.tokens = await this._refreshTokens({ force: forceRefresh, reason });
    }
    return this.tokens;
  }

  async _refreshTokens({ force = false, reason = 'preemptive' } = {}) {
    const { tokens, coastOnCurrent } = await refreshStoredTokens({
      current: this.tokens,
      force,
      reason,
    });
    // The store could not refresh and handed back a still-valid token:
    // hold off re-attempting until the expiry skew so every turn in that
    // window does not re-run the failing exchange.
    if (coastOnCurrent) this._refreshFallbackUntil = Date.now() + TOKEN_REFRESH_SKEW_MS;
    this.tokens = tokens;
    return this.tokens;
  }

  /**
   * Consume this session's startup prewarm reservation, if it fits the turn.
   * Reservation lifecycle lives in openai-startup-prewarm.mjs; this stays a
   * provider method because the turn path and the transport tests address
   * reservations through the provider that holds the registry.
   */
  _claimStartupPrewarmHandle(identity) {
    return claimStartupPrewarmReservation(this._startupPrewarmReadyByPoolKey, identity);
  }

  async send(messages, model, tools, sendOpts) {
    // Re-warm a kept-alive socket before the turn (TTL-gated no-op while
    // hot). After an idle gap it re-opens one in parallel with auth/body
    // build so the HTTP/SSE path skips the cold TLS handshake.
    preconnect(CODEX_BACKEND_ORIGIN);
    const opts = sendOpts || {};
    const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
    const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
    const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
    const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
    const externalSignal = opts.signal || null;
    const _sendSessionId = opts.sessionId || '(none)';
    const _sendAgent = opts.agent || '(none)';
    if (process.env.MIXDOG_DEBUG_AGENT) {
      process.stderr.write(
        `[agent-trace] auth-start sessionHash=${createHash('sha256').update(String(_sendSessionId)).digest('hex').slice(0, 8)} agent=${_sendAgent} expiringInMs=${this.tokens?.expires_at ? this.tokens.expires_at - Date.now() : 'unknown'}\n`
      );
    }
    // Build request body in parallel with auth resolution. ensureAuth is
    // a no-op fast-path on cached tokens, but a refresh round-trip can
    // take 300ms+; the body build (message serialisation) overlaps cleanly.
    const useModel = model || (await ensureLatestCodexModel(() => this._refreshModelCache()));
    const promptCacheLane = resolveProviderPromptCacheLane('openai-oauth', opts, this.config);
    const bodyOpts = {
      ...sendOpts,
      promptCacheLane,
    };
    // Escape hatch for callers (e.g. the web-search backend) that ship a
    // fully-formed request body with a server-side tool shape buildRequestBody
    // can't express. Routing through send() still gives them the 401/403
    // force-refresh retry + HTTP/SSE fallback instead of a hard fail.
    const _bodyP = opts._prebuiltBody
      ? Promise.resolve(opts._prebuiltBody)
      : Promise.resolve().then(() => buildRequestBody(messages, useModel, tools, bodyOpts));
    const _authP = this.ensureAuth();
    // Cold-start guard: the WS/SSE transports read the client version via
    // the SYNC accessor for the `version` header + User-Agent. Await the
    // shared resolver (parallel with auth; never rejects; no-op once
    // cached) so the first turn after boot doesn't report the offline
    // floor and trip the backend's minimal_client_version gate.
    const _verP = warmCodexClientVersion();
    // Credential holder: the 401 recovery below replaces the token and both
    // dispatches must see the replacement.
    const authState = { tokens: await _authP };
    await _verP;
    const body = await _bodyP;
    // poolKey != cacheKey by design. poolKey isolates socket/delta state per
    // session. cacheKey is body.prompt_cache_key and affects prompt-cache
    // routing only; Codex handshake identity comes from sendOpts and remains
    // independent so a future cache-lane policy cannot merge conversations.
    const poolKey = opts.sessionId || null;
    const cacheKey = body.prompt_cache_key || resolveProviderCacheKey(opts, 'openai-oauth');
    const startupPrefixHash = codexStartupPrefixHash(body);
    const prewarmState = {
      handle:
        opts._startupPrewarmOnly === true
          ? null
          : this._claimStartupPrewarmHandle({ poolKey, cacheKey, prefixHash: startupPrefixHash }),
    };
    const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
    const sendWs = typeof opts._sendViaWebSocketFn === 'function' ? opts._sendViaWebSocketFn : sendViaWebSocket;
    const sendHttp = typeof opts._sendViaHttpSseFn === 'function' ? opts._sendViaHttpSseFn : sendViaHttpSse;
    // Fast-fallback is only meaningful when HTTP/SSE fallback is actually
    // configured for this provider; WS-only paths keep the full handshake
    // retry budget. This mirrors _shouldUseOpenAIHttpFallback's `enabled`.
    const transportPolicy = resolveOpenAiTransportPolicy();
    const httpFallbackEnabled = transportPolicy.allowHttpFallback && _envFlag('MIXDOG_OPENAI_HTTP_FALLBACK', true);
    const _t1 = Date.now();
    // WS and HTTP/SSE dispatch, the sticky per-session transport switch, the
    // fallback policy and the transport traces (openai-oauth-dispatch.mjs).
    const dispatch = createOpenAiOAuthDispatch({
      provider: this,
      opts,
      body,
      authState,
      prewarmState,
      poolKey,
      cacheKey,
      iteration,
      useModel,
      externalSignal,
      onStreamDelta,
      onToolCall,
      onTextDelta,
      onStageChange,
      sendWs,
      sendHttp,
      startedAt: _t1,
      httpFallbackEnabled,
    });
    if (
      transportPolicy.transport === 'http' ||
      (transportPolicy.allowHttpFallback &&
        (opts.forceHttpFallback === true ||
          dispatch.httpFallbackActive() ||
          _envFlag('MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK', false)))
    ) {
      dispatch.discardPrewarmReservation();
      if (opts._startupPrewarmOnly === true) {
        return { startupPrewarm: false };
      }
      return dispatch.dispatchHttp('forced');
    }

    // Prefer WebSocket for hot cache/delta transport; fall back to HTTP/SSE
    // after retry-exhausted handshake/acquire/no-first-event failures.
    try {
      if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(
          `[agent-trace] provider-send-start model=${useModel} agent=${_sendAgent} sessionHash=${createHash('sha256').update(String(_sendSessionId)).digest('hex').slice(0, 8)} iteration=${iteration ?? '(none)'}\n`
        );
      }
      const result = await dispatch.dispatchWs(false);
      if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] provider-send-end elapsed=${Date.now() - _t1}ms result=ok\n`);
      }
      // Stamp the reservation with the prefix it warmed so the first real
      // request can tell a matching anchor from a stale one.
      if (opts._startupPrewarmOnly === true && result?.startupPrewarmHandle) {
        stampStartupPrewarmReservation(result.startupPrewarmHandle, startupPrefixHash);
      }
      return dispatch.recordLiveModel(result);
    } catch (err) {
      dispatch.traceTransportError(err, 'primary');
      if (opts._startupPrewarmOnly === true) throw err;
      const status = err?.httpStatus;
      // Live-text invariant: if the WS attempt already relayed a
      // non-empty text chunk to the client, NO recovery path may reissue
      // the turn — an auth-refresh + dispatchWs(true) retry would
      // concatenate a second attempt onto already-rendered output. Refuse
      // the retry (and the HTTP fallback below already refuses) and
      // surface the original error.
      const liveTextEmitted = err?.liveTextEmitted === true || err?.unsafeToRetry === true;
      if (status === 401 && !liveTextEmitted) {
        process.stderr.write(`[openai-oauth-ws] ${status} — forcing refresh and retrying once over WS\n`);
        if (process.env.MIXDOG_DEBUG_AGENT) {
          process.stderr.write(`[agent-trace] provider-${status}-retry attempt=1\n`);
        }
        this._refreshFallbackUntil = 0;
        authState.tokens = await this.ensureAuth({ forceRefresh: true, reason: String(status) });
        try {
          const result = await dispatch.dispatchWs(true, err?.__warmup || null);
          if (process.env.MIXDOG_DEBUG_AGENT) {
            process.stderr.write(`[agent-trace] provider-send-end elapsed=${Date.now() - _t1}ms result=ok\n`);
          }
          return dispatch.recordLiveModel(result);
        } catch (retryErr) {
          dispatch.traceTransportError(retryErr, 'auth_retry');
          if (dispatch.shouldUseHttpFallback(retryErr)) {
            return dispatch.dispatchHttp(
              retryErr?.retryClassifier || retryErr?.code || retryErr?.message || 'ws_auth_retry_failed',
              retryErr,
              { sticky: true }
            );
          }
          throw retryErr;
        }
      }
      // Auth failure after live text already emitted: never reissue.
      if (status === 401 && liveTextEmitted) {
        throw err;
      }
      const msg = err?.message || '';
      const handshakeHttpFallback = isOpenAiOAuthHandshakeHttpFallback(err, externalSignal);
      const isUnknownModel =
        !handshakeHttpFallback && (status === 404 || /unknown[_\s-]?model|model[_\s-]?not[_\s-]?found/i.test(msg));
      // Catalog recovery reissues the full turn. Once any text/tool
      // output has escaped, that replay can duplicate rendered output or
      // a dispatched side effect, so honor the same unsafe gate as auth
      // retry and transport fallback.
      if (isUnknownModel && !opts._modelRetry && !liveTextEmitted) {
        process.stderr.write(`[openai-oauth-ws] unknown model — refreshing catalog + 1 retry\n`);
        await this._refreshModelCache();
        return this.send(messages, model, tools, { ...opts, _modelRetry: true });
      }
      if (dispatch.shouldUseHttpFallback(err)) {
        return dispatch.dispatchHttp(
          err?.retryClassifier || err?.midstreamClassifier || err?.code || err?.message || 'ws_failed',
          err,
          { sticky: true }
        );
      }
      throw err;
    }
  }
  /**
   * Session-startup Responses prewarm. With a materialized session this sends
   * Codex's generate:false request (stable instructions/tools, empty input)
   * and leaves the response/socket state pooled for the first real turn.
   * Legacy callers without a materialized prompt retain the connection-only
   * prewarm path.
   *
   * Best-effort by contract: every failure returns false and leaves the
   * lazy per-send warmup untouched.
   */
  async prewarmWsTransportForSession(opts = {}, seams = {}) {
    const target = resolveStartupPrewarmTarget(opts);
    const { poolKey, promptWarmup } = target;
    if (!poolKey) return false;
    if (hasStartupPrewarmReservation(this._startupPrewarmReadyByPoolKey, poolKey, { promptWarmup })) {
      return true;
    }
    const running = this._startupPrewarmByPoolKey.get(poolKey) || null;
    if (running && (!promptWarmup || running.promptWarmup)) return running.task;
    if (running) {
      // A connection-only prewarm is in flight and cannot satisfy this
      // prompt prewarm: let it settle, retire it, then run the prompt one.
      try {
        await running.task;
      } catch {}
      retireStartupPrewarmRecord(this._startupPrewarmByPoolKey, poolKey, running);
      return this.prewarmWsTransportForSession(opts, seams);
    }
    const record = { promptWarmup, task: this._runStartupPrewarm(target, opts, seams) };
    this._startupPrewarmByPoolKey.set(poolKey, record);
    try {
      return await record.task;
    } catch (err) {
      if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(
          `[agent-trace] spawn-ws-prewarm failed err=${String(err?.message || err).slice(0, 160)}\n`
        );
      }
      return false;
    } finally {
      retireStartupPrewarmRecord(this._startupPrewarmByPoolKey, poolKey, record);
    }
  }

  /** Transport gate shared by both prewarm shapes: never prewarm WS off it. */
  async _runStartupPrewarm(target, opts, seams) {
    const transportPolicy = resolveOpenAiTransportPolicy();
    if (transportPolicy.transport === 'http' || _envFlag('MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK', false))
      return false;
    return target.promptWarmup
      ? this._runStartupPromptPrewarm(target, opts, seams)
      : this._runStartupConnectionPrewarm(target, opts, seams);
  }

  /**
   * Billed generate:false turn over the session's own dispatch identity. A
   * completed one is published as this session's reservation for the first
   * real turn; anything else leaves the lazy per-send warmup untouched.
   */
  async _runStartupPromptPrewarm(target, opts, seams) {
    const { poolKey, messages, model, tools } = target;
    const send =
      seams._send ||
      ((sendMessages, sendModel, sendTools, sendOpts) => this.send(sendMessages, sendModel, sendTools, sendOpts));
    const startedAt = Date.now();
    const result = await send(messages, model, tools, buildStartupPrewarmSendOpts(target, opts));
    const handle = result?.startupPrewarmHandle || null;
    const ready = result?.startupPrewarm === true && !!handle?.entry;
    if (ready) armStartupPrewarmReservation(this._startupPrewarmReadyByPoolKey, poolKey, handle);
    traceStartupPrewarm(poolKey, {
      elapsed_ms: Date.now() - startedAt,
      prompt_warmup: true,
      ready,
    });
    return ready;
  }

  /**
   * Unbilled path: open (or confirm) a pooled socket for the session so the
   * first turn skips the handshake. Nothing is reserved — the socket is
   * released back to the pool, where any turn on this key can pick it up.
   */
  async _runStartupConnectionPrewarm(target, opts, seams) {
    const { poolKey } = target;
    const threadKeyGate = String(process.env.MIXDOG_OAI_CODEX_THREAD_CACHE_KEY || '').toLowerCase();
    if (threadKeyGate === '0' || threadKeyGate === 'false') return false;
    const hasPooled = seams._hasPooled || hasPooledWebSocket;
    if (hasPooled(poolKey)) return true;
    const acquire = seams._acquire || acquireWebSocket;
    const release = seams._release || releaseWebSocket;
    const warmVersion = seams._warmVersion || warmCodexClientVersion;
    const cacheKey = buildStableProviderPromptCacheKey('openai-oauth', opts);
    const [auth] = await Promise.all([this.ensureAuth(), warmVersion()]);
    const codexHeaders = _codexWsCompatibilityHeaders({
      poolKey,
      cacheKey,
      sendOpts: opts,
      model: opts.model,
      serviceTier: opts.fast === true && codexModelSupportsServiceTier(opts.model, 'priority') ? 'priority' : '',
      handshake: true,
    });
    const startedAt = Date.now();
    const acquired = await acquire({
      auth,
      poolKey,
      cacheKey,
      codexHeaders,
      externalSignal: opts.signal || null,
    });
    release({ entry: acquired.entry, poolKey, keep: true });
    traceStartupPrewarm(poolKey, {
      elapsed_ms: Date.now() - startedAt,
      reused: acquired.reused === true,
      prompt_warmup: false,
    });
    return true;
  }
  async listModels() {
    return listCodexModels(() => this.ensureAuth());
  }
  /** Force a catalog refresh (ignores the 24h TTL). */
  async _refreshModelCache() {
    return refreshCodexCatalog(() => this.ensureAuth());
  }

  async isAvailable() {
    return this.tokens !== null;
  }
}
