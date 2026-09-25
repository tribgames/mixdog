// MCP server configuration: add/save/remove/toggle plus the plugin-declared
// servers a plugin's manifest or script contributes.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { clean } from './session-text.mjs';
import {
  normalizePluginMcpServerConfig,
  pluginMcpServerName,
  pluginRawMcpServers,
  pluginMcpEnableScript,
  pluginServerMatcher,
  resolveContainedPluginPath,
  mergeMcpServerConfig,
} from './plugin-mcp.mjs';

/** The `mcpServers` map of a config as a fresh object (never the live one). */
export function mcpServersOf(config) {
  return config.mcpServers && typeof config.mcpServers === 'object' ? { ...config.mcpServers } : {};
}

function pluginMcpEnv(pluginDataDir, plugin, serverName) {
  return {
    MIXDOG_PLUGIN_ROOT: clean(plugin.root),
    MIXDOG_PLUGIN_DATA: join(pluginDataDir, 'plugins', 'data', clean(plugin.id || plugin.name || serverName)),
  };
}

// Manifest-declared servers replace every entry the plugin owned before; a
// single server keeps the bare name.
function manifestPluginMcpServers(existing, { rawServers, mcpRoot }, { plugin, serverName, env }) {
  const keys = Object.keys(rawServers).filter((k) => {
    const v = rawServers[k];
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  });
  const owned = pluginServerMatcher(serverName);
  const nextServers = {};
  for (const [k, v] of Object.entries(existing || {})) {
    if (owned(k)) continue;
    nextServers[k] = v;
  }
  for (const serverKey of keys) {
    const cfg = normalizePluginMcpServerConfig(rawServers[serverKey], mcpRoot);
    cfg.env = { ...(cfg.env || {}), ...env };
    if (plugin.enabled === false) cfg._mixdogPluginDisabled = true;
    nextServers[keys.length === 1 ? serverName : `${serverName}--${serverKey}`] = cfg;
  }
  return nextServers;
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
  return {
    ...(transportChanged ? {} : existing),
    ...input,
    ...maps,
    name: clean(input.name) || originalName,
  };
}

export function createMcpResourceApi({ deps, sync, decorate }) {
  const {
    getConfig,
    cfgMod,
    STANDALONE_DATA_DIR,
    saveConfigAndAdopt,
    normalizeMcpServerInput,
    mcpStatus,
    getMcpServerConfig,
    reloadFullConfig,
    awaitKeychainPrewarm,
  } = deps;

  /** Persist a new `mcpServers` map; project overrides never survive a global edit. */
  const saveServers = (servers) => {
    const nextConfig = { ...getConfig() };
    delete nextConfig.mcpProjectOverrides;
    saveConfigAndAdopt({ ...nextConfig, mcpServers: servers });
  };

  return {
    mcpStatus() {
      return decorate.mcp(mcpStatus());
    },
    getMcpServerConfig(name) {
      return getMcpServerConfig(name);
    },
    async reconnectMcp() {
      await awaitKeychainPrewarm();
      reloadFullConfig();
      return sync.reconnectMcpAndAnnounce();
    },
    async addMcpServer(input = {}) {
      const { name, config: serverConfig } = normalizeMcpServerInput(input);
      const servers = mcpServersOf(getConfig());
      if (Object.hasOwn(servers, name)) throw new Error(`MCP server already exists: ${name}`);
      saveServers({ ...servers, [name]: serverConfig });
      const status = await sync.reconnectMcpAndAnnounce();
      return { name, status };
    },
    async saveMcpServer(input = {}) {
      const servers = mcpServersOf(getConfig());
      const originalName = clean(input.originalName) || clean(input.name);
      if (originalName && !Object.hasOwn(servers, originalName)) {
        throw new Error(`MCP server not configured: ${originalName}`);
      }
      const existing = originalName ? servers[originalName] : {};
      const normalizedInput = normalizeMcpServerInput(mergedServerInput(input, existing, originalName));
      const name = originalName && clean(input.name) === originalName ? originalName : normalizedInput.name;
      if (name !== originalName && Object.hasOwn(servers, name)) {
        throw new Error(`MCP server already exists: ${name}`);
      }
      if (originalName && originalName !== name) delete servers[originalName];
      servers[name] = mergeMcpServerConfig(existing, normalizedInput.config);
      saveServers(servers);
      const status = await sync.reconnectMcpAndAnnounce();
      return { name, source: 'config', status };
    },
    async removeMcpServer(name) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const servers = mcpServersOf(getConfig());
      if (!Object.hasOwn(servers, serverName)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      delete servers[serverName];
      saveServers(servers);
      return sync.reconnectMcpAndAnnounce();
    },
    async setMcpServerEnabled(name, enabled) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const want = enabled !== false;
      const shadowRow = mcpStatus().servers.find((s) => s.name === serverName);
      if (!shadowRow) throw new Error(`MCP server not configured: ${serverName}`);
      const servers = mcpServersOf(getConfig());
      const current = servers[serverName];
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      servers[serverName] = { ...current, enabled: want };
      saveServers(servers);
      const status = await sync.scheduleMcpToggle(serverName, want);
      await sync.publish('mcp');
      return status;
    },
    async enablePluginMcp(plugin = {}) {
      const root = clean(plugin.root);
      const script = pluginMcpEnableScript(root, plugin);
      if (!root || !script) throw new Error('plugin has no MCP script');
      const serverName = pluginMcpServerName(plugin);
      const nextConfig = { ...getConfig() };
      const manifestMcp = pluginRawMcpServers(root, script);
      const env = pluginMcpEnv(cfgMod.getPluginData?.() || STANDALONE_DATA_DIR, plugin, serverName);
      if (manifestMcp) {
        nextConfig.mcpServers = manifestPluginMcpServers(nextConfig.mcpServers, manifestMcp, {
          plugin,
          serverName,
          env,
        });
      } else {
        const scriptPath = resolveContainedPluginPath(root, script);
        if (!scriptPath || !existsSync(scriptPath))
          throw new Error(`plugin MCP script not found: ${join(root, script)}`);
        nextConfig.mcpServers = {
          ...(nextConfig.mcpServers || {}),
          [serverName]: {
            command: 'node',
            args: [scriptPath],
            cwd: root,
            env,
            ...(plugin.enabled === false ? { _mixdogPluginDisabled: true } : {}),
          },
        };
      }
      saveConfigAndAdopt(nextConfig);
      const status = await sync.reconnectMcpAndAnnounce();
      return { serverName, status };
    },
  };
}
