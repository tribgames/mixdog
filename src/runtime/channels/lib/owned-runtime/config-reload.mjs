import { loadConfig } from '../config.mjs';

export function createConfigReloader({
  state,
  getConfig,
  setConfig,
  getBridgeRuntimeConnected,
  scheduler,
  services,
  load = loadConfig,
}) {
  // Reloads overlap (no debounce), so a slower load of an older config must not
  // be applied over a newer one: only the newest started reload applies, and an
  // older caller waits for it instead.
  let latestStarted = 0;
  let latestReload = null;
  function reloadScheduler() {
    // The scheduler must be RE-ARMED by the reload whenever it is supposed to
    // be running: `restart: false` only destroys the cron/one-shot bindings and
    // hands lifecycle back to the caller, but on an automation-only install
    // startAutomationRuntime() is already past its automationRunning guard, so
    // nobody would call scheduler.start() again and every saved/edited schedule
    // stayed silently disarmed until the daemon restarted.
    scheduler.reloadConfig(getConfig().schedules ?? [], {
      restart: state.automationRunning || getBridgeRuntimeConnected(),
    });
  }
  return function reloadRuntimeConfig() {
    const ticket = ++latestStarted;
    const run = (async () => {
      const loaded = await load();
      if (ticket !== latestStarted) return latestReload;
      setConfig(loaded);
      reloadScheduler();
      if (getBridgeRuntimeConnected() || state.automationRunning) {
        services.syncWebhookAndEventRuntime({ reload: true });
      } else {
        await services.stopWebhookAndEventRuntime();
      }
    })();
    latestReload = run;
    return run;
  };
}
