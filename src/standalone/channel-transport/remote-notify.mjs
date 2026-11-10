/**
 * remote-notify.mjs — worker→parent notify routing of the channel transport.
 * Notifications reach the CORRECT attached TUI (targeted routing through the
 * UI control pointer, never broadcast), except the remote-state signal, which
 * is handed to the pointer/badge owner in ./remote-pointer.mjs: 'acquired' is
 * cached as the sticky badge for the control client, any other transition
 * clears it and is broadcast to every live client.
 *
 * Shared transport state read here: clients (through resolveTarget).
 */
import { REMOTE_STATE_METHOD } from './remote-binding.mjs';
import { createRemotePointer } from './remote-pointer.mjs';

export function createRemoteNotify({ state, log, clearRemoteIntent, publishRemoteState, resolveTarget, liveClients }) {
  const { writeRemoteStateTo, movePointer, notifyRemoteState } = createRemotePointer({
    state,
    log,
    clearRemoteIntent,
    publishRemoteState,
    resolveTarget,
    liveClients,
  });

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
