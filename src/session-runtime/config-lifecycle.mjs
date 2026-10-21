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
  onConfigReloaded,
  STANDALONE_DATA_DIR,
}) {
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
  function reloadFullConfig() {
    // A pending debounced write holds the only copy of the latest change.
    // Flush it before re-reading from disk so loadConfig() observes (and the
    // subsequent adopt preserves) that change instead of reverting to a stale
    // on-disk snapshot.
    writers.flushConfigSave();
    const next = withPendingEdits(cfgMod.loadConfig(), writers);
    const adopted = adoptConfig(next, { hasSecrets: true });
    configSaveBaseline = structuredClone(adopted);
    leadRoute.syncEmptyMainRoute(adopted);
    return adopted;
  }

  function ensureFullConfig() {
    if (getConfigHasSecrets()) return getConfig();
    return reloadFullConfig();
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

  // Settings persisted by any other runtime (or process) reach this runtime's
  // in-memory config. reloadFullConfig keeps our own pending edits, and the
  // shared layer coalesces bursts into one pass per subscriber.
  const unsubscribeConfigChange = sharedCfgMod?.subscribeConfigChange?.(() => {
    reloadFullConfig();
    outputStyleCache.invalidateOutputStyleStatusCache();
    onConfigReloaded?.();
  });

  return {
    disposeConfigSync: () => unsubscribeConfigChange?.(),
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
    ensureFullConfig,
    displayConfig: () => getConfig(),
    ensureConfigForRouteProvider,
  };
}
