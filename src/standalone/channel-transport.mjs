// Machine-global channel front door — HTTP + SSE transport (server side).
//
// Replaces the per-TUI fork + node-IPC (`{type:'call'|'notify'}`) plumbing with
// ONE local HTTP server that many TUIs attach to. Design mirrors the memory
// daemon (src/runtime/memory/index.mjs): 127.0.0.1-only, /client/register +
// /health + client-grace self-shutdown. It adds an SSE fan-out for the
// worker->parent notify path so notifications reach the CORRECT attached TUI
// (targeted routing, never broadcast — see routeNotify below).
//
// This module owns ONLY the transport (sockets, client registry, notify
// routing and lifecycle). The channels runtime (tool dispatch,
// Discord provider, transcript bind/steal) is injected via `handleCall` so the
// same transport is exercised by the real daemon entry AND the smoke harness
// (stub runtime, no Discord token).
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { writeJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';
import { readBody, sendJson, sendError } from '../runtime/memory/lib/http-wire.mjs';
import { createFairCallScheduler } from './fair-call-scheduler.mjs';

export const CHANNEL_HTTP_BODY_MAX_BYTES = 64 * 1024 * 1024;

function readChannelBody(req) {
  return readBody(req, { maxBytes: CHANNEL_HTTP_BODY_MAX_BYTES });
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

const ACTIVATE_TOOL = 'activate_channel_bridge';
const REBIND_TOOL = 'rebind_current_transcript';
const BINDING_TOOLS = new Set([ACTIVATE_TOOL, REBIND_TOOL]);

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

  const resolvedRemoteStatePath = remoteStatePath;
  const resolvedRemoteIntentPath = remoteIntentPath;
  // token -> { token, leadPid, cwd, sse, lastSeen, registeredAt }
  const clients = new Map();
  // UI control pointer only. The durable session pin, not this client token,
  // is the channel routing authority.
  let pointerToken = null;
  let boundPort = null;
  // Sticky replay cache for the bridge remote-state notify. The daemon emits
  // 'notifications/mixdog/remote' {state:'acquired'} at boot (and 'superseded'
  // on repoint). That is a STATE signal, not an inbound message: every TUI must
  // observe the current remote-enabled state, and a late/non-pointer TUI that
  // attaches after the one-shot notify would otherwise never learn it. Inbound
  // channel messages bypass this transport and submit directly to the pinned
  // session through the daemon session service.
  const REMOTE_STATE_METHOD = 'notifications/mixdog/remote';
  let stickyRemoteFrame = null;
  let remoteAcquired = false;
  let remoteStateSignature = '';
  let remoteIntent = readRemoteIntent();
  let pinnedSessionId = remoteIntent?.sessionId ?? null;
  let remoteRestorePromise = null;
  // Idempotency cache: callId -> { promise }. A retried /call with the SAME
  // callId awaits/returns the ORIGINAL run's result, so a transport-failure
  // retry never double-runs a non-idempotent tool (e.g. reply). Short TTL.
  const callCache = new Map();
  const CALL_CACHE_TTL_MS = 60_000;
  const configuredLaneLimit = (name) => {
    const parsed = Math.floor(Number(process.env[name]));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : Infinity;
  };
  const CALL_QUEUE_MAX = Math.max(256, Number(process.env.MIXDOG_CHANNEL_CALL_QUEUE) || 256);
  const channelCalls = createFairCallScheduler({
    name: 'channel call',
    activeMax: configuredLaneLimit('MIXDOG_CHANNEL_ACTIVE_CALLS'),
    queueMax: CALL_QUEUE_MAX,
    minOwnerQueue: Math.max(8, Math.floor(CALL_QUEUE_MAX / 16)),
  });
  const channelControlCalls = createFairCallScheduler({
    name: 'channel control call',
    activeMax: configuredLaneLimit('MIXDOG_CHANNEL_CONTROL_RESERVE'),
    queueMax: Math.max(16, Math.min(64, CALL_QUEUE_MAX)),
    minOwnerQueue: 4,
  });
  // Reconnect register replay: a server may commit replacement just before its
  // HTTP response is lost. The retry supplies this stable id and receives the
  // already-created fresh token instead of creating an orphan replacement.
  const registrationReplays = new Map(); // registrationId -> { token, leadPid, cwd, replaceToken, responseFinished }
  const registrationReplayTtl = Math.max(1, Number(registrationReplayTtlMs) || 60_000);
  let server = null;
  let graceTimer = null;
  let sweepTimer = null;
  let everHadClient = false;
  let closed = false;
  let drainingReason = '';

  function nowMs() { return Date.now(); }

  function remoteSessionIdFromBinding(name, args) {
    if (!BINDING_TOOLS.has(name) || !args || typeof args !== 'object') return null;
    const explicit = String(args.sessionId || '').trim();
    if (/^[A-Za-z0-9_-]+$/.test(explicit)) return explicit;
    const transcriptPath = String(args.transcriptPath || '').trim();
    if (!transcriptPath) return null;
    const inferred = basename(transcriptPath).replace(/\.[^.]+$/, '');
    return /^[A-Za-z0-9_-]+$/.test(inferred) ? inferred : null;
  }

  function normalizeRemoteIntent(value) {
    if (!value || typeof value !== 'object') return null;
    const sessionId = String(value.sessionId || '').trim();
    const transcriptPath = String(value.transcriptPath || '').trim();
    const cwd = value.cwd == null ? null : String(value.cwd);
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !transcriptPath) return null;
    const inferredSessionId = basename(transcriptPath).replace(/\.[^.]+$/, '');
    if (inferredSessionId !== sessionId) return null;
    return {
      version: 1,
      sessionId,
      transcriptPath,
      cwd,
      updatedAt: Number(value.updatedAt) || nowMs(),
    };
  }

  function readRemoteIntent() {
    if (!resolvedRemoteIntentPath) return null;
    try {
      const intent = normalizeRemoteIntent(JSON.parse(readFileSync(resolvedRemoteIntentPath, 'utf8')));
      if (!intent) {
        try { rmSync(resolvedRemoteIntentPath, { force: true }); } catch {}
        return null;
      }
      return intent;
    } catch {
      try { rmSync(resolvedRemoteIntentPath, { force: true }); } catch {}
      return null;
    }
  }

  function writeRemoteIntent(args, sessionId, cwd = null) {
    pinnedSessionId = sessionId;
    if (!resolvedRemoteIntentPath) return;
    const intent = normalizeRemoteIntent({
      sessionId,
      transcriptPath: args?.transcriptPath,
      cwd,
      updatedAt: nowMs(),
    });
    if (!intent) {
      log(`remote intent not persisted: session/transcript mismatch session=${sessionId || '?'}`);
      return;
    }
    remoteIntent = intent;
    try {
      writeJsonAtomicSync(resolvedRemoteIntentPath, intent, { compact: true });
    } catch (err) {
      log(`remote intent write failed: ${err?.message || err}`);
    }
  }

  function clearRemoteIntent(reason, sessionId = null) {
    const expectedSessionId = String(sessionId || '').trim();
    if (expectedSessionId && pinnedSessionId !== expectedSessionId) return false;
    pinnedSessionId = null;
    remoteIntent = null;
    if (resolvedRemoteIntentPath) {
      try { rmSync(resolvedRemoteIntentPath, { force: true }); }
      catch (err) { log(`remote intent clear failed (${reason}): ${err?.message || err}`); }
    }
    log(`remote intent cleared (${reason})`);
    return true;
  }

  function restoreRemoteIntent() {
    const intent = remoteIntent;
    if (closed || !intent) return Promise.resolve(false);
    if (remoteAcquired) return Promise.resolve(true);
    if (remoteRestorePromise) return remoteRestorePromise;
    const restore = Promise.resolve().then(async () => {
      if (closed || remoteIntent !== intent || pinnedSessionId !== intent.sessionId) return false;
      try {
        const result = await handleCall(ACTIVATE_TOOL, {
          active: true,
          sessionId: intent.sessionId,
          transcriptPath: intent.transcriptPath,
          restore: true,
        }, {
          clientToken: null,
          leadPid: null,
          cwd: intent.cwd,
        });
        if (result?.isError === true) {
          throw new Error(result?.content?.[0]?.text || 'restored activation failed');
        }
        if (!closed && remoteIntent === intent) {
          remoteAcquired = true;
          pinnedSessionId = intent.sessionId;
          stickyRemoteFrame = JSON.stringify({
            type: 'notify',
            method: REMOTE_STATE_METHOD,
            params: { state: 'acquired' },
          });
          log(`remote intent restored session=${intent.sessionId}`);
          publishRemoteState();
          return true;
        }
      } catch (err) {
        log(`remote intent restore failed session=${intent.sessionId}: ${err?.message || err}`);
      }
      return false;
    }).finally(() => {
      if (remoteRestorePromise === restore) remoteRestorePromise = null;
    });
    remoteRestorePromise = restore;
    return restore;
  }

  function publishRemoteState() {
    const pointerClient = pointerToken ? clients.get(pointerToken) : null;
    const sessionId = String(remoteAcquired ? pinnedSessionId : '');
    const state = {
      enabled: remoteAcquired === true && Boolean(sessionId),
      sessionId: remoteAcquired === true && sessionId ? sessionId : null,
      cwd: pointerClient?.cwd ?? remoteIntent?.cwd ?? null,
      daemonPid: process.pid,
      updatedAt: nowMs(),
    };
    const signature = JSON.stringify([
      state.enabled,
      state.sessionId,
      state.cwd,
      state.daemonPid,
    ]);
    if (signature === remoteStateSignature) return;
    remoteStateSignature = signature;
    if (typeof onRemoteStateChange === 'function') {
      try { onRemoteStateChange(state); }
      catch (err) { log(`remote session state listener failed: ${err?.message || err}`); }
    }
    if (!resolvedRemoteStatePath) return;
    try {
      writeJsonAtomicSync(resolvedRemoteStatePath, state, { compact: true });
    } catch (err) {
      log(`remote session state write failed: ${err?.message || err}`);
    }
  }

  function pruneDeadClients() {
    for (const [token, c] of clients) {
      // A client is dead when its lead pid is gone OR its SSE stream closed and
      // it has not re-registered within a grace window. pid death is the
      // authoritative signal for client liveness.
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
    removeClientRecord(token);
    if (pointerToken === token) pointerToken = null;
    log(`client ${token} (lead=${c.leadPid}) removed: ${reason}`);
    // Client presence is not channel authority. The durable session pin stays
    // active until that same session explicitly turns Remote OFF.
    publishRemoteState();
    maybeArmGrace('client removed');
  }

  function beginDrain(reason = 'daemon replacement') {
    if (drainingReason) return false;
    drainingReason = String(reason || 'daemon replacement');
    cancelGrace();
    for (const token of [...clients.keys()]) {
      dropClient(token, drainingReason);
    }
    return true;
  }

  function removeRegistrationReplay(registrationId, replay = registrationReplays.get(registrationId)) {
    if (!replay || registrationReplays.get(registrationId) !== replay) return;
    registrationReplays.delete(registrationId);
    try { clearTimeout(replay.timer); } catch {}
  }

  // Every removal path uses this primitive, including replacement's deliberate
  // no-failover retirement, so replay records/timers never target absent tokens.
  function removeClientRecord(token) {
    const c = clients.get(token);
    if (!c) return null;
    clients.delete(token);
    for (const [registrationId, replay] of registrationReplays) {
      if (replay.token === token) removeRegistrationReplay(registrationId, replay);
    }
    try { c.sse?.end?.(); } catch {}
    return c;
  }

  function clearRegistrationReplays() {
    for (const [registrationId, replay] of registrationReplays) removeRegistrationReplay(registrationId, replay);
  }

  function armRegistrationReplay(replayId, replay) {
    try { clearTimeout(replay.timer); } catch {}
    replay.timer = setTimeout(() => {
      if (registrationReplays.get(replayId) !== replay) return;
      // A successfully flushed register response creates a valid client even
      // if its SSE/call is delayed. TTL only bounds cancellation metadata.
      removeRegistrationReplay(replayId, replay);
      if (!replay.responseFinished && clients.has(replay.token)) {
        dropClient(replay.token, 'unflushed registration replay expired');
      }
    }, registrationReplayTtl);
    replay.timer.unref?.();
  }

  function markRegistrationResponseFinished(registrationId, token) {
    const replay = registrationId ? registrationReplays.get(registrationId) : null;
    if (replay && replay.token === token) replay.responseFinished = true;
  }

  // A response-loss close knows only its retired token + stable registration id.
  // Bind cancellation to every logical-client field before retiring the fresh
  // token; malformed/mismatched cancellation can never affect another client.
  function cancelReplacementRegistration({ token, registrationId, replaceToken, leadPid, cwd, restoreSessionId }) {
    const replayId = registrationId ? String(registrationId).slice(0, 200) : null;
    const replay = replayId ? registrationReplays.get(replayId) : null;
    if (!replay) return 'missing';
    const retiredToken = token ? String(token) : null;
    if (retiredToken !== replay.replaceToken || String(replaceToken || '') !== replay.replaceToken ||
        parsePid(leadPid) !== replay.leadPid || (cwd || null) !== replay.cwd
        || String(restoreSessionId || '') !== String(replay.restoreSessionId || '')) return 'forbidden';
    dropClient(replay.token, 'replacement deregister');
    return 'cancelled';
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

  // Resolve the active UI pointer for state delivery only. Session routing
  // never depends on this client.
  function resolveTarget() {
    if (pointerToken) {
      const c = clients.get(pointerToken);
      if (c && isPidAlive(c.leadPid)) return c;
      if (c) dropClient(pointerToken, 'pid dead (notify-time)');
      else pointerToken = null;
    }
    return null;
  }

  // Write a targeted remote-state frame to ONE client's SSE. If that client has
  // no live stream yet (e.g. displaced mid-reconnect), BUFFER the frame on its
  // pending queue and flush it when the stream (re)attaches — otherwise the
  // 'superseded' signal is silently lost and the displaced UI keeps its badge.
  function writeRemoteStateTo(client, state) {
    if (!client) return false;
    const frame = JSON.stringify({ type: 'notify', method: REMOTE_STATE_METHOD, params: { state } });
    if (!client.sse) {
      // This is state, not an event log. Control-state churn before an SSE
      // reconnect only needs the newest transition; retaining every displaced
      // frame lets one disconnected client grow without bound.
      client.pendingRemoteStateFrame = frame;
      return true;
    }
    try { client.sse.write(`data: ${frame}\n\n`); return true; }
    catch (err) { log(`remote-state '${state}' write failed for lead=${client.leadPid}: ${err?.message || err}`); return false; }
  }

  // Manual ON may temporarily select its control client before provider
  // activation so a synchronous acquired state reaches the right UI.
  function movePointer(newToken, reason, { notifyDisplaced = true } = {}) {
    const oldToken = pointerToken;
    if (oldToken === newToken) {
      pointerToken = newToken;
      publishRemoteState();
      return oldToken;
    }
    pointerToken = newToken;
    const oldClient = oldToken ? clients.get(oldToken) : null;
    const newClient = clients.get(newToken);
    log(`routing pointer -> token=${newToken} lead=${newClient?.leadPid ?? '?'} via ${reason}`);
    publishRemoteState();
    if (notifyDisplaced && oldClient && oldClient !== newClient && isPidAlive(oldClient.leadPid)) {
      if (writeRemoteStateTo(oldClient, 'superseded')) {
        log(`superseded -> displaced pointer token=${oldToken} lead=${oldClient.leadPid}`);
      }
    }
    return oldToken;
  }

  function notify(method, params) {
    if (method === REMOTE_STATE_METHOD) {
      const frame = JSON.stringify({ type: 'notify', method, params });
      if (params?.state === 'acquired') {
        // Cache the standing badge state even with zero clients. A control
        // client receives the immediate state; session routing is independent.
        const target = resolveTarget();
        if (!target) {
          if (!pinnedSessionId) {
            log('remote-state acquired ignored (no pinned session)');
            return false;
          }
          remoteAcquired = true;
          stickyRemoteFrame = frame;
          publishRemoteState();
          log(`remote-state acquired for session=${pinnedSessionId}`);
          return true;
        }
        remoteAcquired = true;
        stickyRemoteFrame = frame;
        publishRemoteState();
        if (!target.sse) { log('remote-state acquired not delivered (control client has no SSE); sticky set'); return false; }
        try { target.sse.write(`data: ${frame}\n\n`); return true; }
        catch (err) { log(`remote-state acquired write failed for lead=${target.leadPid}: ${err?.message || err}`); return false; }
      }
      // 'superseded' (seat lost to ANOTHER daemon, owned-runtime.mjs) and any
      // other transition CLEAR the sticky and broadcast to every live client —
      // whoever holds the badge must drop it; replaying it to a future attach
      // would wrongly stop a fresh remote client.
      remoteAcquired = false;
      stickyRemoteFrame = null;
      clearRemoteIntent('remote superseded');
      publishRemoteState();
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

  function registerClient({
    leadPid,
    cwd,
    passive = false,
    replaceToken = null,
    registrationId = null,
    restoreSessionId = null,
  }) {
    const pid = parsePid(leadPid) ?? 0;
    const restoreId = /^[A-Za-z0-9_-]+$/.test(String(restoreSessionId || ''))
      ? String(restoreSessionId)
      : null;
    const replacementToken = replaceToken ? String(replaceToken) : null;
    const replayId = passive && registrationId ? String(registrationId).slice(0, 200) : null;
    const existingReplay = replayId ? registrationReplays.get(replayId) : null;
    if (existingReplay) {
      if (existingReplay.leadPid === pid && existingReplay.cwd === (cwd || null) &&
          existingReplay.replaceToken === replacementToken
          && existingReplay.restoreSessionId === restoreId
          && clients.has(existingReplay.token)) {
        armRegistrationReplay(replayId, existingReplay);
        log(`client reconnect replay token=${existingReplay.token} lead=${pid}`);
        return existingReplay.token;
      }
      if (clients.has(existingReplay.token)) {
        const err = new Error('registration replay identity mismatch');
        err.statusCode = 409;
        throw err;
      }
      removeRegistrationReplay(replayId, existingReplay);
    }
    const token = randomUUID();
    clients.set(token, {
      token,
      leadPid: pid,
      cwd: cwd || null,
      sse: null,
      pendingRemoteStateFrame: null,
      lastSeen: nowMs(),
      registeredAt: nowMs(),
      restoreSessionId: restoreId,
    });
    const registeredClient = clients.get(token);
    if (remoteAcquired && restoreId && restoreId === pinnedSessionId) {
      registeredClient.remoteSessionId = restoreId;
    }
    everHadClient = true;
    cancelGrace();
    startSweep();
    log(`client registered token=${token} lead=${pid} cwd=${cwd || '-'}`);
    // The unified daemon starts the channels runtime (automation, webhooks,
    // messaging provider) only once a CHANNELS client is actually present — an
    // session runtime-only daemon must not run tunnels nobody asked for.
    if (typeof onClientRegistered === 'function') {
      try { onClientRegistered({ token, leadPid: pid, cwd: cwd || null }); } catch {}
    }
    const rememberReplacement = (freshToken) => {
      if (!replayId) return freshToken;
      const replay = {
        token: freshToken, leadPid: pid, cwd: cwd || null, replaceToken: replacementToken,
        restoreSessionId: restoreId,
        responseFinished: false, timer: null,
      };
      registrationReplays.set(replayId, replay);
      armRegistrationReplay(replayId, replay);
      return freshToken;
    };
    // A reconnect names the exact token it replaces. Retire it even when it is
    // not the pointer: retaining an old token would let it later call or
    // accumulate a buffered frame after the fresh client
    // has gone away. Token replacement never crosses leadPid boundaries.
    const replaced = passive && replacementToken ? clients.get(replacementToken) : null;
    if (replaced && replaced.leadPid === pid) {
      const fresh = clients.get(token);
      const replacedWasPointer = pointerToken === replaced.token;
      // Token-scoped state belongs to the logical client.
      if (replaced.pendingRemoteStateFrame) {
        fresh.pendingRemoteStateFrame = replaced.pendingRemoteStateFrame;
        replaced.pendingRemoteStateFrame = null;
      }
      if (replaced.remoteSessionId) fresh.remoteSessionId = replaced.remoteSessionId;
      if (replaced.restoreSessionId) fresh.restoreSessionId = replaced.restoreSessionId;
      if (replacedWasPointer) pointerToken = token;
      removeClientRecord(replaced.token);
      log(`client reconnect replaced token=${replaced.token} -> ${token} lead=${pid}`);
      return rememberReplacement(token);
    }
    // Registration is transport-only, including same-pid fresh attaches.
    return rememberReplacement(token);
  }

  function attachSse(token, res) {
    const c = clients.get(token);
    if (!c) return false;
    // A live stream proves the client learned its fresh token, so response-loss
    // cancellation is no longer needed for this logical registration.
    for (const [registrationId, replay] of registrationReplays) {
      if (replay.token === token) removeRegistrationReplay(registrationId, replay);
    }
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
    if (c.pendingRemoteStateFrame) {
      const frame = c.pendingRemoteStateFrame;
      c.pendingRemoteStateFrame = null;
      try { res.write(`data: ${frame}\n\n`); } catch {}
    }
    // Replay the sticky 'acquired' badge only to the current control client.
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
        sendJson(res, {
          status: 'ok',
          pid: process.pid,
          clients: clients.size,
          activeCalls: channelCalls.active + channelControlCalls.active,
          queuedCalls: channelCalls.queued + channelControlCalls.queued,
          callOwners: channelCalls.snapshot().owners,
          draining: drainingReason || null,
          ...(agentBroker?.snapshot ? { agentBroker: agentBroker.snapshot() } : {}),
          ...getStatus(),
        });
        return;
      }
      const token = req.headers['x-mixdog-daemon-token'];
      if (token !== serverToken) { sendError(res, 'forbidden', 403); return; }

      if (req.method === 'POST' && pathName === '/client/register') {
        if (drainingReason) {
          sendError(res, `daemon is draining: ${drainingReason}`, 503);
          return;
        }
        const body = await readChannelBody(req);
        const clientToken = registerClient({
          leadPid: body.leadPid, cwd: body.cwd, passive: body.passive === true,
          replaceToken: body.replaceToken, registrationId: body.registrationId,
          restoreSessionId: body.restoreSessionId,
        });
        const replayId = body.passive === true && body.registrationId ? String(body.registrationId).slice(0, 200) : null;
        res.once('finish', () => markRegistrationResponseFinished(replayId, clientToken));
        sendJson(res, { token: clientToken, pid: process.pid });
        return;
      }
      if (req.method === 'POST' && pathName === '/client/deregister') {
        const body = await readChannelBody(req);
        if (body.registrationId) {
          const cancelled = cancelReplacementRegistration(body);
          if (cancelled === 'forbidden') { sendError(res, 'forbidden replacement deregister', 403); return; }
          sendJson(res, { ok: true, cancelled: cancelled === 'cancelled' });
          return;
        }
        if (body.token) {
          dropClient(body.token, 'deregister');
        }
        sendJson(res, { ok: true });
        return;
      }
      if (req.method === 'GET' && pathName === '/events') {
        const clientToken = url.searchParams.get('token');
        if (!attachSse(clientToken, res)) { sendError(res, 'unknown client token', 404); return; }
        return; // stream stays open
      }
      // Internal memory -> session LLM bridge. It is authenticated with the
      // daemon discovery token but deliberately does NOT register as a channel
              // registered client: background memory work must not change the pinned session or
      // keep the channels client registry alive. The broker itself owns a
      // parallel fair scheduler and per-call cancellation.
      if (req.method === 'POST' && pathName === '/agent/dispatch') {
        if (!agentBroker?.dispatch) { sendError(res, 'agent broker unavailable', 503); return; }
        const body = await readChannelBody(req);
        const callId = String(body.callId || '').trim();
        if (!callId) { sendError(res, 'callId required', 400); return; }
        res.on('close', () => {
          if (res.writableFinished) return;
          try { agentBroker.cancel(callId, 'agent broker client disconnected'); } catch {}
        });
        try {
          const result = await agentBroker.dispatch(body.params || {}, { callId });
          sendJson(res, { ok: true, result });
        } catch (error) {
          sendJson(res, { ok: false, error: error?.message || String(error) }, 200);
        }
        return;
      }
      if (req.method === 'POST' && pathName === '/agent/cancel') {
        if (!agentBroker?.cancel) { sendError(res, 'agent broker unavailable', 503); return; }
        const body = await readChannelBody(req);
        const callId = String(body.callId || '').trim();
        if (!callId) { sendError(res, 'callId required', 400); return; }
        const cancelled = agentBroker.cancelAndWait
          ? await agentBroker.cancelAndWait(
              callId,
              String(body.reason || 'memory agent dispatch canceled'),
            )
          : agentBroker.cancel(callId, String(body.reason || 'memory agent dispatch canceled'));
        sendJson(res, {
          ok: true,
          cancelled,
        });
        return;
      }
      if (req.method === 'POST' && pathName === '/call') {
        const body = await readChannelBody(req);
        const clientToken = body.token || null;
        const c = clientToken ? clients.get(clientToken) : null;
        if (!c) { sendError(res, 'unknown client token', 404); return; }
        for (const [registrationId, replay] of registrationReplays) {
          if (replay.token === clientToken) removeRegistrationReplay(registrationId, replay);
        }
        c.lastSeen = nowMs();
        const name = String(body.name || '');
        const callId = body.callId ? String(body.callId) : null;
        const addressedSessionId = String(body.args?.sessionId || '').trim()
          || remoteSessionIdFromBinding(name, body.args || {});
        const ownerKey = addressedSessionId
          ? `session:${addressedSessionId}`
          : c.leadPid
            ? `pid:${c.leadPid}`
            : `client:${clientToken}`;
        const cacheKey = callId ? `${ownerKey}\u0000${callId}` : null;
        let dispatch;
        if (cacheKey && callCache.has(cacheKey)) {
          // Replay of a retried call — dedup to the original run (exactly one
          // side-effect) instead of dispatching handleCall a second time.
          dispatch = callCache.get(cacheKey).promise;
        } else {
          const run = async () => {
            const args = body.args || {};
            const activationCall = name === ACTIVATE_TOOL;
            const activating = activationCall && args.active === true;
            const deactivating = activationCall && args.active === false;
            const rebindCall = name === REBIND_TOOL;
            const bindingSessionId = remoteSessionIdFromBinding(name, args);
            // Auto/implicit activation is retired. A valid manual ON always
            // carries its target session and explicitly overrides the old one.
            if (activating && (args.claimIfVacant === true || !bindingSessionId)) {
              return {
                content: [{ type: 'text', text: 'channel bridge claim skipped: manual ON required' }],
                claimSkipped: true,
              };
            }
            const pinnedSessionMatch = Boolean(
              bindingSessionId
              && remoteAcquired
              && pinnedSessionId === bindingSessionId,
            );
            if (deactivating && !pinnedSessionMatch) {
              return {
                content: [{ type: 'text', text: 'channel bridge release skipped: session is not pinned' }],
                releaseSkipped: true,
              };
            }
            if (rebindCall && !pinnedSessionMatch) {
              return {
                content: [{ type: 'text', text: 'transcript rebind skipped: session is not pinned' }],
                rebindSkipped: true,
              };
            }

            const previousPointerToken = pointerToken;
            const previousRemoteSessionId = c.remoteSessionId || null;
            const previousRemoteAcquired = remoteAcquired;
            const previousStickyRemoteFrame = stickyRemoteFrame;
            if (activating) {
              c.remoteSessionId = bindingSessionId;
              movePointer(clientToken, 'manual remote ON', { notifyDisplaced: false });
            }
            try {
              const result = await handleCall(name, args, {
                clientToken,
                leadPid: c?.leadPid ?? null,
                cwd: c?.cwd ?? null,
              });
              if (activating && previousPointerToken && previousPointerToken !== clientToken) {
                const displaced = clients.get(previousPointerToken);
                if (displaced && isPidAlive(displaced.leadPid)
                    && writeRemoteStateTo(displaced, 'superseded')) {
                  log(`superseded -> displaced control client token=${previousPointerToken} lead=${displaced.leadPid}`);
                }
              }
              if (deactivating) {
                clearRemoteIntent('explicit Remote OFF', bindingSessionId);
                pointerToken = null;
                c.remoteSessionId = null;
                remoteAcquired = false;
                stickyRemoteFrame = null;
              }
              if (activating && result?.isError !== true
                  && pointerToken === clientToken
                  && c.remoteSessionId === bindingSessionId) {
                remoteAcquired = true;
                writeRemoteIntent(args, bindingSessionId, c.cwd ?? null);
              }
              publishRemoteState();
              return result;
            } catch (err) {
              if (activating && pointerToken === clientToken
                  && c.remoteSessionId === bindingSessionId) {
                pointerToken = previousPointerToken && clients.has(previousPointerToken)
                  ? previousPointerToken
                  : null;
                c.remoteSessionId = previousRemoteSessionId;
                remoteAcquired = previousRemoteAcquired;
                stickyRemoteFrame = previousStickyRemoteFrame;
                publishRemoteState();
              }
              throw err;
            }
          };
          const scheduler = BINDING_TOOLS.has(name) ? channelControlCalls : channelCalls;
          dispatch = scheduler.enqueue(ownerKey, run);
          if (cacheKey) {
            const record = { promise: dispatch, at: nowMs() };
            callCache.set(cacheKey, record);
            // Start the TTL only once the call SETTLES: an in-flight call can
            // outlive a fixed-from-dispatch TTL (e.g. a slow reply upload past
            // 60s), and expiring its entry mid-flight would let a transport
            // retry replay-miss and dispatch a second real side-effect.
            dispatch.then(() => {}, () => {}).then(() => {
              const t = setTimeout(() => {
                if (callCache.get(cacheKey) === record) callCache.delete(cacheKey);
              }, CALL_CACHE_TTL_MS);
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

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer(handleRequest);
      server.on('error', reject);
      // 127.0.0.1 ONLY — never expose the daemon off-box.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        boundPort = server.address().port;
        server.on('error', (err) => log(`server error: ${err?.message || err}`));
        publishRemoteState();
        log(`daemon transport listening on 127.0.0.1:${boundPort} pid=${process.pid}`);
        resolve({ port: boundPort, token: serverToken });
      });
    });
  }

  async function stop() {
    closed = true;
    channelCalls.close('channel transport is closed');
    channelControlCalls.close('channel transport is closed');
    cancelGrace();
    if (sweepTimer) { try { clearInterval(sweepTimer); } catch {} sweepTimer = null; }
    for (const [token] of clients) dropClient(token, 'transport stop');
    remoteAcquired = false;
    pointerToken = null;
    publishRemoteState();
    clearRegistrationReplays();
    if (server) {
      await new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } });
      server = null;
    }
  }

  return {
    start,
    stop,
    notify,
    restoreRemoteIntent,
    beginDrain,
    get port() { return boundPort; },
    get token() { return serverToken; },
    // The unified daemon hosts channels AND session runtimes: it may only self-shutdown
    // when BOTH sides are empty, so each transport has to expose its liveness.
    get clientCount() { return clients.size; },
    get activeCount() { return channelCalls.active + channelControlCalls.active; },
    get queuedCount() { return channelCalls.queued + channelControlCalls.queued; },
    get draining() { return Boolean(drainingReason); },
    get remoteIntentSessionId() {
      return String(pinnedSessionId || '').trim() || null;
    },
    get remoteSessionId() {
      return String(remoteAcquired ? pinnedSessionId : '').trim() || null;
    },
    _clientsForTest: clients,
    _registrationReplaysForTest: registrationReplays,
    _resolveTargetForTest: resolveTarget,
    _writeRemoteStateToForTest: writeRemoteStateTo,
    get _pointerTokenForTest() { return pointerToken; },
    get _remoteIntentForTest() { return remoteIntent; },
  };
}
