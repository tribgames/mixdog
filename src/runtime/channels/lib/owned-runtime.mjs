// Owned-runtime lifecycle: bridge activation, automation runtime (scheduler +
// webhook/event runtime) and config hot-reload. The phases live under
// owned-runtime/ and share one explicit state object; config /
// bridgeRuntimeConnected / webhookServer / eventPipeline stay on the worker
// (get/set) so file-level reference semantics are preserved.
import { createOwnedRuntimeState } from './owned-runtime/state.mjs';
import { createAutomationServices } from './owned-runtime/automation-services.mjs';
import { createAutomationStarter } from './owned-runtime/automation-start.mjs';
import { createOwnedStarter } from './owned-runtime/owned-start.mjs';
import { createOwnedStopper } from './owned-runtime/owned-stop.mjs';
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
    notifyRemoteAcquired,
  });
  const stopOwnedRuntime = createOwnedStopper({ ...deps, state, services });
  const reloadRuntimeConfig = createConfigReloader({ ...deps, state, services });
  return {
    startAutomationRuntime,
    startOwnedRuntime,
    stopOwnedRuntime,
    reloadRuntimeConfig,
    notifyRemoteAcquired,
  };
}
