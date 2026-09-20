// cwd-plugins/plugin-status.mjs — the registered-plugin status list with its
// per-root caches (manifest keyed on mtime, MCP discovery and skill-file count
// on a short TTL).
import { discoverPluginMcp } from '../plugin-mcp.mjs';
import { pluginMetadata } from '../../runtime/shared/plugin-metadata.mjs';

export function createPluginStatus({
  getConfig,
  listRegisteredPlugins,
  pluginAdminStatus,
  pluginManifest,
  pluginMcpServerName,
  countSkillFiles,
  clean,
  resolve,
  statSync,
  existsSync,
  cfgMod,
}) {
  // Per-plugin-root caches for pluginsStatus(): manifest + MCP discovery keyed
  // by root path + manifest mtime (invalidated on manifest edit); recursive
  // skill-file count keyed by root with a ~5s TTL fallback (the walk has no
  // single mtime to key on).
  const pluginRootCache = new Map();
  const skillCountCache = new Map();
  const mcpDiscoveryCache = new Map();
  function manifestMtimeKey(root) {
    let key = '';
    for (const rel of ['.codex-plugin/plugin.json', 'plugin.json']) {
      try {
        key += `${statSync(resolve(root, rel)).mtimeMs}:`;
      } catch {
        key += '0:';
      }
    }
    return key;
  }
  function cachedPluginData(root) {
    const key = manifestMtimeKey(root);
    const hit = pluginRootCache.get(root);
    if (hit && hit.key === key) return hit;
    const entry = { key, manifest: pluginManifest(root) };
    pluginRootCache.set(root, entry);
    return entry;
  }
  // MCP discovery probes candidate script files (.mcp.json, scripts/run-mcp.mjs,
  // ...) whose add/remove is NOT reflected in the manifest mtime, so key it on a
  // short TTL instead (~5s, like the skill-file count).
  function cachedMcpDiscovery(root) {
    const now = Date.now();
    const hit = mcpDiscoveryCache.get(root);
    if (hit && now - hit.at < 5000) return hit.mcp;
    const mcp = discoverPluginMcp(root);
    mcpDiscoveryCache.set(root, { at: now, mcp });
    return mcp;
  }
  function cachedSkillCount(root) {
    const now = Date.now();
    const hit = skillCountCache.get(root);
    if (hit && now - hit.at < 5000) return hit.count;
    const count = countSkillFiles(root);
    skillCountCache.set(root, { at: now, count });
    return count;
  }

  function registeredPlugin(entry, configuredMcp) {
    const root = clean(entry.root);
    if (!root || !existsSync(root)) return null;
    const manifest = cachedPluginData(root).manifest;
    const name = clean(manifest.name) || clean(manifest.id) || clean(entry.name) || root.split(/[\\/]/).pop() || root;
    const { mcpScript, mcpInline } = cachedMcpDiscovery(root);
    const plugin = {
      id: clean(entry.id) || name,
      name,
      title: clean(manifest.title) || clean(manifest.displayName) || clean(entry.title) || name,
      version: clean(manifest.version) || clean(entry.version) || null,
      description: clean(manifest.description) || clean(entry.description),
      ...pluginMetadata(manifest),
      marketplace: null,
      source: clean(entry.sourceType) === 'local' ? 'local' : 'registry',
      sourceUrl: clean(entry.source),
      sourceType: clean(entry.sourceType) || 'git',
      managed: entry.managed !== false,
      enabled: entry.enabled !== false,
      root,
      installedAt: entry.installedAt || null,
      updatedAt: entry.updatedAt || null,
      skillCount: cachedSkillCount(root),
      mcpScript,
      mcpInline,
    };
    plugin.mcpServerName = pluginMcpServerName(plugin);
    plugin.mcpEnabled =
      Object.hasOwn(configuredMcp, plugin.mcpServerName) ||
      Object.keys(configuredMcp).some((k) => k.startsWith(`${plugin.mcpServerName}--`));
    return plugin;
  }

  function pluginsStatus() {
    const config = getConfig();
    const dataDir = cfgMod.getPluginData?.();
    const configuredMcp = config?.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
    const plugins = [];
    for (const entry of listRegisteredPlugins({ dataDir })) {
      const plugin = registeredPlugin(entry, configuredMcp);
      if (plugin) plugins.push(plugin);
    }
    plugins.sort((a, b) => {
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return a.name.localeCompare(b.name);
    });
    const admin = pluginAdminStatus({ dataDir });
    return {
      count: plugins.length,
      plugins,
      roots: {
        registry: admin.registryPath,
        installed: admin.installRoot,
      },
    };
  }

  return { pluginsStatus };
}
