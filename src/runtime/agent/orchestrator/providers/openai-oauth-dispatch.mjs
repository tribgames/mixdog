/**
 * openai-oauth-dispatch.mjs — how one Codex OAuth turn reaches the backend and
 * what it records: the WebSocket dispatch, the HTTP/SSE
 * dispatch that arms the sticky per-session transport switch before it can
 * fail, the handshake / unhealthy-WS fallback policy, the live-model catalog
 * probe, and the transport_error / transport_fallback trace rows.
 *
 * Transport SELECTION — which dispatch runs, and the auth/catalog recovery
 * ladder between them — stays in openai-oauth.mjs.
 */
import { appendAgentTrace } from '../agent-trace.mjs';
import { codexCatalogHas } from './openai-oauth-catalog.mjs';
import { _displayCodexModel } from './openai-codex-model.mjs';
import { _envFlag, _shouldUseOpenAIHttpFallback } from './openai-oauth-http-sse.mjs';
import { isWsMessageTooBigClose } from './retry-classifier.mjs';

function openAiOAuthHandshakeErrorPolicy({ status }) {
  if (Number(status) === 404) {
    return { retry: false, httpFallback: true };
  }
  return null;
}

export function isOpenAiOAuthHandshakeHttpFallback(err, externalSignal) {
  if (
    externalSignal?.aborted ||
    err?.liveTextEmitted === true ||
    err?.emittedToolCall === true ||
    err?.toolCallEmitted === true ||
    err?.unsafeToRetry === true
  ) {
    return false;
  }
  return (
    Number(err?.httpStatus || err?.status || 0) === 404 &&
    err?.wsFailurePhase === 'handshake' &&
    err?.wsHttpFallbackEligible === true
  );
}

/**
 * @param {object} deps
 * @param {object} deps.provider  the provider instance (catalog refresh + sticky map)
 * @param {object} deps.opts  send options
 * @param {object} deps.body  the Responses request body
 * @param {{ tokens: object }} deps.authState  credential holder (replaced on 401 refresh)
 * @param {string|null} deps.poolKey  socket/delta isolation key
 * @param {string} deps.cacheKey  prompt-cache routing key
 * @param {number|null} deps.iteration
 * @param {string} deps.useModel
 * @param {AbortSignal|null} deps.externalSignal
 * @param {Function} deps.sendWs  WebSocket transport (seam-injectable)
 * @param {Function} deps.sendHttp  HTTP/SSE transport (seam-injectable)
 * @param {number} deps.startedAt  send() start, for the debug elapsed lines
 * @param {boolean} deps.httpFallbackEnabled
 */
