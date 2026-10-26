// The keychain side of MCP server edits: storing a server's OAuth client
// secret or Gmail app password, and releasing a removed server's or account's
// sign-in once no other configured server shares it.
import {
  gmailAppPasswordAccount,
  gmailAppPasswordValue,
  connectorAccountServers,
} from '../runtime/shared/connector-catalog.mjs';
import { forgetConnectorAccountHealth } from '../runtime/connectors/connector-accounts-mcp.mjs';
import { oauthUrlOf } from './resource-mcp-servers.mjs';

/** Every config `servers` connects with, a multi-account server's accounts
 *  as the one-account configs they are. */
const expandedConfigs = (servers) =>
  Object.values(servers || {}).flatMap((cfg) => {
    const accounts = connectorAccountServers(cfg);
    return accounts.length ? accounts : [cfg];
  });

export function createMcpServerSecrets({
  gmailAppPassword,
  saveOAuthClientSecret,
  clearMcpServerOAuth,
  resolveConfiguredMcpCatalog,
}) {
  // The user's OAuth client secret (custom connector → 고급 설정 → 비밀값)
  // goes to the keychain only; clearing the client id forgets it.
  const storeOAuthClientSecret = async (input, cfg, previous = {}) => {
    if (!cfg?.url) return;
    const secret = typeof input.oauthClientSecret === 'string' ? input.oauthClientSecret.trim() : '';
    if (cfg.oauthClientId && secret) await saveOAuthClientSecret(cfg.url, secret);
    else if (!cfg.oauthClientId && previous.oauthClientId) await saveOAuthClientSecret(previous.url || cfg.url, '');
  };
  // Gmail with an app password (connector-catalog.mjs GMAIL_APP_PASSWORD): the
  // password is checked with Gmail before anything is saved and goes to the
  // keychain only. A new connection needs one; an edit without one keeps it.
  const storeGmailAppPassword = async (input, cfg, required) => {
    const account = gmailAppPasswordAccount(cfg);
    if (!account) return;
    const password = gmailAppPasswordValue(input.appPassword);
    if (password) await gmailAppPassword.save(account, password);
    else if (required || input.appPassword !== undefined) {
      throw new Error('GMAIL_APP_PASSWORD_FORMAT: An app password has 16 characters.');
    }
  };
  // A server's OAuth tokens and client registration go with it, unless another
  // configured server (plugin or disabled ones included, even with MCP
  // disabled for this runtime) still uses them through the same exact URL.
  // `signIn` tells the caller what happened to the sign-in: `removed` (local
  // secrets deleted, `revoked` when the provider confirmed the revocation
  // too), `shared` (another server still uses it), or none (null).
  const releaseOAuth = async (cfg) => {
    const url = oauthUrlOf(cfg);
    if (!url) return null;
    if (expandedConfigs(resolveConfiguredMcpCatalog().servers).some((other) => oauthUrlOf(other) === url)) {
      return { signIn: 'shared', revoked: false };
    }
    const { revoked = false } = (await clearMcpServerOAuth(cfg, { revoke: true })) || {};
    return { signIn: 'removed', revoked };
  };
  // An app password is deleted once no configured server uses its account.
  const forgetUnusedGmailAppPassword = async (account) => {
    if (!account) return false;
    const servers = expandedConfigs(resolveConfiguredMcpCatalog().servers);
    if (servers.some((cfg) => gmailAppPasswordAccount(cfg) === account)) return false;
    await gmailAppPassword.forget(account);
    return true;
  };
  // A removed account keeps no sign-in another configured server or account
  // does not share: `{ signIn, revoked }` as removeMcpServer reports it.
  const releaseAccount = async (accountCfg) => {
    forgetConnectorAccountHealth(accountCfg.name);
    const address = gmailAppPasswordAccount(accountCfg);
    if (address) {
      const forgotten = await forgetUnusedGmailAppPassword(address);
      return { signIn: forgotten ? 'removed' : 'shared', revoked: false };
    }
    return releaseOAuth(accountCfg);
  };

  return { storeOAuthClientSecret, storeGmailAppPassword, releaseOAuth, forgetUnusedGmailAppPassword, releaseAccount };
}
