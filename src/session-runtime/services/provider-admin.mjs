import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { modelProxyClientMode, serverModelCredentialsDisabledError } from '../../runtime/shared/model-proxy-mode.mjs';
import { sameAccountIdentity } from '../../runtime/agent/orchestrator/providers/lib/oauth-token-utils.mjs';
import { agentApiKeyEnvName } from '../../runtime/shared/provider-api-key.mjs';
import {
  AGENT_PROVIDER_ENV,
  SECRET_ACCOUNTS,
  deleteSecretAsync,
  getAgentApiKey,
  getKeychainStatus,
  hasStoredSecret,
  isFallbackSecret,
  saveSecretAsync,
} from '../../runtime/shared/config.mjs';
import {
  beginOAuthLogin as beginAnthropicOAuthLogin,
  describeAnthropicOAuthCredentials,
  forgetAnthropicOAuthCredentials,
  hasAnthropicOAuthCredentials,
  loginOAuth as loginAnthropicOAuth,
} from '../../runtime/agent/orchestrator/providers/anthropic-oauth-credentials.mjs';
// Credential/login helpers come from their defining modules, not the provider
// facades: the facades pull every provider's transport stack (~180 modules)
// into runtime boot, while the registry already loads providers on demand.
import {
  beginOAuthLogin as beginOpenAIOAuthLogin,
  describeOpenAIOAuthCredentials,
  forgetOpenAIOAuthCredentials,
  hasOpenAIOAuthCredentials,
  loginOAuth as loginOpenAIOAuth,
} from '../../runtime/agent/orchestrator/providers/openai-oauth-tokens.mjs';
import {
  describeGrokOAuthCredentials,
  forgetGrokOAuthCredentials,
  hasGrokOAuthCredentials,
} from '../../runtime/agent/orchestrator/providers/grok-oauth-tokens.mjs';
import {
  beginOAuthLogin as beginGrokOAuthLogin,
  loginOAuth as loginGrokOAuth,
} from '../../runtime/agent/orchestrator/providers/grok-oauth-login.mjs';
import {
  describeMimoOAuthCredentials,
  forgetMimoOAuthCredentials,
  hasMimoOAuthCredentials,
} from '../../runtime/agent/orchestrator/providers/mimo-oauth-tokens.mjs';
import {
  beginOAuthLogin as beginMimoOAuthLogin,
  loginOAuth as loginMimoOAuth,
} from '../../runtime/agent/orchestrator/providers/mimo-oauth-login.mjs';
import {
  describeMuseCodeOAuthCredentials,
  forgetMuseCodeOAuthCredentials,
  hasMuseCodeOAuthCredentials,
} from '../../runtime/agent/orchestrator/providers/muse-code-oauth-tokens.mjs';
import {
  beginOAuthLogin as beginMuseCodeOAuthLogin,
  loginOAuth as loginMuseCodeOAuth,
} from '../../runtime/agent/orchestrator/providers/muse-code-oauth-login.mjs';
import {
  describeCommandCodeOAuthCredentials,
  forgetCommandCodeOAuthCredentials,
  hasCommandCodeOAuthCredentials,
} from '../../runtime/agent/orchestrator/providers/command-code-oauth-tokens.mjs';
import {
  beginOAuthLogin as beginCommandCodeOAuthLogin,
  loginOAuth as loginCommandCodeOAuth,
} from '../../runtime/agent/orchestrator/providers/command-code-oauth-login.mjs';
import {
  describeOpenCodeGoOAuthCredentials,
  forgetOpenCodeGoOAuthCredentials,
  hasOpenCodeGoOAuthCredentials,
} from '../../runtime/agent/orchestrator/providers/opencode-go-oauth-tokens.mjs';
import {
  beginOAuthLogin as beginOpenCodeGoOAuthLogin,
  loginOAuth as loginOpenCodeGoOAuth,
} from '../../runtime/agent/orchestrator/providers/opencode-go-oauth-login.mjs';
import {
  beginCursorOAuthLogin,
  describeCursorOAuthCredentials,
  forgetCursorOAuthCredentials,
  hasCursorOAuthCredentials,
  loginCursorOAuth,
} from '../../runtime/agent/orchestrator/providers/cursor-auth.mjs';
import {
  beginDevinOAuthLogin,
  describeDevinOAuthCredentials,
  forgetDevinOAuthCredentials,
  hasDevinOAuthCredentials,
  loginDevinOAuth,
} from '../../runtime/agent/orchestrator/providers/devin-auth.mjs';
import {
  describeAntigravityOAuthCredentials,
  forgetAntigravityOAuthCredentials,
  hasAntigravityOAuthCredentials,
} from '../../runtime/agent/orchestrator/providers/antigravity-oauth-tokens.mjs';
import {
  beginOAuthLogin as beginAntigravityOAuthLogin,
  loginOAuth as loginAntigravityOAuth,
} from '../../runtime/agent/orchestrator/providers/antigravity-oauth-login.mjs';
import { localProviderStatus } from '../../runtime/local-provider/managed-runtime.mjs';
import { isOAuthProviderAvailable } from '../../runtime/agent/orchestrator/providers/oauth-credential-probes.mjs';
import {
  readProviderAccountPool,
  registerProviderAccount,
  newProviderAccountId,
  providerAccountPath,
  changeProviderAccounts,
  removeProviderAccount,
  clearProviderAccountQuotaState,
  providerAccountLimit,
  providerAccountBlockedUntil,
  ACCOUNT_PROVIDERS,
  MAX_ACCOUNTS,
  customProviderKeyIds,
  setCustomProviderKeyIds,
} from '../../runtime/shared/provider-accounts.mjs';
import { customProviderKeyAccount } from '../../runtime/shared/custom-provider-keys.mjs';
import { currentProviderAccountId, withProviderAccount } from '../../runtime/shared/provider-auth-binding.mjs';
import {
  CUSTOM_API_KEY_ENV_RE,
  effectiveCustomModelRows,
  normalizeCustomProviderConfig as normalizeStoredCustomConfig,
} from '../../runtime/agent/orchestrator/providers/custom-provider-config.mjs';
import {
  VERTEX_ADC_MODE,
  VERTEX_API_KEY_MODE,
  describeVertexAdc,
  parseVertexServiceAccount,
  probeVertexMetadata,
} from '../../runtime/agent/orchestrator/providers/vertex-ai-auth.mjs';
import { vertexEnvLocation } from '../../runtime/agent/orchestrator/providers/vertex-ai-models.mjs';

const API_PROVIDERS = Object.freeze([
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
  Object.freeze({ id: 'vertex-ai', name: 'Vertex AI', env: null, url: null }),
  Object.freeze({
    id: 'deepseek',
    name: 'DeepSeek API',
    env: 'DEEPSEEK_API_KEY',
    url: 'https://platform.deepseek.com/api_keys',
  }),
  Object.freeze({ id: 'xai', name: 'xAI API', env: 'XAI_API_KEY', url: 'https://console.x.ai' }),
]);

const OAUTH_PROVIDERS = Object.freeze([
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
    id: 'muse-code-oauth',
    name: 'Muse Code',
    desc: 'Sign in with your Meta account (Muse Code subscription)',
    has: hasMuseCodeOAuthCredentials,
    describe: describeMuseCodeOAuthCredentials,
    forget: forgetMuseCodeOAuthCredentials,
    begin: beginMuseCodeOAuthLogin,
    login: loginMuseCodeOAuth,
  }),
  Object.freeze({
    id: 'command-code-oauth',
    name: 'Command Code',
    desc: 'Sign in with your Command Code account',
    has: hasCommandCodeOAuthCredentials,
    describe: describeCommandCodeOAuthCredentials,
    forget: forgetCommandCodeOAuthCredentials,
    begin: beginCommandCodeOAuthLogin,
    login: loginCommandCodeOAuth,
  }),
  Object.freeze({
    id: 'opencode-go-oauth',
    name: 'OpenCode Go OAuth',
    desc: 'Sign in with your OpenCode account (OpenCode Go subscription)',
    has: hasOpenCodeGoOAuthCredentials,
    describe: describeOpenCodeGoOAuthCredentials,
    forget: forgetOpenCodeGoOAuthCredentials,
    begin: beginOpenCodeGoOAuthLogin,
    login: loginOpenCodeGoOAuth,
  }),
  Object.freeze({
    id: 'mimo-oauth',
    name: 'MiMo',
    desc: 'Sign in with your Xiaomi MiMo account',
    has: hasMimoOAuthCredentials,
    describe: describeMimoOAuthCredentials,
    forget: forgetMimoOAuthCredentials,
    begin: beginMimoOAuthLogin,
    login: loginMimoOAuth,
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
    id: 'devin-oauth',
    name: 'Devin',
    desc: 'Sign in with your Devin account',
    has: hasDevinOAuthCredentials,
    describe: describeDevinOAuthCredentials,
    forget: forgetDevinOAuthCredentials,
    begin: beginDevinOAuthLogin,
    login: loginDevinOAuth,
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
]);