export function createOpenAiOAuthDispatch({
  provider,
  opts,
  body,
  authState,
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
  startedAt,
  httpFallbackEnabled,
}) {
  const shouldUseHttpFallback = (error) => {
    if (!httpFallbackEnabled) return false;
    if (isOpenAiOAuthHandshakeHttpFallback(error, externalSignal)) return true;
    const status = Number(error?.httpStatus || error?.status || 0);
    // A server 1009 refuses this request frame on every WS retry, so it
    // switches the session at once instead of spending the WS retry budget.
    return (
      (status === 426 || error?.wsRetriesExhausted === true || isWsMessageTooBigClose(error)) &&
      _shouldUseOpenAIHttpFallback(error, externalSignal)
    );
  };
  const recordLiveModel = (result) => {
    if (result?.model && !codexCatalogHas(result.model)) {
      void provider._refreshModelCache();
    }
    if (result && opts.providerState !== undefined && result.providerState === undefined) {
      result.providerState = opts.providerState;
    }
    return result;
  };
  const httpFallbackActive = () => {
    if (!poolKey) return false;
    const now = Date.now();
    for (const [key, expiresAt] of provider._httpFallbackUntilByPoolKey) {
      if (!(expiresAt > now)) provider._httpFallbackUntilByPoolKey.delete(key);
    }
    return (provider._httpFallbackUntilByPoolKey.get(poolKey) || 0) > now;
  };
  const markStickyHttpFallback = () => {
    if (!poolKey) return;
    // Codex disables WebSockets for the remainder of this session after
    // stream retry exhaustion, a typed unsupported upgrade (404/426), or a
    // server 1009 that refused the request frame.
    provider._httpFallbackUntilByPoolKey.set(poolKey, Number.POSITIVE_INFINITY);
  };
  const traceTransportError = (err, stage = 'primary', transport = 'websocket') => {
    try {
      appendAgentTrace({
        sessionId: poolKey,
        iteration,
        kind: 'transport_error',
        provider: 'openai-oauth',
        model: useModel,
        transport,
        payload: {
          stage,
          error_code: err?.code || null,
          error_http_status: Number(err?.httpStatus || 0) || null,
          error_ws_close_code: err?.wsCloseCode ?? null,
          error_classifier: err?.retryClassifier || err?.midstreamClassifier || null,
          ws_retries: err?.midstreamRetries ?? null,
          live_text_emitted: err?.liveTextEmitted === true || err?.unsafeToRetry === true,
          message: String(err?.message || err || '').slice(0, 500),
        },
      });
    } catch {}
  };
  const dispatchHttp = async (reason, originalErr = null, { sticky = false } = {}) => {
    // Transport switching is a session decision, not an HTTP-success
    // side effect. Persist it before the fallback can fail or abort.
    if (sticky) markStickyHttpFallback();
    appendAgentTrace({
      sessionId: poolKey,
      iteration,
      kind: 'transport_fallback',
      provider: 'openai-oauth',
      model: useModel,
      transport: 'http',
      payload: {
        from: 'websocket',
        to: 'http',
        reason,
        error_code: originalErr?.code || null,
        error_http_status: Number(originalErr?.httpStatus || 0) || null,
        error_classifier: originalErr?.retryClassifier || originalErr?.midstreamClassifier || null,
      },
    });
    if (reason === 'forced') {
      if (_envFlag('MIXDOG_OPENAI_OAUTH_LOG_FORCED_FALLBACK', false)) {
        process.stderr.write('[openai-oauth] WebSocket bypassed (forced); using HTTP/SSE\n');
      }
    } else {
      if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
        process.stderr.write(`[openai-oauth] WebSocket unhealthy (${reason}); falling back to HTTP/SSE\n`);
    }
    let result;
    try {
      result = await sendHttp({
        auth: authState.tokens,
        body,
        opts,
        onStreamDelta,
        onToolCall,
        onTextDelta,
        onStageChange,
        externalSignal,
        poolKey,
        cacheKey,
        iteration,
        useModel,
        fetchFn: opts._fetchFn,
      });
    } catch (httpErr) {
      // The current transport owns the terminal decision, including
      // auth, rate limits, cancellation and output-safety markers.
      // Keep WS history outside `cause`: retry classifiers walk that
      // chain and must not revive a stale transport failure.
      if (originalErr && originalErr !== httpErr) {
        try {
          httpErr.previousTransportError = originalErr;
        } catch {}
      }
      traceTransportError(httpErr, reason === 'forced' ? 'primary' : 'fallback', 'http');
      throw httpErr;
    }
    if (process.env.MIXDOG_DEBUG_AGENT) {
      process.stderr.write(
        `[agent-trace] provider-send-end elapsed=${Date.now() - startedAt}ms result=ok transport=http-fallback\n`
      );
    }
    return recordLiveModel(result);
  };
  const dispatchWs = (forceFresh = false) => {
    return sendWs({
      auth: authState.tokens,
      body,
      sendOpts: opts,
      onStreamDelta,
      onToolCall,
      onTextDelta,
      onStageChange,
      externalSignal,
      poolKey,
      cacheKey,
      iteration,
      useModel,
      displayModel: _displayCodexModel,
      forceFresh,
      handshakeErrorPolicy: openAiOAuthHandshakeErrorPolicy,
      // Default refs-style recovery: keep using WS first. A transient
      // first-byte / mid-stream stall closes the bad socket and retries on
      // a fresh WS entry; only after the bounded WS retry budget is
      // exhausted does openai-oauth fall back to HTTP/SSE. This preserves
      // the hot WS/cache path for temporary blips while still preventing
      // TUI-level hangs. Sticky HTTP fallback is only armed after this
      // bounded reconnect budget is exhausted, or at once on a server 1009.
    });
  };

  return {
    dispatchWs,
    dispatchHttp,
    httpFallbackActive,
    recordLiveModel,
    shouldUseHttpFallback,
    traceTransportError,
  };
}
