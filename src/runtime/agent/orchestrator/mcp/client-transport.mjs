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
import { withConnectorAccountsMcp } from '../../../connectors/connector-accounts-mcp.mjs';
import {
  connectorAccountsOf,
  connectorLiveAccountServers,
  gmailAppPasswordAccount,
} from '../../../shared/connector-catalog.mjs';
import { runAbortable } from '../../../shared/abort-race.mjs';
import { isMcpOAuthReauthenticationRequired, storedMcpOAuthIdentity } from './oauth.mjs';
import { shutdownStdioChild } from './child-tree.mjs';
import { listAllMcpTools } from './client-handshake.mjs';
import {
  AUTO_DETECT_PORTS,
  MCP_MAX_TIMER_MS,
  expandEnvVars,
  findMissingMcpEnvVars,
  mcpUrlForLog,
  normalizeMcpTransportUrl,
  resolveMcpHttpHeaders,
  resolveMcpOAuthCredentialKey,
  resolveMcpOAuthUrl,
  resolveMcpStdioEnvironment,
  resolveMcpTransportKind,
  scrubMcpConnectionMessage,
  scrubMcpSecrets,
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
    configured(cfg.env_http_headers) ||
    // A multi-account connector's server: each account authenticates itself.
    connectorAccountsOf(cfg).length > 0
  );
}

// A stdio account (Postgres) runs one process per account config, shared by
// the connector server of every scope like any stdio server (client.mjs):
// account config → its connection, which closes with its last holder.
const sharedAccountConnections = new Map();

/** Close one account connection: a stdio child with its whole process tree. */
async function closeAccountConnection(connection) {
  connection.dead = true;
  if (connection.transport?._process) await shutdownStdioChild(connection.transport).catch(() => {});
  await connection.client.close().catch(() => {});
}

/** Whether a call failure is the account server's own JSON-RPC answer: its
 *  connection stays. */
const answeredError = (error) => error?.name === 'McpError' && error.code !== -32000;

/** The address a remote account is signed in as, '' when none is known. */
function signedInAs(accountCfg) {
  try {
    const url = resolveMcpOAuthUrl(accountCfg);
    if (!url || hasConfiguredMcpAuth(accountCfg)) return '';
    return storedMcpOAuthIdentity(url, resolveMcpOAuthCredentialKey(accountCfg))?.account || '';
  } catch {
    return '';
  }
}

/** One account of a connector server (connector-catalog.mjs
 *  connectorAccountServer) as connector-accounts-mcp.mjs calls it: its own
 *  MCP connection through the transport it had as a server of its own — its
 *  key header, its app password, its local command, or its own
 *  non-interactive OAuth sign-in (refreshed as needed; a new sign-in goes
 *  through 계정 바꾸기, never through a tool call). Connected on first use and
 *  again after its connection failed. */
