// Editor input -> stored MCP server config: name slug, transport selection for
// URL servers, and command/args/cwd/env coercion for stdio servers.
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';

function coerceStringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined || val === null) continue;
    out[String(key)] = String(val);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Explicit URL transport types; an untyped URL is ws for ws(s):// and http otherwise.
const URL_TRANSPORT_TYPES = new Map([
  ['sse', 'sse'],
  ['ws', 'ws'],
  ['http', 'http'],
  ['streamable-http', 'http'],
]);

function coerceStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => clean(entry)).filter(Boolean) : [];
}

function positiveNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number`);
  return n;
}

// Per-server timeouts, stored under the keys client-config.mjs already reads:
// startupTimeoutSec/startupTimeoutMs and timeoutMs. A stored value (save
// merges the existing entry into the input) round-trips unchanged unless the
// setup-facing startupTimeoutSec/toolTimeoutSec overrides it.
function timeoutFields(input) {
  const out = {};
  const startupSec = input.startupTimeoutSec ?? input.startup_timeout_sec;
  if (startupSec != null && startupSec !== '') out.startupTimeoutSec = positiveNumber(startupSec, 'startupTimeoutSec');
  else if (input.startupTimeoutMs != null && input.startupTimeoutMs !== '')
    out.startupTimeoutMs = positiveNumber(input.startupTimeoutMs, 'startupTimeoutMs');
  if (input.toolTimeoutSec != null && input.toolTimeoutSec !== '')
    out.timeoutMs = Math.round(positiveNumber(input.toolTimeoutSec, 'toolTimeoutSec') * 1000);
  else if (input.timeoutMs != null && input.timeoutMs !== '')
    out.timeoutMs = Math.round(positiveNumber(input.timeoutMs, 'timeoutMs'));
  return out;
}

export function createMcpServerInput({ mcpClient, getCurrentCwd }) {
  function normalizeMcpServerInput(input = {}) {
    const result = normalizeTransport(input);
    Object.assign(result.config, timeoutFields(input));
    return result;
  }

  function normalizeTransport(input) {
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
      // The user's own OAuth client (앱 번호); its secret never lands here.
      const oauthClientId = clean(input.oauthClientId);
      if (oauthClientId) config.oauthClientId = oauthClientId;
      return config;
    };
    const url = clean(input.url);
    const type = clean(input.type).toLowerCase();
    if (url) {
      const kind = URL_TRANSPORT_TYPES.get(type) || (/^wss?:\/\//i.test(url) ? 'ws' : 'http');
      const secureUrl =
        typeof mcpClient.normalizeMcpTransportUrl === 'function' ? mcpClient.normalizeMcpTransportUrl(url, kind) : url;
      return { name, config: withOptionalHeaders({ type: kind, url: secureUrl }) };
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
