import {
  AGENT_PROVIDER_ENV,
  SECRET_ACCOUNTS,
  deleteSecret,
  getAgentApiKey,
  hasStoredSecret,
  saveSecret,
} from '../runtime/shared/config.mjs';
import {
  beginOAuthLogin as beginAnthropicOAuthLogin,
  describeAnthropicOAuthCredentials,
  forgetAnthropicOAuthCredentials,
  hasAnthropicOAuthCredentials,
  loginOAuth as loginAnthropicOAuth,
} from '../runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import {
  beginOAuthLogin as beginOpenAIOAuthLogin,
  describeOpenAIOAuthCredentials,
  forgetOpenAIOAuthCredentials,
  hasOpenAIOAuthCredentials,
  loginOAuth as loginOpenAIOAuth,
} from '../runtime/agent/orchestrator/providers/openai-oauth.mjs';
import {
  describeGrokOAuthCredentials,
  forgetGrokOAuthCredentials,
  hasGrokOAuthCredentials,
  beginOAuthLogin as beginGrokOAuthLogin,
  loginOAuth as loginGrokOAuth,
} from '../runtime/agent/orchestrator/providers/grok-oauth.mjs';

export const API_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'openai', name: 'OpenAI API', env: 'OPENAI_API_KEY', url: 'https://platform.openai.com/api-keys' }),
  Object.freeze({ id: 'anthropic', name: 'Anthropic API', env: 'ANTHROPIC_API_KEY', url: 'https://console.anthropic.com/settings/keys' }),
  Object.freeze({ id: 'gemini', name: 'Gemini API', env: 'GEMINI_API_KEY', url: 'https://aistudio.google.com/apikey' }),
  Object.freeze({ id: 'deepseek', name: 'DeepSeek API', env: 'DEEPSEEK_API_KEY', url: 'https://platform.deepseek.com/api_keys' }),
  Object.freeze({ id: 'xai', name: 'xAI API', env: 'XAI_API_KEY', url: 'https://console.x.ai' }),
  Object.freeze({ id: 'opencode-go', name: 'OpenCode Go API', env: 'OPENCODE_API_KEY', url: 'https://opencode.ai' }),
]);

export const OAUTH_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'openai-oauth', name: 'Codex', desc: '~/.codex/auth.json', has: hasOpenAIOAuthCredentials, describe: describeOpenAIOAuthCredentials, forget: forgetOpenAIOAuthCredentials, begin: beginOpenAIOAuthLogin, login: loginOpenAIOAuth }),
  Object.freeze({ id: 'anthropic-oauth', name: 'Claude Code', desc: 'Mixdog OAuth credentials', has: hasAnthropicOAuthCredentials, describe: describeAnthropicOAuthCredentials, forget: forgetAnthropicOAuthCredentials, begin: beginAnthropicOAuthLogin, login: loginAnthropicOAuth }),
  Object.freeze({ id: 'grok-oauth', name: 'Grok', desc: '~/.grok/auth.json or browser OAuth (Grok Build)', has: hasGrokOAuthCredentials, describe: describeGrokOAuthCredentials, forget: forgetGrokOAuthCredentials, begin: beginGrokOAuthLogin, login: loginGrokOAuth }),
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

