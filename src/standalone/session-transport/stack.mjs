// session-transport/stack.mjs
// Assembly of the session transport's collaborators: the bounded body reader,
// the idempotent call cache, the fair call lanes, the client registry, the
// frame stream and the HTTP route table wired to all of them — plus the memory
// report that spans them. session-transport.mjs owns the socket lifecycle and
// keeps this wiring out of it.
import { createSessionFrameStream } from '../session-frame-stream.mjs';
import { readJsonRequestBody } from '../../runtime/shared/http-request-body.mjs';
import { createSessionCallCache } from '../session-call-cache.mjs';
import { createClientRegistry } from './client-registry.mjs';
import { createCallLanes } from './call-lanes.mjs';
import { createCallRoute } from './call-route.mjs';
import { createTransportRoutes } from './routes.mjs';

// A loopback front door still buffers whatever a client sends before it can be
// parsed, so the body has an explicit ceiling instead of the client's memory.
const MAX_BODY_BYTES = Math.max(1, Number(process.env.MIXDOG_SESSION_MAX_BODY_MB) || 32) * 1024 * 1024;
const BODY_INFLIGHT_MAX_BYTES = Math.max(
  MAX_BODY_BYTES,
  (Number(process.env.MIXDOG_SESSION_BODY_INFLIGHT_MB) || 64) * 1024 * 1024
);

const SSE_PENDING_MAX_BYTES = Math.max(
  256 * 1024,
  (Number(process.env.MIXDOG_SESSION_SSE_PENDING_MB) || 8) * 1024 * 1024
);

// A client may wait up to 300s before recovering a lost /call response.
// Retain the authoritative result beyond that horizon so a retry cannot
// re-run a completed mutation. Default to the transport reconnect budget.
const CALL_CACHE_TTL_MS = Math.max(300_000, Number(process.env.MIXDOG_SESSION_CALL_CACHE_TTL_MS) || 10 * 60_000);
// Bound the dedup table: a call that never settles would otherwise pin its
// entry for the daemon's whole life.
const CALL_CACHE_MAX = Math.max(512, Number(process.env.MIXDOG_SESSION_CALL_CACHE) || 4096);
const CALL_CACHE_MAX_BYTES = Math.max(
  1024 * 1024,
  (Number(process.env.MIXDOG_SESSION_CALL_CACHE_MB) || 8) * 1024 * 1024
);

const nowMs = () => Date.now();

// Bounded JSON body reader with one in-flight byte budget across requests.
function createBodyReader() {
  let bytesInFlight = 0;
  const readBody = (req) =>
    readJsonRequestBody(req, {
      maxBytes: MAX_BODY_BYTES,
      tooLargeMessage: 'request body too large',
      destroyOnLimit: true,
      reserve(bytes) {
        if (bytesInFlight + bytes > BODY_INFLIGHT_MAX_BYTES) return false;
        bytesInFlight += bytes;
        return true;
      },
      release(bytes) {
        bytesInFlight = Math.max(0, bytesInFlight - bytes);
      },
    });
  return {
    readBody,
    get bytesInFlight() {
      return bytesInFlight;
    },
  };
}

export function createTransportStack({
  handleCall,
  serverToken,
  drain,
  log,
  clientGraceMs,
  sweepMs,
  onClientsEmpty,
  onClientRegistered,
  onClientDropped,
  onUpgradeRequested,
  getStatus,
}) {
  const body = createBodyReader();
  const callCache = createSessionCallCache({
    ttlMs: CALL_CACHE_TTL_MS,
    maxEntries: CALL_CACHE_MAX,
    maxBytes: CALL_CACHE_MAX_BYTES,
    now: nowMs,
    log,
  });
  const lanes = createCallLanes();
  const registry = createClientRegistry({
    log,
    nowMs,
    clientGraceMs,
    sweepMs,
    onClientsEmpty,
    onClientRegistered,
    onClientDropped,
  });
  const { clients } = registry;
  const { broadcast, attachSse } = createSessionFrameStream({
    clients,
    maxPendingBytes: SSE_PENDING_MAX_BYTES,
    nowMs,
    onDiagnostic: (entry) => log(`transcript-stream ${JSON.stringify(entry)}`),
    // The stream proves receipt of its token, ending registration replay.
    onAttached: registry.forgetReplaysFor,
    // Stream loss alone does not remove a client or its live session.
    onClosed: () => registry.maybeArmGrace('sse closed'),
  });
  const handleRequest = createTransportRoutes({
    serverToken,
    drain,
    readBody: body.readBody,
    registry,
    lanes,
    callRoute: createCallRoute({ handleCall, clients, lanes, callCache, nowMs }),
    attachSse,
    getStatus,
    transportMemory: () => ({
      bodyBytesInFlight: body.bytesInFlight,
      bodyBytesMax: BODY_INFLIGHT_MAX_BYTES,
      callCacheEntries: callCache.size,
      callCacheBytes: callCache.bytes,
      callCacheMaxBytes: CALL_CACHE_MAX_BYTES,
      ssePendingBytes: [...clients.values()].reduce((sum, client) => sum + (client.pendingBytes || 0), 0),
    }),
    onClientsEmpty,
    onUpgradeRequested,
  });

  return { registry, clients, lanes, callCache, broadcast, handleRequest };
}
