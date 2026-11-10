/**
 * remote-state.mjs — publication of the DERIVED remote-session state (is Remote
 * enabled, for which session, in which cwd) to its two observers: the injected
 * listener and the state file. Publication is idempotent: an unchanged state is
 * never re-announced and never rewritten.
 *
 * Shared transport state read here: remoteAcquired, pinnedSessionId,
 * pointerToken, clients, remoteIntent.
 */
import { writeJsonAtomicSync } from '../../runtime/shared/atomic-file.mjs';

export function createRemoteStatePublisher({ state, log, remoteStatePath, onRemoteStateChange }) {
  let remoteStateSignature = '';

  return function publishRemoteState() {
    const pointerClient = state.pointerToken ? state.clients.get(state.pointerToken) : null;
    const sessionId = String(state.remoteAcquired ? state.pinnedSessionId : '');
    const remoteState = {
      enabled: state.remoteAcquired === true && Boolean(sessionId),
      sessionId: state.remoteAcquired === true && sessionId ? sessionId : null,
      cwd: pointerClient?.cwd ?? state.remoteIntent?.cwd ?? null,
      daemonPid: process.pid,
      updatedAt: Date.now(),
    };
    const signature = JSON.stringify([
      remoteState.enabled,
      remoteState.sessionId,
      remoteState.cwd,
      remoteState.daemonPid,
    ]);
    if (signature === remoteStateSignature) return;
    remoteStateSignature = signature;
    if (typeof onRemoteStateChange === 'function') {
      try {
        onRemoteStateChange(remoteState);
      } catch (err) {
        log(`remote session state listener failed: ${err?.message || err}`);
      }
    }
    if (!remoteStatePath) return;
    try {
      writeJsonAtomicSync(remoteStatePath, remoteState, { compact: true });
    } catch (err) {
      log(`remote session state write failed: ${err?.message || err}`);
    }
  };
}
