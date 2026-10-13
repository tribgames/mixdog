// cwd-plugins/plugin-status.mjs — the registered-plugin status list with its
// manifest cache (keyed on mtime); skill count and MCP discovery are live.
import { readFileSync } from 'node:fs';
import { discoverPluginMcp } from '../../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';
import { PLUGIN_MANIFEST_FILES, pluginSkillsRoots } from '../../runtime/shared/plugin-manifest.mjs';
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
  // Per-plugin-root manifest cache keyed by root path + manifest mtimes
  // (invalidated on manifest edit). Skill count and MCP discovery are
  // recomputed on every call so file add/remove shows up immediately.
  const pluginRootCache = new Map();
  function manifestMtimeKey(root) {
    let key = '';
    for (const rel of PLUGIN_MANIFEST_FILES) {
      try {
        key += `${statSync(resolve(root, rel)).mtimeMs}:`;
      } catch {
        key += '0:';
      }
    }
    return key;
  }
  // A manifest file that exists but is not a JSON object is breakage.
  function manifestInvalid(root) {
    for (const rel of PLUGIN_MANIFEST_FILES) {
      const file = resolve(root, rel);
      if (!existsSync(file)) continue;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
      } catch {
        return true;
      }
    }
    return false;
  }
  function cachedPluginData(root) {
    const key = manifestMtimeKey(root);
    const hit = pluginRootCache.get(root);
    if (hit && hit.key === key) return hit;
    const entry = { key, manifest: pluginManifest(root), invalid: manifestInvalid(root) };
    pluginRootCache.set(root, entry);
    return entry;
  }

  function registeredPlugin(entry, configuredMcp) {
    const root = clean(entry.root);
    if (!root) return null;
    if (!existsSync(root)) return { missing: true, id: clean(entry.id) || clean(entry.name) || root, name: clean(entry.name) || clean(entry.id) || root.split(/[\\/]/).pop() || root };
    const { manifest, invalid } = cachedPluginData(root);
    const name = clean(manifest.name) || clean(manifest.id) || clean(entry.name) || root.split(/[\\/]/).pop() || root;
    const { mcpScript, mcpInline } = discoverPluginMcp(root);
    const skillCount = countSkillFiles(root);
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
      skillCount,
      mcpScript,
      mcpInline,
    };
    if (invalid) plugin.invalid = true;
    if (plugin.enabled && skillCount === 0 && !mcpScript && !mcpInline) {
      plugin.searchedSkillRoots = pluginSkillsRoots(root);
      plugin.warning = `No skills or MCP server found. Searched skill roots: ${plugin.searchedSkillRoots.join(', ')}`;
    }
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
    const missing = [];
    for (const entry of listRegisteredPlugins({ dataDir })) {
      const plugin = registeredPlugin(entry, configuredMcp);
      if (plugin?.missing) missing.push({ id: plugin.id, name: plugin.name, enabled: entry.enabled !== false });
      else if (plugin) plugins.push(plugin);
    }
    plugins.sort((a, b) => {
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return a.name.localeCompare(b.name);
    });
    const admin = pluginAdminStatus({ dataDir });
    return {
      count: plugins.length,
      plugins,
      missing,
      roots: {
        registry: admin.registryPath,
        installed: admin.installRoot,
      },
    };
  }

  return { pluginsStatus };
}
