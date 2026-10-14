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
  } = deps;

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
    async addMcpServer(input = {}) {
      const { name, config: serverConfig } = normalizeMcpServerInput(input);
      const servers = userServers();
      if (Object.hasOwn(servers, name)) throw new Error(`MCP server already exists: ${name}`);
      const owned = pluginMcpServer(name);
      if (owned) throw new Error(`MCP server already exists: ${name} (provided by plugin "${owned.owner.id}")`);
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
      saveServers(servers);
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
      // A removed server keeps no OAuth tokens or client registration, unless
      // another configured server (plugin or disabled ones included, even
      // with MCP disabled for this runtime) still uses them through the same
      // exact URL.
      const url = oauthUrlOf(removed);
      if (url && !Object.values(resolveConfiguredMcpCatalog().servers).some((cfg) => oauthUrlOf(cfg) === url)) {
        await clearMcpServerOAuth(removed);
      }
      return status;
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
