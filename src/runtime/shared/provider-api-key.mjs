import { createRequire } from 'node:module';
import { modelProxyClientMode } from './model-proxy-mode.mjs';

const require = createRequire(import.meta.url);
const { getSecret, getSecretAsync, hasSecret } = require('../../lib/keychain-cjs.cjs');

// Lightweight API-key lookup shared by pristine startup and the general config
// loader. This module deliberately has no mixdog-config.json dependency: asking
// for one provider probes only that provider's environment/keychain account.
export const AGENT_PROVIDER_ENV = Object.freeze({
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
});

export const AGENT_PROVIDER_ENV_ALIASES = Object.freeze({
  xai: ['GROK_API_KEY'],
});

function providerSecretEnv(provider) {
  return `MIXDOG_AGENT_${String(provider || '')
    .replace(/[.\s]+/g, '_')
    .toUpperCase()}_APIKEY`;
}

function environmentApiKey(provider) {
  const id = String(provider || '').trim();
  const standardEnv = AGENT_PROVIDER_ENV[id];
  if (standardEnv && process.env[standardEnv]) return process.env[standardEnv];
  const mixdogEnv = providerSecretEnv(id);
  if (process.env[mixdogEnv]) return process.env[mixdogEnv];
  for (const alias of AGENT_PROVIDER_ENV_ALIASES[id] || []) {
    if (process.env[alias]) return process.env[alias];
  }
  return null;
}

/** Presence-only credential probe. On Windows this is a cheap DPAPI-file
 * check; decrypting through PowerShell is reserved for an actual API call. */
export function hasAgentApiKey(provider) {
  // Remote mode: this server holds no model credentials (model-proxy-mode.mjs).
  if (modelProxyClientMode()) return false;
  const id = String(provider || '').trim();
  if (!id) return false;
  if (environmentApiKey(id)) return true;
  try {
    return hasSecret(`agent.${id}.apiKey`);
  } catch {
    return false;
  }
}

export function getAgentApiKey(provider) {
  if (modelProxyClientMode()) return null;
  const id = String(provider || '').trim();
  const environment = environmentApiKey(id);
  if (environment) return environment;
  try {
    const stored = getSecret(`agent.${id}.apiKey`);
    if (stored) return stored;
  } catch {
    // A missing/locked keychain is equivalent to no stored key. Explicit
    // environment aliases remain available as the final provider-local source.
  }
  return null;
}

/** The one API-key resolver for key-based providers: an explicit config key
 *  wins, otherwise the environment/keychain (getAgentApiKey). */
export function resolveProviderApiKey(provider, config) {
  if (config?.apiKeyEnv) return process.env[config.apiKeyEnv] || '';
  return config?.apiKey || getAgentApiKey(provider) || '';
}

/** Presence twin of resolveProviderApiKey, same precedence, no key value read. */
export function hasProviderApiKey(provider, config) {
  if (config?.apiKeyEnv) return Boolean(process.env[config.apiKeyEnv]);
  return Boolean(config?.apiKey) || hasAgentApiKey(provider);
}

/** Auth-error reload: the stored/environment key is re-read first so a
 *  rotated key beats the stale one captured in config. */
export function reloadProviderApiKey(provider, config) {
  if (config?.apiKeyEnv) return process.env[config.apiKeyEnv] || '';
  return getAgentApiKey(provider) || config?.apiKey || '';
}

/** One provider's key read on demand, warming no other account: the
 *  environment first (getAgentApiKey's precedence), then only this provider's
 *  keychain entry through the async path (no whole-keyring snapshot). */
export async function readAgentApiKeyAsync(provider) {
  if (modelProxyClientMode()) return null;
  const id = String(provider || '').trim();
  if (!id) return null;
  const environment = environmentApiKey(id);
  if (environment) return environment;
  try {
    return (await getSecretAsync(`agent.${id}.apiKey`)) || null;
  } catch {
    return null;
  }
}
