// MCP server configuration: add/save/remove/toggle of the user's servers, and
// the per-server intent (enabled flag) of servers registered plugins declare.
// Plugin servers are derived live (mcp-glue/plugin-servers.mjs) and are never
// written into `mcpServers`; ordinary edits refuse them.
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  mergeMcpServerConfig,
  MCP_TIMEOUT_FIELD_GROUPS,
} from '../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';
import { resolveMcpOAuthUrl } from '../runtime/agent/orchestrator/mcp/client-config.mjs';
import { withAdoptedCopies, withPinnedCollisionNames, withPluginServerIntent } from './mcp-glue/plugin-servers.mjs';
import { findRegisteredPlugin } from './resource-plugins-api.mjs';
import { createMcpOAuthLogins } from './mcp-oauth-login.mjs';
import { connectorById, gmailAppPasswordAccount, gmailAppPasswordValue } from '../runtime/shared/connector-catalog.mjs';
import { saveMcpOAuthClientSecret } from '../runtime/agent/orchestrator/mcp/oauth-client.mjs';
import { forgetGmailAppPassword, saveGmailAppPassword } from '../runtime/connectors/gmail-app-password.mjs';

/** The URL a server's OAuth credentials are stored under, or null. */
function oauthUrlOf(cfg) {
  try {
    return resolveMcpOAuthUrl(cfg);
  } catch {
    // No valid remote URL: such a server never logged in.
    return null;
  }
}

/** The `mcpServers` map of a config as a fresh object (never the live one). */
function mcpServersOf(config) {
  return config.mcpServers && typeof config.mcpServers === 'object' ? { ...config.mcpServers } : {};
}

function pluginOwnedError(name, owner) {
  return new Error(
    `MCP server "${name}" is provided by plugin "${owner.id}" (server "${owner.key}"); ` +
      'enable or disable it with set_mcp_enabled, or manage the plugin instead'
  );
}

const transportType = (type) => (type === 'streamable-http' ? 'http' : type);

/** UI editors send complete transports; setup may send a partial patch. Merge
 *  the patch over the existing entry, keeping omitted fields (including
 *  credentials) unless the transport itself changed. */
function mergedServerInput(input, existing, originalName) {
  const transportChanged =
    (input.type && transportType(input.type) !== transportType(existing.type || (existing.url ? 'http' : 'stdio'))) ||
    (input.command && existing.url) ||
    (input.url && !existing.url);
  const maps = {};
  if (!transportChanged) {
    for (const key of ['env', 'headers', 'env_http_headers']) {
      if (Object.hasOwn(input, key)) maps[key] = { ...(existing[key] || {}), ...input[key] };
    }
  }
  // Existing timeouts are kept by mergeMcpServerConfig; the normalizer must only
  // see (and validate) newly supplied ones, so a stored 0/'off' never blocks
  // an unrelated save.
  const { ...base } = transportChanged ? {} : existing;
  for (const field of MCP_TIMEOUT_FIELD_GROUPS.flat()) delete base[field];
  return {
    ...base,
    ...input,
    ...maps,
    name: clean(input.name) || originalName,
  };
}

