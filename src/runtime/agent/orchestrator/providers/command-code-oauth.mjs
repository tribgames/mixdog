/**
 * Command Code provider (commandcode.ai Provider API).
 *
 * Credentials are a Studio-issued API key (command-code-oauth-tokens.mjs).
 * Each model is served on a wire its /models row declares (wire-route.mjs
 * picks among them): Chat Completions and Responses through the
 * OpenAI-compatible engine, Messages through the Anthropic engine. Both
 * clients are pinned to the Command Code API host. The key never expires and
 * has no refresh grant: a 401 means the user must sign in again.
 */
import { noteErrorUsage } from './lib/note-error-usage.mjs';
import { fileMtimeMs, normalizeExpiresAtMs, scrubOAuthSecrets } from './lib/oauth-token-utils.mjs';
import { originBoundFetch } from './lib/origin-bound-fetch.mjs';
import { withInclusiveUsage } from './lib/inclusive-usage.mjs';
import { OpenAICompatProvider, preloadOpenAICompatRuntime } from './openai-compat.mjs';
import { COMPAT_RETRY_POLICY } from './openai-compat-retry-profile.mjs';
import { listCompatModels } from './openai-compat-models.mjs';
import { AnthropicProvider } from './anthropic.mjs';
import { sanitizeToolPairs } from '../session/context-utils.mjs';
import { preparePdfTextForProvider } from './media-normalization.mjs';
import { makeModelCache } from './model-cache.mjs';
import { resolveWireRoute, sendOnRoute } from './wire-route.mjs';
import { gatewayMessagesOpts } from './wire-gateway.mjs';
import {
  API_ORIGIN,
  CREDITS_URL,
  PROVIDER_BASE_URL,
  PROVIDER_ID,
  commandCodeReauthError,
  getOwnTokenPath,
  loadTokens,
  requestCommandCodeJson,
} from './command-code-oauth-tokens.mjs';

export {
  hasCommandCodeOAuthCredentials,
  describeCommandCodeOAuthCredentials,
  forgetCommandCodeOAuthCredentials,
} from './command-code-oauth-tokens.mjs';
export { beginOAuthLogin, loginOAuth } from './command-code-oauth-login.mjs';

export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const ENDPOINT_WIRES = Object.freeze({
  '/chat/completions': 'chat',
  '/messages': 'messages',
  '/responses': 'responses',
});
// The Anthropic SDK appends /v1/messages itself.
const MESSAGES_BASE_URL = `${API_ORIGIN}/provider`;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const isUnauthorized = (err) => Number(err?.httpStatus || err?.status) === 401;

// The discovered roster (what /models returned) is persisted so the shared
// sync lookup sees what listModels found.
const commandCodeModelCache = makeModelCache({
  fileName: 'command-code-oauth-models.json',
  ttlMs: 24 * 60 * 60 * 1000,
  version: 1,
});

/**
 * The wires a /models row declares (`supported_endpoints`), or null when it
 * declares none — such a row is served on Chat Completions by convention.
 */
export function modelEndpoints(item) {
  const declared = item?.supported_endpoints;
  if (!Array.isArray(declared)) return null;
  const wires = [];
  for (const endpoint of declared) {
    const path = String(endpoint).replace(/^\/?(?:provider\/)?(?:v1\/)?/, '/');
    const wire = Object.hasOwn(ENDPOINT_WIRES, path) ? ENDPOINT_WIRES[path] : null;
    if (wire && !wires.includes(wire)) wires.push(wire);
  }
  return wires;
}

// The route for a model with these declared endpoints (null: undeclared, Chat).
// `undefined`: nothing describes the model, so no wire is ruled out.
function commandCodeRoute(model, endpoints, ctx = {}) {
  return resolveWireRoute(PROVIDER_ID, model, {
    ...ctx,
    endpoints: endpoints === undefined ? null : (endpoints ?? ['chat']),
  });
}