const BUILTIN_PROVIDER_IDS = new Set(['mixdog-local']);

const API_PROVIDER_IDS = new Set(API_PROVIDERS.map((p) => p.id));
const OAUTH_BY_ID = new Map(OAUTH_PROVIDERS.map((p) => [p.id, p]));

// Dev-only entries (cursor-oauth, devin-oauth, antigravity-oauth, mimo-oauth) are unknown to
// settings/login while the Developer → Providers option is off. Filtered per
// call, so toggling the option takes effect without a restart.
function availableOAuthProviders() {
  return OAUTH_PROVIDERS.filter((p) => isOAuthProviderAvailable(p.id));
}

function availableOAuthProvider(id) {
  const oauth = OAUTH_BY_ID.get(id);
  return oauth && isOAuthProviderAvailable(id) ? oauth : null;
}

export function isKnownProvider(provider, config = {}) {
  const id = String(provider || '').trim();
  return (
    id !== '' &&
    (API_PROVIDER_IDS.has(id) ||
      BUILTIN_PROVIDER_IDS.has(id) ||
      !!availableOAuthProvider(id) ||
      (isCustomProviderId(id) &&
        isCustomProviderConfig(config.providers?.[id]) &&
        config.providers[id].enabled !== false))
  );
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

// When the OS keyring is locked/missing a stored key reads as absent; say so
// (the UI shows the unlock / install hint) instead of a bare "No Key".
// Fixed, translatable hints keyed by keyring state; internal error text never
// reaches the UI.
const KEYCHAIN_HINTS = Object.freeze({
  unreachable: 'The keyring is not reachable — make sure it is running, then press Unlock keyring.',
  locked: 'Keyring is locked — unlock it (log in again or open Passwords and Keys).',
  missing: 'Install libsecret-tools (sudo apt install libsecret-tools) to use the system keyring.',
  error: 'The system keyring could not be read — check that it is running and unlocked.',
});

// The private-file store being ignored, by what is wrong with it (the repair
// differs: chmod cannot fix an owner or a symlink, and a save fails through a
// foreign or symlinked folder).
const UNSAFE_STORE_HINTS = Object.freeze({
  permissions:
    'The private secrets folder has unsafe permissions, so its keys are ignored — run chmod 700 on the folder and chmod 600 on its files, or save the key again.',
  owner:
    'The private secrets folder or one of its files belongs to another user, so its keys are ignored — change its owner to the current user (chown).',
  type: 'The private secrets folder or one of its files is a symlink or not a regular file, so its keys are ignored — remove it and save the key again.',
});

export function keychainIssueFor(checkSecrets) {
  if (!checkSecrets) return null;
  // A host with no keychain provider keeps its keys in the private secrets
  // file (keychain-cjs.cjs "Linux fallback file"): that works, so nothing to
  // report — unless the store's permissions make reads ignore it, which is
  // reported with the folder to repair. A locked keyring is still an issue.
  const { state, fallback, unsafeStore } = getKeychainStatus();
  if (fallback && unsafeStore) {
    const { kind, path } = unsafeStore;
    return { state: 'unsafe-store', kind, message: UNSAFE_STORE_HINTS[kind] ?? UNSAFE_STORE_HINTS.permissions, path };
  }
  if (fallback) return null;
  const message = KEYCHAIN_HINTS[state];
  return message ? { state, message } : null;
}

// Where a stored key lives, for a row's detail line: decided per account, so a
// key that is still only in the fallback file reads as such after the keychain
// recovers.
function storedSecretDetail(account) {
  return isFallbackSecret(account) ? 'stored in private file' : 'stored in keychain';
}

// The Vertex AI gcloud-login row's detail: who is signed in and where, or what to fix.
function vertexAdcDetail(adc, location) {
  if (!adc) return `gcloud login · ${location}`;
  if (adc.state !== 'ready') return adc.message;
  const account = adc.account || (adc.type === 'metadata' ? 'metadata server' : 'gcloud user login');
  return [account, adc.projectId || 'no project', location].join(' · ');
}

// The Vertex AI location a row shows and where it comes from: the saved one
// ('config'), else what the runtime would use unset ('environment' or
// 'default'), which the connect form offers as a hint without saving it.
function vertexRowLocation(configured) {
  if (configured.location) return { location: String(configured.location), locationSource: 'config' };
  const env = vertexEnvLocation();
  return env ? { location: env, locationSource: 'environment' } : { location: 'global', locationSource: 'default' };
}

// `keychainIssue`: the setup response's one keyring check (never asked per row).
function apiProviderSetup(p, providers, checkSecrets, keychainIssue) {
  const configured = providers[p.id] || {};
  // The environment variable the key resolver actually reads (aliases included);
  // it wins over a stored key, so provenance follows it, not the stored secret.
  const resolvedEnv = agentApiKeyEnvName(p.id);
  const declaredEnv = AGENT_PROVIDER_ENV[p.id] || p.env;
  const envName = resolvedEnv || declaredEnv;
  const env = Boolean(resolvedEnv || (declaredEnv && process.env[declaredEnv]));
  const configuredEnabled = configured.enabled === true;
  const stored = checkSecrets ? hasStoredSecret(SECRET_ACCOUNTS.agentApiKey(p.id)) : false;
  const authenticated = env || stored || (checkSecrets ? Boolean(getAgentApiKey(p.id)) : configuredEnabled);
  let status = configuredEnabled ? 'No Key' : 'Off';
  if (env) status = 'Env';
  else if (stored || authenticated) status = 'Set';
  // Where the effective credential comes from: environment | private-file | keychain.
  let credentialSource = null;
  let detail = envName;
  if (env) {
    credentialSource = 'environment';
  } else if (stored) {
    detail = storedSecretDetail(SECRET_ACCOUNTS.agentApiKey(p.id));
    credentialSource = detail === 'stored in private file' ? 'private-file' : 'keychain';
  } else if (authenticated) {
    detail = 'runtime credential';
  }
  const rowIssue = authenticated ? null : keychainIssue;
  if (rowIssue) detail = rowIssue.message;
  if (p.id === 'vertex-ai' && configured.authMode === VERTEX_ADC_MODE) {
    // gcloud login: nothing is stored; connected while enabled and the login is readable.
    const { location, locationSource } = vertexRowLocation(configured);
    const adc = checkSecrets ? describeVertexAdc({ projectId: configured.projectId }) : null;
    // Without a login file a metadata server may stand in: probed once, in the
    // background, for the next refresh to report.
    if (adc?.state === 'missing') void probeVertexMetadata();
    const ready = configuredEnabled && (!adc || adc.state === 'ready');
    let adcStatus = configuredEnabled ? 'Not connected' : 'Off';
    if (ready) adcStatus = 'Set';
    return {
      ...p,
      group: 'api',
      type: 'api-key',
      authKind: 'adc',
      authMode: VERTEX_ADC_MODE,
      enabled: configuredEnabled,
      authenticated: ready,
      stored: false,
      env: false,
      envName: null,
      status: adcStatus,
      detail: vertexAdcDetail(adc, location),
      location,
      locationSource,
      projectId: adc?.projectId || String(configured.projectId || '') || null,
      ...(adc ? { adc } : {}),
    };
  }
  if (p.id === 'vertex-ai') {
    const { location, locationSource } = vertexRowLocation(configured);
    // An express-mode API key, or the service-account key.
    const express = configured.authMode === VERTEX_API_KEY_MODE;
    // The connect form offers the gcloud login too; its status line reads this.
    const adc = checkSecrets && !authenticated ? describeVertexAdc({ projectId: configured.projectId }) : null;
    let projectId = String(configured.projectId || '');
    if (!projectId && authenticated && checkSecrets && !express) {
      try {
        projectId = parseVertexServiceAccount(getAgentApiKey(p.id)).projectId;
      } catch {
        // An unreadable key leaves the project id empty; the status line then shows the location only.
      }
    }
    if (!rowIssue) {
      if (express) detail = `API key (express mode) · ${location}`;
      else detail = projectId ? `${projectId} · ${location}` : `Location: ${location}`;
    }
    return {
      ...p,
      ...(rowIssue ? { keychainIssue: rowIssue } : {}),
      group: 'api',
      type: 'api-key',
      authKind: express ? 'api-key' : 'service-account',
      authMode: express ? VERTEX_API_KEY_MODE : 'service-account',
      ...(adc ? { adc } : {}),
      enabled: configuredEnabled || authenticated,
      authenticated,
      stored,
      env: false,
      envName: null,
      status,
      detail,
      location,
      locationSource,
      projectId: projectId || null,
      ...(credentialSource ? { credentialSource } : {}),
    };
  }
  return {
    ...p,
    ...(rowIssue ? { keychainIssue: rowIssue } : {}),
    group: 'api',
    type: 'api-key',
    enabled: configuredEnabled || authenticated,
    authenticated,
    stored,
    env,
    envName,
    status,
    detail,
    ...(credentialSource ? { credentialSource } : {}),
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
    plan: auth.plan || null,
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

const CUSTOM_ID_RE = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CUSTOM_TEST_TIMEOUT_MS = 20_000;
// A catalog host can sit behind a slow gateway: api.nano-gpt.com's /models
// answered 503 only after ~44 s, so the wait must outlast that to surface the
// service's own answer instead of a local timeout.
const CUSTOM_DISCOVERY_TIMEOUT_MS = 60_000;

export function isCustomProviderConfig(entry) {
  return Boolean(entry) && typeof entry === 'object' && entry.type === 'custom';
}

function isCustomProviderId(id) {
  return CUSTOM_ID_RE.test(String(id || ''));
}

const loadCustomProviderModule = () => import('../../runtime/agent/orchestrator/providers/custom-provider.mjs');

// The stored entry as a normalized v2 config (legacy entries migrated), or
// the normalizer's message when it does not normalize.
function inspectStoredCustomConfig(entry) {
  try {
    return { config: normalizeStoredCustomConfig(entry), error: null };
  } catch (error) {
    return { config: null, error: String(error?.message || error).replace(/^\[custom-provider\]\s*/, '') };
  }
}

function storedCustomConfig(entry) {
  return inspectStoredCustomConfig(entry).config;
}

// Public (setup UI) view of effective model rows: one field vocabulary for the
// provider row and discovery alike — the override names (`maxOutputTokens`,
// not the runtime row's `outputTokens`).
function publicCustomModelRows(rows) {
  const seen = new Set();
  const models = [];
  for (const item of Array.isArray(rows) ? rows : []) {
    const modelId = String(item?.id || '').trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const model = { id: modelId };
    const name = String(item.name || item.display || '').trim();
    if (name && name !== modelId) model.name = name;
    if (Number(item.contextWindow) > 0) model.contextWindow = Math.floor(Number(item.contextWindow));
    const out = Number(item.maxOutputTokens ?? item.outputTokens);
    if (out > 0) model.maxOutputTokens = Math.floor(out);
    model.hidden = item.hidden === true;
    model.manual = item.manual === true;
    for (const key of [
      'supportsVision',
      'supportsReasoning',
      'reasoningOptions',
      'reasoningLevels',
      'customReasoning',
      'reasoningContentField',
    ]) {
      if (item[key] !== undefined) model[key] = structuredClone(item[key]);
    }
    models.push(model);
  }
  return models;
}

// Secret-free public view of a custom provider, always in the v2 shape.
// `models` are the effective rows known without network I/O (manual models
// with their overrides); discovered rows come from discoverCustomProviderModels.
// Never carries an API key.
function customProviderRow(id, entry, checkSecrets = true) {
  const { config, error: configError } = inspectStoredCustomConfig(entry);
  const configuredEnabled = entry.enabled !== false;
  const keyless = (config?.auth ?? entry.auth) === 'none';
  const apiKeyEnv = keyless ? '' : config?.apiKeyEnv || '';
  const envSet = Boolean(apiKeyEnv && process.env[apiKeyEnv]);
  const stored = checkSecrets ? hasStoredSecret(SECRET_ACCOUNTS.agentApiKey(id)) : false;
  const unstoredStatus = configuredEnabled ? 'No Key' : 'Off';
  let status = stored ? 'Set' : unstoredStatus;
  let detail = stored ? storedSecretDetail(SECRET_ACCOUNTS.agentApiKey(id)) : 'custom endpoint';
  if (apiKeyEnv) {
    status = envSet ? 'Env' : unstoredStatus;
    detail = apiKeyEnv;
  }
  if (keyless) {
    status = configuredEnabled ? 'Keyless' : 'Off';
    detail = 'no API key required';
  }
  let keyAuthenticated = checkSecrets ? stored : configuredEnabled;
  if (apiKeyEnv) keyAuthenticated = envSet;
  const row = {
    id,
    name: entry.name,
    protocol: entry.protocol,
    baseURL: entry.baseURL,
    models: config ? publicCustomModelRows(effectiveCustomModelRows(config, [], { providerId: id })) : [],
    custom: true,
    group: 'api',
    type: 'api-key',
    enabled: configuredEnabled,
    authenticated: keyless || keyAuthenticated,
    stored,
    env: envSet,
    envName: apiKeyEnv || null,
    status,
    detail,
  };
  if (apiKeyEnv) row.apiKeyEnv = apiKeyEnv;
  row.schemaVersion = config?.schemaVersion ?? entry.schemaVersion;
  row.auth = keyless ? 'none' : 'key';
  row.discovery = structuredClone(config?.discovery ?? entry.discovery ?? { newModelsHidden: false });
  row.modelOverrides = structuredClone(config?.modelOverrides ?? entry.modelOverrides ?? {});
  if (config?.headers) row.headers = { ...config.headers };
  if (config?.wires) row.wires = [...config.wires];
  if (config?.modelWires) row.modelWires = { ...config.modelWires };
  // Additional API keys by id only; their values never leave the keychain.
  const extraKeyIds = keyless ? [] : customProviderKeyIds(id);
  if (extraKeyIds.length) row.extraApiKeys = extraKeyIds.map((keyId) => ({ id: keyId }));
  // A stored config that does not normalize cannot run (the registry skips
  // it): say so explicitly instead of listing it as connected.
  // Every readiness flag consumers read says "not ready" (`stored` stays the
  // keychain fact).
  if (configError) {
    row.configError = configError;
    row.status = 'Invalid config';
    row.detail = configError;
    row.usable = false;
    row.ready = false;
    row.authenticated = false;
  }
  return row;
}

function customProviderRows(providers, checkSecrets) {
  return Object.entries(providers)
    .filter(([id, entry]) => isCustomProviderId(id) && isCustomProviderConfig(entry))
    .map(([id, entry]) => customProviderRow(id, entry, checkSecrets));
}

export async function providerSetup(config = {}, options = {}) {
  if (modelProxyClientMode()) return modelProxyProviderSetup(options);
  const providers = config.providers || {};
  const checkSecrets = options?.checkSecrets !== false;
  const keychain = checkSecrets ? keychainIssueFor(true) : null;
  return {
    ...(keychain ? { keychain } : {}),
    api: [
      ...API_PROVIDERS.map((p) => apiProviderSetup(p, providers, checkSecrets, keychain)),
      ...customProviderRows(providers, checkSecrets),
    ],
    oauth: availableOAuthProviders().map((p) => oauthProviderSetup(p, providers, checkSecrets)),
    local: [builtInLocalProviderSetup(config, options)],
  };
}

// The desktop's hidden custom models, in the override shape pickers already read.
function hiddenModelOverrides(entry) {
  const ids = Array.isArray(entry?.hiddenModels) ? entry.hiddenModels : [];
  return Object.fromEntries(ids.filter((id) => typeof id === 'string').map((id) => [id, { hidden: true }]));
}

// SSH servers have no model credentials. Project only the PC's advertised
// availability; account identities and credential management stay on the PC.
async function modelProxyProviderSetup(options) {
  const { loadModelProxyProviderConfig } = await import(
    '../../runtime/agent/orchestrator/providers/model-proxy-provider.mjs'
  );
  let providers;
  try {
    providers = await loadModelProxyProviderConfig({ force: options.force === true, waitMs: 1_000 });
  } catch (error) {
    if (error?.code !== 'MODEL_PROXY_UNAVAILABLE') throw error;
    return { managedByClient: true, unavailable: true, api: [], oauth: [], local: [] };
  }
  const project = (definitions, group, type) =>
    definitions
      .filter(({ id }) => Object.hasOwn(providers, id))
      .map(({ id, name }) => {
        const enabled = providers[id]?.enabled === true;
        const authState = providers[id]?.authState;
        // Older desktops advertise only enabled; new desktops distinguish a
        // missing credential from a transiently unreadable, preserved adapter.
        const authenticated = authState == null ? enabled : authState === 'present';
        const usable = enabled && authState !== 'absent';
        let status = usable ? 'Connected' : 'Not connected';
        if (enabled && authState === 'unreadable') status = 'Checking…';
        // Signed in but switched off on the desktop.
        else if (!enabled && authState === 'present') status = 'Off';
        return {
          id,
          name,
          group,
          type,
          enabled,
          authenticated,
          usable,
          ...(group === 'local' ? { detected: enabled } : {}),
          ...(type === 'custom' ? { custom: true, modelOverrides: hiddenModelOverrides(providers[id]) } : {}),
          status,
        };
      });
  const custom = Object.entries(providers)
    .filter(([id, entry]) => isCustomProviderId(id) && entry?.type === 'custom')
    // Older desktops advertise no name: the id is the fallback.
    .map(([id, entry]) => ({ id, name: (typeof entry.name === 'string' && entry.name.trim()) || id }));
  return {
    managedByClient: true,
    api: [...project(API_PROVIDERS, 'api', 'api-key'), ...project(custom, 'api', 'custom')],
    oauth: project(OAUTH_PROVIDERS, 'oauth', 'oauth'),
    local: project([{ id: 'mixdog-local', name: 'Local Provider' }], 'local', 'local'),
  };
}

function apiProviderStatusRow(p, config) {
  const configured = config.providers?.[p.id] || {};
  if (p.id === 'vertex-ai' && configured.authMode === VERTEX_ADC_MODE) {
    const adc = describeVertexAdc({ projectId: configured.projectId });
    return {
      id: p.id,
      type: 'api-key',
      enabled: configured.enabled === true,
      authenticated: configured.enabled === true && adc.state === 'ready',
      stored: false,
      env: false,
      envName: null,
      label: p.name,
      detail: vertexAdcDetail(adc, vertexRowLocation(configured).location),
    };
  }
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
    ...customProviderRows(config.providers || {}, true).map((row) => ({
      id: row.id,
      type: 'api-key',
      enabled: row.enabled,
      authenticated: row.authenticated,
      stored: row.stored,
      env: row.env,
      envName: row.envName,
      label: row.name,
    })),
    ...availableOAuthProviders().map((p) => oauthProviderStatusRow(p, config)),
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
      else if (row.detail) source = row.detail;
      const enabled = row.enabled ? 'enabled' : 'disabled';
      return `${row.id.padEnd(width)}  ${row.type.padEnd(7)}  ${auth.padEnd(8)}  ${enabled.padEnd(8)}  ${source}`;
    })
    .join('\n');
}

function requireLocalProviderManagement() {
  if (modelProxyClientMode()) throw serverModelCredentialsDisabledError('Provider account management');
}

export async function authenticateProvider(provider, secret) {
  requireLocalProviderManagement();
  const id = String(provider || '').trim();
  if (!id) throw new Error('provider id is required');

  const oauth = availableOAuthProvider(id);
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
  await saveSecretAsync(SECRET_ACCOUNTS.agentApiKey(id), value);
  return { provider: id, type: 'api-key', authenticated: true };
}

export async function loginOAuthProvider(cfgMod, provider) {
  requireLocalProviderManagement();
  const id = String(provider || '').trim();
  const oauth = availableOAuthProvider(id);
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
    if (ACCOUNT_PROVIDERS.includes(id)) await clearProviderAccountQuotaState(id, currentProviderAccountId(id));
  }
  return { provider: id, type: 'oauth', authenticated: Boolean(auth.authenticated), status: auth.status || null };
}

