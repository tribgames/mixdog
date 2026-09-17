// config-lifecycle.mjs — config reload/save/adopt family + output-style status
// cache, extracted from mixdog-session-runtime.mjs. Dependency-injected factory:
// closes over config/webSearchRoute mutable state via getter/setter injection
// (getConfig/setConfig/getWebSearchRoute/setWebSearchRoute) and shared helpers, so the
// facade keeps ownership of the mutable locals while the debounce/adopt logic
// lives here.
//
// Debounce rationale (unchanged from the original inline implementation):
// persisting mixdog-config.json is heavy (cross-process lock, atomic
// temp+rename, win32 icacls owner-only ACL). Adopt in-memory IMMEDIATELY so
// same-tick readers see fresh state, and DEBOUNCE the disk write so a burst of
// toggles collapses into one persist. Three independent debounce channels:
//   - config save  (field patches rebased onto the locked agent section)
//   - outputStyle  (sharedCfgMod.updateConfig whole-root RMW — cfgMod.saveConfig
//                   only serializes agent-section fields, so a top-level
//                   outputStyle would never reach disk via that path)

const CONFIG_SAVE_DEBOUNCE_MS = 150;

// Only pending writers are retained. A new runtime must also drain changes
// accepted by OTHER runtimes before reading its initial config from disk.
const pendingSessionConfigWriters = new Set();

export async function flushPendingSessionConfigWrites() {
  while (pendingSessionConfigWriters.size) {
    await Promise.all([...pendingSessionConfigWriters].map((flush) => flush({ requireSaved: true })));
  }
}

import { withGrandfatheredBuiltins } from './builtin-features.mjs';
import { webSearchRouteOrDefault } from './workflow.mjs';
import { createDebouncedWriter } from '../runtime/shared/debounced-writer.mjs';
import { applyConfigPatch } from '../runtime/shared/config-patch.mjs';

/**
 * Boot-time config/route state for one runtime. Caller overrides are applied
 * ONLY when supplied, so an option left out keeps the persisted route value
 * (`effort: undefined` must not erase a stored effort, and `fast` is a tri-state
 * where only an explicit boolean overrides).
 */
