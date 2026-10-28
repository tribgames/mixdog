// User-defined ("custom") providers. A custom provider is stored as a
// secret-free config entry keyed by a generated `custom-<uuid>` id; the API key
// lives in the keychain under that same id and is injected at load time. The
// runtime reuses the existing OpenAI-compat / Anthropic engines, constructed
// under the custom id so model routes and provider identity stay `custom-…`.

import { resolveProviderApiKey } from '../../../shared/provider-api-key.mjs';
import {
  CUSTOM_PROTOCOL_WIRES,
  effectiveCustomModelRows,
  normalizeCustomProviderConfig,
} from './custom-provider-config.mjs';
import {
  customWireProfile,
  providerOffersWire,
  registerWireProfile,
  resolveWireRoute,
  sendOnRoute,
} from './wire-route.mjs';
import { withInclusiveUsage } from './lib/inclusive-usage.mjs';
import { ANTHROPIC_VERSION } from './lib/anthropic-models.mjs';
import { enrichModels } from './model-catalog.mjs';
import { fetchCompatModelItems, listCompatModels } from './openai-compat-models.mjs';

export {
  CUSTOM_PROVIDER_PROTOCOLS,
  CUSTOM_PROVIDER_SCHEMA_VERSION,
  CUSTOM_REASONING_LEVELS,
  assertCustomReasoningPatch,
  canonicalReasoningLevel,
  effectiveCustomModelRows,
  normalizeCustomProviderConfig,
} from './custom-provider-config.mjs';

const DISCOVERY_TIMEOUT_MS = 10_000;

// Discovery error safe to surface: the key is redacted, the HTTP status kept.
function sanitizeDiscoveryError(error, apiKey) {
  let message = String(error?.message || error || 'model discovery failed');
  if (apiKey) message = message.split(apiKey).join('[redacted]');
  const out = new Error(message);
  if (Number.isInteger(error?.status)) out.status = error.status;
  if (error?.code === 'EPROVIDERTIMEOUT' || error?.name === 'TimeoutError') out.code = 'EPROVIDERTIMEOUT';
  return out;
}

// Discovery always runs; overrides layer on top. A failed discovery keeps the
// last successful discovered rows plus manual rows, and throws only when
// nothing is usable or the caller asks (`throwOnError`). The sanitized error
// of the latest attempt is kept in `customDiscoveryError` (null on success).
function withCustomModels(Base, discover) {
  return class extends Base {
    customConfig = null;
    customDiscoveryError = null;
    _customDiscovered = null;
    _customKeyless = false;
    // The key for discovery and error redaction, resolved per use like sends.
    _customKey() {
      return this._customKeyless ? '' : resolveProviderApiKey(this.name, this.config);
    }
    // Env mode with the variable unset: fail before any request is sent.
    _assertCustomKey() {
      const name = this.customConfig?.apiKeyEnv;
      if (name && !this._customKeyless && !resolveProviderApiKey(this.name, this.config))
        throw new Error(`API key environment variable ${name} is not set`);
    }
    // A 401 reload must not fall back to the stale key once the variable is
    // gone; with a new value the base reload picks it up for the retry.
    reloadApiKey() {
      this._assertCustomKey();
      return super.reloadApiKey();
    }
    async send(...args) {
      this._assertCustomKey();
      return super.send(...args);
    }
    _customRows() {
      return effectiveCustomModelRows(this.customConfig, this._customDiscovered || [], { providerId: this.name });
    }
    _applyCustomRows(rows) {
      this._enrichedModels = rows;
      if (rows.some((row) => row.id === this.defaultModel && !row.hidden)) return;
      const first = rows.find((row) => !row.hidden);
      if (first) this.defaultModel = first.id;
    }
    // `timeoutMs` lets an interactive caller wait longer than the default
    // catalog timeout (slow gateways); the runtime refresh keeps the default.
    async listModels({ signal = null, throwOnError = false, timeoutMs } = {}) {
      let failure = null;
      try {
        this._assertCustomKey();
        this._customDiscovered = await discover(this, signal, timeoutMs);
        this.customDiscoveryError = null;
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = sanitizeDiscoveryError(error, this._customKey());
        this.customDiscoveryError = failure;
      }
      const rows = this._customRows();
      this._applyCustomRows(rows);
      if (failure && (throwOnError || rows.length === 0)) throw failure;
      return rows.map((row) => structuredClone(row));
    }
    async isAvailable() {
      if (this._enrichedModels?.length) return true;
      if (this._customKeyless && this.customConfig.protocol === 'anthropic') return true;
      return super.isAvailable();
    }
    getCachedModelInfo(model) {
      return this._enrichedModels?.find((row) => row.id === model) || null;
    }
  };
}

