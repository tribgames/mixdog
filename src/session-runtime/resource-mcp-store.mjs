// The user's `mcpServers` as the MCP server API reads and writes it: every
// read already merged (one server per multi-account connector) and with
// adoptable plugin copies adopted; every write persisted with collision names
// pinned. Also the free-name and plugin-ownership checks over that registry.
import { withAdoptedCopies, withPinnedCollisionNames } from './mcp-glue/plugin-servers.mjs';
import { connectorAccountsOf, mergeConnectorAccountServers } from '../runtime/shared/connector-catalog.mjs';
import { mcpServersOf } from './resource-mcp-servers.mjs';

function pluginOwnedError(name, owner) {
  return new Error(
    `MCP server "${name}" is provided by plugin "${owner.id}" (server "${owner.key}"); ` +
      'enable or disable it with set_mcp_enabled, or manage the plugin instead'
  );
}

export function createMcpServerStore({ getConfig, saveConfigAndAdopt, resolveMcpCatalog, pluginMcpServer }) {
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
  // Every write starts from the merged form: one server per multi-account connector.
  const userServers = () => mergeConnectorAccountServers(mcpServersOf(adoptedConfig())).servers;
  /** A name no server, plugin server or account has yet: `base`, else `base-2`… */
  const freeName = (servers, base) => {
    const taken = new Set(
      Object.entries(servers).flatMap(([name, cfg]) => [name, ...connectorAccountsOf(cfg).map((a) => a.name)])
    );
    const free = (name) => !taken.has(name) && !pluginMcpServer(name);
    if (free(base)) return base;
    for (let n = 2; ; n += 1) if (free(`${base}-${n}`)) return `${base}-${n}`;
  };
  const refusePluginServer = (name) => {
    const owned = name ? pluginMcpServer(name) : null;
    if (owned) throw pluginOwnedError(name, owned.owner);
  };

  return { adoptedConfig, saveServers, userServers, freeName, refusePluginServer };
}
