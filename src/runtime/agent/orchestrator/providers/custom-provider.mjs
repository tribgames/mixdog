// User-defined ("custom") providers. A custom provider is stored as a
// secret-free config entry keyed by a generated `custom-<uuid>` id; the API key
// lives in the keychain under that same id and is injected at load time. The
// runtime reuses the existing OpenAI-compat / Anthropic engines, constructed
// under the custom id so model routes and provider identity stay `custom-…`.

import { ANTHROPIC_VERSION } from './lib/anthropic-models.mjs';
import { assertSafeBaseURL } from './provider-base-url.mjs';
import { listCompatModels } from './openai-compat-models.mjs';

export const CUSTOM_PROVIDER_PROTOCOLS = Object.freeze(['openai-chat', 'openai-responses', 'anthropic']);

function fail(message) {
  throw new Error(`[custom-provider] ${message}`);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(`${label} must be a positive integer`);
  return n;
}

function normalizeBaseURL(raw) {
  const value = text(raw);
  if (!value) fail('baseURL is required');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`invalid baseURL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('baseURL must use http or https');
  if (url.username || url.password) fail('baseURL must not embed credentials');
  if (url.search || url.hash || /[?#]/.test(value)) fail('baseURL must not contain a query or hash');
  return assertSafeBaseURL(value.replace(/\/+$/, ''), 'custom');
}

function normalizeModels(raw, requireModels) {
  if (raw === undefined || raw === null) raw = [];
  if (!Array.isArray(raw)) fail('models must be an array');
  const seen = new Set();
  const models = raw.map((entry) => {
    const id = text(entry?.id);
    if (!id) fail('every model needs an id');
    if (seen.has(id)) fail(`duplicate model id: ${id}`);
    seen.add(id);
    const name = text(entry.name);
    const contextWindow = positiveInt(entry.contextWindow, `model ${id} contextWindow`);
    const maxOutputTokens = positiveInt(entry.maxOutputTokens, `model ${id} maxOutputTokens`);
    return {
      id,
      ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    };
  });
  if (requireModels && models.length === 0) fail('at least one model is required');
  return models;
}

export function normalizeCustomProviderConfig(input, { requireModels = true } = {}) {
  if (!input || typeof input !== 'object') fail('config must be an object');
  const name = text(input.name);
  if (!name) fail('name is required');
  const protocol = text(input.protocol);
  if (!protocol) fail('protocol is required');
  if (!CUSTOM_PROVIDER_PROTOCOLS.includes(protocol)) fail(`unsupported protocol: ${protocol}`);
  return {
    type: 'custom',
    name,
    protocol,
    baseURL: normalizeBaseURL(input.baseURL),
    models: normalizeModels(input.models, requireModels),
    enabled: true,
  };
}

function modelRow(id, m) {
  return {
    id: m.id,
    name: m.name || m.id,
    provider: id,
    contextWindow: m.contextWindow || 0,
    outputTokens: m.maxOutputTokens || null,
  };
}

// Configured models win; an empty list falls back to protocol discovery.
function withConfiguredModels(Base, discover) {
  return class extends Base {
    _customModels = [];
    async listModels() {
      if (!this._customModels.length) return discover(this);
      if ('_enrichedModels' in this) this._enrichedModels = this._customModels;
      return this._customModels.map((m) => ({ ...m }));
    }
    async isAvailable() {
      return this._customModels.length ? true : super.isAvailable();
    }
    getCachedModelInfo(model) {
      return this._customModels.find((m) => m.id === model) || super.getCachedModelInfo?.(model) || null;
    }
  };
}

async function discoverAnthropicModels(provider) {
  const res = await fetch(`${provider.config.baseURL}/v1/models`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
    headers: { 'x-api-key': provider.apiKey || '', 'anthropic-version': ANTHROPIC_VERSION },
  });
  if (!res.ok) throw new Error(`${provider.name} models ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data?.data) ? data.data : [];
  return items
    .filter((m) => m?.id)
    .map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      provider: provider.name,
      contextWindow: Number(m.max_input_tokens) > 0 ? Number(m.max_input_tokens) : 0,
      outputTokens: Number(m.max_tokens) > 0 ? Number(m.max_tokens) : null,
    }));
}

export async function createCustomProvider(id, config) {
  const providerId = text(id);
  if (!/^custom-.+/.test(providerId)) fail(`invalid custom provider id: ${id}`);
  const cfg = normalizeCustomProviderConfig(config, { requireModels: false });
  const engine = {
    baseURL: cfg.baseURL,
    apiKey: config.apiKey || undefined,
    ...(config.preconnect === false ? { preconnect: false } : {}),
  };
  let provider;
  if (cfg.protocol === 'anthropic') {
    const { AnthropicProvider } = await import('./anthropic.mjs');
    const Custom = withConfiguredModels(AnthropicProvider, discoverAnthropicModels);
    // The Anthropic SDK appends /v1/messages itself; accept a /v1 base URL.
    provider = new Custom({ ...engine, name: providerId, baseURL: cfg.baseURL.replace(/\/v1$/i, '') });
  } else {
    const { OpenAICompatProvider } = await import('./openai-compat.mjs');
    const Base =
      cfg.protocol === 'openai-responses'
        ? class extends OpenAICompatProvider {
            _doSend(messages, model, tools, sendOpts) {
              return super._doSend(messages, model, tools, { ...(sendOpts || {}), compatWireApi: 'responses' });
            }
          }
        : OpenAICompatProvider;
    const Custom = withConfiguredModels(Base, (self) => listCompatModels(self, { throwOnError: true }));
    provider = new Custom(providerId, engine);
    if (cfg.models.length) provider.defaultModel = cfg.models[0].id;
  }
  provider._customModels = cfg.models.map((m) => modelRow(providerId, m));
  provider.customConfig = cfg;
  return provider;
}
