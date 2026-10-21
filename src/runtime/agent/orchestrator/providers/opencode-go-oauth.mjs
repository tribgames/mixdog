/**
 * OpenCode Go through an OpenCode Console OAuth login.
 *
 * The organization's remote config (`/api/v2/config` → providers.opencode-go)
 * is the authority for the inference base URL, the request headers and the
 * model catalog (the gateway's own `/models` is not served on this base).
 * When that config lists no models at all (the console serves `models: {}` for
 * an organization without overrides, as the OpenCode CLI sees it), the catalog
 * is the models.dev `opencode-go` provider, the list the CLI itself shows.
 * Requests run on the OpenCode Go gateway engines (opencode-go.mjs) with the
 * access token as the bearer; a 401 refreshes the token once and retries.
 */
import { scrubOAuthSecrets } from './lib/oauth-token-utils.mjs';
import { getModelMetadataSync, getModelsDevProviderModelsSync, loadModelsDevCatalog } from './model-catalog.mjs';
import { makeModelCache } from './model-cache.mjs';
import { OpenCodeGoProvider, WIRE_API_BY_NPM, resolveOpenCodeGoWireRoute } from './opencode-go.mjs';
import { fetchOpenCodeGoOAuthUsageSnapshot } from './opencode-go-usage.mjs';
import {
  CONFIG_PROVIDER_KEY,
  CONFIG_URL,
  FALLBACK_BASE_URL,
  PROVIDER_ID,
  consoleGetJson,
  ensureFreshTokens,
  loadTokens,
  openCodeGoError,
  openCodeGoReauthError,
} from './opencode-go-oauth-tokens.mjs';

export {
  hasOpenCodeGoOAuthCredentials,
  describeOpenCodeGoOAuthCredentials,
  forgetOpenCodeGoOAuthCredentials,
} from './opencode-go-oauth-tokens.mjs';
export { beginOAuthLogin, loginOAuth } from './opencode-go-oauth-login.mjs';

const CONFIG_TTL_MS = 10 * 60_000;

// The catalog the remote config listed, with the base URL and headers it
// named, so the shared sync lookup and a send whose config read fails see it.
const goModelCache = makeModelCache({ fileName: 'opencode-go-oauth-models.json', ttlMs: 24 * 60 * 60_000, version: 1 });

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
const finite = (value) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

function stringHeaders(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string'));
}

