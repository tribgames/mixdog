// Boot stage 3: the initial config/route state, the runtime scalars, the
// timer/prewarm holders teardown sweeps, and the env-tunable boot delays.
import { performance } from 'node:perf_hooks';
import { setConfiguredShell } from '../../runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs';
import { LOCAL_PROVIDER_ID, configureLocalProviderIdleTtl } from '../../runtime/local-provider/managed-runtime.mjs';
import { normalizeToolMode } from '../effort.mjs';
import { normalizeSystemShellConfig } from '../config-helpers.mjs';
import { flushPendingSessionConfigWrites, resolveInitialConfigState } from '../config-lifecycle.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { createHookPayload } from '../hook-payload.mjs';
import { readRuntimeTunables } from '../runtime-tunables.mjs';
import { resolveRoute } from './shared.mjs';

export async function resolveConfig(boot) {
  const { rt, params, cfgMod, sharedCfgMod } = boot;
  const configStartedAt = performance.now();
  await flushPendingSessionConfigWrites();
  await sharedCfgMod.pendingConfigWrites();
  sharedCfgMod.invalidateConfigReadCache();
  ({
    config: rt.config,
    route: rt.route,
    webSearchRoute: rt.webSearchRoute,
  } = resolveInitialConfigState({
    initialConfig: params.initialConfig,
    loadConfig: () => cfgMod.loadConfig({ secrets: false }),
    resolveRoute,
    provider: params.provider,
    model: params.model,
    effort: params.effort,
    fast: params.fast,
    modelParameters: params.modelParameters,
  }));
  configureLocalProviderIdleTtl(rt.config.providers?.[LOCAL_PROVIDER_ID]?.idleTtlSeconds);
  setConfiguredShell(normalizeSystemShellConfig(rt.config.shell).command);
  rt.configHasSecrets = false;
  bootProfile('config:ready', { ms: (performance.now() - configStartedAt).toFixed(1) });
  initRuntimeState(rt, params);
  const { hookCommonPayload } = createHookPayload({ rt, cfgMod });
  Object.assign(boot, {
    warmupTimers: {
      providerSetupWarmupTimer: null,
      providerWarmupTimer: null,
      providerModelWarmupTimer: null,
      modelCatalogWarmupTimer: null,
      statuslineUsageWarmupTimer: null,
      statuslineUsageRefreshTimer: null,
    },
    // Prewarm/channel-start timer handles + async state, owned here so the
    // teardown clearTimeout sweep still sees them; the prewarm scheduler
    // factory mutates these objects in place (see createPrewarmSchedulers).
    prewarmTimers: {
      codeGraphPrewarmTimer: null,
      channelStartTimer: null,
      searchRuntimeWarmupTimer: null,
    },
    prewarmState: {
      codeGraphPrewarmInFlight: false,
      codeGraphPrewarmQueuedCwd: '',
      channelStartPromise: null,
    },
    ...activeTurnControls(rt),
    hookCommonPayload,
    // Env-tunable boot delays and feature gates: runtime-tunables.mjs.
    tunables: readRuntimeTunables(),
    notificationListeners: new Set(),
  });
}

function initRuntimeState(rt, params) {
  rt.mode = normalizeToolMode(params.toolMode);
  rt.session = null;
  // A daemon-issued address may exist before provider setup. It is consumed by
  // createCurrentSession on the first actual turn, avoiding eager auth/model
  // work while still giving submit a stable session key.
  rt.reservedSessionId = null;
  rt.sessionCreatePromise = null;
  rt.currentCwd = params.cwd;
  rt.closeRequested = false;
  rt.activeTurnCount = 0;
  rt.activeTurnAbortControllers = new Set();
  rt.firstTurnCompleted = false;
  rt.codeGraphFirstTurnPrewarmDone = false;
  rt.startupProviderCatalogRefreshStarted = false;
  // True while the boot-time provider-catalog refresh is in flight: warming a
  // model cache it is about to invalidate only burns the load twice.
  rt.startupProviderCatalogRefreshPending = false;
}

function activeTurnControls(rt) {
  return {
    registerActiveTurnController: (controller) => {
      rt.activeTurnAbortControllers.add(controller);
      return () => rt.activeTurnAbortControllers.delete(controller);
    },
    abortActiveTurns: (reason) => {
      let aborted = false;
      for (const controller of [...rt.activeTurnAbortControllers]) {
        if (controller.signal.aborted) continue;
        aborted = true;
        try {
          controller.abort(reason);
        } catch {}
      }
      return aborted;
    },
  };
}