async function discoverAnthropicModels(provider, signal, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${provider.config.baseURL}/v1/models`, {
    method: 'GET',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      ...(provider._customKeyless ? {} : { 'x-api-key': provider._customKey() }),
      'anthropic-version': ANTHROPIC_VERSION,
      ...(provider.config.extraHeaders || {}),
    },
  });
  if (!res.ok) throw Object.assign(new Error(`${provider.name} models ${res.status}`), { status: res.status });
  const data = await res.json();
  const items = Array.isArray(data?.data) ? data.data : [];
  const rows = items
    .filter((m) => m?.id)
    .map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      provider: provider.name,
      contextWindow: Number(m.max_input_tokens) > 0 ? Number(m.max_input_tokens) : 0,
      outputTokens: Number(m.max_tokens) > 0 ? Number(m.max_tokens) : null,
    }));
  return enrichModels(rows);
}

export async function createCustomProvider(id, config) {
  const providerId = typeof id === 'string' ? id.trim() : '';
  if (!/^custom-.+/.test(providerId)) throw new Error(`[custom-provider] invalid custom provider id: ${id}`);
  const cfg = normalizeCustomProviderConfig(config);
  // `auth: 'none'` is authoritative: a supplied/injected key is ignored and
  // `keyless` makes the engine omit every credential header.
  const keyless = cfg.auth === 'none';
  // Env mode: the named variable is the only key source.
  let apiKey = '';
  if (cfg.apiKeyEnv) apiKey = process.env[cfg.apiKeyEnv] || '';
  else if (!keyless) apiKey = config.apiKey || '';
  const engine = {
    baseURL: cfg.baseURL,
    apiKey: apiKey || undefined,
    ...(cfg.apiKeyEnv ? { apiKeyEnv: cfg.apiKeyEnv } : {}),
    ...(keyless ? { keyless: true } : {}),
    // User-defined headers ride the engines' existing `extraHeaders` path.
    ...(cfg.headers ? { extraHeaders: cfg.headers } : {}),
    ...(config.preconnect === false ? { preconnect: false } : {}),
  };
  let provider;
  if (cfg.protocol === 'anthropic') {
    const { AnthropicProvider } = await import('./anthropic.mjs');
    const Custom = withCustomModels(AnthropicProvider, discoverAnthropicModels);
    // The Anthropic SDK appends /v1/messages itself; accept a /v1 base URL.
    provider = new Custom({ ...engine, name: providerId, baseURL: cfg.baseURL.replace(/\/v1$/i, '') });
    // An unknown third-party gateway behind the Anthropic wire: PDFs lower to text.
    provider.nativePdf = false;
  } else {
    const { OpenAICompatProvider } = await import('./openai-compat.mjs');
    // The wires the endpoint is declared to serve (default: the protocol's
    // own) and the per-model `modelWires` override pick each model's wire
    // through the shared wire-route table, pinned per session like a gateway.
    registerWireProfile(
      providerId,
      customWireProfile({ protocolWire: CUSTOM_PROTOCOL_WIRES[cfg.protocol], wires: cfg.wires })
    );
    let messagesEngine = null;
    if (providerOffersWire(providerId, 'messages')) {
      const { AnthropicProvider } = await import('./anthropic.mjs');
      // The Anthropic SDK appends /v1/messages itself; the endpoint's /v1 base maps to it.
      messagesEngine = new AnthropicProvider({
        ...engine,
        name: providerId,
        baseURL: cfg.baseURL.replace(/\/v1$/i, ''),
      });
      messagesEngine.nativePdf = false;
    }
    class CompatBase extends OpenAICompatProvider {
      messagesEngine = messagesEngine;
      _fetchModelItems({ signal = null, timeoutMs } = {}) {
        return fetchCompatModelItems(this, { signal, timeoutMs, keyless: this._customKeyless });
      }
      resolveWireRoute(model, ctx = {}) {
        return resolveWireRoute(this.name, model, { ...ctx, override: cfg.modelWires?.[model] ?? null });
      }
      send(messages, model, tools, sendOpts) {
        const useModel = model || this.defaultModel;
        // The resolved route is the only wire authority: a caller's own wire
        // switches never reach the engine. A custom provider declares the
        // wires its endpoint serves, so a clear "unsupported" refusal moves
        // the send to another declared wire once (sendOnRoute).
        return sendOnRoute(this, useModel, tools, sendOpts, messages, (wire, history, opts) => {
          if (wire === 'messages' && this.messagesEngine) {
            return withInclusiveUsage(() => this.messagesEngine.send(history, useModel, tools, opts));
          }
          if (wire === 'responses') return super.send(history, model, tools, { ...opts, compatWireApi: 'responses' });
          return super.send(history, model, tools, opts);
        });
      }
    }
    const Custom = withCustomModels(CompatBase, (self, signal, timeoutMs) =>
      listCompatModels(self, { throwOnError: true, signal, timeoutMs })
    );
    provider = new Custom(providerId, engine);
  }
  // The bound Messages engine reads the parent's model rows, so a routed
  // Messages request carries the same row-driven thinking/effort as the
  // Anthropic protocol.
  if (provider.messagesEngine)
    provider.messagesEngine.getCachedModelInfo = (model) => provider.getCachedModelInfo(model);
  provider.customConfig = cfg;
  provider._customKeyless = keyless;
  provider._applyCustomRows(provider._customRows());
  return provider;
}
