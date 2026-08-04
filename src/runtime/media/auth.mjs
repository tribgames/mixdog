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

/**
 * Bearer for the xAI media endpoints. `grok-oauth` refreshes through the chat
 * provider; `xai` uses the stored API key. Both hit the same api.x.ai routes.
 */
export async function resolveXaiAuth(laneId) {
  if (laneId === 'xai') {
    const key = getAgentApiKey('xai');
    if (!key) {
      const err = new Error('xAI API key is not configured');
      err.code = 'MEDIA_LANE_UNAUTHENTICATED';
      err.status = 401;
      throw err;
    }
    return { baseURL: XAI_BASE_URL, token: key };
  }
  const { GrokOAuthProvider } = await import('../agent/orchestrator/providers/grok-oauth.mjs');
  const provider = new GrokOAuthProvider({});
  const tokens = await provider.ensureAuth();
  return { baseURL: XAI_BASE_URL, token: tokens.access_token };
}

/** Codex (ChatGPT OAuth) auth record: access token + account id for headers. */
export async function resolveCodexAuth() {
  const { OpenAIOAuthProvider } = await import('../agent/orchestrator/providers/openai-oauth.mjs');
  const provider = new OpenAIOAuthProvider({});
  return await provider.ensureAuth();
}

export function resolveGeminiKey() {
  const key = getAgentApiKey('gemini');
  if (!key) {
    const err = new Error('Gemini API key is not configured');
    err.code = 'MEDIA_LANE_UNAUTHENTICATED';
    err.status = 401;
    throw err;
  }
  return key;
}
