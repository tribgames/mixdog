/**
 * mcp/client-config.mjs — interpreting an MCP server config entry: transport
 * kind, URL policy, env expansion, stdio environment, HTTP headers, timeouts,
 * and the log scrubbing that keeps credentials out of connection messages.
 */
import { createHash } from 'node:crypto';
import { rememberMcpToolIdentity } from '../../../shared/tool-primitives.mjs';

/** Known auto-detect targets: the discovery-advert service name and the MCP
 *  endpoint path on its port.
 *  Note: `mixdog` used to self-loopback via active-instance.json's
 *  httpPort, but that path went through channels' owner HTTP server which
 *  only exposes a subset of tools. The plugin's own tools are now injected
 *  in-process through agent's toolExecutor (see orchestrator/internal-tools),
 *  so this registry is for genuinely external port-based MCP targets only. */
export const AUTO_DETECT_PORTS = {
  'mixdog-memory': { discovery: 'memory', endpoint: '/mcp' },
};
const DEFAULT_MCP_CALL_TIMEOUT_MS = 120000;
// Per-server STARTUP handshake budget (connect + paginated listTools): 30s.
// Cold npx/uvx wrappers routinely need well over 10s to install and boot.
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30000;
// Hard ceiling for a request that keeps reporting progress (each progress
// notification resets the per-call timeout, this caps the total): 30min.
const DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS = 1_800_000;
// Largest delay setTimeout honours; anything larger fires after 1ms. Used as
// the SDK request timeout when our own call timeout is disabled, so the SDK's
// built-in 60s default never applies.
export const MCP_MAX_TIMER_MS = 2_147_483_647;

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
  return secret ? text.split(secret).join('[redacted]') : text;
}

// Configured URL parts and header values shorter than 4 characters are left
// alone: redacting e.g. the `1` of `?v=1` would mangle every message. Known
// connection secrets (OAuth tokens) are redacted at any length.
function replaceConfiguredSecret(text, value) {
  return String(value || '').length >= 4 ? replaceSecret(text, value) : text;
}

/** `value` with every one of `secrets` redacted from its strings, recursing
 *  into arrays and plain objects (tool results, JSON-RPC error data). */
export function scrubMcpSecrets(value, secrets) {
  if (secrets.length === 0) return value;
  if (typeof value === 'string') return secrets.reduce(replaceSecret, value);
  if (Array.isArray(value)) return value.map((item) => scrubMcpSecrets(item, secrets));
  const proto = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [scrubMcpSecrets(key, secrets), scrubMcpSecrets(item, secrets)])
  );
}

/** `secrets` are values known only to the live connection (its OAuth tokens). */
export function scrubMcpConnectionMessage(value, cfg = {}, secrets = []) {
  let text = scrubMcpSecrets(String(value || ''), secrets);
  const rawUrl = expandEnvVars(String(cfg?.url || ''));
  if (rawUrl) {
    text = text.split(rawUrl).join(mcpUrlForLog(rawUrl));
    try {
      const parsed = new URL(rawUrl);
      text = replaceConfiguredSecret(text, parsed.username);
      text = replaceConfiguredSecret(text, parsed.password);
      for (const paramValue of parsed.searchParams.values()) {
        text = replaceConfiguredSecret(text, paramValue);
      }
    } catch {
      /* invalid URL is reported without echoing it */
    }
  }
  const headers = resolveMcpHttpHeaders(cfg);
  for (const [name, headerValue] of Object.entries(headers)) {
    if (/authorization|cookie|token|secret|api[-_]?key|signature/i.test(name)) {
      text = replaceConfiguredSecret(text, headerValue);
    }
  }
  return text
    .replace(/\b(https?|wss?):\/\/[^/\s@]+@/giu, '$1://[redacted]@')
    .replace(/([?&](?:access_token|api[_-]?key|auth|secret|signature|token)=)[^&\s'"]+/giu, '$1[redacted]');
}

/**
 * Expand `${VAR}`, `${env:VAR}` and `${VAR:-default}` references in string
 * values using the provided env map (defaults to process.env). Recurses into
 * arrays/objects. The default (possibly empty) applies only when the variable
 * is unset, and runs to the first `}`. An unset variable without a default
 * expands to an empty string and, when `missing` (a Set) is given, its name is
 * recorded there. No shell execution.
 */
export function expandEnvVars(value, env = process.env, missing) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
      const v = env?.[name];
      if (v != null) return String(v);
      if (fallback !== undefined) return fallback;
      missing?.add(name);
      return '';
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvVars(v, env, missing));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandEnvVars(v, env, missing);
    }
    return out;
  }
  return value;
}

