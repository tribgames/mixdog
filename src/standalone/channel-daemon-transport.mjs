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
  dispatchBind = null,
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
  // Sticky replay cache for the bridge remote-state notify. The daemon emits
  // 'notifications/mixdog/remote' {state:'acquired'} at boot (and 'superseded'
  // on repoint). That is a STATE signal, not an inbound message: every TUI must
  // observe the current remote-enabled state, and a late/non-pointer TUI that
  // attaches after the one-shot notify would otherwise never learn it. We stash
  // the latest such frame and replay it to each client as it attaches. Only the
  // remote-state notify is cached/replayed — inbound notifies
  // (notifications/claude/channel) stay pointer-targeted, never broadcast.
  const REMOTE_STATE_METHOD = 'notifications/mixdog/remote';
  let stickyRemoteFrame = null;
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
    const wasPointer = pointerToken === token;
    clients.delete(token);
    try { c.sse?.end?.(); } catch {}
    if (pointerToken === token) pointerToken = null;
    log(`client ${token} (lead=${c.leadPid}) removed: ${reason}`);
    // Pointer client death → hand the seat to a survivor (last-wins among the
    // living), replay its badge, and rebind the output forwarder to it. Skipped
    // during stop()/close (grace shutdown owns teardown) and when no live client
    // remains (grace shutdown path).
    if (wasPointer && !closed) failoverPointer(reason);
    maybeArmGrace('client removed');
  }

  // Pointer failover on owner death. Move the pointer to the most-recently-seen
  // LIVE client (reason 'failover'), deliver the sticky 'acquired' badge to it
  // (pending-buffered if it has no SSE yet), and re-dispatch ITS stored bind
  // intent so the output forwarder rebinds to the survivor's transcript. A
  // survivor with no stored bind still gets the pointer + badge (no rebind).
  function failoverPointer(reason) {
    let best = null;
    for (const [, c] of liveClients()) {
      if (!best || c.lastSeen > best.lastSeen) best = c;
    }
    if (!best) return; // no live clients — let grace shutdown run
    movePointer(best.token, 'failover');
    // Persist the acquired badge as the sticky frame so a later attachSse (or a
    // reconnect that follows the pointer) can replay it — matters when the
    // runtime never emitted 'acquired' since daemon boot (sticky still null).
    stickyRemoteFrame = JSON.stringify({ type: 'notify', method: REMOTE_STATE_METHOD, params: { state: 'acquired' } });
    writeRemoteStateTo(best, 'acquired');
    if (best.lastBind && typeof dispatchBind === 'function') {
      const { name, args } = best.lastBind;
      log(`failover rebind -> token=${best.token} lead=${best.leadPid} bind=${name} (${reason})`);
      try {
        Promise.resolve()
          .then(() => dispatchBind(name, args || {}, { clientToken: best.token, leadPid: best.leadPid, cwd: best.cwd }))
          .catch((err) => log(`failover rebind dispatch failed for lead=${best.leadPid}: ${err?.message || err}`));
      } catch (err) { log(`failover rebind dispatch failed for lead=${best.leadPid}: ${err?.message || err}`); }
    }
  }

  // Re-dispatch a client's stored bind intent so the output forwarder rebinds to
  // ITS transcript — the same mechanism failoverPointer uses on owner death,
  // applied when a client GAINS the pointer while already holding a bind (e.g.
  // migrated by pointer-follows-reconnect). Guarded, logged, non-throwing; does
  // not touch last-wins ownership or sticky replay.
  function redispatchPointerBind(client, reason) {
    if (!client?.lastBind || typeof dispatchBind !== 'function') return;
    const { name, args } = client.lastBind;
    log(`pointer rebind -> token=${client.token} lead=${client.leadPid} bind=${name} (${reason})`);
    try {
      Promise.resolve()
        .then(() => dispatchBind(name, args || {}, { clientToken: client.token, leadPid: client.leadPid, cwd: client.cwd }))
        .catch((err) => log(`pointer rebind dispatch failed for lead=${client.leadPid}: ${err?.message || err}`));
    } catch (err) { log(`pointer rebind dispatch failed for lead=${client.leadPid}: ${err?.message || err}`); }
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
      // Dead pointer discovered at notify time (i.e. BEFORE the sweep prunes
      // it): route removal through dropClient so failoverPointer runs — the
      // survivor gets the pointer, sticky 'acquired' badge, and its bind
      // intent re-dispatched. Silently nulling the token here bypassed all of
      // that (pointer stayed null; survivor never got badge/rebind).
      if (c) dropClient(pointerToken, 'pid dead (notify-time)');
      else pointerToken = null;
      // failoverPointer (via dropClient) may have installed a new pointer.
      if (pointerToken) {
        const p = clients.get(pointerToken);
        if (p && isPidAlive(p.leadPid)) return p;
      }
    }
    let best = null;
    for (const [, c] of liveClients()) {
      if (!best || c.lastSeen > best.lastSeen) best = c;
    }
    return best;
  }

  // Write a targeted remote-state frame to ONE client's SSE. If that client has
  // no live stream yet (e.g. displaced mid-reconnect), BUFFER the frame on its
  // pending queue and flush it when the stream (re)attaches — otherwise the
  // 'superseded' signal is silently lost and the old owner keeps its badge.
  function writeRemoteStateTo(client, state) {
    if (!client) return false;
    const frame = JSON.stringify({ type: 'notify', method: REMOTE_STATE_METHOD, params: { state } });
    if (!client.sse) { client.pending.push(frame); return true; }
    try { client.sse.write(`data: ${frame}\n\n`); return true; }
    catch (err) { log(`remote-state '${state}' write failed for lead=${client.leadPid}: ${err?.message || err}`); return false; }
  }

  // Unified last-wins ownership move. The pointer client owns ALL THREE of
  // inbound notify routing, outbound transcript binding, and the remote badge.
  // Every move (new TUI register OR a bind-intent /call) hands the seat to the
  // newcomer AND tells the DISPLACED owner it lost via a targeted 'superseded'
  // frame — so the old TUI drops its badge and stops pushing rebinds. Skip the
  // superseded when the old/new client share a leadPid (same TUI reconnecting /
  // re-binding to itself — it never "lost").
  function movePointer(newToken, reason) {
    const oldToken = pointerToken;
    if (oldToken === newToken) { pointerToken = newToken; return; }
    pointerToken = newToken;
    const oldClient = oldToken ? clients.get(oldToken) : null;
    const newClient = clients.get(newToken);
    log(`routing pointer -> token=${newToken} lead=${newClient?.leadPid ?? '?'} via ${reason}`);
    if (!oldClient || oldClient === newClient) return;
    if (newClient && oldClient.leadPid === newClient.leadPid) return; // same TUI
    if (isPidAlive(oldClient.leadPid)) {
      if (writeRemoteStateTo(oldClient, 'superseded')) {
        log(`superseded -> displaced pointer token=${oldToken} lead=${oldClient.leadPid}`);
      }
    }
    // Newcomer gaining the seat with a stored bind must rebind the output
    // forwarder to ITS transcript, mirroring failoverPointer. Only for moves
    // that carry NO fresh bind of their own: a POINTER_TOOLS /call already
    // dispatches the new bind right after this returns (redispatching the stale
    // lastBind first would fire an out-of-date rebind), and 'failover'
    // self-dispatches best.lastBind. Last-wins ordering above is untouched.
    if (reason !== 'failover' && !POINTER_TOOLS.has(reason)) redispatchPointerBind(newClient, reason);
  }

  function notify(method, params) {
    if (method === REMOTE_STATE_METHOD) {
      const frame = JSON.stringify({ type: 'notify', method, params });
      if (params?.state === 'acquired') {
        // 'acquired' is the standing badge state of the CURRENT owner. It is
        // sticky (cached even with zero live clients, e.g. boot-time notify) so
        // a late attach that IS the pointer can replay it. Under last-wins the
        // owner is exactly the pointer client, so deliver ONLY there — a
        // broadcast would light the badge on displaced/non-owner TUIs.
        stickyRemoteFrame = frame;
        const target = resolveTarget();
        if (!target?.sse) { log('remote-state acquired not delivered (no live pointer SSE); sticky set'); return false; }
        try { target.sse.write(`data: ${frame}\n\n`); return true; }
        catch (err) { log(`remote-state acquired write failed for lead=${target.leadPid}: ${err?.message || err}`); return false; }
      }
      // 'superseded' (seat lost to ANOTHER daemon, owned-runtime.mjs) and any
      // other transition CLEAR the sticky and broadcast to every live client —
      // whoever holds the badge must drop it; replaying it to a future attach
      // would wrongly stop a fresh remote client.
      stickyRemoteFrame = null;
      let delivered = false;
      for (const [, c] of liveClients()) {
        if (!c.sse) continue;
        try { c.sse.write(`data: ${frame}\n\n`); delivered = true; }
        catch (err) { log(`remote-state write failed for lead=${c.leadPid}: ${err?.message || err}`); }
      }
      if (!delivered) log('remote-state superseded not delivered live (no live SSE); sticky cleared');
      return delivered;
    }
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

  function registerClient({ leadPid, cwd, reattach = false }) {
    const pid = parsePid(leadPid) ?? 0;
    const token = randomUUID();
    clients.set(token, {
      token,
      leadPid: pid,
      cwd: cwd || null,
      sse: null,
      pending: [],
      lastSeen: nowMs(),
      registeredAt: nowMs(),
    });
    everHadClient = true;
    cancelGrace();
    startSweep();
    log(`client registered token=${token} lead=${pid} cwd=${cwd || '-'}`);
    // Pointer-follows-pid: if the current pointer client shares this leadPid AND
    // has no live SSE, it is the SAME terminal re-registering after its stream
    // dropped. That old entry is a dead-stream blackhole — pid-prune never reaps
    // it (pid still alive) and sse-close never drops entries, so resolveTarget
    // would write to a dead stream forever. Transfer the seat to the fresh
    // token, migrate its buffered pending frames + last bind intent, and remove
    // the old entry WITHOUT a failover or a self-'superseded'. A live-stream
    // pointer that happens to share the pid (e.g. co-located clients) is left
    // alone — last-wins handles a genuine fresh register below.
    if (pointerToken && pointerToken !== token) {
      const old = clients.get(pointerToken);
      if (old && old.leadPid === pid && !old.sse) {
        const fresh = clients.get(token);
        if (old.pending?.length) fresh.pending.push(...old.pending.splice(0));
        if (old.lastBind) fresh.lastBind = old.lastBind;
        clients.delete(pointerToken);
        try { old.sse?.end?.(); } catch {}
        pointerToken = token;
        log(`pointer follows reconnect -> token=${token} lead=${pid} (old entry dropped)`);
        // The fresh token inherited the old entry's bind intent but never went
        // through movePointer — re-dispatch it so the forwarder rebinds to this
        // reconnected terminal's transcript (guarded/no-op when no lastBind).
        redispatchPointerBind(fresh, 'reconnect');
        return token;
      }
    }
    if (reattach) {
      // SSE-reconnect re-register: a pruned client re-registers with a FRESH
      // token but it is NOT a new terminal — it must never steal ownership.
      // Only adopt the pointer when none exists (avoid a notify blackhole).
      if (!pointerToken) pointerToken = token;
    } else {
      // Last-wins: the NEWEST registered TUI (fresh terminal) always steals the
      // ownership seat, and the displaced owner is told it lost (superseded).
      movePointer(token, 'register');
    }
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
    // Flush any targeted frames buffered while this client had no stream (e.g. a
    // 'superseded' emitted at the moment it was reconnecting). Drop-with-client.
    if (c.pending?.length) {
      for (const frame of c.pending.splice(0)) {
        try { res.write(`data: ${frame}\n\n`); } catch {}
      }
    }
    // Replay the sticky 'acquired' badge ONLY when THIS attaching client is the
    // current pointer (the owner). A non-pointer late attach must NOT light the
    // badge — under last-wins only the newest owner holds it. The TUI-side
    // handler is idempotent, so re-delivery to the owner is safe.
    if (stickyRemoteFrame && token === pointerToken) {
      try { res.write(`data: ${stickyRemoteFrame}\n\n`); } catch {}
    }
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
        const clientToken = registerClient({ leadPid: body.leadPid, cwd: body.cwd, reattach: body.reattach === true });
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
          // Last-wins bind claim (/remote or boot). Steals the seat AND tells
          // the displaced owner it lost (targeted superseded).
          movePointer(clientToken, name);
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
          // Record the caller's last bind intent so a failover can rebind the
          // output forwarder to THIS client's transcript when it becomes owner.
          if (c && POINTER_TOOLS.has(name)) c.lastBind = { name, args: body.args || {} };
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
