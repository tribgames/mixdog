// config-lifecycle.mjs — config reload/save/adopt family + output-style status
// cache. Dependency-injected factory:
// closes over config/webSearchRoute mutable state via getter/setter injection
// (getConfig/setConfig/getWebSearchRoute/setWebSearchRoute) and shared helpers, so the
// facade keeps ownership of the mutable locals while the debounce/adopt logic
// lives here.
//
//   config-lifecycle/config-writers.mjs     — debounced disk channels + flush barriers
//   config-lifecycle/output-style-cache.mjs — short-TTL output-style status cache
import { withGrandfatheredBuiltins } from '../runtime/agent/orchestrator/runtime-core/builtin-features.mjs';
import { webSearchRouteOrDefault } from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { applyConfigPatch } from '../runtime/shared/config-patch.mjs';
import { normalizeContextTokens } from '../runtime/shared/llm/default-context-window.mjs';
import { withEffectiveDisabledAgents, withStoredDisabledAgents } from '../runtime/shared/agent-route-config.mjs';
import {
  DEFAULT_MAINTENANCE,
  stripStoredRouteDefaults,
  withDefaultPresets,
} from '../runtime/agent/orchestrator/config-presets.mjs';
import { syncSessionCompaction } from './session-compaction-sync.mjs';
import {
  configChangeDomains,
  configChangeIsEmpty,
  configChangeSnapshot,
  diffConfigSnapshots,
  withConfigDomainPending,
} from './config-change-effects.mjs';
import { createConfigWriters } from './config-lifecycle/config-writers.mjs';
import { createLeadRouteSync } from './config-lifecycle/lead-route-sync.mjs';
import { createOutputStyleStatusCache } from './config-lifecycle/output-style-cache.mjs';

export { flushPendingSessionConfigWrites } from './config-lifecycle/config-writers.mjs';

// Stored shape of an effective config: disabled agents, presets and maintenance as deltas.
function storedForm(config) {
  return stripStoredRouteDefaults(withStoredDisabledAgents(config));
}

// The Lead route lives in these two stored keys; a conditional fill writes
// them only while `default` is still unset on disk, judged under the config
// file lock when the patch is applied (config-patch.mjs `unlessSet`).
const LEAD_FILL_KEYS = new Set(['default', 'presets']);

// A fresh profile's install markers (an empty `builtins`) equal the
// defaults, so no diff ever carries them — yet on disk their absence reads
// as a grandfathered profile. The first write seeds them where the stored
// section lacks them. Off-by-default agents are NOT seeded: they live in
// code and the file keeps only the user's delta.
function seedChanges(config, changes) {
  return ['builtins']
    .filter((key) => config[key] !== undefined && !changes.some((change) => change.path[0] === key))
    .map((key) => ({ path: [key], value: structuredClone(config[key]), ifAbsent: true }));
}

// The config just read from disk with this runtime's still-pending edits laid
// back on it (the config and skills writers hold the only copy of them).
function withPendingEdits(loaded, writers) {
  let next = loaded;
  if (writers.hasPendingConfigChanges()) {
    // Preserve only our pending edits. Peer changes and fresh secret overlays
    // from the disk load must not be replaced by the rest of our old snapshot.
    // Pending changes are in stored shape, where disabledAgents is the
    // user's delta; patch the stored form, then restore the effective list.
    // Presets and maintenance are stored as deltas too, so patch their
    // stored form and rebuild the effective lists on top of the shipped ones.
    const patched = applyConfigPatch(storedForm(loaded), writers.pendingConfigChanges());
    next = withEffectiveDisabledAgents({
      ...patched,
      presets: withDefaultPresets(patched.presets),
      maintenance: { ...DEFAULT_MAINTENANCE, ...patched.maintenance },
    });
  }
  const pendingSkills = writers.pendingSkills();
  if (pendingSkills !== null) {
    next = { ...next, skills: { ...(next.skills || {}), disabled: pendingSkills } };
  }
  return next;
}

