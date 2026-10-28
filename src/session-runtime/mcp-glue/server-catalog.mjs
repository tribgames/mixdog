// Effective MCP server set and its status projection: the user's configured
// servers plus the servers registered plugins declare (resolved live, with
// explicit owner metadata), per-server config reads, and the live/failed rollup.
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  connectorAccountEnabled,
  connectorAccountServer,
  connectorAccountsOf,
  connectorOfServer,
  gmailAppPasswordAccount,
} from '../../runtime/shared/connector-catalog.mjs';
import { connectorAccountHealth, connectorAccountInUse } from '../../runtime/connectors/connector-accounts-mcp.mjs';
import { googleOAuthClient } from '../../runtime/shared/google-oauth-client.mjs';
import { envFlag } from '../../runtime/shared/env.mjs';
import { resolveMcpServerCatalog } from './plugin-servers.mjs';

function mcpServerStatus(cfg, live, fail, loginPending) {
  if (cfg?.enabled === false) return 'disabled';
  if (live) return 'connected';
  // Until an interactive sign-in completes the server still needs it.
  if (loginPending || fail?.authRequired) return 'sign-in required';
  return fail ? 'failed' : 'disconnected';
}

const EMPTY_CATALOG = { servers: {}, sources: {}, entries: {}, plugins: {}, warnings: [], adoption: null };

// Internal markers on a resolved plugin config; never part of an editable config.
function withoutMarkers(cfg) {
  const { _mixdogStrictEnv, _mixdogRootsFollowScope, _mixdogPlugin, ...rest } = cfg || {};
  return rest;
}

