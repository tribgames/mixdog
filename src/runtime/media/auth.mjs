/**
 * Credential resolution for media lanes.
 *
 * OAuth lanes reuse the chat providers' token stores (including their refresh
 * paths) so the Studio never holds a second copy of a session. API-key lanes
 * read the same keychain-backed store the agent providers use.
 */
import { getAgentApiKey } from '../shared/provider-api-key.mjs';

export { hasGrokOAuthCredentials } from '../agent/orchestrator/providers/oauth-credential-probes.mjs';

const XAI_BASE_URL = 'https://api.x.ai/v1';

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
