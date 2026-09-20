// Machine-global channel front door — HTTP + SSE transport (server side).
//
// Replaces the per-TUI fork + node-IPC (`{type:'call'|'notify'}`) plumbing with
// ONE local HTTP server that many TUIs attach to. Design mirrors the memory
// daemon (src/runtime/memory/index.mjs): 127.0.0.1-only, /client/register +
// /health + client-grace self-shutdown. It adds an SSE fan-out for the
// worker->parent notify path so notifications reach the CORRECT attached TUI
// (targeted routing, never broadcast — see channel-transport/remote-notify.mjs).
//
// This module owns ONLY the transport (sockets, client registry, notify
// routing and lifecycle). The channels runtime (tool dispatch,
// Discord provider, transcript bind/steal) is injected via `handleCall` so the
// same transport is exercised by the real daemon entry AND the smoke harness
// (stub runtime, no Discord token).
//
// Composition root: the shared transport state below is read and written by
// the sub-services in channel-transport/ (remote binding, client registry,
// notify routing, call dispatch, HTTP routes); this file owns the listener
// lifecycle, draining and the public surface.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLoopbackListener } from '../runtime/shared/loopback-listener.mjs';
import { readRemoteIntent } from './channel-binding.mjs';
import { createRemoteBinding } from './channel-transport/remote-binding.mjs';
import { createClientRegistry } from './channel-transport/client-registry.mjs';
import { createRemoteNotify } from './channel-transport/remote-notify.mjs';
import { createCallDispatch } from './channel-transport/call-dispatch.mjs';
import { createChannelRoutes } from './channel-transport/http-routes.mjs';

export function createChannelTransport({
  handleCall,
  serverToken = randomUUID(),
  log = () => {},
  clientGraceMs = 10_000,
  sweepMs = 5_000,
  onClientsEmpty = null,
  getStatus = () => ({}),
  registrationReplayTtlMs = 60_000,
  remoteStatePath = null,
  remoteIntentPath = null,
  onClientRegistered = null,
  onRemoteStateChange = null,
  agentBroker = null,
} = {}) {
  if (typeof handleCall !== 'function') throw new Error('handleCall is required');

  const remoteIntent = readRemoteIntent(remoteIntentPath);
  const state = {
    // token -> { token, leadPid, cwd, sse, lastSeen, registeredAt }
    clients: new Map(),
    // registrationId -> { token, leadPid, cwd, replaceToken, responseFinished }
    registrationReplays: new Map(),
    // UI control pointer only. The durable session pin, not this client token,
    // is the channel routing authority.
    pointerToken: null,
    stickyRemoteFrame: null,
    remoteAcquired: false,
    remoteIntent,
    pinnedSessionId: remoteIntent?.sessionId ?? null,
    everHadClient: false,
    closed: false,
    drainingReason: '',
    drainCommitted: false,
  };
  let listener = null;
  let stopPromise = null;
  let boundPort = null;

  const binding = createRemoteBinding({
    state,
    handleCall,
    log,
    remoteStatePath,
    remoteIntentPath,
    onRemoteStateChange,
  });
  const registry = createClientRegistry({
    state,
    log,
    clientGraceMs,
    sweepMs,
    onClientsEmpty,
    onClientRegistered,
    registrationReplayTtlMs,
    publishRemoteState: binding.publishRemoteState,
  });
  const remote = createRemoteNotify({
    state,
    log,
    clearRemoteIntent: binding.clearRemoteIntent,
    publishRemoteState: binding.publishRemoteState,
    resolveTarget: registry.resolveTarget,
    liveClients: registry.liveClients,
  });
  const dispatch = createCallDispatch({
    state,
    handleCall,
    log,
    runExclusiveBinding: binding.runExclusiveBinding,
    movePointer: remote.movePointer,
    writeRemoteStateTo: remote.writeRemoteStateTo,
    clearRemoteIntent: binding.clearRemoteIntent,
    writeRemoteIntent: binding.writeRemoteIntent,
    publishRemoteState: binding.publishRemoteState,
  });
  const handleRequest = createChannelRoutes({
    state,
    serverToken,
    getStatus,
    agentBroker,
    onClientsEmpty,
    registry,
    dispatch,
  });

  function beginDrain(reason = 'daemon replacement') {
    if (state.drainingReason) return false;
    state.drainingReason = String(reason || 'daemon replacement');
    registry.cancelGrace();
    return true;
  }

  function commitDrain(reason = 'daemon replacement') {
    if (!state.drainingReason) beginDrain(reason);
    if (state.drainCommitted) return false;
    state.drainCommitted = true;
    registry.cancelGrace();
    return true;
  }

  function start() {
    if (state.closed) return Promise.reject(new Error('channel transport is closed'));
    listener ??= createLoopbackListener({
      server: http.createServer(handleRequest),
      onListening(port) {
        boundPort = port;
        binding.publishRemoteState();
        log(`daemon transport listening on 127.0.0.1:${boundPort} pid=${process.pid}`);
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
    state.closed = true;
    try {
      dispatch.close('channel transport is closed');
      registry.stopTimers();
      for (const [token] of state.clients) registry.dropClient(token, 'transport stop');
      state.remoteAcquired = false;
      state.pointerToken = null;
      binding.publishRemoteState();
      registry.clearRegistrationReplays();
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
    notify: remote.notify,
    restoreRemoteIntent: binding.restoreRemoteIntent,
    beginDrain,
    commitDrain,
    get port() {
      return boundPort;
    },
    get token() {
      return serverToken;
    },
    // The unified daemon hosts channels AND session runtimes: it may only
    // self-shutdown when BOTH sides are empty, so each transport has to expose
    // its liveness.
    get clientCount() {
      return state.clients.size;
    },
    get activeCount() {
      return dispatch.active;
    },
    get queuedCount() {
      return dispatch.queued;
    },
    get draining() {
      return Boolean(state.drainingReason);
    },
    get drainCommitted() {
      return state.drainCommitted;
    },
    get remoteIntentSessionId() {
      return String(state.pinnedSessionId || '').trim() || null;
    },
    get remoteSessionId() {
      return String(state.remoteAcquired ? state.pinnedSessionId : '').trim() || null;
    },
    _clientsForTest: state.clients,
    _registrationReplaysForTest: state.registrationReplays,
    _resolveTargetForTest: registry.resolveTarget,
    _writeRemoteStateToForTest: remote.writeRemoteStateTo,
    get _pointerTokenForTest() {
      return state.pointerToken;
    },
    get _remoteIntentForTest() {
      return state.remoteIntent;
    },
  };
}
