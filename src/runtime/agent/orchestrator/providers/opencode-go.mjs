import { randomUUID } from 'node:crypto';
import { AnthropicProvider } from './anthropic.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { getModelMetadataSync, getModelsDevRowSync } from './model-catalog.mjs';
import { withInclusiveUsage } from './lib/inclusive-usage.mjs';
import { providerOffersWire, resolveWireRoute, sendOnRoute } from './wire-route.mjs';
import { gatewayMessagesOpts } from './wire-gateway.mjs';

// The OpenCode Go gateway engines. Not a registered provider: the
// `opencode-go-oauth` provider (opencode-go-oauth.mjs) runs its requests here
// on the account's OAuth access token. `opencode-go` stays the engines' internal
// wire/catalog id.
const GO_GATEWAY_PRESET = Object.freeze({
  baseURL: 'https://opencode.ai/inference/go/v1',
  // The gateway expects an application User-Agent (not the SDK default).
  extraHeaders: Object.freeze({ 'User-Agent': 'mixdog' }),
});

// The Go Anthropic route: the shared request builder gets the model's output
// ceiling (models.dev limit) through the gateway options.
class OpenCodeGoMessagesEngine extends AnthropicProvider {
  _sendOnce(messages, model, tools, opts) {
    return super._sendOnce(messages, model, tools, gatewayMessagesOpts(this.config, model, messages, opts));
  }
}

// OpenCode Go publishes OpenAI chat/completions, OpenAI Responses, and
// Anthropic Messages endpoints, and each upstream brand answers on only one
// of them (muse-spark / gpt / grok 500 on chat/completions; minimax and
// Claude expect Messages). models.dev names the SDK package per model, which
// is the authoritative wire selector; wire-route.mjs holds the cold-catalog
// prefix fallback. `@ai-sdk/google` names the Gemini generateContent wire
// (opencode-go-gemini.mjs).
export const WIRE_API_BY_NPM = Object.freeze({
  '@ai-sdk/openai': 'responses',
  '@ai-sdk/anthropic': 'messages',
  '@ai-sdk/openai-compatible': 'chat',
  '@ai-sdk/google': 'gemini',
});

function openCodeGoCatalogWire(model) {
  const npm = getModelsDevRowSync(String(model || ''), 'opencode-go')?.npm;
  return typeof npm === 'string' && Object.hasOwn(WIRE_API_BY_NPM, npm) ? WIRE_API_BY_NPM[npm] : null;
}

export function resolveOpenCodeGoWireRoute(model, ctx = {}) {
  const catalogWire = openCodeGoCatalogWire(model);
  // Each Go model answers on the one wire the catalog names: it narrows the
  // offered endpoints, so an override cannot pick a wire the model lacks.
  const endpoints = providerOffersWire('opencode-go', catalogWire) ? [catalogWire] : null;
  return resolveWireRoute('opencode-go', model, { ...ctx, catalogWire, endpoints });
}

/** Wire API for a Go model: 'responses' | 'messages' | 'chat'. */
function openCodeGoWireApi(model) {
  return resolveOpenCodeGoWireRoute(model).wire;
}

export function isAnthropicGoModel(model) {
  return openCodeGoWireApi(model) === 'messages';
}

export function resolveOpenCodeGoBaseURLs(configuredBaseURL) {
  const openai = String(configuredBaseURL || GO_GATEWAY_PRESET.baseURL).replace(/\/+$/, '');
  // Anthropic's SDK appends `/v1/messages` itself. Supplying the OpenAI base
  // (`.../v1`) would therefore produce the invalid `.../v1/v1/messages`.
  const anthropic = openai.replace(/\/v1$/i, '');
  return { openai, anthropic };
}

export function openCodeGoEndpointForModel(model, configuredBaseURL) {
  const bases = resolveOpenCodeGoBaseURLs(configuredBaseURL);
  const wire = openCodeGoWireApi(model);
  if (wire === 'messages') return `${bases.anthropic}/v1/messages`;
  if (wire === 'responses') return `${bases.openai}/responses`;
  return `${bases.openai}/chat/completions`;
}

function opencodeGoContextWindow(modelId, current = 0) {
  const native = Number(current);
  if (Number.isFinite(native) && native > 0) return native;
  const catalog = getModelMetadataSync(modelId, 'opencode-go');
  const contextWindow = Number(catalog?.contextWindow);
  if (Number.isFinite(contextWindow) && contextWindow > 0) return Math.floor(contextWindow);
  return 0;
}

function opencodeGoReasoningLevels(model, current = null) {
  if (Array.isArray(current) && current.length > 0) return current;
  const effort = (model?.reasoningOptions || []).find((option) => option?.type === 'effort');
  if (Array.isArray(effort?.values)) return effort.values.map((value) => String(value || '').trim()).filter(Boolean);
  return [];
}

export class OpenCodeGoProvider {
  // No document block on this wire: a PDF is lowered to text before the request is built.
  nativePdf = false;
  static inputExcludesCache = false;
  name = 'opencode-go';
  config;
  openai;
  anthropic;