export function createMcpResourceApi({ deps, sync, decorate }) {
  const {
    getConfig,
    saveConfigAndAdopt,
    normalizeMcpServerInput,
    mcpStatus,
    getMcpServerConfig,
    connectConfiguredMcp,
    clearMcpServerOAuth,
    reloadFullConfig,
    awaitKeychainPrewarm,
    pluginsStatus,
    resolveMcpCatalog = () => ({ servers: {}, adoption: null, plugins: {}, entries: {} }),
    resolveConfiguredMcpCatalog = resolveMcpCatalog,
    pluginMcpServer = () => null,
    flushSkillsSave,
    cancelMcpLogin = () => {},
    completeMcpLogin,
    getMcpServerOAuthState = () => null,
    probeMcpServerAuth,
    startMcpServerOAuthSwitch,
    commitMcpServerOAuthSwitch,
    gmailAppPassword = { save: saveGmailAppPassword, forget: forgetGmailAppPassword },
    saveOAuthClientSecret = saveMcpOAuthClientSecret,
  } = deps;

  const reconnectOne = async (name) => {
    const status = await connectConfiguredMcp({ only: name, enabled: true });
    const row = status?.servers?.find((server) => server.name === name);
    return { connected: row?.connected === true, error: row?.error || null };
  };
  // Explicit OAuth sign-in: the one interactive MCP connect. On success the
  // other runtimes reconnect the server non-interactively with the new tokens.
  const oauthLogins = createMcpOAuthLogins({
    async connect(name, openBrowser) {
      const status = await connectConfiguredMcp({ only: name, enabled: true, login: { openBrowser } });
      const row = status?.servers?.find((server) => server.name === name);
      return { connected: row?.connected === true, error: row?.error || null };
    },
    cancel: (name) => cancelMcpLogin(name),
    completeCallback: completeMcpLogin,
    // 계정 바꾸기, transactionally: the working connection stays until the new
    // sign-in succeeded and connects; a cancel or failure changes nothing, and
    // a new sign-in that cannot connect is rolled back.
    async switchAccount(name, launch, attempt) {
      const cfg = resolveMcpCatalog().servers[name];
      const switching = startMcpServerOAuthSwitch(cfg, launch, name);
      attempt.abort = () => switching.cancel();
      attempt.answer = (callbackUrl) => switching.answer(callbackUrl);
      const signIn = await switching.done;
      const rollback = await commitMcpServerOAuthSwitch(cfg, signIn);
      const outcome = await reconnectOne(name);
      if (outcome.connected) return outcome;
      await rollback();
      await reconnectOne(name);
      return { connected: false, error: outcome.error || 'The new sign-in could not connect' };
    },
    onComplete: (name) => sync.announce('mcp', { detail: { mcpChanges: [{ name, enabled: true }] } }),
  });
  /** The effective config of a server that signs in with MCP OAuth (HTTP/SSE
   *  without configured authentication). */
  const oauthServerConfig = async (name) => {
    const serverName = clean(name);
    if (!serverName) throw new Error('MCP server name is required');
    await awaitKeychainPrewarm();
    reloadFullConfig();
    const cfg = resolveMcpCatalog().servers[serverName];
    if (!cfg) throw new Error(`MCP server not configured: ${serverName}`);
    if (!getMcpServerOAuthState(cfg)) throw new Error(`MCP server "${serverName}" does not use OAuth sign-in`);
    return { serverName, cfg };
  };

  /** The config with any adoptable plugin server copies already adopted, so
   *  every write also persists the adoption and never re-adds a copy. */
  const adoptedConfig = () => withAdoptedCopies(getConfig(), resolveMcpCatalog().adoption);

  /** Persist a new `mcpServers` map; project overrides never survive a global
   *  edit. A plugin server pushed off its name by the edit keeps the collision
   *  name it gets, so it does not flip again later. */
  const saveServers = (servers) => {
    const nextConfig = { ...adoptedConfig() };
    delete nextConfig.mcpProjectOverrides;
    saveConfigAndAdopt({ ...nextConfig, mcpServers: servers });
    const saved = getConfig();
    const pinned = withPinnedCollisionNames(saved, resolveMcpCatalog());
    if (pinned !== saved) saveConfigAndAdopt(pinned);
  };
  const userServers = () => mcpServersOf(adoptedConfig());
  const refusePluginServer = (name) => {
    const owned = name ? pluginMcpServer(name) : null;
    if (owned) throw pluginOwnedError(name, owned.owner);
  };
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
    if (Object.values(resolveConfiguredMcpCatalog().servers).some((other) => oauthUrlOf(other) === url)) {
      return { signIn: 'shared', revoked: false };
    }
    const { revoked = false } = (await clearMcpServerOAuth(cfg, { revoke: true })) || {};
    return { signIn: 'removed', revoked };
  };
  // An app password is deleted once no configured server uses its account.
  const forgetUnusedGmailAppPassword = async (account) => {
    if (!account) return false;
    const servers = Object.values(resolveConfiguredMcpCatalog().servers);
    if (servers.some((cfg) => gmailAppPasswordAccount(cfg) === account)) return false;
    await gmailAppPassword.forget(account);
    return true;
  };
  // Peers reload config from disk on receipt: land the write before publishing.
  const persisted = async () => {
    await flushSkillsSave?.();
  };

  return {
    /** One-time, idempotent: move server copies an earlier plugin enable wrote
     *  into `mcpServers` to per-server plugin intent. Returns adopted names. */
    migratePluginMcpCopies() {
      const { adoption } = resolveMcpCatalog();
      if (!adoption) return [];
      saveConfigAndAdopt(withAdoptedCopies(getConfig(), adoption));
      return adoption.removed;
    },
    mcpStatus() {
      return decorate.mcp(mcpStatus());
    },
    getMcpServerConfig(name) {
      return getMcpServerConfig(name);
    },
    async reconnectMcp(name) {
      await awaitKeychainPrewarm();
      reloadFullConfig();
      const serverName = clean(name);
      if (!serverName) return sync.reconnectMcpAndAnnounce();
      const { enabled } = getMcpServerConfig(serverName);
      return sync.reconnectMcpAndAnnounce({ only: serverName, enabled });
    },
    /** `{ flowId, state: 'pending', url }` once the browser login starts
     *  (`options.openBrowser === false` leaves opening `url` to the caller), or
     *  `{ flowId, state: 'complete' }` when stored credentials sufficed. */
    async beginMcpOAuthLogin(name, options = {}) {
      const { serverName, cfg } = await oauthServerConfig(name);
      if (cfg.enabled === false) throw new Error(`MCP server is disabled: ${serverName}`);
      // `mode`: `connect` (a normal authorization), `reauth` (repair the same
      // connection; a refresh is tried first) or `switch` (계정 바꾸기).
      if (options?.mode === 'switch' && !getMcpServerOAuthState(cfg)?.signedIn) {
        throw new Error(`MCP server "${serverName}" is not signed in`);
      }
      return oauthLogins.begin(serverName, options);
    },
    /** `{ flowId, state: 'pending' | 'complete' | 'failed' | 'cancelled',
     *  step?, error?, reason? }`; with `{ since, waitMs }` it resolves on the
     *  flow's next change (mcp-oauth-login.mjs). */
    getMcpOAuthLoginStatus(flowId, options) {
      return oauthLogins.status(flowId, options);
    },
    cancelMcpOAuthLogin(flowId) {
      return oauthLogins.cancel(flowId);
    },
    /** Remote / headless sign-in: complete the pending flow with the redirect
     *  URL pasted from the browser. `{ flowId, state: 'complete' | 'failed',
     *  error? }`; an invalid paste throws a fixed message and stays pending. */
    completeMcpOAuthLogin(flowId, callbackUrl) {
      return oauthLogins.complete(flowId, callbackUrl);
    },
    /** Forget the server's stored OAuth credentials (shared by every server
     *  with the same exact URL) and reconnect without a login, here and on
     *  peers, so it reports sign-in required. */
    async signOutMcpServer(name) {
      const { serverName, cfg } = await oauthServerConfig(name);
      // A begin issued meanwhile waits until the credentials are gone.
      return oauthLogins.cancelServer(serverName, async () => {
        const { revoked = false } = (await clearMcpServerOAuth(cfg, { revoke: true })) || {};
        const status = await sync.reconnectMcpAndAnnounce({ only: serverName, enabled: cfg.enabled !== false });
        return { ...status, revoked };
      });
    },
    /** `{ auth: 'oauth' | 'none' | 'configured' | 'unreachable', error? }` for an
     *  HTTP/SSE config, without credentials or a browser. */
    probeMcpServerAuth(cfg) {
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new TypeError('MCP server config is required');
      const probe = {};
      for (const key of ['type', 'url', 'headers', 'bearer_token_env_var', 'env_http_headers']) {
        if (cfg[key] !== undefined) probe[key] = cfg[key];
      }
      if (probe.type !== 'http' && probe.type !== 'sse') throw new TypeError("type must be 'http' or 'sse'");
      return probeMcpServerAuth(probe);
    },
    async addMcpServer(input = {}) {
      const { name, config: serverConfig } = normalizeMcpServerInput(input);
      // A catalog connector's server keeps its catalog id (connector-catalog.mjs).
      const connector = clean(input.connector);
      if (connector) {
        if (!connectorById(connector)) throw new Error(`Unknown connector: ${connector}`);
        serverConfig.connector = connector;
      }
      const servers = userServers();
      if (Object.hasOwn(servers, name)) throw new Error(`MCP server already exists: ${name}`);
      const owned = pluginMcpServer(name);
      if (owned) throw new Error(`MCP server already exists: ${name} (provided by plugin "${owned.owner.id}")`);
      await storeOAuthClientSecret(input, serverConfig);
      await storeGmailAppPassword(input, serverConfig, true);
      saveServers({ ...servers, [name]: serverConfig });
      const status = await sync.reconnectMcpAndAnnounce({ only: name, enabled: serverConfig.enabled !== false });
      return { name, status };
    },
    async saveMcpServer(input = {}) {
      const servers = userServers();
      // An explicit originalName must exist; a bare name edits a matching
      // server and otherwise creates a new one. Plugin servers are never
      // edited, renamed or shadowed here.
      const explicitOriginal = clean(input.originalName);
      if (explicitOriginal && !Object.hasOwn(servers, explicitOriginal)) {
        refusePluginServer(explicitOriginal);
        throw new Error(`MCP server not configured: ${explicitOriginal}`);
      }
      const bareName = clean(input.name);
      if (!explicitOriginal && !Object.hasOwn(servers, bareName)) refusePluginServer(bareName);
      const originalName = explicitOriginal || (Object.hasOwn(servers, bareName) ? bareName : '');
      const existing = originalName ? servers[originalName] : {};
      const normalizedInput = normalizeMcpServerInput(mergedServerInput(input, existing, originalName));
      const name = originalName && clean(input.name) === originalName ? originalName : normalizedInput.name;
      if (name !== originalName && (Object.hasOwn(servers, name) || pluginMcpServer(name))) {
        throw new Error(`MCP server already exists: ${name}`);
      }
      if (originalName && originalName !== name) delete servers[originalName];
      servers[name] = mergeMcpServerConfig(existing, normalizedInput.config);
      await storeOAuthClientSecret(input, servers[name], existing);
      await storeGmailAppPassword(input, servers[name], false);
      saveServers(servers);
      const previousAccount = gmailAppPasswordAccount(existing);
      const account = gmailAppPasswordAccount(servers[name]);
      if (previousAccount !== account) await forgetUnusedGmailAppPassword(previousAccount);
      // Gmail switched from the Google sign-in to an app password keeps no sign-in.
      if (account && !previousAccount) await releaseOAuth(existing);
      const status = await sync.reconnectMcpAndAnnounce({
        only: name,
        enabled: servers[name].enabled !== false,
        drop: originalName && originalName !== name ? [originalName] : [],
      });
      return { name, source: 'config', status };
    },
    async removeMcpServer(name) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const servers = userServers();
      if (!Object.hasOwn(servers, serverName)) {
        refusePluginServer(serverName);
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      const removed = servers[serverName];
      delete servers[serverName];
      saveServers(servers);
      const status = await sync.reconnectMcpAndAnnounce({ drop: [serverName] });
      // A removed server keeps no sign-in another server does not share: an
      // app password leaves the keychain (it is revoked at Google only).
      const account = gmailAppPasswordAccount(removed);
      if (account) {
        const forgotten = await forgetUnusedGmailAppPassword(account);
        return { ...status, signIn: forgotten ? 'removed' : 'shared', revoked: false };
      }
      const released = await releaseOAuth(removed);
      return released ? { ...status, ...released } : status;
    },
    async setMcpServerEnabled(name, enabled) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const want = enabled !== false;
      const owned = pluginMcpServer(serverName);
      if (owned) {
        // Server intent only: the effective state still requires the plugin.
        // Only a choice that differs from the declared default is stored.
        const { owner, pluginEnabled, declaredEnabled } = owned;
        saveConfigAndAdopt(
          withPluginServerIntent(adoptedConfig(), owner.id, owner.key, (intent) => ({
            ...intent,
            enabled: want === (declaredEnabled !== false) ? undefined : want,
          }))
        );
        await persisted();
        const effective = want && pluginEnabled;
        const status = await sync.scheduleMcpToggle(serverName, effective);
        await sync.publish('mcp', { mcpChanges: [{ name: serverName, enabled: effective }] });
        return status;
      }
      const shadowRow = mcpStatus().servers.find((s) => s.name === serverName);
      if (!shadowRow) throw new Error(`MCP server not configured: ${serverName}`);
      const servers = userServers();
      const current = servers[serverName];
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      servers[serverName] = { ...current, enabled: want };
      saveServers(servers);
      const status = await sync.scheduleMcpToggle(serverName, want);
      await sync.publish('mcp', { mcpChanges: [{ name: serverName, enabled: want }] });
      return status;
    },
    /** Kept for older callers: plugin servers appear on their own once the
     *  plugin is registered and enabled. This clears any per-server "off"
     *  intent of the plugin's servers and reconnects them (here and on peers);
     *  a disabled plugin stays disabled. */
    async enablePluginMcp(plugin = {}) {
      const registered = findRegisteredPlugin(pluginsStatus, plugin) || plugin;
      const id = clean(registered.id || registered.name);
      const catalog = resolveMcpCatalog();
      const row = catalog.plugins[id];
      if (!row) throw new Error(`plugin not registered: ${clean(plugin.id || plugin.name || plugin) || id}`);
      if (!row.servers.length) {
        const detail = row.errors.map((error) => error.message).join('; ');
        throw new Error(`plugin declares no MCP servers${detail ? `: ${detail}` : ''}`);
      }
      let next = withAdoptedCopies(getConfig(), catalog.adoption);
      for (const name of row.servers) {
        const { owner, declaredEnabled } = catalog.entries[name];
        next = withPluginServerIntent(next, id, owner.key, (intent) => ({
          ...intent,
          enabled: declaredEnabled === false ? true : undefined,
        }));
      }
      saveConfigAndAdopt(next);
      await persisted();
      const mcpChanges = row.servers.map((name) => ({ name, enabled: row.enabled }));
      let status;
      for (const change of mcpChanges)
        status = await connectConfiguredMcp({ only: change.name, enabled: change.enabled });
      await sync.announce('mcp', { detail: { mcpChanges } });
      return { serverName: row.servers[0], serverNames: row.servers, status };
    },
  };
}