/**
 * The wire a /models row is served on (wire-route.mjs over its declared
 * endpoints): Responses for GPT / Muse / Grok when advertised, otherwise Chat
 * when declared or undeclared, Messages when it is the only one, Responses
 * for a Responses-only row; null when it declares none of them.
 */
export function modelWire(item) {
  if (typeof item?.id !== 'string' || !item.id) return null;
  return commandCodeRoute(item.id, modelEndpoints(item))?.wire || null;
}

// Every request either engine makes goes through this fetch: only the Command
// Code API origin, never a redirect.
function apiOnlyFetch(fetchImpl) {
  return originBoundFetch(API_ORIGIN, fetchImpl, PROVIDER_ID);
}

// Anthropic engine bound to this credential: only the Command Code key is
// sent (never an ANTHROPIC_AUTH_TOKEN from the environment) and only to the
// Command Code API host.
class CommandCodeMessagesEngine extends AnthropicProvider {
  nativePdf = false;
  _createClient(apiKey) {
    const client = super._createClient(apiKey);
    client.authToken = null;
    client.fetch = apiOnlyFetch(this.config.fetchImpl);
    return client;
  }
  // The roster's output ceiling reaches the shared request builder.
  _sendOnce(messages, model, tools, opts) {
    return super._sendOnce(messages, model, tools, gatewayMessagesOpts(this.config, model, messages, opts));
  }
}

function rosterRow(item) {
  const contextWindow = Number(item.context_window ?? item.max_context_window ?? item.context_length ?? 0);
  const outputTokens = Number(item.max_output_tokens ?? item.output_tokens ?? 0);
  const name = [item.display_name, item.name].find((v) => typeof v === 'string' && v.trim());
  return {
    id: item.id,
    provider: PROVIDER_ID,
    ...(name ? { name: name.trim() } : {}),
    ...(contextWindow > 0 ? { contextWindow } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    // The full declared endpoint set: the cached route metadata a later
    // send falls back on when the live roster cannot be read.
    ...(Array.isArray(item.supported_endpoints)
      ? { supportedEndpoints: item.supported_endpoints.map((endpoint) => String(endpoint)) }
      : {}),
  };
}

export function chooseDefaultModel(ids) {
  const list = ids || [];
  return list.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : list[0] || DEFAULT_MODEL;
}

// Strip the key from an error (message plus any echoed gateway body).
function scrubErrorSecrets(err, apiKey) {
  if (!err || typeof err !== 'object' || !apiKey) return err;
  const seen = new Set();
  const walk = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > 4) return;
    seen.add(obj);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        if (v.includes(apiKey)) obj[k] = scrubOAuthSecrets(v, [apiKey]);
      } else walk(v, depth + 1);
    }
  };
  if (typeof err.message === 'string') err.message = scrubOAuthSecrets(err.message, [apiKey]);
  walk(err.error, 0);
  walk(err.body, 0);
  return err;
}

// Redact where the transport first surfaces errors (request open and stream
// iteration) on the Chat and Responses endpoints, so the shared retry
// reporter never logs the key.
function redactClientErrors(client, apiKey) {
  redactCreateErrors(client?.chat?.completions, apiKey);
  redactCreateErrors(client?.responses, apiKey);
}

function redactCreateErrors(endpoint, apiKey) {
  if (!endpoint || !apiKey || endpoint.create?.commandCodeRedacting === apiKey) return;
  const create = endpoint.create.bind(endpoint);
  const wrapped = async (...args) => {
    try {
      const stream = await create(...args);
      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = () => {
          const it = iterate();
          return {
            next: async (...a) => {
              try {
                return await it.next(...a);
              } catch (err) {
                throw scrubErrorSecrets(err, apiKey);
              }
            },
            return: (...a) => it.return?.(...a),
          };
        };
      }
      return stream;
    } catch (err) {
      throw scrubErrorSecrets(err, apiKey);
    }
  };
  wrapped.commandCodeRedacting = apiKey;
  endpoint.create = wrapped;
}