/**
 * Boot-time config/route state for one runtime. Caller overrides are applied
 * ONLY when supplied, so an option left out keeps the persisted route value
 * (`effort: undefined` must not erase a stored effort, and `fast` is a tri-state
 * where only an explicit boolean overrides).
 *
 * `agentOwned` (a sub-agent's runtime): the route is the agent's own — the
 * Main route's saved settings for the same model (modelSettings: effort, Fast,
 * Auto effort, model parameters, context share/window) must not fill it, so an
 * agent with no stored value gets the route/model default (Auto effort is on
 * unless the agent turns it off).
 */
export function resolveInitialConfigState({
  initialConfig,
  loadConfig,
  resolveRoute,
  provider,
  model,
  effort,
  fast,
  autoEffort,
  modelParameters,
  contextPercent,
  contextTokens,
  selectedContextWindow,
  agentOwned = false,
}) {
  const config = withGrandfatheredBuiltins(
    initialConfig && typeof initialConfig === 'object' ? initialConfig : loadConfig()
  );
  // A requested percent replaces a saved token window; requested tokens
  // replace both (resolveRouteContextState lets tokens win).
  const { contextTokens: savedTokens, ...resolved } = resolveRoute(
    agentOwned ? { ...config, modelSettings: {} } : config,
    {
      provider,
      model,
    }
  );
  const tokens = normalizeContextTokens(contextTokens) || (contextPercent > 0 ? undefined : savedTokens);
  return {
    config,
    route: {
      ...resolved,
      ...(tokens ? { contextTokens: tokens } : {}),
      ...(effort === undefined ? {} : { effort: effort || null }),
      ...(fast === true || fast === false ? { fast } : {}),
      ...(autoEffort === true || autoEffort === false ? { autoEffort } : {}),
      ...(modelParameters && typeof modelParameters === 'object' ? { modelParameters: { ...modelParameters } } : {}),
      ...(contextPercent > 0 ? { contextPercent } : {}),
      ...(selectedContextWindow > 0 ? { selectedContextWindow } : {}),
    },
    webSearchRoute: webSearchRouteOrDefault(config.webSearchRoute),
  };
}

