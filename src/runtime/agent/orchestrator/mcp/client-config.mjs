/**
 * mcp/client-config.mjs — interpreting an MCP server config entry: transport
 * kind, URL policy, env expansion, stdio environment, HTTP headers, timeouts,
 * and the log scrubbing that keeps credentials out of connection messages.
 */

/** Known auto-detect targets: port file path relative to tmpdir.
 *  Note: `mixdog` used to self-loopback via active-instance.json's
 *  httpPort, but that path went through channels' owner HTTP server which
 *  only exposes a subset of tools. The plugin's own tools are now injected
 *  in-process through agent's toolExecutor (see orchestrator/internal-tools),
 *  so this registry is for genuinely external port-based MCP targets only. */
export const AUTO_DETECT_PORTS = {
  'mixdog-memory': { discovery: 'memory', endpoint: '/mcp' },
};
const DEFAULT_MCP_CALL_TIMEOUT_MS = 120000;
// Per-server STARTUP handshake budget (connect + listTools): 10s.
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 10000;

function isLoopbackMcpHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function normalizeMcpTransportUrl(raw, kind = 'http') {
  let parsed;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch {
    throw new Error(`MCP ${kind} URL is invalid`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP URLs must not contain credentials');
  }
  const websocket = kind === 'ws';
  const encrypted = websocket
    ? parsed.protocol === 'wss:' || parsed.protocol === 'https:'
    : parsed.protocol === 'https:';
  const localPlaintext =
    isLoopbackMcpHost(parsed.hostname) &&
    (websocket ? parsed.protocol === 'ws:' || parsed.protocol === 'http:' : parsed.protocol === 'http:');
  if (!encrypted && !localPlaintext) {
    throw new Error(
      websocket
        ? 'MCP WebSocket URLs must use wss://; ws:// is allowed only for loopback'
        : 'MCP URLs must use https://; http:// is allowed only for loopback'
    );
  }
  parsed.hash = '';
  return parsed.toString();
}

export function mcpUrlForLog(raw) {
  try {
    const parsed = new URL(String(raw || ''));
    const hadQuery = Boolean(parsed.search);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.toString()}${hadQuery ? '?[query-redacted]' : ''}`;
  } catch {
    return '[invalid MCP URL]';
  }
}

function replaceSecret(text, value) {
  const secret = String(value || '');
  return secret.length >= 4 ? text.split(secret).join('[redacted]') : text;
}

export function scrubMcpConnectionMessage(value, cfg = {}) {
  let text = String(value || '');
  const rawUrl = expandEnvVars(String(cfg?.url || ''));
  if (rawUrl) {
    text = text.split(rawUrl).join(mcpUrlForLog(rawUrl));
    try {
      const parsed = new URL(rawUrl);
      text = replaceSecret(text, parsed.username);
      text = replaceSecret(text, parsed.password);
      for (const paramValue of parsed.searchParams.values()) {
        text = replaceSecret(text, paramValue);
      }
    } catch {
      /* invalid URL is reported without echoing it */
    }
  }
  const headers = resolveMcpHttpHeaders(cfg);
  for (const [name, headerValue] of Object.entries(headers)) {
    if (/authorization|cookie|token|secret|api[-_]?key|signature/i.test(name)) {
      text = replaceSecret(text, headerValue);
    }
  }
  return text
    .replace(/\b(https?|wss?):\/\/[^/\s@]+@/giu, '$1://[redacted]@')
    .replace(/([?&](?:access_token|api[_-]?key|auth|secret|signature|token)=)[^&\s'"]+/giu, '$1[redacted]');
}

/**
 * Expand `${VAR}` and `${env:VAR}` references in string values using the
 * provided env map (defaults to process.env). Recurses into arrays/objects.
 * Unknown vars expand to an empty string. No shell execution.
 */
export function expandEnvVars(value, env = process.env) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
      const v = env?.[name];
      return v == null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvVars(v, env));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandEnvVars(v, env);
    }
    return out;
  }
  return value;
}

const DEFAULT_STDIO_ENV_KEYS =
  process.platform === 'win32'
    ? [
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PROCESSOR_ARCHITECTURE',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'TMP',
        'USERDOMAIN',
        'USERNAME',
        'USERPROFILE',
      ]
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

export function resolveMcpStdioEnvironment(cfg = {}, env = process.env) {
  const explicit = cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env) ? expandEnvVars(cfg.env, env) : {};
  if (!Array.isArray(cfg.env_vars)) return { ...env, ...explicit };
  const inherited = {};
  const keys = new Set([
    ...DEFAULT_STDIO_ENV_KEYS,
    ...cfg.env_vars.map((value) => String(value).trim()).filter(Boolean),
  ]);
  for (const requested of keys) {
    const actual =
      process.platform === 'win32'
        ? Object.keys(env || {}).find((key) => key.toLowerCase() === requested.toLowerCase())
        : requested;
    if (actual && env?.[actual] != null) inherited[actual] = String(env[actual]);
  }
  return { ...inherited, ...explicit };
}

export function resolveMcpHttpHeaders(cfg = {}, env = process.env) {
  const headers = {};
  const envHeaders =
    cfg.env_http_headers && typeof cfg.env_http_headers === 'object' && !Array.isArray(cfg.env_http_headers)
      ? cfg.env_http_headers
      : {};
  for (const [header, envName] of Object.entries(envHeaders)) {
    const value = env?.[String(envName)];
    if (value != null && String(value)) headers[String(header)] = String(value);
  }
  const bearerEnv = String(cfg.bearer_token_env_var || '').trim();
  if (bearerEnv && env?.[bearerEnv] != null && String(env[bearerEnv])) {
    headers.Authorization = `Bearer ${String(env[bearerEnv])}`;
  }
  const explicit =
    cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)
      ? expandEnvVars(cfg.headers, env)
      : {};
  return { ...headers, ...explicit };
}

/**
 * Resolve the canonical transport kind for an MCP server config entry.
 * Returns one of: 'autoDetect' | 'stdio' | 'http' | 'sse' | 'ws'.
 * Throws when no transport can be determined.
 */
export function resolveMcpTransportKind(cfg) {
  if (cfg?.autoDetect) return 'autoDetect';
  if (cfg?.type != null && cfg.type !== '') {
    let t = String(cfg.type).toLowerCase();
    if (t === 'streamable-http' || t === 'streamablehttp') t = 'http';
    if (t === 'stdio' || t === 'http' || t === 'sse' || t === 'ws') return t;
  }
  if (cfg?.transport === 'http') return 'http';
  if (cfg?.command) return 'stdio';
  if (cfg?.url) return 'http';
  throw new Error(`Invalid config: need autoDetect, type (stdio/http/sse/ws), url (http), or command (stdio)`);
}

// MCP per-tool-call timeout. Default 2min: a hung/unresponsive MCP server
// (e.g. a busy editor) must not stall a tool call indefinitely. Genuinely
// long-running tools can raise/disable it via MIXDOG_MCP_CALL_TIMEOUT_MS or a
// per-server timeoutMs/callTimeoutMs config value (0/off/none/false disables).
// On expiry we close the transport so the next dispatch reconnects fresh, but
// we do not retry the timed-out call automatically (avoids side-effect dupes).
export function resolveMcpCallTimeoutMs(cfg = {}, env = process.env) {
  const raw =
    cfg?.timeoutMs ?? cfg?.timeout_ms ?? cfg?.callTimeoutMs ?? cfg?.call_timeout_ms ?? env?.MIXDOG_MCP_CALL_TIMEOUT_MS;
  if (raw == null || raw === '' || raw === false) return DEFAULT_MCP_CALL_TIMEOUT_MS;
  if (typeof raw === 'string' && /^(0|off|none|false)$/i.test(raw.trim())) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MCP_CALL_TIMEOUT_MS;
  return Math.round(parsed);
}

// MCP per-server STARTUP timeout: bounds the connect + listTools handshake so a
// slow or hung server can't stall boot or the first turn. Default 10s.
// Per-server override: startupTimeoutMs / startupTimeoutSec. Global
// env: MIXDOG_MCP_STARTUP_TIMEOUT_MS. A value of 0/off/none/false disables it.
export function resolveMcpStartupTimeoutMs(cfg = {}, env = process.env) {
  const rawMs = cfg?.startupTimeoutMs ?? cfg?.startup_timeout_ms;
  const rawSec = cfg?.startupTimeoutSec ?? cfg?.startup_timeout_sec;
  const rawEnv = env?.MIXDOG_MCP_STARTUP_TIMEOUT_MS;
  let raw;
  let scale = 1;
  if (rawMs != null && rawMs !== '') raw = rawMs;
  else if (rawSec != null && rawSec !== '') {
    raw = rawSec;
    scale = 1000;
  } else if (rawEnv != null && rawEnv !== '') raw = rawEnv;
  else return DEFAULT_MCP_STARTUP_TIMEOUT_MS;
  if (raw === 0 || (typeof raw === 'string' && /^(0|off|none|false)$/i.test(raw.trim()))) return 0;
  const parsed = Number(raw) * scale;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MCP_STARTUP_TIMEOUT_MS;
  return Math.round(parsed);
}
