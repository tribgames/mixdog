// Plugin registry edits and the MCP entries a plugin owns.
import { clean } from './session-text.mjs';
import {
  addPlugin as registryAddPlugin,
  removePlugin as registryRemovePlugin,
  setPluginEnabled as registrySetPluginEnabled,
  updatePlugin as registryUpdatePlugin,
} from '../standalone/plugin-admin.mjs';
import { pluginMcpServerName } from './plugin-mcp.mjs';
import { pluginServerMatcher } from './resource-mcp-api.mjs';

const pluginKey = (plugin) => clean(plugin.id || plugin.name || plugin);

export function createPluginsResourceApi({ deps, sync, decorate }) {
  const {
    getConfig,
    cfgMod,
    saveConfigAndAdopt,
    connectConfiguredMcp,
    invalidatePreSessionToolSurface,
    pluginsStatus,
  } = deps;
  const pluginData = () => cfgMod.getPluginData?.();

  /** Rewrite the plugin's MCP entries through `rewrite`; when any existed,
   *  persist and reconnect so the connection registry matches the config. */
  async function rewritePluginServers(plugin, rewrite) {
    const nextConfig = { ...getConfig() };
    const owned = pluginServerMatcher(pluginMcpServerName(plugin));
    const current = nextConfig.mcpServers || {};
    if (!Object.keys(current).some(owned)) return;
    saveConfigAndAdopt({ ...nextConfig, mcpServers: rewrite(current, owned) });
    await connectConfiguredMcp({ reset: true });
    invalidatePreSessionToolSurface();
  }

  return {
    pluginsStatus() {
      return decorate.plugins(pluginsStatus());
    },
    async reloadPlugins() {
      await sync.announce('plugins');
      return pluginsStatus();
    },
    async addPlugin(source) {
      const plugin = registryAddPlugin(source, { dataDir: pluginData() });
      await sync.announce('plugins');
      return { plugin, status: pluginsStatus() };
    },
    async updatePlugin(plugin = {}) {
      const updated = registryUpdatePlugin(pluginKey(plugin), { dataDir: pluginData() });
      await sync.announce('plugins');
      return { plugin: updated, status: pluginsStatus() };
    },
    async setPluginEnabled(plugin = {}, enabled = true) {
      const updated = registrySetPluginEnabled(pluginKey(plugin), enabled, { dataDir: pluginData() });
      await rewritePluginServers(plugin, (servers, owned) => {
        const next = {};
        for (const [name, value] of Object.entries(servers)) {
          const config = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value;
          if (owned(name) && config && typeof config === 'object' && !Array.isArray(config)) {
            if (enabled === false) config._mixdogPluginDisabled = true;
            else delete config._mixdogPluginDisabled;
          }
          next[name] = config;
        }
        return next;
      });
      await sync.announce('plugins');
      return { plugin: updated, status: pluginsStatus() };
    },
    async removePlugin(plugin = {}) {
      const removed = registryRemovePlugin(pluginKey(plugin), { dataDir: pluginData() });
      await rewritePluginServers(plugin, (servers, owned) => {
        const next = { ...servers };
        for (const name of Object.keys(next)) {
          if (owned(name)) delete next[name];
        }
        return next;
      });
      await sync.announce('plugins');
      return { plugin: removed, status: pluginsStatus() };
    },
  };
}
