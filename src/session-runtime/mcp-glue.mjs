// MCP config/status/connect glue. Mutable runtime state is dependency-injected
// through accessors and the caller-owned `state` object; the server catalog,
// connection orchestration and editor-input normalization live under
// ./mcp-glue/ and are composed here.
import { createMcpServerCatalog } from './mcp-glue/server-catalog.mjs';
import { createMcpConnect } from './mcp-glue/connect.mjs';
import { createMcpServerInput } from './mcp-glue/server-input.mjs';

export function createMcpGlue({ mcpClient, getConfig, getCurrentCwd, getMcpScopeId = () => null, state }) {
  const catalog = createMcpServerCatalog({ mcpClient, getConfig, getMcpScopeId, state });
  const connect = createMcpConnect({
    mcpClient,
    getMcpScopeId,
    state,
    resolveEffectiveMcpServers: catalog.resolveEffectiveMcpServers,
    mcpStatus: catalog.mcpStatus,
  });
  const { normalizeMcpServerInput } = createMcpServerInput({ mcpClient, getCurrentCwd });

  return {
    mcpStatus: catalog.mcpStatus,
    getMcpServerConfig: catalog.getMcpServerConfig,
    connectConfiguredMcp: connect.connectConfiguredMcp,
    awaitInitialMcpConnect: connect.awaitInitialMcpConnect,
    normalizeMcpServerInput,
  };
}
