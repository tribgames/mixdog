// A pre-registered OAuth client for an MCP server, used as static client
// information in place of dynamic client registration:
//   - the user's own (custom connector → 고급 설정 → 앱 번호/비밀값): the id
//     in the server config (`oauthClientId`, not a secret), the secret only in
//     the keychain under mcpOAuthClientSecretAccount(url);
//   - else the catalog connector's (connector-catalog.mjs `oauthClient`), with
//     its scopes and the provider's offline-access parameter.
import { createHash } from 'node:crypto';
import keychain from '../../../../lib/keychain-cjs.cjs';
import { connectorById, connectorOfServer } from '../../../shared/connector-catalog.mjs';
import { GOOGLE_AUTH_PARAMS, googleOAuthClient } from '../../../shared/google-oauth-client.mjs';
import { normalizeMcpTransportUrl } from './client-config.mjs';

const BUILT_IN_CLIENTS = {
  google: () => {
    const client = googleOAuthClient();
    return client && { ...client, authParams: GOOGLE_AUTH_PARAMS };
  },
};

/** The keychain account of the user's client secret for one server URL. */
export function mcpOAuthClientSecretAccount(url) {
  const key = normalizeMcpTransportUrl(String(url));
  return `mcp-oauth-client.${createHash('sha256').update(key).digest('hex')}`;
}

/** Store (or, with '', delete) the user's client secret for server `url`. */
export async function saveMcpOAuthClientSecret(url, secret, credentialStore = keychain) {
  const account = mcpOAuthClientSecretAccount(url);
  if (secret) await credentialStore.setSecretAsync(account, secret);
  else await credentialStore.deleteSecretAsync(account);
}

/** What the sign-in page calls server `name` configured as `cfg`: a catalog
 *  connector's display name ("Google Drive"), else the server name. */
export function mcpOAuthDisplayName(cfg, name) {
  return connectorById(connectorOfServer(cfg))?.name || name;
}

/**
 * `{ clientId, clientSecret?, secretAccount?, scopes?, authParams? }` for
 * server config `cfg` at `url`, or null to register a client dynamically.
 */
export function mcpOAuthClientFor(cfg, url) {
  const backend = connectorById(connectorOfServer(cfg))?.backend;
  const catalog = backend?.kind === 'oauth' ? backend : null;
  const scopes = catalog?.scopes ? [...catalog.scopes] : undefined;
  const own = typeof cfg?.oauthClientId === 'string' ? cfg.oauthClientId.trim() : '';
  if (own) {
    const authParams = catalog?.oauthClient === 'google' ? GOOGLE_AUTH_PARAMS : undefined;
    return { clientId: own, secretAccount: mcpOAuthClientSecretAccount(url), scopes, authParams };
  }
  const builtIn = catalog?.oauthClient ? BUILT_IN_CLIENTS[catalog.oauthClient]?.() : null;
  return builtIn ? { ...builtIn, scopes } : null;
}
