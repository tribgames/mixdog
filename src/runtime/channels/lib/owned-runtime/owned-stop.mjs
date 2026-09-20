import { stopSnapshotWriter } from '../status-snapshot.mjs';
import { releaseOwnedChannelLocks, clearActiveInstance } from '../runtime-paths.mjs';

export function createOwnedStopper({
  state,
  getProvider,
  getBridgeRuntimeConnected,
  setBridgeRuntimeConnected,
  instanceId,
  scheduler,
  logOwnership,
  services,
}) {
  // Only disconnect when connect() actually completed; disconnecting
  // mid-connect races the connect promise. In-flight outbound sends are
  // drained first (bounded inside drainPendingSends) so a handoff never cuts
  // off a reply mid-delivery.
  async function disconnectConnectedProvider() {
    try {
      await getProvider().drainPendingSends?.();
    } catch {}
    await getProvider().disconnect();
  }
  return async function stopOwnedRuntime(reason) {
    // A start advertises owner metadata and claims channel locks before
    // awaiting connect(); a stop landing in that window (starting=true,
    // connected=false) still has partial state to tear down.
    if (
      !getBridgeRuntimeConnected() &&
      !state.bridgeRuntimeStarting &&
      !state.automationRunning &&
      !state.automationStartPromise
    ) {
      return;
    }
    // Signal an in-flight start to abort right after its connect() resolves;
    // otherwise it would re-mark connected and re-launch scheduler/webhook
    // after the teardown below.
    if (state.bridgeRuntimeStarting || state.automationStartPromise) state.stopRequested = true;
    if (state.automationStartPromise) {
      try {
        await state.automationStartPromise;
      } catch {}
    }
    const wasConnected = getBridgeRuntimeConnected();
    scheduler.stop();
    stopSnapshotWriter();
    await services.stopWebhookAndEventRuntime();
    state.automationRunning = false;
    releaseOwnedChannelLocks(instanceId);
    clearActiveInstance(instanceId);
    try {
      if (wasConnected) await disconnectConnectedProvider();
    } finally {
      setBridgeRuntimeConnected(false);
      logOwnership(`standby: ${reason}`);
    }
  };
}
