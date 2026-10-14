// MCP config/status/connect glue. Mutable runtime state is dependency-injected
// through accessors and the caller-owned `state` object; the server catalog,
// connection orchestration and editor-input normalization live under
// ./mcp-glue/ and are composed here.
import { createMcpServerCatalog } from './mcp-glue/server-catalog.mjs';
import { createMcpConnect } from './mcp-glue/connect.mjs';
import { createMcpServerInput } from './mcp-glue/server-input.mjs';

export function createMcpGlue({
  mcpClient,
  getConfig,
  getCurrentCwd,
  getMcpScopeId = () => null,
  getPluginDataDir,
  listPlugins,
  state,
}) {
  const catalog = createMcpServerCatalog({
    mcpClient,
    getConfig,
    getCurrentCwd,
    getMcpScopeId,
    getPluginDataDir,
    listPlugins,
    state,
  });
  const connect = createMcpConnect({
    mcpClient,
    getMcpScopeId,
    getCurrentCwd,
    state,
    resolveEffectiveMcpServers: catalog.resolveEffectiveMcpServers,
    mcpStatus: catalog.mcpStatus,
  });
  const { normalizeMcpServerInput } = createMcpServerInput({ mcpClient, getCurrentCwd });

  return {
    mcpStatus: catalog.mcpStatus,
    resolveMcpCatalog: catalog.resolveCatalog,
    resolveConfiguredMcpCatalog: catalog.resolveConfiguredCatalog,
    pluginMcpServer: catalog.pluginServer,
    pluginMcpSummary: catalog.pluginMcpSummary,
    getMcpServerConfig: catalog.getMcpServerConfig,
    connectConfiguredMcp: connect.connectConfiguredMcp,
    awaitInitialMcpConnect: connect.awaitInitialMcpConnect,
    cancelMcpLogin: connect.cancelMcpLogin,
    normalizeMcpServerInput,
  };
}
