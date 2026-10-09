import { createRequire } from 'node:module';
import { noteErrorUsage } from './lib/note-error-usage.mjs';
import { getAgentApiKey } from '../../../shared/provider-api-key.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { appendAgentTrace } from '../agent-trace.mjs';
import { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';
import { assertSafeBaseURL } from './provider-base-url.mjs';
import { resolveResponsesTransportPolicy, RESPONSES_TRANSPORT_CAPABILITIES } from './openai-transport-policy.mjs';
import { toResponsesTools, toXaiResponsesInput } from './openai-compat-wire.mjs';
import {
  useXaiResponsesApi as isXaiResponsesApiEnabled,
  useXaiResponsesWebSocket as preferXaiResponsesWebSocket,
  _shouldFallbackXaiWsToHttp,
} from './openai-compat-xai.mjs';
import { sendCompatResponses } from './openai-compat-responses.mjs';
import { sendCompatChat, recoverCompatNonStreaming } from './openai-compat-chat-send.mjs';
import { sendXaiResponses, sendXaiResponsesWebSocket } from './openai-compat-xai-send.mjs';
import {
  fetchCompatModelItems,
  getCachedCompatModelInfo,
  isCompatProviderAvailable,
  listCompatModels,
} from './openai-compat-models.mjs';

const requireOpenAI = createRequire(import.meta.url);
let _OpenAI = null;

function loadOpenAI() {
  if (!_OpenAI) {
    const mod = requireOpenAI('openai');
    _OpenAI = mod.default || mod.OpenAI || mod;
  }
  return _OpenAI;
}

// Grok OAuth creates its credential-bound inner provider only when send() has
// the final token and request headers. Let the process-wide provider warmup pay
// the OpenAI SDK + undici pool load before that first request reaches the hot
// path, without constructing a fake credential-bound client.
export function preloadOpenAICompatRuntime() {
  const OpenAI = loadOpenAI();
  getLlmDispatcher();
  return OpenAI;
}

export { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';
export { parseToolCalls, parseResponsesToolCalls } from './openai-compat-wire.mjs';
export { applyCompatProviderChatOptions } from './openai-compat-options.mjs';
export { compatReportedCostUsd } from './openai-compat-response-normalization.mjs';

const PRESETS = OPENAI_COMPAT_PRESETS;

export class OpenAICompatProvider {
  // No document block on this wire: a PDF is lowered to text before the request is built.
  nativePdf = false;
  // Chat Completions prompt_tokens is already the total (includes cached).
  // Covers grok-oauth and all OPENAI_COMPAT_PRESETS. See registry.mjs.
  static inputExcludesCache = false;
  name;
  client;
  defaultModel;
  config;
  baseURL;
  apiKey;
  defaultHeaders;
  /** @type {Array<{id:string,contextWindow:number,provider:string}>|null} */
  _enrichedModels;
  constructor(name, config) {
    const preset = PRESETS[name];
    const baseURL = assertSafeBaseURL(config.baseURL || preset?.baseURL || 'http://localhost:8080/v1', name);
    const apiKey = config.apiKey || 'no-key';
    this.name = name;
    this.config = config;
    this.baseURL = baseURL;
    this.apiKey = apiKey;
    // Merge caller-supplied headers (config.extraHeaders) over the preset's.
    // Used e.g. by grok-oauth to inject the Grok CLI client headers for the
    // grok-build proxy. Backward-compatible: providers that pass no
    // extraHeaders behave exactly as before.
    this.defaultHeaders = { ...(preset?.extraHeaders || {}), ...(config.extraHeaders || {}) };
    this.defaultModel = preset?.defaultModel || 'default';
    preloadOpenAICompatRuntime();
    this.client = this._createClient(apiKey);
    // Provider registry initialization normally runs during daemon warmup.
    // Start the origin handshake there; the per-send call below remains as
    // the TTL-gated rewarm after long idle gaps.
    if (this.config?.preconnect !== false) {
      try {
        this._preconnectFn(this.baseURL);
      } catch {
        /* best-effort */
      }
    }
  }
  get _preconnectFn() {
    return typeof this.config?.preconnectFn === 'function' ? this.config.preconnectFn : preconnect;
  }
  _createClient(apiKey) {
    return new (loadOpenAI())({
      baseURL: this.baseURL,
      apiKey,
      defaultHeaders: this.defaultHeaders,
      // The SDK's own retry loop (default 2) would nest underneath our
      // withRetry wrapper and multiply tail latency on a transient
      // backend. We own retry/backoff via withRetry, so disable the SDK's.
      maxRetries: 0,
      // Force the shared long-keepalive undici dispatcher to be installed
      // globally (setGlobalDispatcher) so the SDK's global fetch rides a
      // warm socket pool instead of Node's short-keepalive default. The
      // return value is undefined once installed globally; the option is
      // a harmless no-op then.
      fetchOptions: { dispatcher: getLlmDispatcher() },
    });
  }
  reloadApiKey() {
    try {
      const preset = PRESETS[this.name];
      const newKey = getAgentApiKey(this.name) || this.config.apiKey;
      const baseURL = assertSafeBaseURL(
        this.config.baseURL || preset?.baseURL || 'http://localhost:8080/v1',
        this.name
      );
      if (newKey) {
        this.config = { ...(this.config || {}), apiKey: newKey, baseURL };
        this.baseURL = baseURL;
        this.apiKey = newKey;
        this.defaultHeaders = { ...(preset?.extraHeaders || {}), ...(this.config.extraHeaders || {}) };
        this.client = this._createClient(newKey);
      }
    } catch {
      /* best effort */
    }
  }
  async send(messages, model, tools, sendOpts) {
    try {
      return await this._doSend(messages, model, tools, sendOpts);
    } catch (err) {
      noteErrorUsage(err);
      // Credential reload + reissue requires a TYPED 401. A message that
      // merely mentions "401" is not evidence, and a typed 403 is a
      // permission decision — reloading the key cannot change it.
      const status =
        [err?.status, err?.httpStatus, err?.response?.status]
          .map((value) => Number(value))
          .find((value) => Number.isFinite(value) && value > 0) || 0;
      if (status === 401) {
        if (err.liveTextEmitted === true || err.emittedToolCall === true || err.unsafeToRetry === true) {
          throw err;
        }
        process.stderr.write(`[provider] Auth error, re-reading provider authentication...\n`);
        this.reloadApiKey();
        return await this._doSend(messages, model, tools, sendOpts);
      }
      throw err;
    }
  }
  async _doSend(messages, model, tools, sendOpts) {
    const useModel = model || this.defaultModel;
    const opts = sendOpts || {};
    // Re-warm a kept-alive socket to the provider origin before the turn so
    // the request hot path lands on a live socket instead of paying a cold
    // TLS handshake after an idle gap. Fire-and-forget; never awaited.
    // Tests/local callers can disable this or inject a fail-closed seam;
    // production retains the shared preconnect by default.
    if (this.config?.preconnect !== false) this._preconnectFn(this.baseURL);
    if (this.name === 'xai' && isXaiResponsesApiEnabled(opts, this.config)) {
      // Shared Responses transport switch (MIXDOG_OAI_TRANSPORT), capability-
      // gated for xAI/Grok. Provider-local HTTP pins still win: Grok
      // proxy-only models set responsesTransport:'http' because the WS
      // connector targets api.x.ai, not cli-chat-proxy.grok.com.
      const xaiTransportPolicy = resolveResponsesTransportPolicy(process.env, RESPONSES_TRANSPORT_CAPABILITIES.xai);
      const configuredPreferWebSocket = preferXaiResponsesWebSocket(opts, this.config);
      let preferWebSocket = configuredPreferWebSocket;
      if (configuredPreferWebSocket === false || xaiTransportPolicy.mode === 'http-sse') preferWebSocket = false;
      else if (xaiTransportPolicy.transport === 'ws') preferWebSocket = true;
      if (preferWebSocket) {
        try {
          return await this._doSendXaiResponsesWebSocket(messages, useModel, tools, opts);
        } catch (err) {
          noteErrorUsage(err);
          if (xaiTransportPolicy.allowHttpFallback && _shouldFallbackXaiWsToHttp(err, opts.signal)) {
            const reason = err?.midstreamClassifier || err?.retryClassifier || err?.code || err?.message || 'ws_failed';
            process.stderr.write(`[xai:responses] WebSocket unhealthy (${reason}); falling back to HTTP/SSE\n`);
            try {
              appendAgentTrace({
                sessionId: opts?.sessionId || opts?.session?.id || null,
                iteration: Number.isFinite(Number(opts?.iteration)) ? Number(opts.iteration) : null,
                kind: 'transport_fallback',
                provider: 'xai',
                model: useModel,
                transport: 'http',
                payload: {
                  from: 'websocket',
                  to: 'http',
                  reason,
                  error_code: err?.code || null,
                  error_http_status: Number(err?.httpStatus || 0) || null,
                  error_classifier: err?.retryClassifier || err?.midstreamClassifier || null,
                },
              });
            } catch {}
            return await this._doSendXaiResponses(messages, useModel, tools, opts);
          }
          throw err;
        }
      }
      return await this._doSendXaiResponses(messages, useModel, tools, opts);
    }
    // Gateway brands that only answer on /responses (OpenCode Go routes
    // Muse Spark / GPT / Grok here via compatWireApi).
    if (opts.compatWireApi === 'responses') {
      return await sendCompatResponses(this, messages, useModel, tools, opts);
    }
    return sendCompatChat(this, messages, useModel, tools, opts);
  }
  async _recoverCompatNonStreaming(args) {
    return recoverCompatNonStreaming(this, args);
  }
  async _doSendXaiResponses(messages, useModel, tools, opts) {
    return sendXaiResponses(this, messages, useModel, tools, opts);
  }
  async _doSendXaiResponsesWebSocket(messages, useModel, tools, opts) {
    return sendXaiResponsesWebSocket(this, messages, useModel, tools, opts);
  }
  async _fetchModelItems() {
    return fetchCompatModelItems(this);
  }
  async listModels() {
    return listCompatModels(this);
  }
  async isAvailable() {
    return isCompatProviderAvailable(this);
  }
  /** @param {string} model */
  getCachedModelInfo(model) {
    return getCachedCompatModelInfo(this, model);
  }
}

export const _toResponsesToolsForTest = toResponsesTools;
export const _toXaiResponsesInputForTest = toXaiResponsesInput;
