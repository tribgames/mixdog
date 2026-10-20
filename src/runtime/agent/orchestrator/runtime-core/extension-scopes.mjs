// extension-scopes.mjs — plugin-aware layer over the shared scope model. A
// plugin's scope cascades to the skills it owns and to the MCP server(s) it
// declares, so limiting the plugin limits everything it brought along. MCP
// ownership comes from the tool's `mcpPluginId`, set when the plugin's server
// connected, never from the server name.
import { loadConfig } from '../config.mjs';
import {
  extensionAllowedForCwd,
  extensionScopesFromConfig,
  hasExtensionScopes,
  mcpServerNameOfTool,
} from '../../../shared/extension-scopes.mjs';
import { clean } from '../../../shared/clean.mjs';

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
} from '../../../shared/extension-scopes.mjs';

/** Server scope ∩ owning plugin's scope (`pluginId` from owner metadata). */
export function mcpServerAllowedForCwd(scopes, serverName, cwd, { pluginId = '' } = {}) {
  if (!extensionAllowedForCwd(scopes, 'mcp', serverName, cwd)) return false;
  const owner = clean(pluginId);
  if (owner && !extensionAllowedForCwd(scopes, 'plugins', owner, cwd)) return false;
  return true;
}

/** Drop tools of MCP servers whose scope excludes cwd; non-MCP tools pass. */
export function filterMcpToolsForCwd(tools, scopes, cwd) {
  const list = Array.isArray(tools) ? tools : [];
  const verdicts = new Map();
  return list.filter((tool) => {
    // A name shortened for provider limits carries its server explicitly.
    const server = mcpServerNameOfTool(tool);
    if (!server) return true;
    const pluginId = clean(tool?.mcpPluginId);
    const key = `${server}\0${pluginId}`;
    if (!verdicts.has(key)) verdicts.set(key, mcpServerAllowedForCwd(scopes, server, cwd, { pluginId }));
    return verdicts.get(key);
  });
}

/** The MCP tools a session at `cwd` may see. No scopes configured → the input
 *  as-is, so the global-only fast path costs one config read. An agent's
 *  connectors never narrow this list: the schema and the BP2 manifest stay
 *  identical across agents (one shared cache prefix), and the connector policy
 *  is enforced at dispatch (pre-dispatch-deny / connector approval). */
export function filterMcpToolsForSession(tools, cwd, config = null) {
  const list = Array.isArray(tools) ? tools : [];
  if (!list.length) return list;
  const scopes = extensionScopesFromConfig(config || loadConfig({ secrets: false }));
  return hasExtensionScopes(scopes) ? filterMcpToolsForCwd(list, scopes, cwd) : list;
}
