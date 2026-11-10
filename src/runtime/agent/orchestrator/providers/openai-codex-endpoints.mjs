/**
 * Codex backend endpoint identity for the openai-oauth provider.
 *
 * One origin serves the OAuth transports (responses) and the model catalog,
 * and every request carries the same originator token. Keeping the three in
 * one leaf module means the transport, the catalog query and the connection
 * prewarm can never drift onto different hosts. openai-oauth.mjs re-exports
 * CODEX_RESPONSES_URL / CODEX_OAUTH_ORIGINATOR for existing importers.
 */
export const CODEX_BACKEND_ORIGIN = 'https://chatgpt.com';
const CODEX_BACKEND_BASE = `${CODEX_BACKEND_ORIGIN}/backend-api/codex`;
export const CODEX_RESPONSES_URL = `${CODEX_BACKEND_BASE}/responses`;
export const CODEX_OAUTH_ORIGINATOR = 'codex_cli_rs';

/**
 * Catalog endpoint. The backend gates model exposure on the reported client
 * version, so the query always carries the version the transports report.
 */
export function codexModelsUrl(clientVersion) {
  return `${CODEX_BACKEND_BASE}/models?client_version=${clientVersion}`;
}
