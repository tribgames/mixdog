import { startSnapshotWriter } from '../status-snapshot.mjs';
import { refreshActiveInstance, releaseOwnedChannelLocks, clearActiveInstance } from '../runtime-paths.mjs';
import { initAgentProviders } from './automation-start.mjs';

// Tear down the provider THIS start connected plus the owner-side adverts it
// claimed. Every step is best-effort so a half-open gateway cannot block it.
async function releaseStartingProvider(startingProvider, instanceId) {
  try {
    await startingProvider.disconnect();
  } catch {}
  try {
    releaseOwnedChannelLocks(instanceId);
  } catch {}
  try {
    clearActiveInstance(instanceId);
  } catch {}
}

// Mark a start as in flight and hand back the settle function that clears
// the marker and wakes anyone awaiting state.inFlightStart.
function openInFlightStart(state) {
  let settle;
  state.bridgeRuntimeStarting = true;
  state.stopRequested = false;
  state.inFlightStart = new Promise((resolve) => {
    settle = resolve;
  });
  return () => {
    state.bridgeRuntimeStarting = false;
    state.inFlightStart = null;
    const done = settle;
    settle = null;
    done?.();
  };
}

// Daemon model: the machine-global service (singleton-owner lock in
// src/standalone) guarantees exactly one runtime per machine, so this process
// is the unconditional bridge owner — no seat to claim, no takeover handler,
// no cross-process ownership-loss detection. active-instance.json is a pure
// metadata advert.
export function createOwnedStarter({
  state,
  getProvider,
  getBridgeRuntimeConnected,
  setBridgeRuntimeConnected,
  getChannelBridgeActive,
  instanceId,
  TERMINAL_LEAD_PID,
  scheduler,
  logOwnership,
  services,
  startAutomationRuntime,
  notifyRemoteAcquired,
}) {
  // Explicit restore path for an already-connected owner. Reserved for
  // explicit activation/reload recovery: re-binding status on every tick
  // could move the transcript cursor to EOF, and probing the gateway during
  // the provider's own reconnect window can reset a healthy reconnect loop.
  async function selfHealOwnedRuntime(options = {}) {
    if (options.resetProvider !== true) return;
    if (state.selfHealing) return;
    state.selfHealing = true;
    try {
      if (typeof getProvider()?._resetClient === 'function') {
        await getProvider()
          ._resetClient()
          .catch((e) => {
            process.stderr.write(
              `mixdog: self-heal provider reset failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`
            );
          });
      }
    } finally {
      state.selfHealing = false;
    }
  }
  // Re-checked after each post-connect await so a stopOwnedRuntime() landing
  // mid-start cannot be overridden by the resuming start. Idempotent with the
  // stop's own teardown: it covers both the pre-connected window (stop could
  // not disconnect an in-flight provider) and the post-connected one.
  async function bailIfStopRequested(startingProvider) {
    if (!state.stopRequested) return false;
    await releaseStartingProvider(startingProvider, instanceId);
    setBridgeRuntimeConnected(false);
    state.stopRequested = false;
    return true;
  }
  // Reconnect after a degraded (automation-only) start must not double-arm
  // the scheduler/snapshot timers; the webhook/event sync is idempotent.
  function armAutomation() {
    if (!state.automationRunning) {
      scheduler.start();
      startSnapshotWriter(scheduler);
    }
    services.syncWebhookAndEventRuntime();
    state.automationRunning = true;
  }
  // DEGRADED MODE: a messaging connect failure — packaged runtime without
  // discord.js, bad token, gateway outage — must not take schedules/webhooks
  // down with it. Sends stay dead (connected=false) but session runs, the
  // webhook server and the relay tunnel keep working.
  async function degradeToAutomation() {
    if (state.stopRequested) return;
    // Already degraded-started by an earlier attempt; this run was only a
    // messaging reconnect retry.
    if (state.automationRunning) return;
    try {
      await startAutomationRuntime();
    } catch (e) {
      process.stderr.write(`mixdog: degraded automation start failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  async function connectAndArm(startingProvider) {
    // Awaited so callers (and bindingReady) only resolve after the binding is
    // real; a fire-and-forget connect let bindingReady fire before listeners
    // were attached.
    await startingProvider.connect();
    if (await bailIfStopRequested(startingProvider)) return;
    try {
      refreshActiveInstance(instanceId, { providerReady: true });
    } catch {}
    setBridgeRuntimeConnected(true);
    // Reached only on a not-connected -> connected transition, so this fires
    // exactly once per connect across every start path (boot + reload restart
    // + activate). Notifying post-connect means a connect failure leaves the
    // parent non-remote instead of remote-with-no-bridge.
    notifyRemoteAcquired();
    await initAgentProviders();
    if (await bailIfStopRequested(startingProvider)) return;
    armAutomation();
    process.stderr.write(`mixdog: running with ${getProvider().name} provider\n`);
    logOwnership(`active owner lead=${TERMINAL_LEAD_PID} pid=${process.pid}`);
  }
  async function startOwnedRuntime(options = {}) {
    if (getBridgeRuntimeConnected()) {
      if (!state.bridgeRuntimeStarting) await selfHealOwnedRuntime(options);
      return;
    }
    if (state.bridgeRuntimeStarting) return;
    if (!getChannelBridgeActive()) return;
    const settleInFlightStart = openInFlightStart(state);
    // Capture the provider THIS start connects: a reload hot-swap can replace
    // the worker's provider while connect() is pending, and using the captured
    // instance for both connect() and the bail/failure disconnect guarantees
    // we tear down the one we started (closing the both-providers-live window).
    const startingProvider = getProvider();
    try {
      refreshActiveInstance(instanceId, { providerReady: false });
    } catch (e) {
      settleInFlightStart();
      process.stderr.write(
        `mixdog: pre-connect metadata advert aborted (${e instanceof Error ? e.message : String(e)})\n`
      );
      return;
    }
    try {
      await connectAndArm(startingProvider);
    } catch (e) {
      process.stderr.write(
        `mixdog: provider connect failed (non-fatal, cycle1/MCP still up): ${e instanceof Error ? e.message : String(e)}\n`
      );
      // Roll back the owner-side state advertised before connect() ran; a
      // post-connect step may have thrown while the gateway is live.
      await releaseStartingProvider(startingProvider, instanceId);
      await degradeToAutomation();
    } finally {
      settleInFlightStart();
    }
  }
  return { startOwnedRuntime };
}
