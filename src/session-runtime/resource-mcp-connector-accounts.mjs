// The accounts of a multi-account connector server as the MCP server API
// edits them: adding one more account (into its server, or a new server
// holding it) and editing one account's transport, app password or client.
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  mergeMcpServerConfig,
  MCP_TIMEOUT_FIELD_GROUPS,
} from '../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';
import {
  connectorAccountEnabled,
  connectorAccountEntry,
  connectorAccountServer,
  connectorAccountServers,
  connectorAccountsOf,
  connectorAccountsUrl,
  connectorById,
  connectorOfServer,
  gmailAppPasswordAccount,
} from '../runtime/shared/connector-catalog.mjs';
import { forgetConnectorAccountHealth } from '../runtime/connectors/connector-accounts-mcp.mjs';
import { accountTarget, mergedServerInput, nameTakenError, oauthUrlOf } from './resource-mcp-servers.mjs';

/** The server of multi-account connector `connector` in `servers`, or ''. */
function connectorServerName(servers, connector) {
  return (
    Object.keys(servers).find(
      (name) => connectorOfServer(servers[name]) === connector && connectorAccountsOf(servers[name]).length > 0
    ) || ''
  );
}

/** Whether `input` edits the server `target` belongs to rather than the
 *  account: the account carries the server's name and the input the
 *  server's own address (its config editor). */
export const editsServerItself = (target, input) => {
  if (target.serverName !== target.account.name || !clean(input.url)) return false;
  try {
    return oauthUrlOf({ type: input.type || 'http', url: input.url }) === oauthUrlOf(target.cfg);
  } catch {
    return false;
  }
};

export function createConnectorAccountEdits({
  normalizeMcpServerInput,
  pluginMcpServer,
  sync,
  saveServers,
  freeName,
  storeOAuthClientSecret,
  storeGmailAppPassword,
  forgetUnusedGmailAppPassword,
  releaseOAuth,
}) {
  /** One more account of multi-account connector `connector` (one-account
   *  config `accountCfg` as normalized from `input`): into its server, or a
   *  new server named `name` holding it. The same Gmail address again takes
   *  the new app password. Resolves `{ name, account, status }`. */
  async function addConnectorAccount(servers, connector, name, accountCfg, input) {
    const serverName = connectorServerName(servers, connector);
    const address = gmailAppPasswordAccount(accountCfg);
    const cfg = serverName ? servers[serverName] : null;
    const same =
      cfg && address
        ? connectorAccountsOf(cfg).find(
            (account) => gmailAppPasswordAccount(connectorAccountServer(cfg, account)) === address
          )
        : null;
    if (same) {
      await storeGmailAppPassword(input, accountCfg, true);
      const status = await sync.reconnectMcpAndAnnounce({ only: serverName, enabled: cfg.enabled !== false });
      return { name: serverName, account: same.name, status };
    }
    if (!serverName && (Object.hasOwn(servers, name) || pluginMcpServer(name) || accountTarget(servers, name))) {
      throw nameTakenError(servers, name);
    }
    const accountName = serverName ? freeName(servers, name) : name;
    const account = connectorAccountEntry(accountName, accountCfg);
    // Sign-in tokens are stored per exact URL: another account needs its own.
    const backendUrl = connectorById(connector)?.backend?.url;
    if (
      !address &&
      cfg &&
      connectorAccountServers(cfg).some((other) => oauthUrlOf(other) === oauthUrlOf({ type: 'http', url: account.url }))
    ) {
      account.url = `${backendUrl}?account=${encodeURIComponent(accountName)}`;
    }
    const storedCfg = connectorAccountServer({ connector }, account);
    await storeOAuthClientSecret(input, storedCfg);
    await storeGmailAppPassword(input, storedCfg, true);
    forgetConnectorAccountHealth(accountName);
    let target = serverName;
    if (cfg) {
      servers[serverName] = { ...cfg, accounts: [...connectorAccountsOf(cfg), account] };
    } else {
      // The server's own settings (timeouts, enabled) ride on the input.
      const { type: _type, url: _url, headers: _headers, oauthClientId: _client, ...rest } = accountCfg;
      target = name;
      servers[name] = { ...rest, type: 'http', url: connectorAccountsUrl(connector), connector, accounts: [account] };
    }
    saveServers(servers);
    const status = await sync.reconnectMcpAndAnnounce({ only: target, enabled: servers[target].enabled !== false });
    return { name: target, account: accountName, status };
  }

  /** An edit of one account (`target` from accountTarget): its transport,
   *  app password or own client, as an edit of its one-account server was. */
  async function saveConnectorAccount(servers, target, input) {
    const { serverName, cfg, account, accountCfg } = target;
    const { config } = normalizeMcpServerInput(
      mergedServerInput({ ...input, name: account.name }, accountCfg, account.name)
    );
    const next = mergeMcpServerConfig(accountCfg, config);
    next.connector = cfg.connector;
    await storeOAuthClientSecret(input, next, accountCfg);
    await storeGmailAppPassword(input, next, false);
    // Settings that are not the account's transport (timeouts) are the server's.
    const { type: _type, url: _url, headers: _headers, oauthClientId: _client, ...serverFields } = config;
    const server = { ...cfg };
    for (const group of MCP_TIMEOUT_FIELD_GROUPS) {
      if (group.some((field) => Object.hasOwn(serverFields, field))) for (const field of group) delete server[field];
    }
    servers[serverName] = {
      ...server,
      ...serverFields,
      accounts: connectorAccountsOf(cfg).map((entry) =>
        entry.name === account.name
          ? { ...connectorAccountEntry(account.name, next), ...(connectorAccountEnabled(entry) ? {} : { enabled: false }) }
          : entry
      ),
    };
    saveServers(servers);
    forgetConnectorAccountHealth(account.name);
    const previousAddress = gmailAppPasswordAccount(accountCfg);
    const address = gmailAppPasswordAccount(next);
    if (previousAddress !== address) await forgetUnusedGmailAppPassword(previousAddress);
    // An account switched from the Google sign-in to an app password keeps no sign-in.
    if (address && !previousAddress) await releaseOAuth(accountCfg);
    const status = await sync.reconnectMcpAndAnnounce({ only: serverName, enabled: cfg.enabled !== false });
    return { name: serverName, account: account.name, source: 'config', status };
  }

  return { addConnectorAccount, saveConnectorAccount };
}