export async function providerSetup(config = {}, options = {}) {
  const providers = config.providers || {};
  const detectLocal = options?.detectLocal !== false;
  const checkSecrets = options?.checkSecrets !== false;
  const api = API_PROVIDERS.map((p) => {
    const configured = providers[p.id] || {};
    const envName = AGENT_PROVIDER_ENV[p.id] || p.env;
    const env = Boolean(envName && process.env[envName]);
    const configuredEnabled = configured.enabled === true;
    const stored = checkSecrets ? hasStoredSecret(SECRET_ACCOUNTS.agentApiKey(p.id)) : false;
    const authenticated = env || stored || (checkSecrets ? Boolean(getAgentApiKey(p.id)) : configuredEnabled);
    return {
      ...p,
      group: 'api',
      type: 'api-key',
      enabled: configuredEnabled || authenticated,
      authenticated,
      stored,
      env,
      envName,
      status: stored ? 'Set' : env ? 'Env' : authenticated ? 'Set' : configuredEnabled ? 'No Key' : 'Off',
      detail: stored ? 'stored in keychain' : env ? envName : authenticated ? 'runtime credential' : envName,
    };
  });

  const oauth = OAUTH_PROVIDERS.map((p) => {
    const configured = providers[p.id] || {};
    const auth = checkSecrets
      ? (typeof p.describe === 'function'
        ? p.describe()
        : { authenticated: Boolean(p.has()), status: Boolean(p.has()) ? 'Set' : 'Not Set', detail: p.desc })
      : {
        authenticated: configured.enabled === true,
        status: configured.enabled === true ? 'Enabled' : 'Not Set',
        detail: p.desc,
      };
    const authenticated = Boolean(auth.authenticated);
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
    const detected = detectLocal ? await detectLocalProvider(baseURL) : false;
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

export async function beginOAuthProviderLogin(cfgMod, provider) {
  const id = String(provider || '').trim();
  const oauth = OAUTH_BY_ID.get(id);
  if (!oauth) throw new Error(`unknown OAuth provider "${id}"`);
  if (typeof oauth.begin !== 'function') throw new Error(`${id} does not support interactive code login`);
  const started = await oauth.begin();
  const finish = async (result) => {
    if (!result) return result;
    const auth = typeof oauth.describe === 'function'
      ? oauth.describe()
      : { authenticated: Boolean(oauth.has()), status: Boolean(oauth.has()) ? 'Set' : 'Not Set' };
    updateConfigProvider(cfgMod, id, { enabled: Boolean(auth.authenticated) });
    return { provider: id, type: 'oauth', authenticated: Boolean(auth.authenticated), status: auth.status || null, result };
  };
  return {
    provider: id,
    type: 'oauth',
    url: started.url,
    manualUrl: started.manualUrl || null,
    waitForCallback: started.waitForCallback?.then(finish),
    cancel: started.cancel,
    completeCode: async (code) => {
      return await finish(await started.completeCode(code));
    },
  };
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

export function saveOpenAIUsageSessionKey(cfgMod, secret) {
  const value = String(secret || '').trim();
  if (!value) throw new Error('OpenAI usage session key is required for credit lookup');
  saveSecret(SECRET_ACCOUNTS.openaiUsageSessionKey, value);
  updateConfigProvider(cfgMod, 'openai', { enabled: true });
  return { provider: 'openai', type: 'usage-auth', authenticated: true };
}

export function saveOpenCodeGoUsageAuth(cfgMod, { workspaceId, authCookie } = {}) {
  const workspace = String(workspaceId || '').trim();
  if (workspace && !/^wrk_[a-zA-Z0-9]+$/.test(workspace)) throw new Error('OpenCode Go workspaceId must look like wrk_...');
  const cookie = String(authCookie || '').trim();
  if (!cookie) throw new Error('OpenCode auth cookie is required for usage lookup');
  const authMatch = /(?:^|;\s*)auth=([^;]+)/.exec(cookie);
  saveSecret(SECRET_ACCOUNTS.opencodeGoAuthCookie, authMatch ? authMatch[1] : cookie);
  updateConfigProvider(cfgMod, 'opencode-go', workspace
    ? { enabled: true, workspaceId: workspace }
    : { enabled: true });
  return { provider: 'opencode-go', type: 'usage-auth', authenticated: true, workspaceId: workspace || null };
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

export function forgetProviderAuth(cfgModOrProvider, maybeProvider) {
  const cfgMod = maybeProvider === undefined ? null : cfgModOrProvider;
  const id = String(maybeProvider === undefined ? cfgModOrProvider : maybeProvider || '').trim();
  const oauth = OAUTH_BY_ID.get(id);
  if (oauth) {
    if (typeof oauth.forget !== 'function') throw new Error(`forget is not supported for OAuth provider ${id}`);
    const result = oauth.forget();
    if (cfgMod) updateConfigProvider(cfgMod, id, { enabled: false });
    return { provider: id, type: 'oauth', forgotten: true, removed: Boolean(result?.removed) };
  }
  if (!API_PROVIDER_IDS.has(id)) {
    throw new Error(`unknown provider "${id}"`);
  }
  deleteSecret(SECRET_ACCOUNTS.agentApiKey(id));
  if (cfgMod) updateConfigProvider(cfgMod, id, { enabled: false });
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
    agentHidden: true,
  },
  description: 'List provider auth/config status. No secrets.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
