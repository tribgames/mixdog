import {
  AGENT_PROVIDER_ENV,
  SECRET_ACCOUNTS,
  deleteSecret,
  getAgentApiKey,
  hasStoredSecret,
  saveSecret,
} from '../runtime/shared/config.mjs';
import {
  describeAnthropicOAuthCredentials,
  forgetAnthropicOAuthCredentials,
  hasAnthropicOAuthCredentials,
  loginOAuth as loginAnthropicOAuth,
} from '../runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import {
  describeOpenAIOAuthCredentials,
  forgetOpenAIOAuthCredentials,
  hasOpenAIOAuthCredentials,
  loginOAuth as loginOpenAIOAuth,
} from '../runtime/agent/orchestrator/providers/openai-oauth.mjs';
import {
  describeGrokOAuthCredentials,
  forgetGrokOAuthCredentials,
  hasGrokOAuthCredentials,
  loginOAuth as loginGrokOAuth,
} from '../runtime/agent/orchestrator/providers/grok-oauth.mjs';

export const API_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY', url: 'https://platform.openai.com/api-keys' }),
  Object.freeze({ id: 'anthropic', name: 'Anthropic', env: 'ANTHROPIC_API_KEY', url: 'https://console.anthropic.com/settings/keys' }),
  Object.freeze({ id: 'gemini', name: 'Gemini', env: 'GEMINI_API_KEY', url: 'https://aistudio.google.com/apikey' }),
  Object.freeze({ id: 'deepseek', name: 'DeepSeek', env: 'DEEPSEEK_API_KEY', url: 'https://platform.deepseek.com/api_keys' }),
  Object.freeze({ id: 'xai', name: 'xAI', env: 'XAI_API_KEY', url: 'https://console.x.ai' }),
  Object.freeze({ id: 'opencode-go', name: 'OpenCode Go', env: 'OPENCODE_API_KEY', url: 'https://opencode.ai' }),
]);

export const OAUTH_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'openai-oauth', name: 'Codex', desc: '~/.codex/auth.json', has: hasOpenAIOAuthCredentials, describe: describeOpenAIOAuthCredentials, forget: forgetOpenAIOAuthCredentials, login: loginOpenAIOAuth }),
  Object.freeze({ id: 'anthropic-oauth', name: 'Anthropic OAuth', desc: 'OAuth credentials (~/.claude/.credentials.json)', has: hasAnthropicOAuthCredentials, describe: describeAnthropicOAuthCredentials, forget: forgetAnthropicOAuthCredentials, login: loginAnthropicOAuth }),
  Object.freeze({ id: 'grok-oauth', name: 'Grok', desc: '~/.grok/auth.json or browser OAuth (Grok Build)', has: hasGrokOAuthCredentials, describe: describeGrokOAuthCredentials, forget: forgetGrokOAuthCredentials, login: loginGrokOAuth }),
]);

export const LOCAL_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'ollama', name: 'Ollama', url: 'http://localhost:11434/v1' }),
  Object.freeze({ id: 'lmstudio', name: 'LM Studio', url: 'http://localhost:1234/v1' }),
]);

const API_PROVIDER_IDS = new Set(API_PROVIDERS.map((p) => p.id));
const OAUTH_BY_ID = new Map(OAUTH_PROVIDERS.map((p) => [p.id, p]));
const LOCAL_BY_ID = new Map(LOCAL_PROVIDERS.map((p) => [p.id, p]));

async function detectLocalProvider(baseURL) {
  const url = String(baseURL || '').replace(/\/+$/, '') + '/models';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 650);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function updateConfigProvider(cfgMod, providerId, patch) {
  const config = cfgMod.loadConfig();
  const providers = { ...(config.providers || {}) };
  providers[providerId] = { ...(providers[providerId] || {}), ...patch };
  cfgMod.saveConfig({ ...config, providers });
  return cfgMod.loadConfig();
}

