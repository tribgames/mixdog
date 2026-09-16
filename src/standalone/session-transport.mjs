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
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { sendJson, sendError } from '../runtime/memory/lib/http-wire.mjs';
import { isPidAlive, parsePid } from '../runtime/shared/pid-liveness.mjs';
import {
  compareRuntimeVersions,
  SESSION_CAPABILITY_FINGERPRINT,
  SESSION_PROTOCOL,
  SESSION_REVISION,
  runtimeVersion,
} from './session-wire.mjs';
import { createFairCallScheduler } from './fair-call-scheduler.mjs';
import { callSignature, callIdConflict, clientCallOwner } from './rpc-call-identity.mjs';
import { createSessionFrameStream } from './session-frame-stream.mjs';
import { readJsonRequestBody } from '../runtime/shared/http-request-body.mjs';
import { createLoopbackListener } from '../runtime/shared/loopback-listener.mjs';
import { createSessionCallCache } from './session-call-cache.mjs';

// A loopback front door still buffers whatever a client sends before it can be
// parsed, so the body has an explicit ceiling instead of the client's memory.
const MAX_BODY_BYTES = Math.max(1, Number(process.env.MIXDOG_SESSION_MAX_BODY_MB) || 32) * 1024 * 1024;

const SSE_PENDING_MAX_BYTES = Math.max(
  256 * 1024,
  (Number(process.env.MIXDOG_SESSION_SSE_PENDING_MB) || 8) * 1024 * 1024
);

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

  // token -> { token, leadPid, cwd, lifecycle, sse, pending, lastSeen }
  const clients = new Map();
  let boundPort = null;
  let listener = null;
  let stopPromise = null;
  let graceTimer = null;
  let sweepTimer = null;
  let everHadLifecycleClient = false;
  let closed = false;
  let drainingReason = '';
  let drainCommitted = false;
  const BODY_INFLIGHT_MAX_BYTES = Math.max(
    MAX_BODY_BYTES,
    (Number(process.env.MIXDOG_SESSION_BODY_INFLIGHT_MB) || 64) * 1024 * 1024
  );
  let bodyBytesInFlight = 0;
  const readBody = (req) =>
    readJsonRequestBody(req, {
      maxBytes: MAX_BODY_BYTES,
      tooLargeMessage: 'request body too large',
      destroyOnLimit: true,
      reserve(bytes) {
        if (bodyBytesInFlight + bytes > BODY_INFLIGHT_MAX_BYTES) return false;
        bodyBytesInFlight += bytes;
        return true;
      },
      release(bytes) {
        bodyBytesInFlight = Math.max(0, bodyBytesInFlight - bytes);
      },
    });
  // Idempotency cache: a transport retry of the SAME callId must never run a
  // second session mutation (submit/abort are not idempotent).
  // These routes are safe to replay and can return large snapshots. Keeping
  // them in the mutation-dedup cache retained multiple transcript copies for
  // a full minute under review polling and pane reconciliation.
  const REPLAY_SAFE_CALLS = new Set([
    'project.list',
    'project.inspect',
    'session.list',
    'session.read',
    'session.subscribe',
    'session.unsubscribe',
  ]);
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
  const callCache = createSessionCallCache({
    ttlMs: CALL_CACHE_TTL_MS,
    maxEntries: CALL_CACHE_MAX,
    maxBytes: CALL_CACHE_MAX_BYTES,
    now: nowMs,
    log,
  });
  // A burst of panes used to enqueue every handleCall() as a microtask. Node
  // drains the whole microtask queue before returning to HTTP, so enough cheap
  // calls could starve /health and /client/register even though no explicit
  // mutex existed. Admit one call per event-loop turn while allowing admitted
  // async calls to overlap; control-plane routes never enter this queue.
  // No default concurrency gate: independent session work starts in parallel.
  // The scheduler still launches one item per check phase so synchronous setup
  // cannot monopolize the HTTP/control-plane turn. Operators may explicitly
  // set finite lane limits for constrained hosts.
  const configuredLaneLimit = (name) => {
    const parsed = Math.floor(Number(process.env[name]));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : Infinity;
  };
  const CALL_QUEUE_MAX = Math.max(1024, Number(process.env.MIXDOG_SESSION_CALL_QUEUE) || 1024);
  const CRITICAL_CALLS = new Set([
    'session.abort',
    'session.approve',
    'session.unsubscribe',
    'desktop.control',
    'desktop.ready',
    'desktop.unsubscribe',
  ]);
  const INTERACTIVE_CALLS = new Set([
    'session.create',
    'session.read',
    'session.subscribe',
    'session.submit',
    'session.configure',
    'project.list',
    'project.inspect',
    'project.add',
    'project.touch',
    'project.rename',
    'project.remove',
    'project.ensureDirectory',
    'desktop.init',
  ]);
  const INTERACTIVE_DESKTOP_METHODS = new Set(['termEnsure', 'termWrite', 'termResize', 'termDispose', 'termProfiles']);
  const normalCalls = createFairCallScheduler({
    name: 'session service call',
    activeMax: configuredLaneLimit('MIXDOG_SESSION_ACTIVE_CALLS'),
    queueMax: CALL_QUEUE_MAX,
    minOwnerQueue: Math.max(8, Math.floor(CALL_QUEUE_MAX / 16)),
    dispatchBurst: 1,
    yieldUnbounded: true,
  });
  const criticalCalls = createFairCallScheduler({
    name: 'session service critical call',
    activeMax: configuredLaneLimit('MIXDOG_SESSION_URGENT_RESERVE'),
    queueMax: Math.max(32, Math.min(256, CALL_QUEUE_MAX)),
    minOwnerQueue: 8,
  });
  const interactiveCalls = createFairCallScheduler({
    name: 'session service interactive call',
    activeMax: configuredLaneLimit('MIXDOG_SESSION_INTERACTIVE_RESERVE'),
    queueMax: Math.max(64, Math.min(512, CALL_QUEUE_MAX)),
    minOwnerQueue: 8,
    dispatchBurst: 1,
    yieldUnbounded: true,
  });
  // A timed-out registration may already have committed server-side. Replaying
  // the same registrationId returns that token instead of leaking a second
  // client record and another lifecycle reference.
  const registrationReplays = new Map();
  const REGISTRATION_REPLAY_TTL_MS = 30_000;
  const REGISTRATION_REPLAY_MAX = 256;

  function callLane(name, args = {}) {
    if (CRITICAL_CALLS.has(name)) return 'critical';
    if (INTERACTIVE_CALLS.has(name)) return 'interactive';
    if (name === 'desktop.invoke') {
      const adapterMethod = String(args?.method || '');
      const desktopMethod = adapterMethod === 'invokeDesktopOperation' ? String(args?.args?.[0] || '') : adapterMethod;
      if (INTERACTIVE_DESKTOP_METHODS.has(desktopMethod)) return 'interactive';
    }
    return 'normal';
  }

  function dispatchCall(ownerKey, run, { lane = 'normal', signal = null } = {}) {
    const scheduler = lane === 'critical' ? criticalCalls : lane === 'interactive' ? interactiveCalls : normalCalls;
    return scheduler.enqueue(ownerKey, run, { signal });
  }

  function nowMs() {
    return Date.now();
  }

  function lifecycleClientCount() {
    let count = 0;
    for (const client of clients.values()) {
      if (client.lifecycle) count += 1;
    }
    return count;
  }

  function cancelGrace() {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  function maybeArmGrace(reason) {
    if (closed || !everHadLifecycleClient || typeof onClientsEmpty !== 'function') return;
    if (lifecycleClientCount() > 0) return;
    // Never re-arm an ALREADY armed grace: the 5s sweep also calls this, and
    // cancel+rearm on every tick pushed the 10s deadline out forever — the
    // daemon could never self-shut down through the session front door.
    if (graceTimer) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (closed || lifecycleClientCount() > 0) return;
      log(`no clients remain (${reason}) — signalling shutdown`);
      try {
        onClientsEmpty();
      } catch {}
    }, clientGraceMs);
    graceTimer.unref?.();
  }

  function removeClientRecord(token) {
    const c = clients.get(token);
    if (!c) return;
    try {
      c.sse?.end?.();
    } catch {}
    clients.delete(token);
    for (const [registrationId, replay] of registrationReplays) {
      if (replay.token === token) {
        clearTimeout(replay.timer);
        registrationReplays.delete(registrationId);
      }
    }
  }

  function dropClient(token, reason) {
    if (!clients.has(token)) return;
    removeClientRecord(token);
    // The session runtime pool refcounts VIEWS by client token: a client that is gone
    // must stop holding session runtimes open (and must stop being counted as the
    // reason another client's session runtime survives).
    if (typeof onClientDropped === 'function') {
      try {
        onClientDropped(token, reason);
      } catch {}
    }
    log(`client dropped token=${token} (${reason})`);
    maybeArmGrace(reason);
  }

  function beginDrain(reason = 'daemon replacement') {
    if (drainingReason) return false;
    drainingReason = String(reason || 'daemon replacement');
    cancelGrace();
    return true;
  }

  function commitDrain(reason = 'daemon replacement') {
    if (!drainingReason) beginDrain(reason);
    if (drainCommitted) return false;
    drainCommitted = true;
    cancelGrace();
    return true;
  }

  function startSweep() {
    if (sweepTimer || closed) return;
    sweepTimer = setInterval(() => {
      for (const [token, c] of [...clients]) {
        // A client whose owning process died can never read its stream again.
        if (c.leadPid && !isPidAlive(c.leadPid)) dropClient(token, 'lead pid gone');
      }
      maybeArmGrace('sweep');
    }, sweepMs);
    sweepTimer.unref?.();
  }

  function registerClient({
    leadPid,
    cwd,
    lifecycle = true,
    clientKind = 'session',
    registrationId = null,
    revision = 0,
  } = {}) {
    const pid = parsePid(leadPid) || 0;
    const ownsLifecycle = lifecycle !== false;
    const kind = clientKind === 'desktop' ? 'desktop' : 'session';
    const replayId = registrationId ? String(registrationId).slice(0, 200) : null;
    const replay = replayId ? registrationReplays.get(replayId) : null;
    if (replay) {
      const sameIdentity =
        replay.leadPid === pid &&
        replay.cwd === (cwd || null) &&
        replay.lifecycle === ownsLifecycle &&
        replay.clientKind === kind &&
        replay.revision === Math.max(0, Number(revision) || 0);
      if (sameIdentity && clients.has(replay.token)) {
        log(`client registration replay token=${replay.token} lead=${pid}`);
        return replay.token;
      }
      if (clients.has(replay.token)) {
        const error = new Error('registration replay identity mismatch');
        error.statusCode = 409;
        throw error;
      }
      clearTimeout(replay.timer);
      registrationReplays.delete(replayId);
    }
    const token = randomUUID();
    clients.set(token, {
      token,
      leadPid: pid,
      cwd: cwd || null,
      lifecycle: ownsLifecycle,
      clientKind: kind,
      revision: Math.max(0, Number(revision) || 0),
      sse: null,
      // True while the socket asked us to stop writing (see writeFrame).
      paused: false,
      // Frames are latest-wins per key while a client has no stream: a
      // reconnecting viewer wants the CURRENT snapshot, never a backlog.
      pending: new Map(),
      pendingBytes: 0,
      lastSeen: nowMs(),
    });
    if (ownsLifecycle) {
      everHadLifecycleClient = true;
      cancelGrace();
    }
    startSweep();
    log(`client registered token=${token} lead=${pid} cwd=${cwd || '-'}` + ` lifecycle=${ownsLifecycle} kind=${kind}`);
    if (typeof onClientRegistered === 'function') {
      try {
        onClientRegistered({
          token,
          leadPid: pid,
          cwd: cwd || null,
          lifecycle: ownsLifecycle,
          clientKind: kind,
        });
      } catch {}
    }
    if (replayId) {
      while (registrationReplays.size >= REGISTRATION_REPLAY_MAX) {
        const oldest = registrationReplays.keys().next();
        if (oldest.done) break;
        const prior = registrationReplays.get(oldest.value);
        clearTimeout(prior?.timer);
        registrationReplays.delete(oldest.value);
      }
      const timer = setTimeout(() => registrationReplays.delete(replayId), REGISTRATION_REPLAY_TTL_MS);
      timer.unref?.();
      registrationReplays.set(replayId, {
        token,
        leadPid: pid,
        cwd: cwd || null,
        lifecycle: ownsLifecycle,
        clientKind: kind,
        revision: Math.max(0, Number(revision) || 0),
        timer,
      });
    }
    return token;
  }

  const { broadcast, attachSse } = createSessionFrameStream({
    clients,
    maxPendingBytes: SSE_PENDING_MAX_BYTES,
    nowMs,
    onDiagnostic: (entry) => log(`transcript-stream ${JSON.stringify(entry)}`),
    onAttached(token) {
      // The stream proves receipt of its token, ending registration replay.
      for (const [registrationId, replay] of registrationReplays) {
        if (replay.token === token) {
          clearTimeout(replay.timer);
          registrationReplays.delete(registrationId);
        }
      }
    },
    // Stream loss alone does not remove a client or its live session.
    onClosed: () => maybeArmGrace('sse closed'),
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathName = url.pathname;
    try {
      if (req.method === 'GET' && pathName === '/health') {
        // Identity travels with EVERY health probe: a view negotiates version
        // skew before it attaches, so an embedder can never forget to publish
        // it and leave clients guessing.
        sendJson(res, {
          status: 'ok',
          pid: process.pid,
          clients: lifecycleClientCount(),
          connections: clients.size,
          protocol: SESSION_PROTOCOL,
          revision: SESSION_REVISION,
          capabilityFingerprint: SESSION_CAPABILITY_FINGERPRINT,
          draining: drainingReason || null,
          drainCommitted,
          version: runtimeVersion(),
          ...getStatus(),
          activeCalls: normalCalls.active + interactiveCalls.active + criticalCalls.active,
          queuedCalls: normalCalls.queued + interactiveCalls.queued + criticalCalls.queued,
          queuedUrgentCalls: criticalCalls.queued,
          queuedInteractiveCalls: interactiveCalls.queued,
          callOwners: normalCalls.snapshot().owners,
          callQueues: {
            critical: criticalCalls.snapshot(),
            interactive: interactiveCalls.snapshot(),
            normal: normalCalls.snapshot(),
          },
          transportMemory: {
            bodyBytesInFlight,
            bodyBytesMax: BODY_INFLIGHT_MAX_BYTES,
            callCacheEntries: callCache.size,
            callCacheBytes: callCache.bytes,
            callCacheMaxBytes: CALL_CACHE_MAX_BYTES,
            ssePendingBytes: [...clients.values()].reduce((sum, client) => sum + (client.pendingBytes || 0), 0),
          },
        });
        return;
      }
      const token = req.headers['x-mixdog-daemon-token'];
      if (token !== serverToken) {
        sendError(res, 'forbidden', 403);
        return;
      }

      if (req.method === 'POST' && pathName === '/client/register') {
        const body = await readBody(req);
        if (drainCommitted) {
          sendError(res, `daemon is draining: ${drainingReason}`, 503);
          return;
        }
        const clientProtocol = Number(body.protocol);
        if (clientProtocol !== SESSION_PROTOCOL) {
          sendError(res, `session protocol ${SESSION_PROTOCOL} required`, 409);
          return;
        }
        const clientToken = registerClient({
          leadPid: body.leadPid,
          cwd: body.cwd,
          lifecycle: body.lifecycle !== false,
          clientKind: body.clientKind,
          registrationId: body.registrationId,
          revision: body.revision,
        });
        sendJson(res, {
          token: clientToken,
          pid: process.pid,
          protocol: SESSION_PROTOCOL,
          revision: SESSION_REVISION,
        });
        return;
      }
      if (req.method === 'POST' && pathName === '/client/deregister') {
        const body = await readBody(req);
        if (body.token) dropClient(String(body.token), 'deregister');
        sendJson(res, { ok: true });
        return;
      }
      if (req.method === 'GET' && pathName === '/events') {
        const clientToken = url.searchParams.get('token');
        if (!attachSse(clientToken, res)) {
          sendError(res, 'unknown client token', 404);
          return;
        }
        return; // stream stays open
      }
      if (req.method === 'POST' && pathName === '/call') {
        if (drainCommitted) {
          sendError(res, `daemon is draining: ${drainingReason}`, 503);
          return;
        }
        const body = await readBody(req);
        const clientToken = body.token ? String(body.token) : null;
        const c = clientToken ? clients.get(clientToken) : null;
        if (!c) {
          sendError(res, 'unknown client token', 404);
          return;
        }
        c.lastSeen = nowMs();
        const name = String(body.name || '');
        const callId = body.callId ? String(body.callId) : null;
        const addressedSessionId = String(body.args?.sessionId || '').trim();
        const ownerKey = addressedSessionId
          ? `session:${addressedSessionId}`
          : c.leadPid
            ? `pid:${c.leadPid}`
            : `client:${clientToken}`;
        // Scheduling fairness follows the addressed session, but idempotency
        // belongs to the CALLING PROCESS. Two clients legitimately issuing the
        // same callId against one shared session must not dedupe each other.
        const cacheOwnerKey = clientCallOwner(c, clientToken);
        const cacheKey = callId && !REPLAY_SAFE_CALLS.has(name) ? `${cacheOwnerKey}\u0000${callId}` : null;
        // A retry is the SAME payload under the same id. A different payload
        // that reuses an id (submission ids are caller-supplied) is a NEW call
        // and must never be answered out of another call's result.
        const signature = callId ? callSignature(name, body.args) : null;
        const cached = cacheKey ? callCache.get(cacheKey) : null;
        let dispatch;
        if (cached) {
          if (cached.resultDropped) {
            // The identity survived memory pressure but its result did not.
            // Fail closed: re-running a settled mutation is never correct.
            dispatch = Promise.reject(
              Object.assign(new Error(`callId '${callId}' already ran; its result is no longer retained`), {
                code: 'ECALLRESULTDROPPED',
              })
            );
          } else if (!signature || cached.signature !== signature) {
            // callId is an idempotency key, not a caller-selected overwrite
            // slot. Fail closed while the original keeps its cache identity;
            // dispatching here could execute two side-effecting mutations.
            dispatch = Promise.reject(callIdConflict(callId));
          } else {
            dispatch = cached.promise;
          }
        } else {
          dispatch = dispatchCall(
            ownerKey,
            () =>
              handleCall(name, body.args || {}, {
                clientToken,
                leadPid: c.leadPid ?? null,
                cwd: c.cwd ?? null,
                revision: c.revision ?? 0,
              }),
            { lane: callLane(name, body.args || {}) }
          );
          if (cacheKey) {
            callCache.track(cacheKey, dispatch, signature);
          }
        }
        try {
          const result = await dispatch;
          sendJson(res, { result });
        } catch (err) {
          // Session call errors travel as a 200 {error} envelope so the client can
          // tell a failed CALL from a dead TRANSPORT (which must re-attach). The
          // machine-readable `code` (ECALLIDCONFLICT / ECALLRESULTDROPPED) travels
          // with it: a client must be able to branch on it, not parse prose.
          sendJson(
            res,
            {
              error: err?.message || String(err),
              ...(err?.code ? { code: String(err.code) } : {}),
            },
            200
          );
        }
        return;
      }
      if (req.method === 'POST' && pathName === '/shutdown') {
        sendJson(res, { ok: true });
        if (typeof onClientsEmpty === 'function') {
          try {
            onClientsEmpty();
          } catch {}
        }
        return;
      }
      if (req.method === 'POST' && pathName === '/upgrade') {
        const body = await readBody(req);
        const requestedProtocol = Number(body.protocol);
        const requestedRevision = Math.max(0, Number(body.revision) || 0);
        const requestedVersion = String(body.version || '0.0.0');
        const revisionOrder = requestedRevision - SESSION_REVISION;
        const versionOrder = compareRuntimeVersions(requestedVersion, runtimeVersion());
        const newerBuild =
          requestedProtocol === SESSION_PROTOCOL && (revisionOrder > 0 || (revisionOrder === 0 && versionOrder > 0));
        if (!newerBuild) {
          sendError(
            res,
            `replacement must use protocol ${SESSION_PROTOCOL} with a revision/build newer than ${SESSION_REVISION}/${runtimeVersion()}`,
            409
          );
          return;
        }
        sendJson(res, {
          accepted: true,
          protocol: SESSION_PROTOCOL,
          currentRevision: SESSION_REVISION,
          currentVersion: runtimeVersion(),
          requestedRevision,
          requestedVersion,
        });
        queueMicrotask(() => {
          try {
            onUpgradeRequested?.({
              protocol: SESSION_PROTOCOL,
              revision: requestedRevision,
              version: requestedVersion,
            });
          } catch {}
        });
        return;
      }
      sendError(res, 'not found', 404);
    } catch (err) {
      try {
        sendError(res, err?.message || String(err), err?.statusCode || 500);
      } catch {}
    }
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
      cancelGrace();
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      normalCalls.close('session service transport is closed');
      interactiveCalls.close('session service transport is closed');
      criticalCalls.close('session service transport is closed');
      callCache.close();
      for (const replay of registrationReplays.values()) clearTimeout(replay.timer);
      registrationReplays.clear();
      for (const token of [...clients.keys()]) removeClientRecord(token);
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
      return lifecycleClientCount();
    },
    get connectionCount() {
      return clients.size;
    },
    get activeCount() {
      return normalCalls.active + interactiveCalls.active + criticalCalls.active;
    },
    get queuedCount() {
      return normalCalls.queued + interactiveCalls.queued + criticalCalls.queued;
    },
    get draining() {
      return Boolean(drainingReason);
    },
    get drainCommitted() {
      return drainCommitted;
    },
  };
}