/**
 * Names (deduplicated, first-seen order) of variables a server config needs
 * that are unset: `${VAR}` references without a default in command, args,
 * env, url, headers and cwd, plus the variables named directly by
 * `bearer_token_env_var`, `env_http_headers` values and `env_vars`. Names
 * only — never values.
 */
export function findMissingMcpEnvVars(cfg = {}, env = process.env) {
  const missing = new Set();
  expandEnvVars([cfg.command, cfg.args, cfg.env, cfg.url, cfg.headers, cfg.cwd], env, missing);
  const named = [
    cfg.bearer_token_env_var,
    ...(cfg.env_http_headers && typeof cfg.env_http_headers === 'object' && !Array.isArray(cfg.env_http_headers)
      ? Object.values(cfg.env_http_headers)
      : []),
    ...(Array.isArray(cfg.env_vars) ? cfg.env_vars : []),
  ];
  for (const value of named) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (name && envValue(env, name) == null) missing.add(name);
  }
  return [...missing];
}

// Windows variable names are case-insensitive.
function envValue(env, name) {
  if (process.platform !== 'win32') return env?.[name];
  const actual = Object.keys(env || {}).find((key) => key.toLowerCase() === name.toLowerCase());
  return actual ? env[actual] : undefined;
}

// Provider tool names: at most 64 characters of [A-Za-z0-9_-] (the strictest
// limit among the providers Mixdog talks to).
const PROVIDER_TOOL_NAME_MAX = 64;
const PROVIDER_TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
const KEPT_SERVER_PART_MAX = 40;

/**
 * `mcp__<server>__<tool>` when that already fits provider limits (unchanged
 * for every name that fits today). Otherwise a deterministic short form:
 * the server part kept when it is safe (sanitized and cut short when not),
 * the tool part sanitized and cut, and a hash of the full name appended so
 * distinct tools never meet. Callers keep the original tool name alongside
 * to dispatch the call.
 */
