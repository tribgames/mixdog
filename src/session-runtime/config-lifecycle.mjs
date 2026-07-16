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
  setBackendAsync,
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
  // Coexistence strategy (sync vs async flush):
  //  * The debounce TIMER fires the ASYNC flush (async lock wait + async icacls
  //    + async backup + async atomic write) so a toggle never blocks the UI
  //    event loop.
  //  * Per-channel serialization: each channel keeps ONE in-flight promise tail;
  //    a new async flush chains after it so flushes never interleave. The pending
  //    payload is re-read at write time (identity guard), so a burst collapses to
  //    the last writer without dropping a newer toggle.
  //  * The SYNC flush is retained for reloadFullConfig/teardown (they need the
  //    write durable before continuing). It nulls the pending payload and writes
  //    synchronously; that sync write takes the SAME cross-process lock file as
  //    any in-flight async write, so it serializes AFTER it (lock contention),
  //    and the async loop's identity guard then finds a null/superseded payload
  //    and does not rewrite — never a revert, and no double-write except a rare
  //    idempotent same-content window if a sync flush lands mid async disk-write.
  let pendingConfigToSave = null;
  let configSaveTimer = null;
  let configFlushInFlight = null;

  async function runConfigFlushAsync() {
    // Drain config, then skills, and RE-CHECK config. A config snapshot queued
    // after the skills patch may carry a stale snapshot.skills (the snapshot
    // captured an older config object ref, before the skills toggle replaced it)
    // that would overwrite the just-patched skills.disabled. Looping until BOTH
    // channels are quiescent keeps the skills patch the last writer relative to
    // EVERY pending/queued config snapshot.
    do {
      let configFailed = false;
      while (pendingConfigToSave !== null) {
        const snapshot = pendingConfigToSave;
        try {
          await cfgMod.saveConfigAsync(snapshot);
        } catch (err) {
          process.stderr.write(`[config] async saveConfig failed: ${err?.message || err}\n`);
          // Keep the payload: a failed write must not drop the pending change.
          configFailed = true;
          break;
        }
        if (pendingConfigToSave === snapshot) pendingConfigToSave = null;
      }
      // Ordering invariant: skills.disabled patch lands AFTER the config save.
      await flushSkillsSaveAsync();
      if (configFailed) break; // avoid a hot spin on a persistently failing write
    } while (pendingConfigToSave !== null);
  }

  function flushConfigSaveAsync() {
    if (configSaveTimer) { clearTimeout(configSaveTimer); configSaveTimer = null; }
    const start = () => runConfigFlushAsync();
    const p = configFlushInFlight ? configFlushInFlight.then(start, start) : start();
    configFlushInFlight = p;
    const clear = () => { if (configFlushInFlight === p) configFlushInFlight = null; };
    p.then(clear, clear);
    return p;
  }

  function flushConfigSave() {
    if (configSaveTimer) {
      clearTimeout(configSaveTimer);
      configSaveTimer = null;
    }
    if (pendingConfigToSave !== null) {
      const snapshot = pendingConfigToSave;
      try {
        cfgMod.saveConfig(snapshot);
        // Clear ONLY after a durable write. saveConfig blocks on the same
        // cross-process lock an async flush may hold, so it serializes after it;
        // if it still fails (e.g. lock timeout) we keep the payload so a later
        // flush / reloadFullConfig retries instead of reverting to stale disk.
        if (pendingConfigToSave === snapshot) pendingConfigToSave = null;
      } catch (err) {
        process.stderr.write(`[config] debounced saveConfig failed: ${err?.message || err}\n`);
      }
    }
    // Config-save flush points (reloadFullConfig re-read, runtime teardown) are
    // exactly where a pending skills.disabled patch must also land, so piggyback
    // the skills flush here — AFTER saveConfig: the whole-section snapshot may
    // predate the latest skills toggle (stale snapshot.skills), so the in-lock
    // skills patch must be the last writer. When the snapshot is newer than the
    // toggle it already carries the same skills value, so the order is always
    // safe. Runs even when no config snapshot is pending (early return above
    // must not skip it).
    flushSkillsSave();
  }

  function saveConfigAndAdopt(nextConfig, { hasSecrets = getConfigHasSecrets() } = {}) {
    // In-memory adopt is synchronous and first so callers that read back the
    // value immediately (e.g. setProfile -> getProfile) see the new state.
    const adopted = adoptConfig(nextConfig, { hasSecrets });
    // Persist the adopted object; coalesce rapid successive changes into one
    // disk write after CONFIG_SAVE_DEBOUNCE_MS of quiet.
    pendingConfigToSave = getConfig();
    if (configSaveTimer) clearTimeout(configSaveTimer);
    configSaveTimer = setTimeout(() => { flushConfigSaveAsync(); }, CONFIG_SAVE_DEBOUNCE_MS);
    configSaveTimer.unref?.();
    return adopted;
  }

  // --- debounced backend switch ----------------------------------------------
  let pendingBackendName = null;
  let backendSaveTimer = null;
  let backendFlushInFlight = null;

  async function runBackendFlushAsync() {
    while (pendingBackendName !== null) {
      const name = pendingBackendName;
      try {
        await setBackendAsync(name);
      } catch (err) {
        process.stderr.write(`[channels] async setBackend failed: ${err?.message || err}\n`);
        if (pendingBackendName === name) pendingBackendName = null;
        break;
      }
      if (pendingBackendName === name) pendingBackendName = null;
    }
  }

  function flushBackendSaveAsync() {
    if (backendSaveTimer) { clearTimeout(backendSaveTimer); backendSaveTimer = null; }
    const start = () => runBackendFlushAsync();
    const p = backendFlushInFlight ? backendFlushInFlight.then(start, start) : start();
    backendFlushInFlight = p;
    const clear = () => { if (backendFlushInFlight === p) backendFlushInFlight = null; };
    p.then(clear, clear);
    return p;
  }

  function scheduleBackendSave(name) {
    pendingBackendName = name;
    if (backendSaveTimer) clearTimeout(backendSaveTimer);
    backendSaveTimer = setTimeout(() => { flushBackendSaveAsync(); }, CONFIG_SAVE_DEBOUNCE_MS);
    backendSaveTimer.unref?.();
  }

  // --- debounced skills.disabled persist -------------------------------------
  // In-memory skills state is adopted synchronously by setDisabledSkills; the
  // heavy in-lock file RMW (cfgMod.patchSkillsDisabled) is deferred here so a
  // burst of settings-toggle key presses collapses into one disk write.
  let pendingSkillsNames = null;
  let skillsSaveTimer = null;
  let skillsFlushInFlight = null;

  async function runSkillsFlushAsync() {
    while (pendingSkillsNames !== null) {
      const names = pendingSkillsNames;
      try {
        await cfgMod.patchSkillsDisabledAsync(names);
      } catch (err) {
        process.stderr.write(`[config] async patchSkillsDisabled failed: ${err?.message || err}\n`);
        if (pendingSkillsNames === names) pendingSkillsNames = null;
        break;
      }
      if (pendingSkillsNames === names) pendingSkillsNames = null;
    }
  }

  function flushSkillsSaveAsync() {
    if (skillsSaveTimer) { clearTimeout(skillsSaveTimer); skillsSaveTimer = null; }
    const start = () => runSkillsFlushAsync();
    const p = skillsFlushInFlight ? skillsFlushInFlight.then(start, start) : start();
    skillsFlushInFlight = p;
    const clear = () => { if (skillsFlushInFlight === p) skillsFlushInFlight = null; };
    p.then(clear, clear);
    return p;
  }

  function flushSkillsSave() {
    if (skillsSaveTimer) {
      clearTimeout(skillsSaveTimer);
      skillsSaveTimer = null;
    }
    if (pendingSkillsNames === null) return;
    const names = pendingSkillsNames;
    pendingSkillsNames = null;
    try {
      cfgMod.patchSkillsDisabled(names);
    } catch (err) {
      process.stderr.write(`[config] debounced patchSkillsDisabled failed: ${err?.message || err}\n`);
    }
  }

  function scheduleSkillsSave(names) {
    pendingSkillsNames = names;
    if (skillsSaveTimer) clearTimeout(skillsSaveTimer);
    skillsSaveTimer = setTimeout(() => { flushSkillsSaveAsync(); }, CONFIG_SAVE_DEBOUNCE_MS);
    skillsSaveTimer.unref?.();
  }

  // --- debounced top-level outputStyle persist -------------------------------
  let pendingOutputStyleId = null;
  let outputStyleSaveTimer = null;
  let outputStyleFlushInFlight = null;

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

  async function runOutputStyleFlushAsync() {
    while (pendingOutputStyleId !== null) {
      const styleId = pendingOutputStyleId;
      try {
        await sharedCfgMod.updateConfigAsync(outputStyleUpdater(styleId));
      } catch (err) {
        process.stderr.write(`[config] async outputStyle save failed: ${err?.message || err}\n`);
        if (pendingOutputStyleId === styleId) pendingOutputStyleId = null;
        break;
      }
      if (pendingOutputStyleId === styleId) pendingOutputStyleId = null;
    }
  }

  function flushOutputStyleSaveAsync() {
    if (outputStyleSaveTimer) { clearTimeout(outputStyleSaveTimer); outputStyleSaveTimer = null; }
    const start = () => runOutputStyleFlushAsync();
    const p = outputStyleFlushInFlight ? outputStyleFlushInFlight.then(start, start) : start();
    outputStyleFlushInFlight = p;
    const clear = () => { if (outputStyleFlushInFlight === p) outputStyleFlushInFlight = null; };
    p.then(clear, clear);
    return p;
  }

  // Teardown barrier for every in-process writer that can hold the shared
  // mixdog-config lock. Start/drain all debounce channels through their async
  // variants, then resolve only when every promise tail (including skills,
  // which config flushes after its whole-section write) has settled.
  async function flushAllConfigSavesAsync() {
    await Promise.all([
      flushConfigSaveAsync(),
      flushBackendSaveAsync(),
      flushOutputStyleSaveAsync(),
    ]);
    // The shared config layer also tracks writes started directly by channel,
    // webhook, voice, Discord access, and future async RMW callers.
    await sharedCfgMod.pendingConfigWrites();
  }

  function flushOutputStyleSave() {
    if (outputStyleSaveTimer) {
      clearTimeout(outputStyleSaveTimer);
      outputStyleSaveTimer = null;
    }
    if (pendingOutputStyleId === null) return;
    const styleId = pendingOutputStyleId;
    pendingOutputStyleId = null;
    try {
      sharedCfgMod.updateConfig(outputStyleUpdater(styleId));
    } catch (err) {
      process.stderr.write(`[config] debounced outputStyle save failed: ${err?.message || err}\n`);
    }
  }

  function scheduleOutputStyleSave(styleId) {
    pendingOutputStyleId = styleId;
    if (outputStyleSaveTimer) clearTimeout(outputStyleSaveTimer);
    outputStyleSaveTimer = setTimeout(() => { flushOutputStyleSaveAsync(); }, CONFIG_SAVE_DEBOUNCE_MS);
    outputStyleSaveTimer.unref?.();
  }

  // --- reload / ensure --------------------------------------------------------
  function reloadFullConfig() {
    // A pending debounced write holds the only copy of the latest change.
    // Flush it before re-reading from disk so loadConfig() observes (and the
    // subsequent adopt preserves) that change instead of reverting to a stale
    // on-disk snapshot.
    flushConfigSave();
    const loaded = cfgMod.loadConfig();
    if (pendingConfigToSave !== null) {
      // The debounced write could not land (e.g. lock timeout), so on-disk is
      // stale. Prefer the freshest in-memory state and re-overlay the keychain
      // provider secrets that only the disk load carries, so a failed flush
      // never reverts the user's latest change.
      const current = getConfig();
      const merged = { ...loaded, ...current, providers: { ...(current.providers || {}) } };
      for (const [name, val] of Object.entries(loaded.providers || {})) {
        if (val && val.apiKey) {
          // Match loadConfig's keychain overlay: apiKey ⇒ enabled:true, UNLESS
          // the in-memory pending state EXPLICITLY disabled this provider (a
          // genuine newer user change that must not be reverted).
          const explicitlyDisabled = current.providers?.[name]?.enabled === false;
          merged.providers[name] = {
            ...(merged.providers[name] || {}),
            apiKey: val.apiKey,
            enabled: explicitlyDisabled ? false : true,
          };
        }
      }
      return adoptConfig(merged, { hasSecrets: true });
    }
    return adoptConfig(loaded, { hasSecrets: true });
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
    // Every lifecycle flush uses the async lock path. A synchronous waiter on
    // the same lock would block the event loop needed by an in-flight async
    // writer, so callers must await this before a dependent read/start.
    flushBackendSave: flushBackendSaveAsync,
    scheduleBackendSave,
    flushSkillsSave,
    scheduleSkillsSave,
    flushOutputStyleSave,
    scheduleOutputStyleSave,
    flushAllConfigSavesAsync,
    // reload / ensure
    reloadFullConfig,
    ensureFullConfig,
    displayConfig,
    ensureConfigForRouteProvider,
  };
}