function assertOAuthLoginOptions(options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !['addAccount', 'label', 'accountId', 'openBrowser'].includes(key)) ||
    (options.addAccount !== undefined && typeof options.addAccount !== 'boolean') ||
    (options.openBrowser !== undefined && typeof options.openBrowser !== 'boolean') ||
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
// The roster account (other than the implicit `default` one, whose credential
// lives outside the per-account store) that the fresh sign-in is the same real
// account as, or null.
function rosterAccountForIdentity(id, oauth, newAccountId, auth) {
  const identity = { id: auth.identityId, email: auth.email };
  const match = readProviderAccountPool(id).accounts.find((row) => {
    if (row.id === 'default' || row.id === newAccountId) return false;
    const existing = withProviderAccount(id, row.id, () => describeOAuthProvider(oauth));
    return sameAccountIdentity(identity, { id: existing.identityId, email: existing.email });
  });
  return match?.id || null;
}

async function settleOAuthLogin(
  { cfgMod, id, accountId: signedInId, addAccount, includeDefault, label, inAccount, oauth },
  result
) {
  const auth = inAccount(() => describeOAuthProvider(oauth));
  let accountId = signedInId;
  if (auth.authenticated) {
    // Signing the same real account in again replaces that roster entry's
    // credentials (label and order stay) instead of minting a second id.
    const existingId = addAccount ? rosterAccountForIdentity(id, oauth, signedInId, auth) : null;
    if (existingId) {
      renameSync(providerAccountPath(id, signedInId), providerAccountPath(id, existingId));
      accountId = existingId;
    }
    await registerProviderAccount(id, accountId, { includeDefault, label });
    // A re-connect can follow a re-created subscription under the same
    // account id: start it from no recorded quota rather than from the
    // exhausted window the previous credential earned.
    await clearProviderAccountQuotaState(id, accountId);
    updateConfigProvider(cfgMod, id, { enabled: true });
  }
  return {
    provider: id,
    type: 'oauth',
    authenticated: Boolean(auth.authenticated),
    status: auth.status || null,
    accountId,
    result,
  };
}

