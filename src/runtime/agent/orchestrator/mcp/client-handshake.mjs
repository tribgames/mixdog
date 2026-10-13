/**
 * mcp/client-handshake.mjs — the bounded connect + listTools handshake: a
 * slow/hung server fails on its startup budget with its transport torn down,
 * and a discovery advert that refused the connection is distrusted.
 */
import { markServiceUnreachable, isConnRefuseError } from '../../../shared/service-discovery.mjs';
import { MCP_MAX_TIMER_MS, resolveMcpStartupTimeoutMs } from './client-config.mjs';
import { appendMcpStderrTail } from './client-transport.mjs';

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
  const handshake = performHandshake(client, transport, {
    timeout: startupTimeoutMs > 0 ? startupTimeoutMs : MCP_MAX_TIMER_MS,
  });
  try {
    if (startupTimeoutMs <= 0) return await handshake;
    const deadline = new Promise((_, rej) => {
      guard.timer = setTimeout(() => {
        guard.timedOut = true;
        rej(startupTimeoutError(name, startupTimeoutMs));
      }, startupTimeoutMs);
    });
    return await Promise.race([handshake, deadline]);
  } catch (err) {
    // A discovery-advert port that fails to connect is a corpse (recycled
    // pid): distrust it so the next connect falls back to the legacy port
    // file instead of re-trusting the same advert. Connection-level errors
    // ONLY — a startup/handshake timeout is a slow-but-alive server.
    if (autoDetectAdvert && isConnRefuseError(err))
      markServiceUnreachable(autoDetectAdvert.service, autoDetectAdvert.port);
    if (guard.timedOut) {
      // Tear down the pending transport/child so a hung handshake never
      // leaks a stdio process or socket — fire-and-forget (like the
      // tool-call timeout path) so a slow tree-kill never delays this
      // server's failure or the parallel batch's resolution.
      try {
        closeServer({ client, transport }).catch(() => {});
      } catch {
        /* ignore */
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
    if (guard.timer) clearTimeout(guard.timer);
  }
}