// Same for the Anthropic client's streaming request (read through
// `.asResponse()`); every other failure is scrubbed by _shapeError.
function redactMessagesErrors(client, apiKey) {
  const messages = client?.messages;
  if (!messages || !apiKey || messages.create?.commandCodeRedacting === apiKey) return;
  const create = messages.create.bind(messages);
  const wrapped = (...args) => {
    const request = create(...args);
    const asResponse = request?.asResponse?.bind(request);
    if (asResponse) {
      request.asResponse = () =>
        asResponse().catch((err) => {
          throw scrubErrorSecrets(err, apiKey);
        });
    }
    return request;
  };
  wrapped.commandCodeRedacting = apiKey;
  messages.create = wrapped;
}

function usageStatus(usedFraction) {
  if (usedFraction >= 1) return 'exhausted';
  if (usedFraction >= 0.9) return 'warning';
  return 'ok';
}

function creditWindow({ id, label, longLabel, durationMs }, entry) {
  const cap = Number(entry?.cap);
  const used = Number(entry?.used);
  if (!entry || !Number.isFinite(cap) || cap <= 0 || !Number.isFinite(used) || used < 0) return null;
  const usedPct = Math.min(100, (used / cap) * 100);
  const usedFraction = usedPct / 100;
  const resetAt = normalizeExpiresAtMs(entry.resetAt);
  return {
    id,
    label,
    longLabel,
    source: 'command-code-credits',
    usedPct: Math.round(usedPct * 100) / 100,
    usedFraction,
    remainingFraction: 1 - usedFraction,
    status: usageStatus(usedFraction),
    durationMs,
    ...(resetAt ? { resetAt } : {}),
  };
}

/** Map `/alpha/billing/credits` windowLimits onto the shared quota-window shape. */
export function quotaWindowsFromCredits(body) {
  const limits = (body?.data ?? body)?.windowLimits;
  return [
    creditWindow({ id: '5h', label: '5H', longLabel: '5 Hours', durationMs: FIVE_HOURS_MS }, limits?.fiveHour),
    creditWindow({ id: '1w', label: '7D', longLabel: 'Weekly', durationMs: WEEK_MS }, limits?.weekly),
  ].filter(Boolean);
}

export class CommandCodeOAuthProvider {
  // No document block on this wire: a PDF is lowered to text before the request is built.
  nativePdf = false;
  // OpenAI-compatible usage: prompt_tokens includes cached. See registry.mjs.
  static inputExcludesCache = false;
  name = PROVIDER_ID;
  // The retry profile's limits are final: no loop-level recovery cycles on top.
  retryPolicy = COMPAT_RETRY_POLICY;
  config;
  tokens = null;
  _inner = null;
  _innerKey = null;
  _defaultModel = null;
  _defaultModelKey = null;
  _messages = null;
  _messagesKey = null;
  // Model id → declared endpoint wires (null: undeclared) from the roster
  // fetched with `_wiresKey`.
  _endpoints = new Map();
  _wiresKey = null;

  constructor(config) {
    this.config = config || {};
    this.tokens = loadTokens();
    try {
      preloadOpenAICompatRuntime();
    } catch {
      /* authoritative send surfaces load failures */
    }
  }

  ensureAuth() {
    // Re-read when the token file changed (sign-in from another process).
    const mtime = fileMtimeMs(getOwnTokenPath());
    if (!mtime) {
      // File gone (signed out / forgotten): drop every cached credential.
      this.tokens = null;
      this._inner = null;
      this._innerKey = null;
      this._messages = null;
      this._messagesKey = null;
    }
    if (!this.tokens || mtime > (this.tokens.mtimeMs || 0)) this.tokens = loadTokens() || this.tokens;
    if (!this.tokens?.apiKey) {
      throw new Error('[command-code-oauth] credentials not found — open /providers in mixdog to sign in first');
    }
    return this.tokens;
  }

