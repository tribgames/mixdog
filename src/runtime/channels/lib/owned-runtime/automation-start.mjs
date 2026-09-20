import { startSnapshotWriter } from '../status-snapshot.mjs';
import { initProviders } from '../../../agent/orchestrator/providers/registry.mjs';
import { loadConfig as loadAgentConfig } from '../../../agent/orchestrator/config.mjs';

// The provider registry must be populated before scheduler.start(); otherwise
// the scheduler's first fire can return `Provider "<name>" not found`.
// Failure is non-fatal: the owned runtime keeps going without the registry.
export async function initAgentProviders() {
  try {
    const agentCfg = loadAgentConfig();
    await initProviders(agentCfg.providers || {});
  } catch (e) {
    process.stderr.write(`mixdog: initProviders failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// Automation-only start: scheduler + snapshot writer + webhook/event runtime
// without a messaging provider. Used for installs with no provider and as the
// degraded fallback when the provider connect fails.
export function createAutomationStarter({ state, scheduler, services }) {
  return async function startAutomationRuntime() {
    if (state.automationRunning) {
      services.syncWebhookAndEventRuntime();
      return;
    }
    if (state.automationStartPromise) return state.automationStartPromise;
    if (!state.bridgeRuntimeStarting) state.stopRequested = false;
    const run = (async () => {
      await initAgentProviders();
      if (state.stopRequested) return;
      scheduler.start();
      startSnapshotWriter(scheduler);
      services.syncWebhookAndEventRuntime();
      state.automationRunning = true;
      process.stderr.write('mixdog: automation runtime up without messaging provider\n');
    })();
    state.automationStartPromise = run;
    try {
      return await run;
    } finally {
      if (state.automationStartPromise === run) state.automationStartPromise = null;
    }
  };
}
