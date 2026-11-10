import { startSnapshotWriter } from '../status-snapshot.mjs';
import { refreshActiveInstance, releaseOwnedChannelLocks, clearActiveInstance } from '../runtime-paths.mjs';
import { initAgentProviders } from './automation-start.mjs';

// Release the owner-side adverts a start claimed. Every step is best-effort.
function releaseOwnerAdverts(instanceId) {
  try {
    releaseOwnedChannelLocks(instanceId);
  } catch {}
  try {
    clearActiveInstance(instanceId);
  } catch {}
}

// Daemon model: the machine-global service (singleton-owner lock in
// src/standalone) guarantees exactly one runtime per machine, so this process
// is the unconditional bridge owner — no seat to claim, no takeover handler,
// no cross-process ownership-loss detection. active-instance.json is a pure
// metadata advert.
export function createOwnedStarter({
  state,
  getBridgeRuntimeConnected,
  setBridgeRuntimeConnected,
  getChannelBridgeActive,
  instanceId,
  TERMINAL_LEAD_PID,
  scheduler,
  logOwnership,
  services,
  notifyRemoteAcquired,
}) {
  // Checked after the await in a start so a stopOwnedRuntime() landing
  // mid-start cannot be overridden by the resuming start. Idempotent with the
  // stop's own teardown.
  function bailIfStopRequested() {
    if (!state.stopRequested) return false;
    releaseOwnerAdverts(instanceId);
    setBridgeRuntimeConnected(false);
    state.stopRequested = false;
    return true;
  }
  // Activation after an automation-only start must not double-arm the
  // scheduler/snapshot timers; the webhook/event sync is idempotent.
  function armAutomation() {
    if (!state.automationRunning) {
      scheduler.start();
      startSnapshotWriter(scheduler);
    }
    services.syncWebhookAndEventRuntime();
    state.automationRunning = true;
  }
  async function activateBridge() {
    setBridgeRuntimeConnected(true);
    // Reached only on a not-active -> active transition, so this fires exactly
    // once per activation across every start path.
    notifyRemoteAcquired();
    await initAgentProviders();
    if (bailIfStopRequested()) return;
    armAutomation();
    logOwnership(`active owner lead=${TERMINAL_LEAD_PID} pid=${process.pid}`);
  }
  async function startOwnedRuntime() {
    if (getBridgeRuntimeConnected()) return;
    if (state.bridgeRuntimeStarting) return;
    if (!getChannelBridgeActive()) return;
    state.bridgeRuntimeStarting = true;
    state.stopRequested = false;
    try {
      try {
        refreshActiveInstance(instanceId);
      } catch (e) {
        process.stderr.write(`mixdog: metadata advert aborted (${e instanceof Error ? e.message : String(e)})\n`);
        return;
      }
      try {
        await activateBridge();
      } catch (e) {
        process.stderr.write(
          `mixdog: bridge start failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`
        );
        // Roll back the owner-side state advertised before the start.
        releaseOwnerAdverts(instanceId);
        setBridgeRuntimeConnected(false);
      }
    } finally {
      state.bridgeRuntimeStarting = false;
    }
  }
  return { startOwnedRuntime };
}
