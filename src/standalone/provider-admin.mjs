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
import {
  beginCursorOAuthLogin,
  describeCursorOAuthCredentials,
  forgetCursorOAuthCredentials,
  hasCursorOAuthCredentials,
  loginCursorOAuth,
} from '../runtime/agent/orchestrator/providers/cursor-auth.mjs';
import {
  beginOAuthLogin as beginAntigravityOAuthLogin,
  describeAntigravityOAuthCredentials,
  forgetAntigravityOAuthCredentials,
  hasAntigravityOAuthCredentials,
  loginOAuth as loginAntigravityOAuth,
} from '../runtime/agent/orchestrator/providers/antigravity-oauth.mjs';
import { localProviderStatus } from '../runtime/local-provider/managed-runtime.mjs';
import { isOAuthProviderAvailable } from '../runtime/agent/orchestrator/providers/oauth-credential-probes.mjs';
import {
  readProviderAccountPool,
  registerProviderAccount,
  newProviderAccountId,
  changeProviderAccounts,
  removeProviderAccount,
  clearProviderAccountQuotaState,
  ACCOUNT_PROVIDERS,
} from '../runtime/shared/provider-accounts.mjs';
import { currentProviderAccountId, withProviderAccount } from '../runtime/shared/provider-auth-binding.mjs';

const API_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'opencode-go', name: 'OpenCode Go API', env: 'OPENCODE_API_KEY', url: 'https://opencode.ai' }),
  Object.freeze({ id: 'openrouter', name: 'OpenRouter', env: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/keys' }),
  Object.freeze({
    id: 'openai',
    name: 'OpenAI API',
    env: 'OPENAI_API_KEY',
    url: 'https://platform.openai.com/api-keys',
  }),
  Object.freeze({
    id: 'anthropic',
    name: 'Anthropic API',
    env: 'ANTHROPIC_API_KEY',
    url: 'https://console.anthropic.com/settings/keys',
  }),
  Object.freeze({ id: 'gemini', name: 'Gemini API', env: 'GEMINI_API_KEY', url: 'https://aistudio.google.com/apikey' }),
  Object.freeze({
    id: 'deepseek',
    name: 'DeepSeek API',
    env: 'DEEPSEEK_API_KEY',
    url: 'https://platform.deepseek.com/api_keys',
  }),
  Object.freeze({ id: 'xai', name: 'xAI API', env: 'XAI_API_KEY', url: 'https://console.x.ai' }),
]);

const OAUTH_PROVIDERS = Object.freeze(
  [
    Object.freeze({
      id: 'openai-oauth',
      name: 'OpenAI OAuth',
      desc: 'Mixdog OAuth credentials',
      has: hasOpenAIOAuthCredentials,
      describe: describeOpenAIOAuthCredentials,
      forget: forgetOpenAIOAuthCredentials,
      begin: beginOpenAIOAuthLogin,
      login: loginOpenAIOAuth,
    }),
    Object.freeze({
      id: 'anthropic-oauth',
      name: 'Anthropic OAuth',
      desc: 'Mixdog OAuth credentials',
      has: hasAnthropicOAuthCredentials,
      describe: describeAnthropicOAuthCredentials,
      forget: forgetAnthropicOAuthCredentials,
      begin: beginAnthropicOAuthLogin,
      login: loginAnthropicOAuth,
    }),
    Object.freeze({
      id: 'grok-oauth',
      name: 'Grok OAuth',
      desc: 'Mixdog OAuth credentials (Grok Build)',
      has: hasGrokOAuthCredentials,
      describe: describeGrokOAuthCredentials,
      forget: forgetGrokOAuthCredentials,
      begin: beginGrokOAuthLogin,
      login: loginGrokOAuth,
    }),
    Object.freeze({
      id: 'cursor-oauth',
      name: 'Cursor OAuth',
      desc: 'Sign in with your Cursor account',
      has: hasCursorOAuthCredentials,
      describe: describeCursorOAuthCredentials,
      forget: forgetCursorOAuthCredentials,
      begin: beginCursorOAuthLogin,
      login: loginCursorOAuth,
    }),
    Object.freeze({
      id: 'antigravity-oauth',
      name: 'Antigravity OAuth',
      desc: 'Sign in with Google (Gemini + Claude)',
      has: hasAntigravityOAuthCredentials,
      describe: describeAntigravityOAuthCredentials,
      forget: forgetAntigravityOAuthCredentials,
      begin: beginAntigravityOAuthLogin,
      login: loginAntigravityOAuth,
    }),
    // Dev-only entries (cursor-oauth, antigravity-oauth) are dropped unless
    // MIXDOG_DEV_PROVIDERS is set, so they are unknown to settings/login by default.
  ].filter((p) => isOAuthProviderAvailable(p.id))
);