// The untiered price (or the first one) in USD per million tokens.
function costFields(cost) {
  const list = Array.isArray(cost) ? cost : [cost];
  const base = list.find((entry) => isPlainObject(entry) && !entry.tier) || list.find(isPlainObject);
  if (!base) return {};
  const fields = {
    inputCostPerM: finite(base.input),
    outputCostPerM: finite(base.output),
    cacheReadCostPerM: finite(base.cache?.read),
    cacheWriteCostPerM: finite(base.cache?.write),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
}

function reasoningFields(reasoning) {
  if (!isPlainObject(reasoning) || typeof reasoning.supported !== 'boolean') return {};
  if (!reasoning.supported) return { supportsReasoning: false, reasoningOptions: [], reasoningLevels: [] };
  const levels = Array.isArray(reasoning.effort) ? reasoning.effort.filter((v) => typeof v === 'string' && v) : [];
  return {
    supportsReasoning: true,
    ...(levels.length ? { reasoningOptions: [{ type: 'effort', values: levels }], reasoningLevels: levels } : {}),
  };
}

function catalogRow(id, model, providerPackage) {
  const name = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : id;
  const wirePackage = typeof model.package === 'string' ? model.package : providerPackage;
  const wire = Object.hasOwn(WIRE_API_BY_NPM, wirePackage || '') ? WIRE_API_BY_NPM[wirePackage] : null;
  const baseURL = typeof model.settings?.baseURL === 'string' ? model.settings.baseURL : '';
  const headers = stringHeaders(model.headers);
  return {
    id,
    provider: PROVIDER_ID,
    name,
    ...(positive(model.limit?.context) ? { contextWindow: positive(model.limit.context) } : {}),
    ...(positive(model.limit?.output) ? { outputTokens: positive(model.limit.output) } : {}),
    ...reasoningFields(model.capabilities?.reasoning),
    ...costFields(model.cost),
    ...(wire ? { wire } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

// A models.dev row in the remote config's model shape, for catalogRow.
function configModelFromModelsDev(row) {
  const cost = isPlainObject(row.cost) ? row.cost : null;
  const effort = Array.isArray(row.reasoning_options)
    ? row.reasoning_options.find((option) => option?.type === 'effort')?.values
    : null;
  return {
    name: row.name,
    ...(typeof row.npm === 'string' ? { package: row.npm } : {}),
    limit: row.limit,
    ...(cost
      ? { cost: { input: cost.input, output: cost.output, cache: { read: cost.cache_read, write: cost.cache_write } } }
      : {}),
    ...(typeof row.reasoning === 'boolean'
      ? { capabilities: { reasoning: { supported: row.reasoning, ...(effort ? { effort } : {}) } } }
      : {}),
  };
}

// models.dev serves the Go models over the OpenAI-compatible package unless a row names its own.
const MODELS_DEV_PROVIDER_PACKAGE = '@ai-sdk/openai-compatible';

const listsGoModels = (json) => Object.keys(json?.providers?.[CONFIG_PROVIDER_KEY]?.models || {}).length > 0;

// The models.dev Go catalog, loaded first because the sync read is null on a cold cache.
// The loader swallows its own failure, so a missing catalog is a failed discovery
// (the last published roster stays), never an authoritative empty roster.
async function loadModelsDevGoModels() {
  await loadModelsDevCatalog();
  const models = getModelsDevProviderModelsSync(CONFIG_PROVIDER_KEY);
  if (!models || Object.keys(models).length === 0) {
    throw openCodeGoError(
      `[${PROVIDER_ID}] the OpenCode organization config lists no models and the models.dev OpenCode Go catalog is unavailable`,
      { kind: 'catalog' }
    );
  }
  return models;
}

/**
 * The Go provider of a remote config response: `{ baseURL, headers, models }`
 * with one catalog row per enabled model. A config that lists no models takes
 * the models.dev Go models (`modelsDevModels`, id → row) instead.
 */
export function goConfigFromResponse(json, modelsDevModels = null) {
  const entry = json?.providers?.[CONFIG_PROVIDER_KEY];
  if (!isPlainObject(entry)) {
    throw openCodeGoError(`[${PROVIDER_ID}] the OpenCode organization config has no OpenCode Go provider`, {
      kind: 'catalog',
    });
  }
  const providerPackage = typeof entry.package === 'string' ? entry.package : '';
  const fallback = !listsGoModels(json) && isPlainObject(modelsDevModels);
  const source = fallback
    ? Object.fromEntries(
        Object.entries(modelsDevModels).map(([id, row]) => [
          id,
          isPlainObject(row) ? configModelFromModelsDev(row) : row,
        ])
      )
    : isPlainObject(entry.models)
      ? entry.models
      : {};
  const models = Object.entries(source)
    .filter(([id, model]) => id && isPlainObject(model) && model.disabled !== true)
    .map(([id, model]) => catalogRow(id, model, fallback ? MODELS_DEV_PROVIDER_PACKAGE : providerPackage));
  return {
    baseURL:
      typeof entry.settings?.baseURL === 'string' && entry.settings.baseURL
        ? entry.settings.baseURL
        : FALLBACK_BASE_URL,
    headers: stringHeaders(entry.headers),
    models,
  };
}

// The model list rows (the request routing fields stay in the cache).
function listRow({ wire: _wire, baseURL: _baseURL, headers: _headers, ...row }) {
  return row;
}

const isUnauthorized = (err) => Number(err?.status || err?.httpStatus) === 401;
const emittedOutput = (err) =>
  err?.liveTextEmitted === true || err?.emittedToolCall === true || err?.unsafeToRetry === true;

// The gateway engines on a fixed credential: the compat 401 handler re-reads
// the OpenCode Go API key from config, which must never reach this endpoint.
const pinCredential = (engine) => {
  engine.reloadApiKey = () => {};
  return engine;
};

class OpenCodeGoOAuthEngine extends OpenCodeGoProvider {
  constructor(config) {
    super(config);
    pinCredential(this.openai);
    pinCredential(this.anthropic);
  }

  async _geminiEngine() {
    return pinCredential(await super._geminiEngine());
  }
}

export class OpenCodeGoOAuthProvider {
  // No document block on this wire: a PDF is lowered to text before the request is built.
  nativePdf = false;
  static inputExcludesCache = false;
  name = PROVIDER_ID;
  config;
  tokens = null;
  _remote = null;
  _engines = new Map();

  constructor(config) {
    this.config = config || {};
    this.tokens = loadTokens();
  }

  async ensureAuth({ forceRefresh = false } = {}) {
    this.tokens = await ensureFreshTokens({ force: forceRefresh, fetchFn: this.config.fetchImpl });
    return this.tokens;
  }

  // The remote config for this credential, re-read after CONFIG_TTL_MS; only
  // a read with the still-signed-in account publishes the catalog.
  async _remoteConfig(tokens, { force = false } = {}) {
    const key = `${tokens.account_id}\0${tokens.org_id}`;
    if (!force && this._remote?.key === key && Date.now() - this._remote.fetchedAt < CONFIG_TTL_MS) return this._remote;
    const publish = goModelCache.beginSave(() => {
      const current = loadTokens();
      return current?.account_id === tokens.account_id && current?.org_id === tokens.org_id;
    });
    const response = await consoleGetJson(CONFIG_URL, tokens, { fetchFn: this.config.fetchImpl, refresh: true });
    const remote = goConfigFromResponse(response, listsGoModels(response) ? null : await loadModelsDevGoModels());
    publish(remote.models, {
      baseURL: remote.baseURL,
      headers: remote.headers,
      accountId: tokens.account_id,
      orgId: tokens.org_id,
    });
    this._remote = { key, fetchedAt: Date.now(), ...remote, byId: new Map(remote.models.map((row) => [row.id, row])) };
    return this._remote;
  }

  // A send keeps working on the last catalog of the same account and
  // organization when the config cannot be read right now (its headers route
  // to that organization); a rejected credential is never papered over.
  async _sendConfig(tokens) {
    try {
      return await this._remoteConfig(tokens);
    } catch (err) {
      if (isUnauthorized(err) || err?.reauthRequired) throw err;
      const entry = goModelCache.loadEntrySync({ allowStale: true });
      if (!entry || entry.accountId !== tokens.account_id || entry.orgId !== tokens.org_id) throw err;
      return {
        baseURL: entry.baseURL || FALLBACK_BASE_URL,
        headers: stringHeaders(entry.headers),
        models: entry.models,
        byId: new Map(entry.models.map((row) => [row.id, row])),
      };
    }
  }

  // The configured wire per model; the user's own modelWires win.
  _modelWires(models) {
    const wires = Object.fromEntries(models.filter((row) => row.wire).map((row) => [row.id, row.wire]));
    return { ...wires, ...(this.config.modelWires || {}) };
  }

  _engine(tokens, remote, row) {
    const baseURL = row?.baseURL || remote.baseURL;
    const headers = { ...(this.config.extraHeaders || {}), ...remote.headers, ...(row?.headers || {}) };
    const modelWires = this._modelWires(remote.models);
    const signature = JSON.stringify([baseURL, headers, modelWires]);
    const cached = this._engines.get(signature);
    if (cached && cached.token === tokens.access_token) return cached.engine;
    const { fetchImpl, apiKeyEnv: _env, ...config } = this.config;
    const engine = new OpenCodeGoOAuthEngine({
      ...config,
      apiKey: tokens.access_token,
      baseURL,
      extraHeaders: headers,
      modelWires,
      // Explicit nulls keep OPENAI_ORG_ID / OPENAI_PROJECT_ID out of the requests.
      clientOptions: { organization: null, project: null, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
    });
    this._engines.set(signature, { token: tokens.access_token, engine });
    return engine;
  }

  _scrub(err) {
    if (err && typeof err.message === 'string' && this.tokens) {
      err.message = scrubOAuthSecrets(err.message, [this.tokens.access_token, this.tokens.refresh_token]);
    }
    return err;
  }

  async send(messages, model, tools, sendOpts) {
    const attempt = async (forceRefresh) => {
      const tokens = await this.ensureAuth({ forceRefresh });
      const remote = await this._sendConfig(tokens);
      return this._engine(tokens, remote, remote.byId.get(model)).send(messages, model, tools, sendOpts);
    };
    try {
      return await attempt(false);
    } catch (err) {
      if (!isUnauthorized(err) || err?.reauthRequired || emittedOutput(err)) throw this._scrub(err);
    }
    // The stored expiry cannot see a revoked session: refresh once and ask again.
    try {
      return await attempt(true);
    } catch (err) {
      if (isUnauthorized(err) && !err?.reauthRequired) throw openCodeGoReauthError('inference 401');
      throw this._scrub(err);
    }
  }

  resolveWireRoute(model, ctx = {}) {
    const models = this._remote?.models || goModelCache.loadSync({ allowStale: true }) || [];
    return resolveOpenCodeGoWireRoute(model, { ...ctx, override: this._modelWires(models)[model] ?? null });
  }

  async listModels() {
    try {
      const tokens = await this.ensureAuth();
      const remote = await this._remoteConfig(tokens, { force: true });
      return remote.models.map((row) => ({ ...this.getCachedModelInfo(row.id), ...listRow(row) }));
    } catch (err) {
      throw this._scrub(err);
    }
  }

  getCachedModelInfo(model) {
    const rows = this._remote?.models || goModelCache.loadSync({ allowStale: true }) || [];
    const row = rows.find((candidate) => candidate?.id === model);
    const meta = getModelMetadataSync(model, PROVIDER_ID);
    if (!row && !meta) return null;
    return { ...(meta || {}), ...(row ? listRow(row) : {}), id: model, provider: PROVIDER_ID };
  }

  /** Go 5-hour / weekly / monthly meters of this account's organization. */
  async getUsageSnapshot() {
    const tokens = await this.ensureAuth();
    return await fetchOpenCodeGoOAuthUsageSnapshot(tokens, { fetchFn: this.config.fetchImpl });
  }

  async isAvailable() {
    return loadTokens() !== null;
  }
}
