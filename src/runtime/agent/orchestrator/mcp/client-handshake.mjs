/**
 * mcp/client-handshake.mjs — the bounded connect + listTools handshake: a
 * slow/hung server fails on its startup budget with its transport torn down,
 * and a discovery advert that refused the connection is distrusted.
 */
import { markServiceUnreachable, isConnRefuseError } from '../../../shared/service-discovery.mjs';
import { MCP_MAX_TIMER_MS, resolveMcpStartupTimeoutMs } from './client-config.mjs';
import { appendMcpStderrTail } from './client-transport.mjs';
import { MCP_OAUTH_TIMEOUT_MS } from './oauth.mjs';

// tools/list pagination bounds: a server that never stops handing out cursors
// (or repeats one) cannot loop the client forever.
const MAX_MCP_TOOL_PAGES = 100;

/**
 * Every tool of a server: follows `nextCursor` until it is exhausted, repeats,
 * or MAX_MCP_TOOL_PAGES is reached. A page with an invalid shape is returned
 * as-is so the caller's shape validation reports it.
 * The SDK rebuilds its output validators from each page alone, so after a
 * paginated listing they are rebuilt once from every page's tools.
 */
export async function listAllMcpTools(client, requestOptions = undefined) {
  const tools = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  for (; pages < MAX_MCP_TOOL_PAGES; pages += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
    if (!result || !Array.isArray(result.tools)) return result;
    tools.push(...result.tools);
    const next = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  if (pages > 0) client.cacheToolMetadata?.(tools);
  return { tools };
}

async function performHandshake(client, transport, requestOptions) {
  await client.connect(transport, requestOptions);
  const instructionsRaw = typeof client.getInstructions === 'function' ? client.getInstructions() : undefined;
  const instructions = typeof instructionsRaw === 'string' ? instructionsRaw.trim() : '';
  const capabilities = client.getServerCapabilities?.() || {};
  const toolsResult = capabilities.tools ? await listAllMcpTools(client, requestOptions) : { tools: [] };
  return { instructions, toolsResult, capabilities };
}

function startupTimeoutError(name, startupTimeoutMs) {
  const err = new Error(
    `MCP server "${name}" startup exceeded ${startupTimeoutMs}ms budget — raise per-server "startupTimeoutSec"/"startupTimeoutMs" or env MIXDOG_MCP_STARTUP_TIMEOUT_MS`
  );
  err.code = 'EMCPSTARTUPTIMEOUT';
  return err;
}

const oauthLoginError = () => new Error('MCP OAuth login failed, cancelled, or timed out');

/** Code of a connect cancelled (login cancel, disconnect, shutdown) before any
 *  interactive login started. */
export const MCP_CONNECT_CANCELLED = 'EMCPCONNECTCANCELLED';
function connectCancelledError(name) {
  return Object.assign(new Error(`MCP server "${name}" connect cancelled`), { code: MCP_CONNECT_CANCELLED });
}

/**
 * Bound the connect + listTools handshake so a slow/hung server can't stall
 * boot or the first turn. On expiry the pending transport/child is torn down
 * (nothing leaks) and this server fails like any other connect failure — the
 * parallel Promise.allSettled means other servers are unaffected.
 * The SDK's per-request timeout follows the same budget (its own 60s default
 * would otherwise cut a longer or disabled budget short). Failures carry the
 * server's stderr tail. Returns { instructions, toolsResult, capabilities }.
 */
export async function runBoundedHandshake({
  name,
  cfg,
  client,
  transport,
  autoDetectAdvert,
  closeServer,
  stderrTail = () => '',
}) {
  const startupTimeoutMs = resolveMcpStartupTimeoutMs(cfg);
  const guard = { timer: null, timedOut: false };
  let rejectDeadline;
  // True once an interactive login actually started (the server challenged
  // and a browser sign-in was allowed).
  let loginStarted = false;
  const armDeadline = (ms, error = () => startupTimeoutError(name, ms)) => {
    if (guard.timer) clearTimeout(guard.timer);
    guard.timer = setTimeout(() => {
      guard.timedOut = true;
      rejectDeadline(error());
    }, ms);
  };
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  // A closed OAuth connection (login cancel, disconnect, shutdown) settles a
  // handshake that would otherwise wait forever (an SSE stream closed while
  // starting never settles). The SDK also closes the transport — and with it
  // the OAuth connection — right before rethrowing a connect failure of its
  // own (e.g. connection refused): deferring past the pending microtasks lets
  // that real failure settle the race first.
  const cancelOAuth = () =>
    setImmediate(() => rejectDeadline(loginStarted ? oauthLoginError() : connectCancelledError(name)));
  transport.oauth?.signal.addEventListener('abort', cancelOAuth, { once: true });
  if (transport.oauth?.signal.aborted) cancelOAuth();
  if (startupTimeoutMs > 0) armDeadline(startupTimeoutMs);
  // Human authorization gets a separate, finite budget. The ordinary startup
  // budget still applies until the server actually challenges authentication.
  if (transport.oauth) {
    transport.oauth.onStart = () => {
      loginStarted = true;
      armDeadline(MCP_OAUTH_TIMEOUT_MS, oauthLoginError);
    };
  }
  const handshake = performHandshake(client, transport, {
    timeout: !transport.oauth && startupTimeoutMs > 0 ? startupTimeoutMs : MCP_MAX_TIMER_MS,
  });
  try {
    return await Promise.race([handshake, deadline]);
  } catch (err) {
    // A discovery-advert port that fails to connect is a corpse (recycled
    // pid): distrust it so the next connect falls back to the legacy port
    // file instead of re-trusting the same advert. Connection-level errors
    // ONLY — a startup/handshake timeout is a slow-but-alive server.
    if (autoDetectAdvert && isConnRefuseError(err))
      markServiceUnreachable(autoDetectAdvert.service, autoDetectAdvert.port);
    if (guard.timedOut || transport.oauth?.signal.aborted) {
      // Tear down the pending transport/child so a hung handshake never
      // leaks a stdio process or socket — fire-and-forget (like the
      // tool-call timeout path) so a slow tree-kill never delays this
      // server's failure or the parallel batch's resolution.
      try {
        closeServer({ client, transport }).catch(() => {});
      } catch {
        // Teardown is best effort: the handshake failure below is what gets reported.
      }
      // Never let the late handshake settle into an unhandled rejection.
      handshake.catch(() => {});
    }
    const tail = stderrTail();
    if (tail && err instanceof Error) {
      err.message = appendMcpStderrTail(err.message, tail);
      throw err;
    }
    throw tail ? new Error(appendMcpStderrTail(String(err), tail)) : err;
  } finally {
    transport.oauth?.finishConnect();
    if (guard.timer) clearTimeout(guard.timer);
    transport.oauth?.signal.removeEventListener('abort', cancelOAuth);
    if (transport.oauth) transport.oauth.onStart = () => {};
  }
}