export async function providerSetup(config = {}) {
  const providers = config.providers || {};
  const api = API_PROVIDERS.map((p) => {
    const configured = providers[p.id] || {};
    const stored = hasStoredSecret(SECRET_ACCOUNTS.agentApiKey(p.id));
    const envName = AGENT_PROVIDER_ENV[p.id] || p.env;
    const env = Boolean(envName && process.env[envName]);
    const authenticated = Boolean(getAgentApiKey(p.id));
    return {
      ...p,
      group: 'api',
      type: 'api-key',
      enabled: configured.enabled === true || authenticated,
      authenticated,
      stored,
      env,
      envName,
      status: stored ? 'Set' : env ? 'Env' : 'Off',
      detail: stored ? 'stored in keychain' : env ? envName : p.env,
    };
  });

  const oauth = OAUTH_PROVIDERS.map((p) => {
    const auth = typeof p.describe === 'function'
      ? p.describe()
      : { authenticated: Boolean(p.has()), status: Boolean(p.has()) ? 'Set' : 'Not Set', detail: p.desc };
    const authenticated = Boolean(auth.authenticated);
    const configured = providers[p.id] || {};
    return {
      id: p.id,
      name: p.name,
      desc: p.desc,
      group: 'oauth',
      type: 'oauth',
      enabled: configured.enabled === true || authenticated,
      authenticated,
      status: auth.status || (authenticated ? 'Set' : 'Not Set'),
      detail: auth.detail || p.desc,
      expiresAt: auth.expiresAt || null,
    };
  });

  const local = await Promise.all(LOCAL_PROVIDERS.map(async (p) => {
    const configured = providers[p.id] || {};
    const baseURL = configured.baseURL || p.url;
    const detected = await detectLocalProvider(baseURL);
    const enabled = configured.enabled === true;
    return {
      id: p.id,
      name: p.name,
      group: 'local',
      type: 'local',
      enabled,
      detected,
      baseURL,
      defaultURL: p.url,
      authenticated: detected,
      status: enabled && detected ? 'Enabled' : enabled ? 'Enabled' : detected ? 'Disabled' : 'Off',
      detail: baseURL,
    };
  }));

  return { api, oauth, local };
}

export function providerStatus(config = {}) {
  const rows = [];
  for (const p of API_PROVIDERS) {
    const configured = config.providers?.[p.id] || {};
    const envName = AGENT_PROVIDER_ENV[p.id] || p.env;
    const env = Boolean(envName && process.env[envName]);
    const stored = hasStoredSecret(SECRET_ACCOUNTS.agentApiKey(p.id));
    const authenticated = Boolean(getAgentApiKey(p.id));
    rows.push({
      id: p.id,
      type: 'api-key',
      enabled: configured.enabled === true || authenticated,
      authenticated,
      stored,
      env,
      envName,
      label: p.name,
    });
  }
  for (const p of OAUTH_PROVIDERS) {
    const auth = typeof p.describe === 'function'
      ? p.describe()
      : { authenticated: Boolean(p.has()), status: Boolean(p.has()) ? 'Set' : 'Not Set', detail: p.desc };
    const authenticated = Boolean(auth.authenticated);
    const configured = config.providers?.[p.id] || {};
    rows.push({
      id: p.id,
      type: 'oauth',
      enabled: configured.enabled === true || authenticated,
      authenticated,
      stored: false,
      env: false,
      envName: null,
      label: p.name,
      status: auth.status || (authenticated ? 'Set' : 'Not Set'),
      detail: auth.detail || p.desc,
      expiresAt: auth.expiresAt || null,
    });
  }
  for (const p of LOCAL_PROVIDERS) {
    const configured = config.providers?.[p.id] || {};
    rows.push({
      id: p.id,
      type: 'local',
      enabled: configured.enabled === true,
      authenticated: false,
      stored: false,
      env: false,
      envName: null,
      label: p.name,
    });
  }
  return rows;
}

