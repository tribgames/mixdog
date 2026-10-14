/**
 * Command Code provider (commandcode.ai Provider API).
 *
 * Credentials are a Studio-issued API key (command-code-oauth-tokens.mjs).
 * Each model is served on the endpoint its /models row declares: Chat
 * Completions through the OpenAI-compatible engine, Messages-only models
 * (Claude) through the Anthropic engine. Both clients are pinned to the
 * Command Code API host. The key never expires and has no refresh grant: a
 * 401 means the user must sign in again.
 */
import { noteErrorUsage } from './lib/note-error-usage.mjs';
import { fileMtimeMs, normalizeExpiresAtMs, scrubOAuthSecrets } from './lib/oauth-token-utils.mjs';
import { OpenAICompatProvider, preloadOpenAICompatRuntime } from './openai-compat.mjs';
import { listCompatModels } from './openai-compat-models.mjs';
import { AnthropicProvider } from './anthropic.mjs';
import { toInclusiveOpenCodeGoUsage as toInclusiveUsage } from './opencode-go.mjs';
import { sanitizeToolPairs } from '../session/context-utils.mjs';
import { preparePdfTextForProvider } from './media-normalization.mjs';
import { currentUsageContext } from '../../../shared/llm/usage-context.mjs';
import { makeModelCache } from './model-cache.mjs';
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
const CHAT_ENDPOINT = '/chat/completions';
const MESSAGES_ENDPOINT = '/messages';
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
 * The wire a /models row is served on: 'chat' when it declares Chat
 * Completions or declares no endpoints at all, 'messages' when it declares
 * only Messages, null when it declares neither.
 */
export function modelWire(item) {
  if (typeof item?.id !== 'string' || !item.id) return null;
  const endpoints = item.supported_endpoints;
  if (!Array.isArray(endpoints)) return 'chat';
  const declared = endpoints.map((endpoint) => String(endpoint).replace(/^\/?(?:provider\/)?(?:v1\/)?/, '/'));
  if (declared.includes(CHAT_ENDPOINT)) return 'chat';
  if (declared.includes(MESSAGES_ENDPOINT)) return 'messages';
  return null;
}

// Every request either engine makes goes through this fetch: anything outside
// the Command Code API origin is refused before the key leaves the process,
// and redirects are never followed (any 3xx is an error).
function apiOnlyFetch(fetchImpl) {
  return async (input, init) => {
    const url = new URL(String(input?.url ?? input));
    if (url.origin !== API_ORIGIN) {
      throw new Error(`[command-code-oauth] refusing to send the API key to ${url.host}`);
    }
    const res = await (fetchImpl || globalThis.fetch)(input, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`[command-code-oauth] refusing to follow a redirect from ${url.host}`);
    }
    return res;
  };
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
}

const normalizeUsageError = (err) => {
  if (err && typeof err === 'object') {
    if (err.usage) err.usage = toInclusiveUsage(err.usage);
    if (err.partialUsage) err.partialUsage = toInclusiveUsage(err.partialUsage);
  }
  return err;
};

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
// iteration), so the shared retry reporter never logs the key.
function redactClientErrors(client, apiKey) {
  const completions = client?.chat?.completions;
  if (!completions || !apiKey || completions.create?.commandCodeRedacting === apiKey) return;
  const create = completions.create.bind(completions);
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
  completions.create = wrapped;
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
  config;
  tokens = null;
  _inner = null;
  _innerKey = null;
  _defaultModel = null;
  _defaultModelKey = null;
  _messages = null;
  _messagesKey = null;
  // Model id → wire ('chat' | 'messages') from the roster fetched with `_wiresKey`.
  _wires = new Map();
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
      // x-api-key from the SDK plus the bearer form of the same key.
      extraHeaders: { Authorization: `Bearer ${apiKey}` },
    });
    redactMessagesErrors(engine.client, apiKey);
    this._messages = engine;
    this._messagesKey = apiKey;
    return engine;
  }

  // Servable rows from /models; only the latest fetch with the still-active
  // key publishes the roster and the per-model wire map.
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
    publish(items.map(rosterRow));
    if (this.tokens?.apiKey === apiKey) {
      this._wires = new Map(items.map((item) => [item.id, modelWire(item)]));
      this._wiresKey = apiKey;
    }
    return items;
  }

  // The wire for a model, from this credential's roster (fetched once when
  // missing). A model the roster does not know, or a roster that cannot be
  // read right now, stays on Chat Completions; a rejected key is surfaced.
  async _wireFor(inner, model) {
    if (this._wiresKey !== inner.apiKey) {
      try {
        await listCompatModels(inner, { throwOnError: true });
      } catch (err) {
        if (isUnauthorized(err)) throw err;
      }
    }
    return (this._wiresKey === inner.apiKey && this._wires.get(model)) || 'chat';
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
    // The model's declared endpoint picks the wire; a caller cannot move a
    // model to Responses.
    const { compatWireApi: _wire, responsesTransport: _transport, ...opts } = sendOpts || {};
    try {
      const useModel = model || (await this._pickDefaultModel(inner));
      if ((await this._wireFor(inner, useModel)) === 'messages') {
        return await this._sendMessages(apiKey, messages, useModel, tools, opts);
      }
      // _doSend directly: the compat wrapper's 401 handler reloads a static
      // config key, which does not apply to this credential.
      return await inner._doSend(messages, useModel, tools, opts);
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
    const identity = currentUsageContext();
    if (identity) identity.normalizeAbandonedUsage = toInclusiveUsage;
    try {
      const result = await engine._doSend(prepared, model, tools, opts);
      return result?.usage ? { ...result, usage: toInclusiveUsage(result.usage) } : result;
    } catch (err) {
      throw normalizeUsageError(err);
    }
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
