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
//   - config save  (cfgMod.saveConfig, agent-section serialize)
//   - outputStyle  (sharedCfgMod.updateConfig whole-root RMW — cfgMod.saveConfig
//                   only serializes agent-section fields, so a top-level
//                   outputStyle would never reach disk via that path)

const CONFIG_SAVE_DEBOUNCE_MS = 150;

import { withGrandfatheredBuiltins } from './builtin-features.mjs';
import { createDebouncedWriter } from '../runtime/shared/debounced-writer.mjs';

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
    // Built-in install markers: stamp a fresh profile's empty section or
    // grandfather a pre-section profile. Idempotent and deterministic, so a
    // load that does not persist still re-derives the same state every time.
    setConfig(withGrandfatheredBuiltins(nextConfig));
    setConfigHasSecrets(hasSecrets === true);
    const config = getConfig();
    setConfiguredShell(normalizeSystemShellConfig(config.shell).command);
    setWebSearchRoute(
      normalizeWebSearchRouteConfig(config.webSearchRoute)
        || normalizeWebSearchRouteConfig(getWebSearchRoute()),
    );
    return config;
  }

  // Synchronous reload remains a synchronous API. It may flush an idle writer,
  // but must retain its in-memory overlay while an asynchronous write is active.
  const configWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: (snapshot) => cfgMod.saveConfigAsync(snapshot),
    onError: (error, sync) => process.stderr.write(
      `[config] ${sync ? 'debounced' : 'async'} saveConfig failed: ${error?.message || error}\n`,
    ),
  });
  const skillsWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: (names) => cfgMod.patchSkillsDisabledAsync(names),
    onError: (error, sync) => process.stderr.write(
      `[config] ${sync ? 'debounced' : 'async'} patchSkillsDisabled failed: ${error?.message || error}\n`,
    ),
  });
  const outputStyleWriter = createDebouncedWriter({
    delayMs: CONFIG_SAVE_DEBOUNCE_MS,
    write: (styleId) => sharedCfgMod.updateConfigAsync(outputStyleUpdater(styleId)),
    onError: (error) => process.stderr.write(`[config] async outputStyle save failed: ${error?.message || error}\n`),
  });
  let configFlushInFlight = null;

  async function runConfigFlushAsync() {
    // Whole-config snapshots precede the more specific skills.disabled patch.
    do {
      if (!await configWriter.flush()) break;
      await skillsWriter.flush();
    } while (configWriter.hasPending());
  }

  function flushConfigSaveAsync() {
    if (configFlushInFlight) return configFlushInFlight;
    const p = runConfigFlushAsync();
    configFlushInFlight = p;
    const clear = () => { if (configFlushInFlight === p) configFlushInFlight = null; };
    p.then(clear, clear);
    return p;
  }

  function flushConfigSave() {
    if (configWriter.flushSyncIfIdle((snapshot) => cfgMod.saveConfig(snapshot))) {
      skillsWriter.flushSyncIfIdle((names) => cfgMod.patchSkillsDisabled(names));
    }
  }

  function saveConfigAndAdopt(nextConfig, { hasSecrets = getConfigHasSecrets() } = {}) {
    // In-memory adopt is synchronous and first so callers that read back the
    // value immediately (e.g. setProfile -> getProfile) see the new state.
    const adopted = adoptConfig(nextConfig, { hasSecrets });
    // Persist the adopted object; coalesce rapid successive changes into one
    // disk write after CONFIG_SAVE_DEBOUNCE_MS of quiet.
    configWriter.schedule(getConfig(), flushConfigSaveAsync);
    return adopted;
  }

  function scheduleSkillsSave(names) {
    skillsWriter.schedule(names, flushConfigSaveAsync);
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
  async function flushAllConfigSavesAsync() {
    await Promise.all([
      flushConfigSaveAsync(),
      outputStyleWriter.flush(),
    ]);
    // The shared config layer also tracks writes started directly by channel,
    // webhook, voice, and future async RMW callers.
    await sharedCfgMod.pendingConfigWrites();
  }

  function scheduleOutputStyleSave(styleId) {
    outputStyleWriter.schedule(styleId);
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
      next = merged;
    }
    const pendingSkills = skillsWriter.getPending();
    if (pendingSkills !== null) {
      next = { ...next, skills: { ...(next.skills || {}), disabled: pendingSkills } };
    }
    return adoptConfig(next, { hasSecrets: true });
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
    // Skills publication also drains older whole-config snapshots first.
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
