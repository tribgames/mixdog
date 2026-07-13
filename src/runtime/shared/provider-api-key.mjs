import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getSecret } = require('../../lib/keychain-cjs.cjs');

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
});

export const AGENT_PROVIDER_ENV_ALIASES = Object.freeze({
  xai: ['GROK_API_KEY'],
});

function providerSecretEnv(provider) {
  return `MIXDOG_AGENT_${String(provider || '').replace(/[.\s]+/g, '_').toUpperCase()}_APIKEY`;
}

export function getAgentApiKey(provider) {
  const id = String(provider || '').trim();
  const standardEnv = AGENT_PROVIDER_ENV[id];
  if (standardEnv && process.env[standardEnv]) return process.env[standardEnv];
  const mixdogEnv = providerSecretEnv(id);
  if (process.env[mixdogEnv]) return process.env[mixdogEnv];
  try {
    const stored = getSecret(`agent.${id}.apiKey`);
    if (stored) return stored;
  } catch {
    // A missing/locked keychain is equivalent to no stored key. Explicit
    // environment aliases remain available as the final provider-local source.
  }
  for (const alias of AGENT_PROVIDER_ENV_ALIASES[id] || []) {
    if (process.env[alias]) return process.env[alias];
  }
  return null;
}
