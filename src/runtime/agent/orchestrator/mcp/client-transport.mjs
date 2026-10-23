/**
 * mcp/client-transport.mjs — building the SDK transport a server config asks
 * for: autoDetect (port discovered from a live service), streamable HTTP, SSE,
 * WebSocket, or a stdio child.
 */
import { readServicePort } from '../../../shared/service-discovery.mjs';
import { createMcpOAuth } from './oauth.mjs';
import { mcpOAuthClientFor, mcpOAuthDisplayName } from './oauth-client.mjs';
import { googleMcpService, withGoogleMcp } from '../../../connectors/google-mcp.mjs';
import { gmailAppPasswordService, withGmailAppPasswordMcp } from '../../../connectors/gmail-app-password.mjs';
import {
  AUTO_DETECT_PORTS,
  expandEnvVars,
  findMissingMcpEnvVars,
  mcpUrlForLog,
  normalizeMcpTransportUrl,
  resolveMcpHttpHeaders,
  resolveMcpOAuthUrl,
  resolveMcpStdioEnvironment,
  resolveMcpTransportKind,
  scrubMcpConnectionMessage,
} from './client-config.mjs';

/**
 * Auto-detect: the port of a running service from its pid-validated discovery
 * advert. `advert` names it so a connect failure can distrust it — a pid-live
 * advert can point at a recycled-pid corpse port, and this transport has no
 * other health probe of its own.
 */
function resolveAutoDetectUrl(name, cfg) {
  const spec = AUTO_DETECT_PORTS[cfg.autoDetect];
  if (!spec) throw new Error(`Unknown autoDetect target: "${cfg.autoDetect}"`);
  const port = readServicePort(spec.discovery, { requirePid: false });
  if (!port) throw new Error(`autoDetect server "${name}": live service advert missing`);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`autoDetect server "${name}": invalid port value`);
  }
  return { url: `http://127.0.0.1:${port}${spec.endpoint}`, advert: { service: spec.discovery, port } };
}

// Bounded tail of a stdio server's stderr, kept for failure messages (a server
// that dies at startup or mid-session usually says why on stderr).
const MCP_STDERR_TAIL_CHARS = 4096;
const noStderrTail = () => '';

/** Append a server's stderr tail to a failure message (unchanged when empty). */
export function appendMcpStderrTail(message, tail) {
  const text = String(tail || '').trim();
  return text ? `${message}\n--- server stderr (tail) ---\n${text}` : String(message);
}

function requestInitFor(cfg) {
  const headers = resolveMcpHttpHeaders(cfg);
  return headers && Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined;
}

// Configured authentication stays authoritative even when its variables are
// unset or resolve empty: the server then fails as configured instead of
// turning into an OAuth login.
export function hasConfiguredMcpAuth(cfg) {
  const configured = (value) =>
    value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
  return (
    Boolean(String(cfg.bearer_token_env_var || '').trim()) ||
    configured(cfg.headers) ||
    configured(cfg.env_http_headers)
  );
}

// The SDK's WebSocket transport opens its socket without a way to set request
// headers. This subclass changes only socket creation: Node's WebSocket takes
// `{ protocols, headers }`; the guard and event wiring match the stock start().
function createHeaderWebSocketTransport(Base, messageSchema, url, headers) {
  return new (class extends Base {
    start() {
      if (this._socket) {
        throw new Error(
          'WebSocketClientTransport already started! If using Client class, note that connect() calls start() automatically.'
        );
      }
      return new Promise((resolve, reject) => {
        this._socket = new globalThis.WebSocket(this._url, { protocols: 'mcp', headers });
        this._socket.onerror = (event) => {
          const error = 'error' in event ? event.error : new Error(`WebSocket error: ${JSON.stringify(event)}`);
          reject(error);
          this.onerror?.(error);
        };
        this._socket.onopen = () => resolve();
        this._socket.onclose = () => this.onclose?.();
        this._socket.onmessage = (event) => {
          let message;
          try {
            message = messageSchema.parse(JSON.parse(event.data));
          } catch (error) {
            this.onerror?.(error);
            return;
          }
          this.onmessage?.(message);
        };
      });
    }
  })(url);
}
/** Returns { transport, autoDetectAdvert, stderrTail, warnings } — stderrTail()
 *  is the last ~4 KB of a stdio server's (scrubbed) stderr, '' for remote
 *  transports. `strictEnv` (the caller passes it for plugin-declared servers)
 *  makes unset variables without a default fail the server; otherwise they
 *  expand to empty and are reported in `warnings` (names only). */