  _ensureInner() {
    const { apiKey } = this.ensureAuth();
    if (this._inner && this._innerKey === apiKey) return this._inner;
    const { fetchImpl, baseURL: _ignored, ...config } = this.config;
    const inner = new OpenAICompatProvider(PROVIDER_ID, {
      ...config,
      apiKey,
      // Fixed: the key is only ever sent to the Command Code API host.
      baseURL: PROVIDER_BASE_URL,
      // Explicit nulls keep OPENAI_ORG_ID / OPENAI_PROJECT_ID out of the requests.
      clientOptions: { organization: null, project: null, fetch: apiOnlyFetch(fetchImpl) },
      extraHeaders: { Accept: 'application/json' },
    });
    inner._fetchModelItems = ({ signal } = {}) => this._fetchRoster(apiKey, signal);
    redactClientErrors(inner.client, apiKey);
    this._inner = inner;
    this._innerKey = apiKey;
    return inner;
  }

  // The Anthropic engine for Messages-only models, on the same key and host.
  _ensureMessages(apiKey) {
    if (this._messages && this._messagesKey === apiKey) return this._messages;
    const { baseURL: _ignored, ...config } = this.config;
    const engine = new CommandCodeMessagesEngine({
      ...config,
      name: PROVIDER_ID,
      apiKey,
      baseURL: MESSAGES_BASE_URL,
      disableBetaHeaders: true,
      modelMaxOutputTokens: (model) =>
        commandCodeModelCache.loadSync({ allowStale: true })?.find((row) => row?.id === model)?.outputTokens,
      // x-api-key from the SDK plus the bearer form of the same key.
      extraHeaders: { Authorization: `Bearer ${apiKey}` },
    });
    redactMessagesErrors(engine.client, apiKey);
    this._messages = engine;
    this._messagesKey = apiKey;
    return engine;
  }

  // Servable rows from /models (any declared Chat, Messages or Responses
  // endpoint, or none declared); only the latest fetch with the still-active
  // key publishes the roster and the per-model endpoint map.
  async _fetchRoster(apiKey, signal = null) {
    const publish = commandCodeModelCache.beginSave(() => loadTokens()?.apiKey === apiKey);
    const body = await requestCommandCodeJson(`${PROVIDER_BASE_URL}/models`, apiKey, {
      fetchImpl: this.config.fetchImpl,
      signal,
    });
    let list = [];
    if (Array.isArray(body?.data)) list = body.data;
    else if (Array.isArray(body)) list = body;
    const items = list.filter((item) => modelWire(item));
    await publish(items.map(rosterRow));
    if (this.tokens?.apiKey === apiKey) {
      // Rows accumulate for one key: a later roster that misses a model
      // leaves the endpoints it was last listed with.
      const known = this._wiresKey === apiKey ? this._endpoints : new Map();
      for (const item of items) known.set(item.id, modelEndpoints(item));
      this._endpoints = known;
      this._wiresKey = apiKey;
    }
    return items;
  }

  // A model's declared endpoints: what this credential's rosters listed,
  // then the persisted roster (a roster miss or a roster that cannot be read
  // right now must not move a known Messages-only model to Chat). null is a
  // row declaring none (Chat); undefined is a model nothing describes.
  _endpointsFor(apiKey, model) {
    if (this._wiresKey === apiKey && this._endpoints.has(model)) return this._endpoints.get(model);
    const cached = commandCodeModelCache.loadSync({ allowStale: true })?.find((row) => row?.id === model);
    return cached ? modelEndpoints({ supported_endpoints: cached.supportedEndpoints }) : undefined;
  }

