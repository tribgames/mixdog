// Owned-runtime lifecycle: provider connect/disconnect, automation runtime
// (scheduler + webhook/event runtime), ownership refresh and config
// hot-reload. The phases live under owned-runtime/ and share one explicit
// state object; config / provider / bridgeRuntimeConnected / webhookServer /
// eventPipeline stay on the worker (get/set) so file-level reference
// semantics are preserved.
import { createOwnedRuntimeState } from './owned-runtime/state.mjs';
import { createAutomationServices } from './owned-runtime/automation-services.mjs';
import { createAutomationStarter } from './owned-runtime/automation-start.mjs';
import { createOwnedStarter } from './owned-runtime/owned-start.mjs';
import { createOwnedStopper } from './owned-runtime/owned-stop.mjs';
import { createOwnershipRefresh } from './owned-runtime/ownership-refresh.mjs';
import { createConfigReloader } from './owned-runtime/config-reload.mjs';

export function createOwnedRuntime(deps) {
  const state = createOwnedRuntimeState();
  const services = createAutomationServices(deps);
  // Tell the parent session this worker ACQUIRED the bridge so it flips remote
  // mode ON. Fired only on a genuine not-connected -> connected transition via
  // the sink-aware path, so the daemon replays it to every TUI.
  function notifyRemoteAcquired() {
    deps.sendNotifyToParent('notifications/mixdog/remote', { state: 'acquired' });
  }
  const startAutomationRuntime = createAutomationStarter({ state, scheduler: deps.scheduler, services });
  const { startOwnedRuntime } = createOwnedStarter({
    ...deps,
    state,
    services,
    startAutomationRuntime,
    notifyRemoteAcquired,
  });
  const stopOwnedRuntime = createOwnedStopper({ ...deps, state, services });
  const { refreshBridgeOwnership, refreshBridgeOwnershipSafe } = createOwnershipRefresh({
    ...deps,
    state,
    startOwnedRuntime,
    stopOwnedRuntime,
  });
  const reloadRuntimeConfig = createConfigReloader({
    ...deps,
    state,
    services,
    stopOwnedRuntime,
    refreshBridgeOwnershipSafe,
  });
  // Daemon model: no ownership timer or takeover handler. Kept as no-ops so
  // the worker start()/teardown call sites stay unchanged.
  const armBridgeOwnershipTimer = () => {};
  const clearBridgeOwnershipTimer = () => {};
  return {
    startAutomationRuntime,
    startOwnedRuntime,
    stopOwnedRuntime,
    refreshBridgeOwnership,
    refreshBridgeOwnershipSafe,
    reloadRuntimeConfig,
    armBridgeOwnershipTimer,
    clearBridgeOwnershipTimer,
    notifyRemoteAcquired,
  };
}
