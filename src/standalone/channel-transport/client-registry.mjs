/**
 * client-registry.mjs — the attached-client registry of the channel
 * transport: the live client records, registration with reconnect
 * replacement, pid-liveness pruning, and the UI control pointer lookup. The
 * supporting state machines live under ./client-registry/:
 *   registration-replays — response-loss replay records and their TTL
 *   client-grace         — self-shutdown grace timer + dead-pid sweep
 *   sse-attach           — binding a client's notify stream
 *
 * Shared transport state read/written here: clients, registrationReplays,
 * pointerToken, everHadClient, closed, remoteAcquired, pinnedSessionId,
 * stickyRemoteFrame.
 */
import { randomUUID } from 'node:crypto';
import { isPidAlive, parsePid } from '../../runtime/shared/pid-liveness.mjs';
import { createClientGrace } from './client-registry/client-grace.mjs';
import {
  createRegistrationReplays,
  replayMatchesCancellation,
  replayMatchesRegistration,
} from './client-registry/registration-replays.mjs';
import { attachClientStream } from './client-registry/sse-attach.mjs';

export function createClientRegistry({
  state,
  log,
  clientGraceMs,
  sweepMs,
  onClientsEmpty,
  onClientRegistered,
  registrationReplayTtlMs,
  publishRemoteState,
}) {
  const { clients } = state;
  const replays = createRegistrationReplays({
    registrationReplays: state.registrationReplays,
    ttlMs: registrationReplayTtlMs,
    onExpiredUnflushed: (token) => dropClient(token, 'unflushed registration replay expired'),
  });
  const grace = createClientGrace({ state, clients, log, clientGraceMs, sweepMs, onClientsEmpty, pruneDeadClients });

  // pid death is the authoritative signal for client liveness: a client whose
  // SSE stream closed may still reconnect, one whose lead pid is gone cannot.
  function pruneDeadClients() {
    for (const [token, c] of clients) {
      if (!isPidAlive(c.leadPid)) dropClient(token, 'pid dead');
    }
  }

  function liveClients() {
    const out = [];
    for (const [token, c] of clients) {
      if (isPidAlive(c.leadPid)) out.push([token, c]);
    }
    return out;
  }

  // Every removal path uses this primitive, including replacement's deliberate
  // no-failover retirement, so replay records/timers never target absent tokens.
  function removeClientRecord(token) {
    const c = clients.get(token);
    if (!c) return null;
    clients.delete(token);
    replays.forgetFor(token);
    try {
      c.sse?.end?.();
    } catch {}
    return c;
  }

  function dropClient(token, reason) {
    const c = clients.get(token);
    if (!c) return;
    removeClientRecord(token);
    if (state.pointerToken === token) state.pointerToken = null;
    log(`client ${token} (lead=${c.leadPid}) removed: ${reason}`);
    // Client presence is not channel authority. The durable session pin stays
    // active until that same session explicitly turns Remote OFF.
    publishRemoteState();
    grace.maybeArm('client removed');
  }

  function cancelReplacementRegistration(request) {
    const replay = replays.lookup(request.registrationId);
    if (!replay) return 'missing';
    if (!replayMatchesCancellation(replay, request)) return 'forbidden';
    dropClient(replay.token, 'replacement deregister');
    return 'cancelled';
  }

  // Resolve the active UI pointer for state delivery only. Session routing
  // never depends on this client.
  function resolveTarget() {
    if (state.pointerToken) {
      const c = clients.get(state.pointerToken);
      if (c && isPidAlive(c.leadPid)) return c;
      if (c) dropClient(state.pointerToken, 'pid dead (notify-time)');
      else state.pointerToken = null;
    }
    return null;
  }

  /** A passive reconnect retrying under a known registration id gets the fresh
   *  token it already created; a different identity under that id is a 409. */
  function replayedToken(replayId, identity) {
    const existing = replays.lookup(replayId);
    if (!existing) return null;
    if (replayMatchesRegistration(existing, identity) && clients.has(existing.token)) {
      replays.arm(replayId, existing);
      log(`client reconnect replay token=${existing.token} lead=${identity.pid}`);
      return existing.token;
    }
    if (clients.has(existing.token)) {
      const err = new Error('registration replay identity mismatch');
      err.statusCode = 409;
      throw err;
    }
    replays.remove(replayId, existing);
    return null;
  }

  /** A reconnect names the exact token it replaces. Token-scoped state belongs
   *  to the logical client, so the fresh record inherits the buffered frame,
   *  remote session and pointer; the old token is retired even when it is not
   *  the pointer — retaining it would let it later call or accumulate a
   *  buffered frame after the fresh client has gone away. */
  function adoptReplacedClient(fresh, replaced) {
    const replacedWasPointer = state.pointerToken === replaced.token;
    if (replaced.pendingRemoteStateFrame) {
      fresh.pendingRemoteStateFrame = replaced.pendingRemoteStateFrame;
      replaced.pendingRemoteStateFrame = null;
    }
    if (replaced.remoteSessionId) fresh.remoteSessionId = replaced.remoteSessionId;
    if (replaced.restoreSessionId) fresh.restoreSessionId = replaced.restoreSessionId;
    if (replacedWasPointer) state.pointerToken = fresh.token;
    removeClientRecord(replaced.token);
    log(`client reconnect replaced token=${replaced.token} -> ${fresh.token} lead=${fresh.leadPid}`);
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
    const restoreId = /^[A-Za-z0-9_-]+$/.test(String(restoreSessionId || '')) ? String(restoreSessionId) : null;
    const replacementToken = replaceToken ? String(replaceToken) : null;
    const replayId = passive && registrationId ? replays.replayIdOf(registrationId) : null;
    const replayed = replayedToken(replayId, { pid, cwd, replacementToken, restoreId });
    if (replayed) return replayed;
    const token = randomUUID();
    const fresh = {
      token,
      leadPid: pid,
      cwd: cwd || null,
      sse: null,
      pendingRemoteStateFrame: null,
      lastSeen: Date.now(),
      registeredAt: Date.now(),
      restoreSessionId: restoreId,
    };
    clients.set(token, fresh);
    if (state.remoteAcquired && restoreId && restoreId === state.pinnedSessionId) fresh.remoteSessionId = restoreId;
    state.everHadClient = true;
    grace.cancel();
    grace.resetBackoff();
    grace.startSweep();
    log(`client registered token=${token} lead=${pid} cwd=${cwd || '-'}`);
    // The unified daemon starts the channels runtime (automation, webhooks,
    // messaging provider) only once a CHANNELS client is actually present — a
    // session runtime-only daemon must not run tunnels nobody asked for.
    if (typeof onClientRegistered === 'function') {
      try {
        onClientRegistered({ token, leadPid: pid, cwd: cwd || null });
      } catch {}
    }
    // Token replacement never crosses leadPid boundaries. Registration is
    // otherwise transport-only, including same-pid fresh attaches.
    const replaced = passive && replacementToken ? clients.get(replacementToken) : null;
    if (replaced && replaced.leadPid === pid) adoptReplacedClient(fresh, replaced);
    if (replayId) {
      replays.remember(replayId, {
        token,
        leadPid: pid,
        cwd: cwd || null,
        replaceToken: replacementToken,
        restoreSessionId: restoreId,
        responseFinished: false,
        timer: null,
      });
    }
    return token;
  }

  function attachSse(token, res) {
    const c = clients.get(token);
    if (!c) return false;
    // A live stream proves the client learned its fresh token, so response-loss
    // cancellation is no longer needed for this logical registration.
    replays.forgetFor(token);
    attachClientStream({
      client: c,
      res,
      // Replay the sticky 'acquired' badge only to the current control client.
      stickyFrame: state.stickyRemoteFrame && token === state.pointerToken ? state.stickyRemoteFrame : null,
      // Stream loss alone does not drop the client (a TUI may reconnect); the
      // sweep + pid check reaps genuinely dead clients.
      onClosed: () => grace.maybeArm('sse closed'),
    });
    return true;
  }

  return {
    liveClients,
    dropClient,
    forgetReplaysFor: replays.forgetFor,
    clearRegistrationReplays: replays.clear,
    markRegistrationResponseFinished: replays.markResponseFinished,
    cancelReplacementRegistration,
    cancelGrace: grace.cancel,
    stopTimers: grace.stopTimers,
    resolveTarget,
    registerClient,
    attachSse,
  };
}
