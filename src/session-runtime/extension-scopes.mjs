// extension-scopes.mjs — plugin-aware layer over the shared scope model. A
// plugin's scope cascades to the skills it owns and to the MCP server(s) it
// installed, so limiting the plugin limits everything it brought along.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { pluginMcpServerName } from './plugin-mcp.mjs';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';
import { loadConfig } from '../runtime/agent/orchestrator/config.mjs';
import {
  extensionAllowedForCwd,
  extensionScopesFromConfig,
  hasExtensionScopes,
  mcpServerNameOfTool,
} from '../runtime/shared/extension-scopes.mjs';

export {
  EXTENSION_SCOPE_KINDS,
  normalizeExtensionScopes,
  hasExtensionScopes,
  extensionScopesFromConfig,
  extensionScopeProjects,
  cwdWithinProjects,
  extensionAllowedForCwd,
  skillAllowedForCwd,
  mcpServerNameOfTool,
  withExtensionScope,
} from '../runtime/shared/extension-scopes.mjs';

function clean(value) {
  return String(value ?? '').trim();
}

/** Plugin id that installed MCP server `serverName`, or ''. Plugin servers are
 *  named `plugin-<name>` or `plugin-<name>--<suffix>` (plugin-mcp.mjs). */
export function pluginIdForMcpServer(serverName, plugins) {
  const name = clean(serverName);
  if (!name) return '';
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    const base = pluginMcpServerName(plugin);
    if (name === base || name.startsWith(`${base}--`)) return clean(plugin?.id || plugin?.name);
  }
  return '';
}

export function mcpServerAllowedForCwd(scopes, serverName, cwd, { plugins = [] } = {}) {
  if (!extensionAllowedForCwd(scopes, 'mcp', serverName, cwd)) return false;
  const pluginId = pluginIdForMcpServer(serverName, plugins);
  if (pluginId && !extensionAllowedForCwd(scopes, 'plugins', pluginId, cwd)) return false;
  return true;
}

/** Drop tools of MCP servers whose scope excludes cwd; non-MCP tools pass. */
export function filterMcpToolsForCwd(tools, scopes, cwd, options = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const verdicts = new Map();
  return list.filter((tool) => {
    const server = mcpServerNameOfTool(tool?.name);
    if (!server) return true;
    if (!verdicts.has(server)) verdicts.set(server, mcpServerAllowedForCwd(scopes, server, cwd, options));
    return verdicts.get(server);
  });
}

// `{ id, name }` of every registered plugin, from <data>/plugins/registry.json.
// mtime-cached: this runs on every session create and MCP catalog fold.
let _registryCache = { path: '', mtime: -1, plugins: [] };
export function registeredPluginIdentities(dataDir = null) {
  let path = '';
  try { path = join(dataDir || resolvePluginData(), 'plugins', 'registry.json'); }
  catch { return []; }
  let mtime = -1;
  try { mtime = statSync(path).mtimeMs; }
  catch { return []; }
  if (_registryCache.path === path && _registryCache.mtime === mtime) return _registryCache.plugins;
  let plugins = [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    plugins = (Array.isArray(parsed?.plugins) ? parsed.plugins : [])
      .map((entry) => ({ id: clean(entry?.id || entry?.name), name: clean(entry?.name || entry?.id) }))
      .filter((entry) => entry.id);
  } catch {
    plugins = [];
  }
  _registryCache = { path, mtime, plugins };
  return plugins;
}

/** The MCP tools a session at `cwd` may see. No scopes configured → input
 *  returned as-is, so the global-only fast path costs one config read. */
export function filterMcpToolsForSession(tools, cwd, config = null) {
  const list = Array.isArray(tools) ? tools : [];
  if (!list.length) return list;
  const scopes = extensionScopesFromConfig(config || loadConfig({ secrets: false }));
  if (!hasExtensionScopes(scopes)) return list;
  return filterMcpToolsForCwd(list, scopes, cwd, { plugins: registeredPluginIdentities() });
}