export const LOCAL_PROVIDERS = Object.freeze([]);
const BUILTIN_PROVIDER_IDS = new Set(['mixdog-local']);

const API_PROVIDER_IDS = new Set(API_PROVIDERS.map((p) => p.id));
const OAUTH_BY_ID = new Map(OAUTH_PROVIDERS.map((p) => [p.id, p]));

const ALL_PROVIDER_IDS = new Set([
  ...API_PROVIDERS.map((p) => p.id),
  ...OAUTH_PROVIDERS.map((p) => p.id),
  ...LOCAL_PROVIDERS.map((p) => p.id),
  ...BUILTIN_PROVIDER_IDS,
]);

export function isKnownProvider(provider) {
  const id = String(provider || '').trim();
  return id !== '' && ALL_PROVIDER_IDS.has(id);
}

function updateConfigProvider(cfgMod, providerId, patch) {
  const config = cfgMod.loadConfig();
  const providers = { ...(config.providers || {}) };
  providers[providerId] = { ...(providers[providerId] || {}), ...patch };
  cfgMod.saveConfig({ ...config, providers }, { baseConfig: config });
  return cfgMod.loadConfig();
}

function builtInLocalProviderSetup(config, options) {
  const provider = config.providers?.['mixdog-local'] || {};
  const installed = config.builtins?.localProvider?.installed === true;
  const enabled = provider.enabled === true && installed && config.modules?.localProvider?.enabled !== false;
  let runtime = null;
  if (options?.detectLocal !== false) {
    try {
      runtime = (options?.getLocalProviderStatus || localProviderStatus)();
    } catch {
      runtime = null;
    }
  }
  const installedModels = Array.isArray(runtime?.models)
    ? runtime.models.filter((model) => model?.installed === true)
    : [];
  const detected = runtime?.runtime?.installed === true && installedModels.length > 0;
  let status = installed ? 'No Model' : 'Not Installed';
  if (detected) status = enabled ? 'Ready' : 'Off';
  const plural = installedModels.length === 1 ? '' : 's';
  const detail = detected
    ? `${installedModels.length} installed model${plural}`
    : 'Install a recommended model from Built-in';
  return {
    id: 'mixdog-local',
    name: 'Local Provider',
    desc: 'Models managed on this PC by Mixdog',
    group: 'local',
    type: 'local',
    enabled,
    detected,
    authenticated: detected,
    usable: detected && enabled,
    status,
    detail,
  };
}

// What an OAuth provider says about its own credential; providers without a
// describe() answer from has() alone.
function describeOAuthProvider(p, { detail = false } = {}) {
  if (typeof p.describe === 'function') return p.describe();
  const authenticated = Boolean(p.has());
  return { authenticated, status: authenticated ? 'Set' : 'Not Set', ...(detail ? { detail: p.desc } : {}) };
}

function apiProviderSetup(p, providers, checkSecrets) {
  const configured = providers[p.id] || {};
  const envName = AGENT_PROVIDER_ENV[p.id] || p.env;
  const env = Boolean(envName && process.env[envName]);
  const configuredEnabled = configured.enabled === true;
  const stored = checkSecrets ? hasStoredSecret(SECRET_ACCOUNTS.agentApiKey(p.id)) : false;
  const authenticated = env || stored || (checkSecrets ? Boolean(getAgentApiKey(p.id)) : configuredEnabled);
  let status = configuredEnabled ? 'No Key' : 'Off';
  if (stored) status = 'Set';
  else if (env) status = 'Env';
  else if (authenticated) status = 'Set';
  let detail = envName;
  if (stored) detail = 'stored in keychain';
  else if (env) detail = envName;
  else if (authenticated) detail = 'runtime credential';
  return {
    ...p,
    group: 'api',
    type: 'api-key',
    enabled: configuredEnabled || authenticated,
    authenticated,
    stored,
    env,
    envName,
    status,
    detail,
  };
}

