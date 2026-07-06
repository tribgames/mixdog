// Machine-global channels daemon — HTTP + SSE transport (server side).
//
// Replaces the per-TUI fork + node-IPC (`{type:'call'|'notify'}`) plumbing with
// ONE local HTTP server that many TUIs attach to. Design mirrors the memory
// daemon (src/runtime/memory/index.mjs): 127.0.0.1-only, /client/register +
// /health + client-grace self-shutdown. It adds an SSE fan-out for the
// worker->parent notify path so notifications reach the CORRECT attached TUI
// (targeted routing, never broadcast — see routeNotify below).
//
// This module owns ONLY the transport (sockets, client registry, notify
// routing, discovery file, lifecycle). The channels runtime (tool dispatch,
// Discord backend, transcript bind/steal) is injected via `handleCall` so the
// same transport is exercised by the real daemon entry AND the smoke harness
// (stub runtime, no Discord token).
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { writeJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';
import { readBody, sendJson, sendError } from '../runtime/memory/lib/http-wire.mjs';

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

// Tool names whose successful call re-points the routing pointer at the caller.
// These are the Lead-only "I am now the bound TUI" signals (bridge claim on
// start, Lead-pushed transcript repoint). Per the routing ruling the pointer is
// NOT a lease: last-bind-wins, pid-verified at delivery, no heartbeat expiry.
const POINTER_TOOLS = new Set(['activate_channel_bridge', 'rebind_current_transcript']);

export function createChannelDaemonTransport({
  handleCall,
  discoveryPath,
  serverToken = randomUUID(),
  log = () => {},
  clientGraceMs = 10_000,
  sweepMs = 5_000,
  onClientsEmpty = null,
  getStatus = () => ({}),
} = {}) {
  if (typeof handleCall !== 'function') throw new Error('handleCall is required');

  // token -> { token, leadPid, cwd, sse, lastSeen, registeredAt }
  const clients = new Map();
  // leadPid of the last client to claim the bridge / repoint the transcript.
  // Under a single-owner bridge there is exactly one bound transcript at a
  // time, so the pointer client IS the transcript owner — this unifies notify
  // targeting for both inbound-message notifies and proactive injects.
  let pointerToken = null;
  let boundPort = null;
  // Idempotency cache: callId -> { promise }. A retried /call with the SAME
  // callId awaits/returns the ORIGINAL run's result, so a transport-failure
  // retry never double-runs a non-idempotent tool (e.g. reply). Short TTL.
  const callCache = new Map();
  const CALL_CACHE_TTL_MS = 60_000;
  let server = null;
  let graceTimer = null;
  let sweepTimer = null;
  let everHadClient = false;
  let closed = false;

  function nowMs() { return Date.now(); }

  function pruneDeadClients() {
    for (const [token, c] of clients) {
      // A client is dead when its lead pid is gone OR its SSE stream closed and
      // it has not re-registered within a grace window. pid death is the
      // authoritative signal (mirrors memory daemon pruneDeadClients).
      if (!isPidAlive(c.leadPid)) {
        dropClient(token, 'pid dead');
      }
    }
  }

  function liveClients() {
    const out = [];
    for (const [token, c] of clients) {
      if (isPidAlive(c.leadPid)) out.push([token, c]);
    }
    return out;
  }

  function dropClient(token, reason) {
    const c = clients.get(token);
    if (!c) return;
    clients.delete(token);
    try { c.sse?.end?.(); } catch {}
    if (pointerToken === token) pointerToken = null;
    log(`client ${token} (lead=${c.leadPid}) removed: ${reason}`);
    maybeArmGrace('client removed');
  }

  function cancelGrace() {
    if (graceTimer) { try { clearTimeout(graceTimer); } catch {} graceTimer = null; }
  }

  function maybeArmGrace(reason) {
    if (closed || graceTimer) return;
    if (!everHadClient || clients.size > 0) return;
    if (typeof onClientsEmpty !== 'function' || clientGraceMs <= 0) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      pruneDeadClients();
      if (clients.size > 0) return;
      log(`client grace elapsed (${reason}); no live clients — self-shutdown`);
      try { onClientsEmpty(); } catch {}
    }, clientGraceMs);
    graceTimer.unref?.();
  }

  function startSweep() {
    if (sweepTimer || typeof onClientsEmpty !== 'function') return;
    sweepTimer = setInterval(() => {
      pruneDeadClients();
      if (everHadClient && clients.size === 0) maybeArmGrace('all clients gone (sweep)');
    }, Math.max(1000, Math.min(sweepMs, clientGraceMs || sweepMs)));
    sweepTimer.unref?.();
  }

  // Resolve the ONE client that should receive a notify. Pointer client first
  // (pid-verified at delivery), then most-recently-seen live client, else drop.
  // Never broadcasts — a broadcast would inject one inbound Discord message into
  // every attached TUI's Lead session.
  function resolveTarget() {
    if (pointerToken) {
      const c = clients.get(pointerToken);
      if (c && isPidAlive(c.leadPid)) return c;
      if (pointerToken) pointerToken = null;
    }
    let best = null;
    for (const [, c] of liveClients()) {
      if (!best || c.lastSeen > best.lastSeen) best = c;
    }
    return best;
  }

  function notify(method, params) {
    const target = resolveTarget();
    if (!target) {
      log(`notify dropped (no live target): ${method}`);
      return false;
    }
    if (!target.sse) {
      log(`notify dropped (target has no SSE stream): ${method}`);
      return false;
    }
    const frame = JSON.stringify({ type: 'notify', method, params });
    try {
      target.sse.write(`data: ${frame}\n\n`);
      return true;
    } catch (err) {
      log(`notify write failed for lead=${target.leadPid}: ${err?.message || err}`);
      return false;
    }
  }

  function registerClient({ leadPid, cwd }) {
    const pid = parsePid(leadPid) ?? 0;
    const token = randomUUID();
    clients.set(token, {
      token,
      leadPid: pid,
      cwd: cwd || null,
      sse: null,
      lastSeen: nowMs(),
      registeredAt: nowMs(),
    });
    everHadClient = true;
    cancelGrace();
    startSweep();
    // First client to attach becomes the routing pointer until an explicit
    // bind call moves it. Ensures a lone TUI receives notifies immediately.
    if (!pointerToken) pointerToken = token;
    log(`client registered token=${token} lead=${pid} cwd=${cwd || '-'}`);
    return token;
  }

  function attachSse(token, res) {
    const c = clients.get(token);
    if (!c) return false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Prelude comment flushes headers so the client's SSE reader resolves.
    res.write(': attached\n\n');
    c.sse = res;
    c.lastSeen = nowMs();
    const ka = setInterval(() => {
      try { res.write(': ka\n\n'); } catch {}
    }, 15_000);
    ka.unref?.();
    const cleanup = () => {
      clearInterval(ka);
      if (c.sse === res) c.sse = null;
      // Stream loss alone does not drop the client (a TUI may reconnect); the
      // sweep + pid check reaps genuinely dead clients.
      maybeArmGrace('sse closed');
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return true;
  }

  async function handleRequest(req, res) {
    // 127.0.0.1 bind already restricts reachability; still refuse anything
    // without our server token except /health (liveness probe is unauthed).
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathName = url.pathname;
    try {
      if (req.method === 'GET' && pathName === '/health') {
        sendJson(res, { status: 'ok', pid: process.pid, clients: clients.size, ...getStatus() });
        return;
      }
      const token = req.headers['x-mixdog-daemon-token'] || url.searchParams.get('server_token');
      if (token !== serverToken) { sendError(res, 'forbidden', 403); return; }

      if (req.method === 'POST' && pathName === '/client/register') {
        const body = await readBody(req);
        const clientToken = registerClient({ leadPid: body.leadPid, cwd: body.cwd });
        sendJson(res, { token: clientToken, pid: process.pid });
        return;
      }
      if (req.method === 'POST' && pathName === '/client/deregister') {
        const body = await readBody(req);
        if (body.token) dropClient(body.token, 'deregister');
        sendJson(res, { ok: true });
        return;
      }
      if (req.method === 'GET' && pathName === '/events') {
        const clientToken = url.searchParams.get('token');
        if (!attachSse(clientToken, res)) { sendError(res, 'unknown client token', 404); return; }
        return; // stream stays open
      }
      if (req.method === 'POST' && pathName === '/call') {
        const body = await readBody(req);
        const clientToken = body.token || null;
        const c = clientToken ? clients.get(clientToken) : null;
        if (c) c.lastSeen = nowMs();
        const name = String(body.name || '');
        // Bind-intent calls re-point routing at the caller BEFORE dispatch, so a
        // notify emitted synchronously during the call already targets it.
        if (c && POINTER_TOOLS.has(name)) {
          pointerToken = clientToken;
          log(`routing pointer -> token=${clientToken} lead=${c.leadPid} via ${name}`);
        }
        const callId = body.callId ? String(body.callId) : null;
        let dispatch;
        if (callId && callCache.has(callId)) {
          // Replay of a retried call — dedup to the original run (exactly one
          // side-effect) instead of dispatching handleCall a second time.
          dispatch = callCache.get(callId).promise;
        } else {
          dispatch = Promise.resolve().then(() => handleCall(name, body.args || {}, {
            clientToken,
            leadPid: c?.leadPid ?? null,
            cwd: c?.cwd ?? null,
          }));
          if (callId) {
            callCache.set(callId, { promise: dispatch, at: nowMs() });
            // Start the TTL only once the call SETTLES: an in-flight call can
            // outlive a fixed-from-dispatch TTL (e.g. a slow reply upload past
            // 60s), and expiring its entry mid-flight would let a transport
            // retry replay-miss and dispatch a second real side-effect.
            dispatch.then(() => {}, () => {}).then(() => {
              const t = setTimeout(() => callCache.delete(callId), CALL_CACHE_TTL_MS);
              t.unref?.();
            });
          }
        }
        try {
          const result = await dispatch;
          sendJson(res, { result });
        } catch (err) {
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
      // 127.0.0.1 ONLY — never expose the daemon off-box.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        boundPort = server.address().port;
        server.on('error', (err) => log(`server error: ${err?.message || err}`));
        writeDiscovery();
        log(`daemon transport listening on 127.0.0.1:${boundPort} pid=${process.pid}`);
        resolve({ port: boundPort, token: serverToken });
      });
    });
  }

  async function stop() {
    closed = true;
    cancelGrace();
    if (sweepTimer) { try { clearInterval(sweepTimer); } catch {} sweepTimer = null; }
    for (const [token] of clients) dropClient(token, 'transport stop');
    if (discoveryPath) { try { rmSync(discoveryPath, { force: true }); } catch {} }
    if (server) {
      await new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } });
      server = null;
    }
  }

  return {
    start,
    stop,
    notify,
    get port() { return boundPort; },
    get token() { return serverToken; },
    _clientsForTest: clients,
    _resolveTargetForTest: resolveTarget,
  };
}
