/**
 * Credential resolution for media lanes.
 *
 * OAuth lanes reuse the chat providers' token stores (including their refresh
 * paths) so the Studio never holds a second copy of a session. API-key lanes
 * read the same keychain-backed store the agent providers use.
 */
import { readSection } from '../shared/config.mjs';
import {
  getAgentApiKey,
  hasAgentApiKey,
  hasProviderApiKey,
  resolveProviderApiKey,
} from '../shared/provider-api-key.mjs';

export { hasGrokOAuthCredentials } from '../agent/orchestrator/providers/oauth-credential-probes.mjs';

const XAI_BASE_URL = 'https://api.x.ai/v1';
// Both gateways serve the same normalized Image API (GET /images/models,
// POST /images) under these documented bases.
const IMAGE_API_BASE_URL = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1',
  'nano-gpt': 'https://api.nano-gpt.com/api/v1',
});

/** Lanes served by the normalized Image API adapter. */
export function imageApiLane(laneId) {
  return Object.hasOwn(IMAGE_API_BASE_URL, laneId);
}

function nanoGptHost(baseURL) {
  try {
    const host = new URL(String(baseURL || '')).hostname.toLowerCase();
    return host === 'nano-gpt.com' || host.endsWith('.nano-gpt.com');
  } catch {
    return false;
  }
}

// NanoGPT is not a built-in provider: it is connected as an OpenAI-compatible
// custom provider, whose key lives under that provider's own id (keychain or
// its configured environment variable). The first enabled, keyed endpoint on
// a NanoGPT host is the lane's credential.
function nanoGptProviders() {
  const providers = readSection('agent')?.providers || {};
  return Object.entries(providers).filter(
    ([id, entry]) =>
      id.startsWith('custom-') &&
      entry?.type === 'custom' &&
      entry.enabled !== false &&
      entry.auth !== 'none' &&
      nanoGptHost(entry.baseURL)
  );
}

/** Presence-only probe for an Image API lane's key; no secret is read. */
export function hasImageApiCredentials(laneId) {
  if (laneId === 'openrouter') return hasAgentApiKey('openrouter');
  if (laneId === 'nano-gpt') return nanoGptProviders().some(([id, entry]) => hasProviderApiKey(id, entry));
  return false;
}

/** Base URL + bearer for an Image API lane (OpenRouter key, or the connected NanoGPT custom provider's key). */
export function resolveImageApiAuth(laneId) {
  let token = '';
  if (laneId === 'openrouter') token = getAgentApiKey('openrouter') || '';
  else if (laneId === 'nano-gpt') {
    for (const [id, entry] of nanoGptProviders()) {
      token = resolveProviderApiKey(id, entry);
      if (token) break;
    }
  }
  if (!imageApiLane(laneId) || !token) throw unauthenticated(`${laneId} API key is not configured`);
  return { baseURL: IMAGE_API_BASE_URL[laneId], token };
}

// Built here rather than with lanes.mjs's mediaError: importing it would close
// an auth -> lanes -> catalog -> auth module cycle.
function unauthenticated(message) {
  const err = new Error(message);
  err.code = 'MEDIA_LANE_UNAUTHENTICATED';
  err.status = 401;
  return err;
}

/**
 * Bearer for the xAI media endpoints. `grok-oauth` refreshes through the chat
 * provider; `xai` uses the stored API key. Both hit the same api.x.ai routes.
 */
export async function resolveXaiAuth(laneId) {
  if (laneId === 'xai') {
    const key = getAgentApiKey('xai');
    if (!key) throw unauthenticated('xAI API key is not configured');
    return { baseURL: XAI_BASE_URL, token: key };
  }
  const { GrokOAuthProvider } = await import('../agent/orchestrator/providers/grok-oauth.mjs');
  const provider = new GrokOAuthProvider({});
  const tokens = await provider.ensureAuth();
  // The bearer rotates on every refresh, so it cannot identify this credential
  // across sessions. The account id can, exactly like Antigravity's Cloud
  // project: without it the catalog cache re-keyed on each refresh, re-fetched
  // on every Studio entry, and lost its own offline fallback.
  return { baseURL: XAI_BASE_URL, token: tokens.access_token, accountId: tokens.user_id || '' };
}

/** Codex (ChatGPT OAuth) auth record: access token + account id for headers. */
export async function resolveCodexAuth() {
  const { OpenAIOAuthProvider } = await import('../agent/orchestrator/providers/openai-oauth.mjs');
  const provider = new OpenAIOAuthProvider({});
  return await provider.ensureAuth();
}

/**
 * Antigravity bearer + Cloud project. The chat provider's token store owns the
 * refresh; the client version is warmed so discovery and generation present the
 * same hub identity the gateway version-gates on.
 */
export async function resolveAntigravityAuth() {
  const tokens = await import('../agent/orchestrator/providers/antigravity-oauth-tokens.mjs');
  await tokens.ensureAntigravityVersion();
  const current = await tokens.ensureAccessToken();
  return { token: current.access_token, projectId: current.project_id };
}

export function resolveGeminiKey() {
  const key = getAgentApiKey('gemini');
  if (!key) throw unauthenticated('Gemini API key is not configured');
  return key;
}