// Auth-derived fields shared by the setup and status views of an OAuth provider.
function oauthAuthFields(p, auth) {
  const authenticated = Boolean(auth.authenticated);
  return {
    authenticated,
    status: auth.status || (authenticated ? 'Set' : 'Not Set'),
    detail: auth.detail || p.desc,
    expiresAt: auth.expiresAt || null,
    usable: auth.usable === true || (auth.usable == null && authenticated),
    refreshable: auth.refreshable === true,
    reauthRequired: auth.reauthRequired === true,
  };
}

function oauthProviderSetup(p, providers, checkSecrets) {
  const configured = providers[p.id] || {};
  const configuredStatus = configured.enabled === true ? 'Enabled' : 'Not Set';
  const auth = checkSecrets
    ? describeOAuthProvider(p, { detail: true })
    : { authenticated: configured.enabled === true, status: configuredStatus, detail: p.desc };
  const fields = oauthAuthFields(p, auth);
  return {
    id: p.id,
    name: p.name,
    desc: p.desc,
    group: 'oauth',
    type: 'oauth',
    enabled: configured.enabled === true || fields.authenticated,
    ...fields,
  };
}

export async function providerSetup(config = {}, options = {}) {
  const providers = config.providers || {};
  const checkSecrets = options?.checkSecrets !== false;
  return {
    api: API_PROVIDERS.map((p) => apiProviderSetup(p, providers, checkSecrets)),
    oauth: OAUTH_PROVIDERS.map((p) => oauthProviderSetup(p, providers, checkSecrets)),
    local: [builtInLocalProviderSetup(config, options)],
  };
}

function apiProviderStatusRow(p, config) {
  const configured = config.providers?.[p.id] || {};
  const envName = AGENT_PROVIDER_ENV[p.id] || p.env;
  const env = Boolean(envName && process.env[envName]);
  const stored = hasStoredSecret(SECRET_ACCOUNTS.agentApiKey(p.id));
  const authenticated = Boolean(getAgentApiKey(p.id));
  return {
    id: p.id,
    type: 'api-key',
    enabled: configured.enabled === true || authenticated,
    authenticated,
    stored,
    env,
    envName,
    label: p.name,
  };
}

function oauthProviderStatusRow(p, config) {
  const fields = oauthAuthFields(p, describeOAuthProvider(p, { detail: true }));
  const configured = config.providers?.[p.id] || {};
  return {
    id: p.id,
    type: 'oauth',
    enabled: configured.enabled === true || fields.authenticated,
    authenticated: fields.authenticated,
    stored: false,
    env: false,
    envName: null,
    label: p.name,
    ...fields,
  };
}

export function providerStatus(config = {}) {
  return [
    ...API_PROVIDERS.map((p) => apiProviderStatusRow(p, config)),
    ...OAUTH_PROVIDERS.map((p) => oauthProviderStatusRow(p, config)),
    ...LOCAL_PROVIDERS.map((p) => ({
      id: p.id,
      type: 'local',
      enabled: config.providers?.[p.id]?.enabled === true,
      authenticated: false,
      stored: false,
      env: false,
      envName: null,
      label: p.name,
    })),
  ];
}

export function renderProviderStatus(config = {}) {
  const rows = providerStatus(config);
  const width = rows.reduce((n, row) => Math.max(n, row.id.length), 0);
  return rows
    .map((row) => {
      const authWord = row.authenticated ? 'auth ok' : 'not auth';
      const auth = row.type === 'oauth' ? String(row.status || authWord).toLowerCase() : authWord;
      let source = 'no key';
      if (row.type === 'oauth') source = row.detail || 'oauth';
      else if (row.env) source = `env:${row.envName}`;
      else if (row.stored) source = 'keychain';
      const enabled = row.enabled ? 'enabled' : 'disabled';
      return `${row.id.padEnd(width)}  ${row.type.padEnd(7)}  ${auth.padEnd(8)}  ${enabled.padEnd(8)}  ${source}`;
    })
    .join('\n');
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
  const auth = describeOAuthProvider(oauth);
  // Only a SUCCESSFUL login states `enabled`. A login that ends unauthenticated
  // (wrong or expired code, a token returned without the inference scope) is not
  // a decision to turn the provider off: writing enabled:false here stored a
  // PERMANENT opt-out — loadConfig lets a stored `enabled` outrank the credential
  // probe — and took down a provider whose other accounts were still signed in.
  // Disabling a provider is forgetProviderAuth's job alone, and it does so only
  // once the last account is disconnected.
  if (auth.authenticated) {
    updateConfigProvider(cfgMod, id, { enabled: true });
    // Same reason as the interactive add-account flow: a fresh credential says
    // nothing about the quota the previous one exhausted.
    if (ACCOUNT_PROVIDERS.includes(id)) clearProviderAccountQuotaState(id, currentProviderAccountId(id));
  }
  return { provider: id, type: 'oauth', authenticated: Boolean(auth.authenticated), status: auth.status || null };
}

