// Built-in tool modules: the enable/install toggles (web search, memory, git,
// office, tidy, local provider), the recap switch and the Code Tidy card.
import {
  BRIDGE_FIRST_USE_IDS,
  INSTALLABLE_BUILTIN_IDS,
  builtinFeatureActive,
  builtinFirstUseApproval,
  builtinInstalled,
  setBuiltinFirstUseApprovalInConfig,
  setBuiltinInstalledInConfig,
} from './builtin-features.mjs';
import { LOCAL_PROVIDER_ID } from '../runtime/local-provider/managed-runtime.mjs';
import { getEmbeddingInfo } from '../runtime/memory/lib/embedding-provider.mjs';

function setLocalProviderEnabledInConfig(configLike, enabled) {
  const next = { ...(configLike || {}) };
  next.providers = { ...(next.providers || {}) };
  next.providers[LOCAL_PROVIDER_ID] = {
    ...(next.providers[LOCAL_PROVIDER_ID] || {}),
    enabled: enabled !== false,
  };
  return next;
}

export function createBuiltinToolSettings(
  {
    getConfig,
    saveConfigAndAdopt,
    setRecapEnabledInConfig,
    setMemoryToolsEnabledInConfig,
    setModuleEnabledInConfig,
    prepareBuiltinFeature,
    tidyEngineStatus,
    tidyInstallStatus,
    getLocalProviderStatus,
    stopLocalProviderServer,
    syncLocalProviderRegistry,
    recapEnabledFn,
    memoryToolsEnabledFn,
    gitToolsEnabledFn,
    officeToolsEnabledFn,
    tidyToolEnabledFn,
    localProviderEnabledFn,
    webSearchEnabled,
    invalidateContextStatusCache,
    invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy,
  },
  localSettings
) {
  return {
    // Recap toggle: user-facing switch that gates ONLY the background memory
    // cycles (1/2/3). The memory module (transcript watcher/ingest and
    // on-demand reads) is always-on. The memory runtime re-reads recap from the
    // agent config section each cycle tick, so toggling takes effect without a
    // restart.
    getRecapSettings() {
      return { enabled: recapEnabledFn() };
    },
    setRecapEnabled(enabled) {
      const config = getConfig();
      const nextConfig = setRecapEnabledInConfig({ ...config }, enabled !== false);
      saveConfigAndAdopt(nextConfig);
      invalidatePreSessionToolSurface();
      invalidateContextStatusCache();
      return this.getRecapSettings();
    },
    getToolModuleSettings() {
      const config = getConfig();
      const localProvider = getLocalProviderStatus?.() || {};
      const localProviderRuntimeInstalled = localProvider?.runtime?.installed === true;
      return {
        webSearch: { enabled: webSearchEnabled() },
        memory: {
          enabled: memoryToolsEnabledFn(),
          installed: builtinInstalled(config, 'memory'),
          info: getEmbeddingInfo(),
        },
        git: { enabled: gitToolsEnabledFn(), installed: builtinInstalled(config, 'git') },
        office: { enabled: officeToolsEnabledFn(), installed: builtinInstalled(config, 'office') },
        tidy: {
          enabled: tidyToolEnabledFn ? tidyToolEnabledFn() : builtinFeatureActive(config, 'tidy'),
          installed: builtinInstalled(config, 'tidy'),
        },
        localProvider: {
          ...localProvider,
          ...localSettings.status(),
          enabled: localProviderEnabledFn(),
          installed: builtinInstalled(config, 'localProvider') && localProviderRuntimeInstalled,
        },
      };
    },
    async setWebSearchEnabled(enabled) {
      const config = getConfig();
      saveConfigAndAdopt(setModuleEnabledInConfig({ ...config }, 'webSearch', enabled !== false));
      // Empty/reserved sessions rebuild now so session entry does not still
      // advertise web_search. A conversation keeps its frozen schema.
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    async setMemoryToolsEnabled(enabled) {
      const config = getConfig();
      const memoryEnabled = enabled !== false;
      // General → Memory is the user-facing master: model tools, core-memory
      // injection, and background recap cycles move together.
      let nextConfig = setRecapEnabledInConfig(
        setMemoryToolsEnabledInConfig({ ...config }, memoryEnabled),
        memoryEnabled
      );
      // Enabling IS activation: an explicit enable marks the feature installed
      // so the install-first gate never fights a direct toggle (TUI path).
      if (memoryEnabled) nextConfig = setBuiltinInstalledInConfig(nextConfig, 'memory', true);
      saveConfigAndAdopt(nextConfig);
      invalidateContextStatusCache();
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    /** Once-per-session approval before the first Browser Use or Computer Use
     *  call. The setting is read at each call, so it applies at once. */
    async setBridgeFirstUseApproval(name, enabled) {
      if (!BRIDGE_FIRST_USE_IDS.includes(name)) {
        throw new TypeError('First-use approval applies to browser or computer.');
      }
      saveConfigAndAdopt(setBuiltinFirstUseApprovalInConfig({ ...getConfig() }, name, enabled !== false));
      return {
        name,
        firstUseApproval: builtinFirstUseApproval(getConfig(), name),
        appliesTo: 'the next first use in any session, including this one',
      };
    },
    async setBuiltinToolEnabled(name, enabled) {
      if (name !== 'git' && name !== 'office' && name !== 'tidy' && name !== 'localProvider') {
        throw new TypeError('Built-in tool must be git, office, tidy, or localProvider.');
      }
      if (name === 'localProvider' && enabled !== false && getLocalProviderStatus?.()?.runtime?.installed !== true) {
        await prepareBuiltinFeature?.(name);
      }
      const config = getConfig();
      let nextConfig = setModuleEnabledInConfig({ ...config }, name, enabled !== false);
      if (name === 'localProvider') {
        nextConfig = setLocalProviderEnabledInConfig(nextConfig, enabled);
      }
      // Enabling IS activation (see setMemoryToolsEnabled).
      if (enabled !== false) nextConfig = setBuiltinInstalledInConfig(nextConfig, name, true);
      saveConfigAndAdopt(nextConfig);
      if (name === 'localProvider' && enabled === false) {
        await stopLocalProviderServer?.();
      }
      if (name === 'localProvider') {
        await syncLocalProviderRegistry?.(enabled !== false);
      }
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    /** Extensions → Built-in Install: run the feature's preparation adapter
     *  (model pre-download, component verification), then mark it installed
     *  and enabled in one step. New sessions pick up the tool surface. */
    async installBuiltinFeature(name) {
      if (!INSTALLABLE_BUILTIN_IDS.includes(name)) {
        throw new TypeError('Built-in feature must be git, memory, office, tidy, or localProvider.');
      }
      await prepareBuiltinFeature?.(name);
      const config = getConfig();
      let nextConfig = setBuiltinInstalledInConfig({ ...config }, name, true);
      nextConfig =
        name === 'memory'
          ? setRecapEnabledInConfig(setMemoryToolsEnabledInConfig(nextConfig, true), true)
          : setModuleEnabledInConfig(nextConfig, name, true);
      if (name === 'localProvider') {
        nextConfig = setLocalProviderEnabledInConfig(nextConfig, true);
      }
      saveConfigAndAdopt(nextConfig);
      if (name === 'localProvider') {
        await syncLocalProviderRegistry?.(true);
      }
      if (name === 'memory') invalidateContextStatusCache();
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    /** Extensions → Code Tidy: which engines exist, where each one comes from,
     *  and the in-flight install. Never downloads. */
    async getTidyEngineStatus() {
      return (await tidyEngineStatus?.()) || null;
    },
    /** Progress for an `installBuiltinFeature('tidy')` still in flight, the
     *  last finished job, or null when this runtime never installed. */
    async getTidyInstallStatus() {
      return (await tidyInstallStatus?.()) || null;
    },
  };
}
