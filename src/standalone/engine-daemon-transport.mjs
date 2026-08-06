// Machine-global ENGINE daemon — HTTP + SSE transport (server side).
//
// Sibling of channel-daemon-transport.mjs, deliberately separate: the channels
// transport routes notifies to ONE pointer client (remote ownership), while
// engine frames are shared state — every attached client (terminal TUI and the
// desktop app at the same time) must observe the same snapshot stream. Mixing
// the two routing rules into one server would put the pointer semantics on a
// path that must never target a single client.
//
// This module owns ONLY the transport (sockets, client registry, frame fan-out,
// discovery file, lifecycle). The engine pool is injected via `handleCall`, so
// the same transport is exercised by the real daemon entry AND by the smoke
// harness with a stub engine factory (no provider, no model download).
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { writeJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';
import { sendJson, sendError } from '../runtime/memory/lib/http-wire.mjs';
import { ENGINE_DAEMON_PROTOCOL, engineRuntimeVersion } from './engine-daemon-protocol.mjs';

// A loopback front door still buffers whatever a client sends before it can be
// parsed, so the body has an explicit ceiling instead of the client's memory.
const MAX_BODY_BYTES = Math.max(1, Number(process.env.MIXDOG_ENGINE_DAEMON_MAX_BODY_MB) || 64)
  * 1024 * 1024;

function readLimitedBody(req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message, statusCode) => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.statusCode = statusCode;
      try { req.destroy(); } catch {}
      reject(error);
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      fail('request body too large', 413);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { fail('request body too large', 413); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (error) {
        const err = new Error(`invalid JSON body: ${error.message}`);
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
  });
}

/** Identity of a call's PAYLOAD. A retry repeats it exactly; a caller-supplied
 *  submission id that happens to be reused carries a different one. */
function callSignature(name, args) {
  try {
    return createHash('sha1').update(`${name}\u0000${JSON.stringify(args ?? {})}`).digest('hex');
  } catch { return null; }
}

