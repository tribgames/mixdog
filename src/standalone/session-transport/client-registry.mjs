/**
 * session-transport/client-registry.mjs — the attached-client registry:
 * registration (with timed-out-registration replay, see
 * client-registry/registration-replays), drop, and each client's lease
 * deadline plus the no-clients grace timer (client-registry/client-grace).
 */
import { randomUUID } from 'node:crypto';
import { parsePid } from '../../runtime/shared/pid-liveness.mjs';
import { createRegistrationReplays } from './client-registry/registration-replays.mjs';
import { createClientGrace, clampLeaseMs } from './client-registry/client-grace.mjs';

export function createClientRegistry({ log, nowMs, clientGraceMs, onClientsEmpty, onClientRegistered, onClientDropped }) {
  // token -> { token, leadPid, cwd, lifecycle, remote, leaseMs, leaseTimer, sse, pending, lastSeen }
  const clients = new Map();
  let closed = false;
  const replays = createRegistrationReplays({ clients, log });
  const grace = createClientGrace({
    clients,
    log,
    clientGraceMs,
    onClientsEmpty,
    isClosed: () => closed,
    dropClient: (token, reason) => dropClient(token, reason),
  });

  function removeClientRecord(token) {
    const c = clients.get(token);
    if (!c) return;
    grace.clearLease(c);
    if (c.lifecycle) grace.noteLifecycleDropped(c);
    try {
      c.sse?.end?.();
    } catch {}
    clients.delete(token);
    replays.forgetFor(token);
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
    grace.maybeArm(reason);
  }

  /** Refresh a client's lease clock (heartbeat). False for an unknown token. */
  function touch(token) {
    const c = clients.get(token);
    if (!c) return false;
    c.lastSeen = nowMs();
    grace.noteTouched(c);
    return true;
  }

  /** The frame stream attached a response for `token`. */
  function noteStreamAttached(token) {
    const c = clients.get(token);
    if (c) grace.noteStreamAttached(c);
  }

  /** A /call of `token` started or settled: a call in flight holds its lease. */
  function noteCallStarted(token) {
    const c = clients.get(token);
    if (c) grace.noteCallStarted(c);
  }

  function noteCallSettled(token) {
    const c = clients.get(token);
    if (c) grace.noteCallSettled(c);
  }

  /** A response of `token` closed (the client's `sse` says whether another
   *  already replaced it). */
  function noteStreamClosed(token) {
    const c = clients.get(token);
    if (c) grace.noteStreamClosed(c);
    grace.maybeArm('sse closed');
  }

  function register({
    leadPid,
    cwd,
    lifecycle = true,
    clientKind = 'session',
    registrationId = null,
    revision = 0,
    remote = false,
    leaseMs,
  } = {}) {
    const identity = {
      leadPid: parsePid(leadPid) || 0,
      cwd: cwd || null,
      lifecycle: lifecycle !== false,
      remote: remote === true,
      clientKind: clientKind === 'desktop' ? 'desktop' : 'session',
      revision: Math.max(0, Number(revision) || 0),
    };
    const replayId = registrationId ? String(registrationId).slice(0, 200) : null;
    const replayed = replays.replayedToken(replayId, identity);
    if (replayed) return replayed;
    const token = randomUUID();
    clients.set(token, {
      token,
      ...identity,
      leaseMs: clampLeaseMs(leaseMs),
      sse: null,
      // True while the socket asked us to stop writing (see writeFrame).
      paused: false,
      // Frames are latest-wins per key while a client has no stream: a
      // reconnecting viewer wants the CURRENT snapshot, never a backlog.
      pending: new Map(),
      pendingBytes: 0,
      lastSeen: nowMs(),
      leaseTimer: null,
      callsInFlight: 0,
    });
    if (identity.lifecycle) grace.noteLifecycleClient();
    grace.noteRegistered(clients.get(token));
    log(
      `client registered token=${token} lead=${identity.leadPid} cwd=${identity.cwd || '-'}` +
        ` lifecycle=${identity.lifecycle} kind=${identity.clientKind}` +
        (identity.remote ? ` remote leaseMs=${clients.get(token).leaseMs}` : '')
    );
    if (typeof onClientRegistered === 'function') {
      try {
        onClientRegistered({
          token,
          leadPid: identity.leadPid,
          cwd: identity.cwd,
          lifecycle: identity.lifecycle,
          clientKind: identity.clientKind,
          ...(identity.remote ? { remote: true } : {}),
        });
      } catch {}
    }
    if (replayId) replays.remember(replayId, token, identity);
    return token;
  }

  function close() {
    closed = true;
    grace.stopTimers();
    replays.clear();
    for (const token of [...clients.keys()]) removeClientRecord(token);
  }

  return {
    clients,
    lifecycleClientCount: grace.lifecycleClientCount,
    cancelGrace: grace.cancel,
    maybeArmGrace: grace.maybeArm,
    forgetReplaysFor: replays.forgetFor,
    dropClient,
    register,
    touch,
    noteStreamAttached,
    noteStreamClosed,
    noteCallStarted,
    noteCallSettled,
    close,
  };
}
