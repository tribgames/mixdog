// config-lifecycle.mjs — config reload/save/adopt family + output-style status
// cache, extracted from mixdog-session-runtime.mjs. Dependency-injected factory:
// closes over config/searchRoute mutable state via getter/setter injection
// (getConfig/setConfig/getSearchRoute/setSearchRoute) and shared helpers, so the
// facade keeps ownership of the mutable locals while the debounce/adopt logic
// lives here.
//
// Debounce rationale (unchanged from the original inline implementation):
// persisting mixdog-config.json is heavy (cross-process lock, atomic
// temp+rename, win32 icacls owner-only ACL). Adopt in-memory IMMEDIATELY so
// same-tick readers see fresh state, and DEBOUNCE the disk write so a burst of
// toggles collapses into one persist. Three independent debounce channels:
//   - config save  (cfgMod.saveConfig, agent-section serialize)
//   - backend save (channel-admin setBackend, file-locked RMW)
//   - outputStyle  (sharedCfgMod.updateConfig whole-root RMW — cfgMod.saveConfig
//                   only serializes agent-section fields, so a top-level
//                   outputStyle would never reach disk via that path)

export const CONFIG_SAVE_DEBOUNCE_MS = 150;

export function createConfigLifecycle({
  // config mutable-state injection
  getConfig,
  setConfig,
  getSearchRoute,
  setSearchRoute,
  getConfigHasSecrets,
  setConfigHasSecrets,
  getRoute,
  // shared modules / helpers
  cfgMod,
  sharedCfgMod,
  setBackend,
  setConfiguredShell,
  normalizeSystemShellConfig,
  normalizeSearchRouteConfig,
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
      !fresh
      && outputStyleStatusCache
      && outputStyleStatusCacheDir === cacheDir
      && now - outputStyleStatusCacheAt < 2500
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
    setConfig(nextConfig);
    setConfigHasSecrets(hasSecrets === true);
    const config = getConfig();
    setConfiguredShell(normalizeSystemShellConfig(config.shell).command);
    setSearchRoute(
      normalizeSearchRouteConfig(config.searchRoute)
        || normalizeSearchRouteConfig(getSearchRoute()),
    );
    return config;
  }

  // --- debounced config save --------------------------------------------------
  let pendingConfigToSave = null;
  let configSaveTimer = null;

  function flushConfigSave() {
    if (configSaveTimer) {
      clearTimeout(configSaveTimer);
      configSaveTimer = null;
    }
    if (pendingConfigToSave === null) return;
    const snapshot = pendingConfigToSave;
    pendingConfigToSave = null;
    try {
      cfgMod.saveConfig(snapshot);
    } catch (err) {
      process.stderr.write(`[config] debounced saveConfig failed: ${err?.message || err}\n`);
    }
  }

  function saveConfigAndAdopt(nextConfig, { hasSecrets = getConfigHasSecrets() } = {}) {
    // In-memory adopt is synchronous and first so callers that read back the
    // value immediately (e.g. setProfile -> getProfile) see the new state.
    const adopted = adoptConfig(nextConfig, { hasSecrets });
    // Persist the adopted object; coalesce rapid successive changes into one
    // disk write after CONFIG_SAVE_DEBOUNCE_MS of quiet.
    pendingConfigToSave = getConfig();
    if (configSaveTimer) clearTimeout(configSaveTimer);
    configSaveTimer = setTimeout(flushConfigSave, CONFIG_SAVE_DEBOUNCE_MS);
    configSaveTimer.unref?.();
    return adopted;
  }

  // --- debounced backend switch ----------------------------------------------
  let pendingBackendName = null;
  let backendSaveTimer = null;

  function flushBackendSave() {
    if (backendSaveTimer) {
      clearTimeout(backendSaveTimer);
      backendSaveTimer = null;
    }
    if (pendingBackendName === null) return;
    const name = pendingBackendName;
    pendingBackendName = null;
    try {
      setBackend(name);
    } catch (err) {
      process.stderr.write(`[channels] debounced setBackend failed: ${err?.message || err}\n`);
    }
  }

  function scheduleBackendSave(name) {
    pendingBackendName = name;
    if (backendSaveTimer) clearTimeout(backendSaveTimer);
    backendSaveTimer = setTimeout(flushBackendSave, CONFIG_SAVE_DEBOUNCE_MS);
    backendSaveTimer.unref?.();
  }

  // --- debounced top-level outputStyle persist -------------------------------
  let pendingOutputStyleId = null;
  let outputStyleSaveTimer = null;

  function flushOutputStyleSave() {
    if (outputStyleSaveTimer) {
      clearTimeout(outputStyleSaveTimer);
      outputStyleSaveTimer = null;
    }
    if (pendingOutputStyleId === null) return;
    const styleId = pendingOutputStyleId;
    pendingOutputStyleId = null;
    try {
      sharedCfgMod.updateConfig((root) => {
        const next = { ...(root || {}), outputStyle: styleId };
        if (next.agent && typeof next.agent === 'object' && !Array.isArray(next.agent)) {
          const agent = { ...next.agent };
          delete agent.outputStyle;
          next.agent = agent;
        }
        return next;
      });
    } catch (err) {
      process.stderr.write(`[config] debounced outputStyle save failed: ${err?.message || err}\n`);
    }
  }

  function scheduleOutputStyleSave(styleId) {
    pendingOutputStyleId = styleId;
    if (outputStyleSaveTimer) clearTimeout(outputStyleSaveTimer);
    outputStyleSaveTimer = setTimeout(flushOutputStyleSave, CONFIG_SAVE_DEBOUNCE_MS);
    outputStyleSaveTimer.unref?.();
  }

  // --- reload / ensure --------------------------------------------------------
  function reloadFullConfig() {
    // A pending debounced write holds the only copy of the latest change.
    // Flush it before re-reading from disk so loadConfig() observes (and the
    // subsequent adopt preserves) that change instead of reverting to a stale
    // on-disk snapshot.
    flushConfigSave();
    return adoptConfig(cfgMod.loadConfig(), { hasSecrets: true });
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
    flushConfigSave,
    flushBackendSave,
    scheduleBackendSave,
    flushOutputStyleSave,
    scheduleOutputStyleSave,
    // reload / ensure
    reloadFullConfig,
    ensureFullConfig,
    displayConfig,
    ensureConfigForRouteProvider,
  };
}