  constructor(config = {}) {
    // Retain the outer account config for the common provider-admission
    // lane. The delegated transports are intentionally not independently
    // wrapped, so all model-family routes share this one 64-wide account.
    this.config = config;
    const bases = resolveOpenCodeGoBaseURLs(config.baseURL);
    this.openai = new OpenAICompatProvider('opencode-go', {
      ...config,
      baseURL: bases.openai,
      extraHeaders: { ...GO_GATEWAY_PRESET.extraHeaders, ...(config.extraHeaders || {}) },
    });
    this.anthropic = new OpenCodeGoMessagesEngine({
      ...config,
      name: 'opencode-go',
      baseURL: bases.anthropic,
      disableBetaHeaders: true,
      // The preset's identifying headers (User-Agent) ride the Messages wire
      // too; the user's own headers win.
      extraHeaders: { ...GO_GATEWAY_PRESET.extraHeaders, ...(config.extraHeaders || {}) },
      modelMaxOutputTokens: (model) => this.getCachedModelInfo(model)?.outputTokens,
    });
    // The Anthropic route answers for this provider: PDFs lower to text.
    this.anthropic.nativePdf = this.nativePdf;
  }

  async send(messages, model, tools, sendOpts) {
    // The transports share account-level clients, so session identity must
    // travel with each request rather than mutate client default headers.
    // Calls without a conversation get a send-scoped ID, reused by retries.
    const sessionId =
      [sendOpts?.sessionId, sendOpts?.session?.id].find((value) => typeof value === 'string' && value.trim())?.trim() ||
      randomUUID();
    sendOpts = {
      ...(sendOpts || {}),
      requestHeaders: {
        ...(sendOpts?.requestHeaders || {}),
        'x-opencode-session': sessionId,
      },
    };
    // The session's pinned route, else this model's route (wire-route.mjs);
    // the resolved route is the only wire authority (a caller's own wire
    // switches never reach an engine), and one clear "unsupported" refusal
    // moves the send to the next wire once.
    return sendOnRoute(this, model, tools, sendOpts, messages, async (wire, history, opts) => {
      if (wire === 'responses') {
        // OpenAI-family brands on the gateway (Muse Spark, GPT, Grok)
        // only answer on /responses; the compat transport switches wire
        // shape per request via this flag.
        return this.openai.send(history, model, tools, { ...opts, compatWireApi: 'responses' });
      }
      if (wire === 'messages') {
        // The Anthropic-style Go endpoint reports cached read/write usage
        // and accepts the standard message shape. Preserve the caller's
        // cache strategy so the shared Anthropic live-tail marker advances
        // through tool loops instead of forcing every request fully cold.
        // Abandoned attempts noted by the inner provider use the same conversion.
        return withInclusiveUsage(() => this.anthropic.send(history, model, tools, opts));
      }
      if (wire === 'gemini') return (await this._geminiEngine()).send(history, model, tools, opts);
      return this.openai.send(history, model, tools, opts);
    });
  }

  // The Gemini generateContent route; the Google SDK loads only when a Gemini model is used.
  async _geminiEngine() {
    if (!this.gemini) {
      const { OpenCodeGoGeminiEngine } = await import('./opencode-go-gemini.mjs');
      this.gemini = new OpenCodeGoGeminiEngine({
        ...this.config,
        // The OAuth org config names the chat base `.../go/openai/v1`; the
        // generateContent routes live under `.../go/v1` and 404 on it.
        baseURL: String(this.openai.baseURL).replace(/\/openai\/v1$/i, '/v1'),
        extraHeaders: {
          ...GO_GATEWAY_PRESET.extraHeaders,
          ...(this.config.extraHeaders || {}),
        },
      });
    }
    return this.gemini;
  }

  resolveWireRoute(model, ctx = {}) {
    return resolveOpenCodeGoWireRoute(model, { ...ctx, override: this.config?.modelWires?.[model] ?? null });
  }

  async listModels() {
    const models = await this.openai.listModels();
    return Array.isArray(models)
      ? models.map((model) => ({
          ...model,
          contextWindow: opencodeGoContextWindow(model?.id, model?.contextWindow),
          reasoningLevels: opencodeGoReasoningLevels(model, model?.reasoningLevels),
        }))
      : models;
  }

  getCachedModelInfo(model) {
    const inner = isAnthropicGoModel(model) ? this.anthropic : this.openai;
    const cached = typeof inner.getCachedModelInfo === 'function' ? inner.getCachedModelInfo(model) : null;
    const catalog = getModelMetadataSync(model, 'opencode-go');
    const info = cached || catalog || null;
    if (!info) {
      return null;
    }
    const contextWindow = opencodeGoContextWindow(model, info.contextWindow);
    return {
      ...info,
      id: info.id || model,
      provider: this.name,
      contextWindow: contextWindow || info.contextWindow || null,
      reasoningLevels: opencodeGoReasoningLevels(info, info.reasoningLevels),
    };
  }
}
