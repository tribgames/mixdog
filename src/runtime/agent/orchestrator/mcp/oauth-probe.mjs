/**
 * mcp/oauth-probe.mjs — what authentication an HTTP/SSE server (being added or
 * edited) needs, decided without credentials and without a browser: one
 * anonymous request, then OAuth discovery (RFC 9728 protected-resource
 * metadata, RFC 8414 / OIDC authorization-server metadata) on a 401.
 */
import {
  normalizeMcpTransportUrl,
  resolveMcpOAuthUrl,
  resolveMcpTransportKind,
  scrubMcpConnectionMessage,
} from './client-config.mjs';
import { hasConfiguredMcpAuth } from './client-transport.mjs';

export const MCP_AUTH_PROBE_TIMEOUT_MS = 10_000;

const INITIALIZE_PROBE = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'mixdog-auth-probe', version: '1' },
  },
});

/**
 * `cfg = { type: 'http' | 'sse', url, headers?, bearer_token_env_var?, env_http_headers? }`
 * → `{ auth: 'oauth' | 'none' | 'configured' | 'unreachable', error? }`.
 * Configured authentication is authoritative and never sent anywhere.
 */
export async function probeMcpServerAuth(cfg, { fetchImpl = fetch, timeoutMs = MCP_AUTH_PROBE_TIMEOUT_MS } = {}) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new TypeError('MCP server config is required');
  const kind = resolveMcpTransportKind(cfg);
  if (kind !== 'http' && kind !== 'sse') throw new Error('MCP auth probe needs an http or sse server');
  const url = resolveMcpOAuthUrl(cfg);
  if (hasConfiguredMcpAuth(cfg)) return { auth: 'configured' };
  const deadline = AbortSignal.timeout(timeoutMs);
  // Same policy as the OAuth login's own requests: normalized URLs, no
  // redirects, and nothing outlives the probe's budget.
  const probeFetch = (input, init = {}) =>
    fetchImpl(normalizeMcpTransportUrl(String(input)), {
      ...init,
      redirect: 'error',
      signal: init.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
    });
  const failure = (error) => ({
    auth: 'unreachable',
    error: scrubMcpConnectionMessage(
      deadline.aborted ? `no answer within ${timeoutMs}ms` : String(error?.cause?.message || error?.message || error),
      cfg
    ),
  });
  let response;
  try {
    response =
      kind === 'http'
        ? await probeFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: INITIALIZE_PROBE,
          })
        : await probeFetch(url, { headers: { Accept: 'text/event-stream' } });
  } catch (error) {
    return failure(error);
  }
  // The body is discarded; a failed cancel changes nothing.
  await response.body?.cancel().catch(() => {});
  if (response.status === 404 || response.status >= 500)
    return { auth: 'unreachable', error: `HTTP ${response.status}` };
  if (response.status !== 401) return { auth: 'none' };
  try {
    const { discoverOAuthServerInfo, extractWWWAuthenticateParams } = await import(
      '@modelcontextprotocol/sdk/client/auth.js'
    );
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
    const { authorizationServerMetadata } = await discoverOAuthServerInfo(url, {
      resourceMetadataUrl,
      fetchFn: probeFetch,
    });
    if (authorizationServerMetadata) return { auth: 'oauth' };
  } catch (error) {
    if (deadline.aborted) return failure(error);
  }
  return { auth: 'none', error: 'HTTP 401: the server requires authentication but offers no OAuth sign-in' };
}