export function resolveInitialConfigState({
  initialConfig,
  loadConfig,
  resolveRoute,
  provider,
  model,
  effort,
  fast,
  modelParameters,
}) {
  const config = withGrandfatheredBuiltins(
    initialConfig && typeof initialConfig === 'object' ? initialConfig : loadConfig()
  );
  return {
    config,
    route: {
      ...resolveRoute(config, { provider, model }),
      ...(effort === undefined ? {} : { effort: effort || null }),
      ...(fast === true || fast === false ? { fast } : {}),
      ...(modelParameters && typeof modelParameters === 'object' ? { modelParameters: { ...modelParameters } } : {}),
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
  STANDALONE_DATA_DIR,
}) {
  // --- output-style status cache (short TTL, keyed on plugin data dir) --------
  let outputStyleStatusCache = null;
  let outputStyleStatusCacheAt = 0;
  let outputStyleStatusCacheDir = '';

  const getOutputStyleStatusCached = ({ fresh = false } = {}) => {
    const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
    const cacheDir = resolve(dataDir);
    const now = performanceNow();
    if (
      !fresh &&
      outputStyleStatusCache &&
      outputStyleStatusCacheDir === cacheDir &&
      now - outputStyleStatusCacheAt < 2500
    ) {
      return outputStyleStatusCache;
    }
    outputStyleStatusCache = outputStyleStatus(dataDir, { fresh });
    outputStyleStatusCacheAt = now;
    outputStyleStatusCacheDir = cacheDir;
    return outputStyleStatusCache;
  };
  const invalidateOutputStyleStatusCache = () => {
    outputStyleStatusCache = null;
    outputStyleStatusCacheAt = 0;
    outputStyleStatusCacheDir = '';
  };
  // In-memory seed of the status cache after an outputStyle select (avoids a
  // second forced-fresh filesystem scan during the debounce window).
  const seedOutputStyleStatusCache = (status) => {
    outputStyleStatusCache = status;
    outputStyleStatusCacheAt = performanceNow();
    outputStyleStatusCacheDir = resolve(cfgMod.getPluginData?.() || STANDALONE_DATA_DIR);
  };

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
  let pendingConfigChanges = [];
  // Synchronous reload remains a synchronous API. It may flush an idle writer,
  // but must retain its pending field overlay while an async write is active.
  const configWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: async () => {
      const changes = pendingConfigChanges;
      await cfgMod.saveConfigPatchAsync(changes);
      // New edits accepted during this write remain queued; a successful prefix
      // must never be replayed over another runtime's subsequent changes.
      pendingConfigChanges = pendingConfigChanges.slice(changes.length);
    },
    onError: (error, sync) =>
      process.stderr.write(`[config] ${sync ? 'debounced' : 'async'} saveConfig failed: ${error?.message || error}\n`),
  });
  const skillsWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: (names) => cfgMod.patchSkillsDisabledAsync(names),
    onError: (error, sync) =>
      process.stderr.write(
        `[config] ${sync ? 'debounced' : 'async'} patchSkillsDisabled failed: ${error?.message || error}\n`
      ),
  });
  const outputStyleWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: (styleId) => sharedCfgMod.updateConfigAsync(outputStyleUpdater(styleId)),
    onError: (error) => process.stderr.write(`[config] async outputStyle save failed: ${error?.message || error}\n`),
  });
  let configFlushInFlight = null;

  function releaseSavedWriter() {
    const pending = configWriter.hasPending() || skillsWriter.hasPending() || outputStyleWriter.hasPending();
    if (!pending) pendingSessionConfigWriters.delete(flushAllConfigSavesAsync);
    return !pending;
  }

  async function runConfigFlushAsync() {
    // Config edits precede the dedicated skills.disabled patch.
    do {
      if (!(await configWriter.flush())) return false;
      if (!(await skillsWriter.flush())) return false;
    } while (configWriter.hasPending() || skillsWriter.hasPending());
    return true;
  }

  function flushConfigSaveAsync() {
    if (configFlushInFlight) return configFlushInFlight;
    const p = runConfigFlushAsync();
    configFlushInFlight = p;
    const clear = () => {
      if (configFlushInFlight === p) configFlushInFlight = null;
      releaseSavedWriter();
    };
    p.then(clear, clear);
    return p;
  }

  function flushConfigSave() {
    if (configWriter.flushSyncIfIdle(() => {
      const changes = pendingConfigChanges;
      cfgMod.saveConfigPatch(changes);
      pendingConfigChanges = pendingConfigChanges.slice(changes.length);
    })) {
      skillsWriter.flushSyncIfIdle((names) => cfgMod.patchSkillsDisabled(names));
    }
    releaseSavedWriter();
  }

  function saveConfigAndAdopt(nextConfig, { hasSecrets = getConfigHasSecrets() } = {}) {
    // In-memory adopt is synchronous and first so callers that read back the
    // value immediately (e.g. setProfile -> getProfile) see the new state.
    const adopted = adoptConfig(nextConfig, { hasSecrets });
    const changes = cfgMod.createConfigPatch(configSaveBaseline, adopted);
    configSaveBaseline = structuredClone(adopted);
    if (changes.length) {
      pendingConfigChanges = [...pendingConfigChanges, ...changes];
      configWriter.schedule(pendingConfigChanges, flushConfigSaveAsync);
      pendingSessionConfigWriters.add(flushAllConfigSavesAsync);
    }
    return adopted;
  }

  function scheduleSkillsSave(names) {
    // This field belongs to its dedicated writer, not a later unrelated save.
    configSaveBaseline.skills = structuredClone(getConfig().skills);
    skillsWriter.schedule(names, flushConfigSaveAsync);
    pendingSessionConfigWriters.add(flushAllConfigSavesAsync);
  }

  function outputStyleUpdater(styleId) {
    return (root) => {
      const next = { ...(root || {}), outputStyle: styleId };
      if (next.agent && typeof next.agent === 'object' && !Array.isArray(next.agent)) {
        const agent = { ...next.agent };
        delete agent.outputStyle;
        next.agent = agent;
      }
      return next;
    };
  }

  // Teardown barrier for every in-process writer that can hold the shared
  // mixdog-config lock. Start/drain all debounce channels through their async
  // variants, then resolve only when every promise tail (including skills,
  // which config flushes after its whole-section write) has settled.
  async function flushAllConfigSavesAsync({ requireSaved = false } = {}) {
    const saved = await Promise.all([flushConfigSaveAsync(), outputStyleWriter.flush()]);
    // The shared config layer also tracks writes started directly by channel,
    // webhook, voice, and future async RMW callers.
    await sharedCfgMod.pendingConfigWrites();
    releaseSavedWriter();
    if (requireSaved && saved.includes(false)) {
      throw new Error('Cannot create a new session: pending settings could not be saved.');
    }
  }

  async function flushOutputStyleSaveAsync() {
    await outputStyleWriter.flush();
    releaseSavedWriter();
  }

  function scheduleOutputStyleSave(styleId) {
    outputStyleWriter.schedule(styleId, flushOutputStyleSaveAsync);
    pendingSessionConfigWriters.add(flushAllConfigSavesAsync);
  }

  // --- reload / ensure --------------------------------------------------------
  function reloadFullConfig() {
    // A pending debounced write holds the only copy of the latest change.
    // Flush it before re-reading from disk so loadConfig() observes (and the
    // subsequent adopt preserves) that change instead of reverting to a stale
    // on-disk snapshot.
    flushConfigSave();
    const loaded = cfgMod.loadConfig();
    let next = loaded;
    if (configWriter.hasPending()) {
      // Preserve only our pending edits. Peer changes and fresh secret overlays
      // from the disk load must not be replaced by the rest of our old snapshot.
      next = applyConfigPatch(loaded, pendingConfigChanges);
    }
    const pendingSkills = skillsWriter.getPending();
    if (pendingSkills !== null) {
      next = { ...next, skills: { ...(next.skills || {}), disabled: pendingSkills } };
    }
    const adopted = adoptConfig(next, { hasSecrets: true });
    configSaveBaseline = structuredClone(adopted);
    return adopted;
  }

  function ensureFullConfig() {
    if (getConfigHasSecrets()) return getConfig();
    return reloadFullConfig();
  }

  function displayConfig() {
    return getConfig();
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

  return {
    // output-style cache
    getOutputStyleStatusCached,
    invalidateOutputStyleStatusCache,
    seedOutputStyleStatusCache,
    // adopt / save
    adoptConfig,
    saveConfigAndAdopt,
    // Skills publication also drains older config edits first.
    flushSkillsSave: flushConfigSaveAsync,
    scheduleSkillsSave,
    scheduleOutputStyleSave,
    flushAllConfigSavesAsync,
    // reload / ensure
    reloadFullConfig,
    ensureFullConfig,
    displayConfig,
    ensureConfigForRouteProvider,
  };
}
