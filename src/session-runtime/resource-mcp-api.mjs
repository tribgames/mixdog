// MCP server configuration: add/save/remove/toggle of the user's servers, and
// the per-server intent (enabled flag) of servers registered plugins declare.
// Plugin servers are derived live (mcp-glue/plugin-servers.mjs) and are never
// written into `mcpServers`; ordinary edits refuse them.
// The units it is assembled from: resource-mcp-store.mjs (the `mcpServers`
// registry), resource-mcp-secrets.mjs (keychain side), resource-mcp-connector-
// accounts.mjs (multi-account connector accounts), resource-mcp-oauth-api.mjs
// (sign-in / sign-out) and resource-mcp-servers.mjs (pure map reads).
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { mergeMcpServerConfig } from '../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';
import { withAdoptedCopies, withPluginServerIntent } from './mcp-glue/plugin-servers.mjs';
import { findRegisteredPlugin } from './resource-plugins-api.mjs';
import { migrateMergedConnectorServers } from './connector-merge-migration.mjs';
import {
  connectorAccountServers,
  connectorAccountsOf,
  connectorAppPasswordOnly,
  connectorById,
  connectorServerInput,
  gmailAppPasswordAccount,
  gmailAppPasswordServerInput,
  mergeConnectorAccountServers,
} from '../runtime/shared/connector-catalog.mjs';
import { saveMcpOAuthClientSecret } from '../runtime/agent/orchestrator/mcp/oauth-client.mjs';
import { forgetGmailAppPassword, saveGmailAppPassword } from '../runtime/connectors/gmail-app-password.mjs';
import { extensionScopesFromConfig, withExtensionScope } from '../runtime/shared/extension-scopes.mjs';
import { accountTarget, mcpServersOf, mergedServerInput, nameTakenError } from './resource-mcp-servers.mjs';
import { createMcpServerStore } from './resource-mcp-store.mjs';
import { createMcpServerSecrets } from './resource-mcp-secrets.mjs';
import { createConnectorAccountEdits, editsServerItself } from './resource-mcp-connector-accounts.mjs';
import { createMcpOAuthApi } from './resource-mcp-oauth-api.mjs';

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

  const oauthApi = createMcpOAuthApi({
    sync,
    mcpStatus,
    connectConfiguredMcp,
    clearMcpServerOAuth,
    reloadFullConfig,
    awaitKeychainPrewarm,
    resolveMcpCatalog,
    cancelMcpLogin,
    completeMcpLogin,
    getMcpServerOAuthState,
    probeMcpServerAuth,
    startMcpServerOAuthSwitch,
    commitMcpServerOAuthSwitch,
  });
  const { adoptedConfig, saveServers, userServers, freeName, refusePluginServer } = createMcpServerStore({
    getConfig,
    saveConfigAndAdopt,
    resolveMcpCatalog,
    pluginMcpServer,
  });
  const {
    storeOAuthClientSecret,
    storeGmailAppPassword,
    releaseOAuth,
    forgetUnusedGmailAppPassword,
    forgetStoredSecrets,
    releaseAccount,
  } = createMcpServerSecrets({
    gmailAppPassword,
    saveOAuthClientSecret,
    clearMcpServerOAuth,
    resolveConfiguredMcpCatalog,
  });
  const {
    addConnectorAccount: joinConnectorAccount,
    saveConnectorAccount,
    setConnectorAccountEnabled,
  } = createConnectorAccountEdits({
    normalizeMcpServerInput,
    pluginMcpServer,
    sync,
    saveServers,
    freeName,
    storeOAuthClientSecret,
    storeGmailAppPassword,
    forgetUnusedGmailAppPassword,
    forgetStoredSecrets,
    releaseOAuth,
  });
  // Peers reload config from disk on receipt: land the write before publishing.
  const persisted = async () => {
    await flushSkillsSave?.();
  };
  // One account addition of a connector at a time, each reading the servers
  // the one before it saved: two at once never take the same name, nor does
  // one's save drop the other's account.
  const connectorAdds = new Map();
  const oneAddAtATime = (connector, run) => {
    const next = (connectorAdds.get(connector) || Promise.resolve()).then(run, run);
    const settled = next.then(
      () => {},
      () => {}
    );
    connectorAdds.set(connector, settled);
    void settled.then(() => {
      if (connectorAdds.get(connector) === settled) connectorAdds.delete(connector);
    });
    return next;
  };

  async function addMcpServer(input = {}) {
    // A catalog connector's account (as its own server config) joins that
    // connector's one server.
    const connector = clean(input.connector);
    if (connector && !Array.isArray(input.accounts)) return oneAddAtATime(connector, () => addServerNow(input));
    return addServerNow(input);
  }

  async function addServerNow(input) {
    const { name, config: serverConfig } = normalizeMcpServerInput(input);
    // A catalog connector's server keeps its catalog id (connector-catalog.mjs).
    const connector = clean(input.connector);
    if (connector) {
      if (!connectorById(connector)) throw new Error(`Unknown connector: ${connector}`);
      serverConfig.connector = connector;
    }
    const servers = userServers();
    if (connector && !Array.isArray(input.accounts)) {
      return joinConnectorAccount(servers, connector, name, serverConfig, input);
    }
    if (Object.hasOwn(servers, name) || accountTarget(servers, name)) {
      throw nameTakenError(servers, name);
    }
    const owned = pluginMcpServer(name);
    if (owned) throw new Error(`MCP server already exists: ${name} (provided by plugin "${owned.owner.id}")`);
    await storeOAuthClientSecret(input, serverConfig);
    await storeGmailAppPassword(input, serverConfig, true);
    saveServers({ ...servers, [name]: serverConfig });
    const status = await sync.reconnectMcpAndAnnounce({ only: name, enabled: serverConfig.enabled !== false });
    return { name, status };
  }

  return {
    /** One-time, idempotent: merge the one-account servers of a catalog
     *  connector (`notion`, `notion-2`…) into one server holding the accounts
     *  (connector-catalog.mjs mergeConnectorAccountServers). Every account
     *  keeps its address, so its stored sign-in and app password stay as
     *  they are. Settings keyed by a merged-away server name go with it:
     *  scopes (`extensionScopes.mcp`) are dropped, and the accounts of a
     *  server that was off stay off (`enabled: false` on the account);
     *  per-agent / per-project connector settings and data-dir hooks move to
     *  the surviving server first (connector-merge-migration.mjs); a store
     *  that fails stays in a pending record that every start retries.
     *  Returns what was merged. */
    migrateConnectorAccounts() {
      const config = getConfig();
      const { servers, merged } = mergeConnectorAccountServers(mcpServersOf(config));
      // Also retries, without a merge, what an earlier start could not migrate.
      const settings = migrateMergedConnectorServers(
        deps.cfgMod?.getPluginData?.() || deps.STANDALONE_DATA_DIR,
        merged
      );
      if (!merged.length) return merged;
      // Neither migrated nor recorded for a retry: merging again next start is the retry.
      if (settings.unrecorded && settings.failed.length) return [];
      let next = { ...config, mcpServers: servers };
      const scoped = extensionScopesFromConfig(config).mcp;
      for (const { name, from } of merged) {
        for (const gone of from)
          if (gone !== name && Object.hasOwn(scoped, gone)) next = withExtensionScope(next, 'mcp', gone, null);
      }
      saveConfigAndAdopt(next);
      return merged;
    },
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
      // An account reconnects with its server.
      const serverName = accountTarget(resolveMcpCatalog().servers, clean(name))?.serverName || clean(name);
      if (!serverName) return sync.reconnectMcpAndAnnounce();
      const { enabled } = getMcpServerConfig(serverName);
      return sync.reconnectMcpAndAnnounce({ only: serverName, enabled });
    },
    // Sign-in / sign-out (resource-mcp-oauth-api.mjs), in this key position.
    ...oauthApi,
    addMcpServer,
    /** One more account of catalog connector `input.connector`, connected as
     *  its catalog entry says: `key` for an API-key service (Hugging Face,
     *  Stripe; Postgres takes its connection string), `email` and
     *  `appPassword` for Gmail, nothing more for a sign-in service (the
     *  account then signs in with beginMcpOAuthLogin(account)); the user's own
     *  OAuth client rides on `oauthClientId` / `oauthClientSecret`. The account
     *  gets a free name (`notion`, `notion-2`…) and joins the connector's one
     *  server, which is made when there is none. Resolves `{ name, account,
     *  status }`: the server's name and the new account's (for a Gmail
     *  address already connected, that account, which took the new password). */
    async addConnectorAccount(input = {}) {
      const entry = connectorById(clean(input.connector));
      if (!entry) throw new Error(`Unknown connector: ${clean(input.connector)}`);
      // Its name is picked from the servers the additions before it saved.
      return oneAddAtATime(entry.id, () => {
        const name = freeName(userServers(), entry.id);
        const account = connectorAppPasswordOnly(entry)
          ? gmailAppPasswordServerInput(name, input.email, input.appPassword)
          : connectorServerInput(entry, name, input.key);
        const ownClient = clean(input.oauthClientId);
        return addServerNow({
          ...account,
          ...(ownClient ? { oauthClientId: ownClient, oauthClientSecret: input.oauthClientSecret } : {}),
        });
      });
    },
    async saveMcpServer(input = {}) {
      const servers = userServers();
      // A name of a multi-account connector's account edits that account.
      const accountOf = accountTarget(servers, clean(input.originalName) || clean(input.name));
      if (accountOf && !editsServerItself(accountOf, input)) return saveConnectorAccount(servers, accountOf, input);
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
      if (
        name !== originalName &&
        (Object.hasOwn(servers, name) || pluginMcpServer(name) || accountTarget(servers, name))
      ) {
        throw nameTakenError(servers, name);
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
      // A name of a multi-account connector's account removes that account;
      // the server goes with its last one.
      const target = accountTarget(servers, serverName);
      if (target) {
        const rest = connectorAccountsOf(target.cfg).filter((entry) => entry.name !== serverName);
        if (rest.length) servers[target.serverName] = { ...target.cfg, accounts: rest };
        else delete servers[target.serverName];
        saveServers(servers);
        const status = rest.length
          ? await sync.reconnectMcpAndAnnounce({ only: target.serverName, enabled: target.cfg.enabled !== false })
          : await sync.reconnectMcpAndAnnounce({ drop: [target.serverName] });
        const released = await releaseAccount(target.accountCfg);
        return released ? { ...status, ...released } : status;
      }
      if (!Object.hasOwn(servers, serverName)) {
        refusePluginServer(serverName);
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      const removed = servers[serverName];
      delete servers[serverName];
      saveServers(servers);
      const status = await sync.reconnectMcpAndAnnounce({ drop: [serverName] });
      // The server of a multi-account connector takes every account's sign-in with it.
      const accountCfgs = connectorAccountServers(removed);
      if (accountCfgs.length) {
        const released = (await Promise.all(accountCfgs.map(releaseAccount))).filter(Boolean);
        if (!released.length) return status;
        return {
          ...status,
          signIn: released.every((one) => one.signIn === 'removed') ? 'removed' : 'shared',
          revoked: released.every((one) => one.revoked === true),
        };
      }
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
      // A name a multi-account connector holds as an account switches that
      // account (and, on, its server) rather than the whole server; the
      // account sharing the server's name is switched off with the server.
      const requested = clean(name);
      const servers = userServers();
      const held = accountTarget(servers, requested);
      const serverName = held?.serverName || requested;
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
      const current = servers[serverName];
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      if (held && (want || serverName !== requested)) return setConnectorAccountEnabled(servers, held, want);
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
