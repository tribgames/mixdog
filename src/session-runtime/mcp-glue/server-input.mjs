// Editor input -> stored MCP server config: name slug, transport selection for
// URL servers, and command/args/cwd/env coercion for stdio servers.
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { clean } from '../session-text.mjs';

function coerceStringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined || val === null) continue;
    out[String(key)] = String(val);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function coerceStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => clean(entry)).filter(Boolean) : [];
}

export function createMcpServerInput({ mcpClient, getCurrentCwd }) {
  function normalizeMcpServerInput(input = {}) {
    const currentCwd = getCurrentCwd();
    const name = clean(input.name)
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!name) throw new Error('MCP server name is required');
    const withOptionalHeaders = (config) => {
      const headers = coerceStringRecord(input.headers);
      if (headers) config.headers = headers;
      const bearerTokenEnvVar = clean(input.bearer_token_env_var || input.bearerTokenEnvVar);
      if (bearerTokenEnvVar) config.bearer_token_env_var = bearerTokenEnvVar;
      const envHeaders = coerceStringRecord(input.env_http_headers || input.envHttpHeaders);
      if (envHeaders) config.env_http_headers = envHeaders;
      return config;
    };
    const url = clean(input.url);
    const type = clean(input.type).toLowerCase();
    if (url) {
      const secureUrl = (kind) =>
        typeof mcpClient.normalizeMcpTransportUrl === 'function' ? mcpClient.normalizeMcpTransportUrl(url, kind) : url;
      if (type === 'sse') {
        return { name, config: withOptionalHeaders({ type: 'sse', url: secureUrl('sse') }) };
      }
      if (type === 'ws') {
        return { name, config: withOptionalHeaders({ type: 'ws', url: secureUrl('ws') }) };
      }
      if (type === 'http' || type === 'streamable-http') {
        return { name, config: withOptionalHeaders({ type: 'http', url: secureUrl('http') }) };
      }
      if (/^wss?:\/\//i.test(url)) {
        return { name, config: withOptionalHeaders({ type: 'ws', url: secureUrl('ws') }) };
      }
      return { name, config: withOptionalHeaders({ type: 'http', url: secureUrl('http') }) };
    }
    const command = clean(input.command);
    if (!command) throw new Error('MCP server command or URL is required');
    const args = Array.isArray(input.args)
      ? input.args.map((v) => String(v)).filter(Boolean)
      : clean(input.args).split(/\s+/).filter(Boolean);
    const requestedCwd = clean(input.cwd);
    const expandedCwd = requestedCwd.replace(/^~(?=$|[\\/])/, homedir());
    const resolvedCwd = expandedCwd ? resolve(currentCwd, expandedCwd) : '';
    const config = {
      type: 'stdio',
      command,
      args,
      ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
    };
    const env = coerceStringRecord(input.env);
    if (env) config.env = env;
    const envVars = coerceStringArray(input.env_vars || input.envVars);
    if (envVars.length > 0) config.env_vars = envVars;
    return { name, config };
  }

  return { normalizeMcpServerInput };
}