export function renderProviderStatus(config = {}) {
  const rows = providerStatus(config);
  const width = rows.reduce((n, row) => Math.max(n, row.id.length), 0);
  return rows.map((row) => {
    const auth = row.type === 'oauth'
      ? String(row.status || (row.authenticated ? 'auth ok' : 'not auth')).toLowerCase()
      : row.authenticated ? 'auth ok' : 'not auth';
    const source = row.type === 'oauth'
      ? (row.detail || 'oauth')
      : row.env ? `env:${row.envName}` : row.stored ? 'keychain' : 'no key';
    const enabled = row.enabled ? 'enabled' : 'disabled';
    return `${row.id.padEnd(width)}  ${row.type.padEnd(7)}  ${auth.padEnd(8)}  ${enabled.padEnd(8)}  ${source}`;
  }).join('\n');
}

export async function authenticateProvider(provider, secret) {
  const id = String(provider || '').trim();
  if (!id) throw new Error('provider id is required');

  const oauth = OAUTH_BY_ID.get(id);
  if (oauth) {
    const result = await oauth.login();
    if (!result) throw new Error(`${id} login did not complete`);
    return { provider: id, type: 'oauth', authenticated: oauth.has() };
  }

  if (!API_PROVIDER_IDS.has(id)) {
    throw new Error(`unknown provider "${id}"`);
  }
  const value = String(secret || '').trim();
  if (!value) throw new Error(`API key is required for ${id}`);
  saveSecret(SECRET_ACCOUNTS.agentApiKey(id), value);
  return { provider: id, type: 'api-key', authenticated: true };
}

export async function loginOAuthProvider(cfgMod, provider) {
  const id = String(provider || '').trim();
  const oauth = OAUTH_BY_ID.get(id);
  if (!oauth) throw new Error(`unknown OAuth provider "${id}"`);
  const result = await oauth.login();
  if (!result) throw new Error(`${id} login did not complete`);
  const auth = typeof oauth.describe === 'function'
    ? oauth.describe()
    : { authenticated: Boolean(oauth.has()), status: Boolean(oauth.has()) ? 'Set' : 'Not Set' };
  updateConfigProvider(cfgMod, id, { enabled: Boolean(auth.authenticated) });
  return { provider: id, type: 'oauth', authenticated: Boolean(auth.authenticated), status: auth.status || null };
}

export function saveProviderApiKey(cfgMod, provider, secret) {
  const id = String(provider || '').trim();
  if (!API_PROVIDER_IDS.has(id)) throw new Error(`unknown API-key provider "${id}"`);
  const value = String(secret || '').trim();
  if (!value) throw new Error(`API key is required for ${id}`);
  saveSecret(SECRET_ACCOUNTS.agentApiKey(id), value);
  updateConfigProvider(cfgMod, id, { enabled: true });
  return { provider: id, type: 'api-key', authenticated: true };
}

export function setLocalProvider(cfgMod, provider, { enabled, baseURL } = {}) {
  const id = String(provider || '').trim();
  const local = LOCAL_BY_ID.get(id);
  if (!local) throw new Error(`unknown local provider "${id}"`);
  const nextBaseURL = String(baseURL || local.url).trim() || local.url;
  updateConfigProvider(cfgMod, id, {
    enabled: enabled === true,
    baseURL: nextBaseURL,
  });
  return { provider: id, type: 'local', enabled: enabled === true, baseURL: nextBaseURL };
}

export function forgetProviderAuth(provider) {
  const id = String(provider || '').trim();
  const oauth = OAUTH_BY_ID.get(id);
  if (oauth) {
    if (typeof oauth.forget !== 'function') throw new Error(`forget is not supported for OAuth provider ${id}`);
    const result = oauth.forget();
    return { provider: id, type: 'oauth', forgotten: true, removed: Boolean(result?.removed) };
  }
  if (!API_PROVIDER_IDS.has(id)) {
    throw new Error(`unknown provider "${id}"`);
  }
  deleteSecret(SECRET_ACCOUNTS.agentApiKey(id));
  return { provider: id, type: 'api-key', forgotten: true };
}

export const PROVIDER_STATUS_TOOL = {
  name: 'provider_status',
  title: 'Provider Status',
  annotations: {
    title: 'Provider Status',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    bridgeHidden: true,
  },
  description: 'List mixdog provider authentication/configuration status. This never returns secret values.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
