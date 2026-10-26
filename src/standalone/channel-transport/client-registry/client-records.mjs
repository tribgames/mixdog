// The live client records of the channel transport: pid-liveness reads and
// pruning, the one removal primitive every path uses, and the UI control
// pointer lookup. `replays` and `grace` are the registry's replay records and
// self-shutdown grace timer.
import { isPidAlive } from '../../../runtime/shared/pid-liveness.mjs';

export function createClientRecords({ state, log, publishRemoteState, replays, grace }) {
  const { clients } = state;

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
    } catch {
      // The stream may already be closed by the peer.
    }
    return c;
  }

  function dropClient(token, reason) {
    const c = removeClientRecord(token);
    if (!c) return;
    if (state.pointerToken === token) state.pointerToken = null;
    log(`client ${token} (lead=${c.leadPid}) removed: ${reason}`);
    // Client presence is not channel authority. The durable session pin stays
    // active until that same session explicitly turns Remote OFF.
    publishRemoteState();
    grace.maybeArm('client removed');
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

  return { pruneDeadClients, liveClients, removeClientRecord, dropClient, resolveTarget };
}