export function createMcpServerCatalog({
  mcpClient,
  getConfig,
  getCurrentCwd = () => '',
  getMcpScopeId,
  getPluginDataDir = () => '',
  listPlugins = () => [],
  state,
}) {
  function mcpTransportLabel(cfg = {}) {
    if (cfg.autoDetect) return `autoDetect:${cfg.autoDetect}`;
    try {
      return mcpClient.resolveMcpTransportKind(cfg);
    } catch {
      return 'unknown';
    }
  }

  /** Everything this runtime would connect, resolved now. MCP is
   *  machine-global: project `.mcp.json` files and per-project overrides stay
   *  outside the chain; only plugin servers without a declared cwd follow this
   *  runtime's session cwd. */
  function resolveCatalog() {
    if (envFlag('MIXDOG_DISABLE_MCP')) return EMPTY_CATALOG;
    return resolveConfiguredCatalog();
  }

  /** Every configured server (user config plus plugin declarations, disabled
   *  ones included) whether or not this runtime connects MCP at all. */
  function resolveConfiguredCatalog() {
    let plugins = [];
    let registryWarning = null;
    try {
      plugins = listPlugins() || [];
    } catch (error) {
      registryWarning = { message: `plugin MCP servers unavailable: ${error?.message || String(error)}` };
    }
    const catalog = resolveMcpServerCatalog({
      config: getConfig() || {},
      plugins,
      cwd: clean(getCurrentCwd?.()),
      dataDir: clean(getPluginDataDir?.()),
    });
    if (registryWarning) catalog.warnings.unshift(registryWarning);
    return catalog;
  }

  function resolveEffectiveMcpServers() {
    const { servers, sources } = resolveCatalog();
    return { servers, sources };
  }

  /** Plugin owner of an effective server name, or null for a configured one. */
  function pluginServer(name) {
    const catalog = resolveCatalog();
    const entry = catalog.entries[clean(name)];
    return entry?.owner ? { ...entry, plugin: catalog.plugins[entry.owner.id] } : null;
  }

  function getMcpServerConfig(name) {
    const serverName = clean(name);
    if (!serverName) throw new Error('MCP server name is required');
    const { servers, sources, entries } = resolveCatalog();
    const effective = servers[serverName];
    if (!effective) throw new Error(`MCP server not configured: ${serverName}`);
    // An unadopted plugin copy has an owner but stays the user's editable config.
    const owner = sources[serverName] === 'plugin' ? entries[serverName]?.owner || null : null;
    if (owner) {
      return {
        name: serverName,
        source: 'plugin',
        enabled: effective.enabled !== false,
        owner,
        readOnly: true,
        config: withoutMarkers({ ...effective, enabled: undefined }),
      };
    }
    const raw = getConfig()?.mcpServers?.[serverName];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`MCP server config is unavailable: ${serverName}`);
    }
    return {
      name: serverName,
      source: sources[serverName],
      enabled: effective.enabled !== false,
      config: { ...raw },
    };
  }

  /** One account of a connector server, as its row lists it:
   *  `{ name, email, enabled?, inUse?, appPassword?, oauth?, ownClient?, error?, authRequired? }`
   *  (`enabled: false` only for an account that is switched off; `inUse:
   *  true` only for the connector's last-used account, the one a call
   *  without a conversation history uses). */
  function accountRow(accountCfg, enabled, inUse) {
    const address = gmailAppPasswordAccount(accountCfg);
    const oauth = address ? null : mcpClient.getMcpServerOAuthState?.(accountCfg);
    const state = connectorAccountHealth(accountCfg.name);
    const authRequired = Boolean(oauth && oauth.signedIn !== true) || state?.authRequired === true;
    return {
      name: accountCfg.name,
      ...(enabled ? {} : { enabled: false }),
      ...(inUse ? { inUse: true } : {}),
      email: address || oauth?.account || state?.email || '',
      ...(address ? { appPassword: { account: address } } : {}),
      ...(oauth ? { oauth } : {}),
      ...(typeof accountCfg.oauthClientId === 'string' && accountCfg.oauthClientId.trim() ? { ownClient: true } : {}),
      ...(authRequired ? { authRequired: true } : state?.error ? { error: state.error } : {}),
    };
  }

  function statusRows(catalog) {
    const { servers: configured, sources, entries } = catalog;
    const connected = new Map((mcpClient.getMcpServerStatus?.(getMcpScopeId()) || []).map((row) => [row.name, row]));
    const failures = new Map((state.mcpFailures || []).map((row) => [row.name, row]));
    const servers = [];
    for (const [name, cfg] of Object.entries(configured)) {
      const live = connected.get(name);
      // A registered server whose client reports it not alive (runtime
      // failure after connect) is surfaced as failed, not connected.
      const dead = live && (live.alive === false || live.connected === false);
      const fail =
        failures.get(name) || (dead ? { msg: live.error || live.lastError || 'MCP server is not alive' } : undefined);
      const entry = entries[name] || {};
      const loginPending = !(live && !dead) && mcpClient.isMcpLoginPending?.(name, getMcpScopeId()) === true;
      const stored = entry.owner ? [] : connectorAccountsOf(cfg);
      // The connector's last-used account (none when that one was removed),
      // else its topmost switched-on one.
      const recorded = stored.length ? connectorAccountInUse(connectorOfServer(cfg)) : '';
      const inUse = recorded || stored.find(connectorAccountEnabled)?.name;
      const accounts = stored.map((account) =>
        accountRow(connectorAccountServer(cfg, account), connectorAccountEnabled(account), account.name === inUse)
      );
      // A connector server none of whose accounts is signed in needs a sign-in, not a repair.
      const accountsSignIn = accounts.length > 0 && accounts.every((account) => account.authRequired === true);
      const status = mcpServerStatus(
        cfg,
        live && !dead,
        fail && accountsSignIn ? { ...fail, authRequired: true } : fail,
        loginPending
      );
      // Needing an OAuth sign-in is a state, not an error.
      const authRequired = status === 'sign-in required';
      const row = {
        name,
        configured: true,
        enabled: cfg?.enabled !== false,
        connected: Boolean(live) && !dead,
        status,
        transport: mcpTransportLabel(cfg),
        toolCount: live?.toolCount || 0,
        tools: live?.tools || [],
        capabilities: live?.capabilities || { tools: false, prompts: false, resources: false },
        error: authRequired ? null : fail?.msg || null,
        warnings: [...(entry.warnings || []), ...(live?.warnings || [])],
        source: sources[name] || 'config',
      };
      if (authRequired) row.authRequired = true;
      // The catalog service this server connects (connector-catalog.mjs):
      // its marker.
      const connector = entry.owner ? '' : connectorOfServer(cfg);
      if (connector) row.connector = connector;
      const oauth = mcpClient.getMcpServerOAuthState?.(cfg);
      // Why the last sign-in did not complete (already credential-scrubbed).
      if (oauth) row.oauth = authRequired && fail?.msg ? { ...oauth, lastError: fail.msg } : oauth;
      // Gmail connected with an app password: the account it runs as.
      const appPasswordAccount = gmailAppPasswordAccount(cfg);
      if (appPasswordAccount) row.appPassword = { account: appPasswordAccount };
      // A catalog connector running on the user's own Google client.
      if (connector && typeof cfg?.oauthClientId === 'string' && cfg.oauthClientId.trim()) row.ownClient = true;
      if (accounts.length) {
        // A multi-account connector: its accounts, each with its own state.
        row.accounts = accounts;
        if (accounts.some((account) => account.ownClient)) row.ownClient = true;
        // One account reads like the one-account server it replaces.
        if (accounts.length === 1 && accounts[0].oauth) row.oauth = accounts[0].oauth;
        if (accounts.length === 1 && accounts[0].appPassword) row.appPassword = accounts[0].appPassword;
      }
      if (entry.owner) {
        row.owner = entry.owner;
        row.pluginEnabled = entry.pluginEnabled;
        row.serverEnabled = entry.serverEnabled;
        if (!entry.pluginEnabled) row.disabledReason = 'plugin disabled';
        else if (!entry.serverEnabled) row.disabledReason = 'server disabled';
      }
      servers.push(row);
      connected.delete(name);
    }
    for (const live of connected.values()) {
      servers.push({ ...live, configured: false, status: 'connected' });
    }
    servers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return servers;
  }

  function mcpStatus() {
    if (envFlag('MIXDOG_DISABLE_MCP')) {
      return {
        servers: [],
        configuredCount: 0,
        connectedCount: 0,
        failedCount: 0,
        googleClient: Boolean(googleOAuthClient()),
      };
    }
    const catalog = resolveCatalog();
    const servers = statusRows(catalog);
    const declarationErrors = Object.values(catalog.plugins).flatMap((plugin) =>
      plugin.errors.map((error) => ({ plugin: plugin.id, ...error }))
    );
    return {
      servers,
      configuredCount: Object.keys(catalog.servers).length,
      connectedCount: servers.filter((row) => row.connected).length,
      failedCount: servers.filter((row) => row.status === 'failed').length,
      warnings: catalog.warnings,
      declarationErrors,
      // Whether this build carries Mixdog's own Google client (else the
      // Google sign-ins need the user's own client).
      googleClient: Boolean(googleOAuthClient()),
    };
  }

  /** Per plugin id: declaration format/errors and its server status rows. */
  function pluginMcpSummary() {
    const catalog = resolveCatalog();
    const rows = new Map(statusRows(catalog).map((row) => [row.name, row]));
    return new Map(
      Object.values(catalog.plugins).map((plugin) => [
        plugin.id,
        { format: plugin.format, errors: plugin.errors, servers: plugin.servers.map((name) => rows.get(name)) },
      ])
    );
  }

  return {
    mcpTransportLabel,
    resolveCatalog,
    resolveConfiguredCatalog,
    resolveEffectiveMcpServers,
    pluginServer,
    getMcpServerConfig,
    mcpStatus,
    pluginMcpSummary,
  };
}