export function createConfigLifecycle({
  // config mutable-state injection
  getConfig,
  setConfig,
  getWebSearchRoute,
  setWebSearchRoute,
  getConfigHasSecrets,
  setConfigHasSecrets,
  getRoute,
  // The live session follows the reloaded global compaction settings.
  getSession,
  // A headless caller injects a complete, deliberately isolated config: it
  // never reloads from disk (no change subscription either), and its sessions
  // keep the compaction they were created with.
  injectedConfig = false,
  // Main route sync on reload (both optional: a lifecycle without them never syncs)
  setRouteState,
  resolveRoute,
  // shared modules / helpers
  cfgMod,
  sharedCfgMod,
  setConfiguredShell,
  normalizeSystemShellConfig,
  normalizeWebSearchRouteConfig,
  outputStyleStatus,
  LAZY_SECRET_PROVIDERS,
  clean,
  resolve,
  performanceNow = () => performance.now(),
  // The runtime's change-driven effects (config-change-effects.mjs), given the
  // diff against the snapshot this runtime last applied.
  onConfigChanged,
  // The backoff of a failed effect's retries; the last delay repeats.
  effectRetryDelaysMs = [1000, 4000, 15000, 60000],
  STANDALONE_DATA_DIR,
}) {
  let disposed = false;
  const outputStyleCache = createOutputStyleStatusCache({
    cfgMod,
    STANDALONE_DATA_DIR,
    resolve,
    outputStyleStatus,
    performanceNow,
  });
  const writers = createConfigWriters({ cfgMod, sharedCfgMod });
  const leadRoute = createLeadRouteSync({ getRoute, getConfig, setRouteState, resolveRoute, clean });

  // --- config adopt -----------------------------------------------------------
  function adoptConfig(nextConfig, { hasSecrets = getConfigHasSecrets() } = {}) {
    // Built-in install markers: stamp a fresh profile's empty section or
    // grandfather a pre-section profile. Idempotent and deterministic, so a
    // load that does not persist still re-derives the same state every time.
    setConfig(withGrandfatheredBuiltins(nextConfig));
    setConfigHasSecrets(hasSecrets === true);
    const config = getConfig();
    setConfiguredShell(normalizeSystemShellConfig(config.shell).command);
    setWebSearchRoute(
      normalizeWebSearchRouteConfig(config.webSearchRoute) || normalizeWebSearchRouteConfig(getWebSearchRoute())
    );
    return config;
  }

  // Track accepted edits, not whole stale runtime snapshots. Keep the baseline
  // separate from adoptConfig: model tuning is adopted before its route save.
  let configSaveBaseline = structuredClone(getConfig());

  function saveConfigAndAdopt(nextConfig, { hasSecrets = getConfigHasSecrets(), leadFill = false } = {}) {
    // In-memory adopt is synchronous and first so callers that read back the
    // value immediately (e.g. setProfile -> getProfile) see the new state.
    const adopted = adoptConfig(nextConfig, { hasSecrets });
    const changes = cfgMod
      .createConfigPatch(configSaveBaseline, adopted)
      .map((change) =>
        leadFill && LEAD_FILL_KEYS.has(change.path[0]) ? { ...change, unlessSet: ['default'] } : change
      );
    configSaveBaseline = structuredClone(adopted);
    if (changes.length) writers.queueConfigChanges([...changes, ...seedChanges(adopted, changes)]);
    return adopted;
  }

  /** After a conditional Lead fill adopted `filled`: persist it now and, when
   *  the file already held another Lead route (written by another process after
   *  the fill's re-read, so the patch skipped it), adopt that one instead.
   *  Answers whether the runtime route was replaced. A route the user has moved
   *  off `filled` meanwhile stays. */
  async function confirmLeadFill(filled) {
    await writers.flushConfigSaveAsync();
    reloadFullConfig();
    return leadRoute.adoptFillWinner(filled);
  }

  function scheduleSkillsSave(names) {
    // This field belongs to its dedicated writer, not a later unrelated save.
    configSaveBaseline.skills = structuredClone(getConfig().skills);
    writers.scheduleSkillsSave(names);
  }

  // --- reload / ensure --------------------------------------------------------
  const changeSnapshot = (config) =>
    configChangeSnapshot({
      config,
      root: sharedCfgMod?.readConfig?.(),
      secretTokens: sharedCfgMod?.secretChangeTokens?.(),
    });
  // What this runtime's effects last ran against, starting from the boot
  // config (the snapshot does not depend on whether a load read secrets).
  let appliedSnapshot = changeSnapshot(getConfig());
  // The stored settings the current config object was taken from (never
  // marked pending): the object is replaced only when they changed, so a
  // retry of a failed effect alone keeps it.
  let loadedSnapshot = appliedSnapshot;

  // A pending debounced write holds the only copy of the latest change.
  // Flush it before re-reading from disk so loadConfig() observes (and the
  // subsequent adopt preserves) that change instead of reverting to a stale
  // on-disk snapshot.
  function loadFullConfig() {
    writers.flushConfigSave();
    if (injectedConfig) return null;
    return withPendingEdits(cfgMod.loadConfig(), writers);
  }

  function reloadFullConfig() {
    return adoptFullConfig(loadFullConfig());
  }

  function adoptFullConfig(next) {
    if (!next) return getConfig();
    const adopted = adoptConfig(next, { hasSecrets: true });
    configSaveBaseline = structuredClone(adopted);
    leadRoute.syncEmptyMainRoute(adopted);
    syncSessionCompaction(getSession?.(), adopted);
    return adopted;
  }

  function ensureFullConfig() {
    if (injectedConfig || getConfigHasSecrets()) return getConfig();
    return reloadFullConfig();
  }

  /** The change step: reload, then run the effects keyed by what differs from
   *  the last applied snapshot. A writer that runs it right after its own write
   *  has applied the change, so the notification that follows finds nothing.
   *  The config object is replaced only when the stored settings changed (a
   *  retry of a failed effect alone keeps it): consumers key turn-start
   *  reconciles on its identity. */
  function applyConfigChange() {
    // A load that throws changes nothing: pending domains stay pending.
    const loaded = loadFullConfig();
    // Every pending domain is in this step's diff, so it runs again here (and
    // a scheduled retry is this step).
    pendingDomains = new Set();
    clearTimeout(retryTimer);
    retryTimer = null;
    outputStyleCache.invalidateOutputStyleStatusCache();
    const next = changeSnapshot(loaded ?? getConfig());
    const change = diffConfigSnapshots(appliedSnapshot, next);
    appliedSnapshot = next;
    const settingsChanged = !configChangeIsEmpty(diffConfigSnapshots(loadedSnapshot, next));
    loadedSnapshot = next;
    const config = settingsChanged ? adoptFullConfig(loaded) : getConfig();
    let outcome;
    try {
      outcome = onConfigChanged?.(change, config);
    } catch {
      outcome = configChangeDomains(change);
    }
    void Promise.resolve(outcome).then(
      (failedDomains) => settleConfigEffects(failedDomains),
      () => settleConfigEffects(configChangeDomains(change))
    );
    return change;
  }

  // A domain whose effect failed is marked not applied, so the next change
  // step (any notification, a writer's own step, or the retry below) runs it
  // again; the applied snapshot otherwise advances as the step runs, which
  // keeps a step overlapping an in-flight effect from repeating it. The retry
  // backs off to the last delay and keeps going until the domain succeeds or
  // the sync is disposed.
  let pendingDomains = new Set();
  let retryTimer = null;
  let retryAttempt = 0;
  function settleConfigEffects(failedDomains) {
    for (const domain of Array.isArray(failedDomains) ? failedDomains : []) {
      appliedSnapshot = withConfigDomainPending(appliedSnapshot, domain);
      pendingDomains.add(domain);
    }
    if (!pendingDomains.size) {
      retryAttempt = 0;
      return;
    }
    if (retryTimer || disposed) return;
    const delay = effectRetryDelaysMs[Math.min(retryAttempt, effectRetryDelaysMs.length - 1)];
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryAttempt += 1;
      try {
        applyConfigChange();
      } catch {
        // The reload failed (e.g. a config mid-write): still pending, retry later.
        settleConfigEffects([]);
      }
    }, delay);
    retryTimer.unref?.();
  }

  function ensureConfigForRouteProvider() {
    const config = getConfig();
    const providerId = clean(getRoute().provider);
    const providerCfg = config?.providers?.[providerId];
    if (getConfigHasSecrets() || LAZY_SECRET_PROVIDERS.has(providerId) || providerCfg?.apiKey) {
      return config;
    }
    return ensureFullConfig();
  }

  // Settings and secrets persisted by this or any other runtime (or process)
  // reach this runtime's config and effects. reloadFullConfig keeps our own
  // pending edits, and the shared layer coalesces bursts into one pass per
  // subscriber. An injected config never follows the disk.
  const unsubscribeConfigChange = injectedConfig ? null : sharedCfgMod?.subscribeConfigChange?.(applyConfigChange);

  return {
    disposeConfigSync: () => {
      disposed = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      unsubscribeConfigChange?.();
    },
    // output-style cache
    ...outputStyleCache,
    // adopt / save
    adoptConfig,
    saveConfigAndAdopt,
    confirmLeadFill,
    // Skills publication also drains older config edits first.
    flushSkillsSave: writers.flushConfigSaveAsync,
    scheduleSkillsSave,
    scheduleOutputStyleSave: writers.scheduleOutputStyleSave,
    flushAllConfigSavesAsync: writers.flushAllConfigSavesAsync,
    // reload / ensure
    reloadFullConfig,
    applyConfigChange,
    ensureFullConfig,
    displayConfig: () => getConfig(),
    ensureConfigForRouteProvider,
  };
}