export async function beginOAuthProviderLogin(cfgMod, provider, options = {}) {
  requireLocalProviderManagement();
  const id = String(provider || '').trim();
  const oauth = availableOAuthProvider(id);
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
  // A remote client opens the authorization URL on its own machine and pastes
  // the final redirect back (completeCode), so the host must not pop a browser.
  const started = await inAccount(() => oauth.begin({ openBrowser: options.openBrowser !== false }));
  let cancelled = false;
  const login = {
    cfgMod,
    id,
    accountId,
    addAccount: options.addAccount === true,
    includeDefault,
    label: options.label,
    inAccount,
    oauth,
  };
  // The callback and a pasted code can both deliver the same sign-in; it must
  // settle once, because settling may move the credential to an existing id.
  let settled = null;
  let settling = null;
  const finish = async (result) => {
    if (!result || cancelled) return null;
    if (settled) return settled;
    // Settling is async now: a second delivery arriving mid-write shares it.
    if (settling) return settling;
    settling = settleOAuthLogin(login, result);
    try {
      const outcome = await settling;
      if (outcome.authenticated) settled = outcome;
      return outcome;
    } finally {
      settling = null;
    }
  };
  return {
    provider: id,
    type: 'oauth',
    url: started.url,
    manualUrl: started.manualUrl || null,
    userCode: started.userCode || null,
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
  if (!OAUTH_BY_ID.has(provider)) throw new TypeError('Unknown OAuth provider.');
  // Client mode: accounts live on the desktop, so this server's roster is
  // empty whatever this server's own provider availability says.
  if (modelProxyClientMode()) return { provider, auto: true, useCredits: false, selectedId: null, accounts: [] };
  const oauth = availableOAuthProvider(provider);
  if (!oauth) throw new TypeError('Unknown OAuth provider.');
  const pool = readProviderAccountPool(provider);
  const accounts = pool.accounts.length ? pool.accounts : defaultAccountRows(provider, oauth);
  const now = Date.now();
  return {
    provider,
    auto: pool.auto !== false,
    policy: pool.policy,
    useCredits: pool.useCredits === true,
    selectedId: pool.selectedId || accounts[0]?.id || null,
    accounts: accounts.map((row) => {
      const auth = withProviderAccount(provider, row.id, () => oauth.describe?.() || {});
      // A provider-side identity (email, account id) helps tell two accounts
      // apart when the user has not named them; shown as a secondary line.
      let identity = null;
      if (typeof auth.email === 'string' && auth.email.trim()) identity = auth.email.trim();
      else if (typeof auth.accountId === 'string' && auth.accountId.trim()) identity = auth.accountId.trim();
      // An organization-scoped login names the organization it acts for.
      if (typeof auth.orgName === 'string' && auth.orgName.trim()) {
        identity = identity ? `${identity} · ${auth.orgName.trim()}` : auth.orgName.trim();
      }
      return {
        id: row.id,
        label: row.label,
        authenticated: auth.authenticated === true,
        reauthRequired: auth.reauthRequired === true,
        usage: row.usage || null,
        // When the limit shown lifts: the latest deadline of every block.
        blockedUntil: providerAccountBlockedUntil(row) || null,
        // The limit holding the account now: account-wide, or only for one
        // model family ("7D Fable") while other models still run.
        limit: providerAccountLimit(row, now, { useCredits: pool.useCredits === true }),
        ...(identity ? { identity } : {}),
        ...(typeof auth.email === 'string' && auth.email.trim() ? { email: auth.email.trim() } : {}),
      };
    }),
  };
}

// A provider without a stored pool has one implicit account when it is signed in.
function defaultAccountRows(provider, oauth) {
  const authenticated = withProviderAccount(provider, 'default', () => oauth.describe?.().authenticated);
  return authenticated ? [{ id: 'default', label: 'Account 1' }] : [];
}

// Store the implicit signed-in `default` account in the roster, so a change or
// a usage measurement has a row to land on. Returns the current roster view.
export async function materializeProviderAccounts(provider) {
  requireLocalProviderManagement();
  const current = listProviderAccounts(provider);
  if (readProviderAccountPool(provider).accounts.length || !current.accounts.length) return current;
  await registerProviderAccount(provider, 'default', { label: 'Account 1' });
  return listProviderAccounts(provider);
}

export async function updateProviderAccounts(provider, change) {
  requireLocalProviderManagement();
  await materializeProviderAccounts(provider);
  await changeProviderAccounts(provider, change);
  // Picking an account by hand is a decision to use it NOW, so the refusal
  // window and meter stored against it — both describing the state the user
  // just changed — are dropped here. Never in the pool's own fallback commit,
  // where clearing them would send the request back to a spent account.
  if (change?.selectedId !== undefined) await clearProviderAccountQuotaState(provider, change.selectedId);
  return listProviderAccounts(provider);
}

export async function saveProviderApiKey(cfgMod, provider, secret, options) {
  requireLocalProviderManagement();
  const id = String(provider || '').trim();
  if (!API_PROVIDER_IDS.has(id)) throw new Error(`unknown API-key provider "${id}"`);
  const value = String(secret || '').trim();
  const adc = id === 'vertex-ai' && options?.authMode === VERTEX_ADC_MODE;
  const express = id === 'vertex-ai' && options?.authMode === VERTEX_API_KEY_MODE;
  if (!value && !adc) throw new Error(`API key is required for ${id}`);
  let patch = { enabled: true };
  if (id === 'vertex-ai') {
    if (adc && value) throw new Error('Vertex AI gcloud login takes no key');
    if (express && /[\s{]/.test(value)) throw new Error('Vertex AI express mode takes an API key, not a JSON key file');
    if (!adc && !express) parseVertexServiceAccount(value);
    // Only a location the user chose is saved: an empty one is unset (the
    // runtime then follows the environment's region, then global). None given
    // at all (the terminal setup) keeps a saved one; express mode never keeps
    // one, as it serves global only.
    const location = String(options?.location ?? '')
      .trim()
      .toLowerCase();
    const projectId = String(options?.projectId || '').trim();
    if (location && !/^[a-z0-9-]{1,63}$/.test(location)) throw new Error('Vertex AI location is invalid');
    if (express && location && location !== 'global') {
      throw new Error('Vertex AI express mode serves only the global location');
    }
    const locationPatch =
      location || express || options?.location !== undefined ? { location: location || undefined } : {};
    if (projectId && (!/^[a-zA-Z0-9._:-]{1,128}$/.test(projectId) || projectId.includes('/'))) {
      throw new Error('Vertex AI project ID override is invalid');
    }
    if (adc) {
      // gcloud login: nothing secret is stored, and the login must already be usable.
      let login = describeVertexAdc({ projectId });
      // No login file: a GCE / Cloud Run / GKE host's metadata server.
      if (login.state === 'missing' && (await probeVertexMetadata())) login = describeVertexAdc({ projectId });
      if (login.state !== 'ready') throw new Error(login.message);
      if (!login.projectId) {
        throw new Error(
          'No Google Cloud project found for the gcloud login. Enter a project ID override, or run `gcloud config set project PROJECT_ID`.'
        );
      }
      // The login replaces a key saved earlier rather than sitting beside it.
      const account = SECRET_ACCOUNTS.agentApiKey(id);
      if (hasStoredSecret(account)) await deleteSecretAsync(account);
      updateConfigProvider(cfgMod, id, {
        enabled: true,
        ...locationPatch,
        projectId: projectId || undefined,
        authMode: VERTEX_ADC_MODE,
      });
      return { provider: id, type: 'adc', authenticated: true };
    }
    patch = {
      enabled: true,
      ...locationPatch,
      projectId: projectId || undefined,
      authMode: express ? VERTEX_API_KEY_MODE : 'service-account',
    };
  }
  await saveSecretAsync(SECRET_ACCOUNTS.agentApiKey(id), value);
  updateConfigProvider(cfgMod, id, patch);
  return { provider: id, type: id === 'vertex-ai' && !express ? 'service-account' : 'api-key', authenticated: true };
}

function sanitizeCustomError(error, secrets = []) {
  let text = String(error?.message || error || 'request failed');
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|key|tok)[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/(api[-_]?key|authorization|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  if (text.length > 300) text = `${text.slice(0, 300)}…`;
  return new Error(text || 'request failed');
}

async function withTimeout(run, ms, label) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        Object.assign(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`), { code: 'EPROVIDERTIMEOUT' })
      );
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function existingCustomEntry(config, id) {
  const entry = config.providers?.[id];
  if (!isCustomProviderId(id) || !isCustomProviderConfig(entry)) throw new Error(`unknown custom provider "${id}"`);
  return entry;
}

export const CUSTOM_API_KEY_MAX = 65_536;

// Transport fields of a setup input, with the desktop IPC validator's rules
// (parity-tested): `id` absent (new provider) or a generated custom id, and
// `apiKey` absent or a bounded string — never null, whatever the auth mode.
function validateCustomTransportFields(input) {
  if (input.id !== undefined && (typeof input.id !== 'string' || !CUSTOM_ID_RE.test(input.id)))
    throw new TypeError('custom provider id is invalid');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > CUSTOM_API_KEY_MAX))
    throw new TypeError('custom provider apiKey is invalid');
  if (input.apiKeyEnv !== undefined && input.apiKeyEnv !== null) {
    if (typeof input.apiKeyEnv !== 'string' || !CUSTOM_API_KEY_ENV_RE.test(input.apiKeyEnv))
      throw new TypeError('custom provider apiKeyEnv is invalid');
    if (input.auth === 'none') throw new TypeError('custom provider apiKeyEnv requires key auth');
    if (typeof input.apiKey === 'string' && input.apiKey !== '')
      throw new TypeError('custom provider apiKey and apiKeyEnv are mutually exclusive');
  }
  if (input.extraApiKeys !== undefined) validateExtraApiKeys(input.extraApiKeys);
}

const CUSTOM_KEY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Additional API keys in use order, beside the primary key (MAX_ACCOUNTS in
// all): `{ id }` keeps a saved key, `{ apiKey }` adds one and `{ id, apiKey }`
// replaces a saved key's value; a blank `apiKey` keeps the saved key.
function validateExtraApiKeys(rows) {
  const invalid = () => new TypeError('custom provider extraApiKeys are invalid');
  if (!Array.isArray(rows) || rows.length >= MAX_ACCOUNTS) throw invalid();
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid();
    if (Object.keys(row).some((key) => key !== 'id' && key !== 'apiKey')) throw invalid();
    if (row.id !== undefined && (typeof row.id !== 'string' || !CUSTOM_KEY_ID_RE.test(row.id) || ids.has(row.id)))
      throw new TypeError('custom provider extraApiKeys id is invalid');
    if (row.apiKey !== undefined && (typeof row.apiKey !== 'string' || row.apiKey.length > CUSTOM_API_KEY_MAX))
      throw new TypeError('custom provider extraApiKeys apiKey is invalid');
    if (row.id === undefined && !row.apiKey?.trim()) throw new TypeError('custom provider additional API key is empty');
    if (row.id !== undefined) ids.add(row.id);
  }
}

// The additional-key change a save makes over the `saved` key ids: `rows`
// absent keeps them; a typed key is stored under a new id, so a replaced key
// starts without the old one's cooldown. A keyless provider keeps none.
function extraKeyPlan(saved, rows, keyless) {
  if (keyless) return { saved, ids: [], added: [], removed: saved };
  if (rows === undefined) return { saved, ids: saved, added: [], removed: [] };
  const ids = [];
  const added = [];
  for (const row of rows) {
    if (row.id !== undefined && !saved.includes(row.id)) throw new Error('An additional API key is no longer saved.');
    const typed = typeof row.apiKey === 'string' ? row.apiKey.trim() : '';
    if (!typed) {
      ids.push(row.id);
      continue;
    }
    const keyId = randomUUID();
    ids.push(keyId);
    added.push({ keyId, key: typed });
  }
  return { saved, ids, added, removed: saved.filter((keyId) => !ids.includes(keyId)) };
}

const extraKeysChanged = (plan) => plan.ids.join() !== plan.saved.join();

async function applyExtraKeys(id, plan) {
  for (const { keyId, key } of plan.added) await saveSecretAsync(customProviderKeyAccount(id, keyId), key);
  if (extraKeysChanged(plan)) await setCustomProviderKeyIds(id, plan.ids);
}

// A failed save puts the saved roster back and drops the keys it added.
async function revertExtraKeys(id, plan) {
  if (extraKeysChanged(plan)) await setCustomProviderKeyIds(id, plan.saved);
  for (const { keyId } of plan.added) await deleteSecretAsync(customProviderKeyAccount(id, keyId));
}

/** Whether the named environment variable is set to a non-empty value. */
export function checkCustomProviderKeyEnv(name) {
  if (typeof name !== 'string' || !CUSTOM_API_KEY_ENV_RE.test(name))
    throw new TypeError('environment variable name is invalid');
  return { found: Boolean(process.env[name]) };
}

function inputObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('custom provider is invalid');
  return input;
}

// An edit that omits a stored setting keeps it: `auth` for every input shape,
// and `discovery` / `modelOverrides` / `headers` for a v2 input (a legacy `models` input
// states the whole manual model list itself).
function withStoredSettings(input, entry) {
  const stored = storedCustomConfig(entry);
  if (!stored) {
    // Fixing an invalid entry still keeps its stated auth mode.
    if (input.auth !== undefined || (entry.auth !== 'key' && entry.auth !== 'none')) return input;
    return { ...input, auth: entry.auth };
  }
  const out = { ...input };
  if (out.auth === undefined) out.auth = stored.auth;
  if (out.apiKeyEnv === undefined && stored.apiKeyEnv) out.apiKeyEnv = stored.apiKeyEnv;
  if (out.schemaVersion === stored.schemaVersion) {
    if (out.discovery === undefined) out.discovery = stored.discovery;
    if (out.modelOverrides === undefined) out.modelOverrides = stored.modelOverrides;
    // `headers: {}` clears them; an omitted field keeps the stored ones.
    if (out.headers === undefined && stored.headers) out.headers = stored.headers;
    // Served wires and per-model wires have no setup field yet: an edit on
    // the same protocol keeps them (another protocol serves other wires).
    if ((out.protocol ?? stored.protocol) === stored.protocol) {
      if (out.wires === undefined && stored.wires) out.wires = stored.wires;
      if (out.modelWires === undefined && stored.modelWires) out.modelWires = stored.modelWires;
    }
  }
  return out;
}

// Validated, secret-free config for `input` over one config snapshot (the
// stored entry supplies an edit's omitted settings); the key (typed, else
// stored for an existing provider) is resolved separately and never enters
// the config. Synchronous, so a caller can merge and commit one snapshot.
function customInputAt(snapshot, input, normalizeCustomProviderConfig, options) {
  const id = input.id === undefined ? null : input.id;
  // Additional keys are secrets, applied by the save itself (extraKeyPlan).
  const { extraApiKeys: _extraKeys, ...settings } = input;
  const merged = id ? withStoredSettings(settings, existingCustomEntry(snapshot, id)) : settings;
  const config = normalizeCustomProviderConfig(merged, options);
  const typed = typeof merged.apiKey === 'string' ? merged.apiKey.trim() : '';
  const keyless = config.auth === 'none';
  const envName = keyless ? '' : config.apiKeyEnv || '';
  let apiKey = '';
  if (envName) apiKey = process.env[envName] || '';
  else if (!keyless) apiKey = typed || (id ? getAgentApiKey(id) || '' : '');
  return { id, config, typed: keyless || envName ? '' : typed, apiKey, keyless, envName };
}

async function resolveCustomInput(cfgMod, rawInput, options) {
  const input = inputObject(rawInput);
  validateCustomTransportFields(input);
  const { normalizeCustomProviderConfig } = await loadCustomProviderModule();
  return customInputAt(cfgMod.loadConfig(), input, normalizeCustomProviderConfig, options);
}

function requireCustomKey({ apiKey, keyless, envName }) {
  if (!keyless && !envName && !apiKey) throw new Error('API key is required');
}

// One key transaction per provider, from reading the rollback key to the
// config commit or rollback: a failed save restores the key the preceding
// save committed and never one a newer save wrote. Settings-only saves and
// other providers never wait.
const customKeySaves = new Map();

function serializeCustomKeySave(id, run) {
  const result = (customKeySaves.get(id) || Promise.resolve()).then(run);
  const settled = result.then(
    () => {},
    () => {}
  );
  customKeySaves.set(id, settled);
  settled.then(() => {
    if (customKeySaves.get(id) === settled) customKeySaves.delete(id);
  });
  return result;
}

export async function saveCustomProvider(cfgMod, rawInput) {
  requireLocalProviderManagement();
  // Early verdict: an invalid save never touches the keychain.
  const resolved = await resolveCustomInput(cfgMod, rawInput, { requireModels: false });
  requireCustomKey(resolved);
  const { id: existingId, typed } = resolved;
  const id = existingId || `custom-${randomUUID()}`;
  const { normalizeCustomProviderConfig } = await loadCustomProviderModule();
  const commit = async () => {
    const account = SECRET_ACCOUNTS.agentApiKey(id);
    const previousKey = typed && existingId ? getAgentApiKey(id) : null;
    // Auth as of this save's turn in the key queue: a no-auth save queued
    // earlier may have landed since the input was resolved.
    const keyless = existingId
      ? customInputAt(cfgMod.loadConfig(), rawInput, normalizeCustomProviderConfig, { requireModels: false }).keyless
      : resolved.keyless;
    const extra = extraKeyPlan(existingId ? customProviderKeyIds(id) : [], rawInput.extraApiKeys, keyless);
    if (typed) await saveSecretAsync(account, typed);
    let entry;
    try {
      await applyExtraKeys(id, extra);
      // Synchronous from here: omitted settings come from the config this
      // save commits over, so an edit that landed during the awaits above (a
      // model's visibility, a peer save, a removal) is never reverted.
      const current = cfgMod.loadConfig();
      const latest = customInputAt(current, rawInput, normalizeCustomProviderConfig, { requireModels: false });
      requireCustomKey(latest);
      entry = { ...latest.config, type: 'custom', enabled: latest.config.enabled !== false };
      cfgMod.saveConfig(
        { ...current, providers: { ...(current.providers || {}), [id]: entry } },
        { baseConfig: current }
      );
    } catch (error) {
      await revertExtraKeys(id, extra);
      if (typed) {
        if (previousKey) await saveSecretAsync(account, previousKey);
        else await deleteSecretAsync(account);
      }
      throw error;
    }
    // A removed key is dropped once the save holds; a keychain refusal then
    // leaves an unused secret behind (reported), never a failed save that did commit.
    for (const keyId of extra.removed) {
      await deleteSecretAsync(customProviderKeyAccount(id, keyId)).catch((error) => {
        process.stderr.write(
          `[provider-admin] could not delete additional API key ${keyId} of ${id}: ${error?.message || error}\n`
        );
      });
    }
    return customProviderRow(id, entry);
  };
  // Every save that may change the keys runs in the provider's key queue: a
  // typed key, an additional-key list, or a no-auth save (which drops them),
  // decided from the input alone, never from a roster read outside the queue.
  const keysChange = typed || rawInput.extraApiKeys !== undefined || (existingId && resolved.keyless);
  return keysChange ? serializeCustomKeySave(id, commit) : commit();
}

// Replaces only the stored key of an existing custom provider. The provider's
// settings are never read back and rewritten, so a concurrent edit of them
// (or a removal) is never reverted.
export async function saveCustomProviderKey(cfgMod, rawId, rawKey) {
  requireLocalProviderManagement();
  const id = String(rawId || '').trim();
  if (typeof rawKey !== 'string' || rawKey.length > CUSTOM_API_KEY_MAX)
    throw new TypeError('custom provider apiKey is invalid');
  const key = rawKey.trim();
  if (!key) throw new Error('API key is required');
  const takesStoredKey = () => {
    const entry = existingCustomEntry(cfgMod.loadConfig(), id);
    const config = storedCustomConfig(entry);
    if ((config?.auth ?? entry.auth) === 'none') throw new Error('this custom provider needs no API key');
    if (config?.apiKeyEnv) throw new Error(`this custom provider reads its key from ${config.apiKeyEnv}`);
    return entry;
  };
  takesStoredKey();
  // The provider's removal runs in the same queue, so it never lands between
  // the checks and the write below; a removal queued earlier is seen by the
  // check, before anything is written.
  return serializeCustomKeySave(id, async () => {
    takesStoredKey();
    const account = SECRET_ACCOUNTS.agentApiKey(id);
    const previousKey = getAgentApiKey(id);
    await saveSecretAsync(account, key);
    try {
      return customProviderRow(id, takesStoredKey());
    } catch (error) {
      // Switched to keyless (or the provider is gone) meanwhile: the key written
      // is dropped, and the previous one is only put back for a provider that exists.
      const exists = isCustomProviderConfig(cfgMod.loadConfig().providers?.[id]);
      if (exists && previousKey) await saveSecretAsync(account, previousKey);
      else await deleteSecretAsync(account);
      throw error;
    }
  });
}

const MODEL_PATCH_KEYS = new Set([
  'manual',
  'hidden',
  'name',
  'contextWindow',
  'maxOutputTokens',
  'supportsVision',
  'reasoning',
]);
const REASONING_PATCH_KEYS = new Set(['levels', 'wireFormat', 'wireValues', 'replay']);

// Tri-state merge: undefined preserves, null deletes the property, a value replaces it.
function applyTriState(base, patch) {
  const out = new Map(Object.entries(base || {}));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) out.delete(key);
    else out.set(key, value);
  }
  return Object.fromEntries(out);
}

function plainPatch(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label} has unsupported field`);
  return value;
}

// Edit one model's override without resubmitting the provider. `patch === null`
// removes the whole override; reasoning is merged key by key with the same
// tri-state rules. Semantic validation is the runtime normalizer's.
export async function updateCustomProviderModel(cfgMod, rawId, rawModelId, patch) {
  requireLocalProviderManagement();
  const id = String(rawId || '').trim();
  const modelId = typeof rawModelId === 'string' ? rawModelId.trim() : '';
  if (!modelId) throw new TypeError('model id is required');
  const { normalizeCustomProviderConfig, canonicalReasoningLevel, assertCustomReasoningPatch } =
    await loadCustomProviderModule();
  // Everything below is synchronous: the provider is read, patched and saved
  // without yielding, so a concurrent update can never be overwritten by a
  // provider object read before the await above.
  const entry = existingCustomEntry(cfgMod.loadConfig(), id);
  const current = normalizeCustomProviderConfig(entry, { requireModels: false });
  const overrides = new Map(Object.entries(current.modelOverrides || {}));
  if (patch === null) {
    overrides.delete(modelId);
  } else {
    plainPatch(patch, MODEL_PATCH_KEYS, 'model patch');
    const { reasoning, ...rest } = patch;
    let next = applyTriState(overrides.get(modelId), rest);
    // The supplied reasoning values are validated as sent, before any pruning
    // can hide a malformed mapping.
    if (reasoning !== undefined && reasoning !== null) {
      plainPatch(reasoning, REASONING_PATCH_KEYS, 'reasoning patch');
      assertCustomReasoningPatch(reasoning);
    }
    if (reasoning !== undefined) {
      const nextReasoning =
        reasoning === null
          ? {}
          : applyTriState(next.reasoning, plainPatch(reasoning, REASONING_PATCH_KEYS, 'reasoning patch'));
      // New levels retire the wire values of levels they no longer list
      // (clearing the last level included), instead of failing validation.
      if (
        Array.isArray(reasoning?.levels) &&
        nextReasoning.wireValues &&
        typeof nextReasoning.wireValues === 'object'
      ) {
        const kept = new Set(reasoning.levels.map(canonicalReasoningLevel));
        const wireValues = Object.fromEntries(
          Object.entries(nextReasoning.wireValues).filter(([level]) => kept.has(canonicalReasoningLevel(level)))
        );
        if (Object.keys(wireValues).length) nextReasoning.wireValues = wireValues;
        else delete nextReasoning.wireValues;
      }
      const { reasoning: _old, ...withoutReasoning } = next;
      next = Object.keys(nextReasoning).length ? { ...withoutReasoning, reasoning: nextReasoning } : withoutReasoning;
    }
    if (Object.keys(next).length) overrides.set(modelId, next);
    else overrides.delete(modelId);
  }
  const config = normalizeCustomProviderConfig(
    { ...current, modelOverrides: Object.fromEntries(overrides) },
    { requireModels: false }
  );
  const saved = { ...config, type: 'custom', enabled: entry.enabled !== false };
  const full = cfgMod.loadConfig();
  cfgMod.saveConfig({ ...full, providers: { ...(full.providers || {}), [id]: saved } }, { baseConfig: full });
  return customProviderRow(id, saved);
}

const MODEL_PREFERENCE_KEYS = new Set(['model', 'hidden', 'favorite']);
export const MODEL_PREFERENCE_CHANGES_MAX = 5_000;

function modelPreferenceChanges(raw) {
  if (!Array.isArray(raw) || raw.length > MODEL_PREFERENCE_CHANGES_MAX) {
    throw new TypeError('model preference changes are invalid');
  }
  return raw.map((change) => {
    plainPatch(change, MODEL_PREFERENCE_KEYS, 'model preference change');
    const model = typeof change.model === 'string' ? change.model.trim() : '';
    if (!model) throw new TypeError('model id is required');
    for (const key of ['hidden', 'favorite']) {
      if (change[key] !== undefined && typeof change[key] !== 'boolean') {
        throw new TypeError(`model preference ${key} is invalid`);
      }
    }
    return { model, hidden: change.hidden, favorite: change.favorite };
  });
}

/**
 * The model management card's save for one provider: whether each model is
 * listed in /model (`hidden`) and whether it is a favorite. Both live in the
 * shared per-model store `modelSettings["provider/model"]` — except a custom
 * provider's visibility, which stays its own `modelOverrides[id].hidden`, the
 * store its edit dialog, the runtime catalog and SSH servers already honor.
 * `hidden: false` is an explicit choice (it also lists a model the family
 * limit would leave out); an absent field keeps the stored value.
 */
export function saveModelPreferences(cfgMod, rawProvider, rawChanges) {
  const provider = String(rawProvider || '').trim();
  const changes = modelPreferenceChanges(rawChanges);
  const full = cfgMod.loadConfig();
  if (!isKnownProvider(provider, full)) throw new TypeError(`unknown provider "${provider}"`);
  const custom = isCustomProviderId(provider);
  const modelSettings = { ...(full.modelSettings || {}) };
  for (const { model, hidden, favorite } of changes) {
    const key = `${provider}/${model}`;
    const setting = { ...(modelSettings[key] || {}) };
    if (hidden !== undefined && !custom) setting.hidden = hidden;
    if (favorite === true) setting.favorite = true;
    else if (favorite === false) delete setting.favorite;
    if (Object.keys(setting).length) modelSettings[key] = setting;
    else delete modelSettings[key];
  }
  const next = { ...full, modelSettings };
  const customHidden = custom ? changes.filter((change) => change.hidden !== undefined) : [];
  if (customHidden.length) {
    requireLocalProviderManagement();
    const entry = full.providers[provider];
    const current = normalizeStoredCustomConfig(entry);
    const overrides = new Map(Object.entries(current.modelOverrides || {}));
    for (const { model, hidden } of customHidden) overrides.set(model, { ...overrides.get(model), hidden });
    const config = normalizeStoredCustomConfig({ ...current, modelOverrides: Object.fromEntries(overrides) });
    next.providers = {
      ...full.providers,
      [provider]: { ...config, type: 'custom', enabled: entry.enabled !== false },
    };
  }
  cfgMod.saveConfig(next, { baseConfig: full });
  return { provider, changed: changes.length, customCatalogChanged: customHidden.length > 0 };
}

// Drops every stored model setting and route that names the provider.
function withoutProviderReferences(config, id) {
  const next = { ...config };
  const names = (route) => route?.provider === id;
  if (next.modelSettings) {
    next.modelSettings = Object.fromEntries(
      Object.entries(next.modelSettings).filter(([key]) => !key.startsWith(`${id}/`))
    );
  }
  if (next.agents) {
    next.agents = Object.fromEntries(Object.entries(next.agents).filter(([, route]) => !names(route)));
  }
  if (names(next.webSearchRoute)) delete next.webSearchRoute;
  if (Array.isArray(next.presets)) {
    const dropped = new Set(next.presets.filter(names).map((preset) => preset.id));
    next.presets = next.presets.filter((preset) => !names(preset));
    if (dropped.has(next.default)) delete next.default;
  }
  return next;
}

export async function removeCustomProvider(cfgMod, rawId) {
  requireLocalProviderManagement();
  const id = String(rawId || '').trim();
  existingCustomEntry(cfgMod.loadConfig(), id);
  // In the provider's key queue: a key write in flight finishes first and
  // none starts between the secret's deletion and the config's.
  return serializeCustomKeySave(id, async () => {
    existingCustomEntry(cfgMod.loadConfig(), id);
    // Secret first: a real keychain failure (locked, permission) leaves the
    // provider registered so the removal can be retried. A missing secret
    // (keyless provider) is not an error.
    await deleteSecretAsync(SECRET_ACCOUNTS.agentApiKey(id));
    const extraKeyIds = customProviderKeyIds(id);
    for (const keyId of extraKeyIds) await deleteSecretAsync(customProviderKeyAccount(id, keyId));
    if (extraKeyIds.length) await setCustomProviderKeyIds(id, []);
    const current = cfgMod.loadConfig();
    const { [id]: _removed, ...providers } = current.providers || {};
    cfgMod.saveConfig(withoutProviderReferences({ ...current, providers }, id), { baseConfig: current });
    return { provider: id, type: 'custom', removed: true };
  });
}

export async function testCustomProvider(cfgMod, rawInput) {
  requireLocalProviderManagement();
  const { id, config, apiKey } = await resolveCustomInput(cfgMod, rawInput, { requireModels: false });
  try {
    // The first visible manual model needs no discovery; otherwise the first
    // visible discovered one.
    let model = effectiveCustomModelRows(config, [], { providerId: id || 'custom-test' }).find((m) => !m.hidden)?.id;
    if (!model) {
      const discovery = await discoverCustomProviderModels(cfgMod, rawInput);
      if (discovery.error) return { ok: false, phase: 'discovery', error: discovery.error };
      model = discovery.models.find((m) => !m.hidden)?.id;
    }
    if (!model)
      return {
        ok: false,
        phase: 'discovery',
        error: { kind: 'empty', message: 'No models were found for this provider' },
      };
    const { createCustomProvider } = await loadCustomProviderModule();
    const primary = await createCustomProvider(id || 'custom-test', { ...config, apiKey });
    // A provider with additional keys tests through the same key pool as a
    // real request: an explicit quota refusal moves on to the next key.
    const keyIds = id && !config.apiKeyEnv && config.auth !== 'none' ? customProviderKeyIds(id) : [];
    let provider = primary;
    let routingKey;
    if (keyIds.length) {
      const [pool, keys] = await Promise.all([
        import('../../runtime/agent/orchestrator/providers/account-pool.mjs'),
        import('../../runtime/agent/orchestrator/providers/custom-provider-keys.mjs'),
      ]);
      routingKey = pool.ROUTING_METADATA_KEY;
      provider = pool.createCustomKeyPoolProvider(id, primary, (keyId) => keys.customKeyEngine(primary, id, keyId));
    }
    const answer = await withTimeout(
      (signal) => provider.send([{ role: 'user', content: 'Reply with OK.' }], model, [], { signal, maxTokens: 16 }),
      CUSTOM_TEST_TIMEOUT_MS,
      'connection test'
    );
    // Key numbers count the primary key as 1.
    const served = routingKey ? answer?.providerMetadata?.[routingKey]?.accountId : undefined;
    const index = keyIds.indexOf(served);
    return index < 0 ? { ok: true } : { ok: true, key: { id: served, number: index + 2 } };
  } catch (error) {
    throw sanitizeCustomError(error, customSecrets(apiKey, config));
  }
}

// Every key the operation may have sent: env mode re-reads the variable on an
// auth retry, so its current value is redacted alongside the initial key.
function customSecrets(apiKey, config) {
  return [apiKey, config.apiKeyEnv ? process.env[config.apiKeyEnv] : ''];
}

export async function discoverCustomProviderModels(cfgMod, rawInput) {
  requireLocalProviderManagement();
  const { id, config, apiKey } = await resolveCustomInput(cfgMod, rawInput, { requireModels: false });
  try {
    const { createCustomProvider } = await loadCustomProviderModule();
    const provider = await createCustomProvider(id || 'custom-discovery', { ...config, apiKey });
    const listed = await withTimeout(
      (signal) => provider.listModels({ signal, timeoutMs: CUSTOM_DISCOVERY_TIMEOUT_MS }),
      CUSTOM_DISCOVERY_TIMEOUT_MS,
      'model discovery'
    );
    const models = publicCustomModelRows(listed);
    // A failed discovery that still left manual rows reports its error too.
    const failure = provider.customDiscoveryError;
    return failure ? { models, error: discoveryErrorView(failure, customSecrets(apiKey, config)) } : { models };
  } catch (error) {
    return { models: [], error: discoveryErrorView(error, customSecrets(apiKey, config)) };
  }
}

function discoveryErrorView(error, secrets) {
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  const authKind = status === 401 || status === 403 ? 'authentication' : 'request';
  const kind = status === 404 || status === 405 ? 'unavailable' : authKind;
  return {
    kind: error?.code === 'EPROVIDERTIMEOUT' ? 'timeout' : kind,
    ...(status === undefined ? {} : { status }),
    message: sanitizeCustomError(error, secrets).message,
  };
}

export async function saveOpenAIUsageSessionKey(cfgMod, secret) {
  requireLocalProviderManagement();
  const value = String(secret || '').trim();
  if (!value) throw new Error('OpenAI usage session key is required for credit lookup');
  await saveSecretAsync(SECRET_ACCOUNTS.openaiUsageSessionKey, value);
  updateConfigProvider(cfgMod, 'openai', { enabled: true });
  return { provider: 'openai', type: 'usage-auth', authenticated: true };
}

export async function forgetProviderAuth(cfgModOrProvider, maybeProvider, requestedAccountId) {
  requireLocalProviderManagement();
  const cfgMod = maybeProvider === undefined ? null : cfgModOrProvider;
  const id = String(maybeProvider === undefined ? cfgModOrProvider : maybeProvider || '').trim();
  const oauth = availableOAuthProvider(id);
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
    const pool = await removeProviderAccount(id, accountId);
    if (cfgMod) updateConfigProvider(cfgMod, id, { enabled: pool.accounts.length > 0 });
    return { provider: id, type: 'oauth', forgotten: true, removed: Boolean(result?.removed) };
  }
  if (!API_PROVIDER_IDS.has(id)) {
    throw new Error(`unknown provider "${id}"`);
  }
  await deleteSecretAsync(SECRET_ACCOUNTS.agentApiKey(id));
  if (cfgMod) updateConfigProvider(cfgMod, id, { enabled: false });
  return { provider: id, type: 'api-key', forgotten: true };
}