export function createMcpTransport({ name, cfg, sdk, log, strictEnv, oauthOptions }) {
  const { StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport, WebSocketClientTransport } = sdk;
  const kind = resolveMcpTransportKind(cfg);
  const warnings = [];
  if (kind !== 'autoDetect') {
    const missing = findMissingMcpEnvVars(cfg);
    if (missing.length) {
      const message = `missing environment variable(s): ${missing.join(', ')}`;
      if (strictEnv === true) throw new Error(message);
      warnings.push(message);
      log(`[mcp-client] "${name}": ${message}\n`);
    }
  }
  if (kind === 'autoDetect') {
    const { url, advert } = resolveAutoDetectUrl(name, cfg);
    log(`[mcp-client] Connecting "${name}" via autoDetect HTTP: ${url}\n`);
    return {
      transport: new StreamableHTTPClientTransport(new URL(url)),
      autoDetectAdvert: advert,
      stderrTail: noStderrTail,
      warnings,
    };
  }
  if (kind === 'http' || kind === 'sse') {
    const Transport = kind === 'http' ? StreamableHTTPClientTransport : SSEClientTransport;
    const url = resolveMcpOAuthUrl(cfg);
    const opts = requestInitFor(cfg);
    // Explicit authentication remains authoritative (including custom API-key
    // headers). Never forward those credentials to OAuth discovery endpoints.
    let transport;
    const oauth = hasConfiguredMcpAuth(cfg)
      ? null
      : createMcpOAuth({
          url,
          serverName: mcpOAuthDisplayName(cfg, name),
          oauthClient: mcpOAuthClientFor(cfg, url),
          ...oauthOptions,
          // A built-in Google connector is answered in-process.
          ...(googleMcpService(url) ? { fetchImpl: withGoogleMcp(oauthOptions?.fetchImpl) } : {}),
          // SSE advertises its POST endpoint on the authenticated event stream.
          // No other path on the origin is allowed to receive this server's token.
          isTransportEndpoint: (input) => kind === 'sse' && transport?._endpoint?.href === new URL(input).href,
        });
    // Gmail with an app password is answered in-process too (its account
    // header is the configured authentication; the password is in the keychain).
    const local = !oauth && gmailAppPasswordService(url) ? { ...opts, fetch: withGmailAppPasswordMcp() } : opts;
    transport = new Transport(new URL(url), oauth ? { fetch: oauth.fetch } : local);
    if (oauth) {
      transport.oauth = oauth;
      const close = transport.close.bind(transport);
      transport.close = async () => {
        oauth.close();
        await close();
      };
    }
    log(`[mcp-client] Connecting "${name}" via ${kind.toUpperCase()}: ${mcpUrlForLog(url)}\n`);
    return {
      transport,
      autoDetectAdvert: null,
      stderrTail: noStderrTail,
      warnings,
    };
  }
  if (kind === 'ws') {
    const url = normalizeMcpTransportUrl(expandEnvVars(String(cfg.url ?? '')), 'ws');
    const opts = requestInitFor(cfg);
    log(`[mcp-client] Connecting "${name}" via WebSocket: ${mcpUrlForLog(url)}\n`);
    const transport = opts
      ? createHeaderWebSocketTransport(
          WebSocketClientTransport,
          sdk.JSONRPCMessageSchema,
          new URL(url),
          opts.requestInit.headers
        )
      : new WebSocketClientTransport(new URL(url));
    return { transport, autoDetectAdvert: null, stderrTail: noStderrTail, warnings };
  }
  if (kind === 'stdio') {
    const transport = new StdioClientTransport({
      command: expandEnvVars(String(cfg.command ?? '')),
      args: Array.isArray(cfg.args) ? expandEnvVars(cfg.args) : cfg.args,
      cwd: cfg.cwd == null ? cfg.cwd : expandEnvVars(String(cfg.cwd)),
      env: resolveMcpStdioEnvironment(cfg),
      stderr: cfg.stderr ?? 'pipe',
    });
    let tail = '';
    transport.stderr?.on?.('data', (chunk) => {
      const text = scrubMcpConnectionMessage(chunk, cfg);
      tail = (tail + text).slice(-MCP_STDERR_TAIL_CHARS);
      log(`[mcp:${name}:stderr] ${text}`);
    });
    return { transport, autoDetectAdvert: null, stderrTail: () => tail.trim(), warnings };
  }
  throw new Error(
    `Invalid config for "${name}": need autoDetect, type (stdio/http/sse/ws), url (http), or command (stdio)`
  );
}