function connectorAccountClient(serverName, accountCfg, { sdk, log, oauthOptions }) {
  const { interactive: _interactive, ...ownOAuth } = oauthOptions || {};
  const address = gmailAppPasswordAccount(accountCfg);
  const shareKey = resolveMcpTransportKind(accountCfg) === 'stdio' ? JSON.stringify(accountCfg) : null;
  const secretsOf = (connection) => connection?.transport?.oauth?.secrets() || [];
  const accountError = (error, connection) => {
    if (isMcpOAuthReauthenticationRequired(error)) {
      return Object.assign(new Error('Sign-in required; sign this account in again in Connectors.'), {
        authRequired: true,
      });
    }
    const reason = scrubMcpConnectionMessage(error?.message || String(error), accountCfg, secretsOf(connection));
    return new Error(appendMcpStderrTail(reason, connection?.stderrTail?.() || ''));
  };
  const open = () => {
    const connection = { users: 0, dead: false };
    try {
      const made = createMcpTransport({ name: accountCfg.name, cfg: accountCfg, sdk, log, oauthOptions: ownOAuth });
      connection.transport = made.transport;
      connection.stderrTail = made.stderrTail;
    } catch (error) {
      // A broken account (no sign-in client, an invalid address) stays listed with why.
      connection.dead = true;
      connection.client = { close: async () => {} };
      connection.ready = Promise.reject(error);
      connection.ready.catch(() => {});
      return connection;
    }
    const client = new sdk.Client({ name: `mixdog-agent/${serverName}`, version: '1.0.0' });
    connection.client = client;
    const retire = () => {
      connection.dead = true;
      if (shareKey && sharedAccountConnections.get(shareKey) === connection) sharedAccountConnections.delete(shareKey);
    };
    client.onclose = retire;
    connection.retire = retire;
    connection.ready = (async () => {
      await client.connect(connection.transport, { timeout: MCP_MAX_TIMER_MS });
      const tools = client.getServerCapabilities()?.tools
        ? (await listAllMcpTools(client, { timeout: MCP_MAX_TIMER_MS }))?.tools
        : [];
      if (!Array.isArray(tools)) throw new Error('The account listed its tools in an invalid shape');
      return { instructions: client.getInstructions() || '', tools };
    })();
    connection.ready.catch(() => {
      retire();
      void closeAccountConnection(connection);
    });
    return connection;
  };
  let held = null;
  const release = () => {
    const connection = held;
    held = null;
    if (!connection || --connection.users > 0) return;
    connection.retire?.();
    void closeAccountConnection(connection);
  };
  const acquire = () => {
    if (held && !held.dead) return held;
    release();
    let connection = shareKey ? sharedAccountConnections.get(shareKey) : null;
    if (!connection || connection.dead) {
      connection = open();
      if (shareKey && !connection.dead) sharedAccountConnections.set(shareKey, connection);
    }
    connection.users += 1;
    held = connection;
    return connection;
  };
  return {
    name: accountCfg.name,
    email: address || signedInAs(accountCfg),
    async connect(signal) {
      const connection = acquire();
      try {
        return await runAbortable(signal, () => connection.ready);
      } catch (error) {
        throw accountError(error, connection);
      }
    },
    async callTool(params, { signal, onprogress } = {}) {
      const connection = acquire();
      try {
        await runAbortable(signal, () => connection.ready);
        // The caller's deadline governs (it resets on the progress passed up).
        const result = await connection.client.callTool(params, undefined, {
          signal,
          timeout: MCP_MAX_TIMER_MS,
          ...(onprogress ? { onprogress } : {}),
        });
        return scrubMcpSecrets(result, secretsOf(connection));
      } catch (error) {
        const failed = accountError(error, connection);
        if (answeredError(error)) return { content: [{ type: 'text', text: failed.message }], isError: true };
        // A connection a call failed on is opened again for the next call.
        if (!signal?.aborted) connection.retire?.();
        throw failed;
      }
    },
    close: release,
  };
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
// Unset variables a config references: a failure under `strictEnv`,
// otherwise warnings (names only), each logged.
function missingEnvWarnings(name, cfg, strictEnv, log) {
  const warnings = [];
  const missing = findMissingMcpEnvVars(cfg);
  if (missing.length) {
    const message = `missing environment variable(s): ${missing.join(', ')}`;
    if (strictEnv === true) throw new Error(message);
    warnings.push(message);
    log(`[mcp-client] "${name}": ${message}\n`);
  }
  return warnings;
}

// A connector server: one server, every account behind it (its account choice
// on `connectorAccounts`); closing the transport closes every account client.
function connectorAccountsTransport({ name, cfg, Transport, url, accountServers, sdk, oauthOptions, log }) {
  const accounts = accountServers.map((accountCfg) =>
    connectorAccountClient(name, accountCfg, { sdk, log, oauthOptions })
  );
  const fetchImpl = withConnectorAccountsMcp({ connector: cfg.connector, accounts });
  const transport = new Transport(new URL(url), { fetch: fetchImpl });
  transport.connectorAccounts = fetchImpl.connectorAccounts;
  const close = transport.close.bind(transport);
  transport.close = async () => {
    for (const account of accounts) account.close();
    await close();
  };
  log(`[mcp-client] Connecting "${name}" with ${accounts.length} account(s)\n`);
  return transport;
}

// A streamable HTTP or SSE server: its configured authentication, or else an
// OAuth sign-in the transport owns (and closes with it).
function remoteHttpTransport({ name, cfg, kind, Transport, url, oauthOptions, log }) {
  const opts = requestInitFor(cfg);
  // Explicit authentication remains authoritative (including custom API-key
  // headers). Never forward those credentials to OAuth discovery endpoints.
  let transport;
  let oauth = null;
  if (!hasConfiguredMcpAuth(cfg)) {
    oauth = createMcpOAuth({
      url,
      credentialKey: resolveMcpOAuthCredentialKey(cfg),
      serverName: mcpOAuthDisplayName(cfg, name),
      oauthClient: mcpOAuthClientFor(cfg, url),
      ...oauthOptions,
      // A built-in Google connector is answered in-process.
      ...(googleMcpService(url) ? { fetchImpl: withGoogleMcp(oauthOptions?.fetchImpl) } : {}),
      // SSE advertises its POST endpoint on the authenticated event stream.
      // No other path on the origin is allowed to receive this server's token.
      isTransportEndpoint: (input) => kind === 'sse' && transport?._endpoint?.href === new URL(input).href,
    });
  }
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
  return transport;
}

function webSocketTransport(name, cfg, sdk, log) {
  const { WebSocketClientTransport } = sdk;
  const url = normalizeMcpTransportUrl(expandEnvVars(String(cfg.url ?? '')), 'ws');
  const opts = requestInitFor(cfg);
  log(`[mcp-client] Connecting "${name}" via WebSocket: ${mcpUrlForLog(url)}\n`);
  return opts
    ? createHeaderWebSocketTransport(
        WebSocketClientTransport,
        sdk.JSONRPCMessageSchema,
        new URL(url),
        opts.requestInit.headers
      )
    : new WebSocketClientTransport(new URL(url));
}

// A stdio child, its stderr logged and its bounded (scrubbed) tail kept.
function stdioTransport(name, cfg, StdioClientTransport, log) {
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
  return { transport, stderrTail: () => tail.trim() };
}

/** Returns { transport, autoDetectAdvert, stderrTail, warnings } — stderrTail()
 *  is the last ~4 KB of a stdio server's (scrubbed) stderr, '' for remote
 *  transports. `strictEnv` (the caller passes it for plugin-declared servers)
 *  makes unset variables without a default fail the server; otherwise they
 *  expand to empty and are reported in `warnings` (names only). */
export function createMcpTransport({ name, cfg, sdk, log, strictEnv, oauthOptions }) {
  const { StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport } = sdk;
  const kind = resolveMcpTransportKind(cfg);
  const warnings = kind !== 'autoDetect' ? missingEnvWarnings(name, cfg, strictEnv, log) : [];
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
    // A disabled account is neither connected nor routed to.
    const accountServers = connectorLiveAccountServers(cfg);
    if (!accountServers.length && connectorAccountsOf(cfg).length) {
      throw new Error(`Every account of "${name}" is disabled`);
    }
    const transport = accountServers.length
      ? connectorAccountsTransport({ name, cfg, Transport, url, accountServers, sdk, oauthOptions, log })
      : remoteHttpTransport({ name, cfg, kind, Transport, url, oauthOptions, log });
    return { transport, autoDetectAdvert: null, stderrTail: noStderrTail, warnings };
  }
  if (kind === 'ws') {
    const transport = webSocketTransport(name, cfg, sdk, log);
    return { transport, autoDetectAdvert: null, stderrTail: noStderrTail, warnings };
  }
  if (kind === 'stdio') {
    const { transport, stderrTail } = stdioTransport(name, cfg, StdioClientTransport, log);
    return { transport, autoDetectAdvert: null, stderrTail, warnings };
  }
  throw new Error(
    `Invalid config for "${name}": need autoDetect, type (stdio/http/sse/ws), url (http), or command (stdio)`
  );
}