function parsePid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isPidAlive(pid) {
  const n = parsePid(pid);
  if (!n) return false;
  try { process.kill(n, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

// A stalled reader collapses the backlog to one frame per key. That is right
// for SNAPSHOTS (the newest state is the whole truth) and wrong for a BYTE
// STREAM: dropping PTY output leaves a terminal permanently corrupted. Same-key
// terminal frames therefore concatenate, bounded so a wedged reader can never
// grow the daemon's heap without limit.
const TERMINAL_BACKLOG_MAX_CHARS = 256 * 1024;

function terminalDataFrame(frame) {
  return frame?.type === 'desktop-event'
    && frame.message?.kind === 'backend-event'
    && frame.message?.name === 'terminal-data'
    && typeof frame.message?.value?.data === 'string'
    ? frame
    : null;
}

function mergePendingFrame(existing, frame, json) {
  const previous = existing ? terminalDataFrame(existing.frame) : null;
  const next = terminalDataFrame(frame);
  if (!previous || !next) return { frame, json };
  const joined = `${previous.message.value.data}${next.message.value.data}`;
  const data = joined.length > TERMINAL_BACKLOG_MAX_CHARS
    ? joined.slice(joined.length - TERMINAL_BACKLOG_MAX_CHARS)
    : joined;
  const merged = {
    ...next,
    message: { ...next.message, value: { ...next.message.value, data } },
  };
  return { frame: merged, json: JSON.stringify(merged) };
}

export function createEngineDaemonTransport({
  handleCall,
  discoveryPath,
  serverToken = randomUUID(),
  log = () => {},
  clientGraceMs = 10_000,
  sweepMs = 5_000,
  onClientsEmpty = null,
  onClientRegistered = null,
  onClientDropped = null,
  getStatus = () => ({}),
} = {}) {
  if (typeof handleCall !== 'function') throw new Error('handleCall is required');

  // token -> { token, leadPid, cwd, lifecycle, sse, pending, lastSeen }
  const clients = new Map();
  let boundPort = null;
  let server = null;
  let graceTimer = null;
  let sweepTimer = null;
  let everHadLifecycleClient = false;
  let closed = false;
  // Idempotency cache: a transport retry of the SAME callId must never run a
  // second engine mutation (submit/abort are not idempotent).
  const callCache = new Map();
  const CALL_CACHE_TTL_MS = 60_000;
  // Bound the dedup table: a call that never settles would otherwise pin its
  // entry for the daemon's whole life.
  const CALL_CACHE_MAX = Math.max(512, Number(process.env.MIXDOG_ENGINE_DAEMON_CALL_CACHE) || 4096);
  // A burst of panes used to enqueue every handleCall() as a microtask. Node
  // drains the whole microtask queue before returning to HTTP, so enough cheap
  // calls could starve /health and /client/register even though no explicit
  // mutex existed. Admit one call per event-loop turn while allowing admitted
  // async calls to overlap; control-plane routes never enter this queue.
  const CALL_ACTIVE_MAX = Math.max(8, Number(process.env.MIXDOG_ENGINE_DAEMON_ACTIVE_CALLS) || 64);
  const CALL_QUEUE_MAX = Math.max(CALL_ACTIVE_MAX, Number(process.env.MIXDOG_ENGINE_DAEMON_CALL_QUEUE) || 1024);
  const callQueue = [];
  let activeCalls = 0;
  let callDispatchScheduled = false;
  // A timed-out registration may already have committed server-side. Replaying
  // the same registrationId returns that token instead of leaking a second
  // client record and another lifecycle reference.
  const registrationReplays = new Map();
  const REGISTRATION_REPLAY_TTL_MS = 30_000;
  const REGISTRATION_REPLAY_MAX = 256;

  function pruneCallCache() {
    while (callCache.size > CALL_CACHE_MAX) {
      const oldest = callCache.keys().next();
      if (oldest.done) return;
      callCache.delete(oldest.value);
    }
  }

  function scheduleCallDispatch() {
    if (closed || callDispatchScheduled || activeCalls >= CALL_ACTIVE_MAX || callQueue.length === 0) return;
    callDispatchScheduled = true;
    setImmediate(() => {
      callDispatchScheduled = false;
      if (closed) {
        const error = new Error('engine daemon transport is closed');
        error.statusCode = 503;
        for (const queued of callQueue.splice(0)) queued.reject(error);
        return;
      }
      if (activeCalls >= CALL_ACTIVE_MAX) return;
      const queued = callQueue.shift();
      if (!queued) return;
      activeCalls += 1;
      Promise.resolve()
        .then(queued.run)
        .then(queued.resolve, queued.reject)
        .finally(() => {
          activeCalls = Math.max(0, activeCalls - 1);
          scheduleCallDispatch();
        });
      // Start at most ONE handler in this check phase. A fresh immediate gives
      // socket I/O (especially health/register) a poll phase between starts.
      scheduleCallDispatch();
    });
  }

  function dispatchCall(run) {
    if (closed) {
      const error = new Error('engine daemon transport is closed');
      error.statusCode = 503;
      return Promise.reject(error);
    }
    if (callQueue.length >= CALL_QUEUE_MAX) {
      const error = new Error('engine daemon call queue is full');
      error.statusCode = 503;
      return Promise.reject(error);
    }
    const promise = new Promise((resolve, reject) => {
      callQueue.push({ run, resolve, reject });
    });
    scheduleCallDispatch();
    return promise;
  }

  function nowMs() { return Date.now(); }

  function lifecycleClientCount() {
    let count = 0;
    for (const client of clients.values()) {
      if (client.lifecycle) count += 1;
    }
    return count;
  }

  function cancelGrace() {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  }

  function maybeArmGrace(reason) {
    if (closed || !everHadLifecycleClient || typeof onClientsEmpty !== 'function') return;
    if (lifecycleClientCount() > 0) return;
    // Never re-arm an ALREADY armed grace: the 5s sweep also calls this, and
    // cancel+rearm on every tick pushed the 10s deadline out forever — the
    // daemon could never self-shut down through the engine front door.
    if (graceTimer) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (closed || lifecycleClientCount() > 0) return;
      log(`no clients remain (${reason}) — signalling shutdown`);
      try { onClientsEmpty(); } catch {}
    }, clientGraceMs);
    graceTimer.unref?.();
  }

  function removeClientRecord(token) {
    const c = clients.get(token);
    if (!c) return;
    try { c.sse?.end?.(); } catch {}
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
    // The engine pool refcounts VIEWS by client token: a client that is gone
    // must stop holding engines open (and must stop being counted as the
    // reason another client's engine survives).
    if (typeof onClientDropped === 'function') {
      try { onClientDropped(token, reason); } catch {}
    }
    log(`client dropped token=${token} (${reason})`);
    maybeArmGrace(reason);
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

  function registerClient({ leadPid, cwd, lifecycle = true, registrationId = null } = {}) {
    const pid = parsePid(leadPid) || 0;
    const ownsLifecycle = lifecycle !== false;
    const replayId = registrationId ? String(registrationId).slice(0, 200) : null;
    const replay = replayId ? registrationReplays.get(replayId) : null;
    if (replay) {
      const sameIdentity = replay.leadPid === pid
        && replay.cwd === (cwd || null)
        && replay.lifecycle === ownsLifecycle;
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
      sse: null,
      // True while the socket asked us to stop writing (see writeFrame).
      paused: false,
      // Frames are latest-wins per key while a client has no stream: a
      // reconnecting viewer wants the CURRENT snapshot, never a backlog.
      pending: new Map(),
      lastSeen: nowMs(),
    });
    if (ownsLifecycle) {
      everHadLifecycleClient = true;
      cancelGrace();
    }
    startSweep();
    log(`client registered token=${token} lead=${pid} cwd=${cwd || '-'} lifecycle=${ownsLifecycle}`);
    if (typeof onClientRegistered === 'function') {
      try { onClientRegistered({ token, leadPid: pid, cwd: cwd || null, lifecycle: ownsLifecycle }); } catch {}
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
        timer,
      });
    }
    return token;
  }

  /** Drain the latest-wins backlog into a stream that reported room again. */
  function flushPending(client) {
    while (client.sse && !client.paused && client.pending.size > 0) {
      const [key, entry] = client.pending.entries().next().value;
      client.pending.delete(key);
      try {
        if (client.sse.write(`data: ${entry.json}\n\n`) === false) client.paused = true;
      } catch {
        client.sse = null;
        client.pending.set(key, entry);
        return;
      }
    }
  }

  function writeFrame(client, frame, json) {
    const key = frame.key || `${frame.type}:${frame.sessionId || frame.desktopId || ''}`;
    // A stalled reader must never make the daemon buffer a whole stream in
    // Node's socket queue: while the socket is full the backlog collapses to
    // one frame per key, exactly like a client with no stream at all.
    if (!client.sse || client.paused) {
      client.pending.set(key, mergePendingFrame(client.pending.get(key), frame, json));
      return;
    }
    try {
      if (client.sse.write(`data: ${json}\n\n`) === false) client.paused = true;
    } catch {
      client.sse = null;
      client.pending.set(key, mergePendingFrame(client.pending.get(key), frame, json));
    }
  }

  /** Session and desktop state reaches only subscribed client tokens. Calls
   *  without a target set retain the transport-level broadcast used by
   *  diagnostics and compatibility tests. */
  function broadcast(frame, targetTokens = null) {
    const json = JSON.stringify(frame);
    if (targetTokens) {
      for (const token of targetTokens) {
        const client = clients.get(String(token || ''));
        if (client) writeFrame(client, frame, json);
      }
      return;
    }
    for (const client of clients.values()) writeFrame(client, frame, json);
  }

  function attachSse(token, res) {
    const c = clients.get(token);
    if (!c) return false;
    // Interactive lane: PTY output and keystroke echoes are small writes, and
    // Nagle on a loopback socket adds a full delayed-ACK round trip to each.
    try { res.socket?.setNoDelay(true); } catch { /* transport default stands */ }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': attached\n\n');
    c.sse = res;
    c.paused = false;
    c.lastSeen = nowMs();
    // The stream proves the client received its token; response-loss replay is
    // no longer needed for this registration.
    for (const [registrationId, replay] of registrationReplays) {
      if (replay.token === token) {
        clearTimeout(replay.timer);
        registrationReplays.delete(registrationId);
      }
    }
    res.on('drain', () => {
      if (c.sse !== res) return;
      c.paused = false;
      flushPending(c);
    });
    flushPending(c);
    const ka = setInterval(() => {
      try { res.write(': ka\n\n'); } catch {}
    }, 15_000);
    ka.unref?.();
    const cleanup = () => {
      clearInterval(ka);
      if (c.sse === res) { c.sse = null; c.paused = false; }
      // Stream loss alone never drops the client: a desktop reload or a TUI
      // resize can bounce the stream while the engine keeps running.
      maybeArmGrace('sse closed');
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return true;
  }

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
          protocol: ENGINE_DAEMON_PROTOCOL,
          version: engineRuntimeVersion(),
          ...getStatus(),
          activeCalls,
          queuedCalls: callQueue.length,
        });
        return;
      }
      const token = req.headers['x-mixdog-daemon-token'] || url.searchParams.get('server_token');
      if (token !== serverToken) { sendError(res, 'forbidden', 403); return; }

      if (req.method === 'POST' && pathName === '/client/register') {
        const body = await readLimitedBody(req);
        const clientToken = registerClient({
          leadPid: body.leadPid,
          cwd: body.cwd,
          lifecycle: body.lifecycle !== false,
          registrationId: body.registrationId,
        });
        sendJson(res, { token: clientToken, pid: process.pid });
        return;
      }
      if (req.method === 'POST' && pathName === '/client/deregister') {
        const body = await readLimitedBody(req);
        if (body.token) dropClient(String(body.token), 'deregister');
        sendJson(res, { ok: true });
        return;
      }
      if (req.method === 'GET' && pathName === '/events') {
        const clientToken = url.searchParams.get('token');
        if (!attachSse(clientToken, res)) { sendError(res, 'unknown client token', 404); return; }
        return; // stream stays open
      }
      if (req.method === 'POST' && pathName === '/call') {
        const body = await readLimitedBody(req);
        const clientToken = body.token ? String(body.token) : null;
        const c = clientToken ? clients.get(clientToken) : null;
        if (!c) { sendError(res, 'unknown client token', 404); return; }
        c.lastSeen = nowMs();
        const name = String(body.name || '');
        const callId = body.callId ? String(body.callId) : null;
        // A retry is the SAME payload under the same id. A different payload
        // that reuses an id (submission ids are caller-supplied) is a NEW call
        // and must never be answered out of another call's result.
        const signature = callId ? callSignature(name, body.args) : null;
        const cached = callId ? callCache.get(callId) : null;
        let dispatch;
        if (cached && (!cached.signature || !signature || cached.signature === signature)) {
          dispatch = cached.promise;
        } else {
          dispatch = dispatchCall(() => handleCall(name, body.args || {}, {
            clientToken,
            leadPid: c.leadPid ?? null,
            cwd: c.cwd ?? null,
          }));
          if (callId) {
            const record = { promise: dispatch, at: nowMs(), signature };
            callCache.set(callId, record);
            pruneCallCache();
            // TTL starts at SETTLE: a long-running submit must not expire its
            // dedup entry mid-flight and let a retry run the turn twice.
            dispatch.then(() => {}, () => {}).then(() => {
              const t = setTimeout(() => {
                if (callCache.get(callId) === record) callCache.delete(callId);
              }, CALL_CACHE_TTL_MS);
              t.unref?.();
            });
          }
        }
        try {
          const result = await dispatch;
          sendJson(res, { result });
        } catch (err) {
          // Engine errors travel as a 200 {error} envelope so the client can
          // tell a failed CALL from a dead TRANSPORT (which must re-attach).
          sendJson(res, { error: err?.message || String(err) }, 200);
        }
        return;
      }
      if (req.method === 'POST' && pathName === '/shutdown') {
        sendJson(res, { ok: true });
        if (typeof onClientsEmpty === 'function') { try { onClientsEmpty(); } catch {} }
        return;
      }
      sendError(res, 'not found', 404);
    } catch (err) {
      try { sendError(res, err?.message || String(err), err?.statusCode || 500); } catch {}
    }
  }

  function writeDiscovery() {
    if (!discoveryPath) return;
    try {
      writeJsonAtomicSync(discoveryPath, {
        pid: process.pid,
        port: boundPort,
        token: serverToken,
        startedAt: Date.now(),
      }, { compact: true });
    } catch (err) {
      log(`discovery write failed: ${err?.message || err}`);
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer(handleRequest);
      server.on('error', reject);
      // 127.0.0.1 ONLY — the engine daemon executes tools; it must never be
      // reachable off-box.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        boundPort = server.address().port;
        server.on('error', (err) => log(`server error: ${err?.message || err}`));
        writeDiscovery();
        log(`engine daemon transport listening on 127.0.0.1:${boundPort} pid=${process.pid}`);
        resolve({ port: boundPort, token: serverToken });
      });
    });
  }

  async function stop() {
    closed = true;
    cancelGrace();
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    const stopped = new Error('engine daemon transport is closed');
    stopped.statusCode = 503;
    for (const queued of callQueue.splice(0)) queued.reject(stopped);
    for (const replay of registrationReplays.values()) clearTimeout(replay.timer);
    registrationReplays.clear();
    for (const token of [...clients.keys()]) removeClientRecord(token);
    if (discoveryPath) { try { rmSync(discoveryPath, { force: true }); } catch {} }
    await new Promise((resolve) => {
      if (!server) { resolve(); return; }
      server.close(() => resolve());
      server = null;
    });
  }

  return {
    start,
    stop,
    broadcast,
    get port() { return boundPort; },
    get clientCount() { return lifecycleClientCount(); },
    get connectionCount() { return clients.size; },
  };
}
