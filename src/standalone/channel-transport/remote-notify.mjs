/**
 * remote-notify.mjs — worker→parent notify routing of the channel transport.
 * Notifications reach the CORRECT attached TUI (targeted routing through the
 * UI control pointer, never broadcast), except the remote-state signal:
 * 'acquired' is cached as the sticky badge for the control client, any other
 * transition clears it and is broadcast to every live client.
 *
 * Shared transport state read/written here: clients, pointerToken,
 * remoteAcquired, stickyRemoteFrame, pinnedSessionId.
 */
import { isPidAlive } from '../../runtime/shared/pid-liveness.mjs';
import { REMOTE_STATE_METHOD, remoteStateFrame } from './remote-binding.mjs';

export function createRemoteNotify({ state, log, clearRemoteIntent, publishRemoteState, resolveTarget, liveClients }) {
  const { clients } = state;

  // Write a targeted remote-state frame to ONE client's SSE. If that client has
  // no live stream yet (e.g. displaced mid-reconnect), BUFFER the frame on its
  // pending queue and flush it when the stream (re)attaches — otherwise the
  // 'superseded' signal is silently lost and the displaced UI keeps its badge.
  function writeRemoteStateTo(client, remoteState) {
    if (!client) return false;
    const frame = remoteStateFrame(remoteState);
    if (!client.sse) {
      // This is state, not an event log. Control-state churn before an SSE
      // reconnect only needs the newest transition; retaining every displaced
      // frame lets one disconnected client grow without bound.
      client.pendingRemoteStateFrame = frame;
      return true;
    }
    try {
      client.sse.write(`data: ${frame}\n\n`);
      return true;
    } catch (err) {
      log(`remote-state '${remoteState}' write failed for lead=${client.leadPid}: ${err?.message || err}`);
      return false;
    }
  }

  // Manual ON may temporarily select its control client before provider
  // activation so a synchronous acquired state reaches the right UI.
  function movePointer(newToken, reason, { notifyDisplaced = true } = {}) {
    const oldToken = state.pointerToken;
    if (oldToken === newToken) {
      state.pointerToken = newToken;
      publishRemoteState();
      return oldToken;
    }
    state.pointerToken = newToken;
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

  function notifyRemoteState(method, params) {
    const frame = JSON.stringify({ type: 'notify', method, params });
    if (params?.state === 'acquired') {
      // Cache the standing badge state even with zero clients. A control
      // client receives the immediate state; session routing is independent.
      const target = resolveTarget();
      if (!target) {
        if (!state.pinnedSessionId) {
          log('remote-state acquired ignored (no pinned session)');
          return false;
        }
        state.remoteAcquired = true;
        state.stickyRemoteFrame = frame;
        publishRemoteState();
        log(`remote-state acquired for session=${state.pinnedSessionId}`);
        return true;
      }
      state.remoteAcquired = true;
      state.stickyRemoteFrame = frame;
      publishRemoteState();
      if (!target.sse) {
        log('remote-state acquired not delivered (control client has no SSE); sticky set');
        return false;
      }
      try {
        target.sse.write(`data: ${frame}\n\n`);
        return true;
      } catch (err) {
        log(`remote-state acquired write failed for lead=${target.leadPid}: ${err?.message || err}`);
        return false;
      }
    }
    // 'superseded' (seat lost to ANOTHER daemon, owned-runtime.mjs) and any
    // other transition CLEAR the sticky and broadcast to every live client —
    // whoever holds the badge must drop it; replaying it to a future attach
    // would wrongly stop a fresh remote client.
    state.remoteAcquired = false;
    state.stickyRemoteFrame = null;
    clearRemoteIntent('remote superseded');
    publishRemoteState();
    let delivered = false;
    for (const [, c] of liveClients()) {
      if (!c.sse) continue;
      try {
        c.sse.write(`data: ${frame}\n\n`);
        delivered = true;
      } catch (err) {
        log(`remote-state write failed for lead=${c.leadPid}: ${err?.message || err}`);
      }
    }
    if (!delivered) log('remote-state superseded not delivered live (no live SSE); sticky cleared');
    return delivered;
  }

  function notify(method, params) {
    if (method === REMOTE_STATE_METHOD) return notifyRemoteState(method, params);
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

  return { writeRemoteStateTo, movePointer, notify };
}
