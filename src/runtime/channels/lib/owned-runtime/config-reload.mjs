import { loadConfig } from '../config.mjs';

export function createConfigReloader({ state, getConfig, setConfig, getBridgeRuntimeConnected, scheduler, services }) {
  function reloadScheduler() {
    // The scheduler must be RE-ARMED by the reload whenever it is supposed to
    // be running: `restart: false` only destroys the cron/one-shot bindings and
    // hands lifecycle back to the caller, but on an automation-only install
    // startAutomationRuntime() is already past its automationRunning guard, so
    // nobody would call scheduler.start() again and every saved/edited schedule
    // stayed silently disarmed until the daemon restarted.
    scheduler.reloadConfig(getConfig().nonInteractive ?? [], getConfig().interactive ?? [], {
      restart: state.automationRunning || getBridgeRuntimeConnected(),
    });
  }
  return async function reloadRuntimeConfig() {
    setConfig(await loadConfig());
    reloadScheduler();
    if (getBridgeRuntimeConnected() || state.automationRunning) {
      services.syncWebhookAndEventRuntime({ reload: true });
    } else {
      await services.stopWebhookAndEventRuntime();
    }
  };
}