  // This credential's route for a model (the roster is fetched once when
  // missing; a roster that cannot be read falls back on the persisted rows);
  // a rejected key is surfaced.
  async _routeFor(inner, model, ctx = {}) {
    if (this._wiresKey !== inner.apiKey) {
      try {
        await listCompatModels(inner, { throwOnError: true });
      } catch (err) {
        if (isUnauthorized(err)) throw err;
      }
    }
    const endpoints = this._endpointsFor(inner.apiKey, model);
    return commandCodeRoute(model, endpoints, {
      ...ctx,
      override: this.config?.modelWires?.[model] ?? null,
      known: endpoints !== undefined,
    });
  }

  resolveWireRoute(model, ctx = {}) {
    return this._routeFor(this._ensureInner(), model, ctx);
  }

  // A rejected key needs a fresh sign-in; the gateway's own detail stays attached.
  _shapeError(err, apiKey) {
    noteErrorUsage(err);
    scrubErrorSecrets(err, apiKey);
    if (isUnauthorized(err) && !err?.reauthRequired) return commandCodeReauthError(String(err?.message || ''));
    return err;
  }

  async _pickDefaultModel(inner) {
    if (this._defaultModel && this._defaultModelKey === this._innerKey) return this._defaultModel;
    const rows = await listCompatModels(inner, { throwOnError: true });
    this._defaultModel = chooseDefaultModel(rows.map((row) => row.id));
    this._defaultModelKey = this._innerKey;
    return this._defaultModel;
  }

  async send(messages, model, tools, sendOpts) {
    let inner;
    try {
      inner = this._ensureInner();
    } catch (err) {
      throw this._shapeError(err, this.tokens?.apiKey);
    }
    const apiKey = this._innerKey;
    // The model's route (the session's pinned one, else its declared
    // endpoints) picks the wire; a caller's compat wire flag cannot move it.
    const { compatWireApi: _wire, responsesTransport: _transport, ...callerOpts } = sendOpts || {};
    try {
      const useModel = model || (await this._pickDefaultModel(inner));
      // One clear "unsupported" refusal moves the send to the next wire once.
      return await sendOnRoute(this, useModel, tools, callerOpts, messages, (wire, history, opts) => {
        if (wire === 'messages') return this._sendMessages(apiKey, history, useModel, tools, opts);
        // _doSend directly: the compat wrapper's 401 handler reloads a static
        // config key, which does not apply to this credential.
        if (wire === 'responses') {
          return inner._doSend(history, useModel, tools, { ...opts, compatWireApi: 'responses' });
        }
        return inner._doSend(history, useModel, tools, opts);
      });
    } catch (err) {
      throw this._shapeError(err, apiKey);
    }
  }

  // Messages wire. Same request preparation as the Anthropic engine's own
  // send, but straight to _doSend: its 401 handler re-reads a static config
  // key and replays, which does not apply to this credential. Anthropic usage
  // excludes cached input; it is reported in this provider's inclusive form.
  async _sendMessages(apiKey, messages, model, tools, opts) {
    const engine = this._ensureMessages(apiKey);
    const prepared = await preparePdfTextForProvider(sanitizeToolPairs(messages), engine);
    return withInclusiveUsage(() => engine._doSend(prepared, model, tools, opts));
  }

  async listModels() {
    let inner;
    try {
      inner = this._ensureInner();
      return await listCompatModels(inner, { throwOnError: true });
    } catch (err) {
      throw this._shapeError(err, this.tokens?.apiKey);
    }
  }

  /** 5-hour and weekly credit windows for this account's key. */
  async getUsageSnapshot() {
    const { apiKey, userId } = this.ensureAuth();
    const body = await requestCommandCodeJson(CREDITS_URL, apiKey, { fetchImpl: this.config.fetchImpl });
    const quotaWindows = quotaWindowsFromCredits(body);
    if (!quotaWindows.length) return null;
    return {
      provider: PROVIDER_ID,
      model: null,
      source: 'command-code-credits',
      fetchedAt: Date.now(),
      quotaWindows,
      ...(userId ? { accountId: userId } : {}),
    };
  }

  async isAvailable() {
    return loadTokens() !== null;
  }
}