export function providerSafeMcpToolName(serverName, toolName) {
  const server = String(serverName || '');
  const tool = String(toolName || '');
  const full = `mcp__${server}__${tool}`;
  if (full.length <= PROVIDER_TOOL_NAME_MAX && PROVIDER_TOOL_NAME_RE.test(full)) return full;
  const hash = createHash('sha1').update(full).digest('hex').slice(0, 8);
  const serverPart =
    /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/.test(server) && server.length <= KEPT_SERVER_PART_MAX
      ? server
      : server
          .replace(/[^A-Za-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 24)
          .replace(/-+$/, '') || 'server';
  const room = PROVIDER_TOOL_NAME_MAX - `mcp__${serverPart}__`.length - hash.length - 1;
  const toolPart = tool
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .slice(0, Math.max(0, room))
    .replace(/_+$/, '');
  const safe = `mcp__${serverPart}__${toolPart ? `${toolPart}_` : ''}${hash}`;
  // Name-only consumers in this process (display, guards) resolve it back.
  rememberMcpToolIdentity(safe, server, tool);
  return safe;
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

/** The exact URL an HTTP/SSE server config signs in at with OAuth; null for
 *  other transports. */
export function resolveMcpOAuthUrl(cfg) {
  const kind = resolveMcpTransportKind(cfg);
  if (kind !== 'http' && kind !== 'sse') return null;
  return normalizeMcpTransportUrl(expandEnvVars(String(cfg.url ?? '')), kind);
}

/** What the OAuth credentials of an HTTP/SSE server config are stored under:
 *  its exact URL, or a connector account's own `oauthKey` (another account
 *  of the connector signs in at the same URL), whatever the URL. Null for
 *  other transports. */
export function resolveMcpOAuthCredentialKey(cfg) {
  const url = resolveMcpOAuthUrl(cfg);
  if (!url) return null;
  const own = typeof cfg.oauthKey === 'string' ? cfg.oauthKey.trim() : '';
  return own ? `mcp-account:${own}` : url;
}

// MCP per-tool-call timeout. Default 2min: a hung/unresponsive MCP server
// (e.g. a busy editor) must not stall a tool call indefinitely. Genuinely
// long-running tools can raise/disable it via MIXDOG_MCP_CALL_TIMEOUT_MS or a
// per-server timeoutMs/callTimeoutMs config value (0/off/none/false disables).
// On expiry only the timed-out request is cancelled (notifications/cancelled);
// the server and its other in-flight calls stay up, and the timed-out call is
// never retried automatically (avoids side-effect dupes).
export function resolveMcpCallTimeoutMs(cfg = {}, env = process.env) {
  const raw =
    cfg?.timeoutMs ?? cfg?.timeout_ms ?? cfg?.callTimeoutMs ?? cfg?.call_timeout_ms ?? env?.MIXDOG_MCP_CALL_TIMEOUT_MS;
  if (raw == null || raw === '' || raw === false) return DEFAULT_MCP_CALL_TIMEOUT_MS;
  if (typeof raw === 'string' && /^(0|off|none|false)$/i.test(raw.trim())) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MCP_CALL_TIMEOUT_MS;
  return Math.min(Math.round(parsed), MCP_MAX_TIMER_MS);
}

// Total cap for a call whose server keeps reporting progress. Default 30min.
// Per-server override: maxTotalTimeoutMs / max_total_timeout_ms. Global env:
// MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS. 0/off/none/false removes the cap.
export function resolveMcpMaxTotalTimeoutMs(cfg = {}, env = process.env) {
  const raw = cfg?.maxTotalTimeoutMs ?? cfg?.max_total_timeout_ms ?? env?.MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS;
  if (raw == null || raw === '' || raw === false) return DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS;
  if (raw === 0 || (typeof raw === 'string' && /^(0|off|none|false)$/i.test(raw.trim()))) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS;
  return Math.min(Math.round(parsed), MCP_MAX_TIMER_MS);
}

/**
 * The effective limits of one MCP request:
 *  - callTimeoutMs: our per-call timeout (0 = disabled), reset on progress;
 *  - sdkTimeoutMs: what the SDK gets as `timeout` — the call timeout, or the
 *    largest timer when disabled so the SDK's 60s default never applies;
 *  - maxTotalTimeoutMs: the progress-reset ceiling (never below the call
 *    timeout), or undefined when the call is unbounded or the cap is off.
 */
export function resolveMcpRequestTimeouts(cfg = {}, env = process.env) {
  const callTimeoutMs = resolveMcpCallTimeoutMs(cfg, env);
  if (!(callTimeoutMs > 0)) return { callTimeoutMs: 0, sdkTimeoutMs: MCP_MAX_TIMER_MS, maxTotalTimeoutMs: undefined };
  const cap = resolveMcpMaxTotalTimeoutMs(cfg, env);
  return {
    callTimeoutMs,
    sdkTimeoutMs: callTimeoutMs,
    maxTotalTimeoutMs: cap > 0 ? Math.max(cap, callTimeoutMs) : undefined,
  };
}

// MCP per-server STARTUP timeout: bounds the connect + listTools handshake so a
// slow or hung server can't stall boot or the first turn. Default 30s.
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
  return Math.min(Math.round(parsed), MCP_MAX_TIMER_MS);
}
