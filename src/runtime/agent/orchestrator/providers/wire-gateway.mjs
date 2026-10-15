/**
 * wire-gateway.mjs — an API-key gateway that serves one account on several
 * wires (OpenRouter, DeepSeek). Chat Completions and Responses go through the
 * OpenAI-compatible engine, Anthropic Messages through an Anthropic engine
 * bound to the gateway; wire-route.mjs picks the wire per model.
 */
import { AnthropicProvider } from './anthropic.mjs';
import { OpenAICompatProvider, OPENAI_COMPAT_PRESETS } from './openai-compat.mjs';
import { originBoundFetch } from './lib/origin-bound-fetch.mjs';
import { withInclusiveUsage } from './lib/inclusive-usage.mjs';
import { getModelMetadataSync } from './model-catalog.mjs';
import { resolveWireRoute, sendOnRoute } from './wire-route.mjs';

// A Files API file-ID image anywhere in the history (tool results nest content).
function hasFileIdImage(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return false;
  if (Array.isArray(value)) return value.some((entry) => hasFileIdImage(entry, depth + 1));
  const fileId = value.type === 'input_image' ? value.file_id : value.type === 'image' && value.source?.type === 'file' ? value.source.file_id : null;
  if (typeof fileId === 'string' && fileId) return true;
  return hasFileIdImage(value.content, depth + 1);
}

/**
 * The per-request capability options a gateway's Messages engine hands the
 * shared Anthropic request builder (anthropic-api-request.mjs):
 *   - `modelMaxOutputTokens`: the gateway's own output ceiling for the model
 *     (`config.modelMaxOutputTokens(model)`),
 *   - `messagesEffortProjection`: the gateway's own effort projection
 *     (`config.messagesEffortProjection`), replacing the Claude rules,
 *   - `anthropic-beta` (`config.fileIdImageBeta`) only on a request that
 *     carries a file-ID image; every other beta stays suppressed.
 */
export function gatewayMessagesOpts(config, model, messages, opts) {
  const out = { ...(opts || {}) };
  const ceiling = Math.floor(Number(typeof config?.modelMaxOutputTokens === 'function' ? config.modelMaxOutputTokens(model) : 0));
  if (ceiling > 0 && out.modelMaxOutputTokens === undefined) out.modelMaxOutputTokens = ceiling;
  if (typeof config?.messagesEffortProjection === 'function') out.messagesEffortProjection = config.messagesEffortProjection;
  if (config?.fileIdImageBeta && hasFileIdImage(messages)) {
    out.requestHeaders = { 'anthropic-beta': config.fileIdImageBeta, ...(out.requestHeaders || {}) };
  }
  return out;
}

/**
 * Anthropic engine bound to a gateway: only the gateway key is sent — never
 * an ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the environment — and only
 * to the gateway origin. `config.authScheme: 'bearer'` sends the key as
 * `Authorization: Bearer` (OpenRouter); the default is `x-api-key`. The client
 * is rebuilt through here on every key change or reload.
 * `config.capabilityModel(model)` maps the routing slug to the Claude id its
 * capabilities are read from.
 */
export class GatewayMessagesEngine extends AnthropicProvider {
  // Document capability of this gateway's Messages route, declared by the
  // gateway config. `nativePdf`: PDFs ride as document blocks (default: lowered
  // to text). `nativeDocuments`: any document block at all; unset leaves
  // non-PDF documents as they are, an explicit false (DeepSeek) means every
  // document variant is lowered to text or rejected.
  nativePdf = this.config.nativePdf === true;
  nativeDocuments = this.config.nativeDocuments;
  _sendOnce(messages, model, tools, opts) {
    return super._sendOnce(messages, model, tools, gatewayMessagesOpts(this.config, model, messages, opts));
  }
  _createClient(apiKey) {
    const client = super._createClient(apiKey);
    if (this.config.authScheme === 'bearer') {
      client.apiKey = null;
      client.authToken = apiKey || null;
    } else {
      client.authToken = null;
    }
    client.fetch = originBoundFetch(new URL(this.config.baseURL).origin, this.config.fetchImpl, this.name);
    return client;
  }
  _capabilityModel(model) {
    return (typeof this.config.capabilityModel === 'function' && this.config.capabilityModel(model)) || model;
  }
}

export class WireGatewayProvider {
  // No document block on any gateway wire: a PDF is lowered to text.
  nativePdf = false;
  // Every wire reports inclusive input (Messages usage is converted).
  static inputExcludesCache = false;
  name;
  config;
  openai;
  anthropic;

  /**
   * @param {string} name  preset name (openai-compat-presets.mjs)
   * @param {object} config  provider config
   * @param {object} messages  the Messages engine: `{ baseURL, authScheme?, capabilityModel? }`
   * @param {object} [compatConfig]  extra OpenAI-compatible engine config
   */
  constructor(name, config = {}, messages, compatConfig = {}) {
    this.name = name;
    this.config = config;
    this.openai = new OpenAICompatProvider(name, { ...config, ...compatConfig });
    this.anthropic = new GatewayMessagesEngine({
      ...config,
      ...messages,
      name,
      disableBetaHeaders: true,
      modelMaxOutputTokens: messages.modelMaxOutputTokens ?? ((model) => this._modelMaxOutputTokens(model)),
      extraHeaders: { ...(OPENAI_COMPAT_PRESETS[name]?.extraHeaders || {}), ...(config.extraHeaders || {}) },
    });
    // The Chat engine's retry profile stays the account's loop policy.
    if (this.openai.retryPolicy) this.retryPolicy = this.openai.retryPolicy;
  }

  resolveWireRoute(model, ctx = {}) {
    return resolveWireRoute(this.name, model, { ...ctx, override: this.config?.modelWires?.[model] ?? null });
  }

  // The model's output ceiling: the gateway roster, else the shared catalog.
  _modelMaxOutputTokens(model) {
    const declared = Number(this.getCachedModelInfo(model)?.outputTokens ?? getModelMetadataSync(model, this.name)?.outputTokens);
    return Number.isFinite(declared) && declared > 0 ? declared : null;
  }

  send(messages, model, tools, sendOpts) {
    const useModel = model || this.openai.defaultModel;
    // The resolved route is the only wire authority: a caller's own wire
    // switches never reach an engine, and one clear "unsupported" refusal
    // moves the send to the next wire once (sendOnRoute).
    return sendOnRoute(this, useModel, tools, sendOpts, messages, (wire, history, opts) => {
      if (wire === 'messages') return withInclusiveUsage(() => this.anthropic.send(history, useModel, tools, opts));
      if (wire === 'responses') return this.openai.send(history, model, tools, { ...opts, compatWireApi: 'responses' });
      return this.openai.send(history, model, tools, opts);
    });
  }

  reloadApiKey() {
    this.openai.reloadApiKey();
    this.anthropic.reloadApiKey();
  }

  async listModels() {
    return this.openai.listModels();
  }

  async isAvailable() {
    return this.openai.isAvailable();
  }

  getCachedModelInfo(model) {
    return this.openai.getCachedModelInfo(model);
  }
}

/** The Anthropic SDK base for a gateway's OpenAI base: the SDK appends `/v1/messages`. */
export function messagesBaseFromOpenAIBase(baseURL) {
  return String(baseURL || '')
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
}
