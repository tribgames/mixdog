// Plugin registry edits. A plugin's MCP servers are derived from the registry
// (mcp-glue/plugin-servers.mjs), so each edit reconciles this runtime's MCP
// connections and then lets peer runtimes reconcile theirs.
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  addPlugin as registryAddPlugin,
  removePlugin as registryRemovePlugin,
  setPluginEnabled as registrySetPluginEnabled,
  updatePlugin as registryUpdatePlugin,
} from './services/plugin-admin.mjs';
import { withAdoptedCopies, withoutPluginIntents, withPinnedCollisionNames } from './mcp-glue/plugin-servers.mjs';

const pluginKey = (plugin) => clean(plugin.id || plugin.name || plugin);

/** The registered status row a caller means by `plugin` (row, id, name, or
 *  title), or null. Callers such as the setup tool pass only a name, while
 *  MCP entry names and scope keys come from the registered record. */
export function findRegisteredPlugin(pluginsStatus, plugin) {
  const key = pluginKey(plugin);
  if (!key) return null;
  return (pluginsStatus()?.plugins || []).find((row) => [row.id, row.name, row.title].map(clean).includes(key)) || null;
}

export function createPluginsResourceApi({ deps, sync, decorate }) {
  const {
    getConfig,
    cfgMod,
    saveConfigAndAdopt,
    pluginsStatus,
    resolveMcpCatalog = () => ({ adoption: null }),
    flushSkillsSave,
  } = deps;
  const pluginData = () => cfgMod.getPluginData?.();

  /** Persist any adoptable copies of plugin servers while the registry still
   *  knows their plugin (a removal must not leave them stranded), and keep any
   *  collision name a plugin server was just given. */
  async function adoptPluginServerCopies(transform = (config) => config) {
    const current = getConfig();
    const catalog = resolveMcpCatalog();
    const next = transform(withPinnedCollisionNames(withAdoptedCopies(current, catalog.adoption), catalog));
    if (next === current) return;
    saveConfigAndAdopt(next);
    await flushSkillsSave?.();
  }

  return {
    pluginsStatus() {
      return decorate.plugins(pluginsStatus());
    },
    async reloadPlugins() {
      await sync.reconcilePluginsAndAnnounce();
      return pluginsStatus();
    },
    async addPlugin(source) {
      const plugin = registryAddPlugin(source, { dataDir: pluginData() });
      await adoptPluginServerCopies();
      await sync.reconcilePluginsAndAnnounce();
      return { plugin, status: pluginsStatus() };
    },
    async updatePlugin(plugin = {}) {
      const updated = registryUpdatePlugin(pluginKey(plugin), { dataDir: pluginData() });
      await adoptPluginServerCopies();
      await sync.reconcilePluginsAndAnnounce();
      return { plugin: updated, status: pluginsStatus() };
    },
    async setPluginEnabled(plugin = {}, enabled = true) {
      await adoptPluginServerCopies();
      const updated = registrySetPluginEnabled(pluginKey(plugin), enabled, { dataDir: pluginData() });
      await sync.reconcilePluginsAndAnnounce();
      return { plugin: updated, status: pluginsStatus() };
    },
    async removePlugin(plugin = {}) {
      const owner = findRegisteredPlugin(pluginsStatus, plugin);
      const ownerId = clean(owner?.id);
      // Adopt first (the registry still knows the plugin), then drop the
      // plugin's per-server intent together with the plugin.
      await adoptPluginServerCopies((config) => (ownerId ? withoutPluginIntents(config, ownerId) : config));
      const removed = registryRemovePlugin(pluginKey(plugin), { dataDir: pluginData() });
      await sync.reconcilePluginsAndAnnounce();
      return { plugin: removed, status: pluginsStatus() };
    },
  };
}
