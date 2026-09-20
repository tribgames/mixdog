/**
 * session-transport/client-registry.mjs — the attached-client registry:
 * registration (with timed-out-registration replay, see
 * client-registry/registration-replays), drop, and the dead-lead sweep plus
 * no-clients grace timer (client-registry/client-grace).
 */
import { randomUUID } from 'node:crypto';
import { parsePid } from '../../runtime/shared/pid-liveness.mjs';
import { createRegistrationReplays } from './client-registry/registration-replays.mjs';
import { createClientGrace } from './client-registry/client-grace.mjs';

export function createClientRegistry({
  log,
  nowMs,
  clientGraceMs,
  sweepMs,
  onClientsEmpty,
  onClientRegistered,
  onClientDropped,
}) {
  // token -> { token, leadPid, cwd, lifecycle, sse, pending, lastSeen }
  const clients = new Map();
  let closed = false;
  const replays = createRegistrationReplays({ clients, log });
  const grace = createClientGrace({
    clients,
    log,
    clientGraceMs,
    sweepMs,
    onClientsEmpty,
    isClosed: () => closed,
    dropClient: (token, reason) => dropClient(token, reason),
  });

  function removeClientRecord(token) {
    const c = clients.get(token);
    if (!c) return;
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

  function register({
    leadPid,
    cwd,
    lifecycle = true,
    clientKind = 'session',
    registrationId = null,
    revision = 0,
  } = {}) {
    const identity = {
      leadPid: parsePid(leadPid) || 0,
      cwd: cwd || null,
      lifecycle: lifecycle !== false,
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
      sse: null,
      // True while the socket asked us to stop writing (see writeFrame).
      paused: false,
      // Frames are latest-wins per key while a client has no stream: a
      // reconnecting viewer wants the CURRENT snapshot, never a backlog.
      pending: new Map(),
      pendingBytes: 0,
      lastSeen: nowMs(),
    });
    if (identity.lifecycle) grace.noteLifecycleClient();
    grace.startSweep();
    log(
      `client registered token=${token} lead=${identity.leadPid} cwd=${identity.cwd || '-'}` +
        ` lifecycle=${identity.lifecycle} kind=${identity.clientKind}`
    );
    if (typeof onClientRegistered === 'function') {
      try {
        onClientRegistered({
          token,
          leadPid: identity.leadPid,
          cwd: identity.cwd,
          lifecycle: identity.lifecycle,
          clientKind: identity.clientKind,
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
    close,
  };
}
