// cwd-plugins/plugin-status.mjs — the registered-plugin status list with its
// manifest cache (keyed on mtime); skill count and MCP discovery are live.
import { readFileSync } from 'node:fs';
import { discoverPluginMcp } from '../../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';
import { PLUGIN_MANIFEST_FILES, pluginSkillsRoots } from '../../runtime/shared/plugin-manifest.mjs';
import { pluginMetadata } from '../../runtime/shared/plugin-metadata.mjs';

export function createPluginStatus({
  listRegisteredPlugins,
  pluginAdminStatus,
  pluginManifest,
  pluginMcpSummary = () => new Map(),
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

  function registeredPlugin(entry, mcpByPlugin) {
    const root = clean(entry.root);
    if (!root) return null;
    if (!existsSync(root))
      return {
        missing: true,
        id: clean(entry.id) || clean(entry.name) || root,
        name: clean(entry.name) || clean(entry.id) || root.split(/[\\/]/).pop() || root,
      };
    const { manifest, invalid } = cachedPluginData(root);
    const name = clean(manifest.name) || clean(manifest.id) || clean(entry.name) || root.split(/[\\/]/).pop() || root;
    const { mcpScript, mcpInline } = discoverPluginMcp(root);
    const skillCount = countSkillFiles(root);
    // The hook files the hook bus loads for a plugin (hook-bus/config.mjs).
    const hooks = [resolve(root, 'hooks', 'hooks.json'), resolve(root, '.mixdog', 'hooks.json')].some((file) =>
      existsSync(file)
    );
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
      hooks,
      mcpScript,
      mcpInline,
    };
    if (invalid) plugin.invalid = true;
    if (plugin.enabled && skillCount === 0 && !mcpScript && !mcpInline && !hooks) {
      plugin.searchedSkillRoots = pluginSkillsRoots(root);
      plugin.warning = `No skills or MCP server found. Searched skill roots: ${plugin.searchedSkillRoots.join(', ')}`;
    }
    // Servers the plugin declares, live: name, declared key, intent/effective
    // state, connection, and declaration problems.
    const mcp = mcpByPlugin.get(plugin.id) || { format: 'none', errors: [], servers: [] };
    plugin.mcpFormat = mcp.format;
    plugin.mcpErrors = mcp.errors;
    plugin.mcpServers = mcp.servers.filter(Boolean).map((row) => ({
      name: row.name,
      key: row.owner?.key || '',
      enabled: row.enabled !== false,
      serverEnabled: row.serverEnabled !== false,
      connected: row.connected === true,
      status: row.status,
      error: row.error || null,
      warnings: row.warnings || [],
      cwdDependent: row.owner?.cwdDependent === true,
    }));
    plugin.mcpServerName = plugin.mcpServers[0]?.name || '';
    plugin.mcpEnabled = plugin.mcpServers.some((server) => server.serverEnabled);
    return plugin;
  }

  function pluginsStatus() {
    const dataDir = cfgMod.getPluginData?.();
    let mcpByPlugin = new Map();
    try {
      mcpByPlugin = pluginMcpSummary();
    } catch {
      /* status still lists plugins without their MCP rows */
    }
    const plugins = [];
    const missing = [];
    for (const entry of listRegisteredPlugins({ dataDir })) {
      const plugin = registeredPlugin(entry, mcpByPlugin);
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
