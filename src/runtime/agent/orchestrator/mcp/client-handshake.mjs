/**
 * mcp/client-handshake.mjs — the bounded connect + listTools handshake: a
 * slow/hung server fails on its startup budget with its transport torn down,
 * and a discovery advert that refused the connection is distrusted.
 */
import { markServiceUnreachable, isConnRefuseError } from '../../../shared/service-discovery.mjs';
import { resolveMcpStartupTimeoutMs } from './client-config.mjs';

async function performHandshake(client, transport) {
  await client.connect(transport);
  const instructionsRaw = typeof client.getInstructions === 'function' ? client.getInstructions() : undefined;
  const instructions = typeof instructionsRaw === 'string' ? instructionsRaw.trim() : '';
  const capabilities = client.getServerCapabilities?.() || {};
  const toolsResult = capabilities.tools ? await client.listTools() : { tools: [] };
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
 * Returns { instructions, toolsResult, capabilities }.
 */
export async function runBoundedHandshake({ name, cfg, client, transport, autoDetectAdvert, closeServer }) {
  const startupTimeoutMs = resolveMcpStartupTimeoutMs(cfg);
  const guard = { timer: null, timedOut: false };
  const handshake = performHandshake(client, transport);
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
    throw err;
  } finally {
    if (guard.timer) clearTimeout(guard.timer);
  }
}
