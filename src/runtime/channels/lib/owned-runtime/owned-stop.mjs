import { stopSnapshotWriter } from '../status-snapshot.mjs';
import { releaseOwnedChannelLocks, clearActiveInstance } from '../runtime-paths.mjs';

export function createOwnedStopper({
  state,
  getBridgeRuntimeConnected,
  setBridgeRuntimeConnected,
  instanceId,
  scheduler,
  logOwnership,
  services,
}) {
  return async function stopOwnedRuntime(reason) {
    // A start advertises owner metadata and claims channel locks before
    // it finishes; a stop landing in that window (starting=true,
    // connected=false) still has partial state to tear down.
    if (
      !getBridgeRuntimeConnected() &&
      !state.bridgeRuntimeStarting &&
      !state.automationRunning &&
      !state.automationStartPromise
    ) {
      return;
    }
    // Signal an in-flight start to abort at its next checkpoint; otherwise it
    // would re-launch scheduler/webhook after the teardown below.
    if (state.bridgeRuntimeStarting || state.automationStartPromise) state.stopRequested = true;
    if (state.automationStartPromise) {
      try {
        await state.automationStartPromise;
      } catch {}
    }
    scheduler.stop();
    stopSnapshotWriter();
    await services.stopWebhookAndEventRuntime();
    state.automationRunning = false;
    releaseOwnedChannelLocks(instanceId);
    clearActiveInstance(instanceId);
    setBridgeRuntimeConnected(false);
    logOwnership(`standby: ${reason}`);
  };
}
