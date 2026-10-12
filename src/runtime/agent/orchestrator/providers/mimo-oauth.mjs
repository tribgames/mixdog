/**
 * Xiaomi MiMo subscription provider.
 *
 * Credentials are a platform-issued API key (mimo-oauth-tokens.mjs). Requests
 * go through an inner OpenAI-compatible Chat Completions client pointed at the
 * stored base URL. The key never expires and has no refresh grant: a 401 means
 * the user must sign in again.
 */
import { noteErrorUsage } from './lib/note-error-usage.mjs';
import { fileMtimeMs, scrubOAuthSecrets } from './lib/oauth-token-utils.mjs';
import { OpenAICompatProvider, preloadOpenAICompatRuntime } from './openai-compat.mjs';
import { fetchCompatModelItems, listCompatModels } from './openai-compat-models.mjs';
import {
  SOURCE_HEADER,
  ensureTokenPlanBaseUrl,
  getOwnTokenPath,
  loadTokens,
  mimoReauthError,
} from './mimo-oauth-tokens.mjs';
import {
  MIMO_CHAT_PROFILE,
  chooseDefaultModel,
  decorateModelRows,
  isChatModelId,
  mimoErrorDetail,
  mimoRequestHeaders,
  seedModelItems,
} from './mimo-oauth-profile.mjs';

const isUnauthorized = (err) => Number(err?.httpStatus || err?.status) === 401;

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
  if (!completions || !apiKey || completions.create?.mimoRedacting === apiKey) return;
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
  wrapped.mimoRedacting = apiKey;
  completions.create = wrapped;
}

export {
  hasMimoOAuthCredentials,
  describeMimoOAuthCredentials,
  forgetMimoOAuthCredentials,
} from './mimo-oauth-tokens.mjs';
export { beginOAuthLogin, loginOAuth } from './mimo-oauth-login.mjs';

export class MimoOAuthProvider {
  // No document block on this wire: a PDF is lowered to text before the request is built.
  nativePdf = false;
  // OpenAI-compatible usage: prompt_tokens includes cached. See registry.mjs.
  static inputExcludesCache = false;
  name = 'mimo-oauth';
  config;
  tokens = null;
  _inner = null;
  _innerKey = null;
  _rosterItems = [];
  _defaultModelKey = null;
  _defaultModel = null;

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
    }
    if (!this.tokens || mtime > (this.tokens.mtimeMs || 0)) this.tokens = loadTokens() || this.tokens;
    if (!this.tokens?.apiKey) {
      throw new Error('[mimo-oauth] credentials not found — open /providers in mixdog to sign in first');
    }
    return this.tokens;
  }

  _ensureInner() {
    const { apiKey, baseUrl } = this.ensureAuth();
    const key = `${baseUrl}:${apiKey}`;
    if (this._inner && this._innerKey === key) return this._inner;
    const inner = new OpenAICompatProvider('mimo-oauth', {
      ...this.config,
      apiKey,
      baseURL: baseUrl,
      chatProfile: MIMO_CHAT_PROFILE,
      // Explicit nulls keep OPENAI_ORG_ID / OPENAI_PROJECT_ID out of the requests.
      clientOptions: { organization: null, project: null },
      extraHeaders: { ...SOURCE_HEADER, Accept: 'application/json' },
    });
    inner._fetchModelItems = (args) => this._fetchRoster(inner, args);
    redactClientErrors(inner.client, apiKey);
    this._inner = inner;
    this._innerKey = key;
    return inner;
  }

  // Chat models from /models; a failed or empty listing falls back to the local
  // seed roster. Only a rejected key is surfaced.
  async _fetchRoster(inner, args) {
    let items = [];
    try {
      items = (await fetchCompatModelItems(inner, args)).filter((item) => isChatModelId(item?.id));
    } catch (err) {
      if (isUnauthorized(err)) throw err;
    }
    if (!items.length) items = seedModelItems();
    this._rosterItems = items;
    return items;
  }

  // Shared send/list error shaping, also applied to credential setup failures.
  // A rejected key needs a fresh sign-in; the gateway's own detail stays attached.
  _shapeError(err, apiKey) {
    noteErrorUsage(err);
    if (isUnauthorized(err) && !err?.reauthRequired) return mimoReauthError(mimoErrorDetail(err, [apiKey]));
    return err;
  }

  async _readyInner(signal = null) {
    this.tokens = await ensureTokenPlanBaseUrl(this.ensureAuth(), { fetchImpl: this.config.fetchImpl, signal });
    return this._ensureInner();
  }

  // Configured model wins; otherwise pick from this credential's own roster.
  async _pickDefaultModel(inner) {
    if (this._defaultModel && this._defaultModelKey === this._innerKey) return this._defaultModel;
    await this._listRows(inner);
    this._defaultModel = chooseDefaultModel(this._enrichedIds(inner));
    this._defaultModelKey = this._innerKey;
    return this._defaultModel;
  }

  _enrichedIds(inner) {
    return (inner._enrichedModels || []).map((row) => row.id);
  }

  async _listRows(inner) {
    const rows = decorateModelRows(await listCompatModels(inner, { throwOnError: true }), this._rosterItems);
    inner._enrichedModels = rows;
    return rows;
  }

  async send(messages, model, tools, sendOpts) {
    let inner;
    try {
      inner = await this._readyInner(sendOpts?.signal || null);
    } catch (err) {
      throw this._shapeError(err, this.tokens?.apiKey);
    }
    const apiKey = this.tokens.apiKey;
    // This wire is Chat Completions only; a caller cannot move it to Responses.
    const { compatWireApi: _wire, responsesTransport: _transport, ...rest } = sendOpts || {};
    const opts = { ...rest, requestHeaders: { ...mimoRequestHeaders(rest), ...rest.requestHeaders } };
    try {
      const useModel = model || (await this._pickDefaultModel(inner));
      // _doSend directly: the compat wrapper's 401 handler reloads a static
      // config key, which does not apply to this credential.
      return await inner._doSend(messages, useModel, tools, opts);
    } catch (err) {
      throw this._shapeError(err, apiKey);
    }
  }

  async listModels() {
    let inner;
    try {
      inner = await this._readyInner();
      return await this._listRows(inner);
    } catch (err) {
      throw this._shapeError(err, this.tokens?.apiKey);
    }
  }

  async isAvailable() {
    return loadTokens() !== null;
  }
}
