/**
 * http-router/mcp-route.mjs — the /mcp StreamableHTTP bridge: one MCP
 * server + transport per POST, closed with the response.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFS } from '../../tool-defs.mjs';
import { readBody, sendJson, sendError } from '../http-wire.mjs';

const MEMORY_INSTRUCTIONS_TEXT = '';

export function createMcpRoute({ log, pluginVersion, handleToolCall }) {
  function createHttpMcpServer() {
    const s = new Server(
      { name: 'mixdog-memory', version: pluginVersion },
      { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT }
    );
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
    s.setRequestHandler(CallToolRequestSchema, (req) => handleToolCall(req.params.name, req.params.arguments ?? {}));
    return s;
  }

  const handle = async (req, res) => {
    try {
      if (req.method === 'POST') {
        const httpMcp = createHttpMcpServer();
        const httpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          httpTransport.close();
          void httpMcp.close();
        });
        await httpMcp.connect(httpTransport);
        const body = await readBody(req);
        await httpTransport.handleRequest(req, res, body);
      } else {
        sendJson(res, { error: 'Method not allowed' }, 405);
      }
    } catch (e) {
      log(`[memory-service] /mcp error: ${e.stack || e.message}\n`);
      if (!res.headersSent) sendError(res, e.message, Number(e?.statusCode) || 500);
    }
  };

  return { createHttpMcpServer, handle };
}