function assertOAuthLoginOptions(options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !['addAccount', 'label', 'accountId'].includes(key)) ||
    (options.addAccount !== undefined && typeof options.addAccount !== 'boolean') ||
    (options.label !== undefined && (typeof options.label !== 'string' || options.label.length > 80))
  ) {
    throw new TypeError('Invalid OAuth account login options.');
  }
}

// Same rule as loginOAuthProvider, and it matters most here: the add-account
// flow runs against a brand-new account id, so an exchange that does not
// land leaves THIS account unauthenticated while every already-connected one
// stays valid. Registration and the enabled flag therefore move together, on
// success only; a failed attempt leaves the stored config untouched.
function settleOAuthLogin({ cfgMod, id, accountId, includeDefault, label, inAccount, oauth }, result) {
  const auth = inAccount(() => describeOAuthProvider(oauth));
  if (auth.authenticated) {
    registerProviderAccount(id, accountId, { includeDefault, label });
    // A re-connect can follow a re-created subscription under the same
    // account id: start it from no recorded quota rather than from the
    // exhausted window the previous credential earned.
    clearProviderAccountQuotaState(id, accountId);
    updateConfigProvider(cfgMod, id, { enabled: true });
  }
  return {
    provider: id,
    type: 'oauth',
    authenticated: Boolean(auth.authenticated),
    status: auth.status || null,
    result,
  };
}

export async function beginOAuthProviderLogin(cfgMod, provider, options = {}) {
  const id = String(provider || '').trim();
  const oauth = OAUTH_BY_ID.get(id);
  if (!oauth) throw new Error(`unknown OAuth provider "${id}"`);
  if (typeof oauth.begin !== 'function') throw new Error(`${id} does not support interactive code login`);
  assertOAuthLoginOptions(options);
  const idBefore = currentProviderAccountId(id);
  if (
    options.accountId !== undefined &&
    (options.addAccount || !listProviderAccounts(id).accounts.some((account) => account.id === options.accountId))
  ) {
    throw new TypeError('Account is no longer connected.');
  }
  const accountId = options.addAccount === true ? newProviderAccountId() : options.accountId || idBefore;
  const includeDefault = withProviderAccount(id, 'default', () => Boolean(oauth.describe?.().authenticated));
  const inAccount = (run) => withProviderAccount(id, accountId, run);
  if (options.addAccount && readProviderAccountPool(id).accounts.length >= 20) {
    throw new Error('At most 20 accounts can be connected.');
  }
  const started = await inAccount(() => oauth.begin());
  let cancelled = false;
  const login = { cfgMod, id, accountId, includeDefault, label: options.label, inAccount, oauth };
  const finish = async (result) => (!result || cancelled ? null : settleOAuthLogin(login, result));
  return {
    provider: id,
    type: 'oauth',
    url: started.url,
    manualUrl: started.manualUrl || null,
    waitForCallback: started.waitForCallback?.then(finish),
    cancel: () => {
      cancelled = true;
      return inAccount(() => started.cancel?.());
    },
    ...(typeof started.completeCode === 'function'
      ? {
          completeCode: async (code) => {
            return await finish(await inAccount(() => started.completeCode(code)));
          },
        }
      : {}),
  };
}

export function listProviderAccounts(provider) {
  const oauth = OAUTH_BY_ID.get(provider);
  if (!oauth) throw new TypeError('Unknown OAuth provider.');
  const pool = readProviderAccountPool(provider);
  const accounts = pool.accounts.length ? pool.accounts : defaultAccountRows(provider, oauth);
  return {
    provider,
    auto: pool.auto !== false,
    selectedId: pool.selectedId || accounts[0]?.id || null,
    accounts: accounts.map((row) => {
      const auth = withProviderAccount(provider, row.id, () => oauth.describe?.() || {});
      // A provider-side identity (email, account id) helps tell two accounts
      // apart when the user has not named them; shown as a secondary line.
      let identity = null;
      if (typeof auth.email === 'string' && auth.email.trim()) identity = auth.email.trim();
      else if (typeof auth.accountId === 'string' && auth.accountId.trim()) identity = auth.accountId.trim();
      return {
        id: row.id,
        label: row.label,
        authenticated: auth.authenticated === true,
        reauthRequired: auth.reauthRequired === true,
        usage: row.usage || null,
        blockedUntil: row.blockedUntil || null,
        ...(identity ? { identity } : {}),
      };
    }),
  };
}

