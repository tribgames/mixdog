// Which catalog connector each connected MCP server is (connector-catalog.mjs
// connectorOfServer), recorded by the client as servers connect, so a tool
// name alone (`mcp__<server>__<tool>`) finds its catalog defaults at dispatch.
import { connectorOfServer } from '../../../shared/connector-catalog.mjs';

const byServer = new Map();

export function rememberServerConnector(name, cfg) {
  const id = connectorOfServer(cfg);
  if (id) byServer.set(String(name), id);
  else byServer.delete(String(name));
}

/** The catalog id of connected server `name`, or ''. */
export function serverConnector(name) {
  return byServer.get(String(name)) || '';
}
