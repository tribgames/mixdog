// Machine-global session HTTP + SSE transport (server side).
//
// Sibling of channel-transport.mjs, deliberately separate: the channels
// transport handles control-client state while channel messages route by the
// durable pinned session, and
// session frames are shared state — every attached client (terminal TUI and the
// desktop app at the same time) must observe the same snapshot stream. Mixing
// the two routing rules into one server would put the pointer semantics on a
// path that must never target a single client.
//
// This module owns ONLY the transport (sockets, client registry, frame fan-out,
// lifecycle). The session service is injected via `handleCall`, so
// the same transport is exercised by the real daemon entry AND by the smoke
// harness with a stub session runtime (no provider, no model download).
// The pieces live under session-transport/: client-registry (attach / drop /
// grace / sweep), call-lanes (fair schedulers), call-route (idempotent
// /call) and routes (the HTTP front door).
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createSessionFrameStream } from './session-frame-stream.mjs';
import { readJsonRequestBody } from '../runtime/shared/http-request-body.mjs';
import { createLoopbackListener } from '../runtime/shared/loopback-listener.mjs';
import { createSessionCallCache } from './session-call-cache.mjs';
import { createClientRegistry } from './session-transport/client-registry.mjs';
import { createCallLanes } from './session-transport/call-lanes.mjs';
import { createCallRoute } from './session-transport/call-route.mjs';
import { createTransportRoutes } from './session-transport/routes.mjs';

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

export function createSessionTransport({
  handleCall,
  serverToken = randomUUID(),
  log = () => {},
  clientGraceMs = 10_000,
  sweepMs = 5_000,
  onClientsEmpty = null,
  onClientRegistered = null,
  onClientDropped = null,
  onUpgradeRequested = null,
  getStatus = () => ({}),
} = {}) {
  if (typeof handleCall !== 'function') throw new Error('handleCall is required');

  let boundPort = null;
  let listener = null;
  let stopPromise = null;
  let closed = false;
  const drain = { reason: '', committed: false };
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

  function beginDrain(reason = 'daemon replacement') {
    if (drain.reason) return false;
    drain.reason = String(reason || 'daemon replacement');
    registry.cancelGrace();
    return true;
  }

  function commitDrain(reason = 'daemon replacement') {
    if (!drain.reason) beginDrain(reason);
    if (drain.committed) return false;
    drain.committed = true;
    registry.cancelGrace();
    return true;
  }

  function start() {
    if (closed) return Promise.reject(new Error('session service transport is closed'));
    listener ??= createLoopbackListener({
      server: http.createServer(handleRequest),
      onListening(port) {
        boundPort = port;
        log(`session service transport listening on 127.0.0.1:${boundPort} pid=${process.pid}`);
      },
      onError(error, fatal) {
        if (!fatal) log(`server error: ${error?.message || error}`);
      },
    });
    return listener.start().then((port) => ({ port, token: serverToken }));
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    const completion = Promise.withResolvers();
    stopPromise = completion.promise;
    closed = true;
    try {
      registry.close();
      lanes.close('session service transport is closed');
      callCache.close();
      await listener?.stop();
      completion.resolve();
    } catch (error) {
      completion.reject(error);
    }
    return stopPromise;
  }

  return {
    start,
    stop,
    broadcast,
    beginDrain,
    commitDrain,
    get port() {
      return boundPort;
    },
    get clientCount() {
      return registry.lifecycleClientCount();
    },
    get connectionCount() {
      return clients.size;
    },
    get activeCount() {
      return lanes.active;
    },
    get queuedCount() {
      return lanes.queued;
    },
    get draining() {
      return Boolean(drain.reason);
    },
    get drainCommitted() {
      return drain.committed;
    },
  };
}