// A provider without a stored pool has one implicit account when it is signed in.
function defaultAccountRows(provider, oauth) {
  const authenticated = withProviderAccount(provider, 'default', () => oauth.describe?.().authenticated);
  return authenticated ? [{ id: 'default', label: 'Account 1' }] : [];
}

export function updateProviderAccounts(provider, change) {
  const current = listProviderAccounts(provider);
  if (!readProviderAccountPool(provider).accounts.length && current.accounts.length) {
    registerProviderAccount(provider, 'default', { label: 'Account 1' });
  }
  changeProviderAccounts(provider, change);
  // Picking an account by hand is a decision to use it NOW, so the refusal
  // window and meter stored against it — both describing the state the user
  // just changed — are dropped here. Never in the pool's own fallback commit,
  // where clearing them would send the request back to a spent account.
  if (change?.selectedId !== undefined) clearProviderAccountQuotaState(provider, change.selectedId);
  return listProviderAccounts(provider);
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
  if (workspace && !/^wrk_[a-zA-Z0-9]+$/.test(workspace))
    throw new Error('OpenCode Go workspaceId must look like wrk_...');
  const cookie = String(authCookie || '').trim();
  if (!cookie) throw new Error('OpenCode auth cookie is required for usage lookup');
  const authMatch = /(?:^|;\s*)auth=([^;]+)/.exec(cookie);
  saveSecret(SECRET_ACCOUNTS.opencodeGoAuthCookie, authMatch ? authMatch[1] : cookie);
  // Usage auth is a console cookie, not a model API key. Only flip the model
  // provider on when a key actually exists; otherwise cookie-only setups get
  // routed to the provider with apiKey 'no-key' and fail with 401s.
  const hasApiKey = Boolean(getAgentApiKey('opencode-go'));
  updateConfigProvider(cfgMod, 'opencode-go', {
    ...(hasApiKey ? { enabled: true } : {}),
    ...(workspace ? { workspaceId: workspace } : {}),
  });
  return { provider: 'opencode-go', type: 'usage-auth', authenticated: true, workspaceId: workspace || null };
}

export async function loginOpenCodeGoUsage(cfgMod) {
  const { loginOpenCodeGoConsoleWithBrowser } = await import('./opencode-go-login.mjs');
  const { workspaceId, authCookie } = await loginOpenCodeGoConsoleWithBrowser();
  return saveOpenCodeGoUsageAuth(cfgMod, { workspaceId, authCookie });
}

export function forgetProviderAuth(cfgModOrProvider, maybeProvider, requestedAccountId) {
  const cfgMod = maybeProvider === undefined ? null : cfgModOrProvider;
  const id = String(maybeProvider === undefined ? cfgModOrProvider : maybeProvider || '').trim();
  const oauth = OAUTH_BY_ID.get(id);
  if (oauth) {
    if (typeof oauth.forget !== 'function') throw new Error(`forget is not supported for OAuth provider ${id}`);
    const accountId = requestedAccountId ?? currentProviderAccountId(id);
    if (
      requestedAccountId !== undefined &&
      !listProviderAccounts(id).accounts.some((account) => account.id === accountId)
    ) {
      throw new TypeError('Account is no longer connected.');
    }
    const result = withProviderAccount(id, accountId, () => oauth.forget());
    const pool = removeProviderAccount(id, accountId);
    if (cfgMod) updateConfigProvider(cfgMod, id, { enabled: pool.accounts.length > 0 });
    return { provider: id, type: 'oauth', forgotten: true, removed: Boolean(result?.removed) };
  }
  if (!API_PROVIDER_IDS.has(id)) {
    throw new Error(`unknown provider "${id}"`);
  }
  deleteSecret(SECRET_ACCOUNTS.agentApiKey(id));
  if (cfgMod) updateConfigProvider(cfgMod, id, { enabled: false });
  return { provider: id, type: 'api-key', forgotten: true };
}
