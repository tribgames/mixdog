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
// The pieces live under session-transport/: stack (the bounded body reader and
// the assembly of everything below), client-registry (attach / drop / grace /
// sweep), call-lanes (fair schedulers), call-route (idempotent /call) and
// routes (the HTTP front door).
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLoopbackListener } from '../runtime/shared/loopback-listener.mjs';
import { createTransportStack } from './session-transport/stack.mjs';

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
  const { registry, clients, lanes, callCache, broadcast, handleRequest } = createTransportStack({
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
