/**
 * client-registry.mjs — the attached-client registry of the channel
 * transport: the live client records, registration with reconnect
 * replacement, pid-liveness pruning, and the UI control pointer lookup. The
 * supporting state machines live under ./client-registry/:
 *   client-records       — live records, removal, pruning, pointer lookup
 *   client-registration  — registration, replay and reconnect replacement
 *   registration-replays — response-loss replay records and their TTL
 *   client-grace         — self-shutdown grace timer + dead-pid sweep
 *   sse-attach           — binding a client's notify stream
 *
 * Shared transport state read/written here: clients, registrationReplays,
 * pointerToken, everHadClient, closed, remoteAcquired, pinnedSessionId,
 * stickyRemoteFrame.
 */
import { createClientGrace } from './client-registry/client-grace.mjs';
import { createClientRecords } from './client-registry/client-records.mjs';
import { createClientRegistration } from './client-registry/client-registration.mjs';
import { createRegistrationReplays } from './client-registry/registration-replays.mjs';
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
  const grace = createClientGrace({
    state,
    clients,
    log,
    clientGraceMs,
    sweepMs,
    onClientsEmpty,
    pruneDeadClients: () => records.pruneDeadClients(),
  });
  const records = createClientRecords({ state, log, publishRemoteState, replays, grace });
  const { liveClients, dropClient, resolveTarget } = records;
  const { registerClient, cancelReplacementRegistration } = createClientRegistration({
    state,
    log,
    onClientRegistered,
    replays,
    grace,
    records,
  });

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
