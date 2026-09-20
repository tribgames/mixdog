import { loadConfig, createProvider } from '../config.mjs';

function describeProviderChange(previous, next) {
  const typeChanged = (next?.name || '') !== (previous?.name || '');
  const credentialsChanged = !typeChanged && String(next?.token || '') !== String(previous?.token || '');
  return { typeChanged, changed: typeChanged || credentialsChanged };
}

export function createConfigReloader({
  state,
  getConfig,
  setConfig,
  getProvider,
  setProvider,
  getBridgeRuntimeConnected,
  scheduler,
  statusState,
  services,
  stopOwnedRuntime,
  refreshBridgeOwnershipSafe,
}) {
  function reloadScheduler() {
    // The scheduler must be RE-ARMED by the reload whenever it is supposed to
    // be running: `restart: false` only destroys the cron/one-shot bindings and
    // hands lifecycle back to the caller, but on an automation-only install
    // startAutomationRuntime() is already past its automationRunning guard, so
    // nobody would call scheduler.start() again and every saved/edited schedule
    // stayed silently disarmed until the daemon restarted.
    scheduler.reloadConfig(getConfig().nonInteractive ?? [], getConfig().interactive ?? [], getConfig().channelId, {
      restart: state.automationRunning || getBridgeRuntimeConnected(),
    });
  }
  async function swapProvider(nextProvider, typeChanged) {
    const shouldRestart = getBridgeRuntimeConnected() || state.bridgeRuntimeStarting;
    if (shouldRestart) await stopOwnedRuntime('provider config changed');
    // A start in flight when the stop landed was signalled to bail (and
    // disconnects the OLD provider). Wait for it to FULLY settle before the
    // fresh start below, or startOwnedRuntime's in-flight guard would drop the
    // restart and the NEW provider would never connect (lost-restart race).
    if (state.inFlightStart) {
      try {
        await state.inFlightStart;
      } catch {}
    }
    setProvider(nextProvider);
    // A provider-type change wipes the persisted routing ids; messaging is
    // retired, so only the status snapshot needs clearing.
    if (typeChanged) {
      try {
        statusState.update((snapshot) => {
          snapshot.channelId = '';
          snapshot.transcriptPath = '';
        });
      } catch {}
    }
    if (shouldRestart) refreshBridgeOwnershipSafe({ restoreBinding: !typeChanged });
  }
  return async function reloadRuntimeConfig() {
    const previousProvider = getProvider();
    // File-watch/tool-triggered reloads bypass the short keychain hit cache:
    // another process may have just saved or rotated the channel credential.
    setConfig(await loadConfig({ freshSecrets: true }));
    reloadScheduler();
    const nextProvider = createProvider(getConfig());
    const change = describeProviderChange(previousProvider, nextProvider);
    if (change.changed) {
      await swapProvider(nextProvider, change.typeChanged);
    } else if (nextProvider !== previousProvider) {
      try {
        await nextProvider.disconnect?.();
      } catch {}
    }
    if (getBridgeRuntimeConnected() || state.automationRunning) {
      services.syncWebhookAndEventRuntime({ reload: true });
    } else {
      await services.stopWebhookAndEventRuntime();
    }
  };
}
